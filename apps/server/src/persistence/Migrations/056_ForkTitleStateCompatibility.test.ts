import { assert, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";
import * as NodeSqliteClient from "@t3tools/shared/nodeSqliteClient";
import { runMigrations } from "../Migrations.ts";

it.effect("upgrades deployed fork 55 without losing project settings", () =>
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    yield* runMigrations({ toMigrationInclusive: 55 });
    const before = yield* sql`SELECT * FROM effect_sql_migrations WHERE migration_id >= 52`;
    yield* runMigrations();
    yield* runMigrations();
    const columns = yield* sql<{ name: string }>`PRAGMA table_info(projection_threads)`;
    assert.equal(columns.filter((c) => c.name === "title_state_json").length, 1);
    assert.deepEqual(
      yield* sql`SELECT * FROM effect_sql_migrations WHERE migration_id BETWEEN 52 AND 55`,
      before,
    );
    const projects = yield* sql<{ name: string }>`PRAGMA table_info(projection_projects)`;
    assert.isTrue(projects.some((c) => c.name === "environment_json"));
  }).pipe(Effect.provide(NodeSqliteClient.layerMemory())),
);
it.effect("accepts upstream 52 and supplies fork fields", () =>
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    yield* runMigrations({ toMigrationInclusive: 51 });
    yield* sql`ALTER TABLE projection_threads ADD COLUMN title_state_json TEXT`;
    yield* sql`INSERT INTO effect_sql_migrations (migration_id, name) VALUES (52, 'ProjectionThreadTitleState')`;
    yield* runMigrations();
    const projects = yield* sql<{ name: string }>`PRAGMA table_info(projection_projects)`;
    assert.isTrue(projects.some((c) => c.name === "environment_json"));
    const columns = yield* sql<{ name: string }>`PRAGMA table_info(projection_threads)`;
    assert.equal(columns.filter((c) => c.name === "title_state_json").length, 1);
  }).pipe(Effect.provide(NodeSqliteClient.layerMemory())),
);
