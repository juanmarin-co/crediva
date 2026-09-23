import type { DuckDBInstance } from "@duckdb/node-api";

export type Page = {
  path: string;
  rows: number;
  bytes: number;
  first_id: string;
  last_id: string;
  downloaded_at: string;
  reporting_dates: Record<string, number>;
};

export function timestamp(date: Date): string {
  return date.toISOString().replace(".000Z", "+00:00").replace("Z", "+00:00");
}

export async function inspectPage(
  path: string,
  db: Awaited<ReturnType<DuckDBInstance["connect"]>>,
): Promise<Pick<Page, "rows" | "first_id" | "last_id" | "reporting_dates"> | null> {
  const reader = await db.runAndReadAll(
    `WITH records AS (
      SELECT row_number() OVER () AS position, ":id" AS id,
        CAST(try_cast(fecha_corte AS TIMESTAMP) AS DATE) AS day
      FROM read_csv(?, header=true, all_varchar=true, compression='gzip')
    ), summary AS (
      SELECT count(*) AS rows, arg_min(id, position) AS first_id,
        arg_max(id, position) AS last_id,
        count(*) FILTER (WHERE id IS NULL OR id = '' OR day IS NULL) AS invalid
      FROM records
    ), reporting_dates AS (
      SELECT strftime(day, '%Y-%m-%d') AS day, count(*) AS rows
      FROM records WHERE day IS NOT NULL GROUP BY day
    )
    SELECT *, (SELECT coalesce(json_group_object(day, rows), '{}') FROM reporting_dates) AS dates
    FROM summary`,
    [path],
  );
  const result = reader.getRowObjectsJS()[0];
  if (!result || Number(result["invalid"]) > 0) {
    throw new Error("CSV page contains an empty :id or invalid fecha_corte");
  }

  if (!Number(result["rows"])) {
    return null;
  }

  const dates = JSON.parse(String(result["dates"])) as Record<string, number>;
  return {
    rows: Number(result["rows"]),
    first_id: String(result["first_id"]),
    last_id: String(result["last_id"]),
    reporting_dates: Object.fromEntries(
      Object.entries(dates).sort(([first], [second]) => first.localeCompare(second)),
    ),
  };
}
