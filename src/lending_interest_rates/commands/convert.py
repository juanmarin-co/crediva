import shutil
from collections import defaultdict
from collections.abc import Callable
from datetime import UTC, date, datetime
from pathlib import Path

import duckdb

from ..storage.parquet_manifest import (
    ParquetManifest,
    ParquetManifestStorage,
    ParquetPartition,
    RawPageInput,
)
from ..storage.raw_manifest import RawManifestStorage
from ..storage.raw_pages import RawPage, ReportingDateCount

SCHEMA_VERSION = 2
MEMORY_LIMIT = "8GB"
Progress = Callable[[str, dict[str, object]], None]

NORMALIZED_COLUMNS = {
    "credit_product": "producto_de_cr_dito",
    "entity_type_code": "tipo_entidad",
    "entity_type": "nombre_tipo_entidad",
    "entity_code": "codigo_entidad",
    "entity_name": "nombre_entidad",
    "credit_type": "tipo_de_cr_dito",
    "person_type": "tipo_de_persona",
    "sex": "sexo",
    "company_size": "tama_o_de_empresa",
    "guarantee_type": "tipo_de_garant_a",
    "credit_term": "plazo_de_cr_dito",
    "ethnic_group": "grupo_etnico",
    "company_age": "antiguedad_de_la_empresa",
    "rate_type": "tipo_de_tasa",
    "disbursed_amount_range": "rango_monto_desembolsado",
    "debtor_class": "clase_deudor",
    "ciiu_code": "codigo_ciiu",
    "municipality_code": "codigo_municipio",
}


def ignore_progress(_event: str, _values: dict[str, object]) -> None:
    pass


def convert(
    *,
    raw_path: Path,
    parquet_path: Path,
    clock: Callable[[], datetime] = lambda: datetime.now(UTC),
    progress: Progress = ignore_progress,
) -> None:
    raw_manifest_path = raw_path / "manifest.json"
    progress("READ", {"path": raw_manifest_path, "kind": "raw_manifest"})
    raw_manifest = RawManifestStorage(raw_manifest_path).load()
    if raw_manifest is None:
        raise FileNotFoundError(f"Raw manifest does not exist: {raw_manifest_path}")

    source_pages = (
        (
            "historical",
            raw_manifest.historical.dataset_id,
            raw_manifest.historical.pages,
        ),
        ("recent", raw_manifest.recent.dataset_id, raw_manifest.recent.pages),
    )
    validate_raw_pages(raw_path, source_pages)
    desired_inputs = index_month_inputs(source_pages)

    parquet_manifest_path = parquet_path / "manifest.json"
    manifest_storage = ParquetManifestStorage(parquet_manifest_path)
    if parquet_manifest_path.exists():
        progress(
            "READ",
            {"path": parquet_manifest_path, "kind": "parquet_manifest"},
        )
    previous = manifest_storage.load()
    previous_partitions = (
        {
            (item.reporting_year, item.reporting_month): item
            for item in previous.partitions
        }
        if previous is not None
        else {}
    )
    unchanged: dict[tuple[int, int], ParquetPartition] = {}
    changed: set[tuple[int, int]] = set()
    for key, inputs in desired_inputs.items():
        stored = previous_partitions.get(key)
        if (
            previous is not None
            and previous.schema_version == SCHEMA_VERSION
            and stored is not None
            and stored.inputs == inputs
            and partition_is_complete(parquet_path, stored)
        ):
            unchanged[key] = stored
            progress("UNCHANGED", {"month": format_month(key)})
        else:
            changed.add(key)

    stale = set(previous_partitions) - set(desired_inputs)
    if not changed and not stale:
        return

    staging = parquet_path / ".staging"
    temp_directory = parquet_path / ".duckdb-tmp"
    shutil.rmtree(staging, ignore_errors=True)
    shutil.rmtree(temp_directory, ignore_errors=True)
    staging.mkdir(parents=True, exist_ok=True)
    temp_directory.mkdir(parents=True, exist_ok=True)
    converted: dict[tuple[int, int], ParquetPartition] = {}
    conversion_succeeded = not changed
    if changed:
        raw_files = tuple(
            dict.fromkeys(
                raw_path / item.path
                for key in sorted(changed)
                for item in desired_inputs[key]
            )
        )
        for path in raw_files:
            progress("READ", {"path": path, "kind": "raw_page"})

        connection = duckdb.connect()
        try:
            configure_duckdb(connection, temp_directory)
            written = write_changed_months(
                connection,
                input_paths=raw_files,
                output_directory=staging,
                months=tuple(sorted(changed)),
            )
            for key in sorted(changed):
                generated_path, row_count = written[key]
                expected_rows = sum(
                    count.row_count
                    for item in desired_inputs[key]
                    for count in item.reporting_dates
                )
                if row_count != expected_rows:
                    raise ValueError(
                        f"Converted row count for {format_month(key)} is "
                        f"{row_count}, expected {expected_rows}"
                    )
                staged = month_path(staging, *key)
                generated_path.replace(staged)
                converted[key] = ParquetPartition(
                    reporting_year=key[0],
                    reporting_month=key[1],
                    path=str(month_path(parquet_path, *key).relative_to(parquet_path)),
                    row_count=row_count,
                    size_bytes=staged.stat().st_size,
                    inputs=desired_inputs[key],
                )
            conversion_succeeded = True
        finally:
            connection.close()
            shutil.rmtree(temp_directory, ignore_errors=True)
            if not conversion_succeeded:
                shutil.rmtree(staging, ignore_errors=True)

    try:
        for key in sorted(changed):
            target = month_path(parquet_path, *key)
            target.parent.mkdir(parents=True, exist_ok=True)
            month_path(staging, *key).replace(target)
            progress(
                "WRITE",
                {
                    "path": target,
                    "kind": "parquet_partition",
                    "rows": converted[key].row_count,
                },
            )
            progress(
                "CONVERTED",
                {"month": format_month(key), "rows": converted[key].row_count},
            )

        for key in sorted(stale):
            path = month_path(parquet_path, *key)
            remove_partition(parquet_path, key)
            progress("DELETE", {"path": path, "kind": "parquet_partition"})
            progress("REMOVED", {"month": format_month(key)})

        partitions = tuple(
            (converted | unchanged)[key] for key in sorted(desired_inputs)
        )
        manifest_storage.save(ParquetManifest(SCHEMA_VERSION, clock(), partitions))
        progress(
            "WRITE",
            {"path": parquet_manifest_path, "kind": "parquet_manifest"},
        )
    finally:
        shutil.rmtree(staging, ignore_errors=True)


def configure_duckdb(
    connection: duckdb.DuckDBPyConnection,
    temp_directory: Path,
) -> None:
    connection.execute(f"SET memory_limit = {sql_literal(MEMORY_LIMIT)}")
    connection.execute(f"SET temp_directory = {sql_literal(str(temp_directory))}")


def write_changed_months(
    connection: duckdb.DuckDBPyConnection,
    *,
    input_paths: tuple[Path, ...],
    output_directory: Path,
    months: tuple[tuple[int, int], ...],
) -> dict[tuple[int, int], tuple[Path, int]]:
    projections = ",\n                ".join(
        f"{normalized(source)} AS {target}"
        for target, source in NORMALIZED_COLUMNS.items()
    )
    query = f"""
        COPY (
            WITH projected AS (
                SELECT
                    {projections},
                    CAST(fecha_corte AS DATE) AS reporting_date,
                    CAST(
                        round(CAST(tasa_efectiva_promedio AS DECIMAL(38, 18)), 2)
                        AS DECIMAL(5, 2)
                    ) AS weighted_average_effective_rate,
                    CAST(
                        round(CAST(margen_adicional_a_la AS DECIMAL(38, 18)), 2)
                        AS DECIMAL(5, 2)
                    ) AS additional_margin,
                    CAST(
                        round(CAST(montos_desembolsados AS DECIMAL(38, 18)), 2)
                        AS DECIMAL(18, 2)
                    ) AS disbursed_amount,
                    CAST(numero_de_creditos AS BIGINT) AS disbursed_credit_count,
                    strftime(CAST(fecha_corte AS DATE), '%Y') AS reporting_year,
                    strftime(CAST(fecha_corte AS DATE), '%m') AS reporting_month
                FROM read_csv(
                    ?,
                    header = true,
                    all_varchar = true,
                    compression = 'gzip',
                    union_by_name = true
                )
            )
            SELECT
                credit_product,
                reporting_date,
                entity_type_code,
                entity_type,
                entity_code,
                entity_name,
                credit_type,
                person_type,
                sex,
                company_size,
                guarantee_type,
                credit_term,
                weighted_average_effective_rate,
                additional_margin,
                disbursed_amount,
                disbursed_credit_count,
                ethnic_group,
                company_age,
                rate_type,
                disbursed_amount_range,
                debtor_class,
                ciiu_code,
                municipality_code,
                reporting_year,
                reporting_month
            FROM projected
            WHERE (reporting_year, reporting_month) IN (
                VALUES {", ".join("(?, ?)" for _month in months)}
            )
            ORDER BY
                reporting_year,
                reporting_month,
                reporting_date ASC NULLS LAST,
                credit_product ASC NULLS LAST,
                entity_type_code ASC NULLS LAST,
                entity_code ASC NULLS LAST
        ) TO {sql_literal(str(output_directory))} (
            FORMAT PARQUET,
            COMPRESSION ZSTD,
            PARTITION_BY (reporting_year, reporting_month),
            FILENAME_PATTERN 'data',
            RETURN_STATS
        )
    """
    parameters: list[object] = [[str(path) for path in input_paths]]
    for year, month in months:
        parameters.extend((f"{year:04d}", f"{month:02d}"))
    results = connection.execute(query, parameters).fetchall()
    written: dict[tuple[int, int], tuple[Path, int]] = {}
    for filename, row_count, *_statistics, partition_keys in results:
        key = (
            int(partition_keys["reporting_year"]),
            int(partition_keys["reporting_month"]),
        )
        if key in written:
            raise ValueError(f"DuckDB wrote multiple files for {format_month(key)}")
        written[key] = (Path(filename), int(row_count))
    missing = set(months) - set(written)
    unexpected = set(written) - set(months)
    if missing or unexpected:
        raise ValueError(
            f"DuckDB wrote unexpected monthly partitions: "
            f"missing={sorted(missing)}, unexpected={sorted(unexpected)}"
        )
    return written


def normalized(column: str) -> str:
    return (
        f"CASE {column} "
        "WHEN 'N/A' THEN NULL "
        "WHEN 'No aplica(1)' THEN 'No aplica' "
        "WHEN 'Sin información (1)' THEN 'Sin información' "
        f"ELSE {column} END"
    )


def sql_literal(value: str) -> str:
    return "'" + value.replace("'", "''") + "'"


def validate_raw_pages(
    raw_path: Path,
    source_pages: tuple[tuple[str, str, tuple[RawPage, ...]], ...],
) -> None:
    reporting_date_sources: dict[date, set[str]] = defaultdict(set)
    for source_name, _dataset_id, pages in source_pages:
        for page in pages:
            path = raw_path / page.path
            if not path.is_file() or path.stat().st_size != page.size_bytes:
                raise ValueError(f"Raw page is incomplete: {page.path}")
            for item in page.reporting_dates:
                reporting_date_sources[item.reporting_date].add(source_name)
    overlaps = sorted(
        value for value, sources in reporting_date_sources.items() if len(sources) > 1
    )
    if overlaps:
        raise ValueError(
            "Historical and recent sources overlap on reporting date "
            f"{overlaps[0].isoformat()}"
        )


def index_month_inputs(
    source_pages: tuple[tuple[str, str, tuple[RawPage, ...]], ...],
) -> dict[tuple[int, int], tuple[RawPageInput, ...]]:
    indexed: dict[tuple[int, int], list[RawPageInput]] = defaultdict(list)
    for source_name, dataset_id, pages in source_pages:
        for page in pages:
            dates_by_month: dict[tuple[int, int], list[ReportingDateCount]] = (
                defaultdict(list)
            )
            for item in page.reporting_dates:
                key = (item.reporting_date.year, item.reporting_date.month)
                dates_by_month[key].append(item)
            for key, reporting_dates in dates_by_month.items():
                indexed[key].append(
                    RawPageInput(
                        source_name=source_name,
                        dataset_id=dataset_id,
                        path=page.path,
                        row_count=page.row_count,
                        size_bytes=page.size_bytes,
                        first_id=page.first_id,
                        last_id=page.last_id,
                        downloaded_at=page.downloaded_at,
                        reporting_dates=tuple(reporting_dates),
                    )
                )
    return {key: tuple(value) for key, value in indexed.items()}


def format_month(key: tuple[int, int]) -> str:
    return f"{key[0]:04d}-{key[1]:02d}"


def month_path(root: Path, year: int, month: int) -> Path:
    return (
        root
        / f"reporting_year={year:04d}"
        / f"reporting_month={month:02d}"
        / "data.parquet"
    )


def partition_is_complete(root: Path, partition: ParquetPartition) -> bool:
    path = root / partition.path
    return path.is_file() and path.stat().st_size == partition.size_bytes


def remove_partition(root: Path, key: tuple[int, int]) -> None:
    partition_directory = month_path(root, *key).parent
    shutil.rmtree(partition_directory, ignore_errors=True)
    year_directory = partition_directory.parent
    if year_directory.exists() and not any(year_directory.iterdir()):
        year_directory.rmdir()
