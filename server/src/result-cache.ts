import { createHash, randomUUID } from "node:crypto";
import { chmod, mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { existsSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import type { BridgeResponse, CacheEntryManifest, CacheRequestDescriptor } from "./types.js";

export const CACHEABLE_READ_REQUEST_TYPES = new Set<string>([
  "list_files",
  "get_document",
  "get_selection",
  "get_node",
  "get_styles",
  "get_metadata",
  "get_design_context",
  "get_variable_defs",
  "get_screenshot",
  "get_motion_styles",
  "get_node_motion",
]);

export const CACHE_SCHEMA_VERSION = 1 as const;

export function isCacheableReadRequest(requestType: string): boolean {
  return CACHEABLE_READ_REQUEST_TYPES.has(requestType);
}

export function isNonDocumentWriteRequest(requestType: string): boolean {
  return requestType === "save_screenshots";
}

function resolveDefaultCacheRoot(): string {
  const modulePath = fileURLToPath(import.meta.url);
  const moduleDir = path.dirname(modulePath);
  return path.resolve(moduleDir, "../../docs/ui");
}

/**
 * Canonicalize a value for use in cache keys.
 * Recursively sorts plain object keys, preserves array order.
 * Throws TypeError on non-finite numbers, BigInt, functions, symbols,
 * undefined object values, circular references, or non-plain object inputs.
 */
export function canonicalize(
  value: unknown,
  _stack?: unknown[]
): unknown {
  const stack = _stack ?? [];
  if (stack.includes(value)) {
    throw new TypeError("Circular reference in canonicalize");
  }

  if (value === null || value === undefined) {
    return value;
  }

  if (typeof value === "boolean" || typeof value === "string") {
    return value;
  }

  if (typeof value === "number") {
    if (!Number.isFinite(value)) {
      throw new TypeError("Non-finite number in canonicalize");
    }
    return value;
  }

  if (typeof value === "bigint") {
    throw new TypeError("BigInt not supported in canonicalize");
  }

  if (typeof value === "function") {
    throw new TypeError("Function not supported in canonicalize");
  }

  if (typeof value === "symbol") {
    throw new TypeError("Symbol not supported in canonicalize");
  }

  if (Array.isArray(value)) {
    return value.map((item) => canonicalize(item, [...stack, value]));
  }

  // Plain object check
  if (value === null || typeof value !== "object") {
    return value;
  }
  const proto = Object.getPrototypeOf(value);
  if (proto !== Object.prototype && proto !== null) {
    throw new TypeError("Non-plain object in canonicalize");
  }

  const keys = Object.keys(value as Record<string, unknown>).sort();
  const result: Record<string, unknown> = {};
  for (const key of keys) {
    const val = (value as Record<string, unknown>)[key];
    if (val === undefined) {
      throw new TypeError("Undefined object property in canonicalize");
    }
    result[key] = canonicalize(val, [...stack, value]);
  }
  return result;
}

/**
 * Return lowercase SHA-256 hex digest of the input string.
 */
export function hash(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

/**
 * Replace unsafe characters for filesystem paths with underscores.
 * Unsafe: colon, slash, backslash, control chars, whitespace runs.
 * Trims outer underscores. Returns "unknown" for empty result.
 * Limits output to 80 characters.
 */
export function sanitizePathSegment(value: string): string {
  let result = value.replace(/[:/\\\x00-\x1f\s]+/g, "_");
  result = result.replace(/^_+|_+$/g, "");
  if (result.length === 0) {
    return "unknown";
  }
  if (result.length > 80) {
    result = result.slice(0, 80);
  }
  return result;
}

interface InFlightEntry {
  promise: Promise<BridgeResponse>;
  requestId: string;
}

export class ResultCache {
  private readonly root: string;
  private readonly generations = new Map<string, number>();
  private readonly inFlight = new Map<string, InFlightEntry>();

  constructor(cacheRoot?: string) {
    this.root = cacheRoot ?? resolveDefaultCacheRoot();
  }

  getRoot(): string {
    return this.root;
  }

  /**
   * Resolve the current generation for a file namespace.
   * Reads from generation.json on first access.
   */
  getGeneration(fileKey: string): number {
    let gen = this.generations.get(fileKey);
    if (gen === undefined) {
      const genPath = path.join(
        this.fileNamespace(fileKey),
        "generation.json"
      );
      try {
        if (existsSync(genPath)) {
          const data = JSON.parse(readFileSync(genPath, "utf-8"));
          gen = (data?.generation as number) ?? 0;
        } else {
          gen = 0;
        }
      } catch {
        gen = 0;
      }
      this.generations.set(fileKey, gen);
    }
    return gen;
  }

  async get(
    descriptor: CacheRequestDescriptor,
    requestId: string
  ): Promise<BridgeResponse | undefined> {
    const { fileKey, requestType, nodeIds, params } = descriptor;
    const entryDir = this.entryDirectory(fileKey, requestType, nodeIds, params);
    const responsePath = path.join(entryDir, "response.json");

    try {
      const manifestPath = path.join(entryDir, "manifest.json");
      const manifestRaw = await readFile(manifestPath, "utf-8");
      const manifest = JSON.parse(manifestRaw) as CacheEntryManifest;

      const currentGen = this.getGeneration(fileKey);
      if (manifest.generation !== currentGen) {
        return undefined;
      }

      const raw = await readFile(responsePath, "utf-8");
      const envelope = JSON.parse(raw);

      return {
        type: envelope.type,
        requestId,
        data: envelope.data,
      } satisfies BridgeResponse;
    } catch {
      return undefined;
    }
  }

  async getOrCreate(
    descriptor: CacheRequestDescriptor,
    requestId: string,
    fetch: () => Promise<BridgeResponse>
  ): Promise<BridgeResponse> {
    const cacheKey = buildCacheKey(descriptor);

    // Check in-flight first (synchronous — no gap)
    const existing = this.inFlight.get(cacheKey);
    if (existing) {
      const resp = await existing.promise;
      return { ...resp, requestId };
    }

    // Register in-flight BEFORE any async operation to prevent concurrent misses
    const wrappedFetch = async (): Promise<BridgeResponse> => {
      const hit = await this.get(descriptor, requestId);
      if (hit) return hit;
      return this.fetchAndPersist(descriptor, fetch);
    };

    const promise = wrappedFetch();
    this.inFlight.set(cacheKey, { promise, requestId });

    try {
      const resp = await promise;
      return { ...resp, requestId };
    } finally {
      this.inFlight.delete(cacheKey);
    }
  }

  /**
   * Invalidate the cache for a file namespace:
   * - Increments generation
   * - Clears in-flight entries for that file
   * - Persists the new generation to disk
   */
  async invalidate(fileKey: string): Promise<void> {
    const gen = this.getGeneration(fileKey) + 1;
    this.generations.set(fileKey, gen);

    // Clear in-flight promises for this file
    const prefix = hash(fileKey).slice(0, 16);
    for (const [key] of this.inFlight) {
      if (key.includes(prefix)) {
        this.inFlight.delete(key);
      }
    }

    // Persist generation marker
    const ns = this.fileNamespace(fileKey);
    try {
      await mkdir(ns, { recursive: true, mode: 0o700 });
    } catch {
      // ignore
    }
    const genPath = path.join(ns, "generation.json");
    await this.atomicWrite(
      genPath,
      JSON.stringify({
        generation: gen,
        invalidatedAt: new Date().toISOString(),
      })
    );
  }

  /**
   * Drop in-memory state for a file (on disconnect/reconnect).
   * Does not delete human-readable artifacts.
   */
  dropFile(fileKey: string): void {
    this.generations.delete(fileKey);
    const prefix = hash(fileKey).slice(0, 16);
    for (const [key] of this.inFlight) {
      if (key.includes(prefix)) {
        this.inFlight.delete(key);
      }
    }
  }

  // ---------------------------------------------------------------------------
  // Private helpers
  // ---------------------------------------------------------------------------

  private fileNamespace(fileKey: string): string {
    return path.join(this.root, `file_${hash(fileKey).slice(0, 16)}`);
  }

  private entryDirectory(
    fileKey: string,
    requestType: string,
    nodeIds?: string[],
    params?: Record<string, unknown>
  ): string {
    const ns = this.fileNamespace(fileKey);
    const descriptor: CacheRequestDescriptor = {
      fileKey,
      requestType,
      nodeIds,
      params,
    };
    const fullKey = buildCacheKey(descriptor);
    const keyHash = hash(fullKey);
    const shortHash = keyHash.slice(0, 16);

    if (!/^[a-z_]+$/.test(requestType)) {
      throw new Error(`Invalid request type in path: ${requestType}`);
    }

    if (nodeIds?.length === 1) {
      const safeId = sanitizePathSegment(nodeIds[0]);
      return path.join(
        ns,
        `node_${safeId}`,
        `request_${requestType}_${shortHash}`
      );
    }

    return path.join(ns, `request_${requestType}_${shortHash}`);
  }

  private async fetchAndPersist(
    descriptor: CacheRequestDescriptor,
    fetch: () => Promise<BridgeResponse>
  ): Promise<BridgeResponse> {
    const resp = await fetch();

    if (resp.error) {
      return resp;
    }

    // Check serializability
    try {
      JSON.stringify(resp);
    } catch {
      return resp;
    }

    const { fileKey, requestType, nodeIds, params } = descriptor;
    const entryDir = this.entryDirectory(fileKey, requestType, nodeIds, params);
    const generation = this.getGeneration(fileKey);

    // Build manifest
    const descriptorKey = buildCacheKey(descriptor);
    const keyHash = hash(descriptorKey);

    try {
      await mkdir(entryDir, { recursive: true, mode: 0o700 });

      // Write response.json — never store caller request ID
      const envelope = { type: resp.type, requestId: "", data: resp.data };
      const responseJson = JSON.stringify(envelope);
      await this.atomicWrite(path.join(entryDir, "response.json"), responseJson);

      // Extract image artifacts
      const artifacts: string[] = [];
      if (resp.data) {
        artifacts.push(
          ...this.extractImageArtifacts(resp.data, entryDir)
        );
      }

      // Write manifest
      const manifest: CacheEntryManifest = {
        schemaVersion: CACHE_SCHEMA_VERSION,
        keyHash,
        requestType,
        nodeIds: nodeIds ?? [],
        generation,
        createdAt: new Date().toISOString(),
        artifacts,
      };
      await this.atomicWrite(
        path.join(entryDir, "manifest.json"),
        JSON.stringify(manifest, null, 2)
      );

      // Ensure permissions
      try {
        await chmod(entryDir, 0o700);
        await chmod(path.join(entryDir, "response.json"), 0o600);
      } catch {
        // permission changes are best-effort after write
      }
    } catch {
      // Cache write failure is non-fatal
    }

    return resp;
  }

  private extractImageArtifacts(
    data: unknown,
    entryDir: string
  ): string[] {
    const artifacts: string[] = [];
    this.collectImageArtifacts(data, entryDir, artifacts);
    return artifacts;
  }

  private collectImageArtifacts(
    data: unknown,
    entryDir: string,
    artifacts: string[]
  ): void {
    if (typeof data === "string") {
      const artifact = this.tryWriteImageArtifact(
        data,
        entryDir,
        artifacts.length + 1
      );
      if (artifact) {
        artifacts.push(artifact);
      }
      return;
    }

    if (data && typeof data === "object") {
      for (const value of Object.values(data as Record<string, unknown>)) {
        this.collectImageArtifacts(value, entryDir, artifacts);
      }
    }
  }

  private tryWriteImageArtifact(
    value: string,
    entryDir: string,
    index: number
  ): string | null {
    const match = value.match(
      /^data:image\/(png|jpeg|svg\+xml);base64,([A-Za-z0-9+/=]+)$/
    );
    if (!match) return null;

    const format = match[1];
    let ext: string;
    if (format === "jpeg") {
      ext = "jpg";
    } else if (format === "svg+xml") {
      ext = "svg";
    } else {
      ext = format; // png
    }
    const base64Data = match[2];
    const fileName = `image_${index}.${ext}`;
    const filePath = path.join(entryDir, fileName);

    try {
      const bytes = Buffer.from(base64Data, "base64");
      const tmpPath = filePath + ".tmp." + randomUUID().slice(0, 8);
      writeFileSync(tmpPath, bytes, { mode: 0o600 });
      renameSync(tmpPath, filePath);
    } catch {
      return null;
    }

    return fileName;
  }

  private async atomicWrite(filePath: string, content: string): Promise<void> {
    const dir = path.dirname(filePath);
    await mkdir(dir, { recursive: true, mode: 0o700 });

    const tmpPath =
      filePath + ".tmp." + randomUUID().slice(0, 8) + "." + process.pid;
    await writeFile(tmpPath, content, { mode: 0o600 });
    try {
      await rename(tmpPath, filePath);
    } catch {
      // If rename fails, try to clean up temp file and rethrow
      try {
        await rm(tmpPath, { force: true });
      } catch {
        // ignore cleanup failure
      }
      throw new Error("Atomic write rename failed");
    }
  }
}

/**
 * Build the canonical cache key JSON string for a descriptor.
 * Generation is checked at manifest level, not embedded in the key.
 */
export function buildCacheKey(descriptor: CacheRequestDescriptor): string {
  const canonicalKey = {
    schemaVersion: CACHE_SCHEMA_VERSION,
    fileKey: descriptor.fileKey,
    requestType: descriptor.requestType,
    nodeIds: descriptor.nodeIds ?? [],
    params: canonicalize(descriptor.params ?? {}),
  };
  return JSON.stringify(canonicalKey);
}
