/**
 * Vitest config — the test runner for FleetIQ's unit/integration tests
 * (e.g. Task 2's Drizzle schema tests, AI-parsing tests in later tasks).
 *
 * `environment: "node"` (not "jsdom") because FleetIQ's tests exercise
 * server-side logic — DB queries, Anthropic response parsing, rate
 * limiting — not React component rendering, so there's no need for a
 * simulated browser DOM.
 *
 * The `@` alias mirrors tsconfig.json's `paths` mapping so test files can
 * `import { db } from "@/lib/db"` exactly like app code does — without
 * this, the same import would resolve at compile time (via tsconfig) but
 * fail at test-run time (Vitest doesn't read tsconfig `paths` on its own).
 */
import { defineConfig } from "vitest/config";
import path from "node:path";

export default defineConfig({
  test: {
    environment: "node",
    include: ["tests/**/*.test.ts"],
  },
  resolve: {
    alias: {
      "@": path.resolve(__dirname, "."),
    },
  },
});
