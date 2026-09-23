import { timestamp } from "./raw";
import type { Progress } from "./pull";
import type { Input, ParquetManifest, Partition, RawManifest } from "./manifests";

export interface ObjectInfo {
  bytes: number;
  etag: string;
}

export interface ConvertStorage {
  readRaw(): Promise<RawManifest | null>;
  readParquet(): Promise<ParquetManifest | null>;
  rawObjects(): Promise<Map<string, ObjectInfo>>;
  parquetObjects(): Promise<Map<string, ObjectInfo>>;
  convertMonth(
    month: string,
    pages: string[],
    path: string,
    expectedRows: number,
  ): Promise<{ rows: number } & ObjectInfo>;
  deletePartition(path: string): Promise<void>;
  saveParquet(manifest: ParquetManifest): Promise<void>;
}

export interface ConvertOptions {
  storage: ConvertStorage;
  clock: () => Date;
  progress: Progress;
}

export async function convert({ storage, clock, progress }: ConvertOptions): Promise<void> {
  progress("READ", { path: "raw/manifest.json", kind: "raw_manifest" });
  const raw = await storage.readRaw();
  if (!raw) {
    throw new Error("Raw manifest does not exist in R2");
  }

  const rawObjects = await storage.rawObjects();
  const months = new Map<string, Input[]>();
  const sourceByDate = new Map<string, string>();
  for (const source of ["historical", "recent"] as const) {
    const state = raw.sources[source];
    for (const page of state.pages) {
      if (rawObjects.get(page.path)?.bytes !== page.bytes) {
        throw new Error(`Raw page is incomplete: ${page.path}`);
      }

      const daysByMonth = new Map<string, Record<string, number>>();
      for (const [day, count] of Object.entries(page.reporting_dates).sort()) {
        const previous = sourceByDate.get(day);
        if (previous && previous !== source) {
          throw new Error(`Historical and recent sources overlap on reporting date ${day}`);
        }

        sourceByDate.set(day, source);
        const month = day.slice(0, 7);
        const days = daysByMonth.get(month) ?? {};
        days[day] = count;
        daysByMonth.set(month, days);
      }

      for (const [month, days] of daysByMonth) {
        const inputs = months.get(month) ?? [];
        inputs.push({ source, dataset_id: state.dataset_id, ...page, reporting_dates: days });
        months.set(month, inputs);
      }
    }
  }

  const old = await storage.readParquet();
  if (old) {
    progress("READ", { path: "parquet/manifest.json", kind: "parquet_manifest" });
  }

  const parquetObjects = await storage.parquetObjects();
  const previous = new Map(old?.partitions.map((item) => [monthKey(item), item]));
  const unchanged: Partition[] = [];
  const changed: [string, Input[]][] = [];
  for (const [month, inputs] of [...months].sort()) {
    const stored = previous.get(month);
    const actual = stored && parquetObjects.get(stored.path);
    if (
      stored &&
      actual?.bytes === stored.bytes &&
      actual.etag === stored.etag &&
      JSON.stringify(stored.inputs) === JSON.stringify(inputs)
    ) {
      unchanged.push(stored);
      progress("UNCHANGED", { month });
    } else {
      changed.push([month, inputs]);
    }
  }

  const stale = [...previous.keys()].filter((month) => !months.has(month));
  if (changed.length === 0 && stale.length === 0) {
    return;
  }

  const converted: Partition[] = [];
  for (const [month, inputs] of changed) {
    const paths = [...new Set(inputs.map((input) => input.path))];
    for (const path of paths) {
      progress("READ", { path: `raw/${path}`, kind: "raw_page" });
    }

    const relative = partitionPath(month);
    const expected = inputs.reduce(
      (sum, input) =>
        sum + Object.values(input.reporting_dates).reduce((total, count) => total + count, 0),
      0,
    );
    const result = await storage.convertMonth(month, paths, relative, expected);
    if (result.rows !== expected) {
      throw new Error(`Converted row count for ${month} is ${result.rows}, expected ${expected}`);
    }

    converted.push({
      reporting_year: Number(month.slice(0, 4)),
      reporting_month: Number(month.slice(5)),
      path: relative,
      rows: result.rows,
      bytes: result.bytes,
      inputs,
      etag: result.etag,
    });
    progress("WRITE", {
      path: `parquet/${relative}`,
      kind: "parquet_partition",
      rows: result.rows,
    });
    progress("CONVERTED", { month, rows: result.rows });
  }

  for (const month of stale) {
    const path = previous.get(month)!.path;
    await storage.deletePartition(path);
    progress("DELETE", { path: `parquet/${path}`, kind: "parquet_partition" });
    progress("REMOVED", { month });
  }

  const manifest: ParquetManifest = {
    version: 2,
    schema_version: 2,
    updated_at: timestamp(clock()),
    partitions: [...unchanged, ...converted].sort((a, b) => monthKey(a).localeCompare(monthKey(b))),
  };
  await storage.saveParquet(manifest);
  progress("WRITE", { path: "parquet/manifest.json", kind: "parquet_manifest" });
}

function monthKey(partition: Partition): string {
  return `${partition.reporting_year}-${String(partition.reporting_month).padStart(2, "0")}`;
}

function partitionPath(month: string): string {
  return `reporting_year=${month.slice(0, 4)}/reporting_month=${month.slice(5)}/data.parquet`;
}
