import { defineConfig } from "tsup";

export default defineConfig({
  entry: {
    api: "src/server/bin/api.ts",
    worker: "src/server/bin/worker.ts",
    migrate: "src/server/bin/migrate.ts",
  },
  outDir: "dist/server",
  format: ["esm"],
  platform: "node",
  target: "node24",
  sourcemap: true,
  clean: true,
  splitting: false,
  // Dependencies stay in node_modules; only first-party code is bundled.
  skipNodeModulesBundle: true,
});
