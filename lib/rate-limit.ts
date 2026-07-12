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
import type { NeonDatabase } from 'drizzle-orm/neon-serverless';
import type { PgliteDatabase } from 'drizzle-orm/pglite';
import { aiUsage } from './db/schema';
import type * as schema from './db/schema';

// Accepts either driver's database handle — Neon's Pool/WebSocket driver in
// production (drizzle-orm/neon-serverless, see lib/db/index.ts for why
// Task 6 moved off the HTTP-only driver), PGlite's in-memory one in tests
// (see tests/schema.test.ts for where that comes from). This raw `sql`
// INSERT...SELECT...WHERE statement is driver-agnostic Postgres — nothing
// about it depends on which of the two actually executes it, which is what
// tests/rate-limit.test.ts (unchanged by the driver migration) proves by
// running it straight against PGlite.
export type RateLimitDb = NeonDatabase<typeof schema> | PgliteDatabase<typeof schema>;

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
  // WHY the "is this call under the limit" check and the row that RECORDS
  // this call are ONE INSERT...SELECT...WHERE...RETURNING statement instead
  // of a SELECT-count-then-INSERT pair (the original implementation): two
  // separate round trips leave a gap between "count came back below the
  // limit" and "row got inserted" where OTHER concurrent requests can read
  // that same below-limit count before any of them has inserted yet — every
  // one of them sees "allowed" and all insert, overshooting the cap by as
  // many requests as arrived in that gap. A single statement closes this:
  // Postgres evaluates the WHERE subquery's count(*) and performs (or skips)
  // this statement's own INSERT against one consistent snapshot, so no
  // request running this exact statement can straddle that gap.
  //
  // Residual risk, accepted rather than eliminated: Neon's HTTP driver has
  // no session/connection to hold an advisory lock across statements, and
  // each HTTP call may land on a different underlying Postgres connection —
  // so two requests whose single INSERT statements execute at the EXACT
  // same instant on different connections could still both pass. That
  // window is far narrower than the old two-round-trip gap (bounded by true
  // statement-level simultaneity, not by network latency between a SELECT
  // and an INSERT), and closing it fully would need a lock primitive this
  // driver doesn't expose — see tests/rate-limit.test.ts for the "denied
  // call inserts no row" test that pins the fix's actual behavior.
  const insertResult = await db.execute<{ id: string }>(sql`
    INSERT INTO ai_usage (tenant_id, endpoint)
    SELECT ${tenantId}, ${endpoint}
    WHERE (
      SELECT count(*) FROM ai_usage
      WHERE tenant_id = ${tenantId}
        AND endpoint = ${endpoint}
        AND created_at > now() - make_interval(mins => ${windowMinutes})
    ) < ${limit}
    RETURNING id
  `);

  if (insertResult.rows.length > 0) {
    return { allowed: true };
  }

  // Denied — the INSERT above was skipped (no row landed), so this is a
  // read-only follow-up purely to compute the "try again in N minutes"
  // figure for the caller. WHY this second query still does the whole
  // "minutes until reset" calculation inside SQL (via `now()` and
  // `make_interval`) rather than comparing `aiUsage.createdAt` against a
  // `new Date()` built in this Node process: this table's `created_at`
  // column is a Postgres `timestamp` with NO time zone attached. Reading
  // such a column back through a driver hands JS a plain Date built from a
  // "naive" wall-clock string, and different drivers/environments disagree
  // on what time zone that string implicitly means — worked out the hard
  // way in this task's own PGlite test, where a naive round-trip skewed
  // every reading by exactly the local machine's UTC offset. Doing the
  // whole comparison inside Postgres means there is only ONE clock involved
  // (the database's own `now()`), so this function's correctness can't
  // depend on what time zone the Node process (or CI, or a contributor's
  // laptop) happens to be running in.
  const [row] = await db
    .select({
      minutesUntilReset: sql<number | null>`
        extract(epoch from (min(${aiUsage.createdAt}) + make_interval(mins => ${windowMinutes}) - now())) / 60
      `,
    })
    .from(aiUsage)
    .where(
      and(
        eq(aiUsage.tenantId, tenantId),
        eq(aiUsage.endpoint, endpoint),
        sql`${aiUsage.createdAt} > now() - make_interval(mins => ${windowMinutes})`,
      ),
    );

  // Math.max(1, ...) guards the boundary millisecond where the window has
  // *just* elapsed — "try again in 0 minutes" isn't a sane message.
  const retryAfterMinutes = Math.max(1, Math.ceil(row?.minutesUntilReset ?? 0));
  return { allowed: false, retryAfterMinutes };
}
