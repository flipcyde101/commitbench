import { defineConfig } from "tsup";

export default defineConfig({
  entry: {
    cli: "src/cli.ts",
    index: "src/index.ts",
  },
  format: ["esm"],
  target: "node24",
  platform: "node",
  dts: true,
  clean: true,
  sourcemap: false,
  splitting: false,
  treeshake: true,
  removeNodeProtocol: false,
  outDir: "dist",
});
