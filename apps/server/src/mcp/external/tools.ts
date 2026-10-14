import {
  EnvironmentAuthenticatedPrincipal,
  HostResourcesSnapshot,
  RunId,
  ServerProcessDiagnosticsResult,
  ThreadId,
} from "@t3tools/contracts";
import * as Crypto from "effect/Crypto";
import * as FileSystem from "effect/FileSystem";
import * as Schema from "effect/Schema";
import * as SqlClient from "effect/sql/SqlClient";
import { Tool, Toolkit } from "effect/ai";

import * as ServerConfig from "../../config.ts";
import * as ProcessDiagnostics from "../../diagnostics/ProcessDiagnostics.ts";
import * as ServerEnvironment from "../../environment/ServerEnvironment.ts";
import * as ProjectStore from "../../orchestration-v2/ProjectStore.ts";
import * as ThreadManagementService from "../../orchestration-v2/ThreadManagementService.ts";
import * as ProviderRegistry from "../../provider/ProviderRegistry.ts";
import { HostResources } from "../../resourceTelemetry/HostResources.ts";

export class ExternalDiagnosticsError extends Schema.TaggedError<ExternalDiagnosticsError>()(
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
  ProviderRegistry.ProviderRegistry,
  ProcessDiagnostics.ProcessDiagnostics,
  HostResources,
  ThreadManagementService.ThreadManagementService,
  ProjectStore.ProjectStoreV2,
  FileSystem.FileSystem,
  SqlClient.SqlClient,
  Crypto.Crypto,
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
  hostResources: HostResourcesSnapshot,
});

const ServerHealthTool = readonlyTool(
  Tool.make("t3_server_health", {
    description:
      "Server health snapshot: environment identity, version, platform, uptime, and the whole-host resource sample (CPU, memory, sampledAt) shared with load balancing.",
    success: ServerHealthResult,
    failure: ExternalDiagnosticsError,
    dependencies,
  }).annotate(Tool.Title, "T3 server health"),
);

const ProvidersListTool = readonlyTool(
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

const ThreadsListTool = readonlyTool(
  Tool.make("t3_threads_list", {
    description:
      "List threads with project, provider, model, run status, and pending approval/input flags. filter: 'active' returns only threads with an active run; 'recent' (default) returns the most recently updated; 'all' returns everything including archived.",
    parameters: Schema.Struct({
      filter: Schema.optional(Schema.Literals(["active", "recent", "all"])),
      limit: Schema.optional(Schema.Int),
    }),
    success: Schema.Array(ThreadsListEntry),
    failure: ExternalDiagnosticsError,
    dependencies,
  }).annotate(Tool.Title, "List T3 threads"),
);

const ThreadDetailTool = readonlyTool(
  Tool.make("t3_thread_detail", {
    description:
      "Detailed thread snapshot: thread shell (status, branch, worktree path), runs, provider sessions, pending approvals and user-input requests, recent messages, recent activities (turn items, payloads omitted) and checkpoints.",
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

const ServerLogsTool = readonlyTool(
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

const ServerDiagnosticsTool = readonlyTool(
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

const MigrationsStatusTool = readonlyTool(
  Tool.make("t3_migrations_status", {
    description:
      "Database migration state: latest applied migration, total applied count, database path and size. Useful for post-rebase debugging.",
    success: MigrationsStatusResult,
    failure: ExternalDiagnosticsError,
    dependencies,
  }).annotate(Tool.Title, "T3 migration status"),
);

const ThreadInterruptTool = operateTool(
  Tool.make("t3_thread_interrupt", {
    description:
      "Interrupt a running run on a thread. Pass runId to target a specific run; omit it to interrupt the thread's active run.",
    parameters: Schema.Struct({
      threadId: ThreadId,
      runId: Schema.optional(RunId),
    }),
    success: Schema.Unknown,
    failure: ExternalDiagnosticsError,
    dependencies,
  }).annotate(Tool.Title, "Interrupt T3 thread turn"),
);

const ThreadStopTool = operateTool(
  Tool.make("t3_thread_stop", {
    description:
      "Stop a thread, whatever it is doing: interrupts its running turn, holds its queue, ends its pull request watches and stops its delegated tasks.",
    parameters: Schema.Struct({ threadId: ThreadId }),
    success: Schema.Unknown,
    failure: ExternalDiagnosticsError,
    dependencies,
  }).annotate(Tool.Title, "Stop T3 thread session"),
);

const ProvidersRefreshTool = operateTool(
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
