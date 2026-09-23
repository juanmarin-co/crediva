import { mkdir, rename, rm, stat } from "node:fs/promises";
import { dirname, join } from "node:path";
import { listValue } from "@duckdb/node-api";
import { withDuckDB } from "./duckdb";
import {
  parquetManifest,
  rawManifest,
  save,
  type Input,
  type Partition,
  type ParquetManifest,
} from "./manifests";
import { timestamp } from "./raw";
import type { Progress } from "./pull";

export interface ConvertOptions {
  rawPath: string;
  parquetPath: string;
  clock: () => Date;
  progress: Progress;
}

const columns: Record<string, string> = {
  credit_product: "producto_de_cr_dito",
  entity_type_code: "tipo_entidad",
  entity_type: "nombre_tipo_entidad",
  entity_code: "codigo_entidad",
  entity_name: "nombre_entidad",
  credit_type: "tipo_de_cr_dito",
  person_type: "tipo_de_persona",
  sex: "sexo",
  company_size: "tama_o_de_empresa",
  guarantee_type: "tipo_de_garant_a",
  credit_term: "plazo_de_cr_dito",
  ethnic_group: "grupo_etnico",
  company_age: "antiguedad_de_la_empresa",
  rate_type: "tipo_de_tasa",
  disbursed_amount_range: "rango_monto_desembolsado",
  debtor_class: "clase_deudor",
  ciiu_code: "codigo_ciiu",
  municipality_code: "codigo_municipio",
};

const projectionSQL = `CREATE TEMP TABLE projected AS
  WITH source_rows AS (
    SELECT
      ${Object.entries(columns)
        .map(([target, source]) => `${normalized(source)} AS ${target}`)
        .join(",\n      ")},
      CAST(fecha_corte AS DATE) AS reporting_date,
      CAST(round(CAST(tasa_efectiva_promedio AS DECIMAL(38,18)), 2) AS DECIMAL(5,2)) AS weighted_average_effective_rate,
      CAST(round(CAST(margen_adicional_a_la AS DECIMAL(38,18)), 2) AS DECIMAL(5,2)) AS additional_margin,
      CAST(round(CAST(montos_desembolsados AS DECIMAL(38,18)), 2) AS DECIMAL(18,2)) AS disbursed_amount,
      CAST(numero_de_creditos AS BIGINT) AS disbursed_credit_count
    FROM read_csv(?, header=true, all_varchar=true, compression='gzip', union_by_name=true)
  )
  SELECT
    credit_product, reporting_date, entity_type_code, entity_type, entity_code, entity_name,
    credit_type, person_type, sex, company_size, guarantee_type, credit_term,
    weighted_average_effective_rate, additional_margin, disbursed_amount,
    disbursed_credit_count, ethnic_group, company_age, rate_type,
    disbursed_amount_range, debtor_class, ciiu_code, municipality_code
  FROM source_rows WHERE strftime(reporting_date, '%Y-%m') = ?
  ORDER BY reporting_date ASC NULLS LAST, credit_product ASC NULLS LAST, entity_type_code ASC NULLS LAST, entity_code ASC NULLS LAST`;

export async function convert(options: ConvertOptions): Promise<void> {
  const { rawPath, parquetPath, clock, progress } = options;
  const rawFile = join(rawPath, "manifest.json");
  progress("READ", { path: rawFile, kind: "raw_manifest" });
  const raw = await rawManifest(rawFile);
  if (!raw) {
    throw new Error(`Raw manifest does not exist: ${rawFile}`);
  }

  const months = new Map<string, Input[]>();
  const sourceByDate = new Map<string, string>();
  for (const source of ["historical", "recent"] as const) {
    const state = raw.sources[source];
    for (const page of state.pages) {
      const path = join(rawPath, page.path);
      try {
        if ((await stat(path)).size !== page.bytes) {
          throw new Error("size mismatch");
        }
      } catch {
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

  const manifestPath = join(parquetPath, "manifest.json");
  const old = await parquetManifest(manifestPath);
  if (old) {
    progress("READ", { path: manifestPath, kind: "parquet_manifest" });
  }

  const previous = new Map(old?.partitions.map((item) => [monthKey(item), item]));
  const unchanged: Partition[] = [];
  const changed: [string, Input[]][] = [];
  for (const [month, inputs] of [...months].sort()) {
    const stored = previous.get(month);
    const path = stored && join(parquetPath, stored.path);
    let complete = false;
    if (path) {
      try {
        complete = (await stat(path)).size === stored.bytes;
      } catch {
        // A missing partition must be rebuilt.
      }
    }

    if (
      old?.schema_version === 2 &&
      stored &&
      complete &&
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

  const stage = join(parquetPath, ".staging");
  await rm(stage, { recursive: true, force: true });
  await mkdir(stage, { recursive: true });
  const converted: Partition[] = [];
  try {
    for (const [month, inputs] of changed) {
      const paths = [...new Set(inputs.map((input) => join(rawPath, input.path)))];
      for (const path of paths) {
        progress("READ", { path, kind: "raw_page" });
      }

      const relative = partitionPath(month);
      const destination = join(stage, relative);
      await mkdir(dirname(destination), { recursive: true });
      const rows = await withDuckDB(async (db) => {
        await db.run("SET memory_limit = '8GB'");
        await db.run(projectionSQL, [listValue(paths), month]);
        const result = await db.runAndReadAll(
          "COPY projected TO ? (FORMAT PARQUET, COMPRESSION ZSTD, RETURN_STATS)",
          [destination],
        );
        const item = result.getRowObjectsJS()[0];
        if (!item) {
          throw new Error(`DuckDB did not write a Parquet file for ${month}`);
        }

        return Number(item["count"]);
      });
      const expected = inputs.reduce(
        (sum, input) =>
          sum + Object.values(input.reporting_dates).reduce((total, count) => total + count, 0),
        0,
      );
      if (rows !== expected) {
        throw new Error(`Converted row count for ${month} is ${rows}, expected ${expected}`);
      }

      converted.push({
        reporting_year: Number(month.slice(0, 4)),
        reporting_month: Number(month.slice(5)),
        path: relative,
        rows,
        bytes: (await stat(destination)).size,
        inputs,
      });
    }

    for (const partition of converted) {
      const destination = join(parquetPath, partition.path);
      await mkdir(dirname(destination), { recursive: true });
      await rename(join(stage, partition.path), destination);
      progress("WRITE", { path: destination, kind: "parquet_partition", rows: partition.rows });
      progress("CONVERTED", { month: monthKey(partition), rows: partition.rows });
    }

    for (const month of stale) {
      const previousPartition = previous.get(month)!;
      const path = join(parquetPath, previousPartition.path);
      await rm(dirname(path), { recursive: true, force: true });
      progress("DELETE", { path, kind: "parquet_partition" });
      progress("REMOVED", { month });
    }

    const partitions = [...unchanged, ...converted].sort((a, b) =>
      monthKey(a).localeCompare(monthKey(b)),
    );
    const manifest: ParquetManifest = {
      version: 1,
      schema_version: 2,
      updated_at: timestamp(clock()),
      partitions,
    };
    await save(manifestPath, manifest);
    progress("WRITE", { path: manifestPath, kind: "parquet_manifest" });
  } finally {
    await rm(stage, { recursive: true, force: true });
  }
}

function monthKey(partition: Partition): string {
  return `${partition.reporting_year}-${String(partition.reporting_month).padStart(2, "0")}`;
}

function partitionPath(month: string): string {
  return `reporting_year=${month.slice(0, 4)}/reporting_month=${month.slice(5)}/data.parquet`;
}

function normalized(column: string): string {
  return `CASE ${column} WHEN 'N/A' THEN NULL WHEN 'No aplica(1)' THEN 'No aplica' WHEN 'Sin información (1)' THEN 'Sin información' ELSE ${column} END`;
}
