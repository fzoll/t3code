import { afterEach, describe, expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as ChildProcessSpawner from "effect/unstable/process/ChildProcessSpawner";
import { vi } from "vite-plus/test";

import * as ProcessRunner from "../processRunner.ts";
import * as ServerBuildSha from "./ServerBuildSha.ts";

const runMock = vi.fn<ProcessRunner.ProcessRunner["Service"]["run"]>();

const ProcessRunnerTest = Layer.succeed(
  ProcessRunner.ProcessRunner,
  ProcessRunner.ProcessRunner.of({
    run: (input) => runMock(input),
  }),
);

afterEach(() => {
  runMock.mockReset();
});

const okResult = (stdout: string) => ({
  stdout,
  stderr: "",
  code: ChildProcessSpawner.ExitCode(0),
  timedOut: false,
  stdoutTruncated: false,
  stderrTruncated: false,
});

describe("resolveServerBuildSha", () => {
  it.effect("returns the normalized git SHA when git rev-parse succeeds", () =>
    Effect.gen(function* () {
      runMock.mockReturnValueOnce(
        Effect.succeed(okResult("ABCDEF0123456789ABCDEF0123456789ABCDEF01\n")),
      );

      const result = yield* ServerBuildSha.resolveServerBuildSha().pipe(
        Effect.provide(ProcessRunnerTest),
      );

      expect(result).toBe("abcdef0123456789abcdef0123456789abcdef01");
      expect(runMock).toHaveBeenCalledWith(
        expect.objectContaining({ command: "git", args: ["rev-parse", "HEAD"] }),
      );
    }),
  );

  it.effect("returns null when the process exits non-zero (e.g. not a git checkout)", () =>
    Effect.gen(function* () {
      runMock.mockReturnValueOnce(
        Effect.succeed({
          ...okResult("fatal: not a git repository\n"),
          code: ChildProcessSpawner.ExitCode(128),
        }),
      );

      const result = yield* ServerBuildSha.resolveServerBuildSha().pipe(
        Effect.provide(ProcessRunnerTest),
      );

      expect(result).toBeNull();
    }),
  );

  it.effect("returns null when the process times out", () =>
    Effect.gen(function* () {
      runMock.mockReturnValueOnce(Effect.succeed({ ...okResult(""), timedOut: true }));

      const result = yield* ServerBuildSha.resolveServerBuildSha().pipe(
        Effect.provide(ProcessRunnerTest),
      );

      expect(result).toBeNull();
    }),
  );

  it.effect("returns null when the output isn't a valid SHA", () =>
    Effect.gen(function* () {
      runMock.mockReturnValueOnce(Effect.succeed(okResult("not-a-sha\n")));

      const result = yield* ServerBuildSha.resolveServerBuildSha().pipe(
        Effect.provide(ProcessRunnerTest),
      );

      expect(result).toBeNull();
    }),
  );

  it.effect("returns null when git isn't available", () =>
    Effect.gen(function* () {
      runMock.mockReturnValueOnce(
        Effect.fail(
          new ProcessRunner.ProcessSpawnError({
            command: "git",
            argumentCount: 2,
            cause: new Error("spawn git ENOENT"),
          }),
        ),
      );

      const result = yield* ServerBuildSha.resolveServerBuildSha().pipe(
        Effect.provide(ProcessRunnerTest),
      );

      expect(result).toBeNull();
    }),
  );
});
