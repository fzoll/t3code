import { useEffect, useMemo, useRef } from "react";
import { useProjects, useThreadShells } from "../state/entities";
import { isElectron } from "../env";

/**
 * Fires an OS notification when a thread transitions into a state that
 * needs user attention (pending approval or user-input request).
 * Only active inside Electron — browsers require explicit permission
 * and we don't want to prompt for it in the hosted web client.
 *
 * Projects flagged as automated are skipped: an unattended cc_runner
 * session asking for approval is the normal course of business there, not
 * something to interrupt the user for.
 */
export function useDesktopNotifications(): void {
  const threads = useThreadShells();
  const projects = useProjects();
  const prevAttentionIds = useRef(new Set<string>());

  const autoProjectKeys = useMemo(
    () =>
      new Set(
        projects
          .filter((project) => project.isAuto === true)
          .map((project) => `${project.environmentId}:${project.id}`),
      ),
    [projects],
  );

  useEffect(() => {
    if (!isElectron) return;

    const currentAttentionIds = new Set<string>();
    for (const thread of threads) {
      if (autoProjectKeys.has(`${thread.environmentId}:${thread.projectId}`)) continue;
      if (thread.hasPendingApprovals || thread.hasPendingUserInput) {
        currentAttentionIds.add(thread.id);
      }
    }

    for (const thread of threads) {
      if (!currentAttentionIds.has(thread.id)) continue;
      if (prevAttentionIds.current.has(thread.id)) continue;

      const title = thread.hasPendingApprovals ? "Approval needed" : "Waiting for input";
      const body = thread.title || "A thread needs your attention";

      new Notification(title, { body });
    }

    prevAttentionIds.current = currentAttentionIds;
  }, [autoProjectKeys, threads]);
}
