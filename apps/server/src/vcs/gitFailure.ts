/** Stable, non-sensitive Git diagnostics safe for RPCs and persisted events.
 * Raw stderr can contain credentials in remote URLs or helper output. Never
 * return it. The diagnostic id links this classification to server-side logs.
 */
export function classifyGitFailure(stderr: string): { failureClass: string; detail: string } {
  const text = stderr.toLowerCase();
  if (
    /authentication failed|could not read username|permission denied \(publickey\)|bad credentials/.test(
      text,
    )
  )
    return {
      failureClass: "auth_expired",
      detail: "Git authentication was rejected; check the project credential.",
    };
  if (/unable to create.*\.lock|another git process|index\.lock.*exists|cannot lock ref/.test(text))
    return {
      failureClass: "git_lock_conflict",
      detail: "Another Git operation holds a repository lock.",
    };
  if (
    /already checked out|already used by worktree|already registered worktree|missing but already registered/.test(
      text,
    )
  )
    return {
      failureClass: "worktree_in_use",
      detail: "The requested branch or directory is already registered to a worktree.",
    };
  if (/a branch named .* already exists/.test(text))
    return { failureClass: "branch_exists", detail: "The requested branch already exists." };
  if (
    /not a valid object name|invalid reference|couldn't find remote ref|not our ref|unknown revision/.test(
      text,
    )
  )
    return {
      failureClass: "missing_ref",
      detail: "The requested Git commit or branch does not exist on the remote.",
    };
  if (/not a git repository|repository .* not found/.test(text))
    return { failureClass: "invalid_repo", detail: "The repository is missing or inaccessible." };
  if (
    /could not resolve host|connection timed out|connection reset|network is unreachable|failed to connect/.test(
      text,
    )
  )
    return {
      failureClass: "node_unavailable",
      detail: "Git could not reach the remote repository.",
    };
  if (/no space left on device|disk quota exceeded/.test(text))
    return {
      failureClass: "insufficient_capacity",
      detail: "The node has insufficient disk space.",
    };
  return {
    failureClass: "git_error",
    detail: "Git rejected the operation; see the diagnostic id in server logs.",
  };
}
