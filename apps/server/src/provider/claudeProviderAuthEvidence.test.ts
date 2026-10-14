import { describe, expect, it } from "vite-plus/test";
import type { SDKResultMessage } from "@anthropic-ai/claude-agent-sdk";
import { claudeProviderAuthEvidence } from "./claudeProviderAuthEvidence.ts";

const base = {
  status: "failed" as const,
  result: undefined,
  errorMessage: "Please sign in",
  authenticationFailureMessage: "Please sign in",
  rateLimited: false,
  providerSessionId: "sdk-session",
};
describe("Claude authoritative authentication evidence", () => {
  it("does not infer auth from arbitrary text, bare 401 or transport failure", () => {
    for (const errorMessage of [
      "401 Unauthorized",
      "refresh token expired",
      "ECONNRESET",
      "Please sign in",
    ]) {
      expect(
        claudeProviderAuthEvidence({
          ...base,
          authenticationFailureMessage: undefined,
          errorMessage,
        }),
      ).toBeUndefined();
    }
  });
  it("does not let retained auth evidence override an explicit tool failure or cancellation", () => {
    expect(claudeProviderAuthEvidence({ ...base, errorMessage: "Tool EACCES" })).toBeUndefined();
    expect(claudeProviderAuthEvidence({ ...base, status: "cancelled" })).toBeUndefined();
    expect(claudeProviderAuthEvidence({ ...base, providerSessionId: undefined })).toBeUndefined();
  });
  it("separates quota evidence from login evidence", () => {
    expect(
      claudeProviderAuthEvidence({
        ...base,
        authenticationFailureMessage: undefined,
        rateLimited: true,
        errorMessage: "Claude usage limit reached. Send the message again once the limit resets.",
      })?.status,
    ).toBe("quota");
  });
  it("only clears with a successful SDK result, never a success-tagged error", () => {
    const result = { subtype: "success", is_error: false } as SDKResultMessage;
    expect(
      claudeProviderAuthEvidence({ ...base, status: "completed", result })?.evidenceSource,
    ).toBe("provider_success");
    expect(
      claudeProviderAuthEvidence({
        ...base,
        status: "completed",
        result: { ...result, is_error: true },
      }),
    ).toBeUndefined();
    expect(claudeProviderAuthEvidence({ ...base, status: "completed" })).toBeUndefined();
  });
});
