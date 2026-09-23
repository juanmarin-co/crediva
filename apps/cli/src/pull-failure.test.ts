import { mkdtemp, readFile, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { gzipSync } from "node:zlib";
import { expect, test } from "vitest";
import type { RawManifest } from "./manifests";
import { pull, type Socrata } from "./pull";

const recent = gzipSync(":id,fecha_corte\nrecent-1,2026-09-04\n");
const historical = gzipSync(":id,fecha_corte\nhistorical-1,2026-06-19\n");

test("a failed recent refresh preserves the active snapshot and manifest", async () => {
  const root = await mkdtemp(join(tmpdir(), "rates-refresh-"));
  const events: string[] = [];
  const dependencies = {
    pageSize: 50_000,
    signal: new AbortController().signal,
    clock: () => new Date("2026-09-21T00:00:00Z"),
    progress: (event: string) => {
      events.push(event);
    },
  };

  const first: Socrata = {
    newestId: async () => "recent-1",
    page: async function* (dataset) {
      if (dataset.name === "recent") {
        yield recent;
      } else {
        yield historical;
      }
    },
  };

  try {
    await pull({ root, socrata: first, ...dependencies });

    const before = await readFile(join(root, "recent/current/page-00000001.csv.gz"));

    const failing: Socrata = {
      newestId: async () => "recent-2",
      page: async function* () {
        yield gzipSync(":id,fecha_corte\nrecent-2,2026-09-11\n");
        throw new Error("download interrupted");
      },
    };

    await expect(pull({ root, socrata: failing, ...dependencies })).rejects.toThrow(
      "download interrupted",
    );
    expect(await readFile(join(root, "recent/current/page-00000001.csv.gz"))).toEqual(before);
    expect(events.filter((event) => event === "PAGE")).toHaveLength(2);
    const manifest = JSON.parse(await readFile(join(root, "manifest.json"), "utf8")) as RawManifest;
    expect(manifest.sources.recent.newest_id).toBe("recent-1");
    await expect(
      stat(join(root, "recent/next/page-00000001.csv.gz.partial")),
    ).rejects.toMatchObject({ code: "ENOENT" });
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
