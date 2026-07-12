/**
 * Setup notice — shown instead of the whole app when required env vars
 * are missing or still hold their placeholder values from .env.example.
 *
 * WHY fail closed with instructions instead of letting the app boot:
 * Clerk's ClerkProvider throws when handed a malformed publishable key,
 * which without this guard would surface as an opaque Next.js error
 * overlay / stack trace on every single route — useless to a future
 * contributor (or future Moiz) who just forgot to copy .env.example to
 * .env.local. Catching it here, before ClerkProvider ever mounts, turns
 * that crash into a plain-English checklist instead.
 */
const REQUIRED_VARS = [
  "NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY — Clerk dashboard → API Keys",
  "CLERK_SECRET_KEY — Clerk dashboard → API Keys",
  "DATABASE_URL — Neon dashboard → connection string",
  "ANTHROPIC_API_KEY — console.anthropic.com → API Keys",
] as const;

export function SetupNotice() {
  return (
    <div className="flex min-h-full flex-1 items-center justify-center bg-chassis px-4 py-16">
      <div className="w-full max-w-md border border-seam bg-panel p-6">
        <p className="eyebrow">Setup</p>
        <h1 className="mt-3 text-xl font-semibold text-bone">
          Add your keys
        </h1>
        <p className="mt-2 text-sm text-steel">
          FleetIQ can&apos;t start until these values are set in{" "}
          <code className="mono-figures text-bone">.env.local</code>:
        </p>
        <ul className="mt-4 space-y-2 border-t border-seam pt-4">
          {REQUIRED_VARS.map((entry) => (
            <li
              key={entry}
              className="border-l-2 border-seam pl-3 text-sm text-steel"
            >
              {entry}
            </li>
          ))}
        </ul>
        <p className="mt-4 border-t border-seam pt-4 text-sm text-steel">
          Then restart the dev server.
        </p>
      </div>
    </div>
  );
}
