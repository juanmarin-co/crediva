import gzip
import os
from datetime import UTC, date, datetime
from decimal import Decimal
from pathlib import Path

import duckdb
import pytest

from lending_interest_rates.commands.convert import convert
from lending_interest_rates.storage.raw_manifest import (
    HistoricalSourceState,
    RawManifest,
    RawManifestStorage,
    RecentSourceState,
)
from lending_interest_rates.storage.raw_pages import RawPage, inspect_raw_page

HEADER = (
    ":id,:version,:created_at,:updated_at,tipo_entidad,nombre_tipo_entidad,"
    "codigo_entidad,nombre_entidad,fecha_corte,tipo_de_persona,sexo,"
    "tama_o_de_empresa,tipo_de_cr_dito,tipo_de_garant_a,producto_de_cr_dito,"
    "plazo_de_cr_dito,tasa_efectiva_promedio,margen_adicional_a_la,"
    "montos_desembolsados,numero_de_creditos,grupo_etnico,"
    "antiguedad_de_la_empresa,tipo_de_tasa,rango_monto_desembolsado,"
    "clase_deudor,codigo_ciiu,codigo_municipio\n"
)


def read_parquet_rows(path: Path) -> list[dict[str, object]]:
    connection = duckdb.connect()
    try:
        result = connection.execute(
            "SELECT * FROM read_parquet(?, hive_partitioning = false)",
            [str(path)],
        )
        columns = [item[0] for item in result.description]
        return [dict(zip(columns, row, strict=True)) for row in result.fetchall()]
    finally:
        connection.close()


def store_page(root: Path, relative: str, rows: list[str]) -> RawPage:
    path = root / relative
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_bytes(gzip.compress((HEADER + "".join(rows)).encode(), mtime=0))
    row_count, first_id, last_id, reporting_dates = inspect_raw_page(path)
    assert first_id is not None and last_id is not None
    return RawPage(
        relative,
        row_count,
        path.stat().st_size,
        first_id,
        last_id,
        datetime(2026, 9, 21, tzinfo=UTC),
        reporting_dates,
    )


def save_manifest(
    root: Path,
    *,
    historical: tuple[RawPage, ...] = (),
    recent: tuple[RawPage, ...] = (),
) -> None:
    RawManifestStorage(root / "manifest.json").save(
        RawManifest(
            datetime(2026, 9, 21, tzinfo=UTC),
            HistoricalSourceState("w9zh-vetq", None, historical),
            RecentSourceState("qzsc-9esp", None, recent),
        )
    )


def test_convert_writes_a_monthly_analytical_partition(tmp_path: Path) -> None:
    raw = tmp_path / "raw"
    output = tmp_path / "parquet"
    page = store_page(
        raw,
        "historical/pages/page-00000001.csv.gz",
        [
            (
                "row-1,1,0,0,01,Bancos,0007,Banco Uno,"
                "2026-09-04T00:00:00.000,Natural,N/A,No aplica(1),Consumo,"
                "Hipotecaria,Libranza,12 meses,12.345,0,1000.50,2,"
                "Sin información (1),N/A,Fija,0-1M,Deudor,0010,05001\n"
            )
        ],
    )
    save_manifest(raw, historical=(page,))

    convert(raw_path=raw, parquet_path=output)

    partition = output / "reporting_year=2026/reporting_month=09/data.parquet"
    physical_schema = {
        name: physical_type
        for name, physical_type in duckdb.sql(
            "SELECT name, type FROM parquet_schema(?)", params=[str(partition)]
        ).fetchall()
    }
    assert physical_schema["weighted_average_effective_rate"] == "INT32"
    assert physical_schema["disbursed_amount"] == "INT64"
    compression = duckdb.sql(
        "SELECT DISTINCT compression FROM parquet_metadata(?)",
        params=[str(partition)],
    ).fetchall()
    assert compression == [("ZSTD",)]
    assert read_parquet_rows(partition) == [
        {
            "credit_product": "Libranza",
            "reporting_date": date(2026, 9, 4),
            "entity_type_code": "01",
            "entity_type": "Bancos",
            "entity_code": "0007",
            "entity_name": "Banco Uno",
            "credit_type": "Consumo",
            "person_type": "Natural",
            "sex": None,
            "company_size": "No aplica",
            "guarantee_type": "Hipotecaria",
            "credit_term": "12 meses",
            "weighted_average_effective_rate": Decimal("12.35"),
            "additional_margin": Decimal("0.00"),
            "disbursed_amount": Decimal("1000.50"),
            "disbursed_credit_count": 2,
            "ethnic_group": "Sin información",
            "company_age": None,
            "rate_type": "Fija",
            "disbursed_amount_range": "0-1M",
            "debtor_class": "Deudor",
            "ciiu_code": "0010",
            "municipality_code": "05001",
        }
    ]
    assert (output / "manifest.json").is_file()


def test_convert_reads_a_shared_raw_page_once_for_multiple_months(
    tmp_path: Path,
) -> None:
    raw = tmp_path / "raw"
    output = tmp_path / "parquet"
    page = store_page(
        raw,
        "historical/pages/page-00000001.csv.gz",
        [
            (
                "row-1,1,0,0,01,Bancos,0007,Banco Uno,"
                "2026-09-04T00:00:00.000,Natural,N/A,No aplica,Consumo,"
                "Hipotecaria,Libranza,12 meses,12.34,0,1000.00,2,N/A,N/A,"
                "Fija,0-1M,Deudor,0010,05001\n"
            ),
            (
                "row-2,1,0,0,01,Bancos,0007,Banco Uno,"
                "2026-10-02T00:00:00.000,Natural,N/A,No aplica,Consumo,"
                "Hipotecaria,Libranza,12 meses,12.34,0,2000.00,3,N/A,N/A,"
                "Fija,0-1M,Deudor,0010,05001\n"
            ),
        ],
    )
    save_manifest(raw, historical=(page,))
    events: list[tuple[str, dict[str, object]]] = []

    convert(
        raw_path=raw,
        parquet_path=output,
        progress=lambda event, values: events.append((event, values)),
    )

    raw_page_reads = [
        values["path"]
        for event, values in events
        if event == "READ" and values["kind"] == "raw_page"
    ]
    assert raw_page_reads == [raw / page.path]
    assert read_parquet_rows(
        output / "reporting_year=2026/reporting_month=09/data.parquet"
    )[0]["disbursed_amount"] == Decimal("1000.00")
    assert read_parquet_rows(
        output / "reporting_year=2026/reporting_month=10/data.parquet"
    )[0]["disbursed_amount"] == Decimal("2000.00")


def test_convert_does_not_rewrite_an_unchanged_month(tmp_path: Path) -> None:
    raw = tmp_path / "raw"
    output = tmp_path / "parquet"
    page = store_page(
        raw,
        "historical/pages/page-00000001.csv.gz",
        [
            (
                "row-1,1,0,0,01,Bancos,0007,Banco Uno,"
                "2026-09-04T00:00:00.000,Natural,N/A,No aplica,Consumo,"
                "Hipotecaria,Libranza,12 meses,12.34,0,1000.50,2,N/A,N/A,"
                "Fija,0-1M,Deudor,0010,05001\n"
            )
        ],
    )
    save_manifest(raw, historical=(page,))
    convert(raw_path=raw, parquet_path=output)
    partition = output / "reporting_year=2026/reporting_month=09/data.parquet"
    output_manifest = output / "manifest.json"
    os.utime(partition, ns=(1_000_000_000, 1_000_000_000))
    os.utime(output_manifest, ns=(1_000_000_000, 1_000_000_000))
    events: list[tuple[str, dict[str, object]]] = []

    convert(
        raw_path=raw,
        parquet_path=output,
        progress=lambda event, values: events.append((event, values)),
    )

    assert [item for item in events if item[0] in {"READ", "WRITE"}] == [
        ("READ", {"path": raw / "manifest.json", "kind": "raw_manifest"}),
        (
            "READ",
            {"path": output_manifest, "kind": "parquet_manifest"},
        ),
    ]
    assert partition.stat().st_mtime_ns == 1_000_000_000
    assert output_manifest.stat().st_mtime_ns == 1_000_000_000


def test_convert_rebuilds_only_a_month_with_changed_inputs(tmp_path: Path) -> None:
    raw = tmp_path / "raw"
    output = tmp_path / "parquet"
    september_path = "historical/pages/page-00000001.csv.gz"
    october_path = "historical/pages/page-00000002.csv.gz"
    september = store_page(
        raw,
        september_path,
        [
            (
                "row-1,1,0,0,01,Bancos,0007,Banco Uno,"
                "2026-09-04T00:00:00.000,Natural,N/A,No aplica,Consumo,"
                "Hipotecaria,Libranza,12 meses,12.34,0,1000.50,2,N/A,N/A,"
                "Fija,0-1M,Deudor,0010,05001\n"
            )
        ],
    )
    october = store_page(
        raw,
        october_path,
        [
            (
                "row-2,1,0,0,01,Bancos,0007,Banco Uno,"
                "2026-10-02T00:00:00.000,Natural,N/A,No aplica,Consumo,"
                "Hipotecaria,Libranza,12 meses,12.34,0,2000.00,3,N/A,N/A,"
                "Fija,0-1M,Deudor,0010,05001\n"
            )
        ],
    )
    save_manifest(raw, historical=(september, october))
    convert(raw_path=raw, parquet_path=output)
    september_output = output / "reporting_year=2026/reporting_month=09/data.parquet"
    october_output = output / "reporting_year=2026/reporting_month=10/data.parquet"
    os.utime(september_output, ns=(1_000_000_000, 1_000_000_000))
    os.utime(october_output, ns=(1_000_000_000, 1_000_000_000))
    september = store_page(
        raw,
        september_path,
        [
            (
                "row-1,2,0,0,01,Bancos,0007,Banco Uno,"
                "2026-09-04T00:00:00.000,Natural,N/A,No aplica,Consumo,"
                "Hipotecaria,Libranza,12 meses,12.34,0,1500.00,2,N/A,N/A,"
                "Fija,0-1M,Deudor,0010,05001\n"
            )
        ],
    )
    save_manifest(raw, historical=(september, october))
    events: list[tuple[str, dict[str, object]]] = []

    convert(
        raw_path=raw,
        parquet_path=output,
        progress=lambda event, values: events.append((event, values)),
    )

    file_events = [item for item in events if item[0] in {"READ", "WRITE"}]
    assert file_events == [
        ("READ", {"path": raw / "manifest.json", "kind": "raw_manifest"}),
        (
            "READ",
            {"path": output / "manifest.json", "kind": "parquet_manifest"},
        ),
        ("READ", {"path": raw / september_path, "kind": "raw_page"}),
        (
            "WRITE",
            {
                "path": september_output,
                "kind": "parquet_partition",
                "rows": 1,
            },
        ),
        (
            "WRITE",
            {"path": output / "manifest.json", "kind": "parquet_manifest"},
        ),
    ]
    assert september_output.stat().st_mtime_ns != 1_000_000_000
    assert october_output.stat().st_mtime_ns == 1_000_000_000
    september_rows = read_parquet_rows(september_output)
    assert september_rows[0]["disbursed_amount"] == Decimal("1500.00")


def test_convert_refuses_ambiguous_reporting_dates_without_changing_output(
    tmp_path: Path,
) -> None:
    raw = tmp_path / "raw"
    output = tmp_path / "parquet"
    historical = store_page(
        raw,
        "historical/pages/page-00000001.csv.gz",
        [
            (
                "row-h,1,0,0,01,Bancos,0007,Banco Uno,"
                "2026-09-04T00:00:00.000,Natural,N/A,No aplica,Consumo,"
                "Hipotecaria,Libranza,12 meses,12.34,0,1000.00,2,N/A,N/A,"
                "Fija,0-1M,Deudor,0010,05001\n"
            )
        ],
    )
    save_manifest(raw, historical=(historical,))
    convert(raw_path=raw, parquet_path=output)
    partition = output / "reporting_year=2026/reporting_month=09/data.parquet"
    original = partition.read_bytes()
    recent = store_page(
        raw,
        "recent/current/page-00000001.csv.gz",
        [
            (
                "row-r,1,0,0,01,Bancos,0007,Banco Uno,"
                "2026-09-04T00:00:00.000,Natural,N/A,No aplica,Consumo,"
                "Hipotecaria,Libranza,12 meses,12.34,0,2000.00,3,N/A,N/A,"
                "Fija,0-1M,Deudor,0010,05001\n"
            )
        ],
    )
    save_manifest(raw, historical=(historical,), recent=(recent,))

    with pytest.raises(ValueError, match="overlap.*2026-09-04"):
        convert(raw_path=raw, parquet_path=output)

    assert partition.read_bytes() == original


def test_convert_removes_a_month_no_longer_present_in_raw_data(
    tmp_path: Path,
) -> None:
    raw = tmp_path / "raw"
    output = tmp_path / "parquet"
    page = store_page(
        raw,
        "recent/current/page-00000001.csv.gz",
        [
            (
                "row-r,1,0,0,01,Bancos,0007,Banco Uno,"
                "2026-09-04T00:00:00.000,Natural,N/A,No aplica,Consumo,"
                "Hipotecaria,Libranza,12 meses,12.34,0,2000.00,3,N/A,N/A,"
                "Fija,0-1M,Deudor,0010,05001\n"
            )
        ],
    )
    save_manifest(raw, recent=(page,))
    convert(raw_path=raw, parquet_path=output)
    partition = output / "reporting_year=2026/reporting_month=09/data.parquet"
    save_manifest(raw)

    convert(raw_path=raw, parquet_path=output)

    assert not partition.exists()
