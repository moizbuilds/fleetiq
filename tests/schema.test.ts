// Migration smoke test for lib/db/schema.ts.
//
// WHY PGlite instead of a real Postgres connection: this test must run in
// CI and on any contributor's machine without a live Neon database or
// credentials — PGlite is Postgres compiled to WebAssembly, so it runs a
// real Postgres engine in-process, in memory, with no network or Docker
// dependency. It's dev-only (see package.json), never used in production.
//
// This test proves two things that a pure type-check can't: (1) the SQL
// drizzle-kit generated from schema.ts is actually valid and creates the
// tables, and (2) a row written through the schema's TypeScript shape reads
// back with the right values (uuid/text/integer/array columns round-trip
// correctly).
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { PGlite } from '@electric-sql/pglite';
import { drizzle, type PgliteDatabase } from 'drizzle-orm/pglite';
import { eq } from 'drizzle-orm';
import { readFileSync, readdirSync } from 'node:fs';
import path from 'node:path';
import * as schema from '@/lib/db/schema';

let client: PGlite;
let db: PgliteDatabase<typeof schema>;

// Applies every generated migration file to the in-memory database.
//
// WHY split manually on drizzle's own breakpoint marker instead of using
// drizzle-kit's built-in pglite migrator: the manual approach has no
// dependency on the migrator's journal-file bookkeeping, so this test
// only trusts the one artifact every environment (dev, CI, prod) actually
// runs from — the raw .sql files themselves.
function applyMigrations(pglite: PGlite) {
  const migrationsDir = path.resolve(__dirname, '../drizzle');
  const sqlFiles = readdirSync(migrationsDir)
    .filter((f) => f.endsWith('.sql'))
    .sort(); // filenames are numerically prefixed (0000_, 0001_, ...) so lexical sort is chronological

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

describe('schema migration + round-trip', () => {
  it('inserts and reads back a vehicle', async () => {
    const [vehicle] = await db
      .insert(schema.vehicles)
      .values({
        tenantId: 'org_test123',
        nickname: 'The Beast',
        vin: '1HGCM82633A004352',
        make: 'Toyota',
        model: 'Land Cruiser',
        year: 2019,
        decodeSource: 'vpic',
      })
      .returning();

    expect(vehicle.id).toBeTypeOf('string');
    expect(vehicle.tenantId).toBe('org_test123');
    expect(vehicle.nickname).toBe('The Beast');
    expect(vehicle.vin).toBe('1HGCM82633A004352');
    expect(vehicle.make).toBe('Toyota');
    expect(vehicle.year).toBe(2019);
    expect(vehicle.decodeSource).toBe('vpic');
    expect(vehicle.createdAt).toBeInstanceOf(Date);

    const [found] = await db
      .select()
      .from(schema.vehicles)
      .where(eq(schema.vehicles.id, vehicle.id));

    expect(found).toBeDefined();
    expect(found.nickname).toBe('The Beast');
  });

  it('inserts and reads back a schedule item tied to a vehicle', async () => {
    const [vehicle] = await db
      .insert(schema.vehicles)
      .values({
        tenantId: 'org_test123',
        nickname: 'Runabout',
        decodeSource: 'manual',
      })
      .returning();

    const [item] = await db
      .insert(schema.scheduleItems)
      .values({
        vehicleId: vehicle.id,
        tenantId: 'org_test123',
        name: 'Oil change',
        intervalKm: 10000,
        intervalMonths: 6,
        brandRecommendations: ['Castrol', 'Mobil 1'],
        source: 'ai',
      })
      .returning();

    expect(item.id).toBeTypeOf('string');
    expect(item.vehicleId).toBe(vehicle.id);
    expect(item.name).toBe('Oil change');
    expect(item.intervalKm).toBe(10000);
    expect(item.intervalMonths).toBe(6);
    expect(item.brandRecommendations).toEqual(['Castrol', 'Mobil 1']);
    expect(item.source).toBe('ai');

    const rows = await db
      .select()
      .from(schema.scheduleItems)
      .where(eq(schema.scheduleItems.vehicleId, vehicle.id));

    expect(rows).toHaveLength(1);
    expect(rows[0].name).toBe('Oil change');
  });
});
