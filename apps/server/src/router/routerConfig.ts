// @effect-diagnostics nodeBuiltinImport:off - the router is a small operator
// daemon; it reads its registry synchronously on each request so adding a node
// needs only a file edit, never a restart.
import * as NodeFS from "node:fs";
import * as NodePath from "node:path";

/**
 * One T3 server the router may place work on. Adding a node is a registry
 * entry only: callers never carry a node list of their own.
 */
export interface RouterNode {
  readonly id: string;
  readonly baseUrl: string;
  /** Bearer token file for this node's T3 API. Read per request, so rotation needs no restart. */
  readonly tokenFile: string;
  /** Relative load-balancing weight, the same meaning as the client setting. */
  readonly weight: number;
  /** Absolute directory on the node that holds the router-managed workspaces. */
  readonly workspaceBase: string;
  /** When present, only these workspace names may be placed on the node. */
  readonly workspaces?: ReadonlyArray<string>;
  /** A disabled node still forwards (running threads finish) but takes no new placements. */
  readonly enabled: boolean;
  /** When pinned, a node answering with another environment id is treated as unreachable. */
  readonly environmentId?: string;
}

export interface RouterConfig {
  readonly tokenFile: string;
  readonly nodes: ReadonlyArray<RouterNode>;
}

class RouterConfigError extends Error {
  override readonly name = "RouterConfigError";
}

const NODE_ID = /^[a-z0-9][a-z0-9-]{0,39}$/;
export const WORKSPACE_NAME = /^[A-Za-z0-9][A-Za-z0-9._-]{0,99}$/;

const fail = (message: string): never => {
  throw new RouterConfigError(message);
};

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

const absolute = (value: unknown, field: string): string =>
  typeof value === "string" && NodePath.posix.isAbsolute(value) && !value.includes("\0")
    ? value
    : fail(`${field} must be an absolute path`);

const parseNode = (value: unknown, index: number): RouterNode => {
  if (!isRecord(value)) return fail(`nodes[${index}] must be an object`);
  const id =
    typeof value.id === "string" && NODE_ID.test(value.id)
      ? value.id
      : fail(`nodes[${index}].id is invalid`);
  let baseUrl: URL;
  try {
    baseUrl = new URL(String(value.baseUrl));
  } catch {
    return fail(`nodes[${index}].baseUrl is not a URL`);
  }
  if (baseUrl.protocol !== "http:" && baseUrl.protocol !== "https:") {
    fail(`nodes[${index}].baseUrl must be http(s)`);
  }
  if (baseUrl.username || baseUrl.password || baseUrl.search || baseUrl.hash) {
    fail(`nodes[${index}].baseUrl must not carry credentials, query or fragment`);
  }
  const weight = value.weight === undefined ? 1 : value.weight;
  if (typeof weight !== "number" || !Number.isFinite(weight) || weight < 0) {
    fail(`nodes[${index}].weight must be a non-negative number`);
  }
  let workspaces: ReadonlyArray<string> | undefined;
  if (value.workspaces !== undefined) {
    if (
      !Array.isArray(value.workspaces) ||
      !value.workspaces.every((name) => typeof name === "string" && WORKSPACE_NAME.test(name))
    ) {
      fail(`nodes[${index}].workspaces must be a list of workspace names`);
    }
    workspaces = value.workspaces as ReadonlyArray<string>;
  }
  if (value.enabled !== undefined && typeof value.enabled !== "boolean") {
    fail(`nodes[${index}].enabled must be a boolean`);
  }
  if (
    value.environmentId !== undefined &&
    (typeof value.environmentId !== "string" || value.environmentId.trim() === "")
  ) {
    fail(`nodes[${index}].environmentId must be a non-empty string`);
  }
  return {
    id,
    baseUrl: baseUrl.toString().replace(/\/+$/, ""),
    tokenFile: absolute(value.tokenFile, `nodes[${index}].tokenFile`),
    weight: weight as number,
    workspaceBase: absolute(value.workspaceBase, `nodes[${index}].workspaceBase`),
    ...(workspaces ? { workspaces } : {}),
    enabled: value.enabled !== false,
    ...(typeof value.environmentId === "string" ? { environmentId: value.environmentId } : {}),
  };
};

export const parseRouterConfig = (value: unknown): RouterConfig => {
  if (!isRecord(value)) return fail("config must be an object");
  if (!Array.isArray(value.nodes) || value.nodes.length === 0) {
    return fail("config.nodes must be a non-empty list");
  }
  const nodes = value.nodes.map(parseNode);
  const ids = new Set<string>();
  for (const node of nodes) {
    if (ids.has(node.id)) fail(`duplicate node id ${node.id}`);
    ids.add(node.id);
  }
  return { tokenFile: absolute(value.tokenFile, "tokenFile"), nodes };
};

/** Re-reads the registry when its mtime changes; a broken edit keeps the last good copy. */
export const makeConfigSource = (path: string): (() => RouterConfig) => {
  let cached: { mtimeMs: number; config: RouterConfig } | null = null;
  return () => {
    const { mtimeMs } = NodeFS.statSync(path);
    if (cached && cached.mtimeMs === mtimeMs) return cached.config;
    try {
      const config = parseRouterConfig(JSON.parse(NodeFS.readFileSync(path, "utf8")));
      cached = { mtimeMs, config };
      return config;
    } catch (error) {
      if (cached) return cached.config;
      throw error;
    }
  };
};

export const readSecret = (path: string): string => {
  const secret = NodeFS.readFileSync(path, "utf8").trim();
  if (!secret) throw new RouterConfigError(`secret file ${path} is empty`);
  return secret;
};
