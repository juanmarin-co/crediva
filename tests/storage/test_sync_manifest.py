import json
from datetime import UTC, datetime
from pathlib import Path

from lending_interest_rates.storage.raw import StoredPage
from lending_interest_rates.storage.sync_manifest import (
    HistoricalState,
    RecentState,
    SyncManifest,
    SyncManifestStorage,
)


def test_round_trips_the_atomic_sync_manifest(tmp_path: Path) -> None:
    timestamp = datetime(2026, 9, 21, tzinfo=UTC)
    historical_page = StoredPage(
        path="historical/pages/page-00000001.csv.gz",
        row_count=50_000,
        size=42,
        first_id="row-first",
        last_id="row-last",
        downloaded_at=timestamp,
    )
    recent_page = StoredPage(
        path="recent/current/page-00000001.csv.gz",
        row_count=2,
        size=24,
        first_id="row-recent-first",
        last_id="row-recent-last",
        downloaded_at=timestamp,
    )
    manifest = SyncManifest(
        updated_at=timestamp,
        historical=HistoricalState("w9zh-vetq", "row-last", (historical_page,)),
        recent=RecentState("qzsc-9esp", "row-recent-last", (recent_page,)),
    )
    path = tmp_path / "manifest.json"
    storage = SyncManifestStorage(path)

    storage.save(manifest)

    assert storage.load() == manifest
    assert json.loads(path.read_text()) == {
        "version": 1,
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
                    }
                ],
            },
        },
    }
    assert not path.with_suffix(".json.partial").exists()
