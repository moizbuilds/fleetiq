// Unit tests for lib/actions/schedule-core.ts's updateScheduleItemCore (fix
// round 1, item 4 — the inline interval-edit feature deferred from Task 8).
//
// WHY these call the CORE function directly (never the exported
// updateScheduleItem server action): that wrapper calls requireTenant(),
// which needs a live Clerk session — the same dependency-injection reasoning
// as tests/rollforward.test.ts's use of logOdometerCore/completeServiceCore.
// Each test opens its own db.transaction() (mirroring how the real server
// action calls this core) against a real Postgres engine (PGlite, in-memory,
// no network).
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { PGlite } from '@electric-sql/pglite';
import { drizzle, type PgliteDatabase } from 'drizzle-orm/pglite';
import { eq } from 'drizzle-orm';
import { readFileSync, readdirSync } from 'node:fs';
import path from 'node:path';
import * as schema from '@/lib/db/schema';
import { updateScheduleItemCore, ScheduleItemValidationError } from '@/lib/actions/schedule-core';
import { updateScheduleItemInputSchema } from '@/lib/types';

let client: PGlite;
let db: PgliteDatabase<typeof schema>;

// Identical migration runner to tests/schema.test.ts / tests/rollforward.test.ts.
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

const TENANT = 'org_schedule_edit_test';

async function seedVehicle(nickname: string) {
  const [vehicle] = await db
    .insert(schema.vehicles)
    .values({ tenantId: TENANT, nickname, decodeSource: 'manual' })
    .returning();
  return vehicle;
}

async function seedScheduleItem(vehicleId: string, overrides: Partial<typeof schema.scheduleItems.$inferInsert> = {}) {
  const [item] = await db
    .insert(schema.scheduleItems)
    .values({
      vehicleId,
      tenantId: TENANT,
      name: 'Oil change',
      intervalKm: 10_000,
      intervalMonths: null,
      nextDueKm: 20_000,
      nextDueDate: null,
      source: 'ai',
      ...overrides,
    })
    .returning();
  return item;
}

describe('updateScheduleItemCore', () => {
  it('recomputes thresholds from the item\'s last completion (not "today") when one exists', async () => {
    const vehicle = await seedVehicle('Completed-Item Van');
    const item = await seedScheduleItem(vehicle.id);
    await db.insert(schema.serviceEvents).values({
      vehicleId: vehicle.id,
      tenantId: TENANT,
      scheduleItemId: item.id,
      title: 'Oil change',
      odometerKm: 18_000,
      performedOn: '2026-05-01',
    });
    // A LATER odometer reading than the last completion, logged after — if
    // the recompute wrongly anchored on "current latest reading" instead of
    // the last completion, this test would catch it (30,000 + 12,000 =
    // 42,000, not the expected 18,000 + 12,000 = 30,000).
    await db.insert(schema.odometerReadings).values({
      vehicleId: vehicle.id,
      tenantId: TENANT,
      readingKm: 30_000,
      source: 'manual',
    });

    const vehicleId = await db.transaction((tx) =>
      updateScheduleItemCore(
        tx,
        TENANT,
        { scheduleItemId: item.id, intervalKm: 12_000, intervalMonths: 6 },
        new Date('2026-07-12T12:00:00.000Z'),
      ),
    );
    expect(vehicleId).toBe(vehicle.id);

    const [updated] = await db.select().from(schema.scheduleItems).where(eq(schema.scheduleItems.id, item.id));
    expect(updated.intervalKm).toBe(12_000);
    expect(updated.intervalMonths).toBe(6);
    expect(updated.nextDueKm).toBe(30_000); // 18,000 (last completion odometer) + 12,000
    expect(updated.nextDueDate).toBe('2026-11-01'); // 2026-05-01 (last completion date) + 6 months
    expect(updated.source).toBe('user'); // flipped from 'ai'
  });

  it('recomputes from the latest odometer reading + today when the item has no completion yet', async () => {
    const vehicle = await seedVehicle('No-Completion Van');
    const item = await seedScheduleItem(vehicle.id, { source: 'ai' });
    await db.insert(schema.odometerReadings).values({
      vehicleId: vehicle.id,
      tenantId: TENANT,
      readingKm: 15_000,
      source: 'manual',
    });

    await db.transaction((tx) =>
      updateScheduleItemCore(
        tx,
        TENANT,
        { scheduleItemId: item.id, intervalKm: 5_000, intervalMonths: null },
        new Date('2026-07-12T12:00:00.000Z'),
      ),
    );

    const [updated] = await db.select().from(schema.scheduleItems).where(eq(schema.scheduleItems.id, item.id));
    expect(updated.nextDueKm).toBe(20_000); // 15,000 (latest reading) + 5,000
    expect(updated.nextDueDate).toBeNull(); // months-only edit wasn't set — null-safe
    expect(updated.source).toBe('user');
  });

  it('falls back to a null km base when the vehicle has no completion AND no odometer reading at all', async () => {
    const vehicle = await seedVehicle('No-Reading Van');
    const item = await seedScheduleItem(vehicle.id);

    await db.transaction((tx) =>
      updateScheduleItemCore(
        tx,
        TENANT,
        { scheduleItemId: item.id, intervalKm: 8_000, intervalMonths: null },
        new Date('2026-07-12T12:00:00.000Z'),
      ),
    );

    const [updated] = await db.select().from(schema.scheduleItems).where(eq(schema.scheduleItems.id, item.id));
    // Null-safe: no reading to add the interval to, so nextDueKm stays null
    // rather than crashing or silently treating "no reading" as 0km.
    expect(updated.nextDueKm).toBeNull();
  });

  it('404s (throws) for a schedule item belonging to a different tenant', async () => {
    const vehicle = await seedVehicle('Cross-Tenant Schedule Van');
    const item = await seedScheduleItem(vehicle.id);

    await expect(
      db.transaction((tx) =>
        updateScheduleItemCore(
          tx,
          'org_someone_else',
          { scheduleItemId: item.id, intervalKm: 5_000, intervalMonths: null },
          new Date('2026-07-12T12:00:00.000Z'),
        ),
      ),
    ).rejects.toThrow(ScheduleItemValidationError);
  });
});

// Schema-level check for the "both km and months null" rule — a pure shape
// rule with no DB dependency, so it's asserted directly against the Zod
// schema (same convention as tests/types.test.ts's aiScheduleSchema tests)
// rather than needing a PGlite transaction of its own.
describe('updateScheduleItemInputSchema', () => {
  it('rejects an edit with both intervalKm and intervalMonths null', () => {
    const result = updateScheduleItemInputSchema.safeParse({
      scheduleItemId: '11111111-1111-1111-1111-111111111111',
      intervalKm: null,
      intervalMonths: null,
    });
    expect(result.success).toBe(false);
  });

  it('accepts an edit with only intervalKm set', () => {
    const result = updateScheduleItemInputSchema.safeParse({
      scheduleItemId: '11111111-1111-1111-1111-111111111111',
      intervalKm: 10_000,
      intervalMonths: null,
    });
    expect(result.success).toBe(true);
  });
});
