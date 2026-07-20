export type DbDialect = "sqlite" | "postgresql";

let _dialect: DbDialect = "sqlite";

export const setDbDialect = (d: DbDialect) => {
  _dialect = d;
};

export const getDbDialect = (): DbDialect => _dialect;
