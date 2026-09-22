import gzip
from collections.abc import AsyncIterator
from datetime import UTC, datetime
from pathlib import Path

from lending_interest_rates.storage.raw import RawStorage, StoredPage


async def chunks(*values: bytes) -> AsyncIterator[bytes]:
    for value in values:
        yield value


async def test_writes_and_describes_a_historical_page_atomically(
    tmp_path: Path,
) -> None:
    storage = RawStorage(
        tmp_path,
        clock=lambda: datetime(2026, 9, 21, tzinfo=UTC),
    )
    csv = b":id,value\nrow-first,1\nrow-last,2\n"
    compressed = gzip.compress(csv, mtime=0)

    page = await storage.write_historical_page(1, chunks(compressed))

    assert page == StoredPage(
        path="historical/pages/page-00000001.csv.gz",
        row_count=2,
        size=len(compressed),
        first_id="row-first",
        last_id="row-last",
        downloaded_at=datetime(2026, 9, 21, tzinfo=UTC),
    )
    assert gzip.decompress((tmp_path / page.path).read_bytes()) == csv
    assert not (tmp_path / f"{page.path}.partial").exists()


async def test_writes_a_recent_page_into_next(tmp_path: Path) -> None:
    storage = RawStorage(
        tmp_path,
        clock=lambda: datetime(2026, 9, 21, tzinfo=UTC),
    )
    csv = b":id,value\nrow-current,42\n"
    compressed = gzip.compress(csv, mtime=0)

    page = await storage.write_recent_page(1, chunks(compressed))

    assert page == StoredPage(
        path="recent/next/page-00000001.csv.gz",
        row_count=1,
        size=len(compressed),
        first_id="row-current",
        last_id="row-current",
        downloaded_at=datetime(2026, 9, 21, tzinfo=UTC),
    )
    assert gzip.decompress((tmp_path / page.path).read_bytes()) == csv
    assert not (tmp_path / f"{page.path}.partial").exists()


async def test_activates_recent_next_and_preserves_current_until_cleanup(
    tmp_path: Path,
) -> None:
    storage = RawStorage(tmp_path)
    current = tmp_path / "recent" / "current"
    current.mkdir(parents=True)
    (current / "page-00000001.csv.gz").write_bytes(b"old")
    compressed = gzip.compress(b":id,value\nrow-new,1\n", mtime=0)
    next_page = await storage.write_recent_page(1, chunks(compressed))
    assert next_page is not None

    active_pages = storage.activate_recent((next_page,))

    assert active_pages[0].path == "recent/current/page-00000001.csv.gz"
    assert gzip.decompress((tmp_path / active_pages[0].path).read_bytes()) == (
        b":id,value\nrow-new,1\n"
    )
    assert (tmp_path / "recent/previous/page-00000001.csv.gz").read_bytes() == b"old"

    storage.discard_previous_recent()

    assert not (tmp_path / "recent/previous").exists()
