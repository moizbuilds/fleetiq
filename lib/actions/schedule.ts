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
import { and, eq } from 'drizzle-orm';
import { requireTenant } from '@/lib/auth';
import { getDb } from '@/lib/db';
import { vehicles, scheduleItems } from '@/lib/db/schema';
import { aiScheduleSchema, updateScheduleItemInputSchema, type AiScheduleItem } from '@/lib/types';
import { addMonthsUtc } from '@/lib/status';
import { updateScheduleItemCore, ScheduleItemValidationError } from './schedule-core';
import { getLatestReading } from './odometer-core';

export interface AcceptScheduleState {
  error?: string;
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

  const today = new Date();

  // A single multi-row insert inside `db.transaction()` — Task 6 migrated
  // lib/db/index.ts from the neon-http driver (whose only atomicity
  // primitive was `db.batch()`, one HTTP round trip per call) to
  // neon-serverless's Pool/WebSocket driver, which supports real
  // BEGIN/COMMIT transactions. One `.values([...])` insert of every row is
  // already atomic on its own (a single INSERT statement either fully
  // succeeds or fully fails), so the transaction wrapper here exists mainly
  // to keep "how does this app write multiple rows atomically" answered the
  // same way everywhere (see lib/actions/services.ts's completeService for
  // a case that genuinely needs multiple statements in one transaction).
  await db.transaction(async (tx) => {
    // The vehicle's most recent odometer reading (there may be none yet,
    // e.g. a vehicle added with no initial reading) — every km-based
    // threshold below is seeded from this single reading, never re-derived
    // per item. Reuses odometer-core.ts's getLatestReading (final review,
    // item 2) instead of a second copy of this query: that helper already
    // tiebreaks by `readingKm DESC` when two readings share a
    // `recordedAt` instant, which this query used to omit — the one
    // `orderBy(desc(recordedAt))` this file had was the ONE write path
    // among the three (logOdometerCore, completeServiceCore, this one)
    // that could disagree with the other two about which reading counts as
    // "latest".
    const latestReading = await getLatestReading(tx, vehicleId);
    const currentKm = latestReading?.readingKm ?? null;

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

    await tx.insert(scheduleItems).values(rows);
  });

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

// ---------------------------------------------------------------------------
// Interval edit (fix round 1, item 4 — deferred from Task 8) — components/
// ScheduleItemRow.tsx's inline "Edit" toggle on the vehicle detail page's
// schedule table. Unlike acceptSchedule above, this never navigates: the
// row stays in place and re-renders with the new interval/threshold/source,
// same "stays in place, revalidatePath only" shape as
// lib/actions/vehicles.ts's updateComplianceDates.
// ---------------------------------------------------------------------------
export interface UpdateScheduleItemState {
  error?: string;
}

export async function updateScheduleItem(rawInput: {
  scheduleItemId: string;
  intervalKm: number | null;
  intervalMonths: number | null;
}): Promise<UpdateScheduleItemState> {
  // Reachable directly (Server Actions compile to a real POST endpoint), so
  // it re-validates its own input exactly like a public API route would
  // (globals.md) before ever touching the database.
  const parsed = updateScheduleItemInputSchema.safeParse(rawInput);
  if (!parsed.success) {
    return { error: parsed.error.issues[0]?.message ?? 'Some fields need fixing.' };
  }

  const { tenantId } = await requireTenant();
  const db = getDb();

  let vehicleId: string;
  try {
    vehicleId = await db.transaction((tx) => updateScheduleItemCore(tx, tenantId, parsed.data, new Date()));
  } catch (err) {
    // ScheduleItemValidationError is the one EXPECTED failure mode here (a
    // stale/foreign scheduleItemId) — safe to show the user as a friendly
    // `{ error }` response. Anything else (a real DB/network failure)
    // rethrows instead of being fabricated into a fake success or a
    // misleadingly-generic message (globals.md: never fabricate a result).
    if (err instanceof ScheduleItemValidationError) {
      return { error: err.message };
    }
    throw err;
  }

  revalidatePath(`/vehicles/${vehicleId}`);
  return {};
}
