// @effect-diagnostics nodeBuiltinImport:off globalFetch:off - drives the real node:http router over loopback.
import * as NodeHttp from "node:http";
import type * as NodeNet from "node:net";

import { afterEach, describe, expect, it } from "vite-plus/test";

import { PlacementError, place, type NodeObservation } from "./placement.ts";
import { parseRouterConfig, type RouterConfig, type RouterNode } from "./routerConfig.ts";
import { startRouterServer } from "./routerServer.ts";

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
});
