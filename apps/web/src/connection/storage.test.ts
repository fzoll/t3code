import {
  BearerConnectionCredential,
  ConnectionTransientError,
  PrimaryConnectionTarget,
} from "@t3tools/client-runtime/connection";
import { EnvironmentId } from "@t3tools/contracts";
import { ConnectionCatalogDocument } from "@t3tools/client-runtime/platform";
import { describe, expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Deferred from "effect/Deferred";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import * as Stream from "effect/Stream";
import { afterEach, vi } from "vite-plus/test";

import {
  makeBrowserGitHubRoutingPermissions,
  makeCatalogBackend,
  makeCatalogStore,
} from "./storage";

const emptyCatalog = {
  schemaVersion: 1,
  targets: [],
  profiles: [],
  credentials: [],
  remoteDpopTokens: [],
  disabledEnvironmentIds: [],
} as const;
const decodeCatalog = Schema.decodeUnknownSync(Schema.fromJsonString(ConnectionCatalogDocument));
const encodeCatalog = Schema.encodeSync(Schema.fromJsonString(ConnectionCatalogDocument));

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe("makeCatalogStore", () => {
  for (const replacement of ["repaired", null]) {
    it.effect(
      `rebases a stale renewal across independent stores after ${replacement ?? "deletion"}`,
      () =>
        Effect.gen(function* () {
          let raw = encodeCatalog({
            ...emptyCatalog,
            credentials: [
              {
                connectionId: "saved",
                credential: new BearerConnectionCredential({ token: "original" }),
              },
            ],
          });
          let interleave: Effect.Effect<void, ConnectionTransientError> = Effect.void;
          const backend = {
            read: Effect.sync(() => raw),
            write: (next: string) =>
              Effect.sync(() => {
                raw = next;
              }),
            compareAndSet: (expected: string | null, next: string) =>
              Effect.gen(function* () {
                const race = interleave;
                interleave = Effect.void;
                yield* race;
                if (raw !== expected) return false;
                raw = next;
                return true;
              }),
          };
          const first = yield* makeCatalogStore(backend);
          const second = yield* makeCatalogStore(backend);
          yield* first.read;
          yield* second.read;
          interleave = second.update((document) => ({
            ...document,
            credentials:
              replacement === null
                ? []
                : [
                    {
                      connectionId: "saved",
                      credential: new BearerConnectionCredential({ token: replacement }),
                    },
                  ],
            disabledEnvironmentIds: [EnvironmentId.make("disabled-by-other-window")],
          }));
          yield* first.update((document) => ({
            ...document,
            credentials: document.credentials.map((entry) =>
              entry.credential.token === "original"
                ? { ...entry, credential: new BearerConnectionCredential({ token: "renewed" }) }
                : entry,
            ),
          }));
          const final = yield* first.read;
          expect(final.credentials.map((entry) => entry.credential.token)).toEqual(
            replacement === null ? [] : [replacement],
          );
          expect(final.disabledEnvironmentIds).toEqual(["disabled-by-other-window"]);
          expect(yield* second.read).toEqual(final);
        }),
    );
  }

  it.effect("quarantines malformed catalogs and starts from an empty document", () =>
    Effect.gen(function* () {
      const writes: string[] = [];
      const quarantined: string[] = [];
      const store = yield* makeCatalogStore({
        read: Effect.succeed("{not-json"),
        write: (raw) => Effect.sync(() => writes.push(raw)),
        quarantine: (raw) => Effect.sync(() => quarantined.push(raw)),
      });

      expect(yield* store.read).toEqual(emptyCatalog);
      expect(quarantined).toEqual(["{not-json"]);
      expect(writes).toHaveLength(1);
      expect(decodeCatalog(writes[0]!)).toEqual(emptyCatalog);
    }),
  );

  it.effect("does not hide catalog read failures", () =>
    Effect.gen(function* () {
      const failure = new ConnectionTransientError({
        reason: "remote-unavailable",
        detail: "permission denied",
      });
      const store = yield* makeCatalogStore({
        read: Effect.fail(failure),
        write: () => Effect.void,
      });

      expect(yield* Effect.flip(store.read)).toBe(failure);
    }),
  );
});

describe("makeCatalogBackend", () => {
  it.effect("fails writes when desktop secure storage declines the catalog", () =>
    Effect.gen(function* () {
      const setConnectionCatalog = vi.fn().mockResolvedValue(false);
      vi.stubGlobal("window", {
        desktopBridge: {
          getConnectionCatalog: vi.fn().mockResolvedValue(null),
          setConnectionCatalog,
        },
      });
      const backend = makeCatalogBackend({} as IDBDatabase);
      expect(backend.compareAndSet).toBeUndefined();

      const error = yield* backend.write("{}").pipe(Effect.flip);

      expect(error).toBeInstanceOf(ConnectionTransientError);
      expect(error.message).toContain("Desktop secure storage is unavailable");
      expect(setConnectionCatalog).toHaveBeenCalledWith("{}");
    }),
  );
});

describe("browser GitHub routing permissions", () => {
  it.effect("revokes across runtimes before storage events and resists stale catalog writes", () =>
    Effect.gen(function* () {
      const values = new Map<string, string>();
      const localStorage: Storage = {
        get length() {
          return values.size;
        },
        key: (index) => [...values.keys()][index] ?? null,
        getItem: (key) => values.get(key) ?? null,
        setItem: (key, value) => {
          values.set(key, value);
        },
        removeItem: (key) => {
          values.delete(key);
        },
        clear: () => {
          values.clear();
        },
      };
      const firstBrowser = Object.assign(new EventTarget(), { localStorage });
      const secondBrowser = Object.assign(new EventTarget(), { localStorage });
      const first = makeBrowserGitHubRoutingPermissions(firstBrowser);
      const second = makeBrowserGitHubRoutingPermissions(secondBrowser);
      const entry = {
        target: new PrimaryConnectionTarget({
          environmentId: EnvironmentId.make("first"),
          label: "First",
          httpBaseUrl: "http://localhost:3000",
          wsBaseUrl: "ws://localhost:3000",
        }),
        profile: Option.none(),
        enabled: true,
      };
      const other = {
        ...entry,
        target: new PrimaryConnectionTarget({
          ...entry.target,
          environmentId: EnvironmentId.make("second"),
        }),
      };
      expect(yield* first.get(entry)).toBe("off");
      yield* first.set(entry, "read-write");
      expect(yield* second.get(entry)).toBe("read-write");
      const oldPermissions = Option.getOrThrow(yield* Stream.runHead(first.changes));
      const staleCatalog = yield* makeCatalogStore({
        read: Effect.succeed(
          encodeCatalog({ ...emptyCatalog, githubRoutingPermissions: oldPermissions }),
        ),
        write: () => Effect.void,
      });
      yield* staleCatalog.read;
      const listening = yield* Deferred.make<void>();
      const revoked = yield* Deferred.make<void>();
      yield* second.changes.pipe(
        Stream.runForEach((permissions) =>
          Deferred.succeed(permissions.length > 0 ? listening : revoked, undefined),
        ),
        Effect.forkChild,
      );
      yield* Deferred.await(listening);

      yield* first.set(entry, "off");
      expect(yield* second.get(entry)).toBe("off");
      secondBrowser.dispatchEvent(Object.assign(new Event("storage"), { key: null }));
      yield* Deferred.await(revoked);
      yield* second.set(other, "read");
      yield* staleCatalog.update((document) => ({ ...document, accountId: "updated" }));
      expect(yield* second.get(entry)).toBe("off");
      expect(yield* first.get(other)).toBe("read");
      expect(yield* makeBrowserGitHubRoutingPermissions(firstBrowser).get(entry)).toBe("off");

      yield* first.set(entry, "read-write");
      yield* second.forget(entry.target.environmentId);
      expect(yield* first.get(entry)).toBe("off");
      expect(yield* first.get(other)).toBe("read");
      vi.spyOn(localStorage, "setItem").mockImplementation(() => {
        throw new Error("Storage unavailable");
      });
      expect(yield* first.set(entry, "read-write").pipe(Effect.flip)).toBeInstanceOf(
        ConnectionTransientError,
      );
      expect(yield* second.get(entry)).toBe("off");
    }).pipe(Effect.scoped),
  );
});
