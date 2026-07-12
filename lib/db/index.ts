/**
 * Database client — the one place that turns DATABASE_URL into a live
 * connection every other file in the app talks to.
 *
 * CONCEPT: Neon's "serverless" driver family has two flavors. `neon()`
 * (drizzle-orm/neon-http, Tasks 1-5's driver) talks to Postgres over plain
 * HTTP — one request per query, no connection held open between them. That
 * makes it a great fit for a Vercel function that might get frozen between
 * requests, but it comes with a hard limit: there's no persistent session
 * for Postgres to run a real multi-statement transaction (BEGIN ... COMMIT)
 * against, so `db.transaction()` throws on it outright. `Pool` (this file's
 * driver, drizzle-orm/neon-serverless) instead opens a real — if
 * short-lived — Postgres session over a WebSocket, which DOES support
 * `db.transaction()`. Task 6's completeService needs exactly that: read the
 * vehicle's latest odometer reading and write two-to-three rows as one
 * atomic, consistent-snapshot unit (see lib/actions/services.ts), which is
 * precisely what a transaction is for and what the HTTP driver can't do.
 *
 * CONCEPT: a WebSocket is a persistent, two-way connection — unlike a
 * regular HTTP request/response, it stays open so both sides can keep
 * talking over it, which is what lets `Pool` hold a real Postgres session.
 * Browsers have a built-in `WebSocket` client; a Node.js server process
 * (this app's Vercel/local runtime) does not, so the `ws` npm package
 * stands in for one — `neonConfig.webSocketConstructor = ws` is the one
 * line that tells Neon's Pool which implementation to use.
 *
 * WHY lazy (`getDb()`) instead of connecting at module load time: Next.js
 * imports every route module while *building* the app (to trace its
 * dependencies), even routes that are never called. If this file threw at
 * import time whenever DATABASE_URL was a placeholder, `next build` would
 * fail even for someone who hasn't set up a database yet — exactly the
 * scaffolding-with-placeholder-env scenario Task 1 built around. Throwing
 * only inside `getDb()` means the error surfaces the moment a route
 * actually tries to query, with a message that says what's wrong, instead
 * of an opaque build failure or (worse) a silent connection to nowhere.
 */
import { drizzle, type NeonDatabase } from 'drizzle-orm/neon-serverless';
import { Pool, neonConfig } from '@neondatabase/serverless';
import type { PgTransaction, PgQueryResultHKT } from 'drizzle-orm/pg-core';
import type { ExtractTablesWithRelations } from 'drizzle-orm';
import ws from 'ws';
import * as schema from './schema';
import { isDemoMode } from '../demo';
import { getDemoDb } from './demo-db';

neonConfig.webSocketConstructor = ws;

type Db = NeonDatabase<typeof schema>;

// ---------------------------------------------------------------------------
// Transaction type shared by every server action whose core logic runs
// inside `db.transaction()` (Task 6's logOdometer/completeService) AND must
// be unit-testable against an in-memory PGlite database (see
// tests/rollforward.test.ts) — the same dependency-injection reasoning as
// lib/rate-limit.ts's `RateLimitDb` parameter.
//
// WHY `PgQueryResultHKT` (the base/abstract result-shape generic) instead of
// this driver's own `NeonQueryResultHKT`: a core function only ever calls
// `.select()/.insert()/.update()/.where()` — the shared query-builder API
// every pg driver exposes — never anything that depends on the RAW
// query-result shape (`.rows`, driver-specific metadata). Typing against the
// abstract base is what lets the exact same `AppTx` type describe both this
// driver's `NeonTransaction` (production) and PGlite's `PgliteTransaction`
// (tests) — pinning it to one driver's concrete result type would make the
// other driver's transaction object fail to structurally match.
//
// WHY `ExtractTablesWithRelations<typeof schema>` for the third generic
// (Drizzle's "relational query" config) instead of the simpler-looking
// `Record<string, never>`: every real `db.transaction()` callback — on
// either driver — actually receives THIS derived shape (Drizzle computes it
// from schema.ts even though this app never defines `relations()` calls),
// not an empty record. Typing `AppTx` with the wrong third generic compiles
// fine on its own but then fails the moment a real `db.transaction(tx => ...)`
// call tries to pass its `tx` to a function expecting `AppTx` — caught by
// `npx tsc --noEmit` while wiring up lib/actions/odometer.ts.
export type AppTx = PgTransaction<PgQueryResultHKT, typeof schema, ExtractTablesWithRelations<typeof schema>>;

// WHY three checks instead of just the `user:password@host` substring: that
// substring only catches the exact placeholder .env.example ships with. A
// value like `postgresql://user:password@host/db?sslmode=placeholder` would
// slip past a narrower check, and so would any string that isn't even a
// valid URL (a copy-paste mistake that dropped the scheme, for instance) —
// `neon()` would then fail deep inside the driver with a confusing error
// instead of this file's clear one. Checking for the literal word
// "placeholder" anywhere catches variations on the example value; the
// `new URL()` parse catches anything that isn't a real connection string at
// all.
function isPlaceholder(url: string): boolean {
  if (url.includes('user:password@host')) return true;
  if (url.includes('placeholder')) return true;

  try {
    new URL(url);
    return false;
  } catch {
    return true;
  }
}

let cached: Db | null = null;

export function getDb(): Db {
  // Demo mode (lib/demo.ts) swaps Neon for a local, file-backed PGlite
  // database — see lib/db/demo-db.ts for the setup (migrations + seed data)
  // this branches to. WHY this check runs FIRST, before anything below
  // even reads DATABASE_URL: demo mode is meant to work with ZERO env vars
  // set at all, and the Neon branch below throws the instant DATABASE_URL
  // is missing/placeholder — this early return is what keeps that throw
  // from ever running when FLEETIQ_DEMO=1. Every other line in this
  // function (the Neon Pool, the placeholder check, the `cached` var
  // below) is completely unreached in demo mode, so the production path
  // stays byte-for-byte what it was before demo mode existed.
  if (isDemoMode()) {
    // WHY the cast: `getDemoDb()` returns a `PgliteDatabase`, not a
    // `NeonDatabase` — a different concrete drizzle driver class than this
    // function's `Db` return type names. Every caller of `getDb()` only
    // ever uses the shared query-builder surface both drivers implement
    // identically (`.select()/.insert()/.update()/.where()/.transaction()`
    // — see lib/queries.ts's `QueryDb` and lib/rate-limit.ts's
    // `RateLimitDb`, which already type their own `db` parameters as
    // exactly this two-driver union), so the cast doesn't change what any
    // caller can actually do with the result — it just tells TypeScript
    // what's already true at runtime, the same way lib/queries.ts's
    // `rankItems` cast does for a structurally-identical reason.
    return getDemoDb() as unknown as Db;
  }

  if (cached) return cached;

  const url = process.env.DATABASE_URL;
  if (!url || isPlaceholder(url)) {
    throw new Error(
      'DATABASE_URL is missing or still a placeholder — set a real Neon connection string in .env.local (see .env.example).',
    );
  }

  const pool = new Pool({ connectionString: url });
  cached = drizzle(pool, { schema });
  return cached;
}
