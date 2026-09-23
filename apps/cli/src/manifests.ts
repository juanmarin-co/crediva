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
  etag: string;
}

export interface ParquetManifest {
  version: 2;
  schema_version: 2;
  updated_at: string;
  partitions: Partition[];
}

export function parseRawManifest(doc: RawManifest): RawManifest {
  if (doc.version !== 2) {
    throw new Error("Unsupported raw manifest version");
  }

  for (const source of Object.values(doc.sources)) {
    for (const page of source.pages) {
      if (
        Object.values(page.reporting_dates).reduce((sum, count) => sum + count, 0) !== page.rows
      ) {
        throw new Error("Reporting-date row counts do not match page row count");
      }
    }
  }

  return doc;
}

export function parseParquetManifest(doc: ParquetManifest): ParquetManifest {
  if (doc.version !== 2 || doc.schema_version !== 2) {
    throw new Error("Unsupported Parquet manifest version or schema");
  }

  if (doc.partitions.some((partition) => typeof partition.etag !== "string" || !partition.etag)) {
    throw new Error("Parquet manifest is missing a partition ETag");
  }

  return doc;
}
