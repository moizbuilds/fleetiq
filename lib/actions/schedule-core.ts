/**
 * Schedule-item interval-edit business logic (fix round 1, item 4 —
 * deferred from Task 8) — split out of lib/actions/schedule.ts for the same
 * reason lib/actions/odometer-core.ts and lib/actions/services-core.ts were
 * split out of their own 'use server' siblings: schedule.ts starts with
 * 'use server', and Next.js requires every top-level export of such a file
 * to be an async function reachable as a Server Action. `ScheduleItem
 * ValidationError` (a class) and `updateScheduleItemCore` taking a raw `tx`
 * (a transaction handle no browser could ever serialize) both break that
 * rule — living here, in a file with no directive, keeps them ordinary
 * server-only helpers importable by both schedule.ts's real
 * `updateScheduleItem` action and tests/schedule-edit.test.ts.
 *
 * WHY editing an interval recomputes its thresholds from the item's LAST
 * COMPLETION instead of from "today": a maintenance interval means "every N
 * km/months SINCE IT WAS LAST DONE" — if correcting the interval instead
 * re-anchored the threshold to today's date/current odometer, a vehicle
 * whose oil was changed 8,000km ago on a 10,000km interval would suddenly
 * read "2,000km until due" the moment someone fixed a typo'd interval to
 * 12,000km, when the real answer is "4,000km until due" (12,000 minus the
 * 8,000km already driven since the last change actually happened). Looking
 * up the item's most recent service_events row recovers that real anchor
 * point — the exact same rollforward math lib/actions/services-core.ts's
 * completeServiceCore already runs the moment a service is LOGGED, just
 * re-run here from the SAME anchor instead of a fresh one. An item with no
 * completion yet has no such anchor, so it falls back to the identical
 * seeding rule lib/actions/schedule.ts's acceptSchedule uses for a
 * brand-new item: the vehicle's current latest odometer reading (null if it
 * has none at all yet) and today's date.
 */
import { and, desc, eq } from 'drizzle-orm';
import type { AppTx } from '@/lib/db';
import { scheduleItems, serviceEvents } from '@/lib/db/schema';
import type { UpdateScheduleItemInput } from '@/lib/types';
import { addMonthsUtc } from '@/lib/status';
import { getLatestReading } from './odometer-core';

// Thrown inside a transaction for any business-rule failure that needs a DB
// read to detect (here: a scheduleItemId that doesn't exist, or belongs to
// a different tenant) — never for a plain shape/bounds problem, which
// updateScheduleItemInputSchema already rejects before a transaction even
// opens. Its own class (not a reuse of odometer-core.ts's
// OdometerValidationError) since this file has nothing to do with odometer
// readings — an `instanceof` check on the wrong class would be a false
// signal to the caller.
export class ScheduleItemValidationError extends Error {}

// Runs entirely inside the caller's db.transaction() (see lib/actions/
// schedule.ts's updateScheduleItem) — the same "read the anchor, then
// write the recomputed thresholds" sequence needs a consistent snapshot as
// completeServiceCore's rollforward, so it gets the same transactional
// treatment. `today` is an injected clock (lib/status.ts's pattern) so the
// "no completion yet" fallback is testable with a fixed date. Returns the
// item's vehicleId so the caller can revalidatePath the right vehicle page
// without a second lookup.
export async function updateScheduleItemCore(
  tx: AppTx,
  tenantId: string,
  input: UpdateScheduleItemInput,
  today: Date,
): Promise<string> {
  // Tenant-scoped fetch — scoping by BOTH id and tenantId means an item
  // belonging to a different tenant reads as "not found", never a
  // cross-tenant write (globals.md's tenant-isolation rule). scheduleItems
  // carries tenantId as its own direct, denormalized column (every domain
  // table does — globals.md), so this check is exactly as tenant-scoped as
  // fetching the item via a join through `vehicles` would be, without
  // introducing a join none of this codebase's other core functions use.
  const [item] = await tx
    .select({ id: scheduleItems.id, vehicleId: scheduleItems.vehicleId })
    .from(scheduleItems)
    .where(and(eq(scheduleItems.id, input.scheduleItemId), eq(scheduleItems.tenantId, tenantId)))
    .limit(1);
  if (!item) {
    throw new ScheduleItemValidationError('Schedule item not found.');
  }

  // The item's most recent completion, if any — same newest-first tie-break
  // as lib/queries.ts's history ordering (performedOn desc, then createdAt
  // desc for two services logged on the same calendar date).
  const [lastCompletion] = await tx
    .select({ odometerKm: serviceEvents.odometerKm, performedOn: serviceEvents.performedOn })
    .from(serviceEvents)
    .where(and(eq(serviceEvents.scheduleItemId, input.scheduleItemId), eq(serviceEvents.tenantId, tenantId)))
    .orderBy(desc(serviceEvents.performedOn), desc(serviceEvents.createdAt))
    .limit(1);

  let baseKm: number | null;
  let baseDate: Date;
  if (lastCompletion) {
    baseKm = lastCompletion.odometerKm;
    baseDate = new Date(`${lastCompletion.performedOn}T00:00:00.000Z`);
  } else {
    // No completion yet — the exact same seeding rule lib/actions/
    // schedule.ts's acceptSchedule uses for a brand-new item.
    const latestReading = await getLatestReading(tx, item.vehicleId);
    baseKm = latestReading?.readingKm ?? null;
    baseDate = today;
  }

  await tx
    .update(scheduleItems)
    .set({
      intervalKm: input.intervalKm,
      intervalMonths: input.intervalMonths,
      // THRESHOLDS, not countdowns (globals.md) — recomputed once here from
      // the anchor decided above, null-safe both ways (a months-only item
      // never gets a km threshold and vice versa, same as acceptSchedule and
      // completeServiceCore's rollforward).
      nextDueKm: input.intervalKm !== null && baseKm !== null ? baseKm + input.intervalKm : null,
      nextDueDate: input.intervalMonths !== null ? addMonthsUtc(baseDate, input.intervalMonths) : null,
      // Editing an interval by hand is what flips a schedule item's origin
      // from 'ai' to 'user' — components/ScheduleItemRow.tsx's source badge
      // and tooltip read this column, not a separate flag, so there's one
      // source of truth for "has a human touched this item's numbers".
      source: 'user',
      updatedAt: new Date(),
    })
    .where(eq(scheduleItems.id, item.id));

  return item.vehicleId;
}
