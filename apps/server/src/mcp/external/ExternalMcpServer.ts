import { EnvironmentAuthenticatedPrincipal } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import type * as Types from "effect/Types";
import { McpProtocol, McpServer } from "effect/unstable/ai";
import { HttpRouter, HttpServerRequest, HttpServerResponse } from "effect/unstable/http";

import packageJson from "../../../package.json" with { type: "json" };
import * as EnvironmentAuth from "../../auth/EnvironmentAuth.ts";
import { normalizeMcpHttpResponse } from "../McpHttpServer.ts";
import { ExternalToolkitHandlersLive } from "./handlers.ts";
import { ExternalToolkit } from "./tools.ts";

const unauthorized = HttpServerResponse.jsonUnsafe(
  {
    error: "invalid_environment_credential",
    message: "A valid T3 environment bearer access token is required.",
  },
  {
    status: 401,
    headers: {
      "cache-control": "no-store",
      "www-authenticate": "Bearer",
    },
  },
);

type AuthenticatedHttpEffect = Effect.Effect<
  HttpServerResponse.HttpServerResponse,
  Types.unhandled,
  EnvironmentAuthenticatedPrincipal
>;

const makeAuthMiddleware = EnvironmentAuth.EnvironmentAuth.pipe(
  Effect.map((serverAuth) =>
    Effect.fn("ExternalMcpServer.authenticateRequest")(function* (
      httpEffect: AuthenticatedHttpEffect,
    ) {
      const request = yield* HttpServerRequest.HttpServerRequest;
      const session = yield* serverAuth.authenticateHttpRequest(request).pipe(Effect.option);
      if (session._tag === "None") {
        yield* Effect.logWarning("rejected external MCP request with an unusable credential");
        return unauthorized;
      }
      return yield* httpEffect.pipe(
        Effect.provideService(EnvironmentAuthenticatedPrincipal, {
          ...session.value,
          scopes: new Set(session.value.scopes),
        }),
        Effect.map(normalizeMcpHttpResponse),
      );
    }),
  ),
  Effect.withSpan("ExternalMcpServer.makeAuthMiddleware"),
);

const ExternalMcpAuthMiddlewareLive = HttpRouter.middleware<{
  provides: EnvironmentAuthenticatedPrincipal;
}>()(makeAuthMiddleware).layer;

const ExternalMcpTransportLive = McpServer.layerHttp({
  name: "T3 Code Diagnostics",
  version: packageJson.version,
  path: "/mcp/external",
  protocols: [McpProtocol.v2025_06_18],
}).pipe(Layer.provide(ExternalMcpAuthMiddlewareLive));

// Layer.fresh wraps toolkit registration and transport together so both
// resolve one private McpServer registry: the module-level McpServer.layer
// is otherwise memoized across transports and the diagnostic toolkit would
// leak into the provider-session /mcp endpoint (and vice versa).
export const layer = Layer.fresh(
  McpServer.toolkit(ExternalToolkit).pipe(
    Layer.provide(ExternalToolkitHandlersLive),
    Layer.provideMerge(ExternalMcpTransportLive),
  ),
);
