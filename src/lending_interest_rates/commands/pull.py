from collections.abc import Callable
from dataclasses import replace
from datetime import UTC, datetime

from ..socrata.client import Dataset, SocrataClient
from ..storage.raw_manifest import (
    HistoricalSourceState,
    RawManifest,
    RawManifestStorage,
    RecentSourceState,
)
from ..storage.raw_pages import RawPageStorage

PAGE_SIZE = 50_000
Progress = Callable[[str, dict[str, object]], None]


def ignore_progress(_event: str, _values: dict[str, object]) -> None:
    pass


async def pull(
    *,
    historical: Dataset,
    recent: Dataset,
    socrata: SocrataClient,
    raw_pages: RawPageStorage,
    manifest_storage: RawManifestStorage,
    page_size: int = PAGE_SIZE,
    clock: Callable[[], datetime] = lambda: datetime.now(UTC),
    progress: Progress = ignore_progress,
) -> None:
    manifest = initialize_raw_manifest(
        manifest_storage.load(),
        historical=historical,
        recent=recent,
        updated_at=clock(),
    )
    manifest_storage.save(manifest)

    for page in manifest.recent.pages:
        if not raw_pages.is_complete(page):
            raise ValueError(f"Missing recent page: {page.path}")
    progress("CHECK", {"dataset": recent.name, "operation": "newest_id"})
    newest_id = await socrata.newest_id(recent)
    if newest_id == manifest.recent.newest_id:
        progress(
            "UP_TO_DATE",
            {"dataset": recent.name, "newest_id": newest_id},
        )
    else:
        progress(
            "CHANGED",
            {
                "dataset": recent.name,
                "previous_newest_id": manifest.recent.newest_id,
                "newest_id": newest_id,
            },
        )
        raw_pages.discard_next_recent_generation()
        next_pages = []
        cursor = None
        while True:
            page_number = len(next_pages) + 1
            started_at = datetime.now(UTC)
            page = await raw_pages.write_recent_page(
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
                    "bytes": page.size_bytes,
                    "last_id": page.last_id,
                    "elapsed_s": elapsed_seconds(started_at),
                },
            )
            if page.row_count < page_size:
                break

        active_pages = raw_pages.activate_next_recent_generation(tuple(next_pages))
        manifest = replace(
            manifest,
            updated_at=clock(),
            recent=RecentSourceState(recent.dataset_id, newest_id, active_pages),
        )
        manifest_storage.save(manifest)
        raw_pages.discard_previous_recent_generation()

    historical_state = manifest.historical
    for page in historical_state.pages:
        if not raw_pages.is_complete(page):
            raise ValueError(f"Missing historical page: {page.path}")
    while True:
        page_number = len(historical_state.pages) + 1
        started_at = datetime.now(UTC)
        progress(
            "CHECK",
            {
                "dataset": historical.name,
                "operation": "page_after_id",
                "after_id": historical_state.cursor,
            },
        )
        page = await raw_pages.write_historical_page(
            page_number,
            socrata.stream_page_csv(
                historical,
                after_id=historical_state.cursor,
                limit=page_size,
            ),
        )
        if page is None:
            progress(
                "UP_TO_DATE",
                {
                    "dataset": historical.name,
                    "cursor": historical_state.cursor,
                },
            )
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
        manifest_storage.save(manifest)
        progress(
            "PAGE",
            {
                "dataset": historical.name,
                "page": page_number,
                "rows": page.row_count,
                "bytes": page.size_bytes,
                "last_id": page.last_id,
                "elapsed_s": elapsed_seconds(started_at),
            },
        )
        if page.row_count < page_size:
            break


def initialize_raw_manifest(
    current: RawManifest | None,
    *,
    historical: Dataset,
    recent: Dataset,
    updated_at: datetime,
) -> RawManifest:
    if current is None:
        return RawManifest(
            updated_at=updated_at,
            historical=HistoricalSourceState(historical.dataset_id, None),
            recent=RecentSourceState(recent.dataset_id, None),
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
