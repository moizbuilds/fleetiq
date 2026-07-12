/**
 * VIN (Vehicle Identification Number) helpers — pure functions, no network.
 *
 * What this does: (1) validates that a string has the right SHAPE to be a
 * VIN, and (2) turns a raw vPIC (NHTSA's free VIN-decode API) response into
 * the app's own `VinDecodeResult` shape, normalizing vPIC's various "we
 * don't know" sentinels to a plain `null`.
 *
 * WHY this lives in its own module instead of inline in the route handler
 * (app/api/vin/route.ts): both functions are pure — same input always gives
 * the same output, no `fetch`, no Clerk, no DB. That's what makes them
 * unit-testable with plain fixtures (see tests/vin.test.ts) instead of
 * needing a live network call or a mocked `fetch` in every test. The route
 * handler imports these and adds the parts that genuinely need I/O:
 * reading the request, calling vPIC, and turning failures into HTTP
 * responses.
 */
import type { VinDecodeResult } from './types';

// ---------------------------------------------------------------------------
// VIN shape validation
// ---------------------------------------------------------------------------

// A real VIN is exactly 17 characters from a restricted alphabet: digits
// 0-9 plus every letter EXCEPT I, O, and Q. Those three are excluded
// industry-wide (ISO 3779) because they're too easily confused with 1, 0,
// and 0 on a stamped plate or a handwritten note — allowing them here would
// let obviously-wrong input reach vPIC's API instead of failing fast.
const VIN_PATTERN = /^[A-HJ-NPR-Z0-9]{17}$/;

// CONCEPT: this function is used on BOTH sides of the trust boundary — the
// client blocks submission with it for a fast, friendly UI response, and
// the API route re-runs it on the server before ever calling vPIC. The
// client-side check is a convenience; only the server-side check is a
// security/correctness boundary, since a client-side-only check can always
// be bypassed by calling the route directly.
export function isValidVin(vin: string): boolean {
  const normalized = vin.trim().toUpperCase();
  return VIN_PATTERN.test(normalized);
}

// ---------------------------------------------------------------------------
// vPIC response mapping
// ---------------------------------------------------------------------------

// vPIC's own way of saying "no data for this field" — verified against a
// live API response (see tests/vin.test.ts): a field vPIC couldn't decode
// comes back as either an empty string or the literal text "Not
// Applicable", never as a JSON `null`. Storing either of those verbatim
// would put meaningless placeholder text into the database instead of a
// real null the UI can render as "vPIC couldn't decode this — fill it in".
const BLANK_SENTINELS = new Set(['', 'Not Applicable']);

function cleanString(value: string | undefined): string | null {
  if (value === undefined) return null;
  const trimmed = value.trim();
  return BLANK_SENTINELS.has(trimmed) ? null : trimmed;
}

// ModelYear has its own sentinel on top of the blank ones above: vPIC
// reports "0" rather than a blank string when it couldn't decode a year at
// all (verified live) — a naive Number() conversion would silently store
// the DB's "no data" state as the literal number 0, which reads on screen
// as "Year: 0" instead of "Year: —".
function cleanYear(value: string | undefined): number | null {
  const cleaned = cleanString(value);
  if (cleaned === null) return null;
  const year = Number(cleaned);
  if (!Number.isInteger(year) || year === 0) return null;
  return year;
}

// Builds the free-text "engine" summary shown in the vehicle form and detail
// page by composing whichever of these four vPIC fields actually decoded to
// a value: displacement (e.g. "2.8L"), cylinder count (e.g. "4-cyl"),
// primary fuel type (e.g. "Diesel"), and the engine model code (e.g.
// "1GD-FTV") if vPIC reported one. Any missing/blank part is simply
// skipped rather than leaving a stray "null" or double space in the string.
//
// WHY this order: displacement + cylinders + fuel reads like a natural spec
// sentence a mechanic would say out loud ("2.8-liter 4-cylinder Diesel").
// The engine model code is the least human-readable part (a manufacturer's
// internal part number), so it trails as supplementary detail rather than
// leading the string.
//
// WHY round DisplacementL to one decimal: vPIC returns this as a long
// decimal in practice (e.g. "2.998832712" for a real VIN, verified live),
// not a clean "3.0" — displaying that raw string would look like a data
// bug. Non-numeric displacement values (never seen live, but not
// impossible) fall back to the raw string unrounded rather than being
// dropped, since some data beats none.
function composeEngine(raw: Record<string, string>): string | null {
  const parts: string[] = [];

  const displacement = cleanString(raw.DisplacementL);
  if (displacement !== null) {
    const parsed = Number(displacement);
    parts.push(Number.isFinite(parsed) ? `${parsed.toFixed(1)}L` : `${displacement}L`);
  }

  const cylinders = cleanString(raw.EngineCylinders);
  if (cylinders !== null) parts.push(`${cylinders}-cyl`);

  const fuel = cleanString(raw.FuelTypePrimary);
  if (fuel !== null) parts.push(fuel);

  const engineModel = cleanString(raw.EngineModel);
  if (engineModel !== null) parts.push(engineModel);

  return parts.length > 0 ? parts.join(' ') : null;
}

// Maps vPIC's `Results[0]` object (a flat, all-string-valued record — even
// numeric-looking fields like ModelYear come back as strings) to this app's
// `VinDecodeResult` contract. Pure and synchronous: the route handler is
// the only caller that has actually talked to the network.
export function mapVpicResult(raw: Record<string, string>): VinDecodeResult {
  return {
    vin: raw.VIN ?? '',
    make: cleanString(raw.Make),
    model: cleanString(raw.Model),
    year: cleanYear(raw.ModelYear),
    engine: composeEngine(raw),
    raw,
  };
}
