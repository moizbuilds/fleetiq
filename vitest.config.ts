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
 *
 * `fileParallelism: false` (Task 6): several test files each spin up their
 * own in-memory PGlite instance (Postgres compiled to WebAssembly — see
 * tests/schema.test.ts's header). Vitest's default is to run test FILES
 * concurrently in separate workers, which means every one of those WASM
 * engines boots at once; with eight PGlite-backed suites (Task 6 added the
 * eighth, tests/rollforward.test.ts) that concurrent boot routinely blew
 * past the first test's default 5s timeout on this machine — a real,
 * repeatable failure of `npm run test` under the default config, not a
 * flake in any one test's logic (confirmed by re-running the exact same
 * suite with `--no-file-parallelism`, which passed every time). Running
 * files sequentially instead trades a few seconds of wall-clock time for a
 * suite that reliably passes.
 */
import { defineConfig } from "vitest/config";
import path from "node:path";

export default defineConfig({
  test: {
    environment: "node",
    include: ["tests/**/*.test.ts"],
    fileParallelism: false,
    // 20s ceiling: a single PGlite WASM engine can occasionally take longer
    // than Vitest's default 5s to BOOT on a loaded machine (a rare miss under
    // CI-like load). The bottleneck is one-time engine startup, not any
    // test's logic (which runs in ms), so a generous ceiling removes the last
    // flake without masking a genuinely slow test.
    testTimeout: 20_000,
    hookTimeout: 20_000,
  },
  resolve: {
    alias: {
      "@": path.resolve(__dirname, "."),
    },
  },
});
