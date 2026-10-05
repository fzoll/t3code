import { expect, it } from "@effect/vitest";
import { HostResourcesSnapshot } from "@t3tools/contracts";
import * as Schema from "effect/Schema";

import { ServerHealthResult } from "./tools.ts";

// Regression cover for the telemetry dedup: t3_server_health used to return the
// fork's bespoke `memory` block and per-thread `sessions`. It now returns the
// shared HostResourcesSnapshot (serverGetHostResources) that also backs load
// balancing, so get_node_health and chooseLoadBalancedEnvironment read the same
// numbers. Typecheck cannot catch the serialized-shape change; this does.
it("t3_server_health carries the shared host-resource snapshot, not bespoke memory/sessions", () => {
  const fields = ServerHealthResult.fields;
  expect(Object.keys(fields.hostResources.fields).toSorted()).toEqual(
    Object.keys(HostResourcesSnapshot.fields).toSorted(),
  );
  expect(fields).not.toHaveProperty("memory");
  expect(fields).not.toHaveProperty("sessions");
});

it("t3_server_health drops leftover memory/sessions keys on decode and keeps host resources", () => {
  const decoded = Schema.decodeUnknownSync(ServerHealthResult)({
    environmentId: "env-1",
    label: "node",
    version: "1.2.3",
    platform: { os: "linux", arch: "arm64" },
    uptimeSeconds: 42,
    hostResources: {
      sampledAt: 1_700_000_000_000,
      cpuUtilization: 0.25,
      cpuCount: 4,
      availableMemoryBytes: 1_000_000,
      totalMemoryBytes: 8_000_000,
    },
    // Legacy fork fields must not survive the round-trip.
    memory: { freeMemoryMb: 1 },
    sessions: [{ threadId: "t", pid: 1 }],
  });
  expect(decoded).not.toHaveProperty("memory");
  expect(decoded).not.toHaveProperty("sessions");
  expect(decoded.hostResources.availableMemoryBytes).toBe(1_000_000);
  expect(decoded.hostResources.sampledAt).toBe(1_700_000_000_000);
});
