/**
 * Server action for logging an odometer reading (Task 6) — the one place a
 * vehicle's mileage gets recorded manually, from app/odometer/page.tsx's
 * form. The actual business logic (the below-latest guard, the ownership
 * check, the DB writes) lives in lib/actions/odometer-core.ts — see that
 * file's header for why it had to be split out of this one: a 'use server'
 * file may only export async functions, and this file's job is narrowed to
 * exactly that one export.
 *
 * WHY the below-latest guard is a THROWN error inside a db.transaction(),
 * not a returned `{ error }`: logOdometerCore reads the latest reading and
 * decides whether to insert the new one inside ONE transaction (CONCEPT: a
 * transaction groups multiple statements so they all succeed or all fail
 * together — and just as important here, the read and the write see one
 * consistent snapshot of the table, so a second reading logged in the same
 * instant by another request can't slip in between this read and this
 * write). Throwing is what tells drizzle's transaction wrapper to roll
 * back; a plain returned value would commit whatever was written before the
 * failure was noticed — see lib/db/index.ts's header for why this app can
 * run a real transaction at all now.
 */
'use server';

import { revalidatePath } from 'next/cache';
import { getDb } from '@/lib/db';
import { requireTenant } from '@/lib/auth';
import { logOdometerInputSchema } from '@/lib/types';
import { logOdometerCore, OdometerValidationError } from './odometer-core';

export interface LogOdometerState {
  error?: string;
}

// The real server action. Reachable directly (Next.js compiles a Server
// Action to a real POST endpoint, not just a UI-triggered call), so it
// re-validates its own input exactly like a public API route would
// (globals.md) before ever touching the database.
export async function logOdometer(rawInput: {
  vehicleId: string;
  readingKm: number;
  isCorrection?: boolean;
  note?: string | null;
}): Promise<LogOdometerState> {
  const parsed = logOdometerInputSchema.safeParse({
    vehicleId: rawInput.vehicleId,
    readingKm: rawInput.readingKm,
    isCorrection: rawInput.isCorrection ?? false,
    note: rawInput.note?.trim() || null,
  });
  if (!parsed.success) {
    return { error: parsed.error.issues[0]?.message ?? 'Some fields need fixing.' };
  }

  const { tenantId } = await requireTenant();
  const db = getDb();

  try {
    await db.transaction((tx) => logOdometerCore(tx, tenantId, parsed.data));
  } catch (err) {
    if (err instanceof OdometerValidationError) {
      return { error: err.message };
    }
    throw err;
  }

  // No redirect — the odometer page shows an inline "Logged." confirmation
  // in place (task-6-brief.md), so this stays on /odometer. revalidatePath
  // busts the Router Cache so the vehicle picker's "last reading" figures
  // reflect the row just written.
  revalidatePath('/odometer');
  return {};
}
