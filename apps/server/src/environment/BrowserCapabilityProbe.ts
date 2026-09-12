import type { BrowserCapability } from "@t3tools/contracts";
import { HostProcessEnvironment, HostProcessPlatform } from "@t3tools/shared/hostProcess";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Path from "effect/Path";

import * as ProcessRunner from "../processRunner.ts";

/**
 * cc_runner polls the public environment descriptor to demote nodes whose
 * declared config has drifted from reality, so this measures whether the
 * node can actually launch a Chromium binary rather than trusting config.
 */
const BROWSER_CAPABILITY_CACHE_TTL = "6 hours";
const VERSION_PROBE_TIMEOUT = "5 seconds";

const PLAYWRIGHT_CHROMIUM_BINARY_CANDIDATES: Record<string, readonly string[]> = {
  darwin: ["chrome-mac/headless_shell", "chrome-mac/Chromium.app/Contents/MacOS/Chromium"],
  linux: ["chrome-linux/headless_shell", "chrome-linux/chrome"],
  win32: ["chrome-win/headless_shell.exe", "chrome-win/chrome.exe"],
};

const SYSTEM_CHROMIUM_BINARY_CANDIDATES: Record<string, readonly string[]> = {
  darwin: [
    "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
    "/Applications/Chromium.app/Contents/MacOS/Chromium",
  ],
  linux: [
    "/usr/bin/chromium",
    "/usr/bin/chromium-browser",
    "/usr/bin/google-chrome",
    "/usr/bin/google-chrome-stable",
  ],
  win32: [
    "C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe",
    "C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe",
  ],
};

function resolvePlaywrightCacheRoot(
  platform: NodeJS.Platform,
  env: NodeJS.ProcessEnv,
  path: Path.Path,
): string {
  const overridePath = env.PLAYWRIGHT_BROWSERS_PATH;
  if (overridePath && overridePath !== "0") {
    return overridePath;
  }

  const home = env.HOME ?? env.USERPROFILE ?? "";
  switch (platform) {
    case "darwin":
      return path.join(home, "Library", "Caches", "ms-playwright");
    case "win32":
      return path.join(env.LOCALAPPDATA ?? home, "ms-playwright");
    default:
      return path.join(env.XDG_CACHE_HOME ?? path.join(home, ".cache"), "ms-playwright");
  }
}

const findPlaywrightChromiumBinary = Effect.fn(
  "BrowserCapabilityProbe.findPlaywrightChromiumBinary",
)(function* (cacheRoot: string, binaryCandidates: readonly string[]) {
  const fileSystem = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;

  const cacheRootExists = yield* fileSystem
    .exists(cacheRoot)
    .pipe(Effect.orElseSucceed(() => false));
  if (!cacheRootExists) {
    return null;
  }

  const entries = yield* fileSystem
    .readDirectory(cacheRoot)
    .pipe(Effect.orElseSucceed((): readonly string[] => []));
  const chromiumDirectories = entries
    .filter((entry) => entry.startsWith("chromium"))
    .sort()
    .toReversed();

  for (const directory of chromiumDirectories) {
    for (const relativeBinaryPath of binaryCandidates) {
      const candidate = path.join(cacheRoot, directory, relativeBinaryPath);
      const candidateExists = yield* fileSystem
        .exists(candidate)
        .pipe(Effect.orElseSucceed(() => false));
      if (candidateExists) {
        return candidate;
      }
    }
  }

  return null;
});

const findSystemChromiumBinary = Effect.fn("BrowserCapabilityProbe.findSystemChromiumBinary")(
  function* (candidates: readonly string[]) {
    const fileSystem = yield* FileSystem.FileSystem;
    for (const candidate of candidates) {
      const candidateExists = yield* fileSystem
        .exists(candidate)
        .pipe(Effect.orElseSucceed(() => false));
      if (candidateExists) {
        return candidate;
      }
    }
    return null;
  },
);

function normalizeVersion(stdout: string): string | undefined {
  const trimmed = stdout.trim();
  return trimmed.length > 0 ? trimmed : undefined;
}

export const probeBrowserCapability = Effect.fn("BrowserCapabilityProbe.probe")(
  function* (): Effect.fn.Return<
    BrowserCapability,
    never,
    FileSystem.FileSystem | Path.Path | ProcessRunner.ProcessRunner
  > {
    const platform = yield* HostProcessPlatform;
    const env = yield* HostProcessEnvironment;
    const path = yield* Path.Path;
    const processRunner = yield* ProcessRunner.ProcessRunner;

    const playwrightBinaryCandidates =
      PLAYWRIGHT_CHROMIUM_BINARY_CANDIDATES[platform] ??
      PLAYWRIGHT_CHROMIUM_BINARY_CANDIDATES.linux ??
      [];
    const systemBinaryCandidates = SYSTEM_CHROMIUM_BINARY_CANDIDATES[platform] ?? [];

    const cacheRoot = resolvePlaywrightCacheRoot(platform, env, path);
    const playwrightBinaryPath = yield* findPlaywrightChromiumBinary(
      cacheRoot,
      playwrightBinaryCandidates,
    );
    const systemBinaryPath = playwrightBinaryPath
      ? null
      : yield* findSystemChromiumBinary(systemBinaryCandidates);
    const binaryPath = playwrightBinaryPath ?? systemBinaryPath;

    if (!binaryPath) {
      return { state: "absent" };
    }

    const launchResult = yield* processRunner
      .run({
        command: binaryPath,
        args: ["--version"],
        timeout: VERSION_PROBE_TIMEOUT,
        timeoutBehavior: "timedOutResult",
      })
      .pipe(Effect.result);

    if (
      launchResult._tag === "Failure" ||
      launchResult.success.timedOut ||
      launchResult.success.code !== 0
    ) {
      return {
        state: "degraded",
        binaryPath,
        details:
          launchResult._tag === "Failure"
            ? `Chromium binary at '${binaryPath}' failed to launch: ${launchResult.failure.message}`
            : `Chromium binary at '${binaryPath}' did not exit cleanly when probing its version.`,
      };
    }

    const version = normalizeVersion(launchResult.success.stdout);

    if (playwrightBinaryPath) {
      return { state: "ok", binaryPath, ...(version ? { version } : {}) };
    }

    return {
      state: "degraded",
      binaryPath,
      ...(version ? { version } : {}),
      details:
        "A system Chromium binary was found, but the Playwright browser cache is missing or incomplete.",
    };
  },
);

export class BrowserCapabilityProbe extends Context.Service<
  BrowserCapabilityProbe,
  {
    readonly probe: Effect.Effect<BrowserCapability>;
  }
>()("t3/environment/BrowserCapabilityProbe") {}

export const make = Effect.fn("BrowserCapabilityProbe.make")(function* () {
  const fileSystem = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const processRunner = yield* ProcessRunner.ProcessRunner;
  const platform = yield* HostProcessPlatform;
  const env = yield* HostProcessEnvironment;

  const probe = yield* Effect.cachedWithTTL(
    probeBrowserCapability().pipe(
      Effect.provideService(FileSystem.FileSystem, fileSystem),
      Effect.provideService(Path.Path, path),
      Effect.provideService(ProcessRunner.ProcessRunner, processRunner),
      Effect.provideService(HostProcessPlatform, platform),
      Effect.provideService(HostProcessEnvironment, env),
    ),
    BROWSER_CAPABILITY_CACHE_TTL,
  );

  return BrowserCapabilityProbe.of({ probe });
});

/**
 * Self-contained so callers only need to provide filesystem/path/host-process
 * platform services; the probe never fails, it degrades to `"absent"`.
 */
export const layer = Layer.effect(BrowserCapabilityProbe, make()).pipe(
  Layer.provide(ProcessRunner.layer),
);
