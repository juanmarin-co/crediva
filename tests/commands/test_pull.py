import gzip
from collections.abc import AsyncIterator
from datetime import UTC, datetime
from pathlib import Path

import pytest

from lending_interest_rates.commands.pull import pull
from lending_interest_rates.socrata.client import Dataset
from lending_interest_rates.storage.raw_manifest import RawManifestStorage
from lending_interest_rates.storage.raw_pages import RawPageStorage


def compressed(value: bytes) -> bytes:
    return gzip.compress(value, mtime=0)


class Socrata:
    def __init__(self) -> None:
        self.operations: list[tuple[str, str | None]] = []
        self.historical_pages = {
            None: compressed(
                b":id,fecha_corte,value\n"
                b"row-h1,2026-06-19T00:00:00.000,1\n"
                b"row-h2,2026-06-19T00:00:00.000,2\n"
            ),
            "row-h2": compressed(
                b":id,fecha_corte,value\nrow-h3,2026-06-26T00:00:00.000,3\n"
            ),
        }
        self.recent_pages = {
            None: compressed(
                b":id,fecha_corte,value\n"
                b"row-r1,2026-09-04T00:00:00.000,1\n"
                b"row-r2,2026-09-04T00:00:00.000,2\n"
            ),
            "row-r2": compressed(
                b":id,fecha_corte,value\nrow-r3,2026-09-11T00:00:00.000,3\n"
            ),
        }

    async def newest_id(self, dataset: Dataset) -> str:
        self.operations.append(("newest", dataset.name))
        return "row-r3"

    async def stream_page_csv(
        self,
        dataset: Dataset,
        *,
        after_id: str | None,
        limit: int,
    ) -> AsyncIterator[bytes]:
        self.operations.append((dataset.name, after_id))
        pages = (
            self.historical_pages if dataset.name == "historical" else self.recent_pages
        )
        yield pages[after_id]


async def test_pull_bootstraps_recent_then_historical_pages(tmp_path: Path) -> None:
    socrata = Socrata()
    manifest_storage = RawManifestStorage(tmp_path / "manifest.json")
    events: list[tuple[str, dict[str, object]]] = []

    await pull(
        historical=Dataset("historical", "w9zh-vetq"),
        recent=Dataset("recent", "qzsc-9esp"),
        socrata=socrata,
        raw_pages=RawPageStorage(
            tmp_path,
            clock=lambda: datetime(2026, 9, 21, tzinfo=UTC),
        ),
        manifest_storage=manifest_storage,
        page_size=2,
        clock=lambda: datetime(2026, 9, 21, tzinfo=UTC),
        progress=lambda event, values: events.append((event, values)),
    )

    assert socrata.operations == [
        ("newest", "recent"),
        ("recent", None),
        ("recent", "row-r2"),
        ("historical", None),
        ("historical", "row-h2"),
    ]
    assert (tmp_path / "recent/current/page-00000001.csv.gz").is_file()
    assert (tmp_path / "recent/current/page-00000002.csv.gz").is_file()
    assert not (tmp_path / "recent/next").exists()
    assert (tmp_path / "historical/pages/page-00000001.csv.gz").is_file()
    manifest = manifest_storage.load()
    assert manifest is not None
    assert manifest.recent.newest_id == "row-r3"
    assert len(manifest.recent.pages) == 2
    assert manifest.historical.cursor == "row-h3"
    assert len(manifest.historical.pages) == 2
    assert [values["dataset"] for event, values in events if event == "PAGE"] == [
        "recent",
        "recent",
        "historical",
        "historical",
    ]


async def test_pull_checkpoints_each_historical_page_before_fetching_the_next(
    tmp_path: Path,
) -> None:
    class FailingHistorical(Socrata):
        async def stream_page_csv(
            self,
            dataset: Dataset,
            *,
            after_id: str | None,
            limit: int,
        ) -> AsyncIterator[bytes]:
            if dataset.name == "recent" and after_id is None:
                yield compressed(
                    b":id,fecha_corte,value\nrow-r3,2026-09-11T00:00:00.000,3\n"
                )
            elif dataset.name == "recent":
                yield compressed(b":id,fecha_corte,value\n")
            elif after_id is None:
                yield compressed(
                    b":id,fecha_corte,value\nrow-h1,2026-06-26T00:00:00.000,1\n"
                )
            else:
                yield compressed(b":id,fecha_corte,value\n")
                raise ConnectionError("response ended early")

    manifest_storage = RawManifestStorage(tmp_path / "manifest.json")

    with pytest.raises(ConnectionError, match="response ended early"):
        await pull(
            historical=Dataset("historical", "w9zh-vetq"),
            recent=Dataset("recent", "qzsc-9esp"),
            socrata=FailingHistorical(),
            raw_pages=RawPageStorage(tmp_path),
            manifest_storage=manifest_storage,
            page_size=1,
        )

    manifest = manifest_storage.load()
    assert manifest is not None
    assert manifest.historical.cursor == "row-h1"
    assert len(manifest.historical.pages) == 1
    assert not (tmp_path / "historical/pages/page-00000002.csv.gz.partial").exists()


async def test_pull_skips_unchanged_recent_and_resumes_historical(
    tmp_path: Path,
) -> None:
    historical = Dataset("historical", "w9zh-vetq")
    recent = Dataset("recent", "qzsc-9esp")
    manifest_storage = RawManifestStorage(tmp_path / "manifest.json")
    raw_pages = RawPageStorage(tmp_path)
    await pull(
        historical=historical,
        recent=recent,
        socrata=Socrata(),
        raw_pages=raw_pages,
        manifest_storage=manifest_storage,
        page_size=2,
    )

    class Unchanged(Socrata):
        async def stream_page_csv(
            self,
            dataset: Dataset,
            *,
            after_id: str | None,
            limit: int,
        ) -> AsyncIterator[bytes]:
            self.operations.append((dataset.name, after_id))
            yield compressed(b":id,fecha_corte,value\n")

    unchanged = Unchanged()
    events: list[tuple[str, dict[str, object]]] = []
    await pull(
        historical=historical,
        recent=recent,
        socrata=unchanged,
        raw_pages=raw_pages,
        manifest_storage=manifest_storage,
        page_size=2,
        progress=lambda event, values: events.append((event, values)),
    )

    assert unchanged.operations == [
        ("newest", "recent"),
        ("historical", "row-h3"),
    ]
    assert events == [
        ("CHECK", {"dataset": "recent", "operation": "newest_id"}),
        ("UP_TO_DATE", {"dataset": "recent", "newest_id": "row-r3"}),
        (
            "CHECK",
            {
                "dataset": "historical",
                "operation": "page_after_id",
                "after_id": "row-h3",
            },
        ),
        ("UP_TO_DATE", {"dataset": "historical", "cursor": "row-h3"}),
    ]
    manifest = manifest_storage.load()
    assert manifest is not None
    assert len(manifest.recent.pages) == 2
    assert len(manifest.historical.pages) == 2


async def test_pull_refuses_to_resume_past_a_missing_historical_page(
    tmp_path: Path,
) -> None:
    historical = Dataset("historical", "w9zh-vetq")
    recent = Dataset("recent", "qzsc-9esp")
    manifest_storage = RawManifestStorage(tmp_path / "manifest.json")
    raw_pages = RawPageStorage(tmp_path)
    await pull(
        historical=historical,
        recent=recent,
        socrata=Socrata(),
        raw_pages=raw_pages,
        manifest_storage=manifest_storage,
        page_size=2,
    )
    (tmp_path / "historical/pages/page-00000001.csv.gz").unlink()

    with pytest.raises(ValueError, match="Missing historical page"):
        await pull(
            historical=historical,
            recent=recent,
            socrata=Socrata(),
            raw_pages=raw_pages,
            manifest_storage=manifest_storage,
            page_size=2,
        )


async def test_pull_preserves_current_recent_when_next_download_fails(
    tmp_path: Path,
) -> None:
    historical = Dataset("historical", "w9zh-vetq")
    recent = Dataset("recent", "qzsc-9esp")
    manifest_storage = RawManifestStorage(tmp_path / "manifest.json")
    raw_pages = RawPageStorage(tmp_path)
    await pull(
        historical=historical,
        recent=recent,
        socrata=Socrata(),
        raw_pages=raw_pages,
        manifest_storage=manifest_storage,
        page_size=2,
    )
    current = tmp_path / "recent/current/page-00000001.csv.gz"
    original = current.read_bytes()

    class FailingRecent(Socrata):
        async def newest_id(self, dataset: Dataset) -> str:
            return "row-r4"

        async def stream_page_csv(
            self,
            dataset: Dataset,
            *,
            after_id: str | None,
            limit: int,
        ) -> AsyncIterator[bytes]:
            if dataset.name == "recent" and after_id is None:
                yield compressed(
                    b":id,fecha_corte,value\nrow-r4,2026-09-18T00:00:00.000,4\n"
                )
                return
            raise ConnectionError("recent page failed")
            yield b"unreachable"

    with pytest.raises(ConnectionError, match="recent page failed"):
        await pull(
            historical=historical,
            recent=recent,
            socrata=FailingRecent(),
            raw_pages=raw_pages,
            manifest_storage=manifest_storage,
            page_size=1,
        )

    assert current.read_bytes() == original
    assert (tmp_path / "recent/next/page-00000001.csv.gz").is_file()
    manifest = manifest_storage.load()
    assert manifest is not None
    assert manifest.recent.newest_id == "row-r3"
