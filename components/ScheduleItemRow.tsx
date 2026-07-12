/**
 * One row of the vehicle detail page's maintenance-schedule table
 * (app/vehicles/[id]/page.tsx) — normally read-only (item name, StatusPill,
 * interval, next-due values + gauge, brands, source badge, "Mark done"
 * link), with an inline "Edit" toggle that swaps the interval cell for two
 * small controlled number inputs plus Save/Cancel, wired to lib/actions/
 * schedule.ts's updateScheduleItem server action (fix round 1, item 4 —
 * deferred from Task 8).
 *
 * WHY this is its own Client Component instead of more inline JSX on the
 * (Server Component) page: the edit toggle needs local state — is this row
 * being edited, what are the draft km/months values — which a Server
 * Component can't hold. Splitting out exactly this one row's interactivity
 * is the same "'use client' at the smallest boundary that needs it" pattern
 * components/ComplianceSection.tsx already uses for the compliance section.
 *
 * WHY useTransition (not useActionState/FormData) for the save: same
 * reasoning as ComplianceSection.tsx and components/ScheduleReview.tsx's
 * acceptSchedule call — the two interval fields already live in plain
 * controlled state (needed for the number inputs regardless), so there's no
 * FormData to build; this calls updateScheduleItem directly with an
 * already-typed argument, the established pattern this app already uses for
 * every server action whose input isn't a native browser form submission.
 */
'use client';

import { useState, useTransition } from 'react';
import Link from 'next/link';
import { updateScheduleItem } from '@/lib/actions/schedule';
import { StatusPill } from './StatusPill';
import { IntervalGauge } from './IntervalGauge';
import { formatKm } from '@/lib/status';
import type { ItemStatus, ScheduleItem } from '@/lib/types';

const AI_SOURCE_TOOLTIP = "AI-recommended — verify against your owner's manual.";
// Exact wording from the coordinator ruling (fix round 1, item 4) — shown
// instead of the AI disclaimer once a human has edited this item's
// intervals, since the AI's original recommendation no longer describes
// what's actually being tracked.
const USER_SOURCE_TOOLTIP = 'Intervals edited — AI origin no longer applies';

const NUMBER_FIELD_CLASS =
  'mono-figures w-20 border border-seam bg-panel-2 px-2 py-1 text-sm text-bone placeholder:text-steel-dim';

export function ScheduleItemRow({
  vehicleId,
  item,
  status,
  intervalConsumedPct,
}: {
  vehicleId: string;
  item: ScheduleItem;
  status: ItemStatus;
  intervalConsumedPct: number | null;
}) {
  const [editing, setEditing] = useState(false);
  const [km, setKm] = useState(item.intervalKm !== null ? item.intervalKm.toString() : '');
  const [months, setMonths] = useState(item.intervalMonths !== null ? item.intervalMonths.toString() : '');
  const [error, setError] = useState<string | null>(null);
  const [isPending, startTransition] = useTransition();

  function handleCancel() {
    setEditing(false);
    setError(null);
    setKm(item.intervalKm !== null ? item.intervalKm.toString() : '');
    setMonths(item.intervalMonths !== null ? item.intervalMonths.toString() : '');
  }

  function handleSave(e: React.FormEvent) {
    e.preventDefault();
    setError(null);

    const trimmedKm = km.trim();
    const trimmedMonths = months.trim();
    // Client-side "at least one" check mirrors updateScheduleItemInputSchema's
    // .refine() — fast feedback for the common case of blanking both fields,
    // but the server re-validates the exact same rule regardless (this
    // action is reachable directly, not just from this button).
    if (trimmedKm === '' && trimmedMonths === '') {
      setError('Set at least one of interval km or interval months.');
      return;
    }

    startTransition(async () => {
      const result = await updateScheduleItem({
        scheduleItemId: item.id,
        intervalKm: trimmedKm === '' ? null : Number(trimmedKm),
        intervalMonths: trimmedMonths === '' ? null : Number(trimmedMonths),
      });
      if (result.error) {
        setError(result.error);
      } else {
        setEditing(false);
      }
    });
  }

  const interval = [
    item.intervalKm !== null ? formatKm(item.intervalKm) : null,
    item.intervalMonths !== null ? `${item.intervalMonths} mo` : null,
  ]
    .filter(Boolean)
    .join(' / ');

  const nextDue = [item.nextDueKm !== null ? formatKm(item.nextDueKm) : null, item.nextDueDate]
    .filter(Boolean)
    .join(' / ');

  return (
    <tr className="border-b border-seam align-top last:border-b-0">
      <td className="px-3 py-2 text-bone">{item.name}</td>
      <td className="px-3 py-2">
        <StatusPill state={status.state} />
      </td>
      <td className="px-3 py-2">
        {editing ? (
          <form onSubmit={handleSave} className="flex flex-col gap-2">
            <div className="flex items-center gap-3">
              <label className="flex items-center gap-1.5 text-xs text-steel">
                km
                <input
                  value={km}
                  onChange={(e) => setKm(e.target.value)}
                  type="number"
                  inputMode="numeric"
                  min={1}
                  max={100_000}
                  aria-label="Interval, kilometers"
                  className={NUMBER_FIELD_CLASS}
                />
              </label>
              <label className="flex items-center gap-1.5 text-xs text-steel">
                mo
                <input
                  value={months}
                  onChange={(e) => setMonths(e.target.value)}
                  type="number"
                  inputMode="numeric"
                  min={1}
                  max={120}
                  aria-label="Interval, months"
                  className={NUMBER_FIELD_CLASS}
                />
              </label>
            </div>
            {/* aria-live: this error appears asynchronously with no page
                navigation on failure — same reasoning as every other inline
                form message in this app (e.g. components/ComplianceSection.tsx). */}
            <div aria-live="polite">
              {error && <p className="text-xs text-red">{error}</p>}
            </div>
            <div className="flex gap-2">
              <button
                type="submit"
                disabled={isPending}
                className="border border-seam px-2 py-1 text-xs font-medium text-bone transition-colors hover:bg-panel-2 disabled:cursor-not-allowed disabled:opacity-50"
              >
                {isPending ? 'Saving…' : 'Save'}
              </button>
              <button
                type="button"
                onClick={handleCancel}
                className="border border-seam px-2 py-1 text-xs text-steel transition-colors hover:bg-panel-2 hover:text-bone"
              >
                Cancel
              </button>
            </div>
          </form>
        ) : (
          <span className="mono-figures text-steel">{interval || '—'}</span>
        )}
      </td>
      <td className="px-3 py-2">
        <div className="mono-figures text-steel">{nextDue || '—'}</div>
        <div className="mono-figures text-xs text-steel-dim">{status.label}</div>
        <div className="mt-1.5 w-32">
          <IntervalGauge pct={intervalConsumedPct} />
        </div>
      </td>
      <td className="px-3 py-2 text-steel">
        {item.brandRecommendations.length > 0 ? item.brandRecommendations.join(', ') : '—'}
      </td>
      <td className="px-3 py-2">
        <span
          className="border border-seam px-2 py-0.5 text-xs uppercase text-steel"
          title={item.source === 'ai' ? AI_SOURCE_TOOLTIP : USER_SOURCE_TOOLTIP}
        >
          {item.source}
        </span>
      </td>
      <td className="px-3 py-2 text-right">
        <div className="flex flex-col items-end gap-1.5">
          {!editing && (
            <button
              type="button"
              onClick={() => setEditing(true)}
              className="text-xs text-steel underline decoration-seam underline-offset-4 transition-colors hover:text-bone"
            >
              Edit interval
            </button>
          )}
          {/* `?item=` preselects this row's schedule item on the log-service
              form (that page validates it's actually THIS vehicle's item
              before trusting it — the query string is attacker-controlled). */}
          <Link
            href={`/vehicles/${vehicleId}/log-service?item=${item.id}`}
            className="text-xs text-steel underline decoration-seam underline-offset-4 transition-colors hover:text-bone"
          >
            Mark done
          </Link>
        </div>
      </td>
    </tr>
  );
}
