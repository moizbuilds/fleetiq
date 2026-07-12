/**
 * Database client — the one place that turns DATABASE_URL into a live
 * connection every other file in the app talks to.
 *
 * CONCEPT: Neon's "serverless" driver talks to Postgres over HTTP instead
 * of a persistent TCP socket. That matters on Vercel: serverless functions
 * are short-lived and can spin up hundreds of copies at once, and a
 * traditional TCP connection pool doesn't survive a function being frozen
 * between requests — HTTP has no long-lived connection to lose.
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
import { drizzle } from 'drizzle-orm/neon-http';
import { neon } from '@neondatabase/serverless';
import * as schema from './schema';

type Db = ReturnType<typeof drizzle<typeof schema>>;

let cached: Db | null = null;

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

export function getDb(): Db {
  if (cached) return cached;

  const url = process.env.DATABASE_URL;
  if (!url || isPlaceholder(url)) {
    throw new Error(
      'DATABASE_URL is missing or still a placeholder — set a real Neon connection string in .env.local (see .env.example).',
    );
  }

  const sql = neon(url);
  cached = drizzle(sql, { schema });
  return cached;
}
