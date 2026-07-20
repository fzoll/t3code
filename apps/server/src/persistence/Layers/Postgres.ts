import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Redacted from "effect/Redacted";
import * as SqlClient from "effect/unstable/sql/SqlClient";
import * as PgClient from "@effect/sql-pg/PgClient";

import { runMigrations } from "../Migrations.ts";
import { setDbDialect } from "../DbDialect.ts";

const setup = Layer.effectDiscard(
  Effect.gen(function* () {
    setDbDialect("postgresql");
    const sql = yield* SqlClient.SqlClient;
    yield* sql`SELECT pg_advisory_lock(42)`;
    yield* runMigrations();
    yield* sql`SELECT pg_advisory_unlock(42)`;
  }),
);

export const makePostgresPersistenceLive = (databaseUrl: string) =>
  Layer.provideMerge(
    setup,
    PgClient.layer({
      url: Redacted.make(databaseUrl),
      maxConnections: 10,
      minConnections: 2,
      applicationName: "t3-server",
    }),
  );
