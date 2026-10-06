import * as Clock from "effect/Clock";
import * as TestClock from "effect/testing/TestClock";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { EnvironmentHttpApi } from "@t3tools/contracts";
import { expect, it } from "@effect/vitest";
import * as Context from "effect/Context";
import * as Crypto from "effect/Crypto";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Redacted from "effect/Redacted";
import * as Schema from "effect/Schema";
import * as Etag from "effect/unstable/http/Etag";
import * as HttpPlatform from "effect/unstable/http/HttpPlatform";
import * as HttpApiBuilder from "effect/unstable/httpapi/HttpApiBuilder";
import * as HttpApi from "effect/unstable/httpapi/HttpApi";
import * as HttpRouter from "effect/unstable/http/HttpRouter";

import * as ServerConfig from "../config.ts";
import * as ServerEnvironment from "../environment/ServerEnvironment.ts";
import { SqlitePersistenceMemory } from "../persistence/Layers/Sqlite.ts";
import * as EnvironmentAuth from "./EnvironmentAuth.ts";
import * as ServerSecretStore from "./ServerSecretStore.ts";
import { authHttpApiLayer, environmentAuthenticatedAuthLayer } from "./http.ts";

const DEV_TOKEN = "reusable-dev-auth-token-that-is-long-enough";
class AuthTestApi extends HttpApi.make("environment").add(EnvironmentHttpApi.groups.auth) {}

const configLayer = Layer.effect(
  ServerConfig.ServerConfig,
  Effect.gen(function* () {
    const config = yield* ServerConfig.ServerConfig;
    return {
      ...config,
      mode: "web",
      devUrl: new URL("http://127.0.0.1:5173"),
      devAuthToken: Redacted.make(DEV_TOKEN),
    } satisfies ServerConfig.ServerConfig["Service"];
  }),
).pipe(Layer.provide(ServerConfig.layerTest(process.cwd(), { prefix: "t3-auth-http-test-" })));

const environmentAuthLayer = EnvironmentAuth.layer.pipe(
  Layer.provide(SqlitePersistenceMemory),
  Layer.provide(ServerSecretStore.layer),
  Layer.provide(ServerEnvironment.identityLayer),
  Layer.provide(configLayer),
);
const routesLayer = HttpApiBuilder.layer(AuthTestApi).pipe(
  Layer.provide(authHttpApiLayer),
  Layer.provide(environmentAuthenticatedAuthLayer),
  Layer.provideMerge(environmentAuthLayer),
  Layer.provide(configLayer),
  Layer.provideMerge(
    HttpPlatform.layer.pipe(
      Layer.provideMerge(NodeServices.layer),
      Layer.provideMerge(Etag.layerWeak),
    ),
  ),
  Layer.provide(NodeServices.layer),
);

const encodeJson = Schema.encodeSync(Schema.fromJsonString(Schema.Unknown));
const postJson = (path: string, body: unknown, headers?: Readonly<Record<string, string>>) =>
  new Request(`http://127.0.0.1${path}`, {
    method: "POST",
    headers: { "content-type": "application/json", ...headers },
    body: encodeJson(body),
  });

it.effect("sets the selected browser session cookies through the HTTP route", () =>
  Effect.gen(function* () {
    const crypto = yield* Crypto.Crypto;
    const testClock = yield* TestClock.testClockWith(Effect.succeed);
    const unusedSecretStore = ServerSecretStore.ServerSecretStore.of({
      get: () => Effect.succeed(Option.none()),
      set: () => Effect.void,
      create: () => Effect.void,
      getOrCreateRandom: () => Effect.die("Not used by these routes."),
      remove: () => Effect.void,
    });
    const requestContext = Context.make(Crypto.Crypto, crypto).pipe(
      Context.add(ServerSecretStore.ServerSecretStore, unusedSecretStore),
      Context.add(Clock.Clock, testClock),
    );
    return yield* Effect.acquireUseRelease(
      Effect.sync(
        () =>
          [
            HttpRouter.toWebHandler(routesLayer, { disableLogger: true }),
            HttpRouter.toWebHandler(routesLayer, { disableLogger: true }),
          ] as const,
      ),
      ([environmentA, environmentB]) =>
        Effect.gen(function* () {
          const devResponse = yield* Effect.promise(() =>
            environmentA.handler(
              postJson("/api/auth/browser-session", { credential: DEV_TOKEN }),
              requestContext,
            ),
          );
          expect(devResponse.status).toBe(200);
          const devCookies = devResponse.headers.getSetCookie();
          const devCookie = devCookies.find((cookie) => cookie.startsWith("t3_dev_session_"));
          expect(devCookie).toContain("HttpOnly");
          expect(devCookie).toContain(`=${DEV_TOKEN};`);
          expect(devCookies).toContainEqual(
            expect.stringMatching(/^t3_session_[^=]*=;.*Max-Age=0/),
          );
          const devCookieHeader = devCookie?.split(";", 1)[0] ?? "";
          const environmentBSession = yield* Effect.promise(() =>
            environmentB.handler(
              new Request("http://127.0.0.1/api/auth/session", {
                headers: { cookie: devCookieHeader },
              }),
              requestContext,
            ),
          );
          expect(environmentBSession.status).toBe(200);
          expect(yield* Effect.promise(() => environmentBSession.json())).toMatchObject({
            authenticated: true,
          });

          const pairingResponse = yield* Effect.promise(() =>
            environmentA.handler(
              postJson(
                "/api/auth/pairing-token",
                { scopes: ["orchestration:read"] },
                { cookie: devCookieHeader },
              ),
              requestContext,
            ),
          );
          expect(pairingResponse.status).toBe(200);
          const pairing = (yield* Effect.promise(() => pairingResponse.json())) as {
            credential: string;
          };
          const restrictedResponse = yield* Effect.promise(() =>
            environmentA.handler(
              postJson("/api/auth/browser-session", { credential: pairing.credential }),
              requestContext,
            ),
          );
          expect(restrictedResponse.status).toBe(200);
          const restrictedCookies = restrictedResponse.headers.getSetCookie();
          expect(restrictedCookies).toHaveLength(1);
          expect(restrictedCookies[0]).toMatch(/^t3_session_/);
          expect(restrictedCookies[0]).not.toContain("t3_dev_session_");
          const originalCookie = restrictedCookies[0]?.split(";", 1)[0] ?? "";
          const bearerPairResponse = yield* Effect.promise(() =>
            environmentA.handler(
              postJson(
                "/api/auth/pairing-token",
                { scopes: ["orchestration:read"] },
                { cookie: devCookieHeader },
              ),
              requestContext,
            ),
          );
          const bearerPair = (yield* Effect.promise(() => bearerPairResponse.json())) as {
            credential: string;
          };
          const bearerResponse = yield* Effect.promise(() =>
            environmentA.handler(
              new Request("http://127.0.0.1/oauth/token", {
                method: "POST",
                body: new URLSearchParams({
                  grant_type: "urn:ietf:params:oauth:grant-type:token-exchange",
                  subject_token_type: "urn:t3:params:oauth:token-type:environment-bootstrap",
                  subject_token: bearerPair.credential,
                  requested_token_type: "urn:ietf:params:oauth:token-type:access_token",
                }),
              }),
              requestContext,
            ),
          );
          expect(bearerResponse.status).toBe(200);
          const bearer = (yield* Effect.promise(() => bearerResponse.json())) as {
            access_token: string;
          };
          yield* testClock.adjust("24 days");
          const renewedBearerResponse = yield* Effect.promise(() =>
            environmentA.handler(
              postJson(
                "/api/auth/session/renew",
                {},
                { authorization: `Bearer ${bearer.access_token}` },
              ),
              requestContext,
            ),
          );
          expect(renewedBearerResponse.status).toBe(200);
          expect(renewedBearerResponse.headers.get("cache-control")).toBe("no-store");
          expect(renewedBearerResponse.headers.getSetCookie()).toEqual([]);
          const renewedBearer = (yield* Effect.promise(() => renewedBearerResponse.json())) as {
            access_token: string;
            scope: string;
          };
          expect(renewedBearer.access_token).not.toBe(bearer.access_token);
          expect(renewedBearer.scope).toBe("orchestration:read");
          const cookieRenewal = yield* Effect.promise(() =>
            environmentA.handler(
              postJson("/api/auth/session/renew", {}, { cookie: originalCookie }),
              requestContext,
            ),
          );
          expect(cookieRenewal.status).toBe(401);
          const renewedResponse = yield* Effect.promise(() =>
            environmentA.handler(
              new Request("http://127.0.0.1/api/auth/session", {
                headers: { cookie: originalCookie },
              }),
              requestContext,
            ),
          );
          expect(renewedResponse.status).toBe(200);
          const renewedCookie = renewedResponse.headers.getSetCookie()[0];
          expect(renewedCookie).toContain("HttpOnly");
          expect(renewedCookie).toContain("SameSite=Lax");
          expect(renewedCookie?.split(";", 1)[0]).not.toBe(originalCookie);
          expect(yield* Effect.promise(() => renewedResponse.json())).toMatchObject({
            authenticated: true,
            scopes: ["orchestration:read"],
          });
          const replay = yield* Effect.promise(() =>
            environmentA.handler(
              new Request("http://127.0.0.1/api/auth/session", {
                headers: { cookie: renewedCookie?.split(";", 1)[0] ?? "" },
              }),
              requestContext,
            ),
          );
          expect(replay.headers.getSetCookie()).toEqual([]);
        }),
      ([environmentA, environmentB]) =>
        Effect.promise(() => Promise.all([environmentA.dispose(), environmentB.dispose()])),
    );
  }).pipe(Effect.provide(NodeServices.layer)),
);
