import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";

import { ServerConfig } from "../../config.ts";
import { makeSqlitePersistenceLive, SqlitePersistenceMemory } from "./Sqlite.ts";
import { makePostgresPersistenceLive } from "./Postgres.ts";

export const layerConfig = Layer.unwrap(
  Effect.map(Effect.service(ServerConfig), (config) => {
    if (config.databaseUrl) {
      return makePostgresPersistenceLive(config.databaseUrl);
    }
    return makeSqlitePersistenceLive(config.dbPath);
  }),
);

export const PersistenceMemory = SqlitePersistenceMemory;
