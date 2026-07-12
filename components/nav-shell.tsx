/**
 * Root navigation shell for FleetIQ.
 *
 * What this does: renders the app's four top-level links (Dashboard, Add
 * vehicle, Odometer, Settings) plus the FLEETIQ nameplate. On desktop
 * (768px+) it's a fixed left rail, like a panel of switches down the side
 * of an instrument console. Below 768px it collapses into a horizontal top
 * bar with a scrollable link strip, so it still works on a 375px phone
 * screen without wrapping into an awkward multi-row mess.
 *
 * WHY one component instead of two: the link list (NAV_LINKS) and the
 * "is this link active" logic are identical between the rail and the top
 * bar — only the container layout (flex-row vs flex-col) differs. Keeping
 * both in one component driven by Tailwind's `md:` breakpoint means the
 * link list is defined once; duplicating it into <DesktopNav> and
 * <MobileNav> components would risk the two drifting (e.g. someone adds a
 * link to one and forgets the other).
 */
"use client";

// CONCEPT: "use client" marks this as a Client Component — it runs in the
// browser (not just on the server) because it needs usePathname(), a hook
// that reads the current URL to highlight the active link. Most of
// FleetIQ's pages can be plain Server Components; this one can't.
import Link from "next/link";
import { usePathname } from "next/navigation";

const NAV_LINKS = [
  { href: "/", label: "Dashboard" },
  { href: "/vehicles/new", label: "Add vehicle" },
  { href: "/odometer", label: "Odometer" },
  { href: "/settings", label: "Settings" },
] as const;

export function NavShell() {
  const pathname = usePathname();

  return (
    <nav
      aria-label="Primary"
      className="flex shrink-0 items-center gap-4 border-b border-seam bg-panel px-4 py-3 md:h-dvh md:w-56 md:flex-col md:items-stretch md:gap-8 md:border-b-0 md:border-r md:px-5 md:py-6"
    >
      <span className="nameplate eyebrow shrink-0">FLEETIQ</span>

      {/* Mobile: a horizontally scrollable strip so four links never wrap
          awkwardly on a narrow phone. Desktop: a vertical stack, each row
          reading like a labeled switch on a panel schedule. */}
      <ul className="flex min-w-0 gap-1 overflow-x-auto md:flex-col md:gap-1 md:overflow-visible">
        {NAV_LINKS.map((link) => {
          const isActive = pathname === link.href;
          return (
            <li key={link.href} className="shrink-0 md:shrink">
              <Link
                href={link.href}
                aria-current={isActive ? "page" : undefined}
                className={`block whitespace-nowrap border-l-2 px-3 py-2 text-sm transition-colors ${
                  isActive
                    ? "border-bone bg-panel-2 text-bone"
                    : "border-transparent text-steel hover:border-seam hover:bg-panel-2 hover:text-bone"
                }`}
              >
                {link.label}
              </Link>
            </li>
          );
        })}
      </ul>
    </nav>
  );
}
