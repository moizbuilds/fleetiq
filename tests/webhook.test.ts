// Unit tests for the tracker webhook's non-HTTP building blocks —
// lib/actions/webhook-core.ts's authenticateWebhook/resolveWebhookVehicle
// and lib/actions/odometer-core.ts's logOdometerCore called with source
// 'tracker'. Calling the route handler directly with a mocked Request
// would exercise the same logic through an extra, unnecessary layer (see
// task-9-brief.md: "route handler called directly with a PGlite-backed db
// mock is overkill") — these helpers are exactly what the route delegates
// to, and PGlite (in-memory Postgres, see tests/schema.test.ts) lets them
// run against real SQL semantics with no network.
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { PGlite } from '@electric-sql/pglite';
import { drizzle, type PgliteDatabase } from 'drizzle-orm/pglite';
import { eq } from 'drizzle-orm';
import { readFileSync, readdirSync } from 'node:fs';
import path from 'node:path';
import * as schema from '@/lib/db/schema';
import { generateApiKey } from '@/lib/api-keys';
import { authenticateWebhook, resolveWebhookVehicle } from '@/lib/actions/webhook-core';
import { logOdometerCore, OdometerValidationError } from '@/lib/actions/odometer-core';

let client: PGlite;
let db: PgliteDatabase<typeof schema>;

// Identical migration runner to tests/rollforward.test.ts / tests/schema.test.ts.
function applyMigrations(pglite: PGlite) {
  const migrationsDir = path.resolve(__dirname, '../drizzle');
  const sqlFiles = readdirSync(migrationsDir)
    .filter((f) => f.endsWith('.sql'))
    .sort();

  for (const file of sqlFiles) {
    const raw = readFileSync(path.join(migrationsDir, file), 'utf-8');
    const statements = raw
      .split('--> statement-breakpoint')
      .map((s) => s.trim())
      .filter(Boolean);

    for (const statement of statements) {
      pglite.exec(statement);
    }
  }
}

beforeAll(async () => {
  client = new PGlite();
  applyMigrations(client);
  db = drizzle(client, { schema });
});

afterAll(async () => {
  await client.close();
});

const TENANT = 'org_webhook_test';
const OTHER_TENANT = 'org_webhook_other_tenant';
const SHARED_VIN = '1HGCM82633A004352';

// One real key pair for TENANT, seeded directly into tenantApiKeys (mirrors
// what lib/actions/apiKeys.ts's rotateApiKey would have written).
const { raw: TENANT_RAW_KEY, hash: TENANT_KEY_HASH } = generateApiKey();

let tenantVehicleId: string;

beforeAll(async () => {
  await db.insert(schema.tenantApiKeys).values({ tenantId: TENANT, keyHash: TENANT_KEY_HASH });

  const [tenantVehicle] = await db
    .insert(schema.vehicles)
    .values({ tenantId: TENANT, vin: SHARED_VIN, nickname: 'Tracker Van', decodeSource: 'manual' })
    .returning();
  tenantVehicleId = tenantVehicle.id;

  await db.insert(schema.odometerReadings).values({
    vehicleId: tenantVehicleId,
    tenantId: TENANT,
    readingKm: 12_000,
    source: 'manual',
  });

  // A DIFFERENT tenant with the exact same VIN — this is the fixture the
  // tenant-isolation test below depends on: resolving by VIN must never
  // cross into this tenant's row just because the VIN string matches.
  await db
    .insert(schema.vehicles)
    .values({ tenantId: OTHER_TENANT, vin: SHARED_VIN, nickname: 'Other Tenant Van', decodeSource: 'manual' });
});

describe('authenticateWebhook', () => {
  it('returns null for a missing header', async () => {
    expect(await authenticateWebhook(db, null)).toBeNull();
  });

  it('returns null for a malformed key (wrong shape)', async () => {
    expect(await authenticateWebhook(db, 'not-a-real-key')).toBeNull();
  });

  it('returns null for a well-shaped but unknown key', async () => {
    const { raw: unknownRaw } = generateApiKey(); // never inserted into tenantApiKeys
    expect(await authenticateWebhook(db, unknownRaw)).toBeNull();
  });

  it('returns the tenantId for the correct key', async () => {
    expect(await authenticateWebhook(db, TENANT_RAW_KEY)).toBe(TENANT);
  });
});

describe('resolveWebhookVehicle', () => {
  it('resolves a vehicle by VIN (uppercased) scoped to the tenant', async () => {
    const vehicle = await resolveWebhookVehicle(db, TENANT, { vin: SHARED_VIN.toLowerCase() });
    expect(vehicle?.id).toBe(tenantVehicleId);
  });

  it("resolves a DIFFERENT tenant's own vehicle for the identical VIN — never TENANT's row", async () => {
    // Both TENANT and OTHER_TENANT have a vehicle with the exact same VIN
    // (seeded above). Looking it up scoped to OTHER_TENANT must resolve to
    // OTHER_TENANT's own vehicle, proving the query is scoped by tenantId,
    // not matching on the VIN alone.
    const vehicle = await resolveWebhookVehicle(db, OTHER_TENANT, { vin: SHARED_VIN });
    expect(vehicle?.id).not.toBe(tenantVehicleId);
    expect(vehicle).not.toBeNull();
  });

  it('returns null for a vehicleId that belongs to a different tenant', async () => {
    // Scoped to OTHER_TENANT, resolving by vehicleId belonging to TENANT
    // must find nothing — cross-tenant id guessing is a 404, not a hit.
    const vehicle = await resolveWebhookVehicle(db, OTHER_TENANT, { vehicleId: tenantVehicleId });
    expect(vehicle).toBeNull();
  });

  it('resolves a vehicle by vehicleId scoped to the tenant', async () => {
    const vehicle = await resolveWebhookVehicle(db, TENANT, { vehicleId: tenantVehicleId });
    expect(vehicle?.id).toBe(tenantVehicleId);
  });
});

describe('logOdometerCore with source "tracker"', () => {
  it('rejects a below-latest reading with the shared typed error (the webhook 409 path)', async () => {
    await expect(
      db.transaction(async (tx) => {
        await logOdometerCore(
          tx,
          TENANT,
          { vehicleId: tenantVehicleId, readingKm: 11_000, isCorrection: false, note: null },
          'tracker',
        );
      }),
    ).rejects.toThrow(OdometerValidationError);

    const readings = await db
      .select()
      .from(schema.odometerReadings)
      .where(eq(schema.odometerReadings.vehicleId, tenantVehicleId));
    // Still just the one seeded manual reading — the rejected tracker
    // reading never landed (transaction rolled back).
    expect(readings).toHaveLength(1);
  });

  it('inserts a reading tagged source "tracker" on a happy path', async () => {
    await db.transaction(async (tx) => {
      await logOdometerCore(
        tx,
        TENANT,
        { vehicleId: tenantVehicleId, readingKm: 12_500, isCorrection: false, note: null },
        'tracker',
      );
    });

    const readings = await db
      .select()
      .from(schema.odometerReadings)
      .where(eq(schema.odometerReadings.vehicleId, tenantVehicleId));

    const trackerReading = readings.find((r) => r.readingKm === 12_500);
    expect(trackerReading?.source).toBe('tracker');
    expect(trackerReading?.isCorrection).toBe(false);
  });
});
