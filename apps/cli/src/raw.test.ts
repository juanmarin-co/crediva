import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { gzipSync } from "node:zlib";
import { afterEach, expect, test } from "vitest";
import { RawPages } from "./raw";

const directories: string[] = [];
const clock = () => new Date("2026-09-21T00:00:00Z");

afterEach(async () => {
  for (const path of directories.splice(0)) {
    await rm(path, { recursive: true, force: true });
  }
});

test("a downloaded page retains its gzip bytes and reports IDs and reporting-date counts", async () => {
  const root = await mkdtemp(join(tmpdir(), "rates-"));
  directories.push(root);

  const csv =
    ':id,fecha_corte,value\nrow-1,2026-09-04T00:00:00.000,"with, comma"\nrow-2,2026-09-11T00:00:00.000,2\n';
  const compressed = gzipSync(csv);
  const pages = new RawPages(root, clock);
  const page = await pages.write(
    "historical",
    1,
    (async function* () {
      yield compressed;
    })(),
  );
  expect(page).toEqual({
    path: "historical/pages/page-00000001.csv.gz",
    rows: 2,
    bytes: compressed.length,
    first_id: "row-1",
    last_id: "row-2",
    downloaded_at: "2026-09-21T00:00:00+00:00",
    reporting_dates: { "2026-09-04": 1, "2026-09-11": 1 },
  });
  expect(await readFile(join(root, page!.path))).toEqual(compressed);
});

test("reporting dates are indexed in ascending order regardless of row order", async () => {
  const root = await mkdtemp(join(tmpdir(), "rates-"));
  directories.push(root);
  const pages = new RawPages(root, clock);

  const page = await pages.write(
    "historical",
    1,
    (async function* () {
      yield gzipSync(":id,fecha_corte\nrow-1,2026-09-11\nrow-2,2026-09-04\n");
    })(),
  );

  expect(Object.keys(page!.reporting_dates)).toEqual(["2026-09-04", "2026-09-11"]);
});

test("an empty response does not create a page", async () => {
  const root = await mkdtemp(join(tmpdir(), "rates-"));
  directories.push(root);
  const pages = new RawPages(root, clock);

  const page = await pages.write(
    "historical",
    1,
    (async function* () {
      yield gzipSync(":id,fecha_corte\n");
    })(),
  );

  expect(page).toBeNull();
  await expect(readFile(join(root, "historical/pages/page-00000001.csv.gz"))).rejects.toMatchObject(
    { code: "ENOENT" },
  );
});

test("a malformed fecha_corte cannot be indexed by its valid prefix", async () => {
  const root = await mkdtemp(join(tmpdir(), "rates-"));
  directories.push(root);
  const pages = new RawPages(root, clock);

  await expect(
    pages.write(
      "historical",
      1,
      (async function* () {
        yield gzipSync(":id,fecha_corte\nrow-1,2026-09-04-not-a-date\n");
      })(),
    ),
  ).rejects.toThrow(/fecha_corte/);
  await expect(readFile(join(root, "historical/pages/page-00000001.csv.gz"))).rejects.toMatchObject(
    { code: "ENOENT" },
  );
});

test("an invalid CSV page never becomes active", async () => {
  const root = await mkdtemp(join(tmpdir(), "rates-"));
  directories.push(root);
  const pages = new RawPages(root, clock);
  await expect(
    pages.write(
      "historical",
      1,
      (async function* () {
        yield gzipSync(":id,fecha_corte\n,2026-09-04\n");
      })(),
    ),
  ).rejects.toThrow();
  await expect(readFile(join(root, "historical/pages/page-00000001.csv.gz"))).rejects.toMatchObject(
    { code: "ENOENT" },
  );
});
