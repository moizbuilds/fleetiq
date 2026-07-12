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
import { isValidVin } from './vin';
import type { ItemStatus } from './status';
import type { Vehicle, ScheduleItem } from './db/schema';

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
// WHY every field below got an upper bound (review round 1, finding #2)
// even though a well-behaved Claude response would never hit them: this
// schema is the ONE gate between raw model output and both (a) what
// `app/api/ai/schedule/route.ts` hands back to the browser and (b) what
// `lib/actions/schedule.ts`'s `acceptSchedule` re-validates before writing
// to Postgres. A single AI response can't blow past these caps on its own,
// but nothing stopped a runaway/misbehaving model call — or a client
// hand-crafting the `acceptSchedule` request body directly, since that
// server action is a real reachable endpoint — from sending an
// arbitrarily large payload. Bounds are set generously above any real
// schedule (30 items, 5 brands, 60-char name/brand strings, 300-char
// rationale, 100,000km / 120-month intervals) so a legitimate response
// never brushes against them; they exist purely to reject the pathological
// case, not to constrain a real one.
const aiScheduleItemSchema = z
  .object({
    // 60 is the same cap `lib/actions/schedule.ts` used to enforce with a
    // second, hand-rolled length check after this schema's `.safeParse()`
    // already ran — moving the cap into the schema itself means "how long
    // can a schedule item's name be" is answered in exactly one place, so
    // the route (validating a fresh AI response) and the server action
    // (re-validating a client-edited one) can never drift out of sync.
    name: z.string().trim().min(1).max(60),
    intervalKm: z.number().int().positive().max(100_000).nullable(),
    intervalMonths: z.number().int().positive().max(120).nullable(),
    brandRecommendations: z.array(z.string().trim().min(1).max(60)).max(5),
    rationale: z.string().max(300),
  })
  .refine((item) => item.intervalKm !== null || item.intervalMonths !== null, {
    message: 'Each schedule item needs at least one of intervalKm or intervalMonths.',
  });

export const aiScheduleSchema = z.object({
  items: z.array(aiScheduleItemSchema).max(30),
});

export type AiSchedule = z.infer<typeof aiScheduleSchema>;
export type AiScheduleItem = z.infer<typeof aiScheduleItemSchema>;

// globals.md's exact required wording for any AI-generated schedule item —
// "Never 'OEM schedule'". WHY this needs to be a shared constant rather than
// the sentence typed once in components/ScheduleReview.tsx (the full
// disclaimer banner) and again in components/ScheduleItemRow.tsx (the same
// sentence, shortened into a `title` tooltip on each AI-sourced row): two
// hand-typed copies of a compliance-sensitive exact string is precisely the
// one-source-of-truth drift globals.md warns about — a future wording tweak
// applied to one copy and forgotten on the other would leave one of the two
// surfaces silently out of compliance with the required phrasing.
export const AI_SCHEDULE_DISCLAIMER = "AI-recommended — verify against your owner's manual.";

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
//
// WHY every string/array field below got a max() bound (same reasoning as
// aiScheduleItemSchema's bounds above): a well-behaved response never
// brushes against these, but nothing else stops a misbehaving model call
// from returning a pathologically long field. Bounds are generous relative
// to a real invoice (a Qatar garage receipt has a handful of line items,
// not hundreds) so they only ever reject the pathological case.
const aiInvoiceLineItemSchema = z.object({
  description: z.string().max(300),
  partOrService: z.enum(['part', 'service', 'other']),
  costQar: z.number().nonnegative().nullable(),
});

export const aiInvoiceSchema = z.object({
  garageName: z.string().max(200).nullable(),
  // Deliberately NOT regex-validated to YYYY-MM-DD here: rejecting the
  // WHOLE extraction over one oddly-formatted date would throw away a
  // correctly-read cost/odometer/lineItems alongside it (globals.md's
  // "never fabricate" cuts both ways — a partial real result beats no
  // result at all). components/ServiceForm.tsx checks this string's shape
  // itself before using it to pre-fill a native `<input type="date">`, and
  // leaves that field untouched if it doesn't match — the max() bound below
  // still rejects pathologically long garbage.
  serviceDate: z.string().max(40).nullable(),
  odometerKm: z.number().positive().nullable(),
  totalCostQar: z.number().nonnegative().nullable(),
  lineItems: z.array(aiInvoiceLineItemSchema).max(50),
  // Model's own notes on what it wasn't sure about — surfaced in the UI so
  // the user knows which pre-filled fields to double check before saving.
  confidenceNotes: z.string().max(500),
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
// UUID shape check — shared by every route/page that reads a vehicle (or
// other row) id straight out of a URL segment or a request body. WHY this
// needs to be one shared function instead of a regex copy-pasted at each
// call site: `vehicles.id` is a Postgres `uuid` column, so handing a
// non-UUID string straight to `eq()` makes Postgres itself throw an
// "invalid input syntax for type uuid" error — an opaque 500 instead of the
// clean 404 a well-formed but nonexistent id gets. Both app/vehicles/[id]/
// page.tsx and app/api/ai/schedule/route.ts need this exact same guard
// before ever touching the database; keeping it in one place means a future
// third call site can't accidentally use a looser (or stricter) check.
// ---------------------------------------------------------------------------
const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export function isValidUuid(id: string): boolean {
  return UUID_PATTERN.test(id);
}

// ---------------------------------------------------------------------------
// Vehicle creation (Task 4: VIN decode + manual add form) — validated
// server-side in lib/actions/vehicles.ts's createVehicle server action. The
// form component (components/VehicleForm.tsx) blocks obviously-bad input
// client-side too (e.g. a malformed VIN, a year outside the picker's range)
// purely for a faster feedback loop — this schema is the one place that
// ACTUALLY enforces the rule, since a client check alone can be bypassed by
// POSTing to the server action directly.
//
// A plain `YYYY-MM-DD` regex (not z.iso.date() / a full calendar-validity
// check) is enough here: these are user-typed compliance deadlines from a
// native `<input type="date">`, which only ever emits that exact format or
// an empty string — there's no untrusted free-text path that could send
// "2026-13-45" through this schema in practice.
// Exported (not just used below) so lib/actions/vehicles.ts's
// updateComplianceDates schema (Task 8's inline compliance-date editor) can
// reuse the exact same YYYY-MM-DD-or-null shape instead of a second regex
// that could drift from this one.
export const compareDateString = z
  .string()
  .regex(/^\d{4}-\d{2}-\d{2}$/, 'Date must be in YYYY-MM-DD format.')
  .nullable();

// A `YYYY-MM-DD` string, required (not nullable) — the shape every
// user-entered SERVICE date takes (as opposed to `compareDateString` above,
// which is nullable because a compliance deadline can be genuinely unset).
const requiredDateString = z
  .string()
  .regex(/^\d{4}-\d{2}-\d{2}$/, 'Date must be in YYYY-MM-DD format.');

// 2,000,000 km is a generous real-world ceiling (far beyond any
// passenger/light-commercial vehicle's realistic lifetime odometer) — it
// exists only to catch a fat-fingered extra digit, not to constrain a
// genuine high-mileage fleet vehicle. WHY a shared constant instead of the
// literal repeated in createVehicleInputSchema, logOdometerInputSchema, and
// completeServiceInputSchema below: three copies of "2,000,000" is the
// exact one-source-of-truth drift globals.md warns about — bump this once
// here and every km bound in the app moves together.
export const MAX_ODOMETER_KM = 2_000_000;

// Same one-source-of-truth reasoning as MAX_ODOMETER_KM above: this cap is
// enforced here (completeServiceInputSchema, below) AND used by Task 7's
// lib/ai/invoice.ts to truncate its AI-generated notes summary BEFORE it
// ever reaches this schema — a shared constant means those two call sites
// can't quietly drift to different limits.
export const MAX_SERVICE_NOTES_LENGTH = 1000;

export const createVehicleInputSchema = z.object({
  nickname: z.string().trim().min(1, 'Nickname is required.').max(80),
  vin: z
    .string()
    .nullable()
    .refine((v) => v === null || isValidVin(v), {
      message: 'VIN must be 17 characters (letters and numbers, excluding I, O, Q).',
    }),
  plate: z.string().max(20).nullable(),
  make: z.string().max(80).nullable(),
  model: z.string().max(80).nullable(),
  engine: z.string().max(80).nullable(),
  // 1950 covers any vehicle old enough to plausibly still be on the road;
  // 2035 caps out a few model-years ahead of "today" the way dealerships
  // sell next-year models early — both bounds exist so a typo (e.g. "202" or
  // "20206") gets rejected instead of silently stored.
  year: z.number().int().min(1950).max(2035).nullable(),
  istimaraExpiry: compareDateString,
  fahesDue: compareDateString,
  decodeSource: z.enum(['vpic', 'manual', 'mixed']),
  initialOdometerKm: z.number().int().positive().max(MAX_ODOMETER_KM).nullable(),
});

export type CreateVehicleInput = z.infer<typeof createVehicleInputSchema>;

// ---------------------------------------------------------------------------
// Compliance date edit (Task 8) — validated server-side in lib/actions/
// vehicles.ts's updateComplianceDates server action, reached from the
// vehicle detail page's inline compliance editor
// (components/ComplianceSection.tsx). Reuses compareDateString (the exact
// same nullable-YYYY-MM-DD shape createVehicleInputSchema already enforces
// for these same two columns) rather than a second copy of the regex.
// ---------------------------------------------------------------------------
export const updateComplianceDatesInputSchema = z.object({
  vehicleId: z.string().refine(isValidUuid, { message: 'Vehicle not found.' }),
  istimaraExpiry: compareDateString,
  fahesDue: compareDateString,
});

export type UpdateComplianceDatesInput = z.infer<typeof updateComplianceDatesInputSchema>;

// ---------------------------------------------------------------------------
// Schedule item interval edit (fix round 1, item 4 — deferred from Task 8)
// — validated server-side in lib/actions/schedule.ts's updateScheduleItem
// server action, reached from the vehicle detail page's inline "Edit"
// toggle on each schedule row (components/ScheduleItemRow.tsx). Same
// km/months bounds as aiScheduleItemSchema above (100,000km / 120 months,
// each `.positive()` for the same "0 or negative isn't a real interval"
// reasoning) — a user hand-editing an interval is exactly as unable to
// describe a real maintenance schedule with "every 0km" as an AI response
// is, so the same ceiling applies to a human-typed value.
// ---------------------------------------------------------------------------
export const updateScheduleItemInputSchema = z
  .object({
    scheduleItemId: z.string().refine(isValidUuid, { message: 'Schedule item not found.' }),
    intervalKm: z.number().int().positive().max(100_000).nullable(),
    intervalMonths: z.number().int().positive().max(120).nullable(),
  })
  .refine((v) => v.intervalKm !== null || v.intervalMonths !== null, {
    message: 'Set at least one of interval km or interval months.',
    path: ['intervalKm'],
  });

export type UpdateScheduleItemInput = z.infer<typeof updateScheduleItemInputSchema>;

// ---------------------------------------------------------------------------
// Odometer log (Task 6) — validated server-side in lib/actions/odometer.ts's
// logOdometer server action, before it ever opens a db.transaction(). This
// schema only enforces SHAPE/bounds (a malformed vehicleId, a NaN/negative/
// too-large reading, a note that's too long) — the "is this reading below
// the vehicle's last one" business rule needs a DB read to answer, so it
// lives in logOdometerCore instead (see that file's header for why).
// ---------------------------------------------------------------------------
export const logOdometerInputSchema = z.object({
  vehicleId: z.string().refine(isValidUuid, { message: 'Vehicle not found.' }),
  readingKm: z.number().int().positive().max(MAX_ODOMETER_KM),
  isCorrection: z.boolean(),
  // Corrections REQUIRE a non-empty note (enforced in logOdometerCore,
  // where it can be checked alongside isCorrection — a schema-level
  // .refine() here would have to re-read isCorrection anyway, so keeping
  // both halves of that one rule together avoids splitting it across two
  // files).
  note: z.string().trim().max(300).nullable(),
});

export type LogOdometerInput = z.infer<typeof logOdometerInputSchema>;

// ---------------------------------------------------------------------------
// Service completion (Task 6) — validated server-side in lib/actions/
// services.ts's completeService server action, same "shape here, DB-backed
// business rules in the core function" split as logOdometerInputSchema
// above.
// ---------------------------------------------------------------------------
export const completeServiceInputSchema = z
  .object({
    vehicleId: z.string().refine(isValidUuid, { message: 'Vehicle not found.' }),
    scheduleItemId: z.string().refine(isValidUuid, { message: 'Schedule item not found.' }).nullable(),
    // Required for an unscheduled repair (scheduleItemId === null, enforced
    // by the .refine() below); for a scheduled item, a blank title defaults
    // server-side to the item's own name (lib/actions/services.ts) — this
    // schema alone can't look that name up, so it only enforces "non-blank
    // IF present" here.
    title: z.string().trim().min(1).max(80).nullable(),
    odometerKm: z.number().int().positive().max(MAX_ODOMETER_KM),
    performedOn: requiredDateString,
    costQar: z.number().nonnegative().max(1_000_000).nullable(),
    notes: z.string().trim().max(MAX_SERVICE_NOTES_LENGTH).nullable(),
    invoicePhotoUrl: z.string().url().nullable(),
  })
  .refine((v) => v.scheduleItemId !== null || v.title !== null, {
    message: 'Title is required for an unscheduled repair.',
    path: ['title'],
  });

export type CompleteServiceInput = z.infer<typeof completeServiceInputSchema>;

// ---------------------------------------------------------------------------
// Tracker webhook body (Task 9) — validated in
// app/api/integrations/odometer/route.ts, the ONE endpoint in FleetIQ a
// third-party device (a GPS tracker) calls directly instead of a signed-in
// browser (see proxy.ts's allowlist and lib/api-keys.ts for how that
// endpoint authenticates a caller with no Clerk session at all).
//
// WHY exactly one of vin/vehicleId, enforced by the refine below: a tracker
// device identifies "which vehicle is this" however its own integration was
// configured — some send the VIN they read off the OBD-II port, others are
// paired to a vehicleId at setup time. Accepting both fields but requiring
// exactly one (not "at least one", not "both must match") means the route
// never has to reconcile two different identifiers disagreeing about which
// vehicle a reading belongs to.
//
// WHY `recordedAt` is accepted here at all, given the route IGNORES it
// (app/api/integrations/odometer/route.ts server-stamps every reading
// instead): rejecting the field outright would break any tracker
// integration that already sends a timestamp by convention — accepting and
// silently ignoring it is more compatible than a 400 for a field this
// schema was never going to use in the first place. See the route's own
// comment for why device clocks aren't trusted (the same "trust boundary"
// reasoning globals.md calls out for the deadline-storage rule: a device
// clock that's wrong, or an attacker who controls the request, could
// otherwise backdate a reading past the below-latest guard).
//
// WHY `recordedAt` is only shape-capped (`.max(40)`), not strictly
// ISO-datetime-validated: the SAME reasoning as lib/types.ts's own
// aiInvoiceSchema.serviceDate above — rejecting an otherwise-valid request
// over the exact formatting of a field this route never reads would be
// pure friction for an integrator, not a real safety boundary. The length
// cap alone still rejects pathologically long garbage.
export const webhookOdometerSchema = z
  .object({
    vin: z
      .string()
      .trim()
      .refine((v) => isValidVin(v), {
        message: 'VIN must be 17 characters (letters and numbers, excluding I, O, Q).',
      })
      .optional(),
    vehicleId: z.string().refine(isValidUuid, { message: 'vehicleId must be a valid id.' }).optional(),
    readingKm: z.number().int().positive().max(MAX_ODOMETER_KM),
    recordedAt: z.string().max(40).optional(),
  })
  .refine((v) => (v.vin !== undefined) !== (v.vehicleId !== undefined), {
    message: 'Provide exactly one of vin or vehicleId.',
    path: ['vin'],
  });

export type WebhookOdometerInput = z.infer<typeof webhookOdometerSchema>;

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

// ---------------------------------------------------------------------------
// Due-status engine (Task 3): the shared status shape every vehicle/schedule
// row is turned into at render time. Re-exported here (rather than having
// UI components import from lib/status directly) so the "shared contract in
// one file" rule holds even though the computation itself lives in its own
// module — see lib/status.ts for the functions that produce this shape.
// ---------------------------------------------------------------------------
export type { ItemStatus, ItemState, DueThresholds, IntervalThresholds } from './status';

// ---------------------------------------------------------------------------
// Dashboard + vehicle detail DTOs (Task 8) — the shared contract between
// lib/queries.ts (which composes them from vehicles + schedule_items +
// odometer_readings + service_events, running lib/status.ts's compute
// functions over the raw rows) and the Server Components that render them
// (app/page.tsx, app/vehicles/[id]/page.tsx) plus the presentational
// components underneath (VehicleRow, StatusPill, IntervalGauge, ...). WHY a
// DTO instead of handing raw Drizzle rows to the page: a dashboard row's
// "worst item" and its due-status are a real computation (worstFirst over
// computeItemStatus/computeComplianceStatus), not a column — defining that
// computed shape once here means the query layer and every component that
// reads it agree on exactly what fields exist, instead of each page
// re-deriving (and risking re-implementing slightly differently) the same
// worst-item logic inline.
// ---------------------------------------------------------------------------
// One schedule item OR compliance pseudo-item (Istimara/Fahes), already
// reduced to its display status. `id` is a real scheduleItems.id for a
// schedule item, or the literal 'istimara'/'fahes' for a compliance
// pseudo-item — there's no separate DB row for those, so a real UUID would
// be misleading.
export interface RankedStatusItem {
  id: string;
  name: string;
  status: ItemStatus;
  intervalConsumedPct: number | null;
}

export interface FleetVehicleStatus {
  id: string;
  nickname: string;
  plate: string | null;
  make: string | null;
  model: string | null;
  year: number | null;
  latestReadingKm: number | null;
  // Every non-ok schedule/compliance item, worst-first (lib/status.ts's
  // worstFirst) — VehicleRow renders items[0] as the headline and the rest
  // as its annunciator lamp strip (capped at 5, "+N" overflow).
  items: RankedStatusItem[];
  // items[0]'s status, or a synthesized no_data status when the vehicle has
  // no schedule items and no compliance dates set at all (nothing tracked
  // yet, not literally "ok").
  worst: ItemStatus;
}

export interface VehicleDetail {
  vehicle: Vehicle;
  latestReadingKm: number | null;
  // Worst-first, same ranking as the dashboard's per-vehicle item list, but
  // WITHOUT the compliance pseudo-items mixed in — the detail page shows
  // Istimara/Fahes in their own dedicated compliance section instead.
  scheduleItems: { item: ScheduleItem; status: ItemStatus; intervalConsumedPct: number | null }[];
  compliance: {
    istimara: ItemStatus;
    fahes: ItemStatus;
  };
  // Newest-first service history, one row per service_events row, joined
  // with the schedule item it completed (null for an unscheduled repair).
  history: {
    id: string;
    title: string;
    performedOn: string;
    odometerKm: number;
    costQar: string | null; // numeric column, read as string (globals.md)
    notes: string | null;
    invoicePhotoUrl: string | null;
    scheduleItemName: string | null;
  }[];
  costs: {
    totalsByYear: { year: number; totalQar: string }[];
    // total cost (all cost-bearing services, all-time) ÷ (max reading − min
    // reading) — null when the vehicle has fewer than 2 odometer readings
    // or its reading span is 0 (can't divide by zero km of driving).
    // Computed fresh on every read, never stored (globals.md).
    costPerKm: number | null;
    // Denominator/caption inputs for costPerKm's "derived from X services
    // over Y km" UI caption — both null-safe the same way costPerKm is.
    serviceCount: number;
    distanceKm: number | null;
  };
}
