import * as Effect from "effect/Effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";
import ProjectEnvironment from "./041_ProjectEnvironment.ts";
import ProjectIsAuto from "./042_ProjectIsAuto.ts";
import ProjectGroup from "./043_ProjectGroup.ts";

// Fork installations have already recorded 52-55. Keep those IDs stable;
// upstream 52 adds title state instead. Reconcile both upgrade histories.
export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  yield* ProjectEnvironment;
  yield* ProjectIsAuto;
  yield* ProjectGroup;
  const columns = yield* sql<{ readonly name: string }>`PRAGMA table_info(projection_threads)`;
  if (!columns.some((column) => column.name === "title_state_json")) {
    yield* sql`ALTER TABLE projection_threads ADD COLUMN title_state_json TEXT`;
  }
});
