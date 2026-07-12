// Unit tests for Task 6's transactional core functions —
// lib/actions/odometer.ts's logOdometerCore and lib/actions/services.ts's
// completeServiceCore.
//
// WHY these call the CORE functions directly (never the exported
// logOdometer/completeService server actions): those wrappers call
// requireTenant(), which needs a live Clerk session — exactly the
// dependency injection lib/rate-limit.ts's checkRateLimit already
// established (see tests/rate-limit.test.ts). Each test opens its own
// db.transaction() (mirroring exactly how the real server actions call
// these cores) so the "read latest reading, decide, write" sequence is
// exercised the same way production runs it, against a real Postgres
// engine (PGlite, in-memory, no network — see tests/schema.test.ts).
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { PGlite } from '@electric-sql/pglite';
import { drizzle, type PgliteDatabase } from 'drizzle-orm/pglite';
import { eq } from 'drizzle-orm';
import { readFileSync, readdirSync } from 'node:fs';
import path from 'node:path';
import * as schema from '@/lib/db/schema';
import { logOdometerCore, OdometerValidationError } from '@/lib/actions/odometer-core';
import { completeServiceCore } from '@/lib/actions/services-core';

let client: PGlite;
let db: PgliteDatabase<typeof schema>;

// Identical migration runner to tests/schema.test.ts / tests/rate-limit.test.ts.
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

const TENANT = 'org_rollforward_test';

// Seeds a fresh vehicle (+ optionally a schedule item) for one test, so
// tests never share odometer-reading history with each other.
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
      intervalMonths: 6,
      nextDueKm: 20_000,
      nextDueDate: '2026-01-01',
      source: 'user',
      ...overrides,
    })
    .returning();
  return item;
}

describe('completeServiceCore — threshold rollforward', () => {
  it('rolls a scheduled item forward from the service odometer/date, writes a service_events row and an odometer reading', async () => {
    const vehicle = await seedVehicle('Rollforward Van');
    const item = await seedScheduleItem(vehicle.id);

    await db.transaction(async (tx) => {
      await completeServiceCore(
        tx,
        TENANT,
        {
          vehicleId: vehicle.id,
          scheduleItemId: item.id,
          title: null,
          odometerKm: 21_340,
          performedOn: '2026-07-12',
          costQar: 250,
          notes: 'Full synthetic',
          invoicePhotoUrl: null,
        },
        new Date('2026-07-12T12:00:00.000Z'),
      );
    });

    const [updatedItem] = await db.select().from(schema.scheduleItems).where(eq(schema.scheduleItems.id, item.id));
    expect(updatedItem.nextDueKm).toBe(31_340); // 21,340 + 10,000
    expect(updatedItem.nextDueDate).toBe('2027-01-12'); // 2026-07-12 + 6 months

    const events = await db
      .select()
      .from(schema.serviceEvents)
      .where(eq(schema.serviceEvents.vehicleId, vehicle.id));
    expect(events).toHaveLength(1);
    expect(events[0].title).toBe('Oil change'); // defaulted from the item's own name
    expect(events[0].odometerKm).toBe(21_340);
    expect(events[0].costQar).toBe('250.00');

    const readings = await db
      .select()
      .from(schema.odometerReadings)
      .where(eq(schema.odometerReadings.vehicleId, vehicle.id));
    expect(readings).toHaveLength(1);
    expect(readings[0].readingKm).toBe(21_340);
    expect(readings[0].source).toBe('service');
  });

  it('rolls nothing for an unscheduled repair (null scheduleItemId)', async () => {
    const vehicle = await seedVehicle('Unscheduled Repair Van');
    const item = await seedScheduleItem(vehicle.id, { nextDueKm: 20_000, nextDueDate: '2026-01-01' });

    await db.transaction(async (tx) => {
      await completeServiceCore(
        tx,
        TENANT,
        {
          vehicleId: vehicle.id,
          scheduleItemId: null,
          title: 'Replaced flat tyre',
          odometerKm: 15_000,
          performedOn: '2026-07-12',
          costQar: null,
          notes: null,
          invoicePhotoUrl: null,
        },
        new Date('2026-07-12T12:00:00.000Z'),
      );
    });

    // The pre-existing scheduled item is completely untouched.
    const [untouchedItem] = await db.select().from(schema.scheduleItems).where(eq(schema.scheduleItems.id, item.id));
    expect(untouchedItem.nextDueKm).toBe(20_000);
    expect(untouchedItem.nextDueDate).toBe('2026-01-01');

    const events = await db
      .select()
      .from(schema.serviceEvents)
      .where(eq(schema.serviceEvents.vehicleId, vehicle.id));
    expect(events).toHaveLength(1);
    expect(events[0].scheduleItemId).toBeNull();
    expect(events[0].title).toBe('Replaced flat tyre');
  });

  it('skips inserting a duplicate odometer reading when the service km exactly equals the latest reading', async () => {
    const vehicle = await seedVehicle('Same-Km Service Van');
    await db.insert(schema.odometerReadings).values({
      vehicleId: vehicle.id,
      tenantId: TENANT,
      readingKm: 18_000,
      source: 'manual',
    });

    await db.transaction(async (tx) => {
      await completeServiceCore(
        tx,
        TENANT,
        {
          vehicleId: vehicle.id,
          scheduleItemId: null,
          title: 'Brake pads',
          odometerKm: 18_000, // exactly the latest reading
          performedOn: '2026-07-12',
          costQar: null,
          notes: null,
          invoicePhotoUrl: null,
        },
        new Date('2026-07-12T12:00:00.000Z'),
      );
    });

    const readings = await db
      .select()
      .from(schema.odometerReadings)
      .where(eq(schema.odometerReadings.vehicleId, vehicle.id));
    expect(readings).toHaveLength(1); // still just the original manual reading — no duplicate
  });

  it('rejects a below-latest odometer reading with the shared typed error, and writes nothing', async () => {
    const vehicle = await seedVehicle('Below Latest Service Van');
    await db.insert(schema.odometerReadings).values({
      vehicleId: vehicle.id,
      tenantId: TENANT,
      readingKm: 20_000,
      source: 'manual',
      recordedAt: new Date('2026-07-05T09:00:00.000Z'),
    });

    await expect(
      db.transaction(async (tx) => {
        await completeServiceCore(
          tx,
          TENANT,
          {
            vehicleId: vehicle.id,
            scheduleItemId: null,
            title: 'Wiper blades',
            odometerKm: 19_500,
            performedOn: '2026-07-12',
            costQar: null,
            notes: null,
            invoicePhotoUrl: null,
          },
          new Date('2026-07-12T12:00:00.000Z'),
        );
      }),
    ).rejects.toThrow(OdometerValidationError);

    // Transaction rolled back — no service_events row from the failed attempt.
    const events = await db
      .select()
      .from(schema.serviceEvents)
      .where(eq(schema.serviceEvents.vehicleId, vehicle.id));
    expect(events).toHaveLength(0);
  });
});

describe('logOdometerCore', () => {
  it('rejects a reading below the last one with the exact typed message', async () => {
    const vehicle = await seedVehicle('Typo Guard Van');
    await db.insert(schema.odometerReadings).values({
      vehicleId: vehicle.id,
      tenantId: TENANT,
      readingKm: 12_730,
      source: 'manual',
      recordedAt: new Date('2026-07-05T09:00:00.000Z'),
    });

    await expect(
      db.transaction(async (tx) => {
        await logOdometerCore(tx, TENANT, {
          vehicleId: vehicle.id,
          readingKm: 12_480,
          isCorrection: false,
          note: null,
        });
      }),
    ).rejects.toThrow(
      '12,480 km is below the last reading (12,730 km on 5 Jul). Typo? If the odometer was replaced, use the correction option.',
    );

    const readings = await db
      .select()
      .from(schema.odometerReadings)
      .where(eq(schema.odometerReadings.vehicleId, vehicle.id));
    expect(readings).toHaveLength(1); // rejected reading never landed
  });

  it('allows a below-latest reading when isCorrection is true and a note is provided', async () => {
    const vehicle = await seedVehicle('Correction Override Van');
    await db.insert(schema.odometerReadings).values({
      vehicleId: vehicle.id,
      tenantId: TENANT,
      readingKm: 50_000,
      source: 'manual',
    });

    await db.transaction(async (tx) => {
      await logOdometerCore(tx, TENANT, {
        vehicleId: vehicle.id,
        readingKm: 1_000,
        isCorrection: true,
        note: 'Odometer replaced after dashboard swap.',
      });
    });

    const readings = await db
      .select()
      .from(schema.odometerReadings)
      .where(eq(schema.odometerReadings.vehicleId, vehicle.id));
    expect(readings).toHaveLength(2);
    const correction = readings.find((r) => r.readingKm === 1_000);
    expect(correction?.isCorrection).toBe(true);
  });

  it('rejects a correction with no note', async () => {
    const vehicle = await seedVehicle('Correction No Note Van');
    await db.insert(schema.odometerReadings).values({
      vehicleId: vehicle.id,
      tenantId: TENANT,
      readingKm: 50_000,
      source: 'manual',
    });

    await expect(
      db.transaction(async (tx) => {
        await logOdometerCore(tx, TENANT, {
          vehicleId: vehicle.id,
          readingKm: 1_000,
          isCorrection: true,
          note: null,
        });
      }),
    ).rejects.toThrow('A correction needs a note explaining why (e.g. odometer replaced).');

    const readings = await db
      .select()
      .from(schema.odometerReadings)
      .where(eq(schema.odometerReadings.vehicleId, vehicle.id));
    expect(readings).toHaveLength(1); // rejected correction never landed
  });

  it('allows an equal-or-higher reading with no correction needed', async () => {
    const vehicle = await seedVehicle('Normal Reading Van');
    await db.insert(schema.odometerReadings).values({
      vehicleId: vehicle.id,
      tenantId: TENANT,
      readingKm: 50_000,
      source: 'manual',
    });

    await db.transaction(async (tx) => {
      await logOdometerCore(tx, TENANT, {
        vehicleId: vehicle.id,
        readingKm: 50_500,
        isCorrection: false,
        note: null,
      });
    });

    const readings = await db
      .select()
      .from(schema.odometerReadings)
      .where(eq(schema.odometerReadings.vehicleId, vehicle.id));
    expect(readings).toHaveLength(2);
  });

  it('404s (throws) on a vehicle from a different tenant', async () => {
    const vehicle = await seedVehicle('Cross Tenant Van');

    await expect(
      db.transaction(async (tx) => {
        await logOdometerCore(tx, 'org_someone_else', {
          vehicleId: vehicle.id,
          readingKm: 1_000,
          isCorrection: false,
          note: null,
        });
      }),
    ).rejects.toThrow('Vehicle not found.');
  });
});
