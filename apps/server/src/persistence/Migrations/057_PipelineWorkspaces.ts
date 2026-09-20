import * as Effect from "effect/Effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";
export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  yield* sql`CREATE TABLE IF NOT EXISTS pipeline_workspaces (
    attempt_id TEXT PRIMARY KEY, payload TEXT NOT NULL, result TEXT
  )`;
});
