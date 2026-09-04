import dotenv from "dotenv";
import { configDefaults, defineConfig } from "vitest/config";

dotenv.config({ path: ".env" });

export default defineConfig({
  test: {
    exclude: [...configDefaults.exclude, "dist/**"],
    fileParallelism: false,
  },
});
