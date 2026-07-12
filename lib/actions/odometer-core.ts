/**
 * Odometer business logic shared by lib/actions/odometer.ts's `logOdometer`
 * server action, lib/actions/services.ts's `completeService` (via the
 * shared latest-reading/below-latest helpers), and tests/rollforward.test.ts
 * (which calls `logOdometerCore` directly against a PGlite transaction).
 *
 * WHY this is its OWN file, separate from odometer.ts, instead of just
 * living there: odometer.ts starts with `'use server'`, which Next.js
 * treats as "every top-level export in this file is a Server Action" — and
 * Server Actions have a hard constraint that every export must be an async
 * function (nothing else is allowed to cross that client/server boundary).
 * `OdometerValidationError` (a class) and `belowLatestMessage` (a plain
 * sync function) broke that rule outright — `next build` failed with "the
 * module has no exports at all" the moment either was exported from a
 * 'use server' file. Splitting the plain helpers/class out here, into a
 * module with no directive at all, is what lets odometer.ts keep exporting
 * ONLY `logOdometer` (a real, intentional Server Action) while this file's
 * exports stay ordinary server-only TypeScript, importable by both
 * odometer.ts and lib/actions/services.ts without either accidentally
 * turning them into public network endpoints.
 */
import { and, desc, eq } from 'drizzle-orm';
import type { AppTx } from '@/lib/db';
import { vehicles, odometerReadings } from '@/lib/db/schema';
import type { LogOdometerInput } from '@/lib/types';
import { formatKm, formatShortDate } from '@/lib/status';

// Thrown inside a transaction — by this file's logOdometerCore AND, via
// lib/actions/services.ts's completeServiceCore — for any business-rule
// failure that needs a DB read to detect (never for a plain shape/bounds
// problem, which the Zod schemas in lib/types.ts already reject before a
// transaction even opens).
//
// WHY a custom class instead of a plain `throw new Error(message)`: the
// server-action wrappers in odometer.ts/services.ts need to tell "an
// expected, friendly validation message, safe to show the user" apart from
// a genuine DB/network failure that should surface as a real error instead
// of a fabricated `{ error }` response (globals.md: never fabricate a
// result). `instanceof` does that without parsing message text.
export class OdometerValidationError extends Error {}

// Shared wording for "the reading just entered is lower than the vehicle's
// last recorded reading" (task-6-brief.md's exact message shape). One
// function instead of the string duplicated in odometer.ts and services.ts
// means the numbers/wording can only ever be wrong in one place, never
// drift apart between the two callers.
export function belowLatestMessage(
  readingKm: number,
  latest: { readingKm: number; recordedAt: Date },
): string {
  return `${formatKm(readingKm)} is below the last reading (${formatKm(latest.readingKm)} on ${formatShortDate(latest.recordedAt)}). Typo? If the odometer was replaced, use the correction option.`;
}

// The vehicle's most recent odometer reading — tiebroken by readingKm
// (descending) when two rows share the same recordedAt instant, so "the
// latest reading" is unambiguous even for readings logged in the same
// millisecond. Shared by logOdometerCore and completeServiceCore.
export async function getLatestReading(
  tx: AppTx,
  vehicleId: string,
): Promise<{ readingKm: number; recordedAt: Date } | undefined> {
  const [latest] = await tx
    .select({ readingKm: odometerReadings.readingKm, recordedAt: odometerReadings.recordedAt })
    .from(odometerReadings)
    .where(eq(odometerReadings.vehicleId, vehicleId))
    .orderBy(desc(odometerReadings.recordedAt), desc(odometerReadings.readingKm))
    .limit(1);
  return latest;
}

// Tenant-scoped ownership check, shared by both core functions — scoping by
// BOTH id and tenantId means a vehicle belonging to a different tenant is
// indistinguishable from one that doesn't exist at all (globals.md's
// tenant-isolation rule: missing rows → 404, not 500 or a cross-tenant
// leak), the same pattern every other tenant-scoped query in this app uses.
export async function assertVehicleOwnership(
  tx: AppTx,
  tenantId: string,
  vehicleId: string,
): Promise<void> {
  const [vehicle] = await tx
    .select({ id: vehicles.id })
    .from(vehicles)
    .where(and(eq(vehicles.id, vehicleId), eq(vehicles.tenantId, tenantId)))
    .limit(1);
  if (!vehicle) {
    throw new OdometerValidationError('Vehicle not found.');
  }
}

// The testable core (dependency injection — same reasoning as lib/rate-
// limit.ts's checkRateLimit taking `db` as a parameter): everything
// logOdometer does that touches the database, factored out so
// tests/rollforward.test.ts can run it directly against a PGlite
// transaction with no Clerk session. `input` here is ALREADY validated
// (shape/bounds) by logOdometerInputSchema — this function only enforces
// the rules that need a DB read to check at all.
export async function logOdometerCore(
  tx: AppTx,
  tenantId: string,
  input: LogOdometerInput,
): Promise<void> {
  await assertVehicleOwnership(tx, tenantId, input.vehicleId);

  if (input.isCorrection && (input.note === null || input.note.length === 0)) {
    throw new OdometerValidationError(
      'A correction needs a note explaining why (e.g. odometer replaced).',
    );
  }

  const latest = await getLatestReading(tx, input.vehicleId);
  if (latest && input.readingKm < latest.readingKm && !input.isCorrection) {
    throw new OdometerValidationError(belowLatestMessage(input.readingKm, latest));
  }

  await tx.insert(odometerReadings).values({
    vehicleId: input.vehicleId,
    tenantId,
    readingKm: input.readingKm,
    source: 'manual',
    isCorrection: input.isCorrection,
    note: input.note,
  });
}
