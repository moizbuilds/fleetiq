/**
 * Service-completion business logic — split out of lib/actions/services.ts
 * for the exact same reason lib/actions/odometer-core.ts was split out of
 * odometer.ts: services.ts starts with `'use server'`, and Next.js requires
 * every top-level export of such a file to be an async function reachable
 * as a Server Action. `completeServiceCore` takes a raw `tx` (a database
 * transaction handle, not something a browser could ever serialize across
 * the network) as its first argument, so it was never meant to be a public
 * endpoint in the first place — living here, in a file with no directive,
 * keeps it an ordinary server-only helper that services.ts (the real
 * `completeService` action) and tests/rollforward.test.ts can both import.
 */
import { and, eq } from 'drizzle-orm';
import type { AppTx } from '@/lib/db';
import { scheduleItems, serviceEvents, odometerReadings } from '@/lib/db/schema';
import type { CompleteServiceInput } from '@/lib/types';
import { addMonthsUtc } from '@/lib/status';
import {
  assertVehicleOwnership,
  belowLatestMessage,
  getLatestReading,
  OdometerValidationError,
} from './odometer-core';

// Runs entirely inside the caller's db.transaction() (see lib/actions/
// services.ts's completeService). WHY a transaction: a crash between
// writing the service_events row and rolling the schedule item's next-due
// thresholds forward would leave a service that WAS just completed still
// showing as due — worse than doing nothing, since it would silently hide a
// real maintenance record behind a stale "overdue" badge (task-6-brief.md).
// `today` is an injected clock (same reasoning as lib/status.ts's
// computeItemStatus) so the "performedOn can't be in the future" guard is
// testable with a fixed date instead of depending on when a test happens to
// run.
export async function completeServiceCore(
  tx: AppTx,
  tenantId: string,
  input: CompleteServiceInput,
  today: Date,
): Promise<void> {
  // Cheapest check first, no DB needed: reject an obviously-bad date before
  // spending a round trip on ownership/item lookups.
  const todayStr = today.toISOString().slice(0, 10);
  if (input.performedOn > todayStr) {
    throw new OdometerValidationError("Service date can't be in the future.");
  }

  // (1) Tenant-scoped vehicle check.
  await assertVehicleOwnership(tx, tenantId, input.vehicleId);

  // (2) If scheduleItemId: fetch the item, scoped by vehicleId AND
  // tenantId — an item id that belongs to a different vehicle (even one
  // owned by the same tenant) or a different tenant entirely reads as "not
  // found", never a silent cross-vehicle write.
  let item:
    | { id: string; name: string; intervalKm: number | null; intervalMonths: number | null }
    | undefined;
  if (input.scheduleItemId !== null) {
    [item] = await tx
      .select({
        id: scheduleItems.id,
        name: scheduleItems.name,
        intervalKm: scheduleItems.intervalKm,
        intervalMonths: scheduleItems.intervalMonths,
      })
      .from(scheduleItems)
      .where(
        and(
          eq(scheduleItems.id, input.scheduleItemId),
          eq(scheduleItems.vehicleId, input.vehicleId),
          eq(scheduleItems.tenantId, tenantId),
        ),
      )
      .limit(1);
    if (!item) {
      throw new OdometerValidationError('Schedule item not found.');
    }
  }

  // Scheduled items default their title to the item's own name when the
  // user left the field blank. WHY the `item!` assertion is safe here even
  // though TypeScript can't see it: completeServiceInputSchema's .refine()
  // already guarantees `input.title !== null` whenever `scheduleItemId` is
  // null — so `item!.name` is only ever REACHED (the `??` short-circuits
  // before evaluating it) in the branch where scheduleItemId was non-null,
  // which is exactly the branch that populated `item` above (or threw).
  const title = input.title ?? item!.name;

  // (3) Insert serviceEvent — createdAt is server-stamped by the column's
  // defaultNow() (globals.md: server-stamp created_at/recorded_at).
  await tx.insert(serviceEvents).values({
    vehicleId: input.vehicleId,
    tenantId,
    scheduleItemId: input.scheduleItemId,
    title,
    odometerKm: input.odometerKm,
    performedOn: input.performedOn,
    // Money is `numeric` in Postgres, read/written as a string (globals.md)
    // — the column's TS insert type is `string`, not `number`.
    costQar: input.costQar !== null ? input.costQar.toString() : null,
    notes: input.notes,
    invoicePhotoUrl: input.invoicePhotoUrl,
  });

  // (4) Insert odometerReading, source 'service' — the SAME below-latest
  // guard as logOdometer (shared message/helper: one source of truth for
  // the wording), but with NO correction override: a service log is never
  // the place to "fix" a bad prior reading, only logOdometer's explicit
  // correction flow is. EXCEPTION: if the entered km exactly equals the
  // latest reading, skip inserting a duplicate row — the service was
  // logged at an already-known odometer value, so a second identical
  // reading would just be noise in the vehicle's reading history.
  const latest = await getLatestReading(tx, input.vehicleId);
  if (latest && input.odometerKm < latest.readingKm) {
    throw new OdometerValidationError(belowLatestMessage(input.odometerKm, latest));
  }
  const isDuplicateOfLatest = latest !== undefined && input.odometerKm === latest.readingKm;
  if (!isDuplicateOfLatest) {
    await tx.insert(odometerReadings).values({
      vehicleId: input.vehicleId,
      tenantId,
      readingKm: input.odometerKm,
      source: 'service',
      isCorrection: false,
      note: null,
    });
  }

  // (5) Rollforward — THRESHOLDS, never countdowns (globals.md): the
  // item's next-due km/date are recomputed from THIS service's own
  // odometer/date, not from "today". Null-safe: an item due only by
  // calendar time (no intervalKm) keeps nextDueKm null forever, and vice
  // versa. An unscheduled repair (item undefined) rolls nothing.
  if (item) {
    const performedOnDate = new Date(`${input.performedOn}T00:00:00.000Z`);
    await tx
      .update(scheduleItems)
      .set({
        nextDueKm: item.intervalKm !== null ? input.odometerKm + item.intervalKm : null,
        nextDueDate:
          item.intervalMonths !== null ? addMonthsUtc(performedOnDate, item.intervalMonths) : null,
        updatedAt: new Date(),
      })
      .where(eq(scheduleItems.id, item.id));
  }
}
