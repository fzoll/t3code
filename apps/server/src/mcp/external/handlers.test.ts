import * as NodeServices from "@effect/platform-node/NodeServices";
import { expect, it } from "@effect/vitest";
import {
  AuthOrchestrationOperateScope,
  AuthOrchestrationReadScope,
  AuthSessionId,
  EnvironmentAuthenticatedPrincipal,
  ProjectId,
  RunId,
  RuntimeRequestId,
  ThreadId,
  type AuthEnvironmentScope,
  type OrchestrationV2ThreadShell,
} from "@t3tools/contracts";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Ref from "effect/Ref";
import * as SqlClient from "effect/sql/SqlClient";
import { McpSchema, McpServer } from "effect/ai";

import * as ServerConfig from "../../config.ts";
import * as ProcessDiagnostics from "../../diagnostics/ProcessDiagnostics.ts";
import * as ServerEnvironment from "../../environment/ServerEnvironment.ts";
import * as ProviderRegistry from "../../provider/ProviderRegistry.ts";
import { HostResources } from "../../resourceTelemetry/HostResources.ts";

import * as ProjectStore from "../../orchestration-v2/ProjectStore.ts";
import * as ThreadManagement from "../../orchestration-v2/ThreadManagementService.ts";
import * as McpHttpServer from "../McpHttpServer.ts";
import { liveThreadShell } from "../McpToolAccess.testkit.ts";
import { ExternalToolkitHandlersLive } from "./handlers.ts";
import { ExternalToolkit } from "./tools.ts";

const projectId = ProjectId.make("project:mcp-test");
const running = ThreadId.make("thread:running");
const idle = ThreadId.make("thread:idle");
const archived = ThreadId.make("thread:archived");

const at = (iso: string) => DateTime.makeUnsafe(iso);

const shell = (
  id: ThreadId,
  overrides: Partial<OrchestrationV2ThreadShell> = {},
): OrchestrationV2ThreadShell => ({ ...liveThreadShell(id), ...overrides });

const shells = {
  [running]: shell(running, {
    updatedAt: at("2026-10-01T10:00:00.000Z"),
    pendingRuntimeRequest: {
      id: RuntimeRequestId.make("request:1"),
      kind: "command",
      createdAt: at("2026-10-01T10:00:00.000Z"),
    },
  }),
  [idle]: shell(idle, {
    activeRunId: null,
    status: "idle",
    updatedAt: at("2026-10-02T10:00:00.000Z"),
    pendingRuntimeRequest: {
      id: RuntimeRequestId.make("request:2"),
      kind: "user_input",
      createdAt: at("2026-10-02T10:00:00.000Z"),
    },
  }),
  [archived]: shell(archived, {
    activeRunId: null,
    status: "idle",
    archivedAt: at("2026-10-03T10:00:00.000Z"),
    updatedAt: at("2026-10-03T10:00:00.000Z"),
  }),
} as Record<ThreadId, OrchestrationV2ThreadShell>;

const principal = (scopes: ReadonlyArray<AuthEnvironmentScope>) => ({
  sessionId: AuthSessionId.make("session:external"),
  subject: "external",
  method: "bearer-access-token" as const,
  scopes: new Set(scopes),
});

const client = McpSchema.McpServerClient.of({
  clientId: 1,
  protocolVersion: "2025-06-18",
  clientCapabilities: {},
  clientInfo: { name: "external", version: "1" },
  initializePayload: {
    protocolVersion: "2025-06-18",
    capabilities: {},
    clientInfo: { name: "external", version: "1" },
  },
  getClient: Effect.die("unused"),
});

// In production the /mcp/external auth middleware provides the principal per
// request; the registration excludes it, and each call below provides one.
const registered = McpHttpServer.environmentTokenToolkitRegistration(
  ExternalToolkit,
  ExternalToolkitHandlersLive,
);

const makeLayer = (calls: Ref.Ref<ReadonlyArray<unknown>>) =>
  registered.pipe(
    Layer.provideMerge(McpServer.McpServer.layer),
    // Services the tools under test never touch.
    Layer.provide(
      Layer.mergeAll(
        Layer.mock(HostResources)({}),
        Layer.mock(ProcessDiagnostics.ProcessDiagnostics)({}),
        Layer.mock(ProviderRegistry.ProviderRegistry)({}),
        Layer.succeed(ServerConfig.ServerConfig, {} as ServerConfig.ServerConfig["Service"]),
        Layer.mock(ServerEnvironment.ServerEnvironment)({}),
        Layer.succeed(SqlClient.SqlClient, {} as SqlClient.SqlClient),
      ),
    ),
    Layer.provide(
      Layer.mock(ThreadManagement.ThreadManagementService)({
        getShellSnapshot: (options) =>
          Effect.succeed({
            schemaVersion: 1,
            snapshotSequence: 7,
            threads: options?.location === "archive" ? [] : [shells[running]!, shells[idle]!],
            archivedThreads: options?.location === "archive" ? [shells[archived]!] : [],
          }),
        getThreadShell: (threadId) => Effect.succeed(shells[threadId] ?? null),
        interruptThread: (input) =>
          Ref.update(calls, (all) => [...all, { interrupt: input }]).pipe(
            Effect.as({ type: "no_active_run" as const }),
          ),
        dispatch: (command) =>
          Ref.update(calls, (all) => [...all, { dispatch: command }]).pipe(
            Effect.as({ sequence: 1 } as never),
          ),
      }),
    ),
    Layer.provide(
      Layer.mock(ProjectStore.ProjectStoreV2)({
        listShells: () =>
          Effect.succeed([
            {
              id: projectId,
              title: "Pipeline project",
            } as never,
          ]),
      }),
    ),
    Layer.provide(NodeServices.layer),
  );

const callTool = (
  name: string,
  args: Record<string, unknown>,
  scopes: ReadonlyArray<AuthEnvironmentScope>,
) =>
  Effect.gen(function* () {
    const server = yield* McpServer.McpServer;
    return yield* server
      .callTool({ name, arguments: args })
      .pipe(
        Effect.provideService(EnvironmentAuthenticatedPrincipal, principal(scopes)),
        Effect.provideService(McpSchema.McpServerClient, client),
      );
  });

it.effect("t3_threads_list maps v2 thread shells and filters by run activity", () =>
  Effect.gen(function* () {
    const recent = yield* callTool("t3_threads_list", {}, [AuthOrchestrationReadScope]);
    expect(recent.isError).toBe(false);
    const recentThreads = recent.structuredContent as unknown as ReadonlyArray<
      Record<string, unknown>
    >;
    expect(recentThreads.map((thread) => thread.threadId)).toEqual([idle, running]);
    expect(recentThreads[1]).toMatchObject({
      projectTitle: "Pipeline project",
      provider: "codex",
      model: "gpt-5",
      status: "running",
      hasPendingApprovals: true,
      hasPendingUserInput: false,
      archived: false,
      updatedAt: "2026-10-01T10:00:00.000Z",
    });
    expect(recentThreads[0]).toMatchObject({
      status: "idle",
      hasPendingApprovals: false,
      hasPendingUserInput: true,
    });

    const active = yield* callTool("t3_threads_list", { filter: "active" }, [
      AuthOrchestrationReadScope,
    ]);
    expect(
      (active.structuredContent as unknown as ReadonlyArray<{ threadId: string }>).map(
        (thread) => thread.threadId,
      ),
    ).toEqual([running]);

    const all = yield* callTool("t3_threads_list", { filter: "all" }, [AuthOrchestrationReadScope]);
    expect(
      (all.structuredContent as unknown as ReadonlyArray<{ threadId: string }>).map(
        (thread) => thread.threadId,
      ),
    ).toEqual([archived, idle, running]);
  }).pipe(Effect.provide(makeLayer(Ref.makeUnsafe<ReadonlyArray<unknown>>([])))),
);

it.effect("operate tools require the operate scope and route through thread management", () =>
  Effect.gen(function* () {
    const calls = yield* Ref.make<ReadonlyArray<unknown>>([]);
    yield* Effect.gen(function* () {
      const denied = yield* callTool("t3_thread_stop", { threadId: running }, [
        AuthOrchestrationReadScope,
      ]);
      expect(denied.isError).toBe(true);
      expect(yield* Ref.get(calls)).toEqual([]);

      const missing = yield* callTool("t3_thread_interrupt", { threadId: "thread:missing" }, [
        AuthOrchestrationOperateScope,
      ]);
      expect(missing.isError).toBe(true);

      const interrupted = yield* callTool(
        "t3_thread_interrupt",
        { threadId: running, runId: RunId.make("run:mcp-test") },
        [AuthOrchestrationOperateScope],
      );
      expect(interrupted.isError).toBe(false);
      const stopped = yield* callTool("t3_thread_stop", { threadId: running }, [
        AuthOrchestrationOperateScope,
      ]);
      expect(stopped.isError).toBe(false);

      const recorded = (yield* Ref.get(calls)) as ReadonlyArray<Record<string, any>>;
      expect(recorded).toHaveLength(2);
      expect(recorded[0]!.interrupt).toMatchObject({
        projectId,
        threadId: running,
        runId: "run:mcp-test",
      });
      expect(recorded[1]!.dispatch).toMatchObject({ type: "thread.stop", threadId: running });
    }).pipe(Effect.provide(makeLayer(calls)));
  }),
);
