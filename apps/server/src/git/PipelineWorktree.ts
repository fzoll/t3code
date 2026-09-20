import * as Schema from "effect/Schema";
import * as Effect from "effect/Effect";
import * as Semaphore from "effect/Semaphore";
import * as SqlClient from "effect/unstable/sql/SqlClient";
import {
  GitCommandError,
  type VcsCreateWorktreeInput,
  VcsCreateWorktreeResult,
} from "@t3tools/contracts";
import { GitWorkflowService } from "./GitWorkflowService.ts";

// Shared across RPC connections. A connection loss must not race a second Git
// mutation against the original request. SQLite retains identity across boots.
const preparationLock = Semaphore.makeUnsafe(1);
export const preparePipelineWorktree = Effect.fn("preparePipelineWorktree")(function* (
  input: VcsCreateWorktreeInput,
) {
  const git = yield* GitWorkflowService;
  const sql = yield* SqlClient.SqlClient;
  const fail = (detail: string) =>
    new GitCommandError({
      operation: "pipeline.prepare",
      command: "git worktree",
      cwd: input.cwd,
      detail,
    });
  const attemptId = input.pipelineAttemptId;
  if (
    !attemptId ||
    !/^[a-zA-Z0-9-]{16,80}$/.test(attemptId) ||
    !/^[0-9a-f]{40}$/.test(input.refName) ||
    input.newRefName !== `agent/v2-attempt-${attemptId}` ||
    input.path !== null
  ) {
    return yield* fail("invalid_pipeline_workspace_identity");
  }
  const payload = `${input.cwd.length}:${input.cwd}:${input.refName}:${input.newRefName}`;
  const codec = Schema.fromJsonString(VcsCreateWorktreeResult);
  const work = Effect.gen(function* () {
    const prior = yield* sql<{
      payload: string;
      result: string | null;
    }>`SELECT payload,result FROM pipeline_workspaces WHERE attempt_id=${attemptId}`;
    if (prior[0] && prior[0].payload !== payload) return yield* fail("attempt_payload_conflict");
    if (prior[0]?.result) return yield* Schema.decodeUnknownEffect(codec)(prior[0].result);
    if (!prior[0])
      yield* sql`INSERT INTO pipeline_workspaces(attempt_id,payload) VALUES(${attemptId},${payload})`;
    // Recover a worktree created before a crash or lost response. Never reset it:
    // a started agent may already have legitimate edits here.
    const refs = yield* git.listRefs({
      cwd: input.cwd,
      query: input.newRefName,
      refKind: "local",
      limit: 100,
    });
    const existing = refs.refs.find((ref) => ref.name === input.newRefName);
    let result: VcsCreateWorktreeResult;
    if (existing?.worktreePath) {
      result = {
        worktree: { path: existing.worktreePath, refName: existing.name },
        pipelineAttemptId: attemptId,
      };
    } else {
      // Fetch exactly the observed commit. Missing commits fail; no fallback to
      // main or to the shared checkout is allowed for an unattended attempt.
      yield* git.fetchRemote({ cwd: input.cwd, remoteName: "origin", refName: input.refName });
      const created = yield* git.createWorktree({ ...input, pipelineAttemptId: undefined });
      result = { ...created, pipelineAttemptId: attemptId };
    }
    const encoded = yield* Schema.encodeEffect(codec)(result);
    yield* sql`UPDATE pipeline_workspaces SET result=${encoded} WHERE attempt_id=${attemptId}`;
    return result;
  });
  return yield* preparationLock
    .withPermits(1)(work)
    .pipe(
      Effect.mapError((cause) =>
        Schema.is(GitCommandError)(cause) ? cause : fail("workspace_receipt_unavailable"),
      ),
    );
});
