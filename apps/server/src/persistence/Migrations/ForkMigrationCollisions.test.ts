import { assert, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as SqlClient from "effect/sql/SqlClient";
import * as NodeSqliteClient from "@t3tools/shared/nodeSqliteClient";

import { migrationManifest, runMigrations } from "../Migrations.ts";
import ProjectEnvironment from "./063_ProjectEnvironment.ts";
import ProjectIsAuto from "./064_ProjectIsAuto.ts";
import ProjectGroup from "./065_ProjectGroup.ts";
import PipelineWorkspaces from "./066_PipelineWorkspaces.ts";
import ProjectionThreadTitleState from "./052_ProjectionThreadTitleState.ts";

const history = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  const rows = yield* sql<{ readonly migration_id: number; readonly name: string }>`
    SELECT migration_id, name FROM effect_sql_migrations ORDER BY migration_id
  `;
  return rows.map((row) => [row.migration_id, row.name] as const);
});

const record = (id: number, name: string) =>
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    yield* sql`INSERT INTO effect_sql_migrations (migration_id, name, created_at)
      VALUES (${id}, ${name}, '2026-01-01')`;
  });

const assertForkSchema = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  // Consumers of upstream columns the fork ids used to shadow, and of fork columns.
  yield* sql`SELECT client_surface, client_app_version FROM auth_sessions`;
  yield* sql`SELECT pin_order_key, unsettled_at, title_state_json, auto_settle_disabled_at
    FROM projection_threads`;
  yield* sql`SELECT default_thread_env_mode, environment_json, is_auto, "group"
    FROM projection_projects`;
  yield* sql`SELECT attempt_id, payload, result FROM pipeline_workspaces`;
  const v2 = yield* sql`
    SELECT name FROM sqlite_master WHERE type = 'table' AND name LIKE 'orchestration_v2_%'
  `;
  assert.isAbove(v2.length, 0);
});

it.effect.each([37, 41])("repairs fork migrations recorded from %s", (firstForkId) =>
  Effect.gen(function* () {
    yield* runMigrations({ toMigrationInclusive: firstForkId - 1 });
    const fork = [
      ["ProjectEnvironment", ProjectEnvironment],
      ["ProjectIsAuto", ProjectIsAuto],
      ["ProjectGroup", ProjectGroup],
    ] as const;
    for (const [offset, [name, migration]] of fork.entries()) {
      yield* migration;
      yield* record(firstForkId + offset, name);
    }
    if (firstForkId === 41) {
      yield* record(44, "ReconcileRenumberedForkMigrations");
    }
    yield* runMigrations();
    yield* assertForkSchema;
    const indexes = yield* (yield* SqlClient.SqlClient)<{
      name: string;
    }>`PRAGMA index_list(projection_turns)`;
    assert(indexes.some((index) => index.name === "idx_projection_turns_thread_keyset"));
    assert.deepStrictEqual(yield* history, migrationManifest);
    assert.deepStrictEqual(yield* runMigrations(), []);
  }).pipe(Effect.provide(NodeSqliteClient.layer({ filename: ":memory:" }))),
);

it.effect("upgrades a deployed fork database recorded through fork 57", () =>
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    yield* runMigrations({ toMigrationInclusive: 51 });
    yield* ProjectEnvironment;
    yield* ProjectIsAuto;
    yield* ProjectGroup;
    yield* ProjectionThreadTitleState;
    yield* PipelineWorkspaces;
    for (const [id, name] of [
      [52, "ProjectEnvironment"],
      [53, "ProjectIsAuto"],
      [54, "ProjectGroup"],
      [55, "ReconcileRenumberedForkMigrations"],
      [56, "ForkTitleStateCompatibility"],
      [57, "PipelineWorkspaces"],
    ] as const) {
      yield* record(id, name);
    }
    yield* sql`INSERT INTO pipeline_workspaces (attempt_id, payload, result)
      VALUES ('fixture-attempt', '{"repo":"fixture"}', '{"state":"ready"}')`;
    yield* sql`INSERT INTO projection_projects (
        project_id, title, workspace_root, scripts_json, created_at, updated_at,
        environment_json, is_auto, "group"
      ) VALUES (
        'project-1', 'Fixture', '/tmp/fixture', '[]', '2026-01-01', '2026-01-01',
        '[{"name":"GH_TOKEN","value":"x"}]', 1, 'pipeline/auto'
      )`;

    yield* runMigrations();
    yield* assertForkSchema;
    assert.deepStrictEqual(yield* history, migrationManifest);
    assert.deepStrictEqual(yield* runMigrations(), []);
    assert.deepStrictEqual(yield* sql`SELECT attempt_id, result FROM pipeline_workspaces`, [
      { attempt_id: "fixture-attempt", result: '{"state":"ready"}' },
    ]);
    assert.deepStrictEqual(
      yield* sql`SELECT environment_json, is_auto, "group" FROM projection_projects`,
      [
        {
          environment_json: '[{"name":"GH_TOKEN","value":"x"}]',
          is_auto: 1,
          group: "pipeline/auto",
        },
      ],
    );
  }).pipe(Effect.provide(NodeSqliteClient.layer({ filename: ":memory:" }))),
);

it.effect("upgrades a fork database recorded through fork 54 without title state", () =>
  Effect.gen(function* () {
    yield* runMigrations({ toMigrationInclusive: 51 });
    yield* ProjectEnvironment;
    yield* ProjectIsAuto;
    yield* ProjectGroup;
    yield* record(52, "ProjectEnvironment");
    yield* record(53, "ProjectIsAuto");
    yield* record(54, "ProjectGroup");

    yield* runMigrations();
    yield* assertForkSchema;
    assert.deepStrictEqual(yield* history, migrationManifest);
  }).pipe(Effect.provide(NodeSqliteClient.layer({ filename: ":memory:" }))),
);
