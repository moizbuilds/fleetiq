// Tests the fail-closed behavior added to proxy.ts: with no valid Clerk
// publishable key configured (the state of a freshly-cloned repo before
// secrets are filled in), API routes must refuse requests with a 503
// instead of silently letting them through with no auth check at all.
//
// WHY this needs its own test instead of just trusting the code review:
// this is exactly the kind of security-relevant middleware behavior the
// project standards call out — "verify security fixes by exercising the
// attack, never by re-reading the diff." Without NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY
// set (the default in this test process — nothing loads .env.local for
// vitest), hasValidClerkPublishableKey() is false, which is exactly the
// unconfigured-deployment scenario this test needs.
import { describe, it, expect, beforeEach, vi } from 'vitest';
import { NextRequest, type NextFetchEvent } from 'next/server';

// A stand-in for the second argument Next.js passes to middleware. None of
// the branches under test call into it, so an empty object is enough.
const fakeEvent = {} as NextFetchEvent;

describe('proxy (unconfigured Clerk key)', () => {
  beforeEach(() => {
    vi.resetModules();
    delete process.env.NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY;
  });

  it('returns 503 JSON for a protected API route', async () => {
    const { default: proxy } = await import('@/proxy');
    const req = new NextRequest(new URL('http://localhost/api/vehicles'));

    const res = proxy(req, fakeEvent) as Response;

    expect(res.status).toBe(503);
    const body = await res.json();
    expect(body).toEqual({ error: 'Auth is not configured on this deployment' });
  });

  it('falls through for /api/integrations (its own API-key auth)', async () => {
    const { default: proxy } = await import('@/proxy');
    const req = new NextRequest(new URL('http://localhost/api/integrations/webhook'));

    const res = proxy(req, fakeEvent) as Response;

    // NextResponse.next() carries this header as its marker for
    // "continue the request" rather than a JSON error body.
    expect(res.headers.get('x-middleware-next')).toBe('1');
  });

  it('falls through for a page route (SetupNotice covers it)', async () => {
    const { default: proxy } = await import('@/proxy');
    const req = new NextRequest(new URL('http://localhost/vehicles'));

    const res = proxy(req, fakeEvent) as Response;

    expect(res.headers.get('x-middleware-next')).toBe('1');
  });
});
