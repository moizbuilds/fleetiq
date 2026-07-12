/**
 * VIN decode API — GET /api/vin?vin=<17-character VIN>
 *
 * What this does: validates the VIN's shape, proxies it to NHTSA's free
 * vPIC (Vehicle Product Information Catalog) VIN-decode API, and maps the
 * response into this app's `VinDecodeResult` shape via lib/vin.ts's pure
 * `mapVpicResult()`.
 *
 * WHY this is a Route Handler (not called directly from a Server
 * Component): /vehicles/new needs to decode a VIN on-demand, after the page
 * has already rendered, in response to a button click — a Server Component
 * only runs once at render time and can't react to a later client event.
 *
 * WHY this still checks auth manually with `await auth()` instead of the
 * app's usual `requireTenant()`: this route lives behind Clerk already
 * (proxy.ts only allowlists /api/integrations/*, so every other /api route
 * — including this one — requires a session before the handler even runs).
 * But `requireTenant()` calls `redirect()` on failure, which is meant for
 * Server Components rendering a page; an API route must always return JSON,
 * never a redirect response, so a fetch() caller gets a parseable error
 * instead of chasing a 307 to a login HTML page. This route doesn't need a
 * tenantId at all (vPIC has no concept of tenants), so a plain `auth()`
 * check is the right amount of code — not a reason to change
 * `requireTenant()` itself.
 */
import { NextResponse } from 'next/server';
import type { NextRequest } from 'next/server';
import { auth } from '@clerk/nextjs/server';
import { isValidVin, mapVpicResult } from '@/lib/vin';

// vPIC is a free, unauthenticated NHTSA API — no API key involved. A 10s
// timeout via AbortSignal keeps a slow/hanging upstream from tying up this
// route indefinitely; the manual-add path stays available either way (see
// the brief: decode failure must never block adding a vehicle).
const VPIC_TIMEOUT_MS = 10_000;
const VPIC_UNREACHABLE_MESSAGE = 'VIN service unreachable — add the vehicle manually';

export async function GET(request: NextRequest) {
  const { userId } = await auth();
  if (!userId) {
    return NextResponse.json({ error: 'Not signed in' }, { status: 401 });
  }

  const rawVin = request.nextUrl.searchParams.get('vin');
  if (!rawVin) {
    return NextResponse.json({ error: 'Missing vin query parameter' }, { status: 400 });
  }

  // Server-side validation — the UI blocks an obviously-malformed VIN before
  // ever calling this route, but that's a convenience, not a boundary; this
  // check is what actually protects vPIC (and this route's own logic) from
  // garbage input sent directly via curl/fetch.
  const vin = rawVin.trim().toUpperCase();
  if (!isValidVin(vin)) {
    return NextResponse.json(
      { error: 'VIN must be 17 characters (letters and numbers, excluding I, O, Q).' },
      { status: 400 },
    );
  }

  try {
    const res = await fetch(
      `https://vpic.nhtsa.dot.gov/api/vehicles/DecodeVinValues/${vin}?format=json`,
      { signal: AbortSignal.timeout(VPIC_TIMEOUT_MS) },
    );

    if (!res.ok) {
      return NextResponse.json({ error: VPIC_UNREACHABLE_MESSAGE }, { status: 502 });
    }

    const data = await res.json();
    const result = data?.Results?.[0];
    if (!result || typeof result !== 'object') {
      return NextResponse.json({ error: VPIC_UNREACHABLE_MESSAGE }, { status: 502 });
    }

    return NextResponse.json(mapVpicResult(result));
  } catch {
    // Network failure, DNS error, or the AbortSignal timeout firing all land
    // here — vPIC being unreachable for ANY reason must degrade to the same
    // message and status, never a fabricated decode result.
    return NextResponse.json({ error: VPIC_UNREACHABLE_MESSAGE }, { status: 502 });
  }
}
