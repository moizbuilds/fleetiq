/**
 * Tracker webhook business logic (Task 9) — the auth + vehicle-resolution
 * steps of app/api/integrations/odometer/route.ts, pulled out into their own
 * plain functions so tests/webhook.test.ts can run them directly against an
 * in-memory PGlite database (same dependency-injection reasoning as
 * lib/rate-limit.ts's checkRateLimit and lib/actions/odometer-core.ts's
 * logOdometerCore — see either file's header for the fuller version of this
 * argument).
 *
 * WHY these live outside the route file at all: a Next.js Route Handler
 * only exports GET/POST/etc — there's no way to import "just the auth
 * logic" out of one without also pulling in `NextResponse`, `request`
 * parsing, and everything else that needs a real HTTP request object.
 * Splitting the parts that only need a plain string/db argument into their
 * own module is what makes them testable with zero HTTP involved.
 */
import { eq, and } from 'drizzle-orm';
import type { NeonDatabase } from 'drizzle-orm/neon-serverless';
import type { PgliteDatabase } from 'drizzle-orm/pglite';
import type * as schema from '@/lib/db/schema';
import { tenantApiKeys, vehicles } from '@/lib/db/schema';
import { hashApiKey, isValidApiKeyShape } from '@/lib/api-keys';

// Accepts either driver's plain (non-transaction) query handle — the real
// Neon Pool/WebSocket driver in production, PGlite's in-memory one in
// tests. Same reasoning as lib/rate-limit.ts's `RateLimitDb`: this module
// only ever calls `.select().from().where()`, the driver-agnostic subset
// both expose.
export type WebhookDb = NeonDatabase<typeof schema> | PgliteDatabase<typeof schema>;

// Turns the raw `x-fleetiq-key` header value into a tenantId, or `null` if
// the caller isn't allowed in — covering all three failure shapes the
// route needs to tell apart from a genuine success:
//   - missing/empty header (the route checks this itself BEFORE calling in,
//     so it can return the more specific "Missing x-fleetiq-key header"
//     message — but this function still treats `null` as just another
//     invalid case, so it's directly testable on its own)
//   - malformed shape (doesn't even look like a key FleetIQ could have
//     issued) — rejected before ever touching the database
//   - well-shaped but unknown (hashes to no row in tenantApiKeys)
//
// WHY the lookup is BY HASH (`WHERE key_hash = <hash of the candidate>`)
// rather than "look up the claimed tenant, then timing-safe-compare against
// its stored hash": there IS no tenant-supplied id anywhere in this
// request — the hash of the caller's own key IS the credential, the same
// way a session token or a password reset link's token works. Looking it up
// by its indexed, unique hash column means an unrecognized key reads as "no
// row" in one indexed lookup, never a scan comparing against every stored
// key. Hashing BEFORE the query (rather than passing the raw key into a SQL
// WHERE clause some other way) also means the raw key never appears in a
// query parameter or log line — only its hash ever leaves this function.
export async function authenticateWebhook(
  db: WebhookDb,
  headerValue: string | null,
): Promise<string | null> {
  if (!headerValue) return null;
  if (!isValidApiKeyShape(headerValue)) return null;

  const hash = hashApiKey(headerValue);
  const [row] = await db
    .select({ tenantId: tenantApiKeys.tenantId })
    .from(tenantApiKeys)
    .where(eq(tenantApiKeys.keyHash, hash))
    .limit(1);

  return row?.tenantId ?? null;
}

// Resolves "which vehicle is this reading for" WITHIN the authenticated
// tenant — by VIN (uppercased, matching how vehicles.vin is stored — see
// lib/vin.ts's isValidVin/mapVpicResult for the same normalization) or by
// vehicleId, whichever the request body supplied (lib/types.ts's
// webhookOdometerSchema guarantees exactly one is present by this point).
//
// WHY scoped by tenantId in the SAME query rather than fetched by
// identifier alone and checked after: an identical VIN belonging to a
// DIFFERENT tenant must be indistinguishable from a VIN that doesn't exist
// anywhere — the same tenant-isolation rule every other tenant-scoped query
// in this app follows (globals.md), and exactly why
// tests/webhook.test.ts's "other tenant's identical VIN" case has to come
// back empty here.
export async function resolveWebhookVehicle(
  db: WebhookDb,
  tenantId: string,
  identifier: { vin?: string; vehicleId?: string },
): Promise<{ id: string } | null> {
  const condition = identifier.vehicleId
    ? and(eq(vehicles.id, identifier.vehicleId), eq(vehicles.tenantId, tenantId))
    : and(eq(vehicles.vin, identifier.vin!.toUpperCase()), eq(vehicles.tenantId, tenantId));

  const [vehicle] = await db.select({ id: vehicles.id }).from(vehicles).where(condition).limit(1);
  return vehicle ?? null;
}
