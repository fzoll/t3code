import * as SqlClient from "effect/unstable/sql/SqlClient";
import * as Effect from "effect/Effect";

import { columnExists } from "./helpers.ts";

export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;

  if (!(yield* columnExists("provider_session_runtime", "provider_instance_id"))) {
    yield* sql`
      ALTER TABLE provider_session_runtime
      ADD COLUMN provider_instance_id TEXT
    `;
  }

  yield* sql`
    CREATE INDEX IF NOT EXISTS idx_provider_session_runtime_instance
    ON provider_session_runtime(provider_instance_id)
  `;
});
