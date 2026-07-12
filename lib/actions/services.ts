/**
 * Server actions for completing a maintenance service and uploading its
 * invoice photo (Task 6) — used by components/ServiceForm.tsx (a scheduled
 * item's "Mark done" flow, or an unscheduled repair). The actual write
 * logic (service_events + odometer_readings + schedule rollforward, all in
 * one transaction) lives in lib/actions/services-core.ts — see that file's
 * header for why it had to be split out of this one: a 'use server' file
 * may only export async functions reachable as Server Actions, and
 * completeServiceCore's raw `tx` argument was never meant to be a public
 * endpoint.
 */
'use server';

import { randomUUID } from 'node:crypto';
import { revalidatePath } from 'next/cache';
import { redirect } from 'next/navigation';
import { put } from '@vercel/blob';
import { requireTenant } from '@/lib/auth';
import { getDb } from '@/lib/db';
import { completeServiceInputSchema } from '@/lib/types';
import { MAX_PHOTO_BYTES, isAllowedPhotoType } from '@/lib/photo';
import { OdometerValidationError } from './odometer-core';
import { completeServiceCore } from './services-core';

export interface CompleteServiceState {
  error?: string;
}

export interface UploadInvoicePhotoState {
  url?: string;
  error?: string;
}

// A separate server action (not part of completeService) because
// completeServiceInputSchema's `invoicePhotoUrl` is already a plain URL
// STRING, not a File — see lib/types.ts's header on why this file's shared
// contract expects an already-uploaded URL. WHY the upload has to happen as
// its own round trip instead of bundling the File into completeService's
// FormData the way lib/actions/vehicles.ts's createVehicle does: this
// file's `completeService` takes a single typed object (task-6-brief.md's
// resolutions), not FormData, so components/ServiceForm.tsx uploads the
// photo the moment it's chosen (getting a URL back immediately) rather than
// at final submit time — mirroring createVehicle's own validation rules
// (lib/photo.ts's shared size/type constants) so the two upload paths in
// this app can never drift on what counts as an acceptable photo.
export async function uploadInvoicePhoto(formData: FormData): Promise<UploadInvoicePhotoState> {
  const { tenantId } = await requireTenant();

  const photo = formData.get('photo');
  if (!(photo instanceof File) || photo.size === 0) {
    return { error: 'No photo selected.' };
  }
  if (!isAllowedPhotoType(photo.type)) {
    return { error: 'Photo must be a JPEG, PNG, or WEBP image.' };
  }
  if (photo.size > MAX_PHOTO_BYTES) {
    return { error: 'Photo must be 5MB or smaller.' };
  }

  const blob = await put(`invoices/${tenantId}/${randomUUID()}-${photo.name}`, photo, {
    access: 'public',
  });
  return { url: blob.url };
}

// The real server action — reachable directly (Server Actions compile to a
// real POST endpoint), so it validates its own input exactly like a public
// API route would (globals.md) before ever touching the database.
export async function completeService(rawInput: {
  vehicleId: string;
  scheduleItemId: string | null;
  title: string | null;
  odometerKm: number;
  performedOn: string;
  costQar: number | null;
  notes: string | null;
  invoicePhotoUrl: string | null;
}): Promise<CompleteServiceState> {
  const parsed = completeServiceInputSchema.safeParse(rawInput);
  if (!parsed.success) {
    return { error: parsed.error.issues[0]?.message ?? 'Some fields need fixing.' };
  }

  const { tenantId } = await requireTenant();
  const db = getDb();

  try {
    await db.transaction((tx) => completeServiceCore(tx, tenantId, parsed.data, new Date()));
  } catch (err) {
    if (err instanceof OdometerValidationError) {
      return { error: err.message };
    }
    throw err;
  }

  // WHY revalidatePath is still needed even though redirect() below
  // navigates straight to this same path: the vehicle page may already be
  // sitting in the Router Cache from BEFORE this action ran (the user was
  // just looking at its now-stale schedule table) — same reasoning as
  // lib/actions/schedule.ts's acceptSchedule.
  revalidatePath(`/vehicles/${parsed.data.vehicleId}`);
  redirect(`/vehicles/${parsed.data.vehicleId}`);
}
