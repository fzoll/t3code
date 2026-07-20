import * as Effect from "effect/Effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";

import { columnExists } from "./helpers.ts";

export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;

  if (!(yield* columnExists("auth_pairing_links", "proof_key_thumbprint"))) {
    yield* sql`
      ALTER TABLE auth_pairing_links
      ADD COLUMN proof_key_thumbprint TEXT
    `;
  }
});
