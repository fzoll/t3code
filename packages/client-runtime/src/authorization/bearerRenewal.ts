import * as Encoding from "effect/Encoding";
import * as Result from "effect/Result";
import * as Schema from "effect/Schema";

const claims = Schema.fromJsonString(
  Schema.Struct({
    v: Schema.Literal(1),
    kind: Schema.Literal("session"),
    method: Schema.Literal("bearer-access-token"),
    exp: Schema.Number,
  }),
);
const decode = Schema.decodeUnknownSync(claims);
const RENEWAL_WINDOW_MS = 7 * 24 * 60 * 60 * 1000;

// Unverified claims are only a scheduling hint. The server authenticates renewal.
// T3 session tokens encode milliseconds, unlike standard JWT NumericDate seconds.
export const bearerRenewalDelay = (token: string, now: number): number | undefined => {
  try {
    const parts = token.split(".");
    if (parts.length !== 2) return undefined;
    const payload = decode(Result.getOrThrow(Encoding.decodeBase64UrlString(parts[0]!)));
    if (!Number.isFinite(payload.exp)) return undefined;
    return Math.max(0, payload.exp - now - RENEWAL_WINDOW_MS);
  } catch {
    return undefined;
  }
};
