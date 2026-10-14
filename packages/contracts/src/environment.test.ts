import * as Schema from "effect/Schema";
import { describe, expect, it } from "vite-plus/test";

import { ExecutionEnvironmentDescriptor } from "./environment.ts";

const decodeDescriptor = Schema.decodeUnknownSync(ExecutionEnvironmentDescriptor);

const descriptor = {
  environmentId: "environment-1",
  label: "Local",
  platform: { os: "darwin", arch: "arm64" },
  serverVersion: "0.0.32",
  capabilities: { repositoryIdentity: true },
} as const;

describe("ExecutionEnvironmentDescriptor", () => {
  it("decodes old, recognized and future manual installation descriptors", () => {
    expect(decodeDescriptor(descriptor).capabilities.serverInstallation).toBeUndefined();
    for (const installation of [{ kind: "npx" }, { kind: "npm-global", prefix: "/opt/node" }]) {
      expect(
        decodeDescriptor({
          ...descriptor,
          capabilities: { ...descriptor.capabilities, serverInstallation: installation },
        }).capabilities.serverInstallation,
      ).toEqual(installation);
    }
    for (const installation of [{ kind: "future-manager" }, { kind: "npm-global" }]) {
      expect(
        decodeDescriptor({
          ...descriptor,
          capabilities: { ...descriptor.capabilities, serverInstallation: installation },
        }).capabilities.serverInstallation,
      ).toBeUndefined();
    }
  });
  it("requires an advertised required-worktree bootstrap capability", () => {
    expect(decodeDescriptor(descriptor).capabilities.requiredWorktreeBootstrap).toBeUndefined();
    expect(
      decodeDescriptor({
        ...descriptor,
        capabilities: { ...descriptor.capabilities, requiredWorktreeBootstrap: true },
      }).capabilities.requiredWorktreeBootstrap,
    ).toBe(true);
  });

  it("treats a missing pull-request capability as unsupported under version skew", () => {
    expect(decodeDescriptor(descriptor).capabilities.pullRequests).toBeUndefined();
  });

  it("preserves an advertised pull-request capability", () => {
    expect(
      decodeDescriptor({
        ...descriptor,
        capabilities: { ...descriptor.capabilities, pullRequests: true },
      }).capabilities.pullRequests,
    ).toBe(true);
  });

  it("treats a missing attachment upload capability as unsupported", () => {
    expect(decodeDescriptor(descriptor).capabilities.attachmentUploads).toBeUndefined();
  });

  it("preserves an advertised attachment upload capability", () => {
    expect(
      decodeDescriptor({
        ...descriptor,
        capabilities: { ...descriptor.capabilities, attachmentUploads: true },
      }).capabilities.attachmentUploads,
    ).toBe(true);
  });

  it("preserves the server's generic attachment upload limit", () => {
    expect(
      decodeDescriptor({
        ...descriptor,
        capabilities: {
          ...descriptor.capabilities,
          fileAttachments: { maxUploadBytes: 50 * 1024 * 1024 },
        },
      }).capabilities.fileAttachments,
    ).toEqual({ maxUploadBytes: 50 * 1024 * 1024 });
  });

  it("treats missing server-resolved command context as unsupported", () => {
    expect(decodeDescriptor(descriptor).capabilities.serverResolvedCommandContext).toBeUndefined();
  });

  it("preserves advertised server-resolved command context", () => {
    expect(
      decodeDescriptor({
        ...descriptor,
        capabilities: {
          ...descriptor.capabilities,
          serverResolvedCommandContext: true,
        },
      }).capabilities.serverResolvedCommandContext,
    ).toBe(true);
  });
});

describe("environment host-resource snapshots", () => {
  const resources = { freeMemoryMb: 1024, totalMemoryMb: 2048, sessions: [] };
  const hostResources = {
    sampledAt: 1_700_000_000_000,
    cpuUtilization: 0.25,
    cpuCount: 8,
    availableMemoryBytes: 1024 * 1024 * 1024,
    totalMemoryBytes: 2048 * 1024 * 1024,
  };

  it("preserves the canonical snapshot through descriptor decoding", () => {
    expect(
      decodeDescriptor({ ...descriptor, resources: { ...resources, hostResources } }).resources
        ?.hostResources,
    ).toEqual(hostResources);
  });

  it("continues accepting older nodes without a snapshot", () => {
    expect(decodeDescriptor({ ...descriptor, resources }).resources?.hostResources).toBeUndefined();
  });

  it("rejects malformed advertised snapshots instead of treating them as capacity", () => {
    expect(() =>
      decodeDescriptor({
        ...descriptor,
        resources: { ...resources, hostResources: { ...hostResources, sampledAt: -1 } },
      }),
    ).toThrow();
  });
});
