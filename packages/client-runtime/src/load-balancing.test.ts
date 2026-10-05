import { describe, expect, it } from "@effect/vitest";

import { chooseLoadBalancedEnvironment } from "./load-balancing.ts";

const NOW = 1_700_000_000_000;

function snapshot(overrides?: {
  environmentId?: string;
  sampledAt?: number;
  cpuUtilization?: number | null;
  cpuCount?: number;
  availableMemoryBytes?: number;
  totalMemoryBytes?: number;
  weight?: number;
  receivedAt?: number;
}) {
  const sampledAt = overrides?.sampledAt ?? NOW;
  return {
    environmentId: overrides?.environmentId ?? "env",
    weight: overrides?.weight ?? 1,
    ...(overrides?.receivedAt === undefined ? {} : { receivedAt: overrides.receivedAt }),
    resources: {
      sampledAt,
      cpuUtilization: overrides?.cpuUtilization === undefined ? 0.1 : overrides.cpuUtilization,
      cpuCount: overrides?.cpuCount ?? 8,
      availableMemoryBytes: overrides?.availableMemoryBytes ?? 8 * 1024 * 1024 * 1024,
      totalMemoryBytes: overrides?.totalMemoryBytes ?? 16 * 1024 * 1024 * 1024,
    },
  };
}

describe("chooseLoadBalancedEnvironment", () => {
  it("picks the only healthy candidate", () => {
    expect(chooseLoadBalancedEnvironment([snapshot({ environmentId: "a" })], NOW)).toBe("a");
  });

  it("rejects a snapshot older than the 15s freshness window", () => {
    const stale = snapshot({ environmentId: "stale", sampledAt: NOW - 15_001 });
    expect(chooseLoadBalancedEnvironment([stale], NOW)).toBeNull();
    // One millisecond inside the window is still eligible.
    const fresh = snapshot({ environmentId: "fresh", sampledAt: NOW - 14_999 });
    expect(chooseLoadBalancedEnvironment([fresh], NOW)).toBe("fresh");
  });

  it("prefers client receivedAt over the snapshot's own clock for freshness", () => {
    // sampledAt is ancient, but the client received it just now: a skewed server
    // clock must not disqualify an otherwise-live node.
    const skewed = snapshot({
      environmentId: "skewed",
      sampledAt: NOW - 10 * 60_000,
      receivedAt: NOW - 1_000,
    });
    expect(chooseLoadBalancedEnvironment([skewed], NOW)).toBe("skewed");
  });

  it("rejects a node reporting zero total memory", () => {
    const zero = snapshot({ environmentId: "zero", totalMemoryBytes: 0 });
    expect(chooseLoadBalancedEnvironment([zero], NOW)).toBeNull();
  });

  it("rejects a node with almost no memory headroom", () => {
    const starved = snapshot({
      environmentId: "starved",
      totalMemoryBytes: 16 * 1024 * 1024 * 1024,
      availableMemoryBytes: 0.04 * 16 * 1024 * 1024 * 1024,
    });
    expect(chooseLoadBalancedEnvironment([starved], NOW)).toBeNull();
  });

  it("rejects a saturated or unknown CPU", () => {
    expect(
      chooseLoadBalancedEnvironment(
        [snapshot({ environmentId: "busy", cpuUtilization: 0.95 })],
        NOW,
      ),
    ).toBeNull();
    expect(
      chooseLoadBalancedEnvironment(
        [snapshot({ environmentId: "unknown", cpuUtilization: null })],
        NOW,
      ),
    ).toBeNull();
  });

  it("skips candidates missing a resource snapshot", () => {
    expect(
      chooseLoadBalancedEnvironment([{ environmentId: "a", resources: null, weight: 1 }], NOW),
    ).toBeNull();
  });

  it("scores by free CPU, cores, memory, and weight", () => {
    const small = snapshot({ environmentId: "small", cpuCount: 2, cpuUtilization: 0.5 });
    const big = snapshot({ environmentId: "big", cpuCount: 16, cpuUtilization: 0.1 });
    expect(chooseLoadBalancedEnvironment([small, big], NOW)).toBe("big");
  });
});
