import { gzipSync } from "node:zlib";
import { expect, test } from "vitest";
import { pull, type RawStore, type Socrata } from "./pull";
import type { RawManifest } from "./manifests";
import type { Page } from "./raw";

const gzipPage = (id: string, date: string) => gzipSync(`:id,fecha_corte\n${id},${date}\n`);
const clock = () => new Date("2026-09-21T00:00:00Z");

function collection() {
  let manifest: RawManifest | null = null;
  const objects = new Map<string, Page>();
  const storage: RawStore = {
    readManifest: async () => manifest,
    saveManifest: async (value) => {
      manifest = structuredClone(value);
    },
    list: async () => new Map([...objects].map(([key, page]) => [key, page.bytes])),
    write: async (path, chunks) => {
      const buffers: Buffer[] = [];
      for await (const chunk of chunks) {
        buffers.push(Buffer.from(chunk));
      }

      const bytes = Buffer.concat(buffers);
      let id = "historical-1";
      let date = "2026-06-19";
      if (path.startsWith("recent/")) {
        id = "recent-1";
        date = "2026-09-04";
      }
      const page: Page = {
        path,
        rows: 1,
        bytes: bytes.length,
        first_id: id,
        last_id: id,
        downloaded_at: "2026-09-21T00:00:00+00:00",
        reporting_dates: { [date]: 1 },
      };
      objects.set(path, page);
      return page;
    },
    pruneRecent: async (active) => {
      for (const key of objects.keys()) {
        if (key.startsWith("recent/") && !active.has(key)) {
          objects.delete(key);
        }
      }
    },
  };
  return { storage, objects, manifest: () => manifest };
}

test("pull commits an R2 recent generation and checkpoints historical pages", async () => {
  const { storage, objects, manifest } = collection();
  const requests: string[] = [];
  const socrata: Socrata = {
    newestId: async () => "recent-1",
    page: async function* (dataset, afterId) {
      requests.push(`${dataset.name}:${afterId}`);
      if (dataset.name === "recent") {
        yield gzipPage("recent-1", "2026-09-04");
      } else {
        yield gzipPage("historical-1", "2026-06-19");
      }
    },
  };

  await pull({
    storage,
    socrata,
    pageSize: 2,
    signal: new AbortController().signal,
    clock,
    progress: () => {},
    generationId: () => "g1",
  });

  expect(requests).toEqual(["recent:null", "historical:null"]);
  expect(manifest()!.sources.recent.pages[0]?.path).toBe(
    "recent/generation-g1/page-00000001.csv.gz",
  );
  expect(manifest()!.sources.historical.cursor).toBe("historical-1");
  expect(objects.has("recent/generation-g1/page-00000001.csv.gz")).toBe(true);
});

test("pull replaces the old current layout with a generation even if newest_id is unchanged", async () => {
  const { storage, objects, manifest } = collection();
  const old: Page = {
    path: "recent/current/page-00000001.csv.gz",
    rows: 1,
    bytes: 10,
    first_id: "recent-1",
    last_id: "recent-1",
    downloaded_at: "2026-09-20T00:00:00+00:00",
    reporting_dates: { "2026-09-04": 1 },
  };
  objects.set(old.path, old);
  await storage.saveManifest(
    {
      version: 2,
      updated_at: old.downloaded_at,
      sources: {
        recent: { dataset_id: "qzsc-9esp", newest_id: "recent-1", pages: [old] },
        historical: { dataset_id: "w9zh-vetq", cursor: null, pages: [] },
      },
    },
    new AbortController().signal,
  );
  const socrata: Socrata = {
    newestId: async () => "recent-1",
    page: async function* (dataset) {
      if (dataset.name === "recent") {
        yield gzipPage("recent-1", "2026-09-04");
      } else {
        yield gzipPage("historical-1", "2026-06-19");
      }
    },
  };

  await pull({
    storage,
    socrata,
    pageSize: 50_000,
    signal: new AbortController().signal,
    clock,
    progress: () => {},
    generationId: () => "g2",
  });
  expect(manifest()!.sources.recent.pages[0]?.path).toBe(
    "recent/generation-g2/page-00000001.csv.gz",
  );
  expect(objects.has(old.path)).toBe(false);
});

test("a failed refresh leaves the active snapshot in the manifest and cleans incomplete pages", async () => {
  const { storage, objects, manifest } = collection();
  const first: Socrata = {
    newestId: async () => "recent-1",
    page: async function* (dataset) {
      let id = "historical-1";
      if (dataset.name === "recent") {
        id = "recent-1";
      }

      yield gzipPage(id, "2026-09-04");
    },
  };
  const options = {
    storage,
    pageSize: 50_000,
    signal: new AbortController().signal,
    clock,
    progress: () => {},
    generationId: () => "g1",
  };
  await pull({ ...options, socrata: first });
  const failing: Socrata = {
    newestId: async () => "recent-2",
    page: async function* (_dataset, afterId) {
      if (afterId) {
        throw new Error("download interrupted");
      }

      yield gzipPage("recent-2", "2026-09-11");
    },
  };

  await expect(
    pull({ ...options, pageSize: 1, generationId: () => "g2", socrata: failing }),
  ).rejects.toThrow("download interrupted");
  expect(manifest()!.sources.recent.newest_id).toBe("recent-1");
  expect(objects.has("recent/generation-g1/page-00000001.csv.gz")).toBe(true);
  expect(objects.has("recent/generation-g2/page-00000001.csv.gz")).toBe(false);
});
