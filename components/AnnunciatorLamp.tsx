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
// Its lamp can still be requested `lit` (VehicleRow includes no_data items
// in its "needs attention" lamp strip), but it renders in steel-dim rather
// than inventing a fourth saturated color.
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
