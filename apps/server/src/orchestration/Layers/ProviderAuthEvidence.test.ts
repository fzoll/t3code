import { expect, it } from "vite-plus/test";
import {
  EventId,
  ProviderDriverKind,
  ThreadId,
  TurnId,
  type ProviderRuntimeEvent,
} from "@t3tools/contracts";
import { runtimeEventToActivities } from "./ProviderRuntimeIngestion.ts";

it("projects only normalized evidence with original event, turn and timestamp binding", () => {
  const event: ProviderRuntimeEvent = {
    type: "turn.completed",
    eventId: EventId.make("event-auth"),
    provider: ProviderDriverKind.make("claudeAgent"),
    createdAt: "2026-10-05T20:00:00.000Z",
    threadId: ThreadId.make("thread-auth"),
    turnId: TurnId.make("turn-auth"),
    payload: {
      state: "failed",
      errorMessage: "secret sentinel must not cross auth projection",
      providerAuthEvidence: {
        status: "auth_required",
        reasonCode: "provider_login_required",
        evidenceSource: "provider_error",
        providerSessionId: "session-auth",
      },
    },
  };
  const [activity] = runtimeEventToActivities(event);
  expect(activity?.id).toBe(event.eventId);
  expect(activity?.createdAt).toBe(event.createdAt);
  expect(activity?.turnId).toBe(event.turnId);
  expect(activity?.kind).toBe("provider.auth");
  expect(activity?.payload).toEqual({
    provider: "claudeAgent",
    status: "auth_required",
    reasonCode: "provider_login_required",
    evidenceSource: "provider_error",
    providerSessionId: "session-auth",
  });
  expect(JSON.stringify(activity)).not.toContain("secret sentinel");
  expect(runtimeEventToActivities({ ...event, turnId: undefined })).toEqual([]);
  expect(runtimeEventToActivities({ ...event, payload: { state: "failed" } })).toEqual([]);
});
