// Drizzle schema — the single source of truth for DB shape AND TypeScript types.
// WHY: API, UI and DB all import types inferred from here, so a column change
// propagates everywhere at compile time (the naive alternative — hand-written
// interfaces per layer — drifts silently).
//
// CONCEPT: Drizzle is a "TypeScript-first" ORM (Object-Relational Mapper) — the
// table definitions below both (a) generate the SQL migration files under
// drizzle/ and (b) produce TypeScript types via $inferSelect, so the shape of
// a row in Postgres and the shape of the object in your code can never drift
// apart silently.
import { pgTable, text, integer, numeric, boolean, date, timestamp, uuid, index } from 'drizzle-orm/pg-core';

export const vehicles = pgTable('vehicles', {
  id: uuid('id').primaryKey().defaultRandom(),
  tenantId: text('tenant_id').notNull(),
  vin: text('vin'),                       // nullable: manual add supported
  nickname: text('nickname').notNull(),
  plate: text('plate'),
  photoUrl: text('photo_url'),
  make: text('make'), model: text('model'),
  year: integer('year'), engine: text('engine'),
  decodeSource: text('decode_source', { enum: ['vpic', 'manual', 'mixed'] }).notNull(),
  istimaraExpiry: date('istimara_expiry'),  // user-entered compliance deadlines
  fahesDue: date('fahes_due'),
  createdAt: timestamp('created_at').notNull().defaultNow(),
}, (t) => [index('vehicles_tenant_idx').on(t.tenantId)]);

export const scheduleItems = pgTable('schedule_items', {
  id: uuid('id').primaryKey().defaultRandom(),
  vehicleId: uuid('vehicle_id').notNull().references(() => vehicles.id, { onDelete: 'cascade' }),
  tenantId: text('tenant_id').notNull(),
  name: text('name').notNull(),
  intervalKm: integer('interval_km'),          // at least one of km/months enforced in app layer
  intervalMonths: integer('interval_months'),
  nextDueKm: integer('next_due_km'),           // THRESHOLDS, never countdowns
  nextDueDate: date('next_due_date'),
  brandRecommendations: text('brand_recommendations').array().notNull().default([]),
  source: text('source', { enum: ['ai', 'user'] }).notNull(),
  createdAt: timestamp('created_at').notNull().defaultNow(),
  updatedAt: timestamp('updated_at').notNull().defaultNow(),
}, (t) => [index('schedule_items_vehicle_idx').on(t.vehicleId)]);

export const odometerReadings = pgTable('odometer_readings', {
  id: uuid('id').primaryKey().defaultRandom(),
  vehicleId: uuid('vehicle_id').notNull().references(() => vehicles.id, { onDelete: 'cascade' }),
  tenantId: text('tenant_id').notNull(),
  readingKm: integer('reading_km').notNull(),
  recordedAt: timestamp('recorded_at').notNull().defaultNow(),  // server-stamped
  source: text('source', { enum: ['manual', 'tracker', 'service'] }).notNull(),
  isCorrection: boolean('is_correction').notNull().default(false),
  note: text('note'),
}, (t) => [index('odo_vehicle_idx').on(t.vehicleId)]);

export const serviceEvents = pgTable('service_events', {
  id: uuid('id').primaryKey().defaultRandom(),
  vehicleId: uuid('vehicle_id').notNull().references(() => vehicles.id, { onDelete: 'cascade' }),
  tenantId: text('tenant_id').notNull(),
  scheduleItemId: uuid('schedule_item_id').references(() => scheduleItems.id, { onDelete: 'set null' }), // null = unscheduled repair
  title: text('title').notNull(),
  odometerKm: integer('odometer_km').notNull(),
  performedOn: date('performed_on').notNull(),   // user-entered service date
  costQar: numeric('cost_qar', { precision: 10, scale: 2 }),
  notes: text('notes'),
  invoicePhotoUrl: text('invoice_photo_url'),
  createdAt: timestamp('created_at').notNull().defaultNow(),  // server-stamped
}, (t) => [index('service_vehicle_idx').on(t.vehicleId)]);

export const tenantApiKeys = pgTable('tenant_api_keys', {
  id: uuid('id').primaryKey().defaultRandom(),
  tenantId: text('tenant_id').notNull().unique(),
  keyHash: text('key_hash').notNull(),           // sha256 — raw key shown once
  createdAt: timestamp('created_at').notNull().defaultNow(),
});

export const aiUsage = pgTable('ai_usage', {
  id: uuid('id').primaryKey().defaultRandom(),
  tenantId: text('tenant_id').notNull(),
  endpoint: text('endpoint', { enum: ['schedule', 'invoice'] }).notNull(),
  createdAt: timestamp('created_at').notNull().defaultNow(),
}, (t) => [index('ai_usage_tenant_time_idx').on(t.tenantId, t.createdAt)]);

export type Vehicle = typeof vehicles.$inferSelect;
export type ScheduleItem = typeof scheduleItems.$inferSelect;
export type OdometerReading = typeof odometerReadings.$inferSelect;
export type ServiceEvent = typeof serviceEvents.$inferSelect;
export type TenantApiKey = typeof tenantApiKeys.$inferSelect;
export type AiUsage = typeof aiUsage.$inferSelect;
