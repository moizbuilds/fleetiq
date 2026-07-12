/**
 * Server action for accepting an AI-generated maintenance schedule
 * (components/ScheduleReview.tsx's "Accept schedule" button).
 *
 * What this does: takes the (possibly user-edited) list of schedule items
 * the browser reviewed, re-validates every one of them server-side, works
 * out each item's first due threshold from the vehicle's latest odometer
 * reading and today's date, and writes all the rows in one atomic batch.
 *
 * WHY re-validate here instead of trusting what app/api/ai/schedule/
 * route.ts already generated: by the time this runs, the items have passed
 * through a client-editable table (components/ScheduleReview.tsx) — a user
 * can retype the name, blank out an interval, or delete every brand. This
 * server action is reachable directly (Next.js compiles it to a real POST
 * endpoint) by anyone who can call it, so it has to enforce the same rules
 * a fresh AI response would have satisfied, exactly like
 * lib/actions/vehicles.ts's createVehicle re-validates form input.
 */
'use server';

import { redirect } from 'next/navigation';
import { revalidatePath } from 'next/cache';
import { and, desc, eq } from 'drizzle-orm';
import { requireTenant } from '@/lib/auth';
import { getDb } from '@/lib/db';
import { vehicles, scheduleItems, odometerReadings } from '@/lib/db/schema';
import { aiScheduleSchema, type AiScheduleItem } from '@/lib/types';

export interface AcceptScheduleState {
  error?: string;
}

// Turns `today` + a months interval into a stored `nextDueDate` string
// (`YYYY-MM-DD`, matching the `date` column — see lib/status.ts's date-math
// comment for why dates round-trip as plain strings, never Date objects,
// once stored).
//
// CONCEPT: `Date.UTC(year, month, day)` — passing a month value equal to or
// beyond 11 (December) doesn't throw; JS's Date rolls the extra months
// forward into later years/months for you (Date.UTC(2026, 13, 1) is the
// same instant as Date.UTC(2027, 1, 1)). That's exactly what "add N months"
// needs, but it comes with one accepted quirk worth naming: if `today` is,
// say, Jan 31 and 1 month is added, there is no Feb 31 — JS rolls that
// overflow into early March (Mar 2 or Mar 3) rather than clamping to Feb's
// last day. FleetIQ accepts this (rare, and never wrong in a way that makes
// an item due EARLIER than it should be) rather than adding clamping logic
// for an edge case with no real safety consequence.
function addMonthsUtc(today: Date, months: number): string {
  const d = new Date(Date.UTC(today.getUTCFullYear(), today.getUTCMonth() + months, today.getUTCDate()));
  return d.toISOString().slice(0, 10);
}

export async function acceptSchedule(
  vehicleId: string,
  items: AiScheduleItem[],
): Promise<AcceptScheduleState> {
  const { tenantId } = await requireTenant();
  const db = getDb();

  // Ownership check — scoping by BOTH id and tenantId means a vehicle
  // belonging to a different tenant reads as "not found", never leaking
  // that the id exists at all (globals.md's tenant-isolation rule).
  const [vehicle] = await db
    .select()
    .from(vehicles)
    .where(and(eq(vehicles.id, vehicleId), eq(vehicles.tenantId, tenantId)))
    .limit(1);

  if (!vehicle) {
    return { error: 'Vehicle not found.' };
  }

  // Re-validate the item list against the exact same shape the AI response
  // itself has to satisfy (lib/types.ts's aiScheduleSchema) — reusing
  // `.shape.items` instead of redeclaring the item rules here is what keeps
  // "what counts as a valid schedule item" defined in exactly one place.
  const parsedItems = aiScheduleSchema.shape.items.safeParse(items);
  if (!parsedItems.success) {
    return { error: 'One or more schedule items are invalid — check that every item has a name and at least one interval.' };
  }

  if (parsedItems.data.length === 0) {
    return { error: 'Add at least one schedule item before accepting.' };
  }

  // WHY there's no separate name-length loop here anymore (review round 1,
  // finding #2): `aiScheduleItemSchema.name` now enforces `.trim().min(1).max(60)`
  // directly, so the `.safeParse()` call above already rejects a blank or
  // over-long name — re-checking it here would just be the same rule
  // written a second time, exactly the "one source of truth" drift
  // globals.md warns about. `parsedItems.data[i].name` below is already
  // trimmed by the schema's own `.trim()` transform.

  // The vehicle's most recent odometer reading (there may be none yet, e.g.
  // a vehicle added with no initial reading) — every km-based threshold
  // below is seeded from this single reading, never re-derived per item.
  const [latestReading] = await db
    .select({ readingKm: odometerReadings.readingKm })
    .from(odometerReadings)
    .where(eq(odometerReadings.vehicleId, vehicleId))
    .orderBy(desc(odometerReadings.recordedAt))
    .limit(1);
  const currentKm = latestReading?.readingKm ?? null;

  const today = new Date();
  const rows = parsedItems.data.map((item) => ({
    vehicleId,
    tenantId,
    // Already trimmed by aiScheduleItemSchema's `.trim()` transform above —
    // not re-trimmed here, so there's exactly one place that decides what
    // counts as this row's name.
    name: item.name,
    intervalKm: item.intervalKm,
    intervalMonths: item.intervalMonths,
    // THRESHOLDS, not countdowns (globals.md) — computed once here, at
    // acceptance time, and never recomputed until the item is actually
    // serviced (a later task's concern).
    //
    // Bounded, not overflow-prone: intervalKm is capped at 100,000 by
    // aiScheduleItemSchema and currentKm is capped at 2,000,000 by
    // createVehicleInputSchema's initialOdometerKm bound (odometer readings
    // only ever grow from that seed) — so this sum tops out around 2.1M,
    // nowhere near a number precision or `integer` column concern.
    nextDueKm: item.intervalKm !== null && currentKm !== null ? currentKm + item.intervalKm : null,
    nextDueDate: item.intervalMonths !== null ? addMonthsUtc(today, item.intervalMonths) : null,
    brandRecommendations: item.brandRecommendations,
    source: 'ai' as const,
  }));

  // WHY db.batch() instead of one multi-row `.values([...])` insert: this
  // app's Neon HTTP driver has no `.transaction()` support (see
  // lib/actions/vehicles.ts's comment) — `db.batch()` is its actual
  // atomicity primitive, sending every statement in one HTTP round trip
  // that Neon executes as a single all-or-nothing unit. Matching that same
  // primitive here (rather than introducing a second insert style just
  // because every row happens to target one table) keeps "how does this
  // app write multiple rows atomically" answered exactly one way.
  //
  // The `[first, ...rest]` destructure (rather than passing the mapped
  // array directly) satisfies db.batch()'s type — it requires a
  // known-non-empty tuple, which the `rows.length === 0` check above has
  // already ruled out by this point.
  const insertStatements = rows.map((row) => db.insert(scheduleItems).values(row));
  const [first, ...rest] = insertStatements;
  await db.batch([first, ...rest]);

  // WHY revalidatePath is still needed even though redirect() below
  // navigates straight to this same path: the vehicle page may already be
  // sitting in the Router Cache from BEFORE this action ran (the user was
  // just looking at its empty-schedule state) — without this, a redirect
  // alone could serve that stale cached render instead of the one showing
  // the schedule items just written.
  revalidatePath(`/vehicles/${vehicleId}`);

  // redirect() throws internally (Next.js control-flow) — same pattern as
  // lib/actions/vehicles.ts's createVehicle. Works identically whether
  // this action is bound to a <form action> or called directly from a
  // Client Component's event handler (components/ScheduleReview.tsx), as
  // long as the caller doesn't wrap the call in a try/catch that would
  // swallow the thrown redirect signal.
  redirect(`/vehicles/${vehicleId}`);
}
