import dotenv from "dotenv";
import { defineConfig } from "drizzle-kit";

dotenv.config({ path: ".env.local" });

export default defineConfig({
  schema: "./src/lib/db/schema-sqlite.ts",
  out: "./drizzle",
  dialect: "sqlite",
  dbCredentials: {
    // 与 src/lib/db/index.ts 的默认值保持一致，避免 drizzle-kit 指向另一份库
    url: process.env.SQLITE_DATABASE_PATH || "./data/token-tracker.db",
  },
});
