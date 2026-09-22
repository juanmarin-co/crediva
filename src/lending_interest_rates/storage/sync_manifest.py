import json
from dataclasses import dataclass
from datetime import date, datetime
from pathlib import Path
from typing import cast

from .raw import ReportingDateCount, StoredPage


@dataclass(frozen=True)
class HistoricalState:
    dataset_id: str
    cursor: str | None
    pages: tuple[StoredPage, ...] = ()


@dataclass(frozen=True)
class RecentState:
    dataset_id: str
    newest_id: str | None
    pages: tuple[StoredPage, ...] = ()


@dataclass(frozen=True)
class SyncManifest:
    updated_at: datetime
    historical: HistoricalState
    recent: RecentState


class SyncManifestStorage:
    def __init__(self, path: Path) -> None:
        self.path = path

    def load(self) -> SyncManifest | None:
        if not self.path.exists():
            return None
        document = cast(dict[str, object], json.loads(self.path.read_text()))
        if document.get("version") != 2:
            raise ValueError("Unsupported pull manifest version")
        sources = cast(dict[str, dict[str, object]], document["sources"])
        historical = sources["historical"]
        recent = sources["recent"]
        return SyncManifest(
            updated_at=datetime.fromisoformat(cast(str, document["updated_at"])),
            historical=HistoricalState(
                dataset_id=cast(str, historical["dataset_id"]),
                cursor=cast(str | None, historical.get("cursor")),
                pages=parse_pages(historical),
            ),
            recent=RecentState(
                dataset_id=cast(str, recent["dataset_id"]),
                newest_id=cast(str | None, recent.get("newest_id")),
                pages=parse_pages(recent),
            ),
        )

    def save(self, manifest: SyncManifest) -> None:
        document = {
            "version": 2,
            "updated_at": manifest.updated_at.isoformat(),
            "sources": {
                "historical": {
                    "dataset_id": manifest.historical.dataset_id,
                    "cursor": manifest.historical.cursor,
                    "pages": page_documents(manifest.historical.pages),
                },
                "recent": {
                    "dataset_id": manifest.recent.dataset_id,
                    "newest_id": manifest.recent.newest_id,
                    "pages": page_documents(manifest.recent.pages),
                },
            },
        }
        self.path.parent.mkdir(parents=True, exist_ok=True)
        partial = self.path.with_suffix(f"{self.path.suffix}.partial")
        partial.write_text(
            json.dumps(document, ensure_ascii=False, indent=2) + "\n",
            encoding="utf-8",
        )
        partial.replace(self.path)


def parse_pages(source: dict[str, object]) -> tuple[StoredPage, ...]:
    return tuple(
        StoredPage(
            path=cast(str, page["path"]),
            row_count=cast(int, page["rows"]),
            size=cast(int, page["bytes"]),
            first_id=cast(str, page["first_id"]),
            last_id=cast(str, page["last_id"]),
            downloaded_at=datetime.fromisoformat(cast(str, page["downloaded_at"])),
            reporting_dates=parse_reporting_dates(page),
        )
        for page in cast(list[dict[str, object]], source.get("pages", []))
    )


def parse_reporting_dates(
    page: dict[str, object],
) -> tuple[ReportingDateCount, ...]:
    counts = cast(dict[str, int], page["reporting_dates"])
    reporting_dates = tuple(
        ReportingDateCount(date.fromisoformat(value), row_count)
        for value, row_count in sorted(counts.items())
    )
    if sum(item.row_count for item in reporting_dates) != cast(int, page["rows"]):
        raise ValueError("Reporting-date row counts do not match page row count")
    return reporting_dates


def page_documents(pages: tuple[StoredPage, ...]) -> list[dict[str, object]]:
    return [
        {
            "path": page.path,
            "rows": page.row_count,
            "bytes": page.size,
            "first_id": page.first_id,
            "last_id": page.last_id,
            "downloaded_at": page.downloaded_at.isoformat(),
            "reporting_dates": {
                item.reporting_date.isoformat(): item.row_count
                for item in page.reporting_dates
            },
        }
        for page in pages
    ]
