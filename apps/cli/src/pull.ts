import type { RawManifest } from "./manifests";
import type { Page } from "./raw";
import { timestamp } from "./raw";

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

export interface RawStore {
  readManifest(): Promise<RawManifest | null>;
  saveManifest(manifest: RawManifest, signal: AbortSignal): Promise<void>;
  list(): Promise<Map<string, number>>;
  write(
    path: string,
    chunks: AsyncIterable<Uint8Array>,
    signal: AbortSignal,
    clock: () => Date,
  ): Promise<Page | null>;
  pruneRecent(active: ReadonlySet<string>): Promise<void>;
}

export interface PullOptions {
  storage: RawStore;
  socrata: Socrata;
  pageSize: number;
  signal: AbortSignal;
  progress: Progress;
  clock: () => Date;
  generationId: () => string;
}

const historical: Dataset = { name: "historical", datasetId: "w9zh-vetq" };
const recent: Dataset = { name: "recent", datasetId: "qzsc-9esp" };

export async function pull({
  storage,
  socrata,
  signal,
  pageSize,
  progress,
  clock,
  generationId,
}: PullOptions): Promise<void> {
  const existing = await storage.readManifest();
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

  const objects = await storage.list();
  for (const page of manifest.sources.recent.pages) {
    if (objects.get(page.path) !== page.bytes) {
      throw new Error(`Missing recent page: ${page.path}`);
    }
  }

  await storage.pruneRecent(new Set(manifest.sources.recent.pages.map((page) => page.path)));
  signal.throwIfAborted();
  progress("CHECK", { dataset: "recent", operation: "newest_id" });
  const newest = await socrata.newestId(recent, signal);
  if (
    newest !== manifest.sources.recent.newest_id ||
    manifest.sources.recent.pages.some((page) => !page.path.startsWith("recent/generation-"))
  ) {
    progress("CHANGED", {
      dataset: "recent",
      previous_newest_id: manifest.sources.recent.newest_id,
      newest_id: newest,
    });

    const generation = generationId();
    if (!/^[a-zA-Z0-9-]+$/.test(generation)) {
      throw new Error("Invalid recent generation ID");
    }

    const prefix = `recent/generation-${generation}/`;
    if (manifest.sources.recent.pages.some((page) => page.path.startsWith(prefix))) {
      throw new Error("Recent generation ID is already active");
    }

    const active = new Set(manifest.sources.recent.pages.map((page) => page.path));
    const next: Page[] = [];
    let cursor: string | null = null;
    try {
      while (true) {
        signal.throwIfAborted();
        const relative = `recent/generation-${generation}/page-${String(next.length + 1).padStart(8, "0")}.csv.gz`;
        const page = await storage.write(
          relative,
          socrata.page(recent, cursor, pageSize, signal),
          signal,
          clock,
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
    } catch (error) {
      await storage.pruneRecent(active);
      throw error;
    }

    manifest.sources.recent = { dataset_id: recent.datasetId, newest_id: newest, pages: next };
    manifest.updated_at = timestamp(clock());
    await storage.saveManifest(manifest, signal);
    await storage.pruneRecent(new Set(next.map((page) => page.path)));
  } else {
    progress("UP_TO_DATE", { dataset: "recent", newest_id: newest });
  }

  for (const page of manifest.sources.historical.pages) {
    if (objects.get(page.path) !== page.bytes) {
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
    const relative = `historical/pages/page-${String(state.pages.length + 1).padStart(8, "0")}.csv.gz`;
    const page = await storage.write(
      relative,
      socrata.page(historical, state.cursor, pageSize, signal),
      signal,
      clock,
    );
    if (!page) {
      progress("UP_TO_DATE", { dataset: "historical", cursor: state.cursor });
      break;
    }

    signal.throwIfAborted();
    state.pages.push(page);
    state.cursor = page.last_id;
    manifest.updated_at = timestamp(clock());
    await storage.saveManifest(manifest, signal);
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
