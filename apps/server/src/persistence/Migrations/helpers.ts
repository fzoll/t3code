import * as Effect from "effect/Effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";

import { getDbDialect, type DbDialect } from "../DbDialect.ts";

export const columnExists = Effect.fn("columnExists")(function* (
  tableName: string,
  columnName: string,
) {
  const sql = yield* SqlClient.SqlClient;
  const dialect = getDbDialect();

  if (dialect === "postgresql") {
    const rows = yield* sql<{ readonly column_name: string }>`
      SELECT column_name
      FROM information_schema.columns
      WHERE table_name = ${tableName}
        AND column_name = ${columnName}
    `;
    return rows.length > 0;
  }

  const columns = yield* sql<{ readonly name: string }>`
    PRAGMA table_info(${sql.literal(tableName)})
  `;
  return columns.some((column) => column.name === columnName);
});

export const getDialect = Effect.sync(getDbDialect);
