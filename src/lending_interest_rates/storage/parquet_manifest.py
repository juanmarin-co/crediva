import json
from dataclasses import dataclass
from datetime import date, datetime
from pathlib import Path
from typing import cast

from .raw_pages import ReportingDateCount


@dataclass(frozen=True)
class RawPageInput:
    source_name: str
    dataset_id: str
    path: str
    row_count: int
    size_bytes: int
    first_id: str
    last_id: str
    downloaded_at: datetime
    reporting_dates: tuple[ReportingDateCount, ...]


@dataclass(frozen=True)
class ParquetPartition:
    reporting_year: int
    reporting_month: int
    path: str
    row_count: int
    size_bytes: int
    inputs: tuple[RawPageInput, ...]


@dataclass(frozen=True)
class ParquetManifest:
    schema_version: int
    updated_at: datetime
    partitions: tuple[ParquetPartition, ...]


class ParquetManifestStorage:
    def __init__(self, path: Path) -> None:
        self.path = path

    def load(self) -> ParquetManifest | None:
        if not self.path.exists():
            return None
        document = cast(dict[str, object], json.loads(self.path.read_text()))
        if document.get("version") != 1:
            raise ValueError("Unsupported Parquet manifest version")
        partitions = []
        for item in cast(list[dict[str, object]], document["partitions"]):
            inputs = tuple(
                RawPageInput(
                    source_name=cast(str, value["source"]),
                    dataset_id=cast(str, value["dataset_id"]),
                    path=cast(str, value["path"]),
                    row_count=cast(int, value["rows"]),
                    size_bytes=cast(int, value["bytes"]),
                    first_id=cast(str, value["first_id"]),
                    last_id=cast(str, value["last_id"]),
                    downloaded_at=datetime.fromisoformat(
                        cast(str, value["downloaded_at"])
                    ),
                    reporting_dates=tuple(
                        ReportingDateCount(date.fromisoformat(day), count)
                        for day, count in sorted(
                            cast(dict[str, int], value["reporting_dates"]).items()
                        )
                    ),
                )
                for value in cast(list[dict[str, object]], item["inputs"])
            )
            partitions.append(
                ParquetPartition(
                    reporting_year=cast(int, item["reporting_year"]),
                    reporting_month=cast(int, item["reporting_month"]),
                    path=cast(str, item["path"]),
                    row_count=cast(int, item["rows"]),
                    size_bytes=cast(int, item["bytes"]),
                    inputs=inputs,
                )
            )
        return ParquetManifest(
            schema_version=cast(int, document["schema_version"]),
            updated_at=datetime.fromisoformat(cast(str, document["updated_at"])),
            partitions=tuple(partitions),
        )

    def save(self, manifest: ParquetManifest) -> None:
        document = {
            "version": 1,
            "schema_version": manifest.schema_version,
            "updated_at": manifest.updated_at.isoformat(),
            "partitions": [_partition_document(item) for item in manifest.partitions],
        }
        self.path.parent.mkdir(parents=True, exist_ok=True)
        partial = self.path.with_suffix(f"{self.path.suffix}.partial")
        partial.write_text(
            json.dumps(document, ensure_ascii=False, indent=2) + "\n",
            encoding="utf-8",
        )
        partial.replace(self.path)


def _partition_document(partition: ParquetPartition) -> dict[str, object]:
    return {
        "reporting_year": partition.reporting_year,
        "reporting_month": partition.reporting_month,
        "path": partition.path,
        "rows": partition.row_count,
        "bytes": partition.size_bytes,
        "inputs": [
            {
                "source": item.source_name,
                "dataset_id": item.dataset_id,
                "path": item.path,
                "rows": item.row_count,
                "bytes": item.size_bytes,
                "first_id": item.first_id,
                "last_id": item.last_id,
                "downloaded_at": item.downloaded_at.isoformat(),
                "reporting_dates": {
                    value.reporting_date.isoformat(): value.row_count
                    for value in item.reporting_dates
                },
            }
            for item in partition.inputs
        ],
    }
