import * as Schema from "effect/Schema";
import { describe, expect, it } from "@effect/vitest";
import { bearerRenewalDelay } from "./bearerRenewal.ts";

const encodeRenewalTestClaims = Schema.encodeSync(Schema.fromJsonString(Schema.Unknown));

const token = (method: string, exp: number) =>
  `${btoa(encodeRenewalTestClaims({ v: 1, kind: "session", method, exp }))}.signature`;
const day = 86400000;
describe("bearer renewal scheduling hints", () => {
  it("enters the renewal window before expiry and ignores other credential types", () => {
    expect(bearerRenewalDelay(token("bearer-access-token", 30 * day), 0)).toBe(23 * day);
    expect(bearerRenewalDelay(token("bearer-access-token", 30 * day), 24 * day)).toBe(0);
    expect(bearerRenewalDelay(token("bearer-access-token", 30 * day), 31 * day)).toBe(0);
    expect(bearerRenewalDelay(token("browser-session-cookie", 30 * day), 0)).toBeUndefined();
    expect(bearerRenewalDelay(token("dpop-access-token", 30 * day), 0)).toBeUndefined();
    expect(bearerRenewalDelay("opaque-credential", 0)).toBeUndefined();
    expect(bearerRenewalDelay("invalid.signature", 0)).toBeUndefined();
  });
});
