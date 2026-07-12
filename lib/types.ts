/**
 * Shared contract file — the ONE place API routes, UI components, and eval
 * scripts all import types and validation schemas from.
 *
 * WHY one file instead of redeclaring these per layer: an AI response shape
 * (or a DB column) that's typed independently in the API route, the form
 * component, and the eval script will drift the moment one of them changes
 * — exactly the boundary-contract rule from the project standards. Any
 * task that adds a route or component imports from here instead of writing
 * its own interface.
 *
 * CONCEPT: Zod schemas do double duty — `z.object({...})` both describes a
 * TypeScript type (via `z.infer<...>`) AND validates untrusted data at
 * runtime (`schema.parse(json)` throws if the shape is wrong). That's why
 * these are used for the two places raw, unstructured data enters the app:
 * parsing Claude's JSON output and (in a later task) parsing uploaded
 * invoice extractions. Plain DB rows don't need this — Drizzle's inferred
 * types already guarantee those shapes came from a column definition.
 */
import { z } from 'zod';

// ---------------------------------------------------------------------------
// AI schedule generation (Task 6/7-ish: "AI-recommended" maintenance items)
// ---------------------------------------------------------------------------

// A single generated maintenance item. WHY the refine below instead of just
// making both fields required: a real schedule mixes km-based items (tyre
// rotation) and calendar-based ones (coolant every 24 months regardless of
// mileage) — but an item with NEITHER is meaningless (it could never become
// due), so that combination is rejected here rather than silently stored.
//
// WHY `.positive()` on top of that: 0 or a negative interval is just as
// meaningless as no interval at all — "due every 0km" or "every -6 months"
// can't describe a real maintenance schedule, and would either divide by
// zero or always-be-overdue wherever this feeds a due-date calculation.
// Rejecting it here means a malformed AI response never reaches the DB in
// the first place.
const aiScheduleItemSchema = z
  .object({
    name: z.string(),
    intervalKm: z.number().int().positive().nullable(),
    intervalMonths: z.number().int().positive().nullable(),
    brandRecommendations: z.array(z.string()),
    rationale: z.string(),
  })
  .refine((item) => item.intervalKm !== null || item.intervalMonths !== null, {
    message: 'Each schedule item needs at least one of intervalKm or intervalMonths.',
  });

export const aiScheduleSchema = z.object({
  items: z.array(aiScheduleItemSchema),
});

export type AiSchedule = z.infer<typeof aiScheduleSchema>;
export type AiScheduleItem = z.infer<typeof aiScheduleItemSchema>;

// ---------------------------------------------------------------------------
// AI invoice/receipt extraction (photo of a garage invoice -> prefilled form)
// ---------------------------------------------------------------------------

// WHY `.nonnegative()` on the cost fields but `.positive()` on odometerKm
// below: a cost of exactly 0 QAR is a real thing (a warranty repair, a
// goodwill freebie), so 0 has to stay valid — only a negative cost is
// nonsense. An odometer reading of exactly 0km, on the other hand, would
// mean a brand-new-from-factory car at THIS service event, which never
// happens for a garage invoice; the same z.number().nullable() laxness that
// let 0/negative intervals slip through above applied here too.
const aiInvoiceLineItemSchema = z.object({
  description: z.string(),
  partOrService: z.enum(['part', 'service', 'other']),
  costQar: z.number().nonnegative().nullable(),
});

export const aiInvoiceSchema = z.object({
  garageName: z.string().nullable(),
  serviceDate: z.string().nullable(),
  odometerKm: z.number().positive().nullable(),
  totalCostQar: z.number().nonnegative().nullable(),
  lineItems: z.array(aiInvoiceLineItemSchema),
  // Model's own notes on what it wasn't sure about — surfaced in the UI so
  // the user knows which pre-filled fields to double check before saving.
  confidenceNotes: z.string(),
});

export type AiInvoice = z.infer<typeof aiInvoiceSchema>;
export type AiInvoiceLineItem = z.infer<typeof aiInvoiceLineItemSchema>;

// ---------------------------------------------------------------------------
// vPIC VIN decode result (NHTSA's free VIN-decode API — not an LLM call, so
// no Zod schema needed here: it's a plain DTO shaped by our own code after
// reading the vPIC response, not untrusted model output).
// ---------------------------------------------------------------------------

export interface VinDecodeResult {
  vin: string;
  make: string | null;
  model: string | null;
  year: number | null;
  engine: string | null;
  // Full raw field/value pairs from vPIC, kept for the "mixed" decode case
  // where a user overrides one field but we still want to show what vPIC
  // originally reported.
  raw: Record<string, string>;
}

// ---------------------------------------------------------------------------
// Drizzle-inferred row types, re-exported here so every layer imports types
// from this one file rather than reaching into lib/db/schema.ts directly.
// ---------------------------------------------------------------------------

export type {
  Vehicle,
  ScheduleItem,
  OdometerReading,
  ServiceEvent,
  TenantApiKey,
  AiUsage,
} from './db/schema';
