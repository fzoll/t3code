import {
  AuthOrchestrationOperateScope,
  AuthOrchestrationReadScope,
  CommandId,
  EnvironmentAuthenticatedPrincipal,
  type AuthEnvironmentScope,
} from "@t3tools/contracts";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Option from "effect/Option";
import * as SqlClient from "effect/unstable/sql/SqlClient";
import * as NodeCrypto from "node:crypto";
import * as NodeOS from "node:os";

import * as ServerConfig from "../../config.ts";
import { availableMemoryMb } from "../../diagnostics/availableMemory.ts";
import * as ProcessDiagnostics from "../../diagnostics/ProcessDiagnostics.ts";
import * as ServerEnvironment from "../../environment/ServerEnvironment.ts";
import { projectThreadDetailSnapshot } from "../../orchestration/ActivityPayloadProjection.ts";
import { normalizeDispatchCommand } from "../../orchestration/Normalizer.ts";
import { OrchestrationEngineService } from "../../orchestration/Services/OrchestrationEngine.ts";
import { ProjectionSnapshotQuery } from "../../orchestration/Services/ProjectionSnapshotQuery.ts";
import { ProviderRegistry } from "../../provider/Services/ProviderRegistry.ts";
import { ProviderService } from "../../provider/Services/ProviderService.ts";
import { ExternalDiagnosticsError, ExternalToolkit } from "./tools.ts";

const requireScope = Effect.fn("ExternalToolkit.requireScope")(function* (
  scope: AuthEnvironmentScope,
) {
  const principal = yield* EnvironmentAuthenticatedPrincipal;
  if (!principal.scopes.has(scope)) {
    return yield* new ExternalDiagnosticsError({
      code: "scope_required",
      message: `This tool requires the '${scope}' scope.`,
    });
  }
});

const internalError = (code: string) => (cause: unknown) =>
  new ExternalDiagnosticsError({
    code,
    message: cause instanceof Error ? cause.message : String(cause),
  });

const dispatchCommand = Effect.fn("ExternalToolkit.dispatchCommand")(function* (payload: unknown) {
  yield* requireScope(AuthOrchestrationOperateScope);
  const engine = yield* OrchestrationEngineService;
  const command = yield* normalizeDispatchCommand(payload as never).pipe(
    Effect.mapError(internalError("invalid_command")),
  );
  return yield* engine.dispatch(command).pipe(Effect.mapError(internalError("dispatch_failed")));
});

const handlers = {
  t3_server_health: () =>
    Effect.gen(function* () {
      yield* requireScope(AuthOrchestrationReadScope);
      const serverEnvironment = yield* ServerEnvironment.ServerEnvironment;
      const providerService = yield* ProviderService;
      const processDiagnostics = yield* ProcessDiagnostics.ProcessDiagnostics;
      const descriptor = yield* serverEnvironment.getDescriptor.pipe(
        Effect.mapError(internalError("descriptor_failed")),
      );
      const sessionPids = yield* providerService
        .getSessionPids()
        .pipe(Effect.orElseSucceed(() => []));
      const rssByPid = new Map<number, number>();
      if (sessionPids.length > 0) {
        const diagnostics = yield* processDiagnostics.read.pipe(
          Effect.orElseSucceed(() => ({ processes: [] })),
        );
        for (const row of diagnostics.processes) {
          rssByPid.set(row.pid, row.rssBytes);
        }
      }
      return {
        environmentId: descriptor.environmentId,
        label: descriptor.label,
        version: descriptor.serverVersion,
        platform: { os: descriptor.platform.os, arch: descriptor.platform.arch },
        uptimeSeconds: Math.floor(process.uptime()),
        memory: {
          freeMb: availableMemoryMb(),
          totalMb: Math.round(NodeOS.totalmem() / (1024 * 1024)),
        },
        sessions: sessionPids.map((session) => ({
          threadId: String(session.threadId),
          pid: session.pid,
          rssBytes: rssByPid.get(session.pid) ?? 0,
        })),
      };
    }),

  t3_providers_list: () =>
    Effect.gen(function* () {
      yield* requireScope(AuthOrchestrationReadScope);
      const registry = yield* ProviderRegistry;
      return yield* registry.getProviders;
    }),

  t3_threads_list: (input) =>
    Effect.gen(function* () {
      yield* requireScope(AuthOrchestrationReadScope);
      const query = yield* ProjectionSnapshotQuery;
      const shell = yield* query
        .getShellSnapshot()
        .pipe(Effect.mapError(internalError("snapshot_failed")));
      const filter = input.filter ?? "recent";
      const limit = Math.min(Math.max(input.limit ?? 20, 1), 200);
      const projectTitles = new Map(shell.projects.map((project) => [project.id, project.title]));
      const threads = shell.threads
        .filter((thread) => {
          if (filter === "all") return true;
          if (thread.archivedAt !== null) return false;
          if (filter === "active") return thread.latestTurn?.state === "running";
          return true;
        })
        .toSorted((a, b) => (a.updatedAt < b.updatedAt ? 1 : -1))
        .slice(0, limit);
      return threads.map((thread) => ({
        threadId: String(thread.id),
        title: thread.title,
        projectTitle: projectTitles.get(thread.projectId) ?? "",
        provider: String(thread.modelSelection.instanceId),
        model: thread.modelSelection.model,
        status: thread.latestTurn?.state ?? "idle",
        hasPendingApprovals: thread.hasPendingApprovals,
        hasPendingUserInput: thread.hasPendingUserInput,
        branch: thread.branch,
        worktreePath: thread.worktreePath,
        archived: thread.archivedAt !== null,
        createdAt: thread.createdAt,
        updatedAt: thread.updatedAt,
      }));
    }),

  t3_thread_detail: (input) =>
    Effect.gen(function* () {
      yield* requireScope(AuthOrchestrationReadScope);
      const query = yield* ProjectionSnapshotQuery;
      const snapshot = yield* query
        .getThreadDetailSnapshot(input.threadId)
        .pipe(Effect.mapError(internalError("snapshot_failed")));
      if (Option.isNone(snapshot)) {
        return yield* new ExternalDiagnosticsError({
          code: "thread_not_found",
          message: `Thread '${input.threadId}' was not found.`,
        });
      }
      return projectThreadDetailSnapshot(snapshot.value);
    }),

  t3_server_logs: (input) =>
    Effect.gen(function* () {
      yield* requireScope(AuthOrchestrationReadScope);
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

  t3_server_diagnostics: () =>
    Effect.gen(function* () {
      yield* requireScope(AuthOrchestrationReadScope);
      const processDiagnostics = yield* ProcessDiagnostics.ProcessDiagnostics;
      return yield* processDiagnostics.read;
    }),

  t3_migrations_status: () =>
    Effect.gen(function* () {
      yield* requireScope(AuthOrchestrationReadScope);
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

  t3_thread_interrupt: (input) =>
    Effect.gen(function* () {
      const now = yield* DateTime.now;
      return yield* dispatchCommand({
        type: "thread.turn.interrupt",
        commandId: CommandId.make(NodeCrypto.randomUUID()),
        threadId: input.threadId,
        ...(input.turnId === undefined ? {} : { turnId: input.turnId }),
        createdAt: DateTime.formatIso(now),
      });
    }),

  t3_thread_stop: (input) =>
    Effect.gen(function* () {
      const now = yield* DateTime.now;
      return yield* dispatchCommand({
        type: "thread.session.stop",
        commandId: CommandId.make(NodeCrypto.randomUUID()),
        threadId: input.threadId,
        createdAt: DateTime.formatIso(now),
      });
    }),

  t3_providers_refresh: () =>
    Effect.gen(function* () {
      yield* requireScope(AuthOrchestrationOperateScope);
      const registry = yield* ProviderRegistry;
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
} satisfies Parameters<typeof ExternalToolkit.toLayer>[0];

export const ExternalToolkitHandlersLive = ExternalToolkit.toLayer(handlers);
