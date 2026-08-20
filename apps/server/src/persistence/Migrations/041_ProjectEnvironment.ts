import * as SqlClient from "effect/unstable/sql/SqlClient";
import * as Effect from "effect/Effect";

export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;

  const existing = yield* sql`
    SELECT COUNT(*) as cnt FROM pragma_table_info('projection_projects')
    WHERE name = 'environment_json'
  `;
  if (Number(existing[0]?.cnt) === 0) {
    yield* sql`
      ALTER TABLE projection_projects
      ADD COLUMN environment_json TEXT NOT NULL DEFAULT '[]'
    `;
  }
});
