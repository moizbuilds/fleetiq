/**
 * Read-side queries for the dashboard and vehicle detail page (Task 8) —
 * `getFleetStatus` (one row per vehicle, worst-first, for app/page.tsx) and
 * `getVehicleDetail` (everything about one vehicle, for
 * app/vehicles/[id]/page.tsx). Both turn raw rows (vehicles, schedule_items,
 * odometer_readings, service_events) into the typed DTOs defined in
 * lib/types.ts, by running lib/status.ts's compute functions over them.
 *
 * WHY `db` is a parameter instead of these functions calling getDb()
 * themselves: same dependency-injection reasoning as lib/rate-limit.ts's
 * checkRateLimit — it's what lets tests/queries.test.ts exercise real
 * Postgres DISTINCT ON / SUM / GROUP BY semantics against an in-memory
 * PGlite database, with no live Neon connection needed. WHY `today` is
 * also a parameter: lib/status.ts's injected-clock pattern, so a test can
 * pick an exact "now" and assert an exact overdue/due_soon/ok boundary
 * instead of depending on when the test happens to run.
 */
import { and, asc, desc, eq, sql } from 'drizzle-orm';
import type { NeonDatabase } from 'drizzle-orm/neon-serverless';
import type { PgliteDatabase } from 'drizzle-orm/pglite';
import * as schema from './db/schema';
import { vehicles, scheduleItems, odometerReadings, serviceEvents } from './db/schema';
import { computeItemStatus, computeComplianceStatus, intervalConsumedPct, worstFirst } from './status';
import type { ItemStatus, ScheduleItem, FleetVehicleStatus, VehicleDetail, RankedStatusItem } from './types';

// Accepts either driver's database handle — Neon's Pool/WebSocket driver in
// production (lib/db/index.ts), PGlite's in-memory one in tests. Same union
// as lib/rate-limit.ts's RateLimitDb; every query below is plain
// driver-agnostic Postgres (select/where/orderBy, plus a couple of raw
// `sql` aggregates), so nothing here depends on which one actually runs it.
export type QueryDb = NeonDatabase<typeof schema> | PgliteDatabase<typeof schema>;

// ---------------------------------------------------------------------------
// Shared ranking helper
// ---------------------------------------------------------------------------

// A schedule/compliance item, already reduced to its ItemStatus, with the
// extra `id`/`name`/`intervalConsumedPct` fields both getFleetStatus and
// getVehicleDetail need to carry alongside it.
type RankableEntry = ItemStatus & Pick<RankedStatusItem, 'id' | 'name' | 'intervalConsumedPct'>;

// Ranks a set of schedule/compliance items worst-first by reusing
// lib/status.ts's worstFirst — the ONE place "which status is more urgent"
// is decided (globals.md's one-source-of-truth rule), so this file never
// re-implements that overdue/due_soon/ok tie-break logic itself.
//
// WHY the cast: worstFirst's own type signature (`ItemStatus[] =>
// ItemStatus[]`) only describes the fields its comparator actually reads
// (`.state`/`.dueInKm`/`.dueInDays`). Array.prototype.sort reorders the
// SAME object references rather than copying them, so this file's own
// `id`/`name`/`intervalConsumedPct` fields survive the round trip even
// though worstFirst's return type can't see them — the cast just tells
// TypeScript what's already true at runtime.
function rankItems(entries: RankableEntry[]): RankableEntry[] {
  return worstFirst(entries) as RankableEntry[];
}

function toRankedStatusItem(entry: RankableEntry): RankedStatusItem {
  return {
    id: entry.id,
    name: entry.name,
    status: { state: entry.state, dueInKm: entry.dueInKm, dueInDays: entry.dueInDays, label: entry.label },
    intervalConsumedPct: entry.intervalConsumedPct,
  };
}

// A vehicle's own schedule items, worst-first, with no compliance
// pseudo-items mixed in — shared by getFleetStatus (which adds compliance
// items on top, per vehicle) and getVehicleDetail (which keeps schedule and
// compliance in two separate DTO sections).
function rankScheduleItems(items: ScheduleItem[], currentKm: number | null, today: Date): RankableEntry[] {
  return rankItems(
    items.map((item) => ({
      ...computeItemStatus(item, currentKm, today),
      id: item.id,
      name: item.name,
      intervalConsumedPct: intervalConsumedPct(item, currentKm, today),
    })),
  );
}

// ---------------------------------------------------------------------------
// Dashboard
// ---------------------------------------------------------------------------

// A vehicle with nothing tracked at all yet (no schedule items, no
// compliance dates set) — its "worst" status can't be no_data-from-a-real-
// item because there IS no item; this is what a dashboard row falls back to
// instead of crashing on an empty items[0].
const NOTHING_TRACKED: ItemStatus = { state: 'no_data', dueInKm: null, dueInDays: null, label: 'nothing tracked yet' };

export async function getFleetStatus(db: QueryDb, tenantId: string, today: Date): Promise<FleetVehicleStatus[]> {
  // ORDER BY created_at ASC, id ASC (fix round 1, ruling #2): without an
  // explicit order, Postgres is free to return these rows in whatever
  // physical order it finds convenient (which can change between reloads,
  // e.g. after a VACUUM or an index-only scan) — invisible on a fleet whose
  // vehicles all have DIFFERENT worst-first ranks, but the moment two
  // vehicles land in an exact tie (worstFirst's remainingDistance is only a
  // TIE-BREAK, not a total order — see `NOTHING_TRACKED`/no_data below for
  // the common real case), Array.prototype.sort's stability means whichever
  // order THIS select happened to return decides the final display order.
  // `created_at` (oldest first) makes that order deterministic and
  // meaningful (the vehicle added first stays first); `id` is a pure
  // tie-break for the vanishingly unlikely case of two rows sharing the
  // exact same microsecond-precision timestamp.
  const vehicleRows = await db
    .select()
    .from(vehicles)
    .where(eq(vehicles.tenantId, tenantId))
    .orderBy(asc(vehicles.createdAt), asc(vehicles.id));
  if (vehicleRows.length === 0) return [];

  // CONCEPT: DISTINCT ON (vehicle_id) keeps only the FIRST row Postgres
  // sees per distinct vehicle_id after applying ORDER BY — paired with
  // "ORDER BY vehicle_id, recorded_at DESC, reading_km DESC", that first
  // row is each vehicle's MOST RECENT odometer reading (ties on the exact
  // same instant broken by the higher reading, the same tie-break
  // lib/actions/odometer-core.ts's getLatestReading uses for one vehicle at
  // a time). One query gets every vehicle's latest reading at once, instead
  // of N round trips (one per vehicle) that would flood the connection pool
  // as the fleet grows.
  const latestReadingRows = await db.execute<{ vehicle_id: string; reading_km: number }>(sql`
    SELECT DISTINCT ON (vehicle_id) vehicle_id, reading_km
    FROM odometer_readings
    WHERE tenant_id = ${tenantId}
    ORDER BY vehicle_id, recorded_at DESC, reading_km DESC
  `);
  const latestByVehicle = new Map(latestReadingRows.rows.map((r) => [r.vehicle_id, r.reading_km]));

  // Same deterministic-order reasoning as vehicleRows above — rankScheduleItems
  // feeds these straight into worstFirst, whose sort is stable, so an
  // unordered select here would make a tie between two schedule items'
  // ranks just as reload-dependent as the vehicle-level tie above.
  const itemRows = await db
    .select()
    .from(scheduleItems)
    .where(eq(scheduleItems.tenantId, tenantId))
    .orderBy(asc(scheduleItems.createdAt), asc(scheduleItems.id));
  const itemsByVehicle = new Map<string, ScheduleItem[]>();
  for (const item of itemRows) {
    const list = itemsByVehicle.get(item.vehicleId) ?? [];
    list.push(item);
    itemsByVehicle.set(item.vehicleId, list);
  }

  const entries: FleetVehicleStatus[] = vehicleRows.map((vehicle) => {
    const currentKm = latestByVehicle.get(vehicle.id) ?? null;
    const scheduleRanked = rankScheduleItems(itemsByVehicle.get(vehicle.id) ?? [], currentKm, today);

    // Compliance pseudo-items join the SAME worst-first ranking as schedule
    // items — an expired Istimara is exactly as urgent as an overdue oil
    // change, from the dashboard's point of view. Only included when the
    // date is actually SET: an unset compliance date isn't a "no data" item
    // dragging the vehicle's worst status down, it's simply nothing to
    // track yet (the detail page's dedicated compliance section, which
    // always shows both rows, is where "not set yet" gets surfaced).
    const complianceRanked: RankableEntry[] = [];
    if (vehicle.istimaraExpiry !== null) {
      complianceRanked.push({
        ...computeComplianceStatus(vehicle.istimaraExpiry, today),
        id: 'istimara',
        name: 'Istimara (registration)',
        intervalConsumedPct: null,
      });
    }
    if (vehicle.fahesDue !== null) {
      complianceRanked.push({
        ...computeComplianceStatus(vehicle.fahesDue, today),
        id: 'fahes',
        name: 'Fahes inspection',
        intervalConsumedPct: null,
      });
    }

    const ranked = rankItems([...scheduleRanked, ...complianceRanked]);

    return {
      id: vehicle.id,
      nickname: vehicle.nickname,
      plate: vehicle.plate,
      make: vehicle.make,
      model: vehicle.model,
      year: vehicle.year,
      latestReadingKm: currentKm,
      items: ranked.map(toRankedStatusItem),
      worst: ranked[0]
        ? { state: ranked[0].state, dueInKm: ranked[0].dueInKm, dueInDays: ranked[0].dueInDays, label: ranked[0].label }
        : NOTHING_TRACKED,
    };
  });

  // Vehicles themselves are sorted worst-first too, by whichever single
  // item is most urgent — reuses the exact same worstFirst ranking (via the
  // same flatten-then-cast trick as rankItems above) rather than
  // reimplementing the overdue/due_soon/ok comparator a second time here.
  const sortable = entries.map((entry) => ({ ...entry.worst, entry }));
  return (worstFirst(sortable) as typeof sortable).map((s) => s.entry);
}

// ---------------------------------------------------------------------------
// Vehicle detail
// ---------------------------------------------------------------------------

// Returns null (never throws) when the vehicle doesn't exist OR belongs to
// a different tenant — scoping by BOTH id and tenantId in one WHERE means
// the two cases are indistinguishable to the caller, same tenant-isolation
// rule as every other tenant-scoped query in this app (globals.md: missing
// rows → 404, not 500 or a cross-tenant leak). app/vehicles/[id]/page.tsx
// turns a null return into notFound().
export async function getVehicleDetail(
  db: QueryDb,
  tenantId: string,
  vehicleId: string,
  today: Date,
): Promise<VehicleDetail | null> {
  const [vehicle] = await db
    .select()
    .from(vehicles)
    .where(and(eq(vehicles.id, vehicleId), eq(vehicles.tenantId, tenantId)))
    .limit(1);
  if (!vehicle) return null;

  // CONCEPT: Promise.all runs every one of these independent reads
  // concurrently instead of one after another — none of them depends on
  // another's result (all are scoped by the already-known vehicleId), so
  // awaiting them in sequence would just add five round trips together for
  // no reason (same reasoning as the original app/vehicles/[id]/page.tsx's
  // Promise.all, extended to the new queries this task adds).
  const [itemRows, [latestReading], historyRows, yearRows, spanRow] = await Promise.all([
    // Same deterministic-order reasoning as getFleetStatus's itemRows above.
    db
      .select()
      .from(scheduleItems)
      .where(and(eq(scheduleItems.vehicleId, vehicleId), eq(scheduleItems.tenantId, tenantId)))
      .orderBy(asc(scheduleItems.createdAt), asc(scheduleItems.id)),
    db
      .select({ readingKm: odometerReadings.readingKm })
      .from(odometerReadings)
      .where(and(eq(odometerReadings.vehicleId, vehicleId), eq(odometerReadings.tenantId, tenantId)))
      .orderBy(desc(odometerReadings.recordedAt), desc(odometerReadings.readingKm))
      .limit(1),
    // History, newest first: performedOn (the user-entered service date)
    // leads the sort, tie-broken by createdAt (insertion order) for two
    // services logged on the same calendar date — left-joined to
    // scheduleItems so an unscheduled repair (scheduleItemId null) still
    // returns a row, just with scheduleItemName null.
    db
      .select({
        id: serviceEvents.id,
        title: serviceEvents.title,
        performedOn: serviceEvents.performedOn,
        odometerKm: serviceEvents.odometerKm,
        costQar: serviceEvents.costQar,
        notes: serviceEvents.notes,
        invoicePhotoUrl: serviceEvents.invoicePhotoUrl,
        scheduleItemName: scheduleItems.name,
      })
      .from(serviceEvents)
      .leftJoin(scheduleItems, eq(serviceEvents.scheduleItemId, scheduleItems.id))
      .where(and(eq(serviceEvents.vehicleId, vehicleId), eq(serviceEvents.tenantId, tenantId)))
      .orderBy(desc(serviceEvents.performedOn), desc(serviceEvents.createdAt)),
    // Per-year cost totals — SQL SUM/GROUP BY, computed fresh on every read
    // (never stored, globals.md). `count` doubles as this year's
    // contribution to the "derived from X services" caption below.
    db.execute<{ year: number; total: string; count: number }>(sql`
      SELECT extract(year from performed_on)::int AS year, sum(cost_qar)::numeric AS total, count(*)::int AS count
      FROM service_events
      WHERE vehicle_id = ${vehicleId} AND tenant_id = ${tenantId} AND cost_qar IS NOT NULL
      GROUP BY year
      ORDER BY year DESC
    `),
    // The vehicle's full odometer-reading span (every reading ever logged,
    // not just service ones) — costPerKm's denominator. A single aggregate
    // query always returns exactly one row, with NULLs if there are no
    // readings at all yet.
    db.execute<{ min_km: number | null; max_km: number | null; reading_count: number }>(sql`
      SELECT min(reading_km) AS min_km, max(reading_km) AS max_km, count(*)::int AS reading_count
      FROM odometer_readings
      WHERE vehicle_id = ${vehicleId} AND tenant_id = ${tenantId}
    `),
  ]);

  const currentKm = latestReading?.readingKm ?? null;
  const scheduleRanked = rankScheduleItems(itemRows, currentKm, today);

  const totalsByYear = yearRows.rows.map((r) => ({ year: r.year, totalQar: Number(r.total).toFixed(2) }));
  const totalCostAllTime = yearRows.rows.reduce((sum, r) => sum + Number(r.total), 0);
  const serviceCount = yearRows.rows.reduce((sum, r) => sum + r.count, 0);

  const span = spanRow.rows[0];
  const distanceKm = span && span.min_km !== null && span.max_km !== null ? span.max_km - span.min_km : null;
  // Null-safe per lib/types.ts's VehicleDetail.costs comment: needs at
  // least 2 readings AND a non-zero span (can't divide by zero km driven).
  const costPerKm =
    span && span.reading_count >= 2 && distanceKm !== null && distanceKm > 0
      ? totalCostAllTime / distanceKm
      : null;

  return {
    vehicle,
    latestReadingKm: currentKm,
    scheduleItems: scheduleRanked.map((r) => {
      // itemRows and scheduleRanked always have the same ids (rankItems only
      // reorders, never adds/drops entries) — the `!` is safe for that
      // reason, not an unchecked assumption about unrelated data.
      const item = itemRows.find((i) => i.id === r.id)!;
      return {
        item,
        status: { state: r.state, dueInKm: r.dueInKm, dueInDays: r.dueInDays, label: r.label },
        intervalConsumedPct: r.intervalConsumedPct,
      };
    }),
    compliance: {
      istimara: computeComplianceStatus(vehicle.istimaraExpiry, today),
      fahes: computeComplianceStatus(vehicle.fahesDue, today),
    },
    history: historyRows,
    costs: { totalsByYear, costPerKm, serviceCount, distanceKm },
  };
}
