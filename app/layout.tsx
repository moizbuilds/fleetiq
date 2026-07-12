/**
 * Root layout — wraps every page in FleetIQ.
 *
 * What this does: loads the two fonts (Archivo for body/display text, IBM
 * Plex Mono for numerals), exposes them as CSS variables so globals.css can
 * reference them, wraps the whole app in Clerk's auth provider, and
 * renders the nav shell (left rail / top bar) around every page's content.
 *
 * WHY a shared layout instead of repeating this per page: Next.js's App
 * Router renders app/layout.tsx once around every route automatically —
 * the naive alternative (importing <NavShell> and <ClerkProvider> at the
 * top of every page.tsx) would mean forgetting one on a single new page
 * silently breaks auth or navigation on just that page.
 */
import type { Metadata, Viewport } from "next";
import { Archivo, IBM_Plex_Mono } from "next/font/google";
import { ClerkProvider, Show } from "@clerk/nextjs";
import { NavShell } from "@/components/nav-shell";
import { SetupNotice } from "@/components/setup-notice";
import { SyncActiveOrg } from "@/components/sync-active-org";
import { DemoModeBanner } from "@/components/demo-mode-banner";
import { clerkAppearance } from "@/lib/clerk-appearance";
import { hasValidClerkPublishableKey } from "@/lib/env";
import { isDemoMode } from "@/lib/demo";
import "./globals.css";

// CONCEPT: next/font/google downloads and self-hosts Google Fonts at build
// time (no request to Google's servers from the user's browser, which
// would leak their IP and add a render-blocking network hop). The
// `variable` option exposes the font as a CSS custom property instead of
// a plain className, which is why globals.css can reference
// var(--font-archivo) directly in the @theme block.
const archivo = Archivo({
  subsets: ["latin"],
  weight: ["400", "500", "600", "700"],
  variable: "--font-archivo",
});

const plexMono = IBM_Plex_Mono({
  subsets: ["latin"],
  weight: ["400", "500", "600"],
  variable: "--font-plex-mono",
});

export const metadata: Metadata = {
  title: "FleetIQ",
  description: "Fleet maintenance, tracked like an instrument panel.",
};

// Tells the browser chrome (mobile status bar, Android task switcher) to
// match the app's chassis background instead of defaulting to white —
// otherwise a light strip flashes above a dark-only app on load.
export const viewport: Viewport = {
  themeColor: "#16181d",
  colorScheme: "dark",
};

export default function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  const fontClassName = `${archivo.variable} ${plexMono.variable} h-full`;

  // Demo mode (lib/demo.ts) renders the exact same nav/page shell as the
  // real app, just WITHOUT ClerkProvider (there's no Clerk session to
  // provide — see lib/auth.ts's requireTenant()), WITHOUT the SetupNotice
  // branch below (demo mode isn't a "keys are missing" state, it's a
  // deliberate mode with its own working keyless database — see
  // lib/db/demo-db.ts), and WITHOUT <SyncActiveOrg> (it calls Clerk's
  // useAuth()/useOrganizationList() hooks, which throw outside a
  // ClerkProvider). This has to be its own early return, checked BEFORE
  // hasValidClerkPublishableKey() below: demo mode never sets a Clerk key
  // at all, so it would otherwise always fall into the SetupNotice branch.
  if (isDemoMode()) {
    return (
      <html lang="en" className={fontClassName}>
        <body className="flex min-h-full flex-col">
          <DemoModeBanner />
          {/* Skip link: invisible until keyboard-focused, lets keyboard
              users jump past the nav straight to page content instead of
              tabbing through every nav link on every page load. */}
          <a
            href="#main-content"
            className="sr-only focus-visible:not-sr-only focus-visible:fixed focus-visible:top-4 focus-visible:left-4 focus-visible:z-50 focus-visible:border focus-visible:border-seam focus-visible:bg-panel focus-visible:px-4 focus-visible:py-2 focus-visible:text-bone"
          >
            Skip to content
          </a>
          <div className="flex flex-1 flex-col md:flex-row">
            <NavShell />
            <main
              id="main-content"
              tabIndex={-1}
              className="mx-auto w-full max-w-5xl flex-1 px-4 py-8 md:px-8 md:py-10"
            >
              {children}
            </main>
          </div>
        </body>
      </html>
    );
  }

  // Short-circuit before ClerkProvider mounts at all — ClerkProvider
  // throws on a malformed publishable key, which would otherwise surface
  // as an opaque stack trace on every route. See lib/env.ts for why this
  // same check also has to run in proxy.ts, not just here.
  if (!hasValidClerkPublishableKey()) {
    return (
      <html lang="en" className={fontClassName}>
        <body className="flex min-h-full flex-col">
          <SetupNotice />
        </body>
      </html>
    );
  }

  return (
    // CONCEPT: ClerkProvider is a React "context provider" — it makes
    // auth state (who's signed in) available to every component below it
    // without threading a prop through every layer by hand.
    <ClerkProvider appearance={clerkAppearance}>
      <html lang="en" className={fontClassName}>
        <body className="flex min-h-full flex-col md:flex-row">
          {/* Client-side org-activation bridge — see
              components/sync-active-org.tsx for why this can't be done on
              the server. Scoped to `Show when="signed-in"` (Clerk v7's
              replacement for the old <SignedIn> component) since there's
              no organization to activate before a user is signed in. */}
          <Show when="signed-in">
            <SyncActiveOrg />
          </Show>
          {/* Skip link: invisible until keyboard-focused, lets keyboard
              users jump past the nav straight to page content instead of
              tabbing through every nav link on every page load. */}
          <a
            href="#main-content"
            className="sr-only focus-visible:not-sr-only focus-visible:fixed focus-visible:top-4 focus-visible:left-4 focus-visible:z-50 focus-visible:border focus-visible:border-seam focus-visible:bg-panel focus-visible:px-4 focus-visible:py-2 focus-visible:text-bone"
          >
            Skip to content
          </a>
          <NavShell />
          <main
            id="main-content"
            tabIndex={-1}
            className="mx-auto w-full max-w-5xl flex-1 px-4 py-8 md:px-8 md:py-10"
          >
            {children}
          </main>
        </body>
      </html>
    </ClerkProvider>
  );
}
