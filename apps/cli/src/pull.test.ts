import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { gzipSync } from "node:zlib";
import { expect, test } from "vitest";
import type { RawManifest } from "./manifests";
import { pull, type Socrata } from "./pull";

const page = (id: string, date: string) => gzipSync(`:id,fecha_corte\n${id},${date}\n`);
const clock = () => new Date("2026-09-21T00:00:00Z");

test("pull checkpoints the recent snapshot and historical cursor in compatible raw layout", async () => {
  const root = await mkdtemp(join(tmpdir(), "rates-pull-"));
  const requests: string[] = [];
  const events: string[] = [];
  const socrata: Socrata = {
    newestId: async () => "recent-1",
    page: async function* (dataset, afterId) {
      requests.push(`${dataset.name}:${afterId}`);

      if (dataset.name === "recent") {
        yield page("recent-1", "2026-09-04");
      } else {
        yield page("historical-1", "2026-06-19");
      }
    },
  };

  try {
    await pull({
      root,
      socrata,
      pageSize: 2,
      signal: new AbortController().signal,
      clock,
      progress: (event) => events.push(event),
    });

    const manifest = JSON.parse(await readFile(join(root, "manifest.json"), "utf8")) as RawManifest;
    expect(requests).toEqual(["recent:null", "historical:null"]);
    expect(events.filter((event) => event === "PAGE")).toEqual(["PAGE", "PAGE"]);
    expect(manifest.sources.recent.pages[0]?.path).toBe("recent/current/page-00000001.csv.gz");
    expect(manifest.sources.historical.cursor).toBe("historical-1");
    expect(manifest.sources.historical.pages[0]?.reporting_dates).toEqual({ "2026-06-19": 1 });
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
