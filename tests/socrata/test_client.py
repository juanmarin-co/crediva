import gzip

import aiohttp
import pytest
from aiohttp import web

from lending_interest_rates.socrata.client import Dataset, SocrataClient


async def test_streams_an_id_ordered_csv_page_after_the_cursor(
    aiohttp_server,
) -> None:
    requests: list[tuple[dict[str, object], str | None]] = []
    compressed = gzip.compress(b":id,value\nrow-next,42\n", mtime=0)

    async def query(request: web.Request) -> web.Response:
        requests.append((await request.json(), request.headers.get("Accept-Encoding")))
        return web.Response(
            body=compressed,
            content_type="text/csv",
            headers={"Content-Encoding": "gzip"},
        )

    app = web.Application()
    app.router.add_post("/api/v3/views/w9zh-vetq/query.csv", query)
    server = await aiohttp_server(app)
    dataset = Dataset("historical", "w9zh-vetq")

    async with aiohttp.ClientSession() as session:
        client = SocrataClient(session, api_root=str(server.make_url("/api/v3/views")))
        content = b"".join(
            [
                chunk
                async for chunk in client.stream_page_csv(
                    dataset,
                    after_id="row-current",
                    limit=50_000,
                )
            ]
        )

    assert content == compressed
    assert requests == [
        (
            {
                "query": (
                    "SELECT * WHERE `:id` > 'row-current' ORDER BY `:id` LIMIT 50000"
                ),
                "includeSystem": True,
                "includeSynthetic": True,
            },
            "gzip",
        )
    ]


async def test_gets_the_newest_intrinsic_id(aiohttp_server) -> None:
    requests: list[dict[str, object]] = []

    async def query(request: web.Request) -> web.Response:
        requests.append(await request.json())
        return web.json_response([{":id": "row-newest"}])

    app = web.Application()
    app.router.add_post("/api/v3/views/qzsc-9esp/query.json", query)
    server = await aiohttp_server(app)
    dataset = Dataset("recent", "qzsc-9esp")

    async with aiohttp.ClientSession() as session:
        client = SocrataClient(session, api_root=str(server.make_url("/api/v3/views")))
        newest_id = await client.newest_id(dataset)

    assert newest_id == "row-newest"
    assert requests == [
        {
            "query": "SELECT `:id` ORDER BY `:id` DESC LIMIT 1",
            "includeSystem": True,
            "includeSynthetic": True,
        }
    ]


async def test_newest_id_fails_when_the_dataset_is_empty(aiohttp_server) -> None:
    async def query(request: web.Request) -> web.Response:
        return web.json_response([])

    app = web.Application()
    app.router.add_post("/api/v3/views/qzsc-9esp/query.json", query)
    server = await aiohttp_server(app)

    async with aiohttp.ClientSession() as session:
        client = SocrataClient(session, api_root=str(server.make_url("/api/v3/views")))
        with pytest.raises(ValueError, match="qzsc-9esp.*no rows"):
            await client.newest_id(Dataset("recent", "qzsc-9esp"))
