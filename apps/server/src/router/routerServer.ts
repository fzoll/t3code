// @effect-diagnostics nodeBuiltinImport:off - a plain node:http forwarder keeps
// request and response bytes untouched between the caller and the T3 node.
import * as NodeCrypto from "node:crypto";
import * as NodeHttp from "node:http";
import type * as NodeStream from "node:stream";

import { HostResourcesSnapshot } from "@t3tools/contracts";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import { WebSocket, WebSocketServer, type RawData } from "ws";

import {
  PlacementError,
  parsePlacementRequest,
  place,
  type NodeObservation,
  type ObserveNode,
} from "./placement.ts";
import { readSecret, type RouterConfig, type RouterNode } from "./routerConfig.ts";

/**
 * T3 endpoints a caller may reach through `/nodes/<id>`. Everything else stays
 * private to the node, so a router token is not a full node token.
 *
 * The websocket ticket route is the HTTP half of `/nodes/<id>/ws`: the caller
 * mints a ticket with the router token, and the ticket is the only credential the
 * upgrade carries. A ticket opens the node's whole RPC surface, so the router
 * relays the socket frame by frame and lets only `FORWARDED_RPC` requests through.
 */
const FORWARDED: ReadonlyArray<{ method: string; path: RegExp }> = [
  { method: "POST", path: /^\/api\/orchestration\/dispatch$/ },
  { method: "GET", path: /^\/api\/orchestration\/snapshot$/ },
  // Thread shell: per-thread status flags (hasPendingUserInput, hasPendingApprovals) for callers
  // that must notice a turn waiting on a human.
  { method: "GET", path: /^\/api\/orchestration\/shell$/ },
  { method: "GET", path: /^\/api\/orchestration\/threads\/[^/]+$/ },
  { method: "GET", path: /^\/\.well-known\/t3\/environment$/ },
  { method: "GET", path: /^\/api\/auth\/session$/ },
  { method: "POST", path: /^\/api\/auth\/websocket-ticket$/ },
];

/**
 * RPC methods a caller may invoke over the relayed node socket. Only the WS path
 * runs `thread.turn.start` bootstrap (thread creation + worktree preparation), which
 * HTTP dispatch ignores. Other Effect RPC frames (Ack, Interrupt, Ping, Eof, ...)
 * carry no method and pass through; node-to-caller frames are never filtered.
 */
const FORWARDED_RPC: ReadonlySet<string> = new Set(["orchestration.dispatchCommand"]);

/** Responses that carry project environments; their values never leave the router. */
const REDACTED_SNAPSHOTS: ReadonlySet<string> = new Set([
  "/api/orchestration/snapshot",
  "/api/orchestration/shell",
]);

const MAX_BODY_BYTES = 8 * 1024 * 1024;
const MAX_WS_PAYLOAD_BYTES = 8 * 1024 * 1024;
const WS_CONNECT_TIMEOUT_MS = 10_000;
const OBSERVE_TIMEOUT_MS = 5_000;
const FORWARD_TIMEOUT_MS = 60_000;

const decodeHostResources = Schema.decodeUnknownOption(HostResourcesSnapshot);

/**
 * Project environments hold provider and GitHub credentials. Router callers need project
 * identity (id, workspace root, deletion), never those values, so the snapshot leaves the
 * router with every environment value blanked and marked redacted. Unparseable bodies are
 * withheld rather than passed through.
 */
export const redactProjectEnvironment = (body: Buffer): Buffer => {
  let snapshot: unknown;
  try {
    snapshot = JSON.parse(body.toString("utf8"));
  } catch {
    throw new HttpFailure(502, "snapshot_unreadable");
  }
  const projects = (snapshot as { projects?: unknown })?.projects;
  if (Array.isArray(projects)) {
    for (const project of projects) {
      const environment = (project as { environment?: unknown })?.environment;
      if (!Array.isArray(environment)) continue;
      for (const variable of environment) {
        if (variable && typeof variable === "object") {
          (variable as Record<string, unknown>).value = "";
          (variable as Record<string, unknown>).valueRedacted = true;
        }
      }
    }
  }
  return Buffer.from(JSON.stringify(snapshot));
};

export interface RouterDependencies {
  readonly config: () => RouterConfig;
  readonly fetch?: typeof globalThis.fetch;
  readonly secret?: (path: string) => string;
  readonly now?: () => number;
}

class HttpFailure extends Error {
  readonly status: number;
  readonly code: string;
  constructor(status: number, code: string) {
    super(code);
    this.status = status;
    this.code = code;
  }
}

const sameSecret = (presented: string, expected: string) => {
  const a = NodeCrypto.createHash("sha256").update(presented).digest();
  const b = NodeCrypto.createHash("sha256").update(expected).digest();
  return NodeCrypto.timingSafeEqual(a, b);
};

const readBody = (request: NodeHttp.IncomingMessage): Promise<Buffer> =>
  new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let size = 0;
    request.on("data", (chunk: Buffer) => {
      size += chunk.length;
      if (size > MAX_BODY_BYTES) {
        reject(new HttpFailure(413, "body_too_large"));
        request.destroy();
        return;
      }
      chunks.push(chunk);
    });
    request.on("end", () => resolve(Buffer.concat(chunks)));
    request.on("error", reject);
  });

const sendJson = (response: NodeHttp.ServerResponse, status: number, body: unknown) => {
  response.writeHead(status, { "content-type": "application/json", "cache-control": "no-store" });
  response.end(JSON.stringify(body));
};

const makeRouterHandler = (dependencies: RouterDependencies) => {
  const fetchImpl = dependencies.fetch ?? globalThis.fetch;
  const secret = dependencies.secret ?? readSecret;
  const now = dependencies.now ?? Date.now;

  const nodeRequest = (node: RouterNode, path: string, init: RequestInit, timeoutMs: number) =>
    fetchImpl(`${node.baseUrl}${path}`, {
      ...init,
      headers: {
        ...(init.headers as Record<string, string>),
        authorization: `Bearer ${secret(node.tokenFile)}`,
      },
      redirect: "manual",
      signal: AbortSignal.timeout(timeoutMs),
    });

  const observe: ObserveNode = async (node): Promise<NodeObservation> => {
    const response = await nodeRequest(
      node,
      "/.well-known/t3/environment",
      { method: "GET" },
      OBSERVE_TIMEOUT_MS,
    );
    if (!response.ok) throw new Error(`descriptor_http_${response.status}`);
    const descriptor = (await response.json()) as {
      environmentId?: unknown;
      resources?: { hostResources?: unknown };
    };
    if (typeof descriptor.environmentId !== "string") throw new Error("descriptor_invalid");
    if (node.environmentId && descriptor.environmentId !== node.environmentId) {
      throw new Error("environment_identity_changed");
    }
    return {
      environmentId: descriptor.environmentId,
      hostResources: Option.getOrNull(decodeHostResources(descriptor.resources?.hostResources)),
      receivedAt: now(),
    };
  };

  const authorize = (request: NodeHttp.IncomingMessage, config: RouterConfig) => {
    const header = request.headers.authorization ?? "";
    const presented = header.startsWith("Bearer ") ? header.slice(7) : "";
    if (!presented || !sameSecret(presented, secret(config.tokenFile))) {
      throw new HttpFailure(401, "unauthorized");
    }
  };

  const forward = async (
    request: NodeHttp.IncomingMessage,
    response: NodeHttp.ServerResponse,
    node: RouterNode,
    path: string,
    search: string,
  ) => {
    const method = request.method ?? "GET";
    if (!FORWARDED.some((rule) => rule.method === method && rule.path.test(path))) {
      throw new HttpFailure(404, "route_not_forwarded");
    }
    const read = method === "POST" ? await readBody(request) : undefined;
    // The ticket route takes no payload; an empty POST goes out without a body.
    const body = read && read.length > 0 ? read : undefined;
    let upstream: Response;
    try {
      upstream = await nodeRequest(
        node,
        `${path}${search}`,
        {
          method,
          headers: body
            ? { "content-type": request.headers["content-type"] ?? "application/json" }
            : {},
          ...(body ? { body: new Uint8Array(body) } : {}),
        },
        FORWARD_TIMEOUT_MS,
      );
    } catch {
      throw new HttpFailure(502, "node_unreachable");
    }
    let payload: Buffer = Buffer.from(await upstream.arrayBuffer());
    if (REDACTED_SNAPSHOTS.has(path) && upstream.ok) payload = redactProjectEnvironment(payload);
    response.writeHead(upstream.status, {
      "content-type": upstream.headers.get("content-type") ?? "application/octet-stream",
      "cache-control": "no-store",
      "x-t3-router-node": node.id,
    });
    response.end(payload);
  };

  return async (request: NodeHttp.IncomingMessage, response: NodeHttp.ServerResponse) => {
    try {
      const url = new URL(request.url ?? "/", "http://router.invalid");
      if (request.method === "GET" && url.pathname === "/healthz") {
        sendJson(response, 200, { ok: true });
        return;
      }
      const config = dependencies.config();
      authorize(request, config);

      if (request.method === "GET" && url.pathname === "/api/router/nodes") {
        const nodes = await Promise.all(
          config.nodes.map(async (node) => {
            try {
              const observation = await observe(node);
              return {
                id: node.id,
                enabled: node.enabled,
                weight: node.weight,
                reachable: true,
                environmentId: observation.environmentId,
                hostResources: observation.hostResources,
                ...(node.webUrl ? { webUrl: node.webUrl } : {}),
              };
            } catch (error) {
              return {
                id: node.id,
                enabled: node.enabled,
                weight: node.weight,
                reachable: false,
                error: error instanceof Error ? error.message : "unreachable",
              };
            }
          }),
        );
        sendJson(response, 200, { nodes });
        return;
      }

      if (request.method === "POST" && url.pathname === "/api/router/placements") {
        let parsed: unknown;
        try {
          parsed = JSON.parse((await readBody(request)).toString("utf8"));
        } catch (error) {
          if (error instanceof HttpFailure) throw error;
          throw new HttpFailure(400, "invalid_json");
        }
        const placement = await place(config, parsePlacementRequest(parsed), observe, now);
        sendJson(response, 200, placement);
        return;
      }

      const match = /^\/nodes\/([^/]+)(\/.*)$/.exec(url.pathname);
      if (match) {
        const node = config.nodes.find((candidate) => candidate.id === match[1]);
        if (!node) throw new HttpFailure(404, "unknown_node");
        await forward(request, response, node, match[2]!, url.search);
        return;
      }
      throw new HttpFailure(404, "not_found");
    } catch (error) {
      if (response.headersSent) {
        response.destroy();
        return;
      }
      if (error instanceof HttpFailure || error instanceof PlacementError) {
        sendJson(response, error.status, {
          error: error instanceof HttpFailure ? error.code : error.code,
        });
        return;
      }
      sendJson(response, 500, { error: "router_internal_error" });
    }
  };
};

/**
 * Returns why a caller frame must not reach the node, or null when it may. The
 * node's JSON serialization also accepts arrays of messages, so only a single
 * JSON object per text frame is relayed; that keeps every request visible here.
 */
export const screenCallerFrame = (data: RawData, isBinary: boolean): string | null => {
  if (isBinary) return "invalid_frame";
  let message: unknown;
  try {
    message = JSON.parse(rawText(data));
  } catch {
    return "invalid_frame";
  }
  if (!message || typeof message !== "object" || Array.isArray(message)) return "invalid_frame";
  const { _tag, tag } = message as { _tag?: unknown; tag?: unknown };
  if (_tag === "Request" && !(typeof tag === "string" && FORWARDED_RPC.has(tag))) {
    return "rpc_not_forwarded";
  }
  return null;
};

const rawText = (data: RawData) =>
  (Array.isArray(data)
    ? Buffer.concat(data)
    : Buffer.isBuffer(data)
      ? data
      : Buffer.from(data)
  ).toString("utf8");

const rejectUpgrade = (socket: NodeStream.Duplex, status: number, code: string) => {
  if (!socket.writable) {
    socket.destroy();
    return;
  }
  const body = JSON.stringify({ error: code });
  socket.end(
    `HTTP/1.1 ${status} ${NodeHttp.STATUS_CODES[status] ?? ""}\r\n` +
      "Content-Type: application/json\r\n" +
      "Cache-Control: no-store\r\n" +
      `Content-Length: ${Buffer.byteLength(body)}\r\n` +
      "Connection: close\r\n\r\n" +
      body,
    () => socket.destroy(),
  );
};

/** 1005 and 1006 are reported locally but may never be sent in a close frame. */
const closePeer = (peer: WebSocket, code: number, reason: Buffer) => {
  if (peer.readyState === WebSocket.CLOSED) return;
  if (code === 1005 || code === 1006) {
    peer.terminate();
    return;
  }
  try {
    peer.close(code, reason);
  } catch {
    peer.terminate();
  }
};

/**
 * Relays a caller WebSocket to a node's `/ws`. The node socket is opened first, so a
 * caller only sees `101` once the node accepted its ticket; until then a failure is
 * an ordinary HTTP status on the caller socket.
 */
const makeUpgradeHandler = (dependencies: RouterDependencies) => {
  const callers = new WebSocketServer({ noServer: true, maxPayload: MAX_WS_PAYLOAD_BYTES });

  const relay = (caller: WebSocket, upstream: WebSocket) => {
    const shutdown = (code: number, reason: string) => {
      for (const peer of [caller, upstream]) {
        if (peer.readyState === WebSocket.OPEN) peer.close(code, reason);
        else peer.terminate();
      }
    };
    caller.on("message", (data, isBinary) => {
      const refused = screenCallerFrame(data, isBinary);
      if (refused) {
        shutdown(1008, refused);
        return;
      }
      upstream.send(rawText(data), { binary: false });
    });
    upstream.on("message", (data, isBinary) => {
      caller.send(data, { binary: isBinary });
    });
    caller.on("close", (code, reason) => closePeer(upstream, code, reason));
    upstream.on("close", (code, reason) => closePeer(caller, code, reason));
    caller.on("error", () => {
      caller.terminate();
      upstream.terminate();
    });
    upstream.on("error", () => {
      upstream.terminate();
      caller.terminate();
    });
  };

  return (request: NodeHttp.IncomingMessage, socket: NodeStream.Duplex, head: Buffer) => {
    socket.on("error", () => socket.destroy());
    const url = new URL(request.url ?? "/", "http://router.invalid");
    const match = /^\/nodes\/([^/]+)\/ws$/.exec(url.pathname);
    if (!match) {
      rejectUpgrade(socket, 404, "not_found");
      return;
    }
    let config: RouterConfig;
    try {
      config = dependencies.config();
    } catch {
      rejectUpgrade(socket, 500, "router_internal_error");
      return;
    }
    const node = config.nodes.find((candidate) => candidate.id === match[1]);
    if (!node) {
      rejectUpgrade(socket, 404, "unknown_node");
      return;
    }
    const ticket = url.searchParams.get("wsTicket")?.trim() ?? "";
    if (!ticket) {
      rejectUpgrade(socket, 401, "missing_ws_ticket");
      return;
    }
    if (
      request.headers.upgrade?.toLowerCase() !== "websocket" ||
      !request.headers["sec-websocket-key"]
    ) {
      rejectUpgrade(socket, 400, "invalid_upgrade");
      return;
    }

    const target = new URL(node.baseUrl);
    target.protocol = target.protocol === "https:" ? "wss:" : "ws:";
    target.pathname = `${target.pathname.replace(/\/$/, "")}/ws`;
    target.search = new URLSearchParams({ wsTicket: ticket }).toString();

    let settled = false;
    const upstream = new WebSocket(target, {
      handshakeTimeout: WS_CONNECT_TIMEOUT_MS,
      followRedirects: false,
    });
    const fail = (status: number, code: string) => {
      if (settled) return;
      settled = true;
      upstream.terminate();
      rejectUpgrade(socket, status, code);
    };
    // The caller may hang up while the node handshake is still in flight.
    const abandon = () => {
      if (settled) return;
      settled = true;
      upstream.terminate();
    };
    socket.once("close", abandon);
    upstream.once("unexpected-response", (_request, response) => {
      response.resume();
      const status = response.statusCode ?? 502;
      fail(status === 401 || status === 403 ? status : 502, "node_rejected_upgrade");
    });
    upstream.on("error", () => fail(502, "node_unreachable"));
    upstream.once("open", () => {
      if (settled) return;
      settled = true;
      socket.off("close", abandon);
      // If the caller handshake turns out invalid, ws aborts it and destroys the
      // socket without invoking the callback; the node socket must not outlive it.
      const orphan = () => upstream.terminate();
      socket.once("close", orphan);
      callers.handleUpgrade(request, socket, head, (caller) => {
        socket.off("close", orphan);
        relay(caller, upstream);
      });
    });
  };
};

export const startRouterServer = (
  dependencies: RouterDependencies,
  listen: { readonly host: string; readonly port: number },
): Promise<NodeHttp.Server> =>
  new Promise((resolve, reject) => {
    const handler = makeRouterHandler(dependencies);
    const server = NodeHttp.createServer((request, response) => {
      void handler(request, response);
    });
    server.on("upgrade", makeUpgradeHandler(dependencies));
    server.once("error", reject);
    server.listen(listen.port, listen.host, () => {
      server.off("error", reject);
      resolve(server);
    });
  });
