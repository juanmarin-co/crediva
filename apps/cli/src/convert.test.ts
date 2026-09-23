import { mkdir, mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { gzipSync } from "node:zlib";
import { expect, test } from "vitest";
import { convert } from "./convert";
import { withDuckDB } from "./duckdb";
import type { ParquetManifest, RawManifest } from "./manifests";

const header =
  ":id,fecha_corte,tipo_entidad,nombre_tipo_entidad,codigo_entidad,nombre_entidad,tipo_de_persona,sexo,tama_o_de_empresa,tipo_de_cr_dito,tipo_de_garant_a,producto_de_cr_dito,plazo_de_cr_dito,tasa_efectiva_promedio,margen_adicional_a_la,montos_desembolsados,numero_de_creditos,grupo_etnico,antiguedad_de_la_empresa,tipo_de_tasa,rango_monto_desembolsado,clase_deudor,codigo_ciiu,codigo_municipio\n";
const row =
  "row-1,2026-09-04T00:00:00.000,01,Bancos,0007,Banco Uno,Natural,N/A,No aplica(1),Consumo,Hipotecaria,Libranza,12 meses,12.345,0,1000.50,2,Sin información (1),N/A,Fija,0-1M,Deudor,0010,05001\n";

test("convert produces compatible monthly Parquet from an existing raw manifest", async () => {
  const root = await mkdtemp(join(tmpdir(), "rates-convert-"));
  const raw = join(root, "raw");
  const output = join(root, "parquet");
  const relative = "historical/pages/page-00000001.csv.gz";
  const bytes = gzipSync(header + row);
  const events: string[] = [];
  const dependencies = {
    clock: () => new Date("2026-09-21T00:00:00Z"),
    progress: (event: string) => {
      events.push(event);
    },
  };

  try {
    await mkdir(dirname(join(raw, relative)), { recursive: true });
    await writeFile(join(raw, relative), bytes);

    const manifest: RawManifest = {
      version: 2,
      updated_at: "2026-09-21T00:00:00+00:00",
      sources: {
        historical: {
          dataset_id: "w9zh-vetq",
          cursor: "row-1",
          pages: [
            {
              path: relative,
              rows: 1,
              bytes: bytes.length,
              first_id: "row-1",
              last_id: "row-1",
              downloaded_at: "2026-09-21T00:00:00+00:00",
              reporting_dates: { "2026-09-04": 1 },
            },
          ],
        },
        recent: { dataset_id: "qzsc-9esp", newest_id: null, pages: [] },
      },
    };
    await writeFile(join(raw, "manifest.json"), JSON.stringify(manifest));
    await convert({ rawPath: raw, parquetPath: output, ...dependencies });

    const document = JSON.parse(
      await readFile(join(output, "manifest.json"), "utf8"),
    ) as ParquetManifest;
    expect(document.partitions[0]).toMatchObject({
      reporting_year: 2026,
      reporting_month: 9,
      path: "reporting_year=2026/reporting_month=09/data.parquet",
      rows: 1,
    });

    const path = join(output, document.partitions[0]!.path);
    const record = await withDuckDB(
      async (db) =>
        (
          await db.runAndReadAll(
            "SELECT credit_product, entity_code, weighted_average_effective_rate::VARCHAR AS rate, company_size FROM read_parquet(?, hive_partitioning=false)",
            [path],
          )
        ).getRowObjectsJS()[0],
    );
    expect(record).toEqual({
      credit_product: "Libranza",
      entity_code: "0007",
      rate: "12.35",
      company_size: "No aplica",
    });

    const schema = await withDuckDB(async (db) => {
      const result = await db.runAndReadAll(
        "DESCRIBE SELECT * FROM read_parquet(?, hive_partitioning=false)",
        [path],
      );
      return result.getRowObjectsJS().map((column) => column["column_name"]);
    });
    expect(schema).toEqual([
      "credit_product",
      "reporting_date",
      "entity_type_code",
      "entity_type",
      "entity_code",
      "entity_name",
      "credit_type",
      "person_type",
      "sex",
      "company_size",
      "guarantee_type",
      "credit_term",
      "weighted_average_effective_rate",
      "additional_margin",
      "disbursed_amount",
      "disbursed_credit_count",
      "ethnic_group",
      "company_age",
      "rate_type",
      "disbursed_amount_range",
      "debtor_class",
      "ciiu_code",
      "municipality_code",
    ]);

    const before = (await stat(path)).mtimeMs;
    await convert({ rawPath: raw, parquetPath: output, ...dependencies });
    expect((await stat(path)).mtimeMs).toBe(before);
    expect(events.filter((event) => event === "WRITE")).toHaveLength(2);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("convert rejects overlapping fecha_corte without committing Parquet", async () => {
  const root = await mkdtemp(join(tmpdir(), "rates-overlap-"));
  const raw = join(root, "raw");
  const output = join(root, "parquet");
  const historical = "historical/pages/page-00000001.csv.gz";
  const recent = "recent/current/page-00000001.csv.gz";
  const historicalBytes = gzipSync(header + row);
  const recentBytes = gzipSync(header + row.replace("row-1,", "row-recent,"));
  const events: string[] = [];
  const dependencies = {
    clock: () => new Date("2026-09-21T00:00:00Z"),
    progress: (event: string) => {
      events.push(event);
    },
  };

  try {
    for (const [relative, bytes] of [
      [historical, historicalBytes],
      [recent, recentBytes],
    ] as const) {
      await mkdir(dirname(join(raw, relative)), { recursive: true });
      await writeFile(join(raw, relative), bytes);
    }

    const page = (path: string, bytes: number, id: string) => ({
      path,
      rows: 1,
      bytes,
      first_id: id,
      last_id: id,
      downloaded_at: "2026-09-21T00:00:00+00:00",
      reporting_dates: { "2026-09-04": 1 },
    });

    const manifest: RawManifest = {
      version: 2,
      updated_at: "2026-09-21T00:00:00+00:00",
      sources: {
        historical: {
          dataset_id: "w9zh-vetq",
          cursor: "row-1",
          pages: [page(historical, historicalBytes.length, "row-1")],
        },
        recent: {
          dataset_id: "qzsc-9esp",
          newest_id: "row-recent",
          pages: [page(recent, recentBytes.length, "row-recent")],
        },
      },
    };
    await writeFile(join(raw, "manifest.json"), JSON.stringify(manifest));

    await expect(convert({ rawPath: raw, parquetPath: output, ...dependencies })).rejects.toThrow(
      /overlap.*2026-09-04/,
    );
    await expect(stat(join(output, "manifest.json"))).rejects.toMatchObject({ code: "ENOENT" });
    expect(events).not.toContain("WRITE");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
