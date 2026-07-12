/**
 * Tracker webhook — POST /api/integrations/odometer
 *
 * This is the ONE endpoint in FleetIQ that does NOT sit behind Clerk (see
 * proxy.ts's allowlist for /api/integrations/(.*)). A GPS tracker device
 * bolted into a vehicle has no browser, no Clerk session, no human to sign
 * in — it authenticates instead with a long-lived API key
 * (lib/settings/ApiKeyPanel.tsx issues one per tenant) sent on every
 * request via the `x-fleetiq-key` header. Being the app's only
 * internet-facing, non-session-authenticated surface makes this route the
 * highest-stakes file in the whole app: every step below fails CLOSED
 * (missing/malformed/wrong key -> 401; oversized/malformed body -> 413/400;
 * unknown vehicle -> 404; a below-latest reading -> 409) and the outer
 * try/catch never lets an unexpected error leak a stack trace to a public
 * caller.
 *
 * WHY no rate limit beyond the auth check itself (task-9-brief.md's
 * explicit call): every OTHER paid/DB-write endpoint in this app that
 * needs one (lib/rate-limit.ts) is guarding a Claude API call that costs
 * real money per request. A tracker posting an odometer reading is a
 * single cheap INSERT, and it's already keyed to one tenant's own key — a
 * misbehaving/compromised device can only ever spam its OWN tenant's data,
 * never anyone else's, and there's no per-call cost to cap. If tracker spam
 * ever becomes a real problem, the fix is a rate limit keyed on the
 * (already-verified) tenantId, reusing lib/rate-limit.ts's exact pattern —
 * not something this task needs to add speculatively.
 */
import { NextResponse } from 'next/server';
import { getDb } from '@/lib/db';
import { webhookOdometerSchema } from '@/lib/types';
import { logOdometerCore, OdometerValidationError } from '@/lib/actions/odometer-core';
import { authenticateWebhook, resolveWebhookVehicle } from '@/lib/actions/webhook-core';

const API_KEY_HEADER = 'x-fleetiq-key';
const MAX_BODY_BYTES = 10 * 1024; // 10KB — a generous multiple of this schema's actual payload size

const VEHICLE_NOT_FOUND_MESSAGE = 'No vehicle with that VIN in this account';
const GENERIC_AUTH_FAILURE_MESSAGE = 'Invalid API key';

export async function POST(request: Request) {
  // Wraps the ENTIRE handler: any error that isn't one of this route's own
  // typed 401/404/409/413/400 responses (a DB connection failure, an
  // unexpected exception in a dependency) surfaces as a bare 500 with a
  // generic message — never a stack trace to a caller this route has no
  // Clerk session to identify.
  try {
    // (1) Missing header gets its own specific message — distinct from
    // "you sent something, but it's wrong" (step 2/3 below) — so an
    // integrator setting up a NEW tracker gets a message that actually
    // points at "you forgot to send the header" instead of a generic
    // "invalid key" that reads the same whether the key is missing,
    // malformed, or just wrong.
    const headerValue = request.headers.get(API_KEY_HEADER);
    if (!headerValue) {
      return NextResponse.json({ error: `Missing ${API_KEY_HEADER} header` }, { status: 401 });
    }

    const db = getDb();

    // (2) + (3) Shape-check then hash-lookup, both inside
    // authenticateWebhook (see that file's header for why the lookup is BY
    // HASH rather than by any tenant-supplied id: the hash of the caller's
    // own key IS the credential). Malformed shape and "well-formed but
    // unknown" both collapse to the SAME generic message — telling them
    // apart would hand an attacker a free oracle for "is this exact key
    // real" versus "did I get the format wrong".
    const tenantId = await authenticateWebhook(db, headerValue);
    if (!tenantId) {
      return NextResponse.json({ error: GENERIC_AUTH_FAILURE_MESSAGE }, { status: 401 });
    }

    // (4) Size cap BEFORE parsing — reading the body as text and checking
    // its byte length (not `.length`, which counts UTF-16 code units, not
    // bytes) lets an oversized payload be rejected without ever handing a
    // potentially huge string to JSON.parse.
    const rawBody = await request.text();
    if (Buffer.byteLength(rawBody, 'utf-8') > MAX_BODY_BYTES) {
      return NextResponse.json({ error: 'Request body too large' }, { status: 413 });
    }

    let body: unknown;
    try {
      body = JSON.parse(rawBody);
    } catch {
      return NextResponse.json({ error: 'Body must be valid JSON.' }, { status: 400 });
    }

    // (5) Zod validates shape/bounds AND the "exactly one of vin/vehicleId"
    // rule (lib/types.ts's webhookOdometerSchema) — field-level errors are
    // returned so an integrator can see exactly which field failed instead
    // of a single opaque message.
    const parsed = webhookOdometerSchema.safeParse(body);
    if (!parsed.success) {
      return NextResponse.json(
        { error: 'Some fields need fixing.', fields: parsed.error.flatten().fieldErrors },
        { status: 400 },
      );
    }

    // (6) Resolve the vehicle WITHIN the authenticated tenant only — an
    // identical VIN belonging to a different tenant reads as "not found",
    // never a cross-tenant match (see resolveWebhookVehicle's header for
    // why this has to be one scoped query, not a lookup-then-check).
    const vehicle = await resolveWebhookVehicle(db, tenantId, {
      vin: parsed.data.vin,
      vehicleId: parsed.data.vehicleId,
    });
    if (!vehicle) {
      return NextResponse.json({ error: VEHICLE_NOT_FOUND_MESSAGE }, { status: 404 });
    }

    // (7) Insert via the SAME core guard every manual odometer log goes
    // through (lib/actions/odometer-core.ts), tagged source: 'tracker' so
    // it's distinguishable from a manual/service reading in a vehicle's
    // history. isCorrection is always false here — a tracker has no UI to
    // supply the note a correction requires, and "the tracker glitched"
    // must never be able to silently overwrite a real prior reading
    // (task-9-brief.md: "tracker glitches must not corrupt").
    //
    // NOTE: `parsed.data.recordedAt` (if the device sent one) is
    // deliberately IGNORED — every reading is server-stamped via
    // odometerReadings.recordedAt's defaultNow(), never taken from the
    // request body. Trusting a device's own clock is exactly the kind of
    // unverified, caller-controlled input globals.md's trust-boundary rule
    // warns about: a tracker with a wrong (or maliciously backdated) clock
    // could otherwise report a reading timestamped in the past, which would
    // either dodge the below-latest guard (if the DB compared against a
    // client-supplied "now") or silently reorder a vehicle's reading
    // history. Accepting the field but not using it keeps a well-behaved
    // integration's payload valid without ever trusting its contents.
    try {
      await db.transaction((tx) =>
        logOdometerCore(
          tx,
          tenantId,
          { vehicleId: vehicle.id, readingKm: parsed.data.readingKm, isCorrection: false, note: null },
          'tracker',
        ),
      );
    } catch (err) {
      if (err instanceof OdometerValidationError) {
        return NextResponse.json({ error: err.message }, { status: 409 });
      }
      throw err;
    }

    return NextResponse.json(
      { ok: true, vehicleId: vehicle.id, readingKm: parsed.data.readingKm },
      { status: 201 },
    );
  } catch {
    return NextResponse.json({ error: 'Something went wrong. Try again.' }, { status: 500 });
  }
}
