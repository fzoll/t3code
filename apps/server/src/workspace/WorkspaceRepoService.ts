import * as Context from "effect/Context";
import * as Data from "effect/Data";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";
import * as Layer from "effect/Layer";
import { ChildProcess, ChildProcessSpawner } from "effect/unstable/process";

import { ServerConfig } from "../config.ts";

export class WorkspaceRepoError extends Data.TaggedError("WorkspaceRepoError")<{
  readonly detail: string;
}> {}

export interface WorkspaceRepoServiceShape {
  readonly ensureRepo: (input: {
    readonly repo: string;
    readonly branch: string;
    readonly token: string;
  }) => Effect.Effect<{ readonly path: string; readonly ready: boolean }, WorkspaceRepoError>;

  readonly cleanup: (input: {
    readonly repo: string;
  }) => Effect.Effect<{ readonly removed: boolean }, WorkspaceRepoError>;
}

export class WorkspaceRepoService extends Context.Service<
  WorkspaceRepoService,
  WorkspaceRepoServiceShape
>()("t3/workspace/WorkspaceRepoService") {}

const repoNameFromUrl = (repo: string): string => {
  const parts = repo.replace(/\.git$/, "").split("/");
  return parts[parts.length - 1] ?? repo;
};

export const layer = Layer.effect(
  WorkspaceRepoService,
  Effect.gen(function* () {
    const config = yield* ServerConfig;
    const fs = yield* FileSystem.FileSystem;
    const pathService = yield* Path.Path;
    const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;

    const workspaceRoot = pathService.join(config.baseDir, "workspaces");
    yield* fs.makeDirectory(workspaceRoot, { recursive: true });

    const runGit = (args: ReadonlyArray<string>, cwd: string, env?: Record<string, string>) =>
      Effect.gen(function* () {
        const child = yield* spawner.spawn(
          ChildProcess.make("git", args, {
            cwd,
            env: { ...process.env, ...env },
          }),
        );
        const exitCode = yield* child.exitCode;
        if (exitCode !== 0) {
          return yield* new WorkspaceRepoError({
            detail: `git ${args[0]} failed with exit code ${exitCode}`,
          });
        }
      }).pipe(
        Effect.scoped,
        Effect.mapError((cause) => new WorkspaceRepoError({ detail: String(cause) })),
      );

    return WorkspaceRepoService.of({
      ensureRepo: ({ repo, branch, token }) =>
        Effect.gen(function* () {
          const repoName = repoNameFromUrl(repo);
          const repoPath = pathService.join(workspaceRoot, repoName);
          const exists = yield* fs.exists(repoPath);

          const authUrl = repo.startsWith("https://")
            ? repo.replace("https://", `https://x-access-token:${token}@`)
            : `https://x-access-token:${token}@github.com/${repo}.git`;

          if (!exists) {
            yield* runGit(
              ["clone", "--depth=1", "--branch", branch, authUrl, repoPath],
              workspaceRoot,
            );
          } else {
            yield* runGit(["fetch", "origin"], repoPath);
            yield* runGit(["checkout", branch], repoPath);
            yield* runGit(["pull", "--ff-only"], repoPath).pipe(Effect.ignore);
          }

          return { path: repoPath, ready: true };
        }).pipe(
          Effect.mapError((cause) =>
            cause instanceof WorkspaceRepoError
              ? cause
              : new WorkspaceRepoError({ detail: String(cause) }),
          ),
        ),

      cleanup: ({ repo }) =>
        Effect.gen(function* () {
          const repoName = repoNameFromUrl(repo);
          const repoPath = pathService.join(workspaceRoot, repoName);
          const exists = yield* fs.exists(repoPath);
          if (exists) {
            yield* fs.remove(repoPath, { recursive: true });
            return { removed: true };
          }
          return { removed: false };
        }).pipe(Effect.mapError((cause) => new WorkspaceRepoError({ detail: String(cause) }))),
    });
  }),
);

export const layerNoop = Layer.succeed(
  WorkspaceRepoService,
  WorkspaceRepoService.of({
    ensureRepo: () => Effect.succeed({ path: "/noop", ready: false }),
    cleanup: () => Effect.succeed({ removed: false }),
  }),
);
