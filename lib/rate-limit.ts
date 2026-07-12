/**
 * Per-tenant rate limiting for paid AI endpoints (schedule generation now,
 * invoice extraction in a later task). Every call that reaches Claude costs
 * real money, so globals.md requires a DB-backed limit on top of the
 * per-request size caps already in lib/ai/schedule.ts's prompt.
 *
 * WHY the db handle is a PARAMETER instead of this file calling getDb()
 * itself: dependency injection (same reasoning as lib/status.ts's injected
 * clock) — tests below run against an in-memory PGlite database with no
 * network, while the real route handler passes the live Neon connection.
 * If this function called getDb() internally, it could never be unit
 * tested without a real Postgres connection string.
 *
 * WHY tenantId is a plain parameter this file trusts blindly rather than
 * re-verifying it: the caller (app/api/ai/schedule/route.ts) is the one
 * place responsible for resolving tenantId from a verified Clerk session —
 * see globals.md's trust-boundary rule ("never key a rate limit ... on
 * unverified input"). This module's job starts *after* that's already been
 * established.
 */
import { and, eq, sql } from 'drizzle-orm';
import type { NeonHttpDatabase } from 'drizzle-orm/neon-http';
import type { PgliteDatabase } from 'drizzle-orm/pglite';
import { aiUsage } from './db/schema';
import type * as schema from './db/schema';

// Accepts either driver's database handle — Neon's HTTP driver in
// production, PGlite's in-memory one in tests (see lib/db/index.ts and
// tests/schema.test.ts for where each comes from).
export type RateLimitDb = NeonHttpDatabase<typeof schema> | PgliteDatabase<typeof schema>;

// Single source of truth for every AI endpoint's limit — Task 7's invoice
// extraction imports this same object instead of hard-coding its own "20"
// somewhere else that could drift from this one.
export const RATE_LIMITS = {
  schedule: { limit: 10, windowMinutes: 60 },
  invoice: { limit: 20, windowMinutes: 60 },
} as const;

export type RateLimitEndpoint = keyof typeof RATE_LIMITS;

export type RateLimitResult = { allowed: true } | { allowed: false; retryAfterMinutes: number };

export async function checkRateLimit(
  db: RateLimitDb,
  tenantId: string,
  endpoint: RateLimitEndpoint,
  limit: number,
  windowMinutes: number,
): Promise<RateLimitResult> {
  // WHY the window boundary and the "minutes until reset" figure are BOTH
  // computed inside this one SQL query (via `now()` and `make_interval`)
  // instead of comparing `aiUsage.createdAt` against a `new Date()` built
  // in this Node process: this file's `created_at` column is a Postgres
  // `timestamp` with NO time zone attached. Reading such a column back
  // through a driver hands JS a plain Date built from a "naive" wall-clock
  // string, and different drivers/environments disagree on what time zone
  // that string implicitly means — worked out the hard way in this task's
  // own PGlite test, where a naive round-trip skewed every reading by
  // exactly the local machine's UTC offset. Doing the whole comparison
  // inside Postgres means there is only ONE clock involved (the database's
  // own `now()`), so this function's correctness can't depend on what time
  // zone the Node process (or CI, or a contributor's laptop) happens to be
  // running in.
  const [row] = await db
    .select({
      usedCount: sql<number>`count(*)::int`,
      minutesUntilReset: sql<number | null>`
        extract(epoch from (min(${aiUsage.createdAt}) + make_interval(mins => ${windowMinutes}) - now())) / 60
      `,
    })
    .from(aiUsage)
    .where(
      and(
        eq(aiUsage.tenantId, tenantId),
        eq(aiUsage.endpoint, endpoint),
        sql`${aiUsage.createdAt} >= now() - make_interval(mins => ${windowMinutes})`,
      ),
    );

  if (row.usedCount >= limit) {
    // Math.max(1, ...) guards the boundary millisecond where the window
    // has *just* elapsed — "try again in 0 minutes" isn't a sane message.
    const retryAfterMinutes = Math.max(1, Math.ceil(row.minutesUntilReset ?? 0));
    return { allowed: false, retryAfterMinutes };
  }

  await db.insert(aiUsage).values({ tenantId, endpoint });
  return { allowed: true };
}
