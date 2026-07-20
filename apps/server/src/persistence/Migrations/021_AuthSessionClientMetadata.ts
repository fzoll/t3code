import * as Effect from "effect/Effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";

import { columnExists } from "./helpers.ts";

export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;

  if (!(yield* columnExists("auth_pairing_links", "label"))) {
    yield* sql`
      ALTER TABLE auth_pairing_links
      ADD COLUMN label TEXT
    `;
  }

  if (!(yield* columnExists("auth_sessions", "client_label"))) {
    yield* sql`
      ALTER TABLE auth_sessions
      ADD COLUMN client_label TEXT
    `;
  }

  if (!(yield* columnExists("auth_sessions", "client_ip_address"))) {
    yield* sql`
      ALTER TABLE auth_sessions
      ADD COLUMN client_ip_address TEXT
    `;
  }

  if (!(yield* columnExists("auth_sessions", "client_user_agent"))) {
    yield* sql`
      ALTER TABLE auth_sessions
      ADD COLUMN client_user_agent TEXT
    `;
  }

  if (!(yield* columnExists("auth_sessions", "client_device_type"))) {
    yield* sql`
      ALTER TABLE auth_sessions
      ADD COLUMN client_device_type TEXT NOT NULL DEFAULT 'unknown'
    `;
  }

  if (!(yield* columnExists("auth_sessions", "client_os"))) {
    yield* sql`
      ALTER TABLE auth_sessions
      ADD COLUMN client_os TEXT
    `;
  }

  if (!(yield* columnExists("auth_sessions", "client_browser"))) {
    yield* sql`
      ALTER TABLE auth_sessions
      ADD COLUMN client_browser TEXT
    `;
  }
});
