# FleetIQ

Fleet-maintenance SaaS: vehicles, odometer readings, and service intervals
tracked like an instrument panel. Built with Next.js (App Router), Clerk
auth, Drizzle ORM over Neon Postgres, and Claude for schedule/receipt
extraction.

See `.superpowers/sdd/globals.md` for the binding design system and data
constraints, and `docs/superpowers/specs/` / `docs/superpowers/plans/` for
the full spec and build plan.

## Getting started

```bash
npm install
cp .env.example .env.local   # then fill in real values
npm run dev
```

Open [http://localhost:3000](http://localhost:3000). Sign-in requires a
real Clerk publishable/secret key pair — with the placeholder values from
`.env.example`, `npm run build` succeeds but pages that touch Clerk will
error at request time until real keys are set.

## Scripts

- `npm run dev` — local dev server
- `npm run build` — production build
- `npm run lint` — ESLint
- `npm run test` — Vitest (`--passWithNoTests` until the first test lands)
- `npm run db:generate` — generate a Drizzle migration from `lib/db/schema.ts`
- `npm run db:migrate` — apply pending migrations to `DATABASE_URL`

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

A full setup guide, env var table, and architecture notes land in a later
task's README rewrite.
