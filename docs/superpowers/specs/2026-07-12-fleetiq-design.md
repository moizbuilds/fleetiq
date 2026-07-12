# FleetIQ — Design Spec (2026-07-12)

Fleet maintenance tracker for small businesses, built as a sellable SaaS.
User #1: Moiz, 4 delivery vans in Qatar, real data from day one.

## Product summary

Add a vehicle by VIN → the app decodes it (NHTSA vPIC) → Claude generates a
recommended service schedule (intervals in km AND months, plus brand
suggestions) → the owner logs odometer readings and completed services → the
dashboard answers "what does my fleet need this week" at a glance.

## Stack

| Concern | Choice | Why |
|---|---|---|
| Framework | Next.js 15 App Router + TypeScript | User standard |
| Auth | Clerk (magic-link email, Organizations enabled) | Polished SaaS auth; a garage = an org with staff, no rewrite later |
| DB | Neon serverless Postgres via Drizzle ORM | Postgres we own; Drizzle schema is the single source of truth for DB + TS types |
| Files | Vercel Blob | Vehicle photos + invoice photos |
| AI | Anthropic SDK, `claude-sonnet-5` | Schedule generation + invoice extraction (the only paid calls) |
| Hosting | Vercel → fleetiq.moizbuilds.com | User standard |

## Tenancy (day one)

Every domain table carries `tenant_id` = Clerk organization ID. First sign-in
auto-creates the user's org. Every query filters by the **verified** org from
the Clerk session — never by client-supplied IDs. Server-side lookups that
miss return 404, not 500.

## Data model — RULE: deadlines and thresholds, never countdowns

Persist "next oil change at 78,000 km / by 2026-11-03"; compute "due in
400 km" at render time.

- **vehicles**: id, tenant_id, vin (nullable — manual add supported), nickname,
  plate, photo_url, make, model, year, engine, decode_source
  ('vpic' | 'manual' | 'mixed'), istimara_expiry (date, user-entered),
  fahes_due (date, user-entered), created_at.
- **schedule_items**: id, vehicle_id, tenant_id, name, interval_km (nullable),
  interval_months (nullable, ≥1 of the two required), next_due_km,
  next_due_date, brand_recommendations (text[]), source ('ai' | 'user'),
  timestamps. AI rows always render with the label
  **"AI-recommended — verify against your owner's manual"**; brand suggestions
  labeled "AI suggestions — verify local availability". Never presented as OEM.
- **odometer_readings**: id, vehicle_id, tenant_id, reading_km, recorded_at
  (server-stamped), source ('manual' | 'tracker' | 'service'), is_correction,
  note. Server rejects readings below the latest with a clear message unless
  is_correction ("odometer replaced/corrected") is explicitly set.
- **service_events**: id, vehicle_id, tenant_id, schedule_item_id (nullable —
  null = unscheduled repair), title, odometer_km, performed_on (date),
  cost_qar (numeric), notes, invoice_photo_url, created_at (server-stamped).
- **tenant_api_keys**: hashed API key per tenant for the tracker webhook.
- **ai_usage**: per-tenant call log for DB-backed rate limiting.

**Completing a service is one transaction**: insert service_event + insert an
odometer_reading (source 'service') + roll the linked schedule_item forward
from the ACTUAL odometer/date of service: `next_due_km = actual_km +
interval_km`, `next_due_date = performed_on + interval_months`.

**Due status (computed at render)**: current km = max(odometer_readings).
overdue if threshold passed; due-soon if within 1,000 km or 30 days; else ok.
Istimara/Fahes use the same date logic. Worst item first per vehicle.

## Flows

1. **VIN add**: input VIN → server route proxies vPIC `DecodeVinValues` →
   confirm/correct screen; blank fields (common for non-US vehicles) are
   editable inputs; never block on a perfect decode. Manual add skips decode.
2. **Schedule generation** (paid): vehicle details → Claude → Zod-validated
   JSON (items: name, interval_km, interval_months, brands) → editable review
   table → accept seeds thresholds from current odometer + today.
3. **Odometer quick-entry**: pick vehicle, type number. Typo guard + explicit
   correction override.
4. **Service logging**: mark schedule item done (odometer, date, cost, notes,
   invoice photo) or log unscheduled repair.
5. **Invoice extraction** (paid): upload photo (≤5 MB, type-validated) →
   Claude vision → extracted services/parts/cost/odometer **pre-fill** the
   service form. Never auto-saves.
6. **Tracker webhook**: `POST /api/integrations/odometer` authenticated by
   per-tenant API key; accepts {vin or vehicle_id, reading_km, recorded_at}.
   Live tracker vendor integration is future config, not a rebuild.

## AI endpoints — hard rules

- One SDK client per process, explicit timeout, capped retries; model failures
  surface as 5xx, never faked.
- Parse defensively: find the text block (thinking blocks may precede it);
  tolerate markdown-fenced JSON; Zod-validate everything.
- Rate limit per verified tenant (DB-backed window), input length/size caps.

## Evals (ship with the app)

- `evals/invoice/`: ~15 synthetic Qatar-style garage invoices (HTML rendered →
  screenshots; QAR, mixed print/handwritten odometer) + gold JSON + scoring
  script with normalized matching (punctuation, spacing, numeric formats).
  Real photos replace synthetic ones over time.
- `evals/schedule/`: 5 known vehicles → sanity assertions (oil interval
  5,000–15,000 km, battery has a months interval, every item ≥1 interval,
  disclaimers present).
- Run via `npm run eval:invoice` / `npm run eval:schedule`.

## Design direction

Garage instrument panel, not admin CRUD: dark workshop-industrial surface,
big confident tabular numerals for km figures, red/amber/green as the ONLY
saturated colors. Locked via frontend-design skill before UI code.

## Out of scope (v1)

Live tracker vendor integration; billing/subscriptions; multi-user org
management UI (Clerk provides primitives); Arabic localization.

## Go-live inputs from user

Clerk publishable + secret keys, Neon DATABASE_URL, ANTHROPIC_API_KEY
(reused from qatar-dental-prep), Vercel deploy + DNS records for
fleetiq.moizbuilds.com.
