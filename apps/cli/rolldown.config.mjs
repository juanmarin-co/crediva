import { defineConfig } from "rolldown";

export default defineConfig({
  input: "src/cli.ts",
  platform: "node",
  external: ["@duckdb/node-api", "@logtape/logtape", "cmd-ts"],
  output: {
    cleanDir: true,
    dir: "dist",
    entryFileNames: "cli.js",
    format: "esm",
  },
});
