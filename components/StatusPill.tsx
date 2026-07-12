/**
 * A compact "state" chip — a small colored dot plus an eyebrow-style label
 * (OVERDUE / DUE SOON / OK / NO DATA) — used on the vehicle detail page's
 * schedule and compliance rows wherever an ItemStatus needs a quick,
 * scannable badge (lib/status.ts computes the underlying state; this
 * component only renders it).
 *
 * WHY a lookup table keyed by ItemState instead of a color prop passed in
 * by each caller: globals.md reserves red/amber/green for status ONLY and
 * requires them to mean the same thing everywhere — defining the
 * state-to-color mapping once, here, is what keeps every StatusPill in the
 * app agreeing on what "overdue" looks like instead of each call site
 * picking its own shade.
 */
import type { ItemState } from '@/lib/types';

const STATE_META: Record<ItemState, { label: string; className: string }> = {
  overdue: { label: 'OVERDUE', className: 'text-red' },
  due_soon: { label: 'DUE SOON', className: 'text-amber' },
  ok: { label: 'OK', className: 'text-green' },
  no_data: { label: 'NO DATA', className: 'text-steel-dim' },
};

export function StatusPill({ state }: { state: ItemState }) {
  const meta = STATE_META[state];
  return (
    <span className={`inline-flex items-center gap-1.5 text-[11px] font-semibold uppercase tracking-[0.14em] ${meta.className}`}>
      <span className="h-1.5 w-1.5 shrink-0 rounded-full bg-current" aria-hidden="true" />
      {meta.label}
    </span>
  );
}
