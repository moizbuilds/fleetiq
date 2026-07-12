/**
 * AI schedule generation API — POST /api/ai/schedule with `{ vehicleId }`.
 *
 * What this does: looks up the vehicle (tenant-scoped), asks Claude for a
 * full maintenance schedule via lib/ai/schedule.ts, and returns the raw
 * items to the browser. It does NOT save anything — components/
 * ScheduleReview.tsx shows the result for review first, and only
 * lib/actions/schedule.ts's `acceptSchedule` ever writes to the DB
 * (globals.md: "extraction pre-fills forms; never auto-saves").
 *
 * WHY this is a Route Handler instead of a Server Action: the vehicle page
 * needs to trigger generation from a button click AFTER the page has
 * already rendered (same reasoning as app/api/vin/route.ts), so a plain
 * `fetch()` from a Client Component is the right shape here.
 *
 * WHY `await auth()` + `resolveTenantId()` instead of `requireTenant()`:
 * `requireTenant()` calls Next's `redirect()` on a missing session, which
 * is correct for a page render but wrong for an API route — a fetch()
 * caller needs a parseable 401 JSON body, never an HTML redirect response.
 * `resolveTenantId()` (extracted from lib/auth.ts specifically for this)
 * is the same org-resolution logic `requireTenant()` uses internally, so
 * both paths land on the exact same tenantId for the exact same user —
 * one implementation, two entry points.
 */
import { NextResponse } from 'next/server';
import { auth } from '@clerk/nextjs/server';
import { and, eq } from 'drizzle-orm';
import { resolveTenantId } from '@/lib/auth';
import { getDb } from '@/lib/db';
import { vehicles } from '@/lib/db/schema';
import { isValidUuid } from '@/lib/types';
import { getAnthropic } from '@/lib/ai/client';
import { generateSchedule } from '@/lib/ai/schedule';
import { checkRateLimit, RATE_LIMITS } from '@/lib/rate-limit';

const INVALID_BODY_MESSAGE = 'A valid vehicleId is required.';
const GENERATION_FAILED_MESSAGE = "Couldn't generate a schedule right now — try again in a minute.";

export async function POST(request: Request) {
  const { userId, orgId } = await auth();
  if (!userId) {
    return NextResponse.json({ error: 'Not signed in' }, { status: 401 });
  }
  const tenantId = await resolveTenantId(userId, orgId ?? null);

  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: INVALID_BODY_MESSAGE }, { status: 400 });
  }

  const vehicleId =
    typeof body === 'object' && body !== null
      ? (body as Record<string, unknown>).vehicleId
      : undefined;

  if (typeof vehicleId !== 'string' || !isValidUuid(vehicleId)) {
    return NextResponse.json({ error: INVALID_BODY_MESSAGE }, { status: 400 });
  }

  const db = getDb();

  // Rate limit BEFORE the vehicle lookup, per this endpoint's ordering
  // rule — a tenant that's already exhausted its hourly budget gets the
  // same 429 whether or not the vehicleId they sent even exists, so this
  // check never has to touch the vehicles table at all.
  const { schedule: scheduleLimit } = RATE_LIMITS;
  const rateLimit = await checkRateLimit(db, tenantId, 'schedule', scheduleLimit.limit, scheduleLimit.windowMinutes);
  if (!rateLimit.allowed) {
    return NextResponse.json(
      {
        error: `Schedule generation is limited to ${scheduleLimit.limit} runs per hour. Try again in ${rateLimit.retryAfterMinutes} minutes.`,
      },
      { status: 429 },
    );
  }

  // Scoping by BOTH id and tenantId in one WHERE clause (rather than
  // fetching by id and checking tenantId after) means a vehicle belonging
  // to a different tenant is indistinguishable from one that doesn't exist
  // at all — a 404, not a 403 that would leak "yes, that id exists".
  const [vehicle] = await db
    .select()
    .from(vehicles)
    .where(and(eq(vehicles.id, vehicleId), eq(vehicles.tenantId, tenantId)))
    .limit(1);

  if (!vehicle) {
    return NextResponse.json({ error: 'Vehicle not found.' }, { status: 404 });
  }

  try {
    const schedule = await generateSchedule(getAnthropic(), vehicle);
    return NextResponse.json(schedule);
  } catch {
    // Covers both a Claude API failure (network, 5xx, timeout) and a
    // parse/schema failure (lib/ai/parse.ts's AiParseError) — either way,
    // globals.md's "never fabricate a result" rule means the honest
    // response is a clear failure, not a guessed-at schedule.
    return NextResponse.json({ error: GENERATION_FAILED_MESSAGE }, { status: 502 });
  }
}
