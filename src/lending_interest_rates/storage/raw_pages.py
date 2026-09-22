import csv
import gzip
import shutil
from collections import Counter
from collections.abc import AsyncIterator, Callable
from dataclasses import dataclass, replace
from datetime import UTC, date, datetime
from pathlib import Path


@dataclass(frozen=True)
class ReportingDateCount:
    reporting_date: date
    row_count: int


@dataclass(frozen=True)
class RawPage:
    path: str
    row_count: int
    size_bytes: int
    first_id: str
    last_id: str
    downloaded_at: datetime
    reporting_dates: tuple[ReportingDateCount, ...]


class RawPageStorage:
    def __init__(
        self,
        root: Path,
        clock: Callable[[], datetime] = lambda: datetime.now(UTC),
    ) -> None:
        self.root = root
        self.clock = clock

    def is_complete(self, page: RawPage) -> bool:
        path = self.root / page.path
        return path.is_file() and path.stat().st_size == page.size_bytes

    def discard_next_recent_generation(self) -> None:
        shutil.rmtree(self.root / "recent" / "next", ignore_errors=True)

    def activate_next_recent_generation(
        self,
        pages: tuple[RawPage, ...],
    ) -> tuple[RawPage, ...]:
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

    def discard_previous_recent_generation(self) -> None:
        shutil.rmtree(self.root / "recent" / "previous", ignore_errors=True)

    async def write_historical_page(
        self,
        number: int,
        content: AsyncIterator[bytes],
    ) -> RawPage | None:
        output = self.root / "historical" / "pages" / f"page-{number:08d}.csv.gz"
        return await self._write_page(output, content)

    async def write_recent_page(
        self,
        number: int,
        content: AsyncIterator[bytes],
    ) -> RawPage | None:
        output = self.root / "recent" / "next" / f"page-{number:08d}.csv.gz"
        return await self._write_page(output, content)

    async def _write_page(
        self,
        output: Path,
        content: AsyncIterator[bytes],
    ) -> RawPage | None:
        output.parent.mkdir(parents=True, exist_ok=True)
        partial = output.with_suffix(f"{output.suffix}.partial")
        partial.unlink(missing_ok=True)
        try:
            with partial.open("wb") as stream:
                async for chunk in content:
                    stream.write(chunk)
            row_count, first_id, last_id, reporting_dates = inspect_raw_page(partial)
            if first_id is None or last_id is None:
                partial.unlink()
                return None
            partial.replace(output)
        except BaseException:
            partial.unlink(missing_ok=True)
            raise
        return RawPage(
            path=str(output.relative_to(self.root)),
            row_count=row_count,
            size_bytes=output.stat().st_size,
            first_id=first_id,
            last_id=last_id,
            downloaded_at=self.clock(),
            reporting_dates=reporting_dates,
        )


def inspect_raw_page(
    path: Path,
) -> tuple[
    int,
    str | None,
    str | None,
    tuple[ReportingDateCount, ...],
]:
    row_count = 0
    first_id: str | None = None
    last_id: str | None = None
    reporting_date_counts: Counter[date] = Counter()
    with gzip.open(path, "rt", encoding="utf-8-sig", newline="") as stream:
        rows = csv.reader(stream)
        header = next(rows, None)
        if header is None or ":id" not in header:
            raise ValueError("CSV page does not contain the :id system column")
        if "fecha_corte" not in header:
            raise ValueError("CSV page does not contain the fecha_corte column")
        id_index = header.index(":id")
        reporting_date_index = header.index("fecha_corte")
        for row in rows:
            if len(row) <= id_index or not row[id_index]:
                raise ValueError("CSV page contains an empty :id")
            if len(row) <= reporting_date_index or not row[reporting_date_index]:
                raise ValueError("CSV page contains an empty fecha_corte")
            row_id = row[id_index]
            if first_id is None:
                first_id = row_id
            last_id = row_id
            try:
                reporting_date = datetime.fromisoformat(
                    row[reporting_date_index]
                ).date()
            except ValueError as error:
                raise ValueError(
                    f"CSV page contains an invalid fecha_corte: "
                    f"{row[reporting_date_index]}"
                ) from error
            reporting_date_counts[reporting_date] += 1
            row_count += 1
    return (
        row_count,
        first_id,
        last_id,
        tuple(
            ReportingDateCount(reporting_date, count)
            for reporting_date, count in sorted(reporting_date_counts.items())
        ),
    )
