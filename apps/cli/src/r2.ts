import {
  DeleteObjectCommand,
  GetObjectCommand,
  HeadObjectCommand,
  ListObjectsV2Command,
  PutObjectCommand,
  S3Client,
} from "@aws-sdk/client-s3";
import { listValue } from "@duckdb/node-api";
import { withDuckDB } from "./duckdb";
import {
  parseParquetManifest,
  parseRawManifest,
  type ParquetManifest,
  type RawManifest,
} from "./manifests";
import type { ConvertStorage, ObjectInfo } from "./convert";
import type { RawStore } from "./pull";
import { inspectPage, timestamp, type Page } from "./raw";

export interface R2Config {
  accountId: string;
  accessKeyId: string;
  secretAccessKey: string;
  endpoint: string;
  rawBucket: string;
  parquetBucket: string;
}

export class R2Storage implements ConvertStorage, RawStore {
  private readonly client: S3Client;

  constructor(private readonly config: R2Config) {
    this.client = new S3Client({
      region: "auto",
      endpoint: config.endpoint,
      forcePathStyle: true,
      credentials: { accessKeyId: config.accessKeyId, secretAccessKey: config.secretAccessKey },
    });
  }

  async readRaw(): Promise<RawManifest | null> {
    const document = await this.loadManifest<RawManifest>(this.config.rawBucket);
    if (!document) {
      return null;
    }

    return parseRawManifest(document);
  }

  async readParquet(): Promise<ParquetManifest | null> {
    const document = await this.loadManifest<ParquetManifest>(this.config.parquetBucket);
    if (!document) {
      return null;
    }

    return parseParquetManifest(document);
  }

  rawObjects(): Promise<Map<string, ObjectInfo>> {
    return this.objects(this.config.rawBucket);
  }

  parquetObjects(): Promise<Map<string, ObjectInfo>> {
    return this.objects(this.config.parquetBucket);
  }

  async readManifest(): Promise<RawManifest | null> {
    return this.readRaw();
  }

  async saveManifest(manifest: RawManifest, signal: AbortSignal): Promise<void> {
    signal.throwIfAborted();
    await this.client.send(
      new PutObjectCommand({
        Bucket: this.config.rawBucket,
        Key: "manifest.json",
        Body: JSON.stringify(manifest, null, 2) + "\n",
        ContentType: "application/json",
      }),
      { abortSignal: signal },
    );
  }

  async list(): Promise<Map<string, number>> {
    const objects = await this.objects(this.config.rawBucket);
    return new Map([...objects].map(([key, info]) => [key, info.bytes]));
  }

  async write(
    path: string,
    chunks: AsyncIterable<Uint8Array>,
    signal: AbortSignal,
    clock: () => Date,
  ): Promise<Page | null> {
    const buffers: Buffer[] = [];
    for await (const chunk of chunks) {
      signal.throwIfAborted();
      buffers.push(Buffer.from(chunk));
    }

    signal.throwIfAborted();
    const bytes = Buffer.concat(buffers);
    await this.client.send(
      new PutObjectCommand({
        Bucket: this.config.rawBucket,
        Key: path,
        Body: bytes,
      }),
      { abortSignal: signal },
    );

    try {
      const details = await withDuckDB(async (db) => {
        await db.run("INSTALL httpfs");
        await db.run("LOAD httpfs");
        await db.run("CREATE SECRET crediva_r2 (TYPE r2, KEY_ID ?, SECRET ?, ACCOUNT_ID ?)", [
          this.config.accessKeyId,
          this.config.secretAccessKey,
          this.config.accountId,
        ]);
        return inspectPage(this.uri(this.config.rawBucket, path), db);
      });
      if (!details) {
        await this.deleteRawPage(path);
        return null;
      }

      signal.throwIfAborted();
      return { path, bytes: bytes.length, ...details, downloaded_at: timestamp(clock()) };
    } catch (error) {
      await this.deleteRawPage(path);
      throw error;
    }
  }

  async pruneRecent(active: ReadonlySet<string>): Promise<void> {
    const objects = await this.objects(this.config.rawBucket, "recent/");
    for (const path of objects.keys()) {
      if (!active.has(path)) {
        await this.deleteRawPage(path);
      }
    }
  }

  async convertMonth(
    month: string,
    pages: string[],
    path: string,
    expectedRows: number,
  ): Promise<{ rows: number } & ObjectInfo> {
    const source = pages.map((page) => this.uri(this.config.rawBucket, page));
    const destination = this.uri(this.config.parquetBucket, path);
    const rows = await withDuckDB(async (db) => {
      await db.run("INSTALL httpfs");
      await db.run("LOAD httpfs");
      await db.run("CREATE SECRET crediva_r2 (TYPE r2, KEY_ID ?, SECRET ?, ACCOUNT_ID ?)", [
        this.config.accessKeyId,
        this.config.secretAccessKey,
        this.config.accountId,
      ]);
      await db.run("SET memory_limit = '8GB'");
      await db.run(projectionSQL, [listValue(source), month]);
      const summary = await db.runAndReadAll("SELECT count(*) AS rows FROM projected");
      const rows = Number(summary.getRowObjectsJS()[0]?.["rows"]);
      if (rows !== expectedRows) {
        throw new Error(`Converted row count for ${month} is ${rows}, expected ${expectedRows}`);
      }

      await db.run(
        "COPY projected TO ? (FORMAT PARQUET, COMPRESSION ZSTD, OVERWRITE_OR_IGNORE true)",
        [destination],
      );
      return rows;
    });

    const object = await this.client.send(
      new HeadObjectCommand({ Bucket: this.config.parquetBucket, Key: path }),
    );
    if (object.ContentLength === undefined || !object.ETag) {
      throw new Error(`Cannot verify Parquet partition: ${path}`);
    }

    return { rows, bytes: object.ContentLength, etag: unquote(object.ETag) };
  }

  async deletePartition(path: string): Promise<void> {
    await this.client.send(
      new DeleteObjectCommand({ Bucket: this.config.parquetBucket, Key: path }),
    );
  }

  async saveParquet(manifest: ParquetManifest): Promise<void> {
    await this.client.send(
      new PutObjectCommand({
        Bucket: this.config.parquetBucket,
        Key: "manifest.json",
        Body: JSON.stringify(manifest, null, 2) + "\n",
        ContentType: "application/json",
      }),
    );
  }

  private async deleteRawPage(path: string): Promise<void> {
    await this.client.send(new DeleteObjectCommand({ Bucket: this.config.rawBucket, Key: path }));
  }

  private async loadManifest<T>(bucket: string): Promise<T | null> {
    try {
      const object = await this.client.send(
        new GetObjectCommand({ Bucket: bucket, Key: "manifest.json" }),
      );
      if (!object.Body) {
        throw new Error(`Empty manifest in bucket ${bucket}`);
      }

      return JSON.parse(await object.Body.transformToString()) as T;
    } catch (error) {
      if (isMissing(error)) {
        return null;
      }

      throw error;
    }
  }

  private async objects(bucket: string, prefix = ""): Promise<Map<string, ObjectInfo>> {
    const objects = new Map<string, ObjectInfo>();
    let continuation: string | undefined;
    do {
      const response = await this.client.send(
        new ListObjectsV2Command({
          Bucket: bucket,
          Prefix: prefix,
          ContinuationToken: continuation,
        }),
      );
      for (const object of response.Contents ?? []) {
        if (object.Key && object.Size !== undefined && object.ETag) {
          objects.set(object.Key, { bytes: object.Size, etag: unquote(object.ETag) });
        }
      }

      continuation = undefined;
      if (response.IsTruncated) {
        continuation = response.NextContinuationToken;
        if (!continuation) {
          throw new Error(`Incomplete R2 listing for bucket ${bucket}`);
        }
      }
    } while (continuation);

    return objects;
  }

  private uri(bucket: string, path: string): string {
    return `r2://${bucket}/${path}`;
  }
}

function isMissing(error: unknown): boolean {
  return error instanceof Error && (error.name === "NoSuchKey" || error.name === "NotFound");
}

function unquote(etag: string): string {
  return etag.replace(/^"|"$/g, "");
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

function normalized(column: string): string {
  return `CASE ${column} WHEN 'N/A' THEN NULL WHEN 'No aplica(1)' THEN 'No aplica' WHEN 'Sin información (1)' THEN 'Sin información' ELSE ${column} END`;
}
