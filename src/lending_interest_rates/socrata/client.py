from collections.abc import AsyncGenerator, AsyncIterator
from contextlib import asynccontextmanager
from dataclasses import dataclass
from datetime import date, datetime
from typing import cast

import aiohttp

API_ROOT = "https://www.datos.gov.co/api/v3/views"
CHUNK_SIZE = 1024 * 1024


@dataclass(frozen=True)
class Dataset:
    name: str
    dataset_id: str


@dataclass(frozen=True)
class RemotePartition:
    dataset: Dataset
    reporting_date: date
    row_count: int
    min_created_at: datetime
    max_created_at: datetime
    min_updated_at: datetime
    max_updated_at: datetime


@asynccontextmanager
async def open_client(
    *,
    api_root: str = API_ROOT,
) -> AsyncGenerator["SocrataClient"]:
    headers = {"User-Agent": "lending-interest-rates/0.1"}
    timeout = aiohttp.ClientTimeout(
        total=None,
        connect=60,
        sock_connect=60,
        sock_read=600,
    )
    connector = aiohttp.TCPConnector(limit=1)
    async with aiohttp.ClientSession(
        connector=connector,
        headers=headers,
        timeout=timeout,
        auto_decompress=False,
    ) as session:
        yield SocrataClient(session, api_root=api_root)


class SocrataClient:
    def __init__(
        self,
        session: aiohttp.ClientSession,
        api_root: str = API_ROOT,
    ) -> None:
        self.session = session
        self.api_root = api_root.rstrip("/")

    async def stream_page_csv(
        self,
        dataset: Dataset,
        *,
        after_id: str | None,
        limit: int,
    ) -> AsyncIterator[bytes]:
        where = ""
        if after_id is not None:
            escaped_id = after_id.replace("'", "''")
            where = f" WHERE `:id` > '{escaped_id}'"
        payload = {
            "query": f"SELECT *{where} ORDER BY `:id` LIMIT {limit}",
            "includeSystem": True,
            "includeSynthetic": True,
        }
        async with self.session.post(
            f"{self.api_root}/{dataset.dataset_id}/query.csv",
            json=payload,
            headers={"Accept-Encoding": "gzip"},
            auto_decompress=False,
        ) as response:
            response.raise_for_status()
            require_gzip(response, dataset)
            async for chunk in response.content.iter_chunked(CHUNK_SIZE):
                yield chunk

    async def newest_id(self, dataset: Dataset) -> str:
        payload = {
            "query": "SELECT `:id` ORDER BY `:id` DESC LIMIT 1",
            "includeSystem": True,
            "includeSynthetic": True,
        }
        async with self.session.post(
            f"{self.api_root}/{dataset.dataset_id}/query.json",
            json=payload,
            auto_decompress=True,
        ) as response:
            response.raise_for_status()
            rows = cast(list[dict[str, str]], await response.json())
        if not rows:
            raise ValueError(f"Dataset {dataset.dataset_id} has no rows")
        return rows[0][":id"]


def require_gzip(response: aiohttp.ClientResponse, dataset: Dataset) -> None:
    if response.headers.get("Content-Encoding") != "gzip":
        raise ValueError(f"Dataset {dataset.dataset_id} did not return gzip content")
