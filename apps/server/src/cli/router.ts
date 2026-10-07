/**
 * `t3 router` - one entry point in front of several T3 servers.
 *
 * Callers (the Paperclip adapter) ask `POST /api/router/placements` for a node,
 * then talk to that node through `/nodes/<id>/...`. A dedicated node in the
 * request wins; otherwise the router picks with the same load-balancing rule the
 * web client uses. The node registry is a file the router re-reads on change,
 * so adding a node is a registry edit, never a caller change or a restart.
 */
import * as Console from "effect/Console";
import * as Effect from "effect/Effect";
import { Command, Flag } from "effect/unstable/cli";

import { makeConfigSource } from "../router/routerConfig.ts";
import { startRouterServer } from "../router/routerServer.ts";

export const routerCommand = Command.make("router", {
  config: Flag.string("config").pipe(
    Flag.withDescription("Path to the router node registry JSON."),
  ),
  host: Flag.string("host").pipe(
    Flag.withDescription("Listen address; keep it loopback or tailnet-only."),
    Flag.withDefault("127.0.0.1"),
  ),
  port: Flag.integer("port").pipe(Flag.withDescription("Listen port."), Flag.withDefault(3780)),
}).pipe(
  Command.withDescription("Route T3 orchestration work across several T3 servers."),
  Command.withHandler(({ config, host, port }) =>
    Effect.gen(function* () {
      const source = makeConfigSource(config);
      const loaded = yield* Effect.try(() => source());
      yield* Effect.acquireRelease(
        Effect.promise(() => startRouterServer({ config: source }, { host, port })),
        (server) =>
          Effect.promise(() => new Promise<void>((resolve) => server.close(() => resolve()))),
      );
      yield* Console.log(
        `t3 router listening on ${host}:${port} with nodes ${loaded.nodes.map((node) => node.id).join(", ")}`,
      );
      return yield* Effect.never;
    }),
  ),
);
