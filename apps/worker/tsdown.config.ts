import { defineConfig } from "tsdown";

export default defineConfig({
  entry: ["./src/index.ts", "./src/main.ts", "./src/fake-main.ts"],
  format: "esm",
  outDir: "./dist",
  clean: true,
  dts: false,
  deps: {
    alwaysBundle: [/@inbox-saas\/.*/],
  },
});
