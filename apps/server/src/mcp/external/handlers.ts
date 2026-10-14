import {
  AuthOrchestrationOperateScope,
  AuthOrchestrationReadScope,
  CommandId,
  type AuthEnvironmentScope,
  type OrchestrationV2ThreadShell,
  type ThreadId,
} from "@t3tools/contracts";
import * as Crypto from "effect/Crypto";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as SqlClient from "effect/sql/SqlClient";

import * as ServerConfig from "../../config.ts";

import * as ProcessDiagnostics from "../../diagnostics/ProcessDiagnostics.ts";
import * as ServerEnvironment from "../../environment/ServerEnvironment.ts";
import * as ProjectStore from "../../orchestration-v2/ProjectStore.ts";
import * as ThreadManagementService from "../../orchestration-v2/ThreadManagementService.ts";
import * as ProviderRegistry from "../../provider/ProviderRegistry.ts";
import { HostResources } from "../../resourceTelemetry/HostResources.ts";
import * as McpToolAccess from "../McpToolAccess.ts";
import { ExternalDiagnosticsError, ExternalToolkit } from "./tools.ts";

const refuseWithoutScope = (scope: AuthEnvironmentScope) =>
  new ExternalDiagnosticsError({
    code: "scope_required",
    message: `This tool requires the '${scope}' scope.`,
  });

/** Read tools need the principal's read scope, operate tools its operate scope. */
const reads = <P, A, E, R>(handle: (params: P) => Effect.Effect<A, E, R>) =>
  McpToolAccess.requiresEnvironmentScope(AuthOrchestrationReadScope, refuseWithoutScope, handle);

const operates = <P, A, E, R>(handle: (params: P) => Effect.Effect<A, E, R>) =>
  McpToolAccess.requiresEnvironmentScope(AuthOrchestrationOperateScope, refuseWithoutScope, handle);

const internalError = (code: string) => (cause: unknown) =>
  new ExternalDiagnosticsError({
    code,
    message: cause instanceof Error ? cause.message : String(cause),
  });

const isThreadNotFound = (cause: unknown) =>
  typeof cause === "object" &&
  cause !== null &&
  "_tag" in cause &&
  cause._tag === "ThreadManagementThreadNotFoundError";

/** Thread detail keeps recent history only; the full projection can be many MB. */
const DETAIL_MESSAGE_LIMIT = 50;
const DETAIL_ACTIVITY_LIMIT = 100;
const DETAIL_MESSAGE_TEXT_LIMIT = 4_000;

const newCommandId = Effect.gen(function* () {
  const crypto = yield* Crypto.Crypto;
  return CommandId.make(yield* crypto.randomUUIDv4().pipe(Effect.orDie));
});

const loadThreadShell = Effect.fn("ExternalToolkit.loadThreadShell")(function* (
  threadId: ThreadId,
) {
  const threadManagement = yield* ThreadManagementService.ThreadManagementService;
  const shell = yield* threadManagement
    .getThreadShell(threadId)
    .pipe(Effect.mapError(internalError("snapshot_failed")));
  if (shell === null) {
    return yield* new ExternalDiagnosticsError({
      code: "thread_not_found",
      message: `Thread '${threadId}' was not found.`,
    });
  }
  return shell;
});

const isPendingApproval = (shell: OrchestrationV2ThreadShell) =>
  shell.pendingRuntimeRequest !== null &&
  shell.pendingRuntimeRequest.kind !== "user_input" &&
  shell.pendingRuntimeRequest.kind !== "auth_refresh" &&
  shell.pendingRuntimeRequest.kind !== "dynamic_tool_call";

export const ExternalToolkitHandlersLive = McpToolAccess.toLayer(ExternalToolkit, {
  t3_server_health: reads(() =>
    Effect.gen(function* () {
      const serverEnvironment = yield* ServerEnvironment.ServerEnvironment;
      const hostResources = yield* HostResources;
      const descriptor = yield* serverEnvironment.getDescriptor.pipe(
        Effect.mapError(internalError("descriptor_failed")),
      );
      // Whole-host capacity comes from the shared HostResources snapshot
      // (serverGetHostResources) so get_node_health and load balancing read the
      // same numbers. `sampledAt` lets the reader enforce its freshness window.
      const resources = yield* hostResources.read;
      return {
        environmentId: descriptor.environmentId,
        label: descriptor.label,
        version: descriptor.serverVersion,
        platform: { os: descriptor.platform.os, arch: descriptor.platform.arch },
        uptimeSeconds: Math.floor(process.uptime()),
        hostResources: resources,
      };
    }),
  ),

  t3_providers_list: reads(() =>
    Effect.gen(function* () {
      const registry = yield* ProviderRegistry.ProviderRegistry;
      return yield* registry.getProviders;
    }),
  ),

  t3_threads_list: reads((input) =>
    Effect.gen(function* () {
      const threadManagement = yield* ThreadManagementService.ThreadManagementService;
      const projectStore = yield* ProjectStore.ProjectStoreV2;
      const filter = input.filter ?? "recent";
      const limit = Math.min(Math.max(input.limit ?? 20, 1), 200);
      const active = yield* threadManagement
        .getShellSnapshot({ location: "active" })
        .pipe(Effect.mapError(internalError("snapshot_failed")));
      const archived =
        filter === "all"
          ? yield* threadManagement
              .getShellSnapshot({ location: "archive" })
              .pipe(Effect.mapError(internalError("snapshot_failed")))
          : undefined;
      const projects = yield* projectStore
        .listShells()
        .pipe(Effect.mapError(internalError("snapshot_failed")));
      const projectTitles = new Map(projects.map((project) => [project.id, project.title]));
      const candidates: ReadonlyArray<OrchestrationV2ThreadShell> = [
        ...active.threads,
        ...(archived === undefined ? [] : [...archived.threads, ...archived.archivedThreads]),
      ];
      const seen = new Set<ThreadId>();
      const threads = candidates
        .filter((thread) => {
          if (seen.has(thread.id) || thread.deletedAt !== null) return false;
          seen.add(thread.id);
          if (filter === "all") return true;
          if (thread.archivedAt !== null) return false;
          if (filter === "active") return thread.activeRunId !== null;
          return true;
        })
        .toSorted(
          (a, b) => DateTime.toEpochMillis(b.updatedAt) - DateTime.toEpochMillis(a.updatedAt),
        )
        .slice(0, limit);
      return threads.map((thread) => ({
        threadId: String(thread.id),
        title: thread.title,
        projectTitle: projectTitles.get(thread.projectId) ?? "",
        provider: String(thread.providerInstanceId),
        model: thread.modelSelection.model,
        status: thread.status,
        hasPendingApprovals: isPendingApproval(thread),
        hasPendingUserInput: thread.pendingRuntimeRequest?.kind === "user_input",
        branch: thread.branch,
        worktreePath: thread.worktreePath,
        archived: thread.archivedAt !== null,
        createdAt: DateTime.formatIso(thread.createdAt),
        updatedAt: DateTime.formatIso(thread.updatedAt),
      }));
    }),
  ),

  t3_thread_detail: reads((input) =>
    Effect.gen(function* () {
      const threadManagement = yield* ThreadManagementService.ThreadManagementService;
      const shell = yield* loadThreadShell(input.threadId);
      const snapshot = yield* threadManagement.getThreadSnapshot(input.threadId).pipe(
        Effect.mapError((cause) =>
          isThreadNotFound(cause)
            ? new ExternalDiagnosticsError({
                code: "thread_not_found",
                message: `Thread '${input.threadId}' was not found.`,
              })
            : internalError("snapshot_failed")(cause),
        ),
      );
      const projection = snapshot.projection;
      const truncateText = (text: string) =>
        text.length > DETAIL_MESSAGE_TEXT_LIMIT
          ? `${text.slice(0, DETAIL_MESSAGE_TEXT_LIMIT)}… [truncated ${text.length - DETAIL_MESSAGE_TEXT_LIMIT} chars]`
          : text;
      return {
        snapshotSequence: snapshot.snapshotSequence,
        thread: shell,
        runs: projection.runs,
        providerSessions: projection.providerSessions,
        pendingRuntimeRequests: projection.runtimeRequests.filter(
          (request) => request.status === "pending",
        ),
        messageCount: projection.messages.length,
        messages: projection.messages.slice(-DETAIL_MESSAGE_LIMIT).map((message) => ({
          id: message.id,
          runId: message.runId,
          role: message.role,
          text: truncateText(message.text),
          streaming: message.streaming,
          attachmentCount: message.attachments.length,
          createdAt: message.createdAt,
        })),
        activityCount: projection.turnItems.length,
        activities: projection.turnItems.slice(-DETAIL_ACTIVITY_LIMIT).map((item) => ({
          id: item.id,
          type: item.type,
          status: item.status,
          title: item.title,
          runId: item.runId,
          startedAt: item.startedAt,
          completedAt: item.completedAt,
        })),
        checkpoints: projection.checkpoints,
        updatedAt: projection.updatedAt,
      };
    }),
  ),

  t3_server_logs: reads((input) =>
    Effect.gen(function* () {
      const config = yield* ServerConfig.ServerConfig;
      const fileSystem = yield* FileSystem.FileSystem;
      const requested = Math.min(Math.max(input.lines ?? 100, 1), 1000);
      const text = yield* fileSystem
        .readFileString(config.serverTracePath)
        .pipe(Effect.orElseSucceed(() => ""));
      let lines = text.split("\n").filter((line) => line.length > 0);
      if (input.level !== undefined) {
        const level = input.level.toUpperCase();
        lines = lines.filter((line) => line.toUpperCase().includes(`"${level}"`));
      }
      if (input.pattern !== undefined) {
        const pattern = yield* Effect.try({
          try: () => new RegExp(input.pattern as string),
          catch: internalError("invalid_pattern"),
        });
        lines = lines.filter((line) => pattern.test(line));
      }
      return {
        filePath: config.serverTracePath,
        entries: lines.slice(-requested),
        truncated: lines.length > requested,
      };
    }),
  ),

  t3_server_diagnostics: reads(() =>
    Effect.gen(function* () {
      const processDiagnostics = yield* ProcessDiagnostics.ProcessDiagnostics;
      return yield* processDiagnostics.read;
    }),
  ),

  t3_migrations_status: reads(() =>
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      const config = yield* ServerConfig.ServerConfig;
      const fileSystem = yield* FileSystem.FileSystem;
      const rows = yield* sql<{ readonly migration_id: number; readonly name: string }>`
        SELECT migration_id, name FROM effect_sql_migrations ORDER BY migration_id DESC
      `.pipe(Effect.mapError(internalError("migrations_query_failed")));
      const stat = yield* fileSystem
        .stat(config.dbPath)
        .pipe(Effect.orElseSucceed(() => ({ size: 0n }) as const));
      return {
        latestMigrationId: rows[0]?.migration_id ?? null,
        latestMigrationName: rows[0]?.name ?? null,
        totalMigrations: rows.length,
        databasePath: config.dbPath,
        databaseSizeBytes: Number(stat.size),
      };
    }),
  ),

  t3_thread_interrupt: operates((input) =>
    Effect.gen(function* () {
      const threadManagement = yield* ThreadManagementService.ThreadManagementService;
      const shell = yield* loadThreadShell(input.threadId);
      const commandId = yield* newCommandId;
      return yield* threadManagement
        .interruptThread({
          projectId: shell.projectId,
          commandId,
          threadId: input.threadId,
          ...(input.runId === undefined ? {} : { runId: input.runId }),
          reason: "Interrupted via external diagnostics MCP",
        })
        .pipe(Effect.mapError(internalError("dispatch_failed")));
    }),
  ),

  t3_thread_stop: operates((input) =>
    Effect.gen(function* () {
      const threadManagement = yield* ThreadManagementService.ThreadManagementService;
      yield* loadThreadShell(input.threadId);
      const commandId = yield* newCommandId;
      return yield* threadManagement
        .dispatch({
          type: "thread.stop",
          commandId,
          threadId: input.threadId,
          reason: "Stopped via external diagnostics MCP",
        })
        .pipe(Effect.mapError(internalError("dispatch_failed")));
    }),
  ),

  t3_providers_refresh: operates(() =>
    Effect.gen(function* () {
      const registry = yield* ProviderRegistry.ProviderRegistry;
      // Re-probing every provider CLI can hang on machines where a CLI is
      // broken; cap the wait so the MCP call fails loudly instead of stalling.
      return yield* registry.refresh().pipe(
        Effect.timeoutOrElse({
          duration: "45 seconds",
          orElse: () =>
            Effect.fail(
              new ExternalDiagnosticsError({
                code: "refresh_timeout",
                message: "Provider refresh did not finish within 45 seconds.",
              }),
            ),
        }),
      );
    }),
  ),
});
