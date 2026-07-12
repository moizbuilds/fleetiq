/**
 * Server actions for creating a vehicle (Task 4: VIN decode + manual add).
 *
 * CONCEPT: a Server Action ('use server' at the top of the file) is a
 * function that always runs on the server, even though components/
 * VehicleForm.tsx calls it directly like a normal function from the
 * browser. Next.js compiles the call into a POST request under the hood —
 * no hand-written /api route needed for a plain form submission. Because
 * it's reachable by anyone who can send that POST (not just through the UI
 * button), every action must authenticate and validate its own input
 * exactly like a public API route would — see the Server Actions security
 * notes bundled with Next.js 16.
 */
'use server';

import { randomUUID } from 'node:crypto';
import { redirect } from 'next/navigation';
import { put } from '@vercel/blob';
import { requireTenant } from '@/lib/auth';
import { getDb } from '@/lib/db';
import { vehicles, odometerReadings } from '@/lib/db/schema';
import { createVehicleInputSchema } from '@/lib/types';
import { MAX_PHOTO_BYTES, isAllowedPhotoType } from '@/lib/photo';

// Shape returned to the client on failure. CONCEPT: useActionState (the
// client hook that calls this action) re-renders the form with whatever
// this function returns — returning a typed `{ error }` object instead of
// throwing lets the form show a friendly inline message instead of an
// unhandled-exception overlay.
export interface CreateVehicleState {
  error?: string;
}

// FormData values are always strings (or File) — never numbers, booleans,
// or null — even for a field the form renders as `<input type="number">` or
// a date picker. These two helpers are the one place that turns "the field
// was left blank" into `null` rather than an empty string, so the Zod
// schema only has to describe the DOMAIN rule (nullable) instead of also
// special-casing "" everywhere.
function optionalString(formData: FormData, key: string): string | null {
  const value = formData.get(key);
  if (typeof value !== 'string') return null;
  const trimmed = value.trim();
  return trimmed === '' ? null : trimmed;
}

// WHY return NaN instead of null for "field had a value but it wasn't a
// number": z.number() rejects NaN by default (it fails the same way a
// string or a negative-when-positive-required value would) — passing NaN
// through to the schema means "user typed garbage in a number field" gets
// the same typed `{ error }` response as any other bad input, instead of
// silently being treated as "field left blank" (a real pre-flight-checklist
// gap: `count <= 0` alone doesn't catch NaN, but z.number() does).
function optionalInt(formData: FormData, key: string): number | null {
  const raw = optionalString(formData, key);
  if (raw === null) return null;
  const n = Number(raw);
  return Number.isFinite(n) ? Math.trunc(n) : NaN;
}

export async function createVehicle(
  _prevState: CreateVehicleState,
  formData: FormData,
): Promise<CreateVehicleState> {
  // requireTenant() redirects to /sign-in if there's no session at all —
  // the correct behavior for a Server Action (unlike the API route in
  // app/api/vin/route.ts, this call is always triggered by a form
  // submission from within the app, so a redirect is the right UX, not a
  // parsing problem for a fetch() caller).
  const { tenantId } = await requireTenant();

  const parsed = createVehicleInputSchema.safeParse({
    nickname: optionalString(formData, 'nickname') ?? '',
    vin: optionalString(formData, 'vin'),
    plate: optionalString(formData, 'plate'),
    make: optionalString(formData, 'make'),
    model: optionalString(formData, 'model'),
    engine: optionalString(formData, 'engine'),
    year: optionalInt(formData, 'year'),
    istimaraExpiry: optionalString(formData, 'istimaraExpiry'),
    fahesDue: optionalString(formData, 'fahesDue'),
    decodeSource: optionalString(formData, 'decodeSource') ?? 'manual',
    initialOdometerKm: optionalInt(formData, 'initialOdometerKm'),
  });

  if (!parsed.success) {
    return { error: parsed.error.issues[0]?.message ?? 'Some fields need fixing.' };
  }

  const input = parsed.data;

  // Photo upload — thin and self-contained on purpose. Task 7's invoice
  // photo upload is a different route with different constraints (invoice
  // photos attach to a service event, not a vehicle), so there's nothing to
  // share yet; abstracting a "photo upload" helper now, before a second
  // real caller exists, would be guessing at a shape neither use case has
  // proven out.
  let photoUrl: string | null = null;
  const photo = formData.get('photo');
  if (process.env.BLOB_READ_WRITE_TOKEN && photo instanceof File && photo.size > 0) {
    if (!isAllowedPhotoType(photo.type)) {
      return { error: 'Photo must be a JPEG, PNG, or WEBP image.' };
    }
    if (photo.size > MAX_PHOTO_BYTES) {
      return { error: 'Photo must be 5MB or smaller.' };
    }
    const blob = await put(`vehicles/${tenantId}/${randomUUID()}-${photo.name}`, photo, {
      access: 'public',
    });
    photoUrl = blob.url;
  }

  const db = getDb();

  // Generating the vehicle's id here (instead of letting the DB's
  // defaultRandom() assign one on insert) is what lets both inserts below
  // be prepared without needing the vehicle insert's `.returning()` result
  // first.
  //
  // WHY `db.transaction()` here (Task 6 migrated lib/db/index.ts from the
  // Neon HTTP driver, which has no real transaction support, to the
  // Pool/WebSocket driver, which does — see that file's header comment):
  // a vehicle added WITH an initial odometer reading needs both rows to
  // land together or not at all — a crash between the two inserts would
  // otherwise leave a vehicle with no reading history, silently breaking
  // every due-status calculation that depends on "the latest reading"
  // until someone notices and logs one manually.
  const vehicleId = randomUUID();
  const vehicleValues = {
    id: vehicleId,
    tenantId,
    nickname: input.nickname,
    vin: input.vin,
    plate: input.plate,
    make: input.make,
    model: input.model,
    year: input.year,
    engine: input.engine,
    decodeSource: input.decodeSource,
    istimaraExpiry: input.istimaraExpiry,
    fahesDue: input.fahesDue,
    photoUrl,
  };

  if (input.initialOdometerKm !== null) {
    const initialOdometerKm = input.initialOdometerKm;
    await db.transaction(async (tx) => {
      await tx.insert(vehicles).values(vehicleValues);
      await tx.insert(odometerReadings).values({
        vehicleId,
        tenantId,
        readingKm: initialOdometerKm,
        source: 'manual',
      });
    });
  } else {
    await db.insert(vehicles).values(vehicleValues);
  }

  // redirect() throws internally (Next.js control-flow), so nothing after
  // this line runs — that's expected, not a bug, per the Server Actions
  // guide bundled with this Next.js version.
  redirect(`/vehicles/${vehicleId}`);
}
