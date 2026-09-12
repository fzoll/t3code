import * as NodePath from "@effect/platform-node/NodePath";
import { afterEach, describe, expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as ChildProcessSpawner from "effect/unstable/process/ChildProcessSpawner";
import { HostProcessEnvironment, HostProcessPlatform } from "@t3tools/shared/hostProcess";
import { vi } from "vite-plus/test";

import * as ProcessRunner from "../processRunner.ts";
import { probeBrowserCapability } from "./BrowserCapabilityProbe.ts";

const runMock = vi.fn<ProcessRunner.ProcessRunner["Service"]["run"]>();

const ProcessRunnerTest = Layer.succeed(
  ProcessRunner.ProcessRunner,
  ProcessRunner.ProcessRunner.of({
    run: (input) => runMock(input),
  }),
);
const PathLayer = NodePath.layer;

const linuxHome = "/home/pi";
const linuxCacheRoot = `${linuxHome}/.cache/ms-playwright`;
const linuxHeadlessShellPath = `${linuxCacheRoot}/chromium_headless_shell-1148/chrome-linux/headless_shell`;
const systemChromiumPath = "/usr/bin/chromium";

const withEnv = <ROut, E, RIn>(
  layer: Layer.Layer<ROut, E, RIn>,
  platform: NodeJS.Platform,
  env: NodeJS.ProcessEnv,
) =>
  Layer.mergeAll(
    layer,
    Layer.succeed(HostProcessPlatform, platform),
    Layer.succeed(HostProcessEnvironment, env),
  );

const successResult = (stdout: string) => ({
  stdout,
  stderr: "",
  code: ChildProcessSpawner.ExitCode(0),
  timedOut: false,
  stdoutTruncated: false,
  stderrTruncated: false,
});

afterEach(() => {
  runMock.mockReset();
});

describe("probeBrowserCapability", () => {
  it.effect("reports absent when no Chromium binary can be found anywhere", () =>
    Effect.gen(function* () {
      const result = yield* probeBrowserCapability().pipe(
        Effect.provide(
          withEnv(Layer.mergeAll(ProcessRunnerTest, PathLayer, FileSystem.layerNoop({})), "linux", {
            HOME: linuxHome,
          }),
        ),
      );

      expect(result).toEqual({ state: "absent" });
      expect(runMock).not.toHaveBeenCalled();
    }),
  );

  it.effect("reports ok when the Playwright-managed Chromium binary launches", () =>
    Effect.gen(function* () {
      runMock.mockReturnValueOnce(Effect.succeed(successResult("HeadlessChrome/120.0.6099.0\n")));

      const fileSystemLayer = FileSystem.layerNoop({
        exists: (path) =>
          Effect.succeed(path === linuxCacheRoot || path === linuxHeadlessShellPath),
        readDirectory: (path) =>
          path === linuxCacheRoot
            ? Effect.succeed(["chromium_headless_shell-1148"])
            : Effect.succeed([]),
      });

      const result = yield* probeBrowserCapability().pipe(
        Effect.provide(
          withEnv(Layer.mergeAll(ProcessRunnerTest, PathLayer, fileSystemLayer), "linux", {
            HOME: linuxHome,
          }),
        ),
      );

      expect(result).toEqual({
        state: "ok",
        binaryPath: linuxHeadlessShellPath,
        version: "HeadlessChrome/120.0.6099.0",
      });
      expect(runMock).toHaveBeenCalledWith(
        expect.objectContaining({ command: linuxHeadlessShellPath, args: ["--version"] }),
      );
    }),
  );

  it.effect(
    "reports degraded when only a system Chromium binary exists and the Playwright cache is missing",
    () =>
      Effect.gen(function* () {
        runMock.mockReturnValueOnce(Effect.succeed(successResult("Chromium 120.0.6099.0\n")));

        const fileSystemLayer = FileSystem.layerNoop({
          exists: (path) => Effect.succeed(path === systemChromiumPath),
          readDirectory: () => Effect.succeed([]),
        });

        const result = yield* probeBrowserCapability().pipe(
          Effect.provide(
            withEnv(Layer.mergeAll(ProcessRunnerTest, PathLayer, fileSystemLayer), "linux", {
              HOME: linuxHome,
            }),
          ),
        );

        expect(result.state).toBe("degraded");
        expect(result.binaryPath).toBe(systemChromiumPath);
        expect(result.details).toContain("Playwright browser cache is missing");
      }),
  );

  it.effect("reports degraded when a located binary fails to launch", () =>
    Effect.gen(function* () {
      runMock.mockReturnValueOnce(
        Effect.fail(
          new ProcessRunner.ProcessSpawnError({
            command: linuxHeadlessShellPath,
            argumentCount: 1,
            cause: new Error("spawn EACCES"),
          }),
        ),
      );

      const fileSystemLayer = FileSystem.layerNoop({
        exists: (path) =>
          Effect.succeed(path === linuxCacheRoot || path === linuxHeadlessShellPath),
        readDirectory: (path) =>
          path === linuxCacheRoot
            ? Effect.succeed(["chromium_headless_shell-1148"])
            : Effect.succeed([]),
      });

      const result = yield* probeBrowserCapability().pipe(
        Effect.provide(
          withEnv(Layer.mergeAll(ProcessRunnerTest, PathLayer, fileSystemLayer), "linux", {
            HOME: linuxHome,
          }),
        ),
      );

      expect(result.state).toBe("degraded");
      expect(result.binaryPath).toBe(linuxHeadlessShellPath);
      expect(result.details).toContain("failed to launch");
    }),
  );

  it.effect("prefers the Playwright cache binary over a system Chromium install", () =>
    Effect.gen(function* () {
      runMock.mockReturnValueOnce(Effect.succeed(successResult("HeadlessChrome/120.0.6099.0\n")));

      const fileSystemLayer = FileSystem.layerNoop({
        exists: (path) =>
          Effect.succeed(
            path === linuxCacheRoot ||
              path === linuxHeadlessShellPath ||
              path === systemChromiumPath,
          ),
        readDirectory: (path) =>
          path === linuxCacheRoot
            ? Effect.succeed(["chromium_headless_shell-1148"])
            : Effect.succeed([]),
      });

      const result = yield* probeBrowserCapability().pipe(
        Effect.provide(
          withEnv(Layer.mergeAll(ProcessRunnerTest, PathLayer, fileSystemLayer), "linux", {
            HOME: linuxHome,
          }),
        ),
      );

      expect(result.state).toBe("ok");
      expect(result.binaryPath).toBe(linuxHeadlessShellPath);
    }),
  );
});
