import { assert, it } from "@effect/vitest";
import { EventId, ProjectId, ProviderInstanceId } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as SqlClient from "effect/sql/SqlClient";

import * as SqlitePersistence from "../persistence/Sqlite.ts";
import * as ProjectStore from "./ProjectStore.ts";

it.layer(ProjectStore.layer.pipe(Layer.provideMerge(SqlitePersistence.layerMemory)))(
  "ProjectStoreV2",
  (it) => {
    it.effect("stores a model selection without options as JSON without an options key", () =>
      Effect.gen(function* () {
        const projects = yield* ProjectStore.ProjectStoreV2;
        const sql = yield* SqlClient.SqlClient;
        const projectId = ProjectId.make("project-null-options");
        const modelSelection = { instanceId: ProviderInstanceId.make("codex"), model: "gpt-5.4" };
        yield* projects.apply({
          sequence: 1,
          eventId: EventId.make("event-null-options"),
          aggregateKind: "project",
          aggregateId: projectId,
          occurredAt: "2026-03-24T00:00:00.000Z",
          commandId: null,
          causationEventId: null,
          correlationId: null,
          metadata: {},
          type: "project.created",
          payload: {
            projectId,
            title: "Null options project",
            workspaceRoot: "/tmp/project-null-options",
            defaultModelSelection: modelSelection,
            scripts: [],
            environment: [],
            isAuto: false,
            group: null,
            createdAt: "2026-03-24T00:00:00.000Z",
            updatedAt: "2026-03-24T00:00:00.000Z",
          },
        });

        const rows = yield* sql<{ readonly defaultModelSelection: string | null }>`
          SELECT default_model_selection_json AS "defaultModelSelection"
          FROM projection_projects
          WHERE project_id = ${projectId}
        `;
        assert.strictEqual(rows[0]?.defaultModelSelection, JSON.stringify(modelSelection));
        assert.deepStrictEqual(
          Option.getOrNull(yield* projects.get(projectId))?.defaultModelSelection,
          modelSelection,
        );
      }),
    );
    it.effect("fork: persists project environment, isAuto and group", () =>
      Effect.gen(function* () {
        const projects = yield* ProjectStore.ProjectStoreV2;
        const projectId = ProjectId.make("project-fork-fields");
        const base = {
          aggregateKind: "project" as const,
          aggregateId: projectId,
          occurredAt: "2026-03-24T00:00:00.000Z",
          commandId: null,
          causationEventId: null,
          correlationId: null,
          metadata: {},
        };
        yield* projects.apply({
          ...base,
          sequence: 1,
          eventId: EventId.make("event-fork-created"),
          type: "project.created",
          payload: {
            projectId,
            title: "Fork project",
            workspaceRoot: "/tmp/project-fork-fields",
            defaultModelSelection: null,
            scripts: [],
            environment: [{ name: "GH_TOKEN", value: "token-a", sensitive: true }],
            isAuto: true,
            group: "pipeline/fzoll",
            createdAt: "2026-03-24T00:00:00.000Z",
            updatedAt: "2026-03-24T00:00:00.000Z",
          },
        });
        const created = Option.getOrThrow(yield* projects.get(projectId));
        assert.deepStrictEqual(created.environment, [
          { name: "GH_TOKEN", value: "token-a", sensitive: true },
        ]);
        assert.isTrue(created.isAuto);
        assert.strictEqual(created.group, "pipeline/fzoll");

        yield* projects.apply({
          ...base,
          sequence: 2,
          eventId: EventId.make("event-fork-updated"),
          type: "project.meta-updated",
          payload: {
            projectId,
            environment: [{ name: "GH_TOKEN", value: "token-b", sensitive: true }],
            group: null,
            updatedAt: "2026-03-25T00:00:00.000Z",
          },
        });
        const updated = Option.getOrThrow(yield* projects.get(projectId));
        assert.deepStrictEqual(updated.environment, [
          { name: "GH_TOKEN", value: "token-b", sensitive: true },
        ]);
        assert.isTrue(updated.isAuto);
        assert.strictEqual(updated.group, null);
        const shell = Option.getOrThrow(yield* projects.getShell(projectId));
        assert.deepStrictEqual(shell.environment, updated.environment);
        assert.isTrue(shell.isAuto);
      }),
    );
  },
);
