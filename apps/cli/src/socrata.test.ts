import { createServer } from "node:http";
import { gzipSync } from "node:zlib";
import { expect, test } from "vitest";
import { SocrataClient } from "./socrata";

test("Socrata requests gzip CSV pages with opaque ID pagination", async () => {
  const requests: { path: string; query: string; encoding: string | undefined }[] = [];
  const server = createServer(async (request, response) => {
    const body: Uint8Array[] = [];
    for await (const chunk of request) {
      body.push(chunk);
    }

    const payload = JSON.parse(Buffer.concat(body).toString()) as { query: string };
    requests.push({
      path: request.url ?? "",
      query: payload.query,
      encoding: request.headers["accept-encoding"],
    });

    if (request.url?.endsWith(".json")) {
      response.setHeader("Content-Type", "application/json");
      response.setHeader("Content-Encoding", "gzip");
      response.end(gzipSync(JSON.stringify([{ ":id": "newest" }])));
    } else {
      response.setHeader("Content-Encoding", "gzip");
      response.end(gzipSync(":id,fecha_corte\nnext,2026-09-04\n"));
    }
  });

  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));

  try {
    const address = server.address();
    if (!address || typeof address === "string") {
      throw new Error("server has no port");
    }

    const client = new SocrataClient(`http://127.0.0.1:${address.port}`);
    const dataset = { name: "recent" as const, datasetId: "qzsc-9esp" };
    const signal = new AbortController().signal;

    expect(await client.newestId(dataset, signal)).toBe("newest");
    const chunks = [];
    for await (const chunk of client.page(dataset, "o'neil", 2, signal)) {
      chunks.push(chunk);
    }

    expect(Buffer.concat(chunks)).toEqual(gzipSync(":id,fecha_corte\nnext,2026-09-04\n"));
    expect(requests).toEqual([
      {
        path: "/qzsc-9esp/query.json",
        query: "SELECT `:id` ORDER BY `:id` DESC LIMIT 1",
        encoding: "identity",
      },
      {
        path: "/qzsc-9esp/query.csv",
        query: "SELECT * WHERE `:id` > 'o''neil' ORDER BY `:id` LIMIT 2",
        encoding: "gzip",
      },
    ]);
  } finally {
    server.closeAllConnections();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
});
