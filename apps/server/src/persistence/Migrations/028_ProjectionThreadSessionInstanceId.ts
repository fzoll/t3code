import * as SqlClient from "effect/unstable/sql/SqlClient";
import * as Effect from "effect/Effect";

import { columnExists } from "./helpers.ts";

export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;

  if (!(yield* columnExists("projection_thread_sessions", "provider_instance_id"))) {
    yield* sql`
      ALTER TABLE projection_thread_sessions
      ADD COLUMN provider_instance_id TEXT
    `;
  }

  yield* sql`
    CREATE INDEX IF NOT EXISTS idx_projection_thread_sessions_instance
    ON projection_thread_sessions(provider_instance_id)
  `;
});
