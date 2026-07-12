/**
 * A single "annunciator lamp" — the small colored indicator lights on a
 * real instrument panel that flag a specific fault (check engine, low oil)
 * rather than showing a number. components/VehicleRow.tsx renders one per
 * non-ok schedule/compliance item, so a glance at the strip tells you HOW
 * MANY things need attention before reading any text at all.
 *
 * Per .superpowers/sdd/globals.md's design system: a 12px rounded-square,
 * unlit = panel-2 fill + seam border, lit = the item's status color with a
 * soft glow (`box-shadow: 0 0 12px <color>40`).
 *
 * WHY `lit` is a boolean PROP instead of derived internally from `state`:
 * the ignition self-test (components/IgnitionSequence.tsx) needs to flash
 * every lamp lit for a moment on page load regardless of its real state,
 * then settle to the real value — that timing belongs to the parent
 * driving the animation, not to this presentational component.
 */
import type { ItemState } from '@/lib/types';

// no_data has no saturated status color of its own — globals.md reserves
// red/amber/green for status ONLY, and no_data isn't one of the three real
// statuses (it means "nothing to compare yet", not "fine" or "a problem").
// components/VehicleRow.tsx's lamp strip excludes no_data items entirely
// (fix round 1, ruling #1): a no_data item's OdometerReadout already reads
// "no reading yet", so a glowing lamp for it would falsely imply urgency.
// This Record still needs a no_data entry — TypeScript requires every
// ItemState union member covered — steel-dim is just a neutral placeholder
// for any OTHER future caller that might request a no_data lamp `lit`, not
// an implied fourth severity color.
//
// WHY these are raw hex strings instead of `var(--red)` etc. (fix round 1,
// ruling #6): the app/globals.css tokens (--red/--amber/--green/--steel-dim)
// are this app's one source of truth for these colors, and the `lit` branch
// below appends a hex alpha suffix (`${color}40` = 25% opacity) to build the
// glow's `box-shadow` — CSS custom properties resolve to whatever the
// variable itself contains (here, an opaque 6-digit hex), and you can't
// concatenate a suffix onto a `var(...)` reference at the CSS-parsing level
// the way you can onto a plain string. Duplicating the literal hex here
// (kept byte-for-byte identical to app/globals.css) is the accepted
// trade-off; if the tokens ever change, this table has to change with them.
const STATE_COLOR: Record<ItemState, string> = {
  overdue: '#E5484D',
  due_soon: '#FFB224',
  ok: '#46A758',
  no_data: '#5C616C',
};

export function AnnunciatorLamp({ state, label, lit }: { state: ItemState; label: string; lit: boolean }) {
  const color = STATE_COLOR[state];

  return (
    <span
      title={label}
      className="inline-block h-3 w-3 shrink-0 rounded-[3px] border transition-shadow duration-150"
      style={
        lit
          ? { backgroundColor: color, borderColor: color, boxShadow: `0 0 12px ${color}40` }
          : { backgroundColor: 'var(--panel-2)', borderColor: 'var(--seam)' }
      }
    >
      <span className="sr-only">{label}</span>
    </span>
  );
}
