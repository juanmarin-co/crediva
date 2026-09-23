import { createServer } from "node:http";
import { once } from "node:events";
import { expect, test } from "vitest";
import { R2Storage } from "./r2";

test("R2 storage reads manifests, paginates object metadata, and publishes the manifest", async () => {
  const requests: string[] = [];
  let published = "";
  const server = createServer(async (request, response) => {
    const url = new URL(request.url!, "http://localhost");
    requests.push(`${request.method} ${url.pathname}`);
    if (request.method === "GET" && url.searchParams.get("list-type") === "2") {
      const next = url.searchParams.has("continuation-token");
      response.setHeader("Content-Type", "application/xml");
      let key = "manifest.json";
      let size = 2;
      let etag = "manifest-etag";
      let continuation = "<NextContinuationToken>next</NextContinuationToken>";
      if (next) {
        key = "reporting_year=2026/reporting_month=09/data.parquet";
        size = 99;
        etag = "parquet-etag";
        continuation = "";
      }

      response.end(`<ListBucketResult xmlns="http://s3.amazonaws.com/doc/2006-03-01/">
        <IsTruncated>${!next}</IsTruncated>
        ${continuation}
        <Contents><Key>${key}</Key><Size>${size}</Size><ETag>"${etag}"</ETag></Contents>
      </ListBucketResult>`);
    } else if (request.method === "GET" && url.pathname === "/analytical/manifest.json") {
      response.setHeader("Content-Type", "application/json");
      response.end(
        JSON.stringify({ version: 2, schema_version: 2, updated_at: "today", partitions: [] }),
      );
    } else if (request.method === "PUT" && url.pathname === "/analytical/manifest.json") {
      published = await new Promise<string>((resolve) => {
        let body = "";
        request.setEncoding("utf8");
        request.on("data", (chunk: string) => (body += chunk));
        request.on("end", () => resolve(body));
      });
      response.setHeader("ETag", '"published"');
      response.end();
    } else {
      response.writeHead(404).end();
    }
  });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const address = server.address();
  if (!address || typeof address === "string") {
    throw new Error("No server port");
  }

  try {
    const storage = new R2Storage({
      accountId: "test",
      accessKeyId: "test",
      secretAccessKey: "test",
      endpoint: `http://127.0.0.1:${address.port}`,
      rawBucket: "raw",
      parquetBucket: "analytical",
    });
    expect((await storage.readParquet())?.version).toBe(2);
    expect(
      (await storage.parquetObjects()).get("reporting_year=2026/reporting_month=09/data.parquet"),
    ).toEqual({
      bytes: 99,
      etag: "parquet-etag",
    });
    await storage.saveParquet({
      version: 2,
      schema_version: 2,
      updated_at: "today",
      partitions: [],
    });
    expect(JSON.parse(published)).toMatchObject({ version: 2, partitions: [] });
    expect(requests).toContain("GET /analytical/manifest.json");
  } finally {
    server.close();
    await once(server, "close");
  }
});

test("R2 raw storage removes only unreferenced recent pages", async () => {
  const deleted: string[] = [];
  let saved = "";
  const server = createServer(async (request, response) => {
    const url = new URL(request.url!, "http://localhost");
    if (request.method === "GET" && url.searchParams.get("list-type") === "2") {
      response.setHeader("Content-Type", "application/xml");
      response.end(`<ListBucketResult xmlns="http://s3.amazonaws.com/doc/2006-03-01/">
        <IsTruncated>false</IsTruncated>
        <Contents><Key>recent/generation-old/page-00000001.csv.gz</Key><Size>10</Size><ETag>"old"</ETag></Contents>
        <Contents><Key>recent/generation-active/page-00000001.csv.gz</Key><Size>10</Size><ETag>"active"</ETag></Contents>
      </ListBucketResult>`);
    } else if (request.method === "DELETE") {
      deleted.push(url.pathname);
      response.writeHead(204).end();
    } else if (request.method === "PUT" && url.pathname === "/raw/manifest.json") {
      saved = await new Promise<string>((resolve) => {
        let body = "";
        request.setEncoding("utf8");
        request.on("data", (chunk: string) => (body += chunk));
        request.on("end", () => resolve(body));
      });
      response.end();
    } else {
      response.writeHead(404).end();
    }
  });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const address = server.address();
  if (!address || typeof address === "string") {
    throw new Error("No server port");
  }

  try {
    const storage = new R2Storage({
      accountId: "test",
      accessKeyId: "test",
      secretAccessKey: "test",
      endpoint: `http://127.0.0.1:${address.port}`,
      rawBucket: "raw",
      parquetBucket: "analytical",
    });
    await storage.pruneRecent(new Set(["recent/generation-active/page-00000001.csv.gz"]));
    await storage.saveManifest(
      {
        version: 2,
        updated_at: "today",
        sources: {
          historical: { dataset_id: "w9zh-vetq", cursor: null, pages: [] },
          recent: { dataset_id: "qzsc-9esp", newest_id: "1", pages: [] },
        },
      },
      new AbortController().signal,
    );
    expect(deleted).toEqual(["/raw/recent/generation-old/page-00000001.csv.gz"]);
    expect(JSON.parse(saved).version).toBe(2);
  } finally {
    server.close();
    await once(server, "close");
  }
});
