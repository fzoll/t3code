// @effect-diagnostics nodeBuiltinImport:off - posix path joining for remote node paths.
import type { HostResourcesSnapshot } from "@t3tools/contracts";
import { chooseLoadBalancedEnvironment } from "@t3tools/client-runtime/load-balancing";
import * as NodePath from "node:path";

import { WORKSPACE_NAME, type RouterConfig, type RouterNode } from "./routerConfig.ts";

/** What the router learns from a node's `/.well-known/t3/environment`. */
export interface NodeObservation {
  readonly environmentId: string;
  readonly hostResources: HostResourcesSnapshot | null;
  readonly receivedAt: number;
}

export type ObserveNode = (node: RouterNode) => Promise<NodeObservation>;

export interface PlacementRequest {
  readonly workspace: string;
  /** A dedicated node from the request always wins over load balancing. */
  readonly node?: string;
}

export interface Placement {
  readonly nodeId: string;
  readonly environmentId: string;
  readonly workspaceRoot: string;
  readonly reason: "requested" | "load_balanced";
}

export class PlacementError extends Error {
  override readonly name = "PlacementError";
  readonly code: string;
  readonly status: number;
  constructor(code: string, status: number) {
    super(code);
    this.code = code;
    this.status = status;
  }
}

const hosts = (node: RouterNode, workspace: string) =>
  !node.workspaces || node.workspaces.includes(workspace);

const placementFor = (
  node: RouterNode,
  observation: NodeObservation,
  workspace: string,
  reason: Placement["reason"],
): Placement => ({
  nodeId: node.id,
  environmentId: observation.environmentId,
  workspaceRoot: NodePath.posix.join(node.workspaceBase, workspace),
  reason,
});

export const parsePlacementRequest = (value: unknown): PlacementRequest => {
  if (typeof value !== "object" || value === null) throw new PlacementError("invalid_request", 400);
  const { workspace, node } = value as Record<string, unknown>;
  if (
    typeof workspace !== "string" ||
    !WORKSPACE_NAME.test(workspace) ||
    workspace.includes("..")
  ) {
    throw new PlacementError("invalid_workspace", 400);
  }
  if (node !== undefined && node !== null && (typeof node !== "string" || node === "")) {
    throw new PlacementError("invalid_node", 400);
  }
  return typeof node === "string" ? { workspace, node } : { workspace };
};

export const place = async (
  config: RouterConfig,
  request: PlacementRequest,
  observe: ObserveNode,
  now: () => number = Date.now,
): Promise<Placement> => {
  if (request.node !== undefined) {
    const node = config.nodes.find((candidate) => candidate.id === request.node);
    if (!node) throw new PlacementError("unknown_node", 404);
    if (!node.enabled) throw new PlacementError("node_disabled", 409);
    if (!hosts(node, request.workspace)) throw new PlacementError("workspace_not_on_node", 409);
    let observation: NodeObservation;
    try {
      observation = await observe(node);
    } catch {
      throw new PlacementError("node_unreachable", 503);
    }
    return placementFor(node, observation, request.workspace, "requested");
  }

  const candidates = config.nodes.filter(
    (node) => node.enabled && node.weight > 0 && hosts(node, request.workspace),
  );
  if (candidates.length === 0) throw new PlacementError("workspace_not_hosted", 409);
  const observed = await Promise.all(
    candidates.map(async (node) => {
      try {
        return { node, observation: await observe(node) };
      } catch {
        return null;
      }
    }),
  );
  const live = observed.filter((entry) => entry !== null);
  const chosen = chooseLoadBalancedEnvironment(
    live.map(({ node, observation }) => ({
      environmentId: observation.environmentId,
      resources: observation.hostResources,
      receivedAt: observation.receivedAt,
      weight: node.weight,
    })),
    now(),
  );
  const winner = live.find(({ observation }) => observation.environmentId === chosen);
  if (!winner) throw new PlacementError("no_eligible_node", 503);
  return placementFor(winner.node, winner.observation, request.workspace, "load_balanced");
};
