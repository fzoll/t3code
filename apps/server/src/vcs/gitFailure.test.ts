import { describe, it, expect } from "@effect/vitest";
import { classifyGitFailure } from "./gitFailure.ts";
describe("safe Git diagnostics", () => {
  it("distinguishes branch collision, stale registration and locks", () => {
    expect(
      classifyGitFailure("fatal: a branch named 'agent/issue-1' already exists").failureClass,
    ).toBe("branch_exists");
    expect(
      classifyGitFailure("fatal: '/tmp/work' is a missing but already registered worktree")
        .failureClass,
    ).toBe("worktree_in_use");
    expect(
      classifyGitFailure("fatal: Unable to create '/repo/.git/index.lock': File exists")
        .failureClass,
    ).toBe("git_lock_conflict");
  });
  it("never transports credentials or arbitrary helper output", () => {
    const raw =
      "fatal: Authentication failed for https://user:secret123@github.com/org/repo\nAuthorization: Bearer private-token";
    const result = classifyGitFailure(raw);
    expect(result.failureClass).toBe("auth_expired");
    expect(result.detail).not.toContain("secret123");
    expect(result.detail).not.toContain("private-token");
    expect(
      classifyGitFailure("credential helper unexpectedly printed private-token").detail,
    ).not.toContain("private-token");
  });
});
