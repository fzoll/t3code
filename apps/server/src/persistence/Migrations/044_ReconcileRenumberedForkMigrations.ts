import * as Effect from "effect/Effect";

import Migration0037 from "./037_ProjectionTurnsKeysetIndex.ts";
import Migration0038 from "./038_ProjectionThreadsPinOrderKey.ts";
import Migration0039 from "./039_ProjectionProjectsDefaultThreadEnvMode.ts";

/**
 * Reconciles databases created by this fork before it caught up with upstream.
 *
 * The fork's own migrations originally claimed ids 37-39. Upstream later
 * shipped different migrations under those same ids, so the fork ones were
 * renumbered to 41-43 during the merge. The migrator only runs ids greater
 * than the highest recorded one, which means a database that already recorded
 * the fork's 37-39 will never run upstream's 37-39 — leaving
 * `projection_threads.pin_order_key` and
 * `projection_projects.default_thread_env_mode` missing.
 *
 * Re-running those three here closes the gap. All of them guard their own DDL
 * (`CREATE INDEX IF NOT EXISTS`, `PRAGMA table_info` checks), so this is a
 * no-op on databases that already applied them.
 */
export default Effect.gen(function* () {
  yield* Migration0037;
  yield* Migration0038;
  yield* Migration0039;
});
