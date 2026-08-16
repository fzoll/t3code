# T3 Code MCP Server — External Diagnostic Interface

## Motivation

T3 Code servers run on remote nodes (RPi, cloud VMs). Debugging requires SSH + journalctl + sqlite3 — slow, fragile, breaks flow. An MCP server lets any MCP-compatible agent (Claude Code, Codex, jcode) query T3 backend state directly.

## Architecture

```
Agent (Claude Code / CC Runner)
  │
  ├── MCP stdio transport (local)
  │     └── t3-mcp-bridge (thin Node CLI)
  │           └── HTTP → T3 Server REST API
  │
  └── MCP SSE transport (remote)
        └── T3 Server /mcp/external endpoint
```

Two transport options:
1. **stdio bridge** — `t3-mcp-bridge --host hermes.local:3773 --token <bearer>` — local process, agent adds to `.mcp.json`
2. **SSE endpoint** — T3 server exposes `/mcp/external/sse` — agent connects directly (needs auth token)

Auth: bearer token from existing T3 pairing system (`/api/auth/browser-session` + `/api/auth/websocket-ticket`). Reuse `orchestration:read` scope for read-only tools, `orchestration:operate` for write tools.

## Tools

### Read-only (orchestration:read scope)

#### `t3.server.health`
Server health snapshot.

**Input:** `{}`

**Output:**
```json
{
  "nodeId": "rpi5",
  "uptime": "4h 23m",
  "version": "0.0.31",
  "platform": { "os": "linux", "arch": "arm64" },
  "memory": { "freeMb": 11069, "totalMb": 16003 },
  "sessions": {
    "active": 2,
    "total": 15
  }
}
```

#### `t3.providers.list`
List configured providers with status and available models.

**Input:** `{}`

**Output:**
```json
[
  {
    "instanceId": "claudeAgent",
    "displayName": "Claude",
    "status": "ready",
    "installed": true,
    "version": "2.1.212",
    "models": ["claude-sonnet-4", "claude-opus-4"]
  },
  {
    "instanceId": "jcode",
    "displayName": "Jcode",
    "status": "ready",
    "installed": true,
    "version": "0.64.2",
    "models": ["auto"]
  }
]
```

#### `t3.threads.list`
List threads with status, provider, model, timing.

**Input:**
```json
{
  "filter": "active" | "recent" | "all",
  "limit": 20
}
```

**Output:**
```json
[
  {
    "threadId": "0940cbd8-...",
    "title": "Fix auth middleware",
    "projectTitle": "tellmemore",
    "provider": "claudeAgent",
    "model": "claude-sonnet-4",
    "status": "running",
    "hasPendingApprovals": false,
    "hasPendingUserInput": false,
    "activeTurnId": "turn-abc",
    "createdAt": "2026-08-07T10:00:00Z",
    "updatedAt": "2026-08-07T14:23:00Z",
    "sessionPid": 12345,
    "sessionRssBytes": 367239168
  }
]
```

#### `t3.thread.detail`
Detailed thread state including turn history, pending approvals, diff summary.

**Input:** `{ "threadId": "0940cbd8-..." }`

**Output:**
```json
{
  "threadId": "0940cbd8-...",
  "title": "Fix auth middleware",
  "turns": [
    {
      "turnId": "turn-1",
      "state": "completed",
      "input": "Fix the CORS issue",
      "startedAt": "...",
      "completedAt": "...",
      "changedFiles": 3
    }
  ],
  "pendingApprovals": [],
  "pendingUserInputs": [],
  "resumeCursor": { "sessionId": "ses_..." },
  "worktreePath": "/home/fzowl/.t3/worktrees/..."
}
```

#### `t3.server.logs`
Recent server log entries, optionally filtered.

**Input:**
```json
{
  "lines": 50,
  "level": "warn" | "error" | "info" | "all",
  "pattern": "optional grep pattern"
}
```

**Output:**
```json
{
  "entries": [
    {
      "timestamp": "2026-08-07T14:00:00Z",
      "level": "WARN",
      "message": "Grok CLI health check failed.",
      "fields": { "errorTag": "Die" }
    }
  ],
  "truncated": false
}
```

#### `t3.server.diagnostics`
Process tree, resource usage, active sessions per provider.

**Input:** `{}`

**Output:**
```json
{
  "processes": [
    {
      "pid": 4169010,
      "command": "node apps/server/src/bin.ts serve",
      "rssBytes": 157286400,
      "cpuPercent": 2.3,
      "children": [
        {
          "pid": 4170000,
          "command": "claude --acp",
          "rssBytes": 89000000,
          "threadId": "0940cbd8-..."
        }
      ]
    }
  ],
  "providerSessions": {
    "claudeAgent": { "active": 1, "idle": 2 },
    "jcode": { "active": 0, "idle": 1 }
  }
}
```

#### `t3.migrations.status`
Database migration state — useful for post-rebase debugging.

**Input:** `{}`

**Output:**
```json
{
  "latestMigrationId": 39,
  "latestMigrationName": "ProjectGroup",
  "totalMigrations": 39,
  "pendingMigrations": [],
  "databasePath": "/home/fzowl/.t3/userdata/state.sqlite",
  "databaseSizeBytes": 120020992
}
```

### Write tools (orchestration:operate scope)

#### `t3.thread.interrupt`
Interrupt a running turn.

**Input:** `{ "threadId": "...", "turnId": "..." }`

#### `t3.thread.stop`
Stop a provider session for a thread.

**Input:** `{ "threadId": "..." }`

#### `t3.server.drain`
Enter drain mode — stop accepting new sessions, wait for active ones to finish.

**Input:** `{ "timeoutMs": 7200000 }`

#### `t3.providers.refresh`
Force refresh provider status (re-probe CLI versions, re-discover models).

**Input:** `{ "instanceId": "jcode" }` (optional, omit for all)

#### `t3.vcs.pruneWorktrees`
Run `git worktree prune` in a project directory.

**Input:** `{ "cwd": "/path/to/project" }`

#### `t3.vcs.deleteBranch`
Delete a git branch.

**Input:** `{ "cwd": "/path/to/project", "branch": "agent/issue-123", "force": true }`

## Resources (MCP resources, read-only)

### `t3://server/config`
Current ServerConfig (providers, settings, keybindings).

### `t3://threads/{threadId}/diff`
Full diff for a thread (all changed files across all turns).

### `t3://threads/{threadId}/messages`
Conversation messages for a thread.

## Implementation Plan

### Phase 1: Core read-only tools (MVP)
- `t3.server.health`
- `t3.providers.list`
- `t3.threads.list`
- `t3.server.logs`
- stdio bridge CLI (`t3-mcp-bridge`)
- Bearer auth from existing pairing system

**Effort:** ~2 days
**Files:**
- `apps/server/src/mcp/external/ExternalMcpServer.ts` — tool handlers
- `apps/server/src/mcp/external/ExternalMcpHttpEndpoint.ts` — SSE transport
- `packages/t3-mcp-bridge/src/main.ts` — stdio bridge CLI
- `packages/contracts/src/environmentHttp.ts` — new HTTP API group

### Phase 2: Thread detail + write tools
- `t3.thread.detail`
- `t3.thread.interrupt`
- `t3.thread.stop`
- `t3.server.drain`

**Effort:** ~1 day

### Phase 3: VCS + diagnostics + resources
- `t3.vcs.pruneWorktrees` / `t3.vcs.deleteBranch`
- `t3.server.diagnostics`
- `t3.migrations.status`
- MCP resources (`t3://server/config`, `t3://threads/*/diff`)

**Effort:** ~1 day

## Agent Configuration

### Claude Code `.mcp.json`
```json
{
  "mcpServers": {
    "t3-hermes": {
      "command": "t3-mcp-bridge",
      "args": ["--host", "hermes.local:3773", "--token-file", "~/.t3/tokens/hermes.token"]
    },
    "t3-local": {
      "command": "t3-mcp-bridge",
      "args": ["--host", "127.0.0.1:3773"]
    }
  }
}
```

### CC Runner integration
The cc_runner can use the MCP tools to:
1. Check thread status before relaunch (`t3.threads.list`)
2. Clean up stale worktrees/branches before session start (`t3.vcs.pruneWorktrees`, `t3.vcs.deleteBranch`)
3. Monitor session health during long runs (`t3.thread.detail`)
4. Drain server before maintenance (`t3.server.drain`)

## Security

- All tools require valid bearer token with appropriate scope
- Read-only tools: `orchestration:read` scope
- Write tools: `orchestration:operate` scope
- Token acquisition: existing pairing flow or long-lived API token (new)
- Rate limiting: inherit T3 server HTTP rate limits
- No credential/secret exposure in any tool output
