// Unit tests for lib/queries.ts — the dashboard/vehicle-detail read layer
// (Task 8). Same PGlite pattern as tests/schema.test.ts and
// tests/rollforward.test.ts: a real in-memory Postgres engine, no network,
// so getFleetStatus/getVehicleDetail's raw `sql` DISTINCT ON / SUM /
// GROUP BY queries run against real Postgres semantics instead of a mock.
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { PGlite } from '@electric-sql/pglite';
import { drizzle, type PgliteDatabase } from 'drizzle-orm/pglite';
import { readFileSync, readdirSync } from 'node:fs';
import path from 'node:path';
import * as schema from '@/lib/db/schema';
import { getFleetStatus, getVehicleDetail } from '@/lib/queries';

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

const TENANT_A = 'org_queries_test_a';
const TENANT_B = 'org_queries_test_b';
const TODAY = new Date('2026-07-12T12:00:00.000Z');

let overdueTruck: typeof schema.vehicles.$inferSelect;
let okSedan: typeof schema.vehicles.$inferSelect;
let oilChangeItem: typeof schema.scheduleItems.$inferSelect;

beforeAll(async () => {
  client = new PGlite();
  applyMigrations(client);
  db = drizzle(client, { schema });

  // --- Tenant A: "Overdue Truck" — overdue oil change AND expired Istimara,
  // two odometer readings a year apart, two costed services (different
  // years) — this vehicle exercises worst-first ranking, compliance
  // pseudo-items, and the cost/costPerKm math all at once.
  [overdueTruck] = await db
    .insert(schema.vehicles)
    .values({
      tenantId: TENANT_A,
      nickname: 'Overdue Truck',
      decodeSource: 'manual',
      istimaraExpiry: '2020-01-01', // long expired
      fahesDue: null,
    })
    .returning();

  [oilChangeItem] = await db
    .insert(schema.scheduleItems)
    .values({
      vehicleId: overdueTruck.id,
      tenantId: TENANT_A,
      name: 'Oil change',
      intervalKm: 10_000,
      intervalMonths: null,
      nextDueKm: 20_000, // currentKm (25,000) already past this
      nextDueDate: null,
      source: 'user',
    })
    .returning();

  await db.insert(schema.odometerReadings).values([
    {
      vehicleId: overdueTruck.id,
      tenantId: TENANT_A,
      readingKm: 10_000,
      source: 'manual',
      recordedAt: new Date('2025-06-01T09:00:00.000Z'),
    },
    {
      vehicleId: overdueTruck.id,
      tenantId: TENANT_A,
      readingKm: 25_000,
      source: 'manual',
      recordedAt: new Date('2026-07-01T09:00:00.000Z'),
    },
  ]);

  await db.insert(schema.serviceEvents).values([
    {
      vehicleId: overdueTruck.id,
      tenantId: TENANT_A,
      scheduleItemId: null,
      title: 'Brake pads',
      odometerKm: 10_000,
      performedOn: '2025-06-01',
      costQar: '300.00',
    },
    {
      vehicleId: overdueTruck.id,
      tenantId: TENANT_A,
      scheduleItemId: oilChangeItem.id,
      title: 'Oil change',
      odometerKm: 25_000,
      performedOn: '2026-07-01',
      costQar: '200.00',
    },
  ]);

  // --- Tenant A: "OK Sedan" — everything comfortably not-due, exactly one
  // odometer reading (the null-costPerKm case: can't compute a per-km rate
  // from a single point).
  [okSedan] = await db
    .insert(schema.vehicles)
    .values({
      tenantId: TENANT_A,
      nickname: 'OK Sedan',
      decodeSource: 'manual',
      istimaraExpiry: '2030-01-01', // far future
      fahesDue: null,
    })
    .returning();

  await db.insert(schema.scheduleItems).values({
    vehicleId: okSedan.id,
    tenantId: TENANT_A,
    name: 'Oil change',
    intervalKm: 15_000,
    intervalMonths: null,
    nextDueKm: 20_000, // currentKm (5,000) is 15,000 away — comfortably ok
    nextDueDate: null,
    source: 'ai',
  });

  await db.insert(schema.odometerReadings).values({
    vehicleId: okSedan.id,
    tenantId: TENANT_A,
    readingKm: 5_000,
    source: 'manual',
  });

  // --- Tenant B: a vehicle that must be completely invisible to tenant A's
  // queries — the tenant-scoping assertion below.
  const [ghostTruck] = await db
    .insert(schema.vehicles)
    .values({ tenantId: TENANT_B, nickname: 'Ghost Truck', decodeSource: 'manual' })
    .returning();
  await db.insert(schema.odometerReadings).values({
    vehicleId: ghostTruck.id,
    tenantId: TENANT_B,
    readingKm: 999_999,
    source: 'manual',
  });
});

afterAll(async () => {
  await client.close();
});

describe('getFleetStatus', () => {
  it('only returns vehicles for the given tenant', async () => {
    const fleet = await getFleetStatus(db, TENANT_A, TODAY);
    expect(fleet).toHaveLength(2);
    expect(fleet.some((v) => v.nickname === 'Ghost Truck')).toBe(false);
  });

  it('sorts vehicles worst-first by their single worst item', async () => {
    const fleet = await getFleetStatus(db, TENANT_A, TODAY);
    expect(fleet[0].nickname).toBe('Overdue Truck');
    expect(fleet[0].worst.state).toBe('overdue');
    expect(fleet[1].nickname).toBe('OK Sedan');
    expect(fleet[1].worst.state).toBe('ok');
  });

  it('includes a compliance pseudo-item only when its date is actually set', async () => {
    const fleet = await getFleetStatus(db, TENANT_A, TODAY);
    const overdue = fleet.find((v) => v.nickname === 'Overdue Truck')!;
    const okVehicle = fleet.find((v) => v.nickname === 'OK Sedan')!;

    // Both vehicles have istimaraExpiry set, so both get an 'istimara' item —
    // the overdue truck's is overdue (expired long ago), the sedan's is ok
    // (far future).
    const overdueIstimara = overdue.items.find((i) => i.id === 'istimara');
    expect(overdueIstimara?.status.state).toBe('overdue');
    const sedanIstimara = okVehicle.items.find((i) => i.id === 'istimara');
    expect(sedanIstimara?.status.state).toBe('ok');

    // Neither vehicle set fahesDue — no 'fahes' pseudo-item should appear
    // for either, rather than a synthesized no_data entry dragging the
    // ranking down for nothing.
    expect(overdue.items.some((i) => i.id === 'fahes')).toBe(false);
    expect(okVehicle.items.some((i) => i.id === 'fahes')).toBe(false);

    // The real schedule item is present too, under its own DB id.
    expect(overdue.items.some((i) => i.id === oilChangeItem.id)).toBe(true);
  });

  it('reflects the latest odometer reading per vehicle (DISTINCT ON), not the first', async () => {
    const fleet = await getFleetStatus(db, TENANT_A, TODAY);
    const overdue = fleet.find((v) => v.nickname === 'Overdue Truck')!;
    expect(overdue.latestReadingKm).toBe(25_000); // not 10,000, the older reading
  });
});

describe('getVehicleDetail', () => {
  it('returns null for a vehicle id that belongs to a different tenant (404, not a leak)', async () => {
    const result = await getVehicleDetail(db, TENANT_B, overdueTruck.id, TODAY);
    expect(result).toBeNull();
  });

  it('computes per-year cost totals and a costPerKm derived from total cost ÷ reading span', async () => {
    const detail = await getVehicleDetail(db, TENANT_A, overdueTruck.id, TODAY);
    expect(detail).not.toBeNull();

    expect(detail!.costs.totalsByYear).toEqual([
      { year: 2026, totalQar: '200.00' },
      { year: 2025, totalQar: '300.00' },
    ]);
    expect(detail!.costs.serviceCount).toBe(2);
    expect(detail!.costs.distanceKm).toBe(15_000); // 25,000 - 10,000

    // total cost (300 + 200 = 500) ÷ distance (15,000 km)
    expect(detail!.costs.costPerKm).not.toBeNull();
    expect(detail!.costs.costPerKm!).toBeCloseTo(500 / 15_000, 6);
  });

  it('keeps compliance as its own section, always present, separate from scheduleItems', async () => {
    const detail = await getVehicleDetail(db, TENANT_A, overdueTruck.id, TODAY);
    expect(detail!.compliance.istimara.state).toBe('overdue');
    expect(detail!.compliance.fahes.state).toBe('no_data'); // never set for this vehicle
    // scheduleItems only ever contains real schedule_items rows — no
    // 'istimara'/'fahes' pseudo-entries mixed in (unlike the dashboard DTO).
    expect(detail!.scheduleItems.every(({ item }) => item.id !== 'istimara' && item.id !== 'fahes')).toBe(true);
  });

  it('orders history newest-first and joins the completed schedule item name', async () => {
    const detail = await getVehicleDetail(db, TENANT_A, overdueTruck.id, TODAY);
    expect(detail!.history).toHaveLength(2);
    expect(detail!.history[0].performedOn).toBe('2026-07-01'); // newest first
    expect(detail!.history[0].scheduleItemName).toBe('Oil change');
    expect(detail!.history[1].performedOn).toBe('2025-06-01');
    expect(detail!.history[1].scheduleItemName).toBeNull(); // unscheduled repair
  });

  it('returns a null costPerKm when the vehicle has fewer than 2 odometer readings', async () => {
    const detail = await getVehicleDetail(db, TENANT_A, okSedan.id, TODAY);
    expect(detail).not.toBeNull();
    expect(detail!.costs.costPerKm).toBeNull();
    expect(detail!.costs.totalsByYear).toEqual([]); // no costed services at all yet
  });
});
