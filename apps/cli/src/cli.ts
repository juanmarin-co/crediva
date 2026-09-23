#!/usr/bin/env node
import { join } from "node:path";
import { configure, getLogger } from "@logtape/logtape";
import { command, option, run, string, subcommands } from "cmd-ts";
import { convert } from "./convert";
import { pull, type Progress } from "./pull";
import { API_ROOT, SocrataClient } from "./socrata";

const PAGE_SIZE = 50_000;
const clock = () => new Date();
const logger = getLogger("lending-interest-rates");
const progress: Progress = (event, values) => {
  logger.info("{event}", { event, ...values });
};

const app = subcommands({
  name: "lending-interest-rates",
  description: "Acquire Colombian lending-interest-rate data",
  cmds: {
    pull: command({
      name: "pull",
      description: "pull raw Socrata data",
      args: {
        rawPath: option({ long: "raw-path", type: string, defaultValue: () => "data/raw" }),
        apiRoot: option({ long: "api-root", type: string, defaultValue: () => API_ROOT }),
      },
      handler: async ({ rawPath, apiRoot }) => {
        const controller = new AbortController();
        const onSigint = () => controller.abort("SIGINT");
        const onSigterm = () => controller.abort("SIGTERM");
        process.once("SIGINT", onSigint);
        process.once("SIGTERM", onSigterm);

        try {
          await pull({
            root: rawPath,
            socrata: new SocrataClient(apiRoot),
            signal: controller.signal,
            pageSize: PAGE_SIZE,
            clock,
            progress,
          });
          progress("COMPLETE", { manifest: join(rawPath, "manifest.json") });
        } catch (error) {
          if (!controller.signal.aborted) {
            throw error;
          }

          progress("INTERRUPTED", { signal: controller.signal.reason });
          let signalNumber = 15;
          if (controller.signal.reason === "SIGINT") {
            signalNumber = 2;
          }

          process.exitCode = 128 + signalNumber;
        } finally {
          process.removeListener("SIGINT", onSigint);
          process.removeListener("SIGTERM", onSigterm);
        }
      },
    }),
    convert: command({
      name: "convert",
      description: "convert raw data to Parquet",
      args: {
        rawPath: option({ long: "raw-path", type: string, defaultValue: () => "data/raw" }),
        parquetPath: option({
          long: "parquet-path",
          type: string,
          defaultValue: () => "data/parquet",
        }),
      },
      handler: async ({ rawPath, parquetPath }) => {
        await convert({ rawPath, parquetPath, clock, progress });

        progress("COMPLETE", { manifest: join(parquetPath, "manifest.json") });
      },
    }),
  },
});

await configure({
  sinks: {
    stderr: (record) => {
      const { event, ...values } = record.properties;
      const fields = Object.entries(values).map(([name, value]) => `${name}=${String(value)}`);
      process.stderr.write(`${String(event)} ${fields.join(" ")}`.trimEnd() + "\n");
    },
  },
  loggers: [
    { category: "lending-interest-rates", sinks: ["stderr"], lowestLevel: "info" },
    { category: ["logtape", "meta"], sinks: ["stderr"], lowestLevel: "error" },
  ],
});

try {
  await run(app, process.argv.slice(2));
} catch (error) {
  let message = String(error);
  if (error instanceof Error) {
    message = error.message;
  }

  process.stderr.write(`ERROR ${message}\n`);
  process.exitCode = 1;
}
