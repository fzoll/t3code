import { useEffect, useRef } from "react";
import { useThreadShells } from "../state/entities";
import { isElectron } from "../env";

/**
 * Fires an OS notification when a thread transitions into a state that
 * needs user attention (pending approval or user-input request).
 * Only active inside Electron — browsers require explicit permission
 * and we don't want to prompt for it in the hosted web client.
 */
export function useDesktopNotifications(): void {
  const threads = useThreadShells();
  const prevAttentionIds = useRef(new Set<string>());

  useEffect(() => {
    if (!isElectron) return;

    const currentAttentionIds = new Set<string>();
    for (const thread of threads) {
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
  }, [threads]);
}
