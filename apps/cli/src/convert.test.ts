import { expect, test } from "vitest";
import { convert, type ConvertStorage } from "./convert";
import type { ParquetManifest, RawManifest } from "./manifests";

const page = {
  path: "historical/pages/page-00000001.csv.gz",
  rows: 2,
  bytes: 70,
  first_id: "1",
  last_id: "2",
  downloaded_at: "2026-09-21T00:00:00+00:00",
  reporting_dates: { "2026-09-04": 2 },
};

function collection(): {
  storage: ConvertStorage;
  written: ParquetManifest[];
  converted: string[];
} {
  const written: ParquetManifest[] = [];
  const converted: string[] = [];
  const raw: RawManifest = {
    version: 2,
    updated_at: "2026-09-21T00:00:00+00:00",
    sources: {
      historical: { dataset_id: "w9zh-vetq", cursor: "2", pages: [page] },
      recent: { dataset_id: "qzsc-9esp", newest_id: null, pages: [] },
    },
  };
  const storage: ConvertStorage = {
    readRaw: async () => raw,
    readParquet: async () => written.at(-1) ?? null,
    rawObjects: async () => new Map([[page.path, { bytes: 70, etag: "raw-etag" }]]),
    parquetObjects: async () =>
      new Map(
        written.at(-1)?.partitions.map((p) => [p.path, { bytes: p.bytes, etag: p.etag }]) ?? [],
      ),
    convertMonth: async (month, inputs, path, expectedRows) => {
      converted.push(month);
      expect(expectedRows).toBe(2);
      expect(inputs).toEqual([page.path]);
      expect(path).toBe("reporting_year=2026/reporting_month=09/data.parquet");

      return { rows: 2, bytes: 99, etag: "parquet-etag" };
    },
    deletePartition: async () => {},
    saveParquet: async (manifest) => {
      written.push(manifest);
    },
  };

  return { storage, written, converted };
}

test("convert publishes a changed reporting month and skips it when R2 objects match", async () => {
  const { storage, written, converted } = collection();
  const options = {
    storage,
    clock: () => new Date("2026-09-21T00:00:00Z"),
    progress: () => {},
  };

  await convert(options);
  expect(written[0]).toMatchObject({
    version: 2,
    partitions: [
      {
        path: "reporting_year=2026/reporting_month=09/data.parquet",
        rows: 2,
        bytes: 99,
        etag: "parquet-etag",
      },
    ],
  });

  await convert(options);
  expect(converted).toEqual(["2026-09"]);
  expect(written).toHaveLength(1);
});

test("convert rebuilds a partition whose R2 ETag changed without changing its size", async () => {
  const { storage, written, converted } = collection();
  const options = { storage, clock: () => new Date("2026-09-21T00:00:00Z"), progress: () => {} };
  await convert(options);
  storage.parquetObjects = async () =>
    new Map([[written[0]!.partitions[0]!.path, { bytes: 99, etag: "replaced-object" }]]);

  await convert(options);
  expect(converted).toEqual(["2026-09", "2026-09"]);
  expect(written).toHaveLength(2);
});

test("convert rebuilds a reporting month when its raw page metadata changes", async () => {
  const { storage, converted } = collection();
  const options = { storage, clock: () => new Date("2026-09-21T00:00:00Z"), progress: () => {} };
  await convert(options);
  const original = storage.readRaw;
  storage.readRaw = async () => {
    const raw = (await original())!;
    return {
      ...raw,
      sources: {
        ...raw.sources,
        historical: {
          ...raw.sources.historical,
          pages: [{ ...page, downloaded_at: "2026-09-22T00:00:00+00:00" }],
        },
      },
    };
  };

  await convert(options);
  expect(converted).toEqual(["2026-09", "2026-09"]);
});

test("convert rejects overlapping source dates without publishing Parquet", async () => {
  const { storage, written } = collection();
  const original = storage.readRaw;
  storage.readRaw = async () => {
    const raw = (await original())!;
    return {
      ...raw,
      sources: {
        ...raw.sources,
        recent: {
          dataset_id: "qzsc-9esp",
          newest_id: "3",
          pages: [{ ...page, path: "recent/current/page-00000001.csv.gz" }],
        },
      },
    };
  };
  storage.rawObjects = async () =>
    new Map([
      [page.path, { bytes: 70, etag: "raw-etag" }],
      ["recent/current/page-00000001.csv.gz", { bytes: 70, etag: "recent-etag" }],
    ]);

  await expect(convert({ storage, clock: () => new Date(), progress: () => {} })).rejects.toThrow(
    /overlap.*2026-09-04/,
  );
  expect(written).toHaveLength(0);
});

test("convert removes a reporting month absent from the active raw collection", async () => {
  const { storage, written } = collection();
  const removed: string[] = [];
  const options = { storage, clock: () => new Date("2026-09-21T00:00:00Z"), progress: () => {} };
  await convert(options);
  const original = storage.readRaw;
  storage.readRaw = async () => {
    const raw = (await original())!;
    return {
      ...raw,
      sources: {
        ...raw.sources,
        historical: { ...raw.sources.historical, pages: [] },
      },
    };
  };
  storage.deletePartition = async (path) => {
    removed.push(path);
  };

  await convert(options);
  expect(removed).toEqual(["reporting_year=2026/reporting_month=09/data.parquet"]);
  expect(written[1]?.partitions).toEqual([]);
});

test("convert leaves its manifest unchanged if writing the changed partition fails", async () => {
  const { storage, written } = collection();
  storage.convertMonth = async () => {
    throw new Error("upload interrupted");
  };

  await expect(convert({ storage, clock: () => new Date(), progress: () => {} })).rejects.toThrow(
    "upload interrupted",
  );
  expect(written).toHaveLength(0);
});
