import { assert, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as SqlClient from "effect/unstable/sql/SqlClient";
import { GitWorkflowService } from "./GitWorkflowService.ts";
import { preparePipelineWorktree } from "./PipelineWorktree.ts";
import { SqlitePersistenceMemory } from "../persistence/Layers/Sqlite.ts";

const suite = it.layer(SqlitePersistenceMemory);
suite("durable pipeline workspace", (it) => {
  it.effect("replays a saved receipt without another fetch or worktree creation", () =>
    Effect.gen(function* () {
      let creates = 0,
        fetches = 0;
      const id = "aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee";
      const input = {
        cwd: "/repo",
        refName: "a".repeat(40),
        newRefName: "agent/v2-attempt-" + id,
        path: null,
        pipelineAttemptId: id,
      };
      const mock = Layer.mock(GitWorkflowService)({
        listRefs: () =>
          Effect.succeed({
            refs: [],
            isRepo: true,
            hasPrimaryRemote: true,
            nextCursor: null,
            totalCount: 0,
          }),
        fetchRemote: () =>
          Effect.sync(() => {
            fetches++;
          }),
        createWorktree: () =>
          Effect.sync(() => {
            creates++;
            return { worktree: { path: "/worktree/" + id, refName: input.newRefName } };
          }),
      });
      const first = yield* preparePipelineWorktree(input).pipe(Effect.provide(mock));
      const second = yield* preparePipelineWorktree(input).pipe(Effect.provide(mock));
      assert.deepStrictEqual(first, second);
      assert.equal(creates, 1);
      assert.equal(fetches, 1);
      const conflict = yield* preparePipelineWorktree({ ...input, refName: "b".repeat(40) }).pipe(
        Effect.provide(mock),
        Effect.flip,
      );
      assert.match(conflict.detail, /conflict/);
    }),
  );
  it.effect("recovers the existing worktree after a crash before receipt commit", () =>
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      const id = "bbbbbbbb-bbbb-cccc-dddd-eeeeeeeeeeee";
      const input = {
        cwd: "/repo",
        refName: "a".repeat(40),
        newRefName: "agent/v2-attempt-" + id,
        path: null,
        pipelineAttemptId: id,
      };
      const payload = `${input.cwd.length}:${input.cwd}:${input.refName}:${input.newRefName}`;
      yield* sql`INSERT INTO pipeline_workspaces(attempt_id,payload) VALUES(${id},${payload})`;
      const mock = Layer.mock(GitWorkflowService)({
        listRefs: () =>
          Effect.succeed({
            refs: [
              {
                name: input.newRefName,
                current: false,
                isDefault: false,
                worktreePath: "/recovered",
              },
            ],
            isRepo: true,
            hasPrimaryRemote: true,
            nextCursor: null,
            totalCount: 1,
          }),
      });
      const result = yield* preparePipelineWorktree(input).pipe(Effect.provide(mock));
      assert.equal(result.worktree.path, "/recovered");
      assert.equal(result.pipelineAttemptId, id);
    }),
  );
  it.effect("refuses mutable branch names and shared checkout fallback", () =>
    Effect.gen(function* () {
      const result = yield* preparePipelineWorktree({
        cwd: "/repo",
        refName: "main",
        newRefName: "main",
        path: null,
        pipelineAttemptId: "cccccccc-bbbb-cccc-dddd-eeeeeeeeeeee",
      }).pipe(Effect.provide(Layer.mock(GitWorkflowService)({})), Effect.flip);
      assert.match(result.detail, /invalid_pipeline_workspace_identity/);
    }),
  );
});
