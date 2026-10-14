import * as Effect from "effect/Effect";
import * as Migrator from "effect/sql/Migrator";
import * as SqlClient from "effect/sql/SqlClient";

/**
 * fork: the cc-runner fork ships its own schema migrations (project
 * environment/isAuto/group columns, pipeline workspaces). Each upstream sync
 * appends them after upstream's latest id, but databases written by an earlier
 * fork build recorded them under ids upstream later used for its own
 * migrations. The migrator keys on `migration_id` and skips every id up to the
 * highest recorded one, so without this repair those upstream migrations would
 * never run (and V2's guard would refuse to start).
 *
 * History of fork ids (every fork migration is idempotent):
 * - 37-39, 41-44: first fork releases (collided with upstream 37-44).
 * - 52-57: fork releases up to the 2026-10 sync (collided with upstream 52-57).
 * - now: appended after upstream's latest id (see `Migrations.ts`).
 *
 * Repair, run once before the migrator in one transaction:
 * 1. A fork-named row below `FIRST_RELOCATED_FORK_ID` marks an upstream
 *    migration that never ran under that id. Run it (all of them guard their own
 *    DDL) and record it under upstream's name.
 * 2. A fork-named row at or above `FIRST_RELOCATED_FORK_ID` that is not in the
 *    current manifest is dropped, so the migrator runs upstream's migrations at
 *    those ids and then the fork migrations at their current ids (no-ops on
 *    columns that already exist).
 * 3. Upstream 52 (`title_state_json`) is not idempotent, and fork builds applied
 *    it under a fork id (ForkTitleStateCompatibility). Record it as applied when
 *    the column already exists.
 */
const FORK_MIGRATION_NAMES = new Set([
  "ProjectEnvironment",
  "ProjectIsAuto",
  "ProjectGroup",
  "ReconcileRenumberedForkMigrations",
  "ForkTitleStateCompatibility",
  "PipelineWorkspaces",
]);

/** The first id fork builds ever recorded after upstream's 51. */
const FIRST_RELOCATED_FORK_ID = 52;

const TITLE_STATE_MIGRATION = [52, "ProjectionThreadTitleState"] as const;

export const reconcileForkMigrations = Effect.fn("reconcileForkMigrations")(function* <E>(input: {
  readonly entries: ReadonlyArray<
    readonly [number, string, Effect.Effect<unknown, E, SqlClient.SqlClient>]
  >;
  readonly throughId?: number | undefined;
}) {
  const sql = yield* SqlClient.SqlClient;
  const tables = yield* sql`
    SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'effect_sql_migrations'
  `;
  if (tables.length === 0) return;
  const recorded = yield* sql<{ readonly migration_id: number; readonly name: string }>`
    SELECT migration_id, name FROM effect_sql_migrations
  `;
  const manifest = new Map(input.entries.map(([id, name]) => [id, name] as const));
  const stale = recorded.filter(
    (row) => FORK_MIGRATION_NAMES.has(row.name) && manifest.get(row.migration_id) !== row.name,
  );
  if (stale.length === 0) return;

  const within = (id: number) => input.throughId === undefined || id <= input.throughId;

  yield* sql.withTransaction(
    Effect.gen(function* () {
      for (const row of stale) {
        if (row.migration_id < FIRST_RELOCATED_FORK_ID) {
          const upstream = input.entries.find(([id]) => id === row.migration_id);
          if (upstream === undefined || !within(row.migration_id)) continue;
          const [id, name, migration] = upstream;
          // Report failures the way the migrator does, so a migration's own
          // error types (e.g. SchemaError) do not leak into the database layer.
          yield* migration.pipe(
            Effect.mapError(
              (cause) =>
                new Migrator.MigrationError({
                  kind: "Failed",
                  message: `Fork migration repair: migration ${id}_${name} failed`,
                  cause,
                }),
            ),
          );
          yield* sql`
            UPDATE effect_sql_migrations SET name = ${name}
            WHERE migration_id = ${id} AND name = ${row.name}
          `;
        } else if (within(FIRST_RELOCATED_FORK_ID)) {
          yield* sql`
            DELETE FROM effect_sql_migrations
            WHERE migration_id = ${row.migration_id} AND name = ${row.name}
          `;
        }
      }

      const [titleStateId, titleStateName] = TITLE_STATE_MIGRATION;
      if (!within(titleStateId)) return;
      const titleStateRecorded = yield* sql`
        SELECT 1 FROM effect_sql_migrations WHERE migration_id = ${titleStateId}
      `;
      if (titleStateRecorded.length > 0) return;
      const columns = yield* sql<{ readonly name: string }>`PRAGMA table_info(projection_threads)`;
      if (columns.some((column) => column.name === "title_state_json")) {
        yield* sql`
          INSERT INTO effect_sql_migrations (migration_id, name)
          VALUES (${titleStateId}, ${titleStateName})
        `;
      }
    }),
  );
});
