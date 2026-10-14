import type { SDKResultMessage } from "@anthropic-ai/claude-agent-sdk";
import type { ProviderAuthEvidence, ProviderRuntimeTurnStatus } from "@t3tools/contracts";

/** Only SDK-owned evidence may change provider readiness. Never classify chat/tool text. */
export function claudeProviderAuthEvidence(input: {
  status: ProviderRuntimeTurnStatus;
  result: SDKResultMessage | undefined;
  errorMessage: string | undefined;
  authenticationFailureMessage: string | undefined;
  rateLimited: boolean;
  providerSessionId: string | undefined;
}): ProviderAuthEvidence | undefined {
  const providerSessionId = input.providerSessionId;
  if (!providerSessionId) return undefined;
  if (
    input.status === "completed" &&
    input.result?.subtype === "success" &&
    !input.result.is_error
  ) {
    return {
      status: "ready",
      reasonCode: "provider_authenticated",
      evidenceSource: "provider_success",
      providerSessionId,
    };
  }
  if (input.status !== "failed") return undefined;
  // resultOutcome preserves explicit terminal causes over the retained auth hint.
  // An earlier authentication failure must not relabel a tool error or cancellation.
  if (
    input.authenticationFailureMessage &&
    input.errorMessage === input.authenticationFailureMessage
  ) {
    return {
      status: "auth_required",
      reasonCode: "provider_login_required",
      evidenceSource: "provider_error",
      providerSessionId,
    };
  }
  if (
    input.rateLimited &&
    input.errorMessage ===
      "Claude usage limit reached. Send the message again once the limit resets."
  ) {
    return {
      status: "quota",
      reasonCode: "provider_rate_limited",
      evidenceSource: "provider_error",
      providerSessionId,
    };
  }
  return undefined;
}
