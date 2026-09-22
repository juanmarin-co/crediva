import gzip
from collections.abc import AsyncIterator
from datetime import UTC, date, datetime
from pathlib import Path

from lending_interest_rates.storage.raw_pages import (
    RawPage,
    RawPageStorage,
    ReportingDateCount,
)


async def chunks(*values: bytes) -> AsyncIterator[bytes]:
    for value in values:
        yield value


async def test_writes_and_describes_a_historical_page_atomically(
    tmp_path: Path,
) -> None:
    storage = RawPageStorage(
        tmp_path,
        clock=lambda: datetime(2026, 9, 21, tzinfo=UTC),
    )
    csv = (
        b":id,fecha_corte,value\n"
        b"row-first,2026-09-11T00:00:00.000,1\n"
        b"row-last,2026-09-18T00:00:00.000,2\n"
    )
    compressed = gzip.compress(csv, mtime=0)

    page = await storage.write_historical_page(1, chunks(compressed))

    assert page == RawPage(
        path="historical/pages/page-00000001.csv.gz",
        row_count=2,
        size_bytes=len(compressed),
        first_id="row-first",
        last_id="row-last",
        downloaded_at=datetime(2026, 9, 21, tzinfo=UTC),
        reporting_dates=(
            ReportingDateCount(date(2026, 9, 11), 1),
            ReportingDateCount(date(2026, 9, 18), 1),
        ),
    )
    assert gzip.decompress((tmp_path / page.path).read_bytes()) == csv
    assert not (tmp_path / f"{page.path}.partial").exists()


async def test_writes_a_recent_page_into_next(tmp_path: Path) -> None:
    storage = RawPageStorage(
        tmp_path,
        clock=lambda: datetime(2026, 9, 21, tzinfo=UTC),
    )
    csv = b":id,fecha_corte,value\nrow-current,2026-09-11T00:00:00.000,42\n"
    compressed = gzip.compress(csv, mtime=0)

    page = await storage.write_recent_page(1, chunks(compressed))

    assert page == RawPage(
        path="recent/next/page-00000001.csv.gz",
        row_count=1,
        size_bytes=len(compressed),
        first_id="row-current",
        last_id="row-current",
        downloaded_at=datetime(2026, 9, 21, tzinfo=UTC),
        reporting_dates=(ReportingDateCount(date(2026, 9, 11), 1),),
    )
    assert gzip.decompress((tmp_path / page.path).read_bytes()) == csv
    assert not (tmp_path / f"{page.path}.partial").exists()


async def test_activates_recent_next_and_preserves_current_until_cleanup(
    tmp_path: Path,
) -> None:
    storage = RawPageStorage(tmp_path)
    current = tmp_path / "recent" / "current"
    current.mkdir(parents=True)
    (current / "page-00000001.csv.gz").write_bytes(b"old")
    compressed = gzip.compress(
        b":id,fecha_corte,value\nrow-new,2026-09-11T00:00:00.000,1\n",
        mtime=0,
    )
    next_page = await storage.write_recent_page(1, chunks(compressed))
    assert next_page is not None

    active_pages = storage.activate_next_recent_generation((next_page,))

    assert active_pages[0].path == "recent/current/page-00000001.csv.gz"
    assert gzip.decompress((tmp_path / active_pages[0].path).read_bytes()) == (
        b":id,fecha_corte,value\nrow-new,2026-09-11T00:00:00.000,1\n"
    )
    assert (tmp_path / "recent/previous/page-00000001.csv.gz").read_bytes() == b"old"

    storage.discard_previous_recent_generation()

    assert not (tmp_path / "recent/previous").exists()
