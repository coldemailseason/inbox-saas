import dotenv from "dotenv";
import { defineConfig } from "vitest/config";

dotenv.config({ path: "../../apps/server/.env" });

export default defineConfig({
  test: {
    fileParallelism: false,
  },
});
