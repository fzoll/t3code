import * as Effect from "effect/Effect";

import Migration0037 from "./037_ProjectionTurnsKeysetIndex.ts";
import Migration0038 from "./038_ProjectionThreadsPinOrderKey.ts";
import Migration0039 from "./039_ProjectionProjectsDefaultThreadEnvMode.ts";
import Migration0041 from "./041_AuthSessionClientConnection.ts";
import Migration0042 from "./042_ProjectionThreadLinkedPullRequest.ts";
import Migration0043 from "./043_ProjectionThreadsUnsettledAt.ts";
import Migration0044 from "./044_ClearAutomaticProjectModelDefaults.ts";

/**
 * Reconciles databases created by this fork before it caught up with upstream.
 *
 * The fork's own migrations originally claimed ids 37-39 and, later, 41-44.
 * Upstream independently shipped different migrations under those same ids, so
 * the fork ones were renumbered (37-39 -> 41-43, then 41-44 -> 52-55) during
 * the merge onto upstream main. The migrator only runs ids greater than the
 * highest recorded one, so a database that already recorded the fork's ids will
 * never run upstream's migrations sharing those numbers, leaving columns like
 * `projection_threads.pin_order_key`, `projection_projects.default_thread_env_mode`,
 * `auth_sessions.client_surface`, `projection_threads.linked_pull_request_json`,
 * and `projection_threads.unsettled_at` missing.
 *
 * Re-running the affected upstream migrations here closes the gap. All of them
 * guard their own DDL (`CREATE INDEX IF NOT EXISTS`, `PRAGMA table_info` checks,
 * idempotent data UPDATEs), so this is a no-op on databases that already
 * applied them (fresh installs and pure-upstream databases included).
 */
export default Effect.gen(function* () {
  yield* Migration0037;
  yield* Migration0038;
  yield* Migration0039;
  yield* Migration0041;
  yield* Migration0042;
  yield* Migration0043;
  yield* Migration0044;
});
