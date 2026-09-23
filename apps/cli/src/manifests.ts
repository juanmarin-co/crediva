import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import type { Page } from "./raw";

export interface RawManifest {
  version: 2;
  updated_at: string;
  sources: {
    historical: { dataset_id: string; cursor: string | null; pages: Page[] };
    recent: { dataset_id: string; newest_id: string | null; pages: Page[] };
  };
}

export interface Input extends Page {
  source: "historical" | "recent";
  dataset_id: string;
}

export interface Partition {
  reporting_year: number;
  reporting_month: number;
  path: string;
  rows: number;
  bytes: number;
  inputs: Input[];
}

export interface ParquetManifest {
  version: 1;
  schema_version: 2;
  updated_at: string;
  partitions: Partition[];
}

export async function save(path: string, value: unknown): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
  const partial = path + ".partial";
  await writeFile(partial, JSON.stringify(value, null, 2) + "\n");
  await rename(partial, path);
}

export async function rawManifest(path: string): Promise<RawManifest | null> {
  const doc = await load<RawManifest>(path);
  if (doc && doc.version !== 2) {
    throw new Error("Unsupported raw manifest version");
  }

  if (doc) {
    for (const source of Object.values(doc.sources)) {
      for (const page of source.pages) {
        if (
          Object.values(page.reporting_dates).reduce((sum, count) => sum + count, 0) !== page.rows
        ) {
          throw new Error("Reporting-date row counts do not match page row count");
        }
      }
    }
  }

  return doc;
}

export async function parquetManifest(path: string): Promise<ParquetManifest | null> {
  const doc = await load<ParquetManifest>(path);
  if (doc && doc.version !== 1) {
    throw new Error("Unsupported Parquet manifest version");
  }

  return doc;
}

async function load<T>(path: string): Promise<T | null> {
  try {
    return JSON.parse(await readFile(path, "utf8")) as T;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      return null;
    }

    throw error;
  }
}
