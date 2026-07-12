/**
 * Photo-upload validation rules — shared between the client (components/
 * VehicleDetailsForm.tsx, a pre-submit check) and the server (lib/actions/
 * vehicles.ts's createVehicle, the actual authority).
 *
 * WHY this is its own tiny module instead of two copies of the same two
 * numbers: the client check only exists so a bad photo gets caught before a
 * round trip to the server, not to replace the server check — if the two
 * ever drifted (say, someone bumps the server's size cap and forgets the
 * client's), the client would silently reject files the server would have
 * accepted, or worse, wave through files the server then rejects with a
 * message the user has no context for. One source of truth removes that
 * whole class of bug (globals.md's "one source of truth" rule).
 */

export const MAX_PHOTO_BYTES = 5 * 1024 * 1024;

export const ALLOWED_PHOTO_TYPES = ['image/jpeg', 'image/png', 'image/webp'] as const;

export function isAllowedPhotoType(type: string): boolean {
  return (ALLOWED_PHOTO_TYPES as readonly string[]).includes(type);
}
