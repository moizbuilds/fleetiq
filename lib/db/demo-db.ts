/**
 * Demo-mode database — a persistent, file-backed PGlite instance that
 * stands in for Neon when `FLEETIQ_DEMO=1` (lib/demo.ts). Split out of
 * lib/db/index.ts so that file's Neon path (the one every real deployment
 * runs) stays a plain, easy-to-audit diff with none of this module's extra
 * machinery mixed in.
 *
 * CONCEPT: PGlite is Postgres compiled to WebAssembly (see
 * tests/schema.test.ts's header) — it runs a real Postgres engine in the
 * same process, no network or Docker needed. Pointing it at a directory
 * path (instead of the in-memory mode the test suite uses) makes it write
 * its files to disk, so the demo fleet a visitor builds up survives a
 * `next dev` restart instead of resetting every time.
 *
 * WHY the migration+seed setup below is more involved than "just call
 * seedDemoData once": `getDemoDb()` has to return a USABLE database
 * SYNCHRONOUSLY (every caller in the app does `const db = getDb();` with
 * no `await` — see lib/db/index.ts), but building the database (booting
 * the WASM engine, running migrations, inserting the seed rows) is
 * unavoidably asynchronous work. The naive fix — kick off that async work
 * and just return the drizzle object immediately — has a real race: the
 * very first request after a fresh `.demo-db/` is created could run its
 * own query before the seed rows exist yet, and see an empty dashboard
 * instead of the seeded fleet (a real instance of globals.md's "Reload"
 * pre-flight question: an in-flight async setup must never let a request
 * observe a half-finished state). The `readyGate` below exists purely to
 * close that race — see its own comment for how.
 */
import { readFileSync, readdirSync } from 'node:fs';
import path from 'node:path';
import { PGlite } from '@electric-sql/pglite';
import { drizzle, type PgliteDatabase } from 'drizzle-orm/pglite';
import * as schema from './schema';
import { seedDemoData } from '../demo-seed';

// Persistent on disk (a plain directory path, not `memory://`) — see
// PGlite's own constructor docs: a bare path uses Node's filesystem
// backend, which is exactly the "survives a restart" behavior demo mode
// wants. Gitignored (this repo's .gitignore has `.demo-db/`) since it's
// generated, machine-local data, never something to commit.
const DEMO_DB_DIR = path.join(process.cwd(), '.demo-db');

// Applies every generated migration file to a PGlite instance — copied
// from tests/schema.test.ts's `applyMigrations` (see that file's header for
// why this reads the raw .sql files directly instead of using drizzle-kit's
// migrator). Kept as its own small function here rather than importing the
// test helper: importing test code into app code the other way round would
// make tests/ a production dependency, which is backwards.
function applyMigrations(pglite: PGlite): void {
  const migrationsDir = path.resolve(process.cwd(), 'drizzle');
  const sqlFiles = readdirSync(migrationsDir)
    .filter((f) => f.endsWith('.sql'))
    .sort(); // numerically prefixed (0000_, 0001_, ...) so lexical sort is chronological

  for (const file of sqlFiles) {
    const raw = readFileSync(path.join(migrationsDir, file), 'utf-8');
    const statements = raw
      .split('--> statement-breakpoint')
      .map((s) => s.trim())
      .filter(Boolean);

    for (const statement of statements) {
      // Deliberately not awaited here — see this file's header and the
      // `readyGate` comment below for why that's safe: PGlite serializes
      // every call to `exec`/`query`/`transaction` into one in-order queue
      // regardless of whether the caller awaits each one, so issuing every
      // migration statement in this synchronous loop still guarantees they
      // run in file/statement order, before anything queued after this
      // function returns.
      void pglite.exec(statement);
    }
  }
}

// Wraps a PGlite client so every call to its three query-executing methods
// (`query` — plain reads/writes; `exec` — raw multi-statement SQL, used by
// applyMigrations above; `transaction` — lib/actions/odometer.ts's and
// lib/actions/services.ts's `db.transaction()`) waits for `whenReady`
// before actually running.
//
// WHY this is the right layer to gate at, instead of wrapping the higher-
// level drizzle `db` object's `.select()`/`.insert()`/etc: those methods
// return CHAINABLE query builders (`db.select().from(x).where(y)`) that
// only actually touch the database once awaited — making `.select()` itself
// async would break that chain (you can't call `.from()` on a Promise).
// The PGlite client's `query`/`exec`/`transaction` methods, by contrast,
// are the actual leaf calls drizzle-orm/pglite makes internally ONLY at the
// point a query is awaited — gating them is invisible to every caller
// above, whether that's drizzle's query builder or this file's own
// migration/seed code.
//
// WHY this doesn't deadlock against the migration/seed work that's what
// PRODUCES `whenReady` in the first place: migrations and seeding both run
// against the plain, UNGATED `client`/`internalDb` in `getDemoDb()` below —
// this wrapped version is only ever handed to the app-facing `db` that
// `getDb()` returns, so the code establishing readiness never waits on
// itself.
function withReadyGate(client: PGlite, whenReady: Promise<void>): PGlite {
  return new Proxy(client, {
    get(target, prop, receiver) {
      if (prop === 'query' || prop === 'exec' || prop === 'transaction') {
        const original = Reflect.get(target, prop, receiver) as (...args: unknown[]) => Promise<unknown>;
        return async (...args: unknown[]) => {
          await whenReady;
          return original.apply(target, args);
        };
      }
      return Reflect.get(target, prop, receiver);
    },
  }) as PGlite;
}

let cachedDemoDb: PgliteDatabase<typeof schema> | null = null;

// The lazy, once-per-process entry point lib/db/index.ts's getDb() calls
// when `isDemoMode()` is true.
export function getDemoDb(): PgliteDatabase<typeof schema> {
  if (cachedDemoDb) return cachedDemoDb;

  const client = new PGlite(DEMO_DB_DIR);
  // Ungated handle used ONLY by the migration/seed IIFE below — never
  // returned to the rest of the app.
  const internalDb = drizzle(client, { schema });

  let resolveReady!: () => void;
  const whenReady = new Promise<void>((resolve) => {
    resolveReady = resolve;
  });

  const gatedClient = withReadyGate(client, whenReady);
  const externalDb = drizzle(gatedClient, { schema });

  // Fire-and-forget setup: migrate, then seed, then release every query
  // that was waiting on `whenReady`. Errors are logged rather than thrown
  // here (there's no caller left to throw at, by the time this runs — see
  // getDemoDb()'s synchronous return below) and `resolveReady()` still
  // fires in the `catch`, so a broken demo database surfaces as a normal
  // Postgres query error on the next real request instead of every request
  // hanging forever waiting on a promise that can never resolve.
  (async () => {
    applyMigrations(client);
    await seedDemoData(internalDb);
  })()
    .then(() => resolveReady())
    .catch((err) => {
      console.error('FleetIQ demo mode: failed to set up the demo database', err);
      resolveReady();
    });

  // WHY the cast: `externalDb`'s underlying client is a Proxy typed as
  // plain `PGlite` (see withReadyGate above) — structurally identical to a
  // real PGlite instance for every property drizzle-orm/pglite actually
  // reads, but TypeScript can't verify a Proxy's shape against the concrete
  // class it wraps. The cast just states what's true at runtime.
  cachedDemoDb = externalDb as unknown as PgliteDatabase<typeof schema>;
  return cachedDemoDb;
}
