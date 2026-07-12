# FleetIQ — Go-Live Runbook

The app is code-complete and the production build passes. Going live is now a
credentials-and-config job. Do these five steps in order — about 10 minutes.

## 1. Create the database (Neon)

1. At [neon.tech](https://neon.tech) create a project (region: pick the one
   nearest Qatar, e.g. AWS `me-central-1` or `eu-central-1`).
2. Copy the **pooled** connection string (looks like
   `postgresql://user:pass@ep-xxx-pooler.region.aws.neon.tech/neondb?sslmode=require`).
3. Run the migration from your machine (creates all six tables):
   ```bash
   DATABASE_URL="<your-neon-pooled-url>" npm run db:migrate
   ```
   You should see the `0000_outgoing_power_pack` migration apply cleanly.

## 2. Get the other keys

| Key | Where | Notes |
|-----|-------|-------|
| `NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY` / `CLERK_SECRET_KEY` | [dashboard.clerk.com](https://dashboard.clerk.com) → new app → API Keys | **Enable Organizations** in the Clerk app (Configure → Organizations). The app auto-provisions a "My Fleet" org per user. |
| `ANTHROPIC_API_KEY` | [console.anthropic.com](https://console.anthropic.com) | Reuse your existing key from qatar-dental-prep if you want one bill. |
| `BLOB_READ_WRITE_TOKEN` | Vercel → Storage → create a Blob store → tokens | Optional. Without it, vehicle/invoice photos just aren't stored; AI invoice scanning still works. |
| `NEXT_PUBLIC_APP_URL` | `https://fleetiq.moizbuilds.com` | Used in the tracker webhook docs shown on the Settings page. |
| `NEXT_PUBLIC_CLERK_SIGN_IN_URL` | `/sign-in` | So Clerk redirects to the themed in-app sign-in, not its hosted portal. |

## 3. Deploy to Vercel — on the account that owns moizbuilds.com

> The Vercel account currently connected to Claude ("moizrana-3582's projects")
> is **not** the one holding `moizbuilds.com`, so deploy from the right one.

Fastest path — Vercel CLI from this directory:
```bash
cd ~/"30 in 30 apps/fleetiq"
vercel login          # use the account that has moizbuilds.com
vercel link           # create a new project "fleetiq"
vercel --prod
```
Or push this repo to GitHub and "Import Project" on that Vercel account.

## 4. Set the env vars in Vercel

Project → Settings → Environment Variables → add every row from step 2 for the
**Production** environment. Then redeploy (Vercel → Deployments → Redeploy) so
they take effect. Until they're set, every page shows the built-in "Add your
keys" setup notice by design (it fails closed, never a broken page).

## 5. Wire the subdomain

1. Vercel → fleetiq project → Settings → Domains → add `fleetiq.moizbuilds.com`.
2. Vercel shows a **CNAME** target (typically `cname.vercel-dns.com`).
3. In the Vercel account/DNS that manages `moizbuilds.com`, add:
   ```
   Type: CNAME   Name: fleetiq   Value: cname.vercel-dns.com
   ```
4. Wait for propagation; Vercel auto-issues the TLS cert.

## After go-live: run the evals (the last honesty step)

With `ANTHROPIC_API_KEY` set locally:
```bash
ANTHROPIC_API_KEY="sk-ant-..." npm run eval:schedule   # 5 vehicles, sanity assertions
ANTHROPIC_API_KEY="sk-ant-..." npm run eval:invoice     # 15 invoices, per-field accuracy
```
Paste the real per-field accuracy numbers into `evals/README.md` under a new
"Eval results" table — that's the one step that proves the AI quality claim with
real numbers rather than a scorer self-test.

## Smoke test the live app (5 minutes)

1. Sign in → a "My Fleet" org is created automatically.
2. Add a vehicle by VIN (try a real van VIN) → confirm the decode → generate the
   AI schedule → accept it.
3. Log an odometer reading; try a lower number → the typo guard should block it.
4. Mark a service done → the schedule threshold rolls forward from the actual km.
5. Dashboard shows the vehicle with worst-item-first status.
6. Settings → generate a tracker API key → test the webhook:
   ```bash
   curl -X POST https://fleetiq.moizbuilds.com/api/integrations/odometer \
     -H "x-fleetiq-key: <the-key>" -H "content-type: application/json" \
     -d '{"vin":"<your-vin>","readingKm":54210}'
   ```
   A rotated/old key must return 401.
