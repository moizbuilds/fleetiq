// Unit tests for lib/rate-limit.ts — the per-tenant AI usage limiter.
//
// WHY PGlite (in-memory Postgres, see tests/schema.test.ts for the pattern
// this file reuses): checkRateLimit takes a real db handle as a parameter
// (dependency injection), so it can be exercised against a real Postgres
// engine — real COUNT/WHERE/ORDER BY semantics — with no network or a live
// Neon connection string.
import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import { PGlite } from '@electric-sql/pglite';
import { drizzle, type PgliteDatabase } from 'drizzle-orm/pglite';
import { readFileSync, readdirSync } from 'node:fs';
import path from 'node:path';
import * as schema from '@/lib/db/schema';
import { checkRateLimit, RATE_LIMITS } from '@/lib/rate-limit';

let client: PGlite;
let db: PgliteDatabase<typeof schema>;

// Identical to tests/schema.test.ts's migration runner — kept as its own
// copy here rather than a shared test helper because there are currently
// only two call sites; extracting a shared util now would be guessing at a
// shape a third test file hasn't proven out yet.
function applyMigrations(pglite: PGlite) {
  const migrationsDir = path.resolve(__dirname, '../drizzle');
  const sqlFiles = readdirSync(migrationsDir)
    .filter((f) => f.endsWith('.sql'))
    .sort();

  for (const file of sqlFiles) {
    const raw = readFileSync(path.join(migrationsDir, file), 'utf-8');
    const statements = raw
      .split('--> statement-breakpoint')
      .map((s) => s.trim())
      .filter(Boolean);

    for (const statement of statements) {
      pglite.exec(statement);
    }
  }
}

beforeAll(async () => {
  client = new PGlite();
  applyMigrations(client);
  db = drizzle(client, { schema });
});

afterAll(async () => {
  await client.close();
});

// Each test starts from an empty ai_usage table so limits don't bleed
// across tests that share the same in-memory PGlite instance.
beforeEach(async () => {
  await db.delete(schema.aiUsage);
});

describe('RATE_LIMITS', () => {
  it('defines the schedule and invoice limits used across the app', () => {
    expect(RATE_LIMITS.schedule).toEqual({ limit: 10, windowMinutes: 60 });
    expect(RATE_LIMITS.invoice).toEqual({ limit: 20, windowMinutes: 60 });
  });
});

describe('checkRateLimit', () => {
  it('allows the first `limit` calls, then denies the next one', async () => {
    const first = await checkRateLimit(db, 'org_a', 'schedule', 2, 60);
    expect(first).toEqual({ allowed: true });

    const second = await checkRateLimit(db, 'org_a', 'schedule', 2, 60);
    expect(second).toEqual({ allowed: true });

    const third = await checkRateLimit(db, 'org_a', 'schedule', 2, 60);
    expect(third.allowed).toBe(false);
    if (!third.allowed) {
      // Both prior calls happened moments ago, well within a 60-minute
      // window — the oldest row won't age out for roughly another hour.
      expect(third.retryAfterMinutes).toBeGreaterThan(0);
      expect(third.retryAfterMinutes).toBeLessThanOrEqual(60);
    }
  });

  it('does not record a usage row on a denied call', async () => {
    await checkRateLimit(db, 'org_b', 'schedule', 1, 60);
    await checkRateLimit(db, 'org_b', 'schedule', 1, 60); // denied — must not insert

    const rows = await db.select().from(schema.aiUsage);
    expect(rows).toHaveLength(1);
  });

  it('keys the limit only on tenantId — one tenant hitting its limit does not affect another', async () => {
    await checkRateLimit(db, 'org_c', 'schedule', 1, 60);
    const otherTenant = await checkRateLimit(db, 'org_d', 'schedule', 1, 60);
    expect(otherTenant).toEqual({ allowed: true });
  });

  it('keys the limit per endpoint — schedule usage does not count against invoice', async () => {
    await checkRateLimit(db, 'org_e', 'schedule', 1, 60);
    const invoiceCall = await checkRateLimit(db, 'org_e', 'invoice', 1, 60);
    expect(invoiceCall).toEqual({ allowed: true });
  });

  it('ignores rows that have already aged out of the window', async () => {
    // Insert a row stamped well outside a 60-minute window (2 hours ago) —
    // a call with limit 1 should still be allowed since that row shouldn't
    // count.
    const twoHoursAgo = new Date(Date.now() - 2 * 60 * 60_000);
    await db.insert(schema.aiUsage).values({
      tenantId: 'org_f',
      endpoint: 'schedule',
      createdAt: twoHoursAgo,
    });

    const result = await checkRateLimit(db, 'org_f', 'schedule', 1, 60);
    expect(result).toEqual({ allowed: true });
  });
});
