import { join } from "node:path";
import { rawManifest, save, type RawManifest } from "./manifests";
import { RawPages, timestamp } from "./raw";

export type Dataset = { name: "historical" | "recent"; datasetId: string };

export interface Socrata {
  newestId(dataset: Dataset, signal: AbortSignal): Promise<string>;
  page(
    dataset: Dataset,
    afterId: string | null,
    limit: number,
    signal: AbortSignal,
  ): AsyncIterable<Uint8Array>;
}

export type Progress = (event: string, values: Record<string, unknown>) => void;

export interface PullOptions {
  root: string;
  socrata: Socrata;
  pageSize: number;
  signal: AbortSignal;
  progress: Progress;
  clock: () => Date;
}

const historical: Dataset = { name: "historical", datasetId: "w9zh-vetq" };
const recent: Dataset = { name: "recent", datasetId: "qzsc-9esp" };

export async function pull(options: PullOptions): Promise<void> {
  const { root, socrata, signal, pageSize, progress, clock } = options;
  const pages = new RawPages(root, clock);
  const path = join(root, "manifest.json");
  const existing = await rawManifest(path);
  const manifest: RawManifest = existing ?? {
    version: 2,
    updated_at: timestamp(clock()),
    sources: {
      historical: { dataset_id: historical.datasetId, cursor: null, pages: [] },
      recent: { dataset_id: recent.datasetId, newest_id: null, pages: [] },
    },
  };
  if (
    manifest.sources.historical.dataset_id !== historical.datasetId ||
    manifest.sources.recent.dataset_id !== recent.datasetId
  ) {
    throw new Error("Raw manifest source does not match datasets");
  }

  await save(path, manifest);

  for (const page of manifest.sources.recent.pages) {
    if (!(await pages.complete(page))) {
      throw new Error(`Missing recent page: ${page.path}`);
    }
  }

  progress("CHECK", { dataset: "recent", operation: "newest_id" });
  const newest = await socrata.newestId(recent, signal);
  if (newest !== manifest.sources.recent.newest_id) {
    progress("CHANGED", {
      dataset: "recent",
      previous_newest_id: manifest.sources.recent.newest_id,
      newest_id: newest,
    });
    await pages.discardNext();

    const next = [];
    let cursor: string | null = null;
    while (true) {
      signal.throwIfAborted();

      const page = await pages.write(
        "recent",
        next.length + 1,
        socrata.page(recent, cursor, pageSize, signal),
      );
      if (!page) {
        if (next.length === 0) {
          throw new Error(`Dataset ${recent.datasetId} returned no rows`);
        }

        break;
      }

      next.push(page);
      cursor = page.last_id;
      progress("PAGE", {
        dataset: "recent",
        page: next.length,
        rows: page.rows,
        bytes: page.bytes,
        last_id: page.last_id,
      });

      if (page.rows < pageSize) {
        break;
      }
    }

    signal.throwIfAborted();

    const active = await pages.activate(next);
    manifest.sources.recent = { dataset_id: recent.datasetId, newest_id: newest, pages: active };
    manifest.updated_at = timestamp(clock());
    await save(path, manifest);
    await pages.discardPrevious();
  } else {
    progress("UP_TO_DATE", { dataset: "recent", newest_id: newest });
  }

  for (const page of manifest.sources.historical.pages) {
    if (!(await pages.complete(page))) {
      throw new Error(`Missing historical page: ${page.path}`);
    }
  }

  while (true) {
    signal.throwIfAborted();

    const state = manifest.sources.historical;
    progress("CHECK", {
      dataset: "historical",
      operation: "page_after_id",
      after_id: state.cursor,
    });
    const page = await pages.write(
      "historical",
      state.pages.length + 1,
      socrata.page(historical, state.cursor, pageSize, signal),
    );
    if (!page) {
      progress("UP_TO_DATE", { dataset: "historical", cursor: state.cursor });
      break;
    }

    state.pages.push(page);
    state.cursor = page.last_id;
    manifest.updated_at = timestamp(clock());
    await save(path, manifest);
    progress("PAGE", {
      dataset: "historical",
      page: state.pages.length,
      rows: page.rows,
      bytes: page.bytes,
      last_id: page.last_id,
    });
    if (page.rows < pageSize) {
      break;
    }
  }
}
