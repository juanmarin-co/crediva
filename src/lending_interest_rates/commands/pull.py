from collections.abc import Callable
from dataclasses import replace
from datetime import UTC, datetime

from ..socrata.client import Dataset, SocrataClient
from ..storage.raw import RawStorage
from ..storage.sync_manifest import (
    HistoricalState,
    RecentState,
    SyncManifest,
    SyncManifestStorage,
)

PAGE_SIZE = 50_000
Progress = Callable[[str, dict[str, object]], None]


def ignore_progress(_event: str, _values: dict[str, object]) -> None:
    pass


async def pull(
    *,
    historical: Dataset,
    recent: Dataset,
    socrata: SocrataClient,
    raw: RawStorage,
    manifests: SyncManifestStorage,
    page_size: int = PAGE_SIZE,
    clock: Callable[[], datetime] = lambda: datetime.now(UTC),
    progress: Progress = ignore_progress,
) -> None:
    manifest = initialize_manifest(
        manifests.load(),
        historical=historical,
        recent=recent,
        updated_at=clock(),
    )
    manifests.save(manifest)

    for page in manifest.recent.pages:
        if not raw.is_complete(page):
            raise ValueError(f"Missing recent page: {page.path}")
    newest_id = await socrata.newest_id(recent)
    if newest_id != manifest.recent.newest_id:
        raw.discard_recent_next()
        next_pages = []
        cursor = None
        while True:
            page_number = len(next_pages) + 1
            started_at = datetime.now(UTC)
            page = await raw.write_recent_page(
                page_number,
                socrata.stream_page_csv(
                    recent,
                    after_id=cursor,
                    limit=page_size,
                ),
            )
            if page is None:
                if not next_pages:
                    raise ValueError(f"Dataset {recent.dataset_id} returned no rows")
                break
            next_pages.append(page)
            cursor = page.last_id
            progress(
                "PAGE",
                {
                    "dataset": recent.name,
                    "page": page_number,
                    "rows": page.row_count,
                    "bytes": page.size,
                    "last_id": page.last_id,
                    "elapsed_s": elapsed_seconds(started_at),
                },
            )
            if page.row_count < page_size:
                break

        active_pages = raw.activate_recent(tuple(next_pages))
        manifest = replace(
            manifest,
            updated_at=clock(),
            recent=RecentState(recent.dataset_id, newest_id, active_pages),
        )
        manifests.save(manifest)
        raw.discard_previous_recent()

    historical_state = manifest.historical
    for page in historical_state.pages:
        if not raw.is_complete(page):
            raise ValueError(f"Missing historical page: {page.path}")
    while True:
        page_number = len(historical_state.pages) + 1
        started_at = datetime.now(UTC)
        page = await raw.write_historical_page(
            page_number,
            socrata.stream_page_csv(
                historical,
                after_id=historical_state.cursor,
                limit=page_size,
            ),
        )
        if page is None:
            break
        historical_state = replace(
            historical_state,
            cursor=page.last_id,
            pages=(*historical_state.pages, page),
        )
        manifest = replace(
            manifest,
            updated_at=clock(),
            historical=historical_state,
        )
        manifests.save(manifest)
        progress(
            "PAGE",
            {
                "dataset": historical.name,
                "page": page_number,
                "rows": page.row_count,
                "bytes": page.size,
                "last_id": page.last_id,
                "elapsed_s": elapsed_seconds(started_at),
            },
        )
        if page.row_count < page_size:
            break


def initialize_manifest(
    current: SyncManifest | None,
    *,
    historical: Dataset,
    recent: Dataset,
    updated_at: datetime,
) -> SyncManifest:
    if current is None:
        return SyncManifest(
            updated_at=updated_at,
            historical=HistoricalState(historical.dataset_id, None),
            recent=RecentState(recent.dataset_id, None),
        )
    if current.historical.dataset_id != historical.dataset_id:
        raise ValueError(
            f"Historical manifest source does not match {historical.dataset_id}"
        )
    if current.recent.dataset_id != recent.dataset_id:
        raise ValueError(f"Recent manifest source does not match {recent.dataset_id}")
    return current


def elapsed_seconds(started_at: datetime) -> str:
    return f"{(datetime.now(UTC) - started_at).total_seconds():.1f}"
