import { DuckDBInstance } from "@duckdb/node-api";

export async function withDuckDB<T>(
  task: (connection: Awaited<ReturnType<DuckDBInstance["connect"]>>) => Promise<T>,
): Promise<T> {
  const instance = await DuckDBInstance.create(":memory:");
  const connection = await instance.connect();
  try {
    return await task(connection);
  } finally {
    connection.closeSync();
  }
}
