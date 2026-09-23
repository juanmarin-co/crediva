import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { gzipSync } from "node:zlib";
import { expect, test } from "vitest";
import { withDuckDB } from "./duckdb";
import { inspectPage } from "./raw";

async function inspect(csv: string) {
  const root = await mkdtemp(join(tmpdir(), "crediva-page-"));
  try {
    const path = join(root, "page.csv.gz");
    await writeFile(path, gzipSync(csv));
    return await withDuckDB((db) => inspectPage(path, db));
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}

test("a raw CSV page reports intrinsic ID boundaries and sorted reporting-date counts", async () => {
  expect(await inspect(":id,fecha_corte\nrow-1,2026-09-11\nrow-2,2026-09-04\n")).toEqual({
    rows: 2,
    first_id: "row-1",
    last_id: "row-2",
    reporting_dates: { "2026-09-04": 1, "2026-09-11": 1 },
  });
});

test("an empty CSV page is not checkpointed", async () => {
  expect(await inspect(":id,fecha_corte\n")).toBeNull();
});

test("invalid source dates and empty intrinsic IDs cannot be checkpointed", async () => {
  await expect(inspect(":id,fecha_corte\nrow-1,2026-09-04-not-a-date\n")).rejects.toThrow(
    /fecha_corte/,
  );
  await expect(inspect(":id,fecha_corte\n,2026-09-04\n")).rejects.toThrow(/:id/);
});
