# Lending Interest Rates

This pnpm monorepo provides a Node.js 24+ TypeScript CLI (`apps/cli`) for replicating Colombian lending-interest-rate data from the government Socrata portal. It also includes **CrediVá** (`apps/dash`), a dashboard scaffold for exploring historical aggregated credit-rate data. Install dependencies with `pnpm install` and build with `pnpm build`.

The CrediVá chart currently shows fictitious values, not current credit offers or source observations. See [`apps/dash/README.md`](apps/dash/README.md) to run the dashboard.

## Pulling data

```bash
node apps/cli/dist/cli.js pull
```

Use a different destination when needed:

```bash
node apps/cli/dist/cli.js pull --raw-path data/raw
```

Progress is written to stderr as structured `EVENT key=value` lines.

## Sources

The data is published through two Socrata resources:

- Historical: [`w9zh-vetq`](https://www.datos.gov.co/api/views/w9zh-vetq)
- Recent: [`qzsc-9esp`](https://www.datos.gov.co/api/views/qzsc-9esp)

The historical resource behaves as an append-only sequence. The recent resource is replaced as a complete snapshot. `pull` synchronizes recent first, then historical. It treats Socrata intrinsic row IDs as opaque cursors and does not group or reconcile records by reporting date.

## Storage

```text
data/raw/
├── manifest.json
├── historical/
│   └── pages/
│       ├── page-00000001.csv.gz
│       └── page-00000002.csv.gz
└── recent/
    └── current/
        ├── page-00000001.csv.gz
        └── page-00000002.csv.gz
```

Both sources are stored in gzip-compressed CSV pages of at most 50,000 records, ordered by Socrata's intrinsic `:id`. Socrata's gzip response bytes are persisted directly without client decompression or local recompression. Query pages preserve API field names and the `:id`, `:version`, `:created_at`, and `:updated_at` system columns.

The manifest records the path, size, row count, ID boundaries, download time, and exact row counts by `fecha_corte` for every active page. These reporting-date counts form an index for selecting the minimal raw-page set needed to rebuild a monthly projection; synchronization still relies only on intrinsic IDs. Historical also records its append cursor, while recent records the newest ID used for change detection. File and manifest writes use `.partial` files and atomic replacement.

## Synchronization protocol

Historical pages use keyset pagination:

```sql
SELECT *
WHERE `:id` > 'last-id'
ORDER BY `:id`
LIMIT 50000
```

The initial request omits the `WHERE` clause. Every completed page is written durably before its final ID is checkpointed. A response containing fewer than 50,000 records ends the pull; an empty response creates no page.

For the recent source, `pull` first requests its newest intrinsic ID. If that ID differs from the active generation, it downloads a complete set of `query.csv` pages from the beginning into `recent/next`. Pagination state remains in memory. After the final short page, `next` replaces `current` and the manifest records the new active pages and newest ID.

Interrupted historical pulls resume after the last committed page. Interrupted recent downloads retain `current`; the incomplete `next` directory is discarded and downloaded again on the next pull. No retries are performed automatically.

## Parquet collection

Convert raw pages into the analytical collection:

```bash
node apps/cli/dist/cli.js convert
```

Use `--raw-path` and `--parquet-path` to override the default `data/raw` and `data/parquet` locations. Conversion uses DuckDB Node Neo to read candidate raw pages and write each changed month to a staged Parquet file. DuckDB limits managed memory to 8 GB. Structured `READ`, `WRITE`, and `DELETE` events report every data or manifest file used or changed, making incremental work observable.

The analytical collection is unified across both Socrata sources and partitioned by reporting month:

```text
data/parquet/
└── reporting_year=2026/
    └── reporting_month=09/
        └── data.parquet
```

Each partition contains one canonical Zstandard-compressed Parquet file with all business rows for that month. Socrata IDs, versions, timestamps, and source labels remain in raw storage and are not projected into Parquet. Conversion fails if historical and recent contain the same reporting date, because removing provenance would otherwise make those rows ambiguous. When raw data changes, conversion compares the page metadata recorded in `data/parquet/manifest.json` with the raw manifest, uses the `reporting_dates` index to read the exact candidate pages, rebuilds only affected months in staging, validates their expected row counts, and atomically replaces their `data.parquet` files. No content fingerprint is maintained.

### Schema

The publisher describes each row as a weekly aggregate of disbursed credit for one reporting entity and combination of borrower, product, term, guarantee, rate, geography, and economic-activity categories. Rows are not individual credits. The measures are the weighted-average effective rate, total amount, and number of credits disbursed during that week. For UVR products, rates from the 2023-09-29 cutoff onward exclude the change in UVR.

The Socrata title is the metadata `name`; `fieldName` is the identifier used by the API and raw CSV.

| Socrata title                      | Socrata `fieldName`        | Parquet field                     | Meaning                                                                                                                                             | Parquet physical / logical type | Nullable |
| ---------------------------------- | -------------------------- | --------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------- | -------- |
| `Tipo_Entidad`                     | `tipo_entidad`             | `entity_type_code`                | Code for the class of credit institution reporting the weekly aggregate                                                                             | `BYTE_ARRAY / STRING`           | No       |
| `Nombre_Tipo_Entidad`              | `nombre_tipo_entidad`      | `entity_type`                     | Human-readable label for `entity_type_code`                                                                                                         | `BYTE_ARRAY / STRING`           | No       |
| `Codigo_Entidad`                   | `codigo_entidad`           | `entity_code`                     | Source identifier for the reporting credit institution; interpret with `entity_type_code`                                                           | `BYTE_ARRAY / STRING`           | No       |
| `Nombre_Entidad`                   | `nombre_entidad`           | `entity_name`                     | Name of the reporting credit institution                                                                                                            | `BYTE_ARRAY / STRING`           | No       |
| `Fecha_Corte`                      | `fecha_corte`              | `reporting_date`                  | Cutoff date for the week in which the represented credits were disbursed                                                                            | `INT32 / DATE`                  | No       |
| `Tipo_de_persona`                  | `tipo_de_persona`          | `person_type`                     | Whether the borrower is a natural person or legal entity                                                                                            | `BYTE_ARRAY / STRING`           | Yes      |
| `Sexo`                             | `sexo`                     | `sex`                             | Source-reported borrower sex or gender category; may be non-applicable                                                                              | `BYTE_ARRAY / STRING`           | Yes      |
| `Tamaño_de_empresa`                | `tama_o_de_empresa`        | `company_size`                    | Size classification of the borrower when the borrower is a business                                                                                 | `BYTE_ARRAY / STRING`           | Yes      |
| `Tipo_de_crédito`                  | `tipo_de_cr_dito`          | `credit_type`                     | Broad regulatory credit classification, such as consumer, housing, commercial, or productive credit                                                 | `BYTE_ARRAY / STRING`           | Yes      |
| `Tipo_de_garantía`                 | `tipo_de_garant_a`         | `guarantee_type`                  | Category of collateral or guarantee backing the represented credits                                                                                 | `BYTE_ARRAY / STRING`           | Yes      |
| `Producto de crédito`              | `producto_de_cr_dito`      | `credit_product`                  | Detailed lending product within the broad credit classification, including product and placement modality                                           | `BYTE_ARRAY / STRING`           | Yes      |
| `Plazo de crédito`                 | `plazo_de_cr_dito`         | `credit_term`                     | Source-defined maturity or transaction-term bucket for the represented credits                                                                      | `BYTE_ARRAY / STRING`           | Yes      |
| `Tasa_efectiva_promedio_ponderada` | `tasa_efectiva_promedio`   | `weighted_average_effective_rate` | Weighted-average effective interest rate for the represented weekly disbursements, expressed as a percentage; the weighting formula is not declared | `INT32 / DECIMAL(5,2)`          | No       |
| `margen_adicional`                 | `margen_adicional_a_la`    | `additional_margin`               | Source-reported additional spread associated with the rate reference, expressed in percentage points; the formula is not declared                   | `INT32 / DECIMAL(5,2)`          | No       |
| `Montos_desembolsados`             | `montos_desembolsados`     | `disbursed_amount`                | Total monetary amount disbursed during the week for the row's dimensional combination; the metadata does not declare a currency or unit             | `INT64 / DECIMAL(18,2)`         | No       |
| `Numero_de_creditos_desembolsados` | `numero_de_creditos`       | `disbursed_credit_count`          | Number of credits disbursed during the week for the row's dimensional combination                                                                   | `INT64 / INTEGER(64, signed)`   | No       |
| `Grupo_Etnico`                     | `grupo_etnico`             | `ethnic_group`                    | Source-reported ethnic-group category associated with the borrower                                                                                  | `BYTE_ARRAY / STRING`           | Yes      |
| `Antiguedad_de_la_empresa`         | `antiguedad_de_la_empresa` | `company_age`                     | Age band of the borrower business; non-applicable to other borrowers                                                                                | `BYTE_ARRAY / STRING`           | Yes      |
| `Tipo_de_Tasa`                     | `tipo_de_tasa`             | `rate_type`                       | Pricing basis or reference index for the rate, including fixed and indexed-rate codes                                                               | `BYTE_ARRAY / STRING`           | Yes      |
| `Rango_monto_desembolsado`         | `rango_monto_desembolsado` | `disbursed_amount_range`          | Source-defined disbursement-size bucket, generally expressed in current legal monthly minimum wages (`SMLMV`)                                       | `BYTE_ARRAY / STRING`           | Yes      |
| `Clase_deudor`                     | `clase_deudor`             | `debtor_class`                    | Whether the borrower is existing at or new to the reporting institution                                                                             | `BYTE_ARRAY / STRING`           | Yes      |
| `Codigo_CIIU`                      | `codigo_ciiu`              | `ciiu_code`                       | CIIU code for the economic activity associated with the borrower or aggregate                                                                       | `BYTE_ARRAY / STRING`           | Yes      |
| `Codigo_Municipio`                 | `codigo_municipio`         | `municipality_code`               | Municipality code attached to the aggregate; the metadata does not define whether it identifies the borrower, branch, or disbursement location      | `BYTE_ARRAY / STRING`           | Yes      |

The raw query also contains four Socrata system fields. They support synchronization and provenance but are not projected into the analytical file:

| Raw field     | Meaning                                                    | Parquet mapping |
| ------------- | ---------------------------------------------------------- | --------------- |
| `:id`         | Opaque intrinsic row identifier and synchronization cursor | Omitted         |
| `:version`    | Opaque intrinsic row version                               | Omitted         |
| `:created_at` | Socrata row creation timestamp                             | Omitted         |
| `:updated_at` | Socrata row update timestamp                               | Omitted         |

Identifiers remain strings so leading zeros are preserved. Rates are rounded to two decimals before exact decimal conversion; zero remains valid. The exact literal `N/A` becomes null. Source footnote markers are normalized only through explicit mappings: `No aplica(1)` becomes `No aplica`, and `Sin información (1)` becomes `Sin información`; all other categories remain unchanged. Hive readers derive `reporting_year` and `reporting_month` from directory names.

Rows are sorted ascending by `reporting_date`, `credit_product`, `entity_type_code`, and `entity_code`, with nulls last. This supports weekly, product, and entity filtering without making the physical order depend on every analytical dimension.

## Development

Tests exercise commands through boundary implementations, Socrata through a local HTTP server, and storage through temporary directories.

Run the project checks with:

```bash
pnpm format:check
pnpm lint
pnpm test
pnpm typecheck
pnpm build
git diff --check
```
