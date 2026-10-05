import { assert, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";
import * as NodeSqliteClient from "@t3tools/shared/nodeSqliteClient";

import { runMigrations } from "../Migrations.ts";
import ProjectEnvironment from "./041_ProjectEnvironment.ts";
import ProjectIsAuto from "./042_ProjectIsAuto.ts";
import ProjectGroup from "./043_ProjectGroup.ts";

for (const firstForkId of [37, 41]) {
  it.effect(`repairs fork migrations starting at ${firstForkId} before upstream consumers`, () =>
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      yield* runMigrations({ toMigrationInclusive: firstForkId - 1 });
      const fork = [
        ["ProjectEnvironment", ProjectEnvironment],
        ["ProjectIsAuto", ProjectIsAuto],
        ["ProjectGroup", ProjectGroup],
      ] as const;
      for (const [offset, [name, migration]] of fork.entries()) {
        yield* migration;
        yield* sql`INSERT INTO effect_sql_migrations (migration_id, name, created_at)
          VALUES (${firstForkId + offset}, ${name}, '2026-01-01')`;
      }
      if (firstForkId === 41) {
        yield* sql`INSERT INTO effect_sql_migrations (migration_id, name, created_at)
          VALUES (44, 'ReconcileRenumberedForkMigrations', '2026-01-01')`;
      }
      yield* runMigrations();
      // Exercise consumers of the skipped upstream and retained fork columns.
      yield* sql`SELECT client_surface, client_app_version FROM auth_sessions`;
      yield* sql`SELECT pin_order_key, unsettled_at FROM projection_threads`;
      yield* sql`SELECT default_thread_env_mode, environment_json, is_auto, "group"
        FROM projection_projects`;
      const indexes = yield* sql<{ name: string }>`PRAGMA index_list(projection_turns)`;
      assert(indexes.some((index) => index.name === "idx_projection_turns_thread_keyset"));
      assert.deepStrictEqual(yield* runMigrations(), []);
    }).pipe(Effect.provide(NodeSqliteClient.layerMemory())),
  );
}
