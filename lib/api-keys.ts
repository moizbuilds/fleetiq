/**
 * API-key helpers for the tracker webhook (Task 9) — the ONE non-Clerk-
 * authenticated surface in FleetIQ (see proxy.ts's allowlist for
 * /api/integrations/(.*)). A GPS tracker device can't run a Clerk sign-in
 * flow, so it authenticates instead with a long-lived key it sends on every
 * request via the `x-fleetiq-key` header.
 *
 * Every function here is PURE (no DB, no Next.js import) — that's what
 * makes tests/api-keys.test.ts able to exercise all of them with plain
 * fixtures, no network or database involved.
 *
 * CONCEPT: we store only a SHA-256 HASH of the key (lib/db/schema.ts's
 * tenantApiKeys.keyHash), never the raw key itself. A database leak (a
 * backup exposed, a misconfigured read replica) then leaks unusable hashes,
 * not working credentials — the same reason a login system stores a
 * password hash, not the password. Comparing hashes with
 * `crypto.timingSafeEqual` (rather than `===` or `Buffer.equals`) matters
 * for the same reason a login system's password check does: a naive `===`
 * comparison returns as soon as the first mismatched byte is found, so an
 * attacker who can measure response time (even down to microseconds, over
 * many requests) can recover the correct hash one byte at a time.
 * `timingSafeEqual` always compares every byte, so the time taken reveals
 * nothing about how many bytes matched.
 */
import { randomBytes, createHash, timingSafeEqual } from 'node:crypto';

// "fiq_" (FleetIQ) + 32 lowercase hex characters (16 random bytes) — a
// recognizable prefix (so a key is identifiable at a glance in a device's
// config screen, the way Stripe's `sk_live_...` keys are) plus enough
// entropy (2^128 possibilities) that guessing one is infeasible.
const KEY_PREFIX = 'fiq_';
const RAW_KEY_PATTERN = /^fiq_[0-9a-f]{32}$/;

// Generates a brand-new key pair: the RAW string (shown to the user exactly
// once, by lib/actions/apiKeys.ts's rotateApiKey) and its hash (the only
// half that ever gets stored). WHY the caller gets both instead of this
// function storing the hash itself: this file has no DB import at all —
// storage is lib/actions/apiKeys.ts's job (dependency injection, same
// reasoning as lib/rate-limit.ts's injected `db` parameter), which is what
// keeps this module testable with zero setup.
export function generateApiKey(): { raw: string; hash: string } {
  const raw = KEY_PREFIX + randomBytes(16).toString('hex');
  return { raw, hash: hashApiKey(raw) };
}

// One-way hash of a raw key — used both when generating a new key (above)
// and when checking a candidate key sent by a tracker device (below).
export function hashApiKey(raw: string): string {
  return createHash('sha256').update(raw).digest('hex');
}

// Shape check ONLY (does this look like a key we could have issued at
// all?) — cheap enough to run before ever touching the database, so a
// request with an obviously-wrong header (empty, a totally different
// format) never even reaches a DB round trip. This is NOT a security
// boundary on its own (an attacker could craft a string that matches the
// shape) — it exists purely to short-circuit garbage input before the real
// check (verifyApiKey / a hash lookup) runs.
export function isValidApiKeyShape(candidate: string): boolean {
  return RAW_KEY_PATTERN.test(candidate);
}

// The actual credential check: hash the candidate and compare it to the
// stored hash in constant time. WHY timing-safe compare here even though
// app/api/integrations/odometer/route.ts's real lookup is BY hash (a DB
// index lookup, not a linear scan comparing every stored key) — see that
// route's comment for why the DB lookup is the primary guard there: this
// function is still the one place a byte-by-byte candidate/stored
// comparison happens, so it has to be timing-safe regardless of how its
// caller sources `storedHash`.
export function verifyApiKey(candidateRaw: string, storedHash: string): boolean {
  const candidateHash = hashApiKey(candidateRaw);
  const candidateBuf = Buffer.from(candidateHash, 'hex');
  const storedBuf = Buffer.from(storedHash, 'hex');

  // Guard kept even though sha256-hex is always 64 chars by construction:
  // timingSafeEqual throws (rather than returning false) on a length
  // mismatch, so this turns an impossible-in-practice case into a clean
  // `false` instead of an unhandled exception.
  if (candidateBuf.length !== storedBuf.length) return false;

  return timingSafeEqual(candidateBuf, storedBuf);
}
