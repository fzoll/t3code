import * as Effect from "effect/Effect";

import * as ProcessRunner from "../processRunner.ts";

const GIT_SHA_PATTERN = /^[0-9a-f]{40}$/i;

/**
 * Source-mode nodes (e.g. an RPi running `node apps/server/src/bin.ts serve`
 * directly from a git checkout) never rebuild `apps/web/dist` on `git pull`.
 * A stale bundle then fails to decode the running server's wire schema,
 * surfacing as a generic SchemaError instead of a clear "rebuild the web
 * client" message. Stamping the real checkout SHA into serverVersion lets
 * the existing client/server version-mismatch check catch that drift even
 * when package.json's semver hasn't moved.
 */
export const resolveServerBuildSha = Effect.fn("resolveServerBuildSha")(function* () {
  const processRunner = yield* ProcessRunner.ProcessRunner;
  const result = yield* processRunner
    .run({
      command: "git",
      args: ["rev-parse", "HEAD"],
      cwd: import.meta.dirname,
      timeoutBehavior: "timedOutResult",
    })
    .pipe(
      Effect.catch((cause) =>
        Effect.logDebug("Could not resolve the server's build SHA.", { cause }).pipe(
          Effect.as(null),
        ),
      ),
    );

  if (result === null || result.timedOut || result.code !== 0) {
    return null;
  }

  const sha = result.stdout.trim().toLowerCase();
  return GIT_SHA_PATTERN.test(sha) ? sha : null;
});
