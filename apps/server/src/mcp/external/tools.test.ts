import { expect, it } from "@effect/vitest";
import * as Context from "effect/Context";
import { Tool } from "effect/unstable/ai";

import { ExternalToolkit } from "./tools.ts";

const READ_TOOLS = [
  "t3_server_health",
  "t3_providers_list",
  "t3_threads_list",
  "t3_thread_detail",
  "t3_server_logs",
  "t3_server_diagnostics",
  "t3_migrations_status",
];

const OPERATE_TOOLS = ["t3_thread_interrupt", "t3_thread_stop", "t3_providers_refresh"];

it("exposes the full diagnostic tool set", () => {
  const names = Object.values(ExternalToolkit.tools).map((tool) => tool.name);
  expect(names.toSorted()).toEqual([...READ_TOOLS, ...OPERATE_TOOLS].toSorted());
});

it("exports provider-compatible object schemas with useful descriptions", () => {
  for (const tool of Object.values(ExternalToolkit.tools)) {
    const schema = Tool.getJsonSchema(tool) as {
      readonly type?: unknown;
      readonly anyOf?: unknown;
      readonly oneOf?: unknown;
    };
    expect(
      tool.description?.length ?? 0,
      `${tool.name} should have a useful description`,
    ).toBeGreaterThan(40);
    expect(schema.type ?? "object", `${tool.name} must export a top-level object schema`).toBe(
      "object",
    );
    expect(schema.anyOf, `${tool.name} must not export a root anyOf`).toBeUndefined();
    expect(schema.oneOf, `${tool.name} must not export a root oneOf`).toBeUndefined();
  }
});

it("marks read tools readonly and operate tools non-readonly", () => {
  for (const tool of Object.values(ExternalToolkit.tools)) {
    const readonly = Context.get(tool.annotations, Tool.Readonly);
    if (READ_TOOLS.includes(tool.name)) {
      expect(readonly, `${tool.name} must be readonly`).toBe(true);
    } else {
      expect(readonly, `${tool.name} must not be readonly`).toBe(false);
    }
  }
});
