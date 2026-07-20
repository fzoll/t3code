import * as Effect from "effect/Effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";

import { getDialect } from "./helpers.ts";

export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  const dialect = yield* getDialect;

  if (dialect === "postgresql") {
    yield* sql`
      UPDATE orchestration_events
      SET payload_json = jsonb_set(payload_json::jsonb, '{runtimeMode}', '"full-access"')::text
      WHERE event_type = 'thread.created'
        AND payload_json::jsonb->>'runtimeMode' IS NULL
    `;
  } else {
    yield* sql`
      UPDATE orchestration_events
      SET payload_json = json_set(payload_json, '$.runtimeMode', 'full-access')
      WHERE event_type = 'thread.created'
        AND json_type(payload_json, '$.runtimeMode') IS NULL
    `;
  }
});
