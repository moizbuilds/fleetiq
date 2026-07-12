# FleetIQ

FleetIQ is a fleet-maintenance dashboard for small operators — a few vans, a
handful of company cars, maybe a mixed fleet with no dedicated ops team —
who need one place to know "what's due, and how urgent is it" without a
spreadsheet. Each vehicle gets a maintenance schedule (AI-drafted from its
make/model/year, then reviewed and edited by a human before it's saved),
tracked against odometer readings and calendar dates, plus Qatar-specific
compliance deadlines (Istimara registration, Fahes inspection). It reads
like an instrument panel on purpose: red/amber/green status lamps, worst-item-first
ordering, tabular-mono numerals for everything you'd glance at on a dashboard.

## Architecture notes (why it's built this way)

These are the load-bearing decisions — read this section if you want to
understand the codebase, not just run it.

**Drizzle schema is the one source of truth for shape.** `lib/db/schema.ts`
defines every table once; both the Postgres migration *and* every
TypeScript type in the app (`Vehicle`, `ScheduleItem`, ...) are derived from
those same definitions (`$inferSelect`). The naive alternative — hand-written
interfaces in the API layer, the UI layer, and the DB layer — drifts the
moment one of the three changes and nobody updates the other two. One
file, three consumers, compile-time enforcement.

**Deadlines are stored; countdowns are computed.** A schedule item's
`nextDueKm`/`nextDueDate` are fixed thresholds written once (at acceptance
time, or rolled forward when a service completes). Nothing in this app ever
stores "3,200 km remaining" or "12 days left" — `lib/status.ts` recomputes
that fresh on every page load from `(threshold, current reading, today)`.
The naive version — storing a countdown — goes stale the instant a day
passes with nobody opening the app; a stored threshold is always correct as
of "now," with no background job needed to keep it in sync.

**External clients and the clock are injected, not reached for.** `getDb()`,
`getAnthropic()`, `checkRateLimit(db, ...)`, and `lib/status.ts`'s
`computeItemStatus(item, currentKm, today)` all take their dependencies as
parameters instead of calling a global singleton internally. This is what
lets `tests/` exercise real business logic — the below-latest-odometer
guard, the rate-limit race condition, a due-date boundary exactly at day 30
— against an in-memory PGlite database and a fixed `today: Date`, with zero
network calls and zero flakiness from "what time is it right now." The
naive alternative (each function calls `getDb()` or `new Date()` itself)
would make every one of those tests either impossible to write or
dependent on a live database and the wall clock.

**Tenancy is an organization, not a user.** Every domain table has a
`tenantId`, resolved from Clerk's *active organization* (`lib/auth.ts`),
not the raw `userId` — a solo user gets an invisible personal organization
auto-provisioned on first sign-in, so a future "share this fleet with a
second person" feature needs no schema change, just a second membership.
Every query filters by this server-verified `tenantId`; a row belonging to
a different tenant is made indistinguishable from a row that doesn't exist
at all (a 404, never a 500 or a leaked "yes, that id exists").

**AI features pre-fill forms; they never auto-save.** Both `/api/ai/schedule`
and `/api/ai/invoice` are pure read/generate endpoints — the AI-drafted
maintenance schedule or extracted invoice fields are shown to the user for
review and editing, and only an explicit "Accept" / "Log service" click
ever writes to the database. Every AI response is Zod-validated (schema in
`lib/types.ts`) and every paid call is rate-limited per tenant
(`lib/rate-limit.ts`) before Claude is ever called.

## Stack

- **Next.js 16** (App Router, Turbopack) — Server Components for reads,
  Server Actions for writes, one Route Handler each for VIN decode and the
  two AI endpoints (they need to be callable from a client-side button
  click after the page has already rendered).
- **Clerk** — authentication + organizations (the tenancy model above).
- **Drizzle ORM over Neon Postgres** — `drizzle-orm/neon-serverless` (the
  WebSocket driver, not the HTTP one) specifically because real
  `db.transaction()` support is needed for the atomic multi-row writes
  (completing a service, accepting a schedule).
- **Anthropic Claude** (`lib/ai/client.ts`) — schedule generation from a
  vehicle's make/model/year, and vision-based invoice-photo extraction.
- **Vercel Blob** — optional invoice/vehicle photo storage (the app runs
  fine without it configured; upload fields hide themselves and AI
  extraction still works, just without a stored photo).
- **Vitest + PGlite** — the whole test suite runs against an in-memory
  Postgres, no live database or network needed.

## Setup

### Prerequisites

- Node.js 20+
- A [Neon](https://neon.tech) Postgres database (free tier is enough)
- A [Clerk](https://clerk.com) application
- An [Anthropic API key](https://console.anthropic.com)
- (Optional) A [Vercel Blob](https://vercel.com/docs/storage/vercel-blob) store, for invoice/vehicle photo uploads

### Environment variables

Copy `.env.example` to `.env.local` and fill in real values:

| Variable | What it's for | Where to get it |
|---|---|---|
| `NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY` | Clerk client-side auth | Clerk dashboard → your app → API Keys |
| `CLERK_SECRET_KEY` | Clerk server-side auth | Same page, "Secret keys" |
| `NEXT_PUBLIC_CLERK_SIGN_IN_URL` | Routes signed-out visitors to FleetIQ's own `/sign-in` page instead of Clerk's generic hosted portal | Set to `/sign-in` (no Clerk dashboard step needed) |
| `DATABASE_URL` | Neon Postgres connection string (pooled) | Neon dashboard → your project → Connection Details |
| `ANTHROPIC_API_KEY` | Claude calls for schedule generation + invoice extraction | Anthropic Console → API Keys |
| `BLOB_READ_WRITE_TOKEN` | Vercel Blob storage for invoice/vehicle photos (optional — app degrades gracefully without it) | Vercel dashboard → Storage → your Blob store → `.env.local` tab |
| `NEXT_PUBLIC_APP_URL` | Public base URL, used for absolute links | `http://localhost:3000` locally; your deployed URL in production |

With only the placeholder values `.env.example` ships, `npm run build`
still succeeds — every secret-reading module (`lib/ai/client.ts`,
`lib/db/index.ts`, `proxy.ts`'s Clerk check) fails closed *at request
time* with a clear error, not at build time, so an unconfigured clone
doesn't block on missing secrets until you actually hit a route that needs
them.

### Install and run

```bash
npm install
cp .env.example .env.local   # then fill in real values above
npm run db:migrate            # applies drizzle/*.sql to your real Neon DATABASE_URL
npm run dev
```

Open [http://localhost:3000](http://localhost:3000). `npm run db:migrate`
needs a real Neon connection string — it will fail loudly (not silently)
against the placeholder value in a fresh `.env.local`.

### Scripts

- `npm run dev` — local dev server
- `npm run build` — production build
- `npm run lint` — ESLint
- `npm run test` — Vitest (PGlite in-memory Postgres, no network — see Testing below)
- `npm run db:generate` — generate a Drizzle migration from `lib/db/schema.ts`
- `npm run db:migrate` — apply pending migrations to `DATABASE_URL`
- `npm run eval:schedule` / `npm run eval:invoice` — AI quality evals (see Evals below)

## Connecting a GPS tracker

FleetIQ's tracker webhook is the ONE endpoint in the app that isn't behind
Clerk sign-in — a tracker device has no browser to sign in with, so it
authenticates with a long-lived API key instead. Generate (or regenerate)
a key from **Settings** in the app; regenerating immediately invalidates
the old one.

- **Endpoint:** `POST /api/integrations/odometer` (e.g.
  `https://<your-deployment>/api/integrations/odometer`)
- **Auth header:** `x-fleetiq-key: <your key>` — missing or wrong returns
  `401`.
- **Body (JSON):**
  ```json
  {
    "vin": "1HGCM82633A004352",
    "readingKm": 84210
  }
  ```
  Send exactly one of `vin` or `vehicleId` (a UUID), never both. An
  optional `recordedAt` (ISO datetime) is accepted but **ignored** — every
  reading is timestamped by the server, never by the device's own clock.
  Trusting a device's clock would let a tracker with a wrong (or
  maliciously backdated) timestamp dodge the below-latest guard below.
- **Below-latest readings are rejected (`409`):** if the reported km is
  lower than the vehicle's last known reading, the request fails instead of
  silently overwriting good data — a tracker glitch (a reset odometer chip,
  a bad GPS unit) must never be able to corrupt a vehicle's mileage
  history. There's no correction path over this endpoint; fix a bad reading
  from the app itself.
- **Unknown vehicle:** `404`. **Oversized body (>10KB):** `413`. **Bad
  shape:** `400` with field-level errors.

Example request:

```bash
curl -X POST https://<your-deployment>/api/integrations/odometer \
  -H "x-fleetiq-key: fiq_xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx" \
  -H "Content-Type: application/json" \
  -d '{"vin": "1HGCM82633A004352", "readingKm": 84210}'
```

## Testing

```bash
npm run test
```

Runs the whole Vitest suite (185 tests across 15 files at last count) —
business logic (`lib/status.ts`'s due-date math, the odometer
below-latest guard, the rate-limit race-condition fix), route-level auth
(`proxy.ts`'s allowlist), Zod schema edge cases, and read queries
(`lib/queries.ts`'s dashboard/cost aggregates) — all against an in-memory
PGlite Postgres, with zero real network calls and zero API costs. Safe to
run on every commit.

**AI evals are separate and cost real money** (they call the actual
Anthropic API), so they're never run automatically — see
[`evals/README.md`](./evals/README.md) for the schedule-generation and
invoice-extraction eval suites, their gold test sets, scoring
methodology, and per-run cost estimates. Both support a free `--selftest`
mode that proves the scoring logic itself works without spending a cent.

## Deploy (Vercel)

1. Push this repo to GitHub and import it in the [Vercel
   dashboard](https://vercel.com/new).
2. Set the same environment variables from the table above in the
   project's **Settings → Environment Variables** (all of them —
   `NEXT_PUBLIC_*` vars need to be set at build time too).
3. Run `npm run db:migrate` once against your production `DATABASE_URL`
   (from your machine, or a one-off Vercel deploy hook) before the first
   deploy serves real traffic — the app expects the schema to already
   exist.
4. Point `fleetiq.moizbuilds.com` at the Vercel deployment: in the
   project's **Settings → Domains**, add `fleetiq.moizbuilds.com`, then add
   the CNAME record Vercel shows you (typically `cname.vercel-dns.com`) at
   your DNS provider for the `moizbuilds.com` zone. Update
   `NEXT_PUBLIC_APP_URL` to `https://fleetiq.moizbuilds.com` once the
   domain is live.
5. In Clerk's dashboard, add the production domain to your instance's
   allowed origins so sign-in works on the real URL, not just localhost.

## What to learn from this codebase

- **Deadlines-not-countdowns** (`lib/status.ts`) is the single idea that
  makes the whole dashboard correct without a background job — anywhere
  you're tempted to store "time remaining," store the deadline instead and
  compute the remaining time on read.
- **Dependency injection** (`getDb()`/`getAnthropic()`/`today: Date` all
  passed as parameters into "core" functions, never called for internally)
  is what makes business logic unit-testable without a live database or
  network — see any `*-core.ts` file next to its Server Action wrapper.
- **Fail closed, not silent** — every secret-reading function
  (`getAnthropic`, `getDb`, the Clerk key check, the webhook's key lookup)
  throws or 401s the moment something required is missing, rather than
  guessing or degrading into a confusing downstream error.
