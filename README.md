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
