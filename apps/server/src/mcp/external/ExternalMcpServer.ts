import { EnvironmentAuthenticatedPrincipal } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import type * as Types from "effect/Types";
import { HttpRouter, HttpServerRequest, HttpServerResponse } from "effect/http";

import * as EnvironmentAuth from "../../auth/EnvironmentAuth.ts";
import * as McpHttpServer from "../McpHttpServer.ts";
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
        Effect.map(McpHttpServer.normalizeMcpHttpResponse),
      );
    }),
  ),
  Effect.withSpan("ExternalMcpServer.makeAuthMiddleware"),
);

const ExternalMcpAuthMiddlewareLive = HttpRouter.middleware<{
  provides: EnvironmentAuthenticatedPrincipal;
}>()(makeAuthMiddleware).layer;

/**
 * `/mcp/external`: the diagnostic toolkit for operators holding an environment
 * bearer token, read tools under its read scope and operate tools under its
 * operate scope (see `handlers.ts`). It has its own registry, separate from the
 * provider-session `/mcp` endpoint.
 */
export const layer = McpHttpServer.layerEnvironmentTokenEndpoint({
  name: "T3 Code Diagnostics",
  path: "/mcp/external",
  authMiddleware: ExternalMcpAuthMiddlewareLive,
  toolkit: ExternalToolkit,
  handlers: ExternalToolkitHandlersLive,
});
