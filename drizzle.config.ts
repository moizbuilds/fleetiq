/**
 * Drizzle Kit config — tells the `drizzle-kit` CLI where the schema lives,
 * where to write generated SQL migrations, and how to reach the database.
 *
 * This file only configures the CLI (`npm run db:generate` / `db:migrate`);
 * the actual table definitions come in Task 2 (lib/db/schema.ts). Nothing
 * here needs to change when tables are added — new tables just get
 * exported from that one schema file.
 *
 * CONCEPT: DATABASE_URL is read from the environment, never hard-coded —
 * it's a secret connection string (contains the DB password), and the
 * value differs between local dev, CI, and production.
 */
import { defineConfig } from "drizzle-kit";

export default defineConfig({
  schema: "./lib/db/schema.ts",
  out: "./drizzle",
  dialect: "postgresql",
  dbCredentials: {
    url: process.env.DATABASE_URL!,
  },
});
