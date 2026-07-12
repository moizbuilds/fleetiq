/**
 * Demo mode — the single on/off switch that lets FleetIQ boot with NO
 * external services at all: no Clerk account, no Neon database, no
 * Anthropic API key. Every file that needs to behave differently in demo
 * mode imports `isDemoMode()` from here and branches on it — this is the
 * ONE place that decides "are we in demo mode", so no other file ever
 * re-derives the same answer from `process.env` directly (globals.md's
 * one-source-of-truth rule: two independent checks of the same env var are
 * exactly the kind of thing that quietly drifts when one gets edited and
 * the other doesn't).
 *
 * WHY this exists at all: FleetIQ is a portfolio/demo app, and the normal
 * path requires signing up for three separate paid/keyed services before
 * anyone (a recruiter, a LinkedIn viewer, future-Moiz on a new laptop) can
 * even see the dashboard. `FLEETIQ_DEMO=1 npm run dev` swaps Clerk auth for
 * a fixed fake tenant and Neon for a local, file-backed Postgres-in-WASM
 * database (PGlite) pre-loaded with sample data — same UI, same code
 * paths, zero signup friction.
 *
 * WHY an env var instead of, say, a query param or a cookie: an env var is
 * fixed for the whole process (set once, before `next dev`/`next start`
 * boots), so every request — Server Component, Server Action, Route
 * Handler, middleware — sees the exact same answer with no risk of one
 * request accidentally running in demo mode while another doesn't. A
 * request-scoped signal (cookie/header) would be attacker-controlled input
 * (globals.md's trust-boundary rule) for something that decides whether
 * auth even runs at all — far too sensitive a switch to key off anything
 * the client sends.
 */
export function isDemoMode(): boolean {
  return process.env.FLEETIQ_DEMO === '1';
}

// Fixed fake identity used everywhere demo mode short-circuits real
// auth/tenant resolution (lib/auth.ts) — every seeded row in lib/demo-seed.ts
// is scoped to this exact tenantId, so the two files can never drift on
// "which tenant does the demo data belong to".
export const DEMO_TENANT_ID = 'demo-tenant';
export const DEMO_USER_ID = 'demo-user';
