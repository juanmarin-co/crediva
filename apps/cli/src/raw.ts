import { mkdir, open, rename, rm, stat } from "node:fs/promises";
import { dirname, join } from "node:path";
import { withDuckDB } from "./duckdb";

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

export class RawPages {
  constructor(
    readonly root: string,
    readonly clock: () => Date,
  ) {}

  async complete(page: Page): Promise<boolean> {
    try {
      return (await stat(join(this.root, page.path))).size === page.bytes;
    } catch {
      return false;
    }
  }
  async write(
    source: "historical" | "recent",
    number: number,
    chunks: AsyncIterable<Uint8Array>,
  ): Promise<Page | null> {
    let directory = "historical/pages";
    if (source === "recent") {
      directory = "recent/next";
    }

    const relative = `${directory}/page-${String(number).padStart(8, "0")}.csv.gz`;
    const target = join(this.root, relative);
    const partial = target + ".partial";
    await mkdir(dirname(target), { recursive: true });

    const file = await open(partial, "w");
    try {
      for await (const chunk of chunks) {
        await file.writeFile(chunk);
      }

      await file.close();
      const result = await withDuckDB(async (db) => {
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
          [partial],
        );

        return reader.getRowObjectsJS()[0];
      });
      if (!result || Number(result["invalid"]) > 0) {
        throw new Error("CSV page contains an empty :id or invalid fecha_corte");
      }

      if (!Number(result["rows"])) {
        await rm(partial);

        return null;
      }

      const dates = JSON.parse(String(result["dates"])) as Record<string, number>;
      const reportingDates = Object.fromEntries(
        Object.entries(dates).sort(([first], [second]) => first.localeCompare(second)),
      );
      const bytes = (await stat(partial)).size;
      await rename(partial, target);

      return {
        path: relative,
        rows: Number(result["rows"]),
        bytes,
        first_id: String(result["first_id"]),
        last_id: String(result["last_id"]),
        downloaded_at: timestamp(this.clock()),
        reporting_dates: reportingDates,
      };
    } catch (error) {
      await file.close().catch(() => {});
      await rm(partial, { force: true });

      throw error;
    }
  }

  async discardNext(): Promise<void> {
    await rm(join(this.root, "recent/next"), { recursive: true, force: true });
  }

  async activate(pages: Page[]): Promise<Page[]> {
    const recent = join(this.root, "recent");
    await rm(join(recent, "previous"), { recursive: true, force: true });
    try {
      await rename(join(recent, "current"), join(recent, "previous"));
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") {
        throw error;
      }
    }

    await rename(join(recent, "next"), join(recent, "current"));

    return pages.map((p) => ({ ...p, path: p.path.replace("recent/next/", "recent/current/") }));
  }

  async discardPrevious(): Promise<void> {
    await rm(join(this.root, "recent/previous"), { recursive: true, force: true });
  }
}
