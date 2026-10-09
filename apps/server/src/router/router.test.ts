// @effect-diagnostics nodeBuiltinImport:off globalFetch:off - drives the real node:http router over loopback.
import * as NodeHttp from "node:http";
import type * as NodeNet from "node:net";

import { afterEach, describe, expect, it } from "vite-plus/test";
import { WebSocket, WebSocketServer } from "ws";

import { PlacementError, place, type NodeObservation } from "./placement.ts";
import { parseRouterConfig, type RouterConfig, type RouterNode } from "./routerConfig.ts";
import { redactProjectEnvironment, screenCallerFrame, startRouterServer } from "./routerServer.ts";

const NOW = 1_000_000;

const node = (id: string, extra: Partial<RouterNode> = {}): Record<string, unknown> => ({
  id,
  baseUrl: `http://${id}.test:3773`,
  tokenFile: `/secrets/${id}.token`,
  workspaceBase: `/work/${id}`,
  weight: 1,
  ...extra,
});

const config = (nodes: ReadonlyArray<Record<string, unknown>>): RouterConfig =>
  parseRouterConfig({ tokenFile: "/secrets/router.token", nodes });

const resources = (cpuUtilization: number, cpuCount = 4) => ({
  sampledAt: NOW,
  cpuUtilization,
  cpuCount,
  availableMemoryBytes: 8,
  totalMemoryBytes: 16,
});

const observer =
  (byId: Record<string, NodeObservation | Error>) =>
  async (target: RouterNode): Promise<NodeObservation> => {
    const value = byId[target.id];
    if (!value || value instanceof Error) throw value ?? new Error("missing");
    return value;
  };

const observation = (id: string, cpu: number): NodeObservation => ({
  environmentId: `env-${id}`,
  hostResources: resources(cpu),
  receivedAt: NOW,
});

const placementError = async (promise: Promise<unknown>) => {
  try {
    await promise;
  } catch (error) {
    if (error instanceof PlacementError) return error.code;
    throw error;
  }
  throw new Error("expected a placement error");
};

describe("parseRouterConfig", () => {
  it("normalizes nodes and defaults", () => {
    const parsed = config([
      node("rpi", { baseUrl: "http://127.0.0.1:3773/" }),
      node("mac", { weight: 4 }),
    ]);
    expect(
      parsed.nodes.map((entry) => [entry.id, entry.baseUrl, entry.weight, entry.enabled]),
    ).toEqual([
      ["rpi", "http://127.0.0.1:3773", 1, true],
      ["mac", "http://mac.test:3773", 4, true],
    ]);
  });

  it("rejects duplicate ids, relative paths and credentials in URLs", () => {
    expect(() => config([node("rpi"), node("rpi")])).toThrow(/duplicate/);
    expect(() => config([node("rpi", { tokenFile: "rpi.token" })])).toThrow(/absolute/);
    expect(() => config([node("rpi", { baseUrl: "http://user:pw@rpi:3773" })])).toThrow(
      /credentials/,
    );
    expect(() => config([])).toThrow(/non-empty/);
  });
});

describe("place", () => {
  const registry = config([
    node("rpi"),
    node("mac", { weight: 4 }),
    node("ha", { workspaces: ["other"] }),
  ]);

  it("honours a dedicated node even when another one is idler", async () => {
    const placement = await place(
      registry,
      { workspace: "RPI_Hermes", node: "rpi" },
      observer({ rpi: observation("rpi", 0.9), mac: observation("mac", 0) }),
      () => NOW,
    );
    expect(placement).toEqual({
      nodeId: "rpi",
      environmentId: "env-rpi",
      workspaceRoot: "/work/rpi/RPI_Hermes",
      reason: "requested",
    });
  });

  it("load-balances over nodes that host the workspace", async () => {
    const placement = await place(
      registry,
      { workspace: "RPI_Hermes" },
      observer({
        rpi: observation("rpi", 0),
        mac: observation("mac", 0.5),
        ha: observation("ha", 0),
      }),
      () => NOW,
    );
    expect(placement.nodeId).toBe("mac");
    expect(placement.reason).toBe("load_balanced");
  });

  it("skips unreachable nodes and fails closed when nothing is eligible", async () => {
    const placement = await place(
      registry,
      { workspace: "RPI_Hermes" },
      observer({ rpi: observation("rpi", 0.2), mac: new Error("down") }),
      () => NOW,
    );
    expect(placement.nodeId).toBe("rpi");
    expect(
      await placementError(
        place(
          registry,
          { workspace: "RPI_Hermes" },
          observer({ rpi: new Error("down"), mac: new Error("down") }),
          () => NOW,
        ),
      ),
    ).toBe("no_eligible_node");
  });

  it("carries the node web origin for thread links", async () => {
    const withWeb = config([
      node("rpi", { webUrl: "http://hermes.test:3773/" } as Partial<RouterNode>),
    ]);
    const placement = await place(
      withWeb,
      { workspace: "w" },
      observer({ rpi: observation("rpi", 0) }),
      () => NOW,
    );
    expect(placement.webUrl).toBe("http://hermes.test:3773");
    expect(() => config([node("rpi", { webUrl: "http://u:p@x" } as Partial<RouterNode>)])).toThrow(
      /webUrl/,
    );
  });

  it("refuses unknown, disabled or non-hosting dedicated nodes", async () => {
    const all = observer({
      rpi: observation("rpi", 0),
      mac: observation("mac", 0),
      ha: observation("ha", 0),
    });
    expect(await placementError(place(registry, { workspace: "x", node: "nope" }, all))).toBe(
      "unknown_node",
    );
    expect(
      await placementError(place(registry, { workspace: "RPI_Hermes", node: "ha" }, all)),
    ).toBe("workspace_not_on_node");
    const disabled = config([node("rpi", { enabled: false })]);
    expect(await placementError(place(disabled, { workspace: "x", node: "rpi" }, all))).toBe(
      "node_disabled",
    );
    expect(await placementError(place(disabled, { workspace: "x" }, all))).toBe(
      "workspace_not_hosted",
    );
  });
});

describe("router server", () => {
  const servers: NodeHttp.Server[] = [];
  afterEach(async () => {
    await Promise.all(
      servers.splice(0).map((server) => new Promise((resolve) => server.close(resolve))),
    );
  });

  const secrets: Record<string, string> = {
    "/secrets/router.token": "router-secret",
    "/secrets/rpi.token": "rpi-secret",
    "/secrets/mac.token": "mac-secret",
  };

  const start = async (
    fetchImpl: typeof globalThis.fetch,
    registry = config([node("rpi"), node("mac", { environmentId: "env-mac" })]),
  ) => {
    const server = await startRouterServer(
      {
        config: () => registry,
        fetch: fetchImpl,
        secret: (path) => secrets[path]!,
        now: () => NOW,
      },
      { host: "127.0.0.1", port: 0 },
    );
    servers.push(server);
    return `http://127.0.0.1:${(server.address() as NodeNet.AddressInfo).port}`;
  };

  const auth = { authorization: "Bearer router-secret" };

  it("requires the router token", async () => {
    const base = await start(async () => new Response("{}"));
    expect((await fetch(`${base}/api/router/nodes`)).status).toBe(401);
    expect(
      (await fetch(`${base}/api/router/nodes`, { headers: { authorization: "Bearer wrong" } }))
        .status,
    ).toBe(401);
    expect((await fetch(`${base}/healthz`)).status).toBe(200);
  });

  it("forwards allowed T3 routes with the node token, query and body intact", async () => {
    const seen: Array<{
      url: string;
      method: string;
      authorization: string | null;
      body: string | null;
    }> = [];
    const base = await start(async (input, init) => {
      const headers = new Headers(init?.headers);
      seen.push({
        url: String(input),
        method: init?.method ?? "GET",
        authorization: headers.get("authorization"),
        body: init?.body ? Buffer.from(init.body as Uint8Array).toString("utf8") : null,
      });
      return new Response(JSON.stringify({ accepted: true }), {
        status: 202,
        headers: { "content-type": "application/json" },
      });
    });
    const threads = await fetch(`${base}/nodes/rpi/api/orchestration/threads/t-1?turnLimit=5`, {
      headers: auth,
    });
    expect(threads.status).toBe(202);
    expect(threads.headers.get("x-t3-router-node")).toBe("rpi");
    const dispatch = await fetch(`${base}/nodes/mac/api/orchestration/dispatch`, {
      method: "POST",
      headers: { ...auth, "content-type": "application/json" },
      body: JSON.stringify({ type: "thread.turn.start" }),
    });
    expect(await dispatch.json()).toEqual({ accepted: true });
    expect(seen).toEqual([
      {
        url: "http://rpi.test:3773/api/orchestration/threads/t-1?turnLimit=5",
        method: "GET",
        authorization: "Bearer rpi-secret",
        body: null,
      },
      {
        url: "http://mac.test:3773/api/orchestration/dispatch",
        method: "POST",
        authorization: "Bearer mac-secret",
        body: '{"type":"thread.turn.start"}',
      },
    ]);
  });

  it("does not forward routes outside the allowlist or to unknown nodes", async () => {
    let calls = 0;
    const base = await start(async () => {
      calls += 1;
      return new Response("{}");
    });
    expect((await fetch(`${base}/nodes/rpi/api/settings`, { headers: auth })).status).toBe(404);
    expect(
      (await fetch(`${base}/nodes/rpi/api/orchestration/dispatch`, { headers: auth })).status,
    ).toBe(404);
    expect(
      (await fetch(`${base}/nodes/zzz/api/orchestration/snapshot`, { headers: auth })).status,
    ).toBe(404);
    expect(calls).toBe(0);
  });

  it("blanks project environment values in forwarded snapshots", async () => {
    const base = await start(
      async () =>
        new Response(
          JSON.stringify({
            projects: [
              {
                id: "p",
                workspaceRoot: "/w",
                environment: [{ name: "GH_TOKEN", value: "ghp_SECRET", sensitive: false }],
              },
            ],
          }),
          { headers: { "content-type": "application/json" } },
        ),
    );
    const response = await fetch(`${base}/nodes/rpi/api/orchestration/snapshot`, { headers: auth });
    const text = await response.text();
    expect(text).not.toContain("ghp_SECRET");
    expect(JSON.parse(text).projects[0]).toMatchObject({
      id: "p",
      workspaceRoot: "/w",
      environment: [{ name: "GH_TOKEN", value: "", valueRedacted: true }],
    });
    expect(() => redactProjectEnvironment(Buffer.from("not json"))).toThrow();
  });

  it("places from live descriptors and treats a swapped environment id as unreachable", async () => {
    const base = await start(async (input) => {
      const url = String(input);
      const id = url.includes("rpi") ? "env-rpi" : "env-impostor";
      return new Response(
        JSON.stringify({ environmentId: id, resources: { hostResources: resources(0.1) } }),
        { headers: { "content-type": "application/json" } },
      );
    });
    const response = await fetch(`${base}/api/router/placements`, {
      method: "POST",
      headers: { ...auth, "content-type": "application/json" },
      body: JSON.stringify({ workspace: "RPI_Hermes" }),
    });
    expect(await response.json()).toEqual({
      nodeId: "rpi",
      environmentId: "env-rpi",
      workspaceRoot: "/work/rpi/RPI_Hermes",
      reason: "load_balanced",
    });
    const pinned = await fetch(`${base}/api/router/placements`, {
      method: "POST",
      headers: { ...auth, "content-type": "application/json" },
      body: JSON.stringify({ workspace: "RPI_Hermes", node: "mac" }),
    });
    expect(pinned.status).toBe(503);
    expect(await pinned.json()).toEqual({ error: "node_unreachable" });
    const bad = await fetch(`${base}/api/router/placements`, {
      method: "POST",
      headers: { ...auth, "content-type": "application/json" },
      body: JSON.stringify({ workspace: "../etc" }),
    });
    expect(bad.status).toBe(400);
  });

  it("forwards the websocket ticket route with the node token", async () => {
    const seen: Array<{ url: string; method: string; authorization: string | null }> = [];
    const base = await start(async (input, init) => {
      seen.push({
        url: String(input),
        method: init?.method ?? "GET",
        authorization: new Headers(init?.headers).get("authorization"),
      });
      return new Response(JSON.stringify({ ticket: "t-1" }), {
        headers: { "content-type": "application/json" },
      });
    });
    const response = await fetch(`${base}/nodes/rpi/api/auth/websocket-ticket`, {
      method: "POST",
      headers: auth,
    });
    expect(await response.json()).toEqual({ ticket: "t-1" });
    expect(
      (await fetch(`${base}/nodes/rpi/api/auth/websocket-ticket`, { method: "POST" })).status,
    ).toBe(401);
    expect(seen).toEqual([
      {
        url: "http://rpi.test:3773/api/auth/websocket-ticket",
        method: "POST",
        authorization: "Bearer rpi-secret",
      },
    ]);
  });
});

describe("router websocket relay", () => {
  const servers: NodeHttp.Server[] = [];
  const sockets: WebSocket[] = [];
  afterEach(async () => {
    for (const socket of sockets.splice(0)) socket.terminate();
    await Promise.all(
      servers.splice(0).map((server) => new Promise((resolve) => server.close(resolve))),
    );
  });

  const listen = (server: NodeHttp.Server) =>
    new Promise<number>((resolve) => {
      servers.push(server);
      server.listen(0, "127.0.0.1", () => resolve((server.address() as NodeNet.AddressInfo).port));
    });

  /** A T3 node stand-in: accepts ticket `t-1` and answers every request with Success. */
  const startNode = async () => {
    const frames: unknown[] = [];
    const upgrades: string[] = [];
    const closes: number[] = [];
    const nodeSockets = new WebSocketServer({ noServer: true });
    const server = NodeHttp.createServer();
    server.on("upgrade", (request, socket, head) => {
      upgrades.push(request.url ?? "");
      if (!request.url?.startsWith("/ws?wsTicket=t-1")) {
        socket.end("HTTP/1.1 401 Unauthorized\r\nContent-Length: 0\r\n\r\n");
        return;
      }
      nodeSockets.handleUpgrade(request, socket, head, (peer) => {
        peer.on("close", (code) => closes.push(code));
        peer.on("message", (data) => {
          const frame = JSON.parse(String(data)) as { _tag: string; id?: string };
          frames.push(frame);
          if (frame._tag === "Request") {
            peer.send(
              JSON.stringify({
                _tag: "Exit",
                requestId: frame.id,
                exit: { _tag: "Success", value: { sequence: 7 } },
              }),
            );
          }
        });
      });
    });
    const port = await listen(server);
    return { baseUrl: `http://127.0.0.1:${port}`, frames, upgrades, closes };
  };

  const startRouter = async (nodeBaseUrl: string) => {
    const server = await startRouterServer(
      {
        config: () =>
          config([
            node("rpi", { baseUrl: nodeBaseUrl }),
            node("down", { baseUrl: "http://127.0.0.1:1" }),
          ]),
        fetch: async () => new Response("{}"),
        secret: () => "router-secret",
        now: () => NOW,
      },
      { host: "127.0.0.1", port: 0 },
    );
    servers.push(server);
    return `ws://127.0.0.1:${(server.address() as NodeNet.AddressInfo).port}`;
  };

  const connect = (url: string) =>
    new Promise<{ socket?: WebSocket; status?: number }>((resolve, reject) => {
      const socket = new WebSocket(url);
      sockets.push(socket);
      socket.once("open", () => resolve({ socket }));
      socket.once("unexpected-response", (_request, response) => {
        response.resume();
        resolve({ status: response.statusCode ?? 0 });
      });
      socket.on("error", reject);
    });

  const nextMessage = (socket: WebSocket) =>
    new Promise<unknown>((resolve) =>
      socket.once("message", (data) => resolve(JSON.parse(String(data)))),
    );

  const closed = (socket: WebSocket) =>
    new Promise<{ code: number; reason: string }>((resolve) =>
      socket.once("close", (code, reason) => resolve({ code, reason: reason.toString() })),
    );

  const dispatch = {
    _tag: "Request",
    id: "1",
    tag: "orchestration.dispatchCommand",
    payload: { type: "thread.turn.start" },
    headers: [],
  };

  it("relays allowed RPC frames and node replies, forwarding only the ticket", async () => {
    const fake = await startNode();
    const router = await startRouter(fake.baseUrl);
    const { socket } = await connect(`${router}/nodes/rpi/ws?wsTicket=t-1&clientSurface=x`);
    const reply = nextMessage(socket!);
    socket!.send(JSON.stringify({ _tag: "Ping" }));
    socket!.send(JSON.stringify(dispatch));
    expect(await reply).toEqual({
      _tag: "Exit",
      requestId: "1",
      exit: { _tag: "Success", value: { sequence: 7 } },
    });
    expect(fake.upgrades).toEqual(["/ws?wsTicket=t-1"]);
    expect(fake.frames).toEqual([{ _tag: "Ping" }, dispatch]);
    const done = closed(socket!);
    socket!.close(1000, "bye");
    expect((await done).code).toBe(1000);
  });

  it("closes both sides with 1008 on a disallowed RPC and never forwards it", async () => {
    const fake = await startNode();
    const router = await startRouter(fake.baseUrl);
    const { socket } = await connect(`${router}/nodes/rpi/ws?wsTicket=t-1`);
    const done = closed(socket!);
    socket!.send(JSON.stringify({ ...dispatch, tag: "server.getSettings" }));
    expect(await done).toEqual({ code: 1008, reason: "rpc_not_forwarded" });
    await expect.poll(() => fake.closes).toEqual([1008]);
    expect(fake.frames).toEqual([]);

    const batch = await connect(`${router}/nodes/rpi/ws?wsTicket=t-1`);
    const batchDone = closed(batch.socket!);
    batch.socket!.send(JSON.stringify([{ ...dispatch, tag: "server.getSettings" }]));
    expect(await batchDone).toEqual({ code: 1008, reason: "invalid_frame" });
    expect(fake.frames).toEqual([]);
  });

  it("refuses upgrades for unknown nodes, other paths, missing or rejected tickets", async () => {
    const fake = await startNode();
    const router = await startRouter(fake.baseUrl);
    expect((await connect(`${router}/nodes/zzz/ws?wsTicket=t-1`)).status).toBe(404);
    expect((await connect(`${router}/nodes/rpi/api/ws?wsTicket=t-1`)).status).toBe(404);
    expect((await connect(`${router}/ws?wsTicket=t-1`)).status).toBe(404);
    expect((await connect(`${router}/nodes/rpi/ws`)).status).toBe(401);
    expect((await connect(`${router}/nodes/rpi/ws?wsTicket=wrong`)).status).toBe(401);
    expect((await connect(`${router}/nodes/down/ws?wsTicket=t-1`)).status).toBe(502);
    expect(fake.upgrades).toEqual(["/ws?wsTicket=wrong"]);
  });

  it("screens caller frames", () => {
    const text = (value: unknown) => Buffer.from(JSON.stringify(value));
    expect(screenCallerFrame(text(dispatch), false)).toBeNull();
    expect(screenCallerFrame(text({ _tag: "Ack", requestId: "1" }), false)).toBeNull();
    expect(screenCallerFrame(text({ _tag: "Request", id: "2" }), false)).toBe("rpc_not_forwarded");
    expect(screenCallerFrame(text(dispatch), true)).toBe("invalid_frame");
    expect(screenCallerFrame(Buffer.from("{"), false)).toBe("invalid_frame");
    expect(screenCallerFrame(text(null), false)).toBe("invalid_frame");
  });
});
