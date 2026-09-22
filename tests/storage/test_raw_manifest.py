import json
from datetime import UTC, date, datetime
from pathlib import Path

from lending_interest_rates.storage.raw_manifest import (
    HistoricalSourceState,
    RawManifest,
    RawManifestStorage,
    RecentSourceState,
)
from lending_interest_rates.storage.raw_pages import RawPage, ReportingDateCount


def test_round_trips_the_atomic_raw_manifest(tmp_path: Path) -> None:
    timestamp = datetime(2026, 9, 21, tzinfo=UTC)
    historical_page = RawPage(
        path="historical/pages/page-00000001.csv.gz",
        row_count=50_000,
        size_bytes=42,
        first_id="row-first",
        last_id="row-last",
        downloaded_at=timestamp,
        reporting_dates=(ReportingDateCount(date(2026, 6, 26), 50_000),),
    )
    recent_page = RawPage(
        path="recent/current/page-00000001.csv.gz",
        row_count=2,
        size_bytes=24,
        first_id="row-recent-first",
        last_id="row-recent-last",
        downloaded_at=timestamp,
        reporting_dates=(ReportingDateCount(date(2026, 9, 11), 2),),
    )
    manifest = RawManifest(
        updated_at=timestamp,
        historical=HistoricalSourceState("w9zh-vetq", "row-last", (historical_page,)),
        recent=RecentSourceState("qzsc-9esp", "row-recent-last", (recent_page,)),
    )
    path = tmp_path / "manifest.json"
    storage = RawManifestStorage(path)

    storage.save(manifest)

    assert storage.load() == manifest
    assert json.loads(path.read_text()) == {
        "version": 2,
        "updated_at": "2026-09-21T00:00:00+00:00",
        "sources": {
            "historical": {
                "dataset_id": "w9zh-vetq",
                "cursor": "row-last",
                "pages": [
                    {
                        "path": "historical/pages/page-00000001.csv.gz",
                        "rows": 50000,
                        "bytes": 42,
                        "first_id": "row-first",
                        "last_id": "row-last",
                        "downloaded_at": "2026-09-21T00:00:00+00:00",
                        "reporting_dates": {"2026-06-26": 50000},
                    }
                ],
            },
            "recent": {
                "dataset_id": "qzsc-9esp",
                "newest_id": "row-recent-last",
                "pages": [
                    {
                        "path": "recent/current/page-00000001.csv.gz",
                        "rows": 2,
                        "bytes": 24,
                        "first_id": "row-recent-first",
                        "last_id": "row-recent-last",
                        "downloaded_at": "2026-09-21T00:00:00+00:00",
                        "reporting_dates": {"2026-09-11": 2},
                    }
                ],
            },
        },
    }
    assert not path.with_suffix(".json.partial").exists()
