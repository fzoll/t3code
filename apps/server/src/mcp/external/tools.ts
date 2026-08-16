import {
  EnvironmentAuthenticatedPrincipal,
  ServerProcessDiagnosticsResult,
  ThreadId,
  TurnId,
} from "@t3tools/contracts";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";
import * as Schema from "effect/Schema";
import * as SqlClient from "effect/unstable/sql/SqlClient";
import { Tool, Toolkit } from "effect/unstable/ai";

import * as ServerConfig from "../../config.ts";
import * as ProcessDiagnostics from "../../diagnostics/ProcessDiagnostics.ts";
import * as ServerEnvironment from "../../environment/ServerEnvironment.ts";
import { OrchestrationEngineService } from "../../orchestration/Services/OrchestrationEngine.ts";
import { ProjectionSnapshotQuery } from "../../orchestration/Services/ProjectionSnapshotQuery.ts";
import { ProviderRegistry } from "../../provider/Services/ProviderRegistry.ts";
import { ProviderService } from "../../provider/Services/ProviderService.ts";
import * as WorkspacePaths from "../../workspace/WorkspacePaths.ts";

export class ExternalDiagnosticsError extends Schema.TaggedErrorClass<ExternalDiagnosticsError>()(
  "ExternalDiagnosticsError",
  {
    code: Schema.String,
    message: Schema.String,
  },
) {}

const dependencies = [
  EnvironmentAuthenticatedPrincipal,
  ServerConfig.ServerConfig,
  ServerEnvironment.ServerEnvironment,
  ProviderService,
  ProviderRegistry,
  ProcessDiagnostics.ProcessDiagnostics,
  ProjectionSnapshotQuery,
  OrchestrationEngineService,
  FileSystem.FileSystem,
  Path.Path,
  SqlClient.SqlClient,
  WorkspacePaths.WorkspacePaths,
];

const readonlyTool = <T extends Tool.Any>(tool: T): T =>
  tool
    .annotate(Tool.Readonly, true)
    .annotate(Tool.Destructive, false)
    .annotate(Tool.Idempotent, true)
    .annotate(Tool.OpenWorld, false) as T;

const operateTool = <T extends Tool.Any>(tool: T): T =>
  tool
    .annotate(Tool.Readonly, false)
    .annotate(Tool.Destructive, true)
    .annotate(Tool.OpenWorld, false) as T;

export const ServerHealthResult = Schema.Struct({
  environmentId: Schema.String,
  label: Schema.String,
  version: Schema.String,
  platform: Schema.Struct({ os: Schema.String, arch: Schema.String }),
  uptimeSeconds: Schema.Int,
  memory: Schema.Struct({ freeMb: Schema.Int, totalMb: Schema.Int }),
  sessions: Schema.Array(
    Schema.Struct({
      threadId: Schema.String,
      pid: Schema.Int,
      rssBytes: Schema.Int,
    }),
  ),
});

export const ServerHealthTool = readonlyTool(
  Tool.make("t3_server_health", {
    description:
      "Server health snapshot: environment identity, version, platform, uptime, memory, and active provider sessions with their process memory usage.",
    success: ServerHealthResult,
    failure: ExternalDiagnosticsError,
    dependencies,
  }).annotate(Tool.Title, "T3 server health"),
);

export const ProvidersListTool = readonlyTool(
  Tool.make("t3_providers_list", {
    description:
      "List configured provider instances with install status, CLI version, health, and available models.",
    success: Schema.Unknown,
    failure: ExternalDiagnosticsError,
    dependencies,
  }).annotate(Tool.Title, "List T3 providers"),
);

export const ThreadsListEntry = Schema.Struct({
  threadId: Schema.String,
  title: Schema.String,
  projectTitle: Schema.String,
  provider: Schema.String,
  model: Schema.String,
  status: Schema.String,
  hasPendingApprovals: Schema.Boolean,
  hasPendingUserInput: Schema.Boolean,
  branch: Schema.NullOr(Schema.String),
  worktreePath: Schema.NullOr(Schema.String),
  archived: Schema.Boolean,
  createdAt: Schema.String,
  updatedAt: Schema.String,
});

export const ThreadsListTool = readonlyTool(
  Tool.make("t3_threads_list", {
    description:
      "List threads with project, provider, model, run status, and pending approval/input flags. filter: 'active' returns only threads with a running turn; 'recent' (default) returns the most recently updated; 'all' returns everything including archived.",
    parameters: Schema.Struct({
      filter: Schema.optional(Schema.Literals(["active", "recent", "all"])),
      limit: Schema.optional(Schema.Int),
    }),
    success: Schema.Array(ThreadsListEntry),
    failure: ExternalDiagnosticsError,
    dependencies,
  }).annotate(Tool.Title, "List T3 threads"),
);

export const ThreadDetailTool = readonlyTool(
  Tool.make("t3_thread_detail", {
    description:
      "Detailed thread snapshot: turn history, messages, activities, checkpoints, pending approvals and user-input requests, session state, worktree path.",
    parameters: Schema.Struct({ threadId: ThreadId }),
    success: Schema.Unknown,
    failure: ExternalDiagnosticsError,
    dependencies,
  }).annotate(Tool.Title, "T3 thread detail"),
);

export const ServerLogsResult = Schema.Struct({
  filePath: Schema.String,
  entries: Schema.Array(Schema.String),
  truncated: Schema.Boolean,
});

export const ServerLogsTool = readonlyTool(
  Tool.make("t3_server_logs", {
    description:
      "Tail the server trace log (ndjson). Optionally filter lines by a case-sensitive regex pattern and/or a log level substring (e.g. 'WARN', 'ERROR'). Returns raw ndjson lines, newest last.",
    parameters: Schema.Struct({
      lines: Schema.optional(Schema.Int),
      level: Schema.optional(Schema.String),
      pattern: Schema.optional(Schema.String),
    }),
    success: ServerLogsResult,
    failure: ExternalDiagnosticsError,
    dependencies,
  }).annotate(Tool.Title, "T3 server logs"),
);

export const ServerDiagnosticsTool = readonlyTool(
  Tool.make("t3_server_diagnostics", {
    description:
      "Process diagnostics for the server and its provider session children: pid, command, RSS memory, CPU, and elapsed time per process.",
    success: ServerProcessDiagnosticsResult,
    failure: ExternalDiagnosticsError,
    dependencies,
  }).annotate(Tool.Title, "T3 process diagnostics"),
);

export const MigrationsStatusResult = Schema.Struct({
  latestMigrationId: Schema.NullOr(Schema.Int),
  latestMigrationName: Schema.NullOr(Schema.String),
  totalMigrations: Schema.Int,
  databasePath: Schema.String,
  databaseSizeBytes: Schema.Int,
});

export const MigrationsStatusTool = readonlyTool(
  Tool.make("t3_migrations_status", {
    description:
      "Database migration state: latest applied migration, total applied count, database path and size. Useful for post-rebase debugging.",
    success: MigrationsStatusResult,
    failure: ExternalDiagnosticsError,
    dependencies,
  }).annotate(Tool.Title, "T3 migration status"),
);

export const ThreadInterruptTool = operateTool(
  Tool.make("t3_thread_interrupt", {
    description:
      "Interrupt a running turn on a thread. Pass turnId to target a specific turn; omit it to interrupt the thread's active turn.",
    parameters: Schema.Struct({
      threadId: ThreadId,
      turnId: Schema.optional(TurnId),
    }),
    success: Schema.Unknown,
    failure: ExternalDiagnosticsError,
    dependencies,
  }).annotate(Tool.Title, "Interrupt T3 thread turn"),
);

export const ThreadStopTool = operateTool(
  Tool.make("t3_thread_stop", {
    description: "Stop the provider session backing a thread.",
    parameters: Schema.Struct({ threadId: ThreadId }),
    success: Schema.Unknown,
    failure: ExternalDiagnosticsError,
    dependencies,
  }).annotate(Tool.Title, "Stop T3 thread session"),
);

export const ProvidersRefreshTool = operateTool(
  Tool.make("t3_providers_refresh", {
    description:
      "Force refresh provider status (re-probe CLI versions, re-discover models), then return the refreshed provider list.",
    success: Schema.Unknown,
    failure: ExternalDiagnosticsError,
    dependencies,
  })
    .annotate(Tool.Title, "Refresh T3 providers")
    .annotate(Tool.Destructive, false)
    .annotate(Tool.Idempotent, true),
);

export const ExternalToolkit = Toolkit.make(
  ServerHealthTool,
  ProvidersListTool,
  ThreadsListTool,
  ThreadDetailTool,
  ServerLogsTool,
  ServerDiagnosticsTool,
  MigrationsStatusTool,
  ThreadInterruptTool,
  ThreadStopTool,
  ProvidersRefreshTool,
);
