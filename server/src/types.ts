export interface BridgeRequest {
  type: string;
  requestId: string;
  nodeIds?: string[];
  params?: Record<string, unknown>;
}

export interface BridgeResponse {
  type: string;
  requestId: string;
  data?: unknown;
  error?: string;
}

export interface RPCRequest {
  tool: string;
  nodeIds?: string[];
  params?: Record<string, unknown>;
  fileKey?: string;
}

export interface RPCResponse {
  data?: unknown;
  error?: string;
}

export interface ConnectedFile {
  fileKey: string;
  fileName: string;
}

export enum Role {
  Unknown = 0,
  Leader = 1,
  Follower = 2,
}

export interface CacheRequestDescriptor {
  fileKey: string;
  requestType: string;
  nodeIds?: string[];
  params?: Record<string, unknown>;
}

export interface CacheEntryManifest {
  schemaVersion: 1;
  keyHash: string;
  requestType: string;
  nodeIds: string[];
  generation: number;
  createdAt: string;
  artifacts: string[];
}
