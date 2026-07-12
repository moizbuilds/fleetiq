/**
 * Demo fleet — sample data for demo mode (lib/demo.ts) so the dashboard,
 * vehicle detail page, and cost/history sections all have something real to
 * show with zero external services. Four vans, chosen so the dashboard's
 * three status colors (globals.md: red/amber/green) AND a vehicle with no
 * schedule at all (the "generate schedule" empty state) are all visible on
 * the very first load:
 *
 *   Van 1 — Salwa Road route  (Toyota Hiace)    → one item OVERDUE (red)
 *   Van 2 — Industrial Area   (Nissan Urvan)     → one item DUE SOON (amber)
 *   Van 3 — Airport run       (Mitsubishi L200)  → everything OK (green)
 *   Van 4 — Spare             (Toyota Corolla)   → manual add, no schedule yet
 *
 * WHY dates/km thresholds are computed relative to `new Date()` AT SEED
 * TIME rather than a hardcoded calendar date: lib/status.ts's due-status
 * engine always compares a stored threshold against `new Date()` at RENDER
 * time (app/page.tsx passes `new Date()` into getFleetStatus on every
 * request) — a threshold baked in as a fixed past date would only read as
 * "overdue" for as long as that fixed date stays in the past, which is true
 * forever for something already overdue, but a hardcoded "10 days from
 * 2026-07-12" would silently drift into "overdue" instead of "due soon"
 * the first time someone opens the demo after that window passes. Deriving
 * every threshold from the actual clock at the moment this function runs
 * keeps the three statuses correct for as long as the demo exists, at the
 * cost of the concrete numbers moving slightly across process restarts —
 * an acceptable trade for a demo dataset that's never read by anything
 * else.
 *
 * WHY idempotent (checked, not just "insert-if-empty-table"): lib/db/index.ts
 * calls this on every process start in demo mode (the PGlite database
 * persists in `.demo-db/` across dev-server restarts, by design — so
 * anything a demo visitor adds survives a reload). Re-seeding on every
 * restart would either duplicate all four vans, or require deleting
 * everything first (destroying anything a visitor added). Checking for the
 * one row that only this function ever creates (Van 1, by nickname) and
 * bailing out if it's already there is the cheapest correct check.
 */
import { randomUUID } from 'node:crypto';
import { eq } from 'drizzle-orm';
import type { PgliteDatabase } from 'drizzle-orm/pglite';
import * as schema from './db/schema';
import { vehicles, scheduleItems, odometerReadings, serviceEvents } from './db/schema';
import { DEMO_TENANT_ID } from './demo';

const VAN_1_NICKNAME = 'Van 1 — Salwa Road route';

// ---------------------------------------------------------------------------
// Date/km helpers — every threshold below is expressed as "N days from now"
// or "current odometer ± N km" so the intent (overdue / due-soon / ok) reads
// directly off the seed data instead of a magic date string.
// ---------------------------------------------------------------------------

// `date` columns round-trip as plain YYYY-MM-DD strings (see lib/status.ts's
// header comment on why FleetIQ never stores dates as tz-bearing values) —
// this matches that shape exactly.
function dateOffset(today: Date, days: number): string {
  const d = new Date(today);
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, 10);
}

// `recordedAt`/`createdAt` are real timestamps (odometer readings, service
// history) — used to build a believable reading/service history that reads
// oldest-to-newest.
function timeOffset(today: Date, days: number): Date {
  const d = new Date(today);
  d.setUTCDate(d.getUTCDate() - days);
  return d;
}

export async function seedDemoData(db: PgliteDatabase<typeof schema>): Promise<void> {
  // Idempotency check — see header comment. Scoped by tenantId (not a global
  // COUNT) so this stays correct even if demo mode is ever pointed at a
  // shared database in the future.
  const [existing] = await db
    .select({ id: vehicles.id })
    .from(vehicles)
    .where(eq(vehicles.tenantId, DEMO_TENANT_ID))
    .limit(1);
  if (existing) return;

  const today = new Date();
  const van1Id = randomUUID();
  const van2Id = randomUUID();
  const van3Id = randomUUID();
  const van4Id = randomUUID();

  // ---------------------------------------------------------------------
  // Vehicles
  // ---------------------------------------------------------------------
  await db.insert(vehicles).values([
    {
      id: van1Id,
      tenantId: DEMO_TENANT_ID,
      nickname: VAN_1_NICKNAME,
      plate: '12345',
      vin: 'JT2AE09W5N0123456',
      make: 'Toyota',
      model: 'Hiace',
      year: 2022,
      engine: '2.8L Diesel',
      decodeSource: 'vpic',
      // Fahes ~10 days out → due_soon (DUE_SOON_DAYS boundary is 30, so 10
      // is comfortably inside it without being overdue).
      fahesDue: dateOffset(today, 10),
      // Istimara ~5 months out → ok.
      istimaraExpiry: dateOffset(today, 150),
    },
    {
      id: van2Id,
      tenantId: DEMO_TENANT_ID,
      nickname: 'Van 2 — Industrial Area',
      plate: '54321',
      vin: 'JN1AE0P5B0K012345',
      make: 'Nissan',
      model: 'Urvan',
      year: 2019,
      engine: '2.5L Diesel',
      decodeSource: 'vpic',
      // Both compliance dates comfortably far out → ok.
      fahesDue: dateOffset(today, 220),
      istimaraExpiry: dateOffset(today, 280),
    },
    {
      id: van3Id,
      tenantId: DEMO_TENANT_ID,
      nickname: 'Van 3 — Airport run',
      plate: '99887',
      vin: 'MMBJNKB40MH012345',
      make: 'Mitsubishi',
      model: 'L200',
      year: 2021,
      engine: '2.4L Diesel',
      decodeSource: 'vpic',
      fahesDue: dateOffset(today, 300),
      istimaraExpiry: dateOffset(today, 340),
    },
    {
      id: van4Id,
      tenantId: DEMO_TENANT_ID,
      nickname: 'Van 4 — Spare',
      plate: null,
      vin: null,
      make: 'Toyota',
      model: 'Corolla',
      year: 2023,
      engine: null,
      decodeSource: 'manual',
      // Left unset on purpose — a spare vehicle nobody's gotten around to
      // tracking compliance dates for yet (detail page's compliance section
      // shows "no compliance date set" for both, which doesn't drag the
      // dashboard's worst-status down; see lib/queries.ts's comment on why
      // an unset date isn't a no_data ITEM).
      fahesDue: null,
      istimaraExpiry: null,
    },
  ]);

  // ---------------------------------------------------------------------
  // Van 1 — the "rich" vehicle: full schedule, reading history, past
  // services with costs (so the detail page's cost-per-km section has
  // something to compute).
  // ---------------------------------------------------------------------
  await db.insert(odometerReadings).values([
    { vehicleId: van1Id, tenantId: DEMO_TENANT_ID, readingKm: 65_000, recordedAt: timeOffset(today, 100), source: 'manual' },
    { vehicleId: van1Id, tenantId: DEMO_TENANT_ID, readingKm: 72_500, recordedAt: timeOffset(today, 45), source: 'manual' },
    { vehicleId: van1Id, tenantId: DEMO_TENANT_ID, readingKm: 78_000, recordedAt: timeOffset(today, 2), source: 'manual' },
  ]);

  const van1OilChangeId = randomUUID();
  const van1TyreId = randomUUID();
  await db.insert(scheduleItems).values([
    {
      id: van1OilChangeId,
      vehicleId: van1Id,
      tenantId: DEMO_TENANT_ID,
      name: 'Oil & filter change',
      intervalKm: 10_000,
      intervalMonths: 6,
      // Current reading is 78,000km — a 75,000km threshold is already
      // 3,000km behind, and the date threshold is also in the past, so this
      // reads as overdue on BOTH dimensions (lib/status.ts's worstOf).
      nextDueKm: 75_000,
      nextDueDate: dateOffset(today, -20),
      brandRecommendations: ['Castrol', 'Mobil 1'],
      source: 'ai',
    },
    {
      id: randomUUID(),
      vehicleId: van1Id,
      tenantId: DEMO_TENANT_ID,
      name: 'Air & cabin filters',
      intervalKm: 15_000,
      intervalMonths: 12,
      nextDueKm: 85_000,
      nextDueDate: dateOffset(today, 200),
      brandRecommendations: ['Denso'],
      source: 'ai',
    },
    {
      id: randomUUID(),
      vehicleId: van1Id,
      tenantId: DEMO_TENANT_ID,
      name: 'Brake pads',
      intervalKm: 40_000,
      intervalMonths: null,
      nextDueKm: 100_000,
      nextDueDate: null,
      brandRecommendations: ['Bosch'],
      source: 'ai',
    },
    {
      id: van1TyreId,
      vehicleId: van1Id,
      tenantId: DEMO_TENANT_ID,
      name: 'Tyre rotation',
      intervalKm: 10_000,
      intervalMonths: null,
      nextDueKm: 88_000,
      nextDueDate: null,
      brandRecommendations: [],
      source: 'ai',
    },
    {
      id: randomUUID(),
      vehicleId: van1Id,
      tenantId: DEMO_TENANT_ID,
      name: 'Battery replacement',
      intervalKm: null,
      intervalMonths: 24,
      nextDueKm: null,
      nextDueDate: dateOffset(today, 300),
      brandRecommendations: ['AC Delco'],
      source: 'ai',
    },
    {
      id: randomUUID(),
      vehicleId: van1Id,
      tenantId: DEMO_TENANT_ID,
      name: 'Coolant flush',
      intervalKm: 40_000,
      intervalMonths: 24,
      nextDueKm: 100_000,
      nextDueDate: dateOffset(today, 500),
      brandRecommendations: [],
      source: 'ai',
    },
  ]);

  await db.insert(serviceEvents).values([
    {
      vehicleId: van1Id,
      tenantId: DEMO_TENANT_ID,
      scheduleItemId: van1OilChangeId,
      title: 'Oil & filter change',
      odometerKm: 65_000,
      performedOn: dateOffset(today, -100),
      costQar: '250.00',
      notes: 'Castrol 15W-40, standard filter.',
    },
    {
      vehicleId: van1Id,
      tenantId: DEMO_TENANT_ID,
      scheduleItemId: van1TyreId,
      title: 'Tyre rotation',
      odometerKm: 72_500,
      performedOn: dateOffset(today, -45),
      costQar: '120.00',
      notes: null,
    },
    {
      vehicleId: van1Id,
      tenantId: DEMO_TENANT_ID,
      scheduleItemId: null,
      title: 'Windscreen chip repair',
      odometerKm: 78_000,
      performedOn: dateOffset(today, -2),
      costQar: '90.00',
      notes: 'Resin repair, passenger side.',
    },
  ]);

  // ---------------------------------------------------------------------
  // Van 2 — one item due-soon by km, everything else ok.
  // ---------------------------------------------------------------------
  await db.insert(odometerReadings).values([
    { vehicleId: van2Id, tenantId: DEMO_TENANT_ID, readingKm: 132_000, recordedAt: timeOffset(today, 60), source: 'manual' },
    { vehicleId: van2Id, tenantId: DEMO_TENANT_ID, readingKm: 140_000, recordedAt: timeOffset(today, 5), source: 'manual' },
  ]);

  await db.insert(scheduleItems).values([
    {
      id: randomUUID(),
      vehicleId: van2Id,
      tenantId: DEMO_TENANT_ID,
      name: 'Oil & filter change',
      intervalKm: 10_000,
      intervalMonths: 6,
      // 800km away from the current 140,000km reading — inside
      // DUE_SOON_KM's 1,000km window, so this is due_soon, not overdue.
      nextDueKm: 140_800,
      nextDueDate: dateOffset(today, 90),
      brandRecommendations: ['Shell Helix'],
      source: 'ai',
    },
    {
      id: randomUUID(),
      vehicleId: van2Id,
      tenantId: DEMO_TENANT_ID,
      name: 'Brake pads',
      intervalKm: 45_000,
      intervalMonths: null,
      nextDueKm: 160_000,
      nextDueDate: null,
      brandRecommendations: [],
      source: 'ai',
    },
  ]);

  await db.insert(serviceEvents).values([
    {
      vehicleId: van2Id,
      tenantId: DEMO_TENANT_ID,
      scheduleItemId: null,
      title: 'Alternator replacement',
      odometerKm: 132_000,
      performedOn: dateOffset(today, -60),
      costQar: '680.00',
      notes: null,
    },
  ]);

  // ---------------------------------------------------------------------
  // Van 3 — everything ok/green.
  // ---------------------------------------------------------------------
  await db.insert(odometerReadings).values([
    { vehicleId: van3Id, tenantId: DEMO_TENANT_ID, readingKm: 45_000, recordedAt: timeOffset(today, 10), source: 'manual' },
  ]);

  await db.insert(scheduleItems).values([
    {
      id: randomUUID(),
      vehicleId: van3Id,
      tenantId: DEMO_TENANT_ID,
      name: 'Oil & filter change',
      intervalKm: 10_000,
      intervalMonths: 6,
      nextDueKm: 55_000,
      nextDueDate: dateOffset(today, 150),
      brandRecommendations: ['Mobil 1'],
      source: 'ai',
    },
    {
      id: randomUUID(),
      vehicleId: van3Id,
      tenantId: DEMO_TENANT_ID,
      name: 'Tyre rotation',
      intervalKm: 10_000,
      intervalMonths: null,
      nextDueKm: 55_000,
      nextDueDate: null,
      brandRecommendations: [],
      source: 'ai',
    },
  ]);

  // ---------------------------------------------------------------------
  // Van 4 — manual add, no odometer reading and no schedule yet: exercises
  // the vehicle detail page's empty "generate schedule" state.
  // ---------------------------------------------------------------------
  // Intentionally no odometerReadings/scheduleItems rows for van4Id.
}
