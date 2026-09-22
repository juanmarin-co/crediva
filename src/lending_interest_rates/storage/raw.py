import csv
import gzip
import shutil
from collections.abc import AsyncIterator, Callable
from dataclasses import dataclass, replace
from datetime import UTC, datetime
from pathlib import Path


@dataclass(frozen=True)
class StoredPage:
    path: str
    row_count: int
    size: int
    first_id: str
    last_id: str
    downloaded_at: datetime


class RawStorage:
    def __init__(
        self,
        root: Path,
        clock: Callable[[], datetime] = lambda: datetime.now(UTC),
    ) -> None:
        self.root = root
        self.clock = clock

    def is_complete(self, page: StoredPage) -> bool:
        path = self.root / page.path
        return path.is_file() and path.stat().st_size == page.size

    def discard_recent_next(self) -> None:
        shutil.rmtree(self.root / "recent" / "next", ignore_errors=True)

    def activate_recent(
        self,
        pages: tuple[StoredPage, ...],
    ) -> tuple[StoredPage, ...]:
        recent = self.root / "recent"
        current = recent / "current"
        next_generation = recent / "next"
        previous = recent / "previous"
        shutil.rmtree(previous, ignore_errors=True)
        if current.exists():
            current.replace(previous)
        next_generation.replace(current)
        return tuple(
            replace(
                page,
                path=page.path.replace("recent/next/", "recent/current/", 1),
            )
            for page in pages
        )

    def discard_previous_recent(self) -> None:
        shutil.rmtree(self.root / "recent" / "previous", ignore_errors=True)

    async def write_historical_page(
        self,
        number: int,
        content: AsyncIterator[bytes],
    ) -> StoredPage | None:
        output = self.root / "historical" / "pages" / f"page-{number:08d}.csv.gz"
        return await self._write_page(output, content)

    async def write_recent_page(
        self,
        number: int,
        content: AsyncIterator[bytes],
    ) -> StoredPage | None:
        output = self.root / "recent" / "next" / f"page-{number:08d}.csv.gz"
        return await self._write_page(output, content)

    async def _write_page(
        self,
        output: Path,
        content: AsyncIterator[bytes],
    ) -> StoredPage | None:
        output.parent.mkdir(parents=True, exist_ok=True)
        partial = output.with_suffix(f"{output.suffix}.partial")
        partial.unlink(missing_ok=True)
        try:
            with partial.open("wb") as stream:
                async for chunk in content:
                    stream.write(chunk)
            row_count, first_id, last_id = inspect_page(partial)
            if first_id is None or last_id is None:
                partial.unlink()
                return None
            partial.replace(output)
        except BaseException:
            partial.unlink(missing_ok=True)
            raise
        return StoredPage(
            path=str(output.relative_to(self.root)),
            row_count=row_count,
            size=output.stat().st_size,
            first_id=first_id,
            last_id=last_id,
            downloaded_at=self.clock(),
        )


def inspect_page(path: Path) -> tuple[int, str | None, str | None]:
    row_count = 0
    first_id: str | None = None
    last_id: str | None = None
    with gzip.open(path, "rt", encoding="utf-8-sig", newline="") as stream:
        rows = csv.reader(stream)
        header = next(rows, None)
        if header is None or ":id" not in header:
            raise ValueError("CSV page does not contain the :id system column")
        id_index = header.index(":id")
        for row in rows:
            if len(row) <= id_index or not row[id_index]:
                raise ValueError("CSV page contains an empty :id")
            row_id = row[id_index]
            if first_id is None:
                first_id = row_id
            last_id = row_id
            row_count += 1
    return row_count, first_id, last_id
