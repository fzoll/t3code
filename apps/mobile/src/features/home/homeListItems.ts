import type { EnvironmentThreadShell } from "@t3tools/client-runtime/state/shell";

import type { PendingNewTask } from "../../state/use-pending-new-tasks";
import type { HomeThreadGroup } from "./homeThreadList";

/** Threads shown per project before the "Show more" affordance appears. */
export const HOME_INITIAL_VISIBLE_THREADS = 6;
/** Additional threads revealed per "Show more" tap. */
export const HOME_SHOW_MORE_STEP = 10;

export interface HomeGroupDisplayState {
  readonly collapsed: boolean;
  /** How many threads are currently revealed (clamped to the group size). */
  readonly visibleCount: number;
}

export const DEFAULT_GROUP_DISPLAY_STATE: HomeGroupDisplayState = {
  collapsed: false,
  visibleCount: HOME_INITIAL_VISIBLE_THREADS,
};

export interface HomeHeaderListItem {
  readonly type: "header";
  readonly key: string;
  readonly group: HomeThreadGroup;
  readonly collapsed: boolean;
  readonly isFirst: boolean;
}

export interface HomeThreadListItem {
  readonly type: "thread";
  readonly key: string;
  readonly thread: EnvironmentThreadShell;
  readonly isLast: boolean;
}

export interface HomePendingTaskListItem {
  readonly type: "pending-task";
  readonly key: string;
  readonly pendingTask: PendingNewTask;
  readonly isLast: boolean;
}

export interface HomeShowMoreListItem {
  readonly type: "show-more";
  readonly key: string;
  readonly groupKey: string;
  /** Threads still hidden. 0 means the group is fully expanded. */
  readonly hiddenCount: number;
  /** Whether more than the initial count is revealed, so "Show less" applies. */
  readonly canShowLess: boolean;
}

export interface HomeSectionHeaderListItem {
  readonly type: "section-header";
  readonly key: string;
  readonly label: string;
  readonly depth: number;
  readonly path: string;
  readonly collapsed: boolean;
  readonly projectCount: number;
}

export type HomeListItem =
  | HomeHeaderListItem
  | HomePendingTaskListItem
  | HomeThreadListItem
  | HomeShowMoreListItem
  | HomeSectionHeaderListItem;

export interface HomeListLayout {
  readonly items: ReadonlyArray<HomeListItem>;
  readonly stickyHeaderIndices: ReadonlyArray<number>;
}

export type HomeGroupDisplayAction = "toggle-collapsed" | "show-more" | "show-less";

export function nextGroupDisplayState(
  current: HomeGroupDisplayState,
  action: HomeGroupDisplayAction,
): HomeGroupDisplayState {
  switch (action) {
    case "toggle-collapsed":
      return { ...current, collapsed: !current.collapsed };
    case "show-more":
      return { ...current, visibleCount: current.visibleCount + HOME_SHOW_MORE_STEP };
    case "show-less":
      return { ...current, visibleCount: HOME_INITIAL_VISIBLE_THREADS };
  }
}

/**
 * Structural equality for list items. Item objects are rebuilt on every
 * collapse/show-more toggle; without this the lists would consider every
 * mounted row changed and re-render all of them (each carrying a swipeable +
 * a vcs-status subscription). Group/thread references are stable across
 * toggles.
 */
export function homeListItemsAreEqual(previous: HomeListItem, item: HomeListItem): boolean {
  switch (item.type) {
    case "header":
      return (
        previous.type === "header" &&
        previous.group === item.group &&
        previous.collapsed === item.collapsed &&
        previous.isFirst === item.isFirst
      );
    case "pending-task":
      return (
        previous.type === "pending-task" &&
        previous.pendingTask === item.pendingTask &&
        previous.isLast === item.isLast
      );
    case "thread":
      return (
        previous.type === "thread" &&
        previous.thread === item.thread &&
        previous.isLast === item.isLast
      );
    case "show-more":
      return (
        previous.type === "show-more" &&
        previous.groupKey === item.groupKey &&
        previous.hiddenCount === item.hiddenCount &&
        previous.canShowLess === item.canShowLess
      );
    case "section-header":
      return (
        previous.type === "section-header" &&
        previous.path === item.path &&
        previous.collapsed === item.collapsed &&
        previous.projectCount === item.projectCount
      );
  }
}

interface GroupTreeNode {
  readonly children: Map<string, GroupTreeNode>;
  readonly groups: HomeThreadGroup[];
}

function countGroupTreeProjects(node: GroupTreeNode): number {
  let count = node.groups.length;
  for (const child of node.children.values()) {
    count += countGroupTreeProjects(child);
  }
  return count;
}

function buildGroupTree(groups: ReadonlyArray<HomeThreadGroup>): GroupTreeNode {
  const root: GroupTreeNode = { children: new Map(), groups: [] };
  for (const group of groups) {
    const groupPath = group.representative.group ?? "";
    if (!groupPath) {
      root.groups.push(group);
      continue;
    }
    const segments = groupPath.split("/").filter(Boolean);
    let node = root;
    for (const segment of segments) {
      if (!node.children.has(segment)) {
        (node.children as Map<string, GroupTreeNode>).set(segment, {
          children: new Map(),
          groups: [],
        });
      }
      node = node.children.get(segment)!;
    }
    node.groups.push(group);
  }
  return root;
}

function appendGroupItems(
  items: HomeListItem[],
  stickyHeaderIndices: number[],
  group: HomeThreadGroup,
  groupIndex: number,
  displayStates: ReadonlyMap<string, HomeGroupDisplayState>,
  showAllThreads: boolean,
): void {
  const display = displayStates.get(group.key) ?? DEFAULT_GROUP_DISPLAY_STATE;
  const collapsed = display.collapsed && !showAllThreads;

  stickyHeaderIndices.push(items.length);
  items.push({
    type: "header",
    key: `header:${group.key}`,
    group,
    collapsed,
    isFirst: groupIndex === 0 && items.length === 0,
  });

  if (collapsed) return;

  const totalCount = group.threads.length;
  const baselineCount = Math.min(
    group.recentThreads.length,
    HOME_INITIAL_VISIBLE_THREADS,
    totalCount,
  );
  const visibleCount = showAllThreads
    ? totalCount
    : Math.min(
        display.visibleCount > HOME_INITIAL_VISIBLE_THREADS ? display.visibleCount : baselineCount,
        totalCount,
      );
  const visibleThreads = group.threads.slice(0, visibleCount);
  const hiddenCount = totalCount - visibleCount;
  const hasShowMoreRow = !showAllThreads && totalCount > baselineCount;

  for (const [pendingIndex, pendingTask] of group.pendingTasks.entries()) {
    items.push({
      type: "pending-task",
      key: `pending-task:${pendingTask.message.messageId}`,
      pendingTask,
      isLast:
        pendingIndex === group.pendingTasks.length - 1 &&
        visibleThreads.length === 0 &&
        !hasShowMoreRow,
    });
  }

  for (const [threadIndex, thread] of visibleThreads.entries()) {
    items.push({
      type: "thread",
      key: `thread:${thread.environmentId}:${thread.id}`,
      thread,
      isLast: threadIndex === visibleThreads.length - 1 && !hasShowMoreRow,
    });
  }

  if (hasShowMoreRow) {
    items.push({
      type: "show-more",
      key: `show-more:${group.key}`,
      groupKey: group.key,
      hiddenCount,
      canShowLess: visibleCount > baselineCount,
    });
  }
}

function appendTreeNode(
  items: HomeListItem[],
  stickyHeaderIndices: number[],
  name: string,
  node: GroupTreeNode,
  parentPath: string,
  depth: number,
  displayStates: ReadonlyMap<string, HomeGroupDisplayState>,
  sectionCollapsed: ReadonlySet<string>,
  showAllThreads: boolean,
): void {
  const fullPath = parentPath ? `${parentPath}/${name}` : name;
  const collapsed = sectionCollapsed.has(fullPath);
  const projectCount = countGroupTreeProjects(node);

  stickyHeaderIndices.push(items.length);
  items.push({
    type: "section-header",
    key: `section:${fullPath}`,
    label: name,
    depth,
    path: fullPath,
    collapsed,
    projectCount,
  });

  if (collapsed) return;

  const sortedChildren = [...node.children.entries()].sort((a, b) => a[0].localeCompare(b[0]));
  for (const [childName, childNode] of sortedChildren) {
    appendTreeNode(
      items,
      stickyHeaderIndices,
      childName,
      childNode,
      fullPath,
      depth + 1,
      displayStates,
      sectionCollapsed,
      showAllThreads,
    );
  }
  for (const [groupIndex, group] of node.groups.entries()) {
    appendGroupItems(items, stickyHeaderIndices, group, groupIndex, displayStates, showAllThreads);
  }
}

export function buildHomeListLayout(input: {
  readonly groups: ReadonlyArray<HomeThreadGroup>;
  readonly displayStates: ReadonlyMap<string, HomeGroupDisplayState>;
  readonly collapsedSections?: ReadonlySet<string>;
  /**
   * When searching, pagination is suspended so every match stays visible.
   */
  readonly showAllThreads?: boolean;
}): HomeListLayout {
  const items: HomeListItem[] = [];
  const stickyHeaderIndices: number[] = [];
  const sectionCollapsed = input.collapsedSections ?? new Set<string>();
  const showAllThreads = input.showAllThreads === true;

  const tree = buildGroupTree(input.groups);

  const sortedRootChildren = [...tree.children.entries()].sort((a, b) => a[0].localeCompare(b[0]));
  for (const [name, node] of sortedRootChildren) {
    appendTreeNode(
      items,
      stickyHeaderIndices,
      name,
      node,
      "",
      0,
      input.displayStates,
      sectionCollapsed,
      showAllThreads,
    );
  }
  for (const [groupIndex, group] of tree.groups.entries()) {
    appendGroupItems(
      items,
      stickyHeaderIndices,
      group,
      groupIndex,
      input.displayStates,
      showAllThreads,
    );
  }

  return { items, stickyHeaderIndices };
}
