import { describe, expect, test, afterEach } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";

import {
  CACHEABLE_READ_REQUEST_TYPES,
  CACHE_SCHEMA_VERSION,
  ResultCache,
  buildCacheKey,
  canonicalize,
  hash,
  isCacheableReadRequest,
  isNonDocumentWriteRequest,
  sanitizePathSegment,
} from "./result-cache.js";
import type { BridgeResponse } from "./types.js";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function tempCacheRoot(): string {
  const dir = mkdtempSync(join(tmpdir(), "figma-mcp-bridge-cache-"));
  return dir;
}

function mockResponse(type: string, requestId: string, data?: unknown): BridgeResponse {
  return { type, requestId, data };
}

function errorResponse(type: string, requestId: string, error: string): BridgeResponse {
  return { type, requestId, error };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("canonicalize", () => {
  test("sorts object keys", () => {
    const a = canonicalize({ z: 1, a: 2, m: 3 });
    expect(JSON.stringify(a)).toBe('{"a":2,"m":3,"z":1}');
  });

  test("preserves array order", () => {
    const a = canonicalize([3, 1, 2]);
    expect(a).toEqual([3, 1, 2]);
  });

  test("produces stable output for same content", () => {
    const a = canonicalize({ b: [3, 1], a: { y: 1, x: 2 } });
    const b = canonicalize({ a: { x: 2, y: 1 }, b: [3, 1] });
    expect(JSON.stringify(a)).toBe(JSON.stringify(b));
  });

  test("key differs on node ID order", () => {
    const a = canonicalize({ nodeIds: ["a", "b"] });
    const b = canonicalize({ nodeIds: ["b", "a"] });
    expect(JSON.stringify(a)).not.toBe(JSON.stringify(b));
  });

  test("throws on non-finite number", () => {
    expect(() => canonicalize(NaN)).toThrow(TypeError);
    expect(() => canonicalize(Infinity)).toThrow(TypeError);
  });

  test("throws on function", () => {
    expect(() => canonicalize(() => {})).toThrow(TypeError);
  });

  test("throws on symbol", () => {
    expect(() => canonicalize(Symbol("a"))).toThrow(TypeError);
  });

  test("throws on undefined object property", () => {
    expect(() => canonicalize({ a: undefined })).toThrow(TypeError);
  });

  test("throws on BigInt", () => {
    expect(() => canonicalize(BigInt(42))).toThrow(TypeError);
  });

  test("throws on circular reference", () => {
    const obj: Record<string, unknown> = { a: 1 };
    obj.self = obj;
    expect(() => canonicalize(obj)).toThrow(TypeError);
  });

  test("handles null and primitive values", () => {
    expect(canonicalize(null)).toBeNull();
    expect(canonicalize(42)).toBe(42);
    expect(canonicalize("hello")).toBe("hello");
    expect(canonicalize(true)).toBe(true);
    expect(canonicalize(false)).toBe(false);
  });
});

describe("hash", () => {
  test("returns lowercase SHA-256 hex", () => {
    const result = hash("hello");
    expect(result).toMatch(/^[0-9a-f]{64}$/);
  });

  test("first 16 chars differ for different inputs", () => {
    const a = hash("file-one").slice(0, 16);
    const b = hash("file-two").slice(0, 16);
    expect(a).not.toBe(b);
  });
});

describe("sanitizePathSegment", () => {
  test("replaces colon with underscore", () => {
    expect(sanitizePathSegment("I3520:71152;1494:7326")).toBe(
      "I3520_71152;1494_7326"
    );
  });

  test("replaces slashes and backslashes", () => {
    expect(sanitizePathSegment("a/b\\c")).toBe("a_b_c");
  });

  test("trims leading/trailing underscores", () => {
    expect(sanitizePathSegment("__hello__")).toBe("hello");
  });

  test("returns unknown for empty result", () => {
    expect(sanitizePathSegment("::")).toBe("unknown");
  });

  test("limits to 80 characters", () => {
    const long = "a" + "b".repeat(200);
    const result = sanitizePathSegment(long);
    expect(result.length).toBeLessThanOrEqual(80);
  });
});

describe("isCacheableReadRequest / isNonDocumentWriteRequest", () => {
  test("read types are cacheable", () => {
    for (const type of CACHEABLE_READ_REQUEST_TYPES) {
      expect(isCacheableReadRequest(type)).toBe(true);
    }
  });

  test("mutation types are not cacheable", () => {
    expect(isCacheableReadRequest("set_solid_fill")).toBe(false);
    expect(isCacheableReadRequest("create_frame")).toBe(false);
    expect(isCacheableReadRequest("delete_nodes")).toBe(false);
  });

  test("save_screenshots is non-document-write", () => {
    expect(isNonDocumentWriteRequest("save_screenshots")).toBe(true);
  });

  test("set_solid_fill is not non-document-write", () => {
    expect(isNonDocumentWriteRequest("set_solid_fill")).toBe(false);
  });
});

describe("ResultCache — persistence and basic operations", () => {
  let root: string;

  afterEach(() => {
    rmSync(root, { recursive: true, force: true });
  });

  test("persists and returns a cold hit with new request ID", async () => {
    root = tempCacheRoot();
    const cache = new ResultCache(root);

    const fileKey = "test-file-key-abc123";
    const descriptor = {
      fileKey,
      requestType: "get_node",
      nodeIds: ["4029:12345"],
    };

    // First call — miss, fetch, persist
    const response1 = await cache.getOrCreate(
      descriptor,
      "req-001",
      async () => mockResponse("get_node", "req-001", { id: "4029:12345", name: "Frame 1" })
    );

    expect(response1.requestId).toBe("req-001");
    expect(response1.data).toEqual({ id: "4029:12345", name: "Frame 1" });

    // Second call with new cache instance — should read from disk
    const cache2 = new ResultCache(root);
    const response2 = await cache2.getOrCreate(
      descriptor,
      "req-002",
      async () => {
        throw new Error("should not be called");
      }
    );

    expect(response2.requestId).toBe("req-002");
    expect(response2.data).toEqual({ id: "4029:12345", name: "Frame 1" });
  });

  test("error responses are not persisted", async () => {
    root = tempCacheRoot();
    const cache = new ResultCache(root);

    const fileKey = "error-file-key";
    const descriptor = {
      fileKey,
      requestType: "get_node",
      nodeIds: ["1:2"],
    };

    const resp = await cache.getOrCreate(
      descriptor,
      "req-err",
      async () => errorResponse("get_node", "req-err", "Node not found")
    );

    expect(resp.error).toBe("Node not found");

    // The error should NOT be cached — calling again should fetch
    let fetchCalled = false;
    await cache.getOrCreate(
      descriptor,
      "req-err2",
      async () => {
        fetchCalled = true;
        return mockResponse("get_node", "req-err2", { id: "1:2" });
      }
    );

    expect(fetchCalled).toBe(true);
  });

  test("invalidation prevents prior entry from being served", async () => {
    root = tempCacheRoot();
    const cache = new ResultCache(root);

    const fileKey = "invalidation-test";
    const descriptor = {
      fileKey,
      requestType: "get_document",
    };

    // Persist one value
    await cache.getOrCreate(
      descriptor,
      "req-v1",
      async () => mockResponse("get_document", "req-v1", { version: 1 })
    );

    // Verify it's cached
    const hit1 = await cache.getOrCreate(
      descriptor,
      "req-v1-hit",
      async () => {
        throw new Error("should not fetch");
      }
    );
    expect(hit1.data).toEqual({ version: 1 });

    // Invalidate
    await cache.invalidate(fileKey);

    // Now it should miss and fetch fresh
    const hit2 = await cache.getOrCreate(
      descriptor,
      "req-v2",
      async () => mockResponse("get_document", "req-v2", { version: 2 })
    );
    expect(hit2.data).toEqual({ version: 2 });
  });

  test("invalidation persists generation across restarts", async () => {
    root = tempCacheRoot();
    const cache = new ResultCache(root);

    const fileKey = "persist-gen";
    await cache.invalidate(fileKey);

    // Fresh instance reads generation from disk
    const cache2 = new ResultCache(root);
    expect(cache2.getGeneration(fileKey)).toBe(1);
  });

  test("concurrent getOrCreate with identical descriptor runs fetch once", async () => {
    root = tempCacheRoot();
    const cache = new ResultCache(root);

    const fileKey = "concurrent-test";
    const descriptor = {
      fileKey,
      requestType: "get_node",
      nodeIds: ["1:1"],
    };

    let fetchCount = 0;

    const [r1, r2, r3] = await Promise.all([
      cache.getOrCreate(descriptor, "req-a", async () => {
        fetchCount++;
        // Simulate a slow plugin response
        await new Promise((r) => setTimeout(r, 50));
        return mockResponse("get_node", "req-a", { id: "1:1" });
      }),
      cache.getOrCreate(descriptor, "req-b", async () => {
        fetchCount++;
        await new Promise((r) => setTimeout(r, 20));
        return mockResponse("get_node", "req-b", { id: "1:1" });
      }),
      cache.getOrCreate(descriptor, "req-c", async () => {
        fetchCount++;
        return mockResponse("get_node", "req-c", { id: "1:1" });
      }),
    ]);

    // Only one fetch should have occurred
    expect(fetchCount).toBe(1);

    // Each caller gets its own request ID
    expect(r1.requestId).toBe("req-a");
    expect(r2.requestId).toBe("req-b");
    expect(r3.requestId).toBe("req-c");

    // All get the same data
    expect(r1.data).toEqual({ id: "1:1" });
    expect(r2.data).toEqual({ id: "1:1" });
    expect(r3.data).toEqual({ id: "1:1" });
  });
});

describe("ResultCache — corruption handling", () => {
  let root: string;

  afterEach(() => {
    rmSync(root, { recursive: true, force: true });
  });

  test("corrupted response.json produces miss", async () => {
    root = tempCacheRoot();
    const cache = new ResultCache(root);

    const fileKey = "corrupt-test";
    const descriptor = {
      fileKey,
      requestType: "get_metadata",
    };

    // First fetch to create the entry
    await cache.getOrCreate(
      descriptor,
      "req-1",
      async () => mockResponse("get_metadata", "req-1", { fileName: "test" })
    );

    // Corrupt the response.json manually
    const entryDir = (cache as any).entryDirectory(
      fileKey,
      "get_metadata",
      undefined,
      undefined
    ) as string;
    await writeFile(join(entryDir, "response.json"), "not valid json!!!");

    // Should miss and fetch
    let fetchCalled = false;
    const result = await cache.getOrCreate(
      descriptor,
      "req-2",
      async () => {
        fetchCalled = true;
        return mockResponse("get_metadata", "req-2", { fileName: "refetched" });
      }
    );

    expect(fetchCalled).toBe(true);
    expect(result.data).toEqual({ fileName: "refetched" });
  });
});

describe("ResultCache — screenshot image artifact extraction", () => {
  let root: string;

  afterEach(() => {
    rmSync(root, { recursive: true, force: true });
  });

  test("PNG data URI produces image_1.png artifact and retains original URI", async () => {
    root = tempCacheRoot();
    const cache = new ResultCache(root);

    const pngDataUri =
      "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==";

    const fileKey = "img-test";
    const descriptor = {
      fileKey,
      requestType: "get_screenshot",
      nodeIds: ["1:1"],
      params: { format: "PNG" },
    };

    await cache.getOrCreate(
      descriptor,
      "req-img",
      async () =>
        mockResponse("get_screenshot", "req-img", {
          exports: [{ nodeId: "1:1", base64: pngDataUri }],
        })
    );

    // Verify response JSON is stored and retains the original data URI
    const cache2 = new ResultCache(root);
    const hit = await cache2.get(descriptor, "req-img-hit");
    expect(hit).toBeDefined();
    expect(hit!.data).toEqual({
      exports: [{ nodeId: "1:1", base64: pngDataUri }],
    });

    // Verify image artifact file exists under cache root
    const { existsSync, readFileSync, readdirSync } = await import("node:fs");
    const { globSync } = await import("node:fs");
    // Use import("node:fs").readdirSync recursively to find image_1.png
    const findPng = (dir: string): string | null => {
      try {
        for (const entry of readdirSync(dir, { withFileTypes: true })) {
          const full = join(dir, entry.name);
          if (entry.isDirectory()) {
            const found = findPng(full);
            if (found) return found;
          } else if (entry.name === "image_1.png") {
            return full;
          }
        }
      } catch { /* ignore */ }
      return null;
    };
    const imagePath = findPng(root);
    expect(imagePath).not.toBeNull();
    const imageBytes = readFileSync(imagePath!);
    expect(imageBytes.length).toBeGreaterThan(0);
  });
});

describe("ResultCache — node path safety", () => {
  let root: string;

  afterEach(() => {
    rmSync(root, { recursive: true, force: true });
  });

  test("unsafe node ID produces safe path", async () => {
    root = tempCacheRoot();
    const cache = new ResultCache(root);

    const fileKey = "path-test";
    const descriptor = {
      fileKey,
      requestType: "get_node",
      nodeIds: ["I3520:71152;1494:7326"],
    };

    await cache.getOrCreate(
      descriptor,
      "req-path",
      async () => mockResponse("get_node", "req-path", { id: "I3520:71152;1494:7326" })
    );

    // Verify it's cached and retrievable
    const hit = await cache.get(descriptor, "req-path-hit");
    expect(hit).toBeDefined();
    expect(hit!.data).toEqual({ id: "I3520:71152;1494:7326" });
  });
});

describe("buildCacheKey", () => {
  test("produces stable key for same inputs", () => {
    const a = buildCacheKey({
      fileKey: "abc",
      requestType: "get_node",
      nodeIds: ["1:2"],
      params: { depth: 2 },
    });
    const b = buildCacheKey({
      fileKey: "abc",
      requestType: "get_node",
      nodeIds: ["1:2"],
      params: { depth: 2 },
    });
    expect(a).toBe(b);
  });

  test("differences in node ID order produce different keys", () => {
    const a = buildCacheKey({
      fileKey: "abc",
      requestType: "get_screenshot",
      nodeIds: ["1:1", "2:2"],
    });
    const b = buildCacheKey({
      fileKey: "abc",
      requestType: "get_screenshot",
      nodeIds: ["2:2", "1:1"],
    });
    expect(a).not.toBe(b);
  });
});

describe("ResultCache — default root resolution", () => {
  test("constructor with no arg resolves to docs/ui/ two levels up", () => {
    const cache = new ResultCache();
    const root = cache.getRoot();
    expect(root).toMatch(/docs\/ui$/);
  });
});

describe("isNonDocumentWriteRequest classification", () => {
  test("save_screenshots is classified correctly", () => {
    expect(isNonDocumentWriteRequest("save_screenshots")).toBe(true);
  });

  test("mutations are not non-document-write", () => {
    expect(isNonDocumentWriteRequest("set_solid_fill")).toBe(false);
    expect(isNonDocumentWriteRequest("create_frame")).toBe(false);
    expect(isNonDocumentWriteRequest("delete_nodes")).toBe(false);
    expect(isNonDocumentWriteRequest("reparent_nodes")).toBe(false);
  });
});
