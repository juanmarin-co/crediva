import { request as httpRequest, type IncomingMessage } from "node:http";
import { request as httpsRequest } from "node:https";
import { gunzipSync } from "node:zlib";
import type { Dataset, Socrata } from "./pull";

export const API_ROOT = "https://www.datos.gov.co/api/v3/views";

export class SocrataClient implements Socrata {
  constructor(readonly apiRoot: string) {}

  async newestId(dataset: Dataset, signal: AbortSignal): Promise<string> {
    const response = await this.post(
      dataset,
      "query.json",
      {
        query: "SELECT `:id` ORDER BY `:id` DESC LIMIT 1",
        includeSystem: true,
        includeSynthetic: true,
      },
      false,
      signal,
    );
    const chunks: Uint8Array[] = [];
    for await (const chunk of response) {
      chunks.push(chunk);
    }

    let body = Buffer.concat(chunks);
    if (response.headers["content-encoding"] === "gzip") {
      body = gunzipSync(body);
    } else if (
      response.headers["content-encoding"] &&
      response.headers["content-encoding"] !== "identity"
    ) {
      throw new Error(`Unsupported Socrata JSON encoding: ${response.headers["content-encoding"]}`);
    }

    const rows = JSON.parse(body.toString("utf8")) as Record<string, string>[];
    if (!rows[0]?.[":id"]) {
      throw new Error(`Dataset ${dataset.datasetId} has no rows`);
    }

    return rows[0][":id"];
  }

  async *page(
    dataset: Dataset,
    afterId: string | null,
    limit: number,
    signal: AbortSignal,
  ): AsyncIterable<Uint8Array> {
    let where = "";
    if (afterId !== null) {
      where = ` WHERE \`:id\` > '${afterId.replaceAll("'", "''")}'`;
    }

    const response = await this.post(
      dataset,
      "query.csv",
      {
        query: `SELECT *${where} ORDER BY \`:id\` LIMIT ${limit}`,
        includeSystem: true,
        includeSynthetic: true,
      },
      true,
      signal,
    );
    if (response.headers["content-encoding"] !== "gzip") {
      response.destroy();
      throw new Error(`Dataset ${dataset.datasetId} did not return gzip content`);
    }

    try {
      for await (const chunk of response) {
        yield chunk as Buffer;
      }
    } finally {
      response.destroy();
    }
  }

  private async post(
    dataset: Dataset,
    format: string,
    payload: unknown,
    gzip: boolean,
    signal: AbortSignal,
  ): Promise<IncomingMessage> {
    const url = new URL(`${this.apiRoot.replace(/\/$/, "")}/${dataset.datasetId}/${format}`);
    const body = JSON.stringify(payload);
    let send = httpRequest;
    if (url.protocol === "https:") {
      send = httpsRequest;
    }

    let encoding = "identity";
    if (gzip) {
      encoding = "gzip";
    }

    return new Promise<IncomingMessage>((resolve, reject) => {
      const req = send(
        url,
        {
          method: "POST",
          signal,
          headers: {
            "User-Agent": "lending-interest-rates/0.1",
            "Content-Type": "application/json",
            "Accept-Encoding": encoding,
            "Content-Length": Buffer.byteLength(body),
          },
          timeout: 600_000,
        },
        (response) => {
          if ((response.statusCode ?? 500) >= 400) {
            response.resume();
            reject(new Error(`Socrata HTTP ${response.statusCode}`));
            return;
          }

          resolve(response);
        },
      );
      req.on("timeout", () => req.destroy(new Error("Socrata request timed out")));
      req.on("error", reject);
      req.end(body);
    });
  }
}
