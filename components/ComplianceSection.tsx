/**
 * Vehicle detail page's compliance section — shows each of Istimara
 * (registration) and Fahes (inspection) deadlines with its computed
 * StatusPill, and lets both be edited inline without leaving the page.
 * Read-only by default; "Edit dates" swaps in a small controlled form,
 * saved via lib/actions/vehicles.ts's updateComplianceDates server action.
 *
 * WHY useTransition (not useActionState/FormData) for the save: both dates
 * already live in plain controlled state (needed for the `<input
 * type="date">` fields regardless), so there's no FormData to build or
 * parse — this mirrors components/ScheduleReview.tsx's own
 * useTransition-based save, which calls its server action directly with an
 * already-typed argument for the same reason.
 */
'use client';

import { useState, useTransition } from 'react';
import { updateComplianceDates } from '@/lib/actions/vehicles';
import { StatusPill } from './StatusPill';
import type { ItemStatus } from '@/lib/types';

interface ComplianceSectionProps {
  vehicleId: string;
  istimaraExpiry: string | null;
  istimaraStatus: ItemStatus;
  fahesDue: string | null;
  fahesStatus: ItemStatus;
}

// WHY no `focus-visible:outline-none` here (unlike some older form inputs
// elsewhere in this app): removing the outline without a replacement fails
// the "visible keyboard focus everywhere" rule (globals.md) — this class
// deliberately leaves globals.css's `:focus-visible { outline: 2px solid
// var(--bone) }` rule in effect instead of suppressing it.
const DATE_INPUT_CLASS = 'mono-figures w-full border border-seam bg-panel-2 px-3 py-2 text-bone';

export function ComplianceSection({
  vehicleId,
  istimaraExpiry,
  istimaraStatus,
  fahesDue,
  fahesStatus,
}: ComplianceSectionProps) {
  const [editing, setEditing] = useState(false);
  const [istimara, setIstimara] = useState(istimaraExpiry ?? '');
  const [fahes, setFahes] = useState(fahesDue ?? '');
  const [error, setError] = useState<string | null>(null);
  const [isPending, startTransition] = useTransition();

  function handleCancel() {
    setEditing(false);
    setError(null);
    setIstimara(istimaraExpiry ?? '');
    setFahes(fahesDue ?? '');
  }

  function handleSave(e: React.FormEvent) {
    e.preventDefault();
    setError(null);
    startTransition(async () => {
      const result = await updateComplianceDates({
        vehicleId,
        istimaraExpiry: istimara.trim() === '' ? null : istimara,
        fahesDue: fahes.trim() === '' ? null : fahes,
      });
      if (result.error) {
        setError(result.error);
      } else {
        setEditing(false);
      }
    });
  }

  return (
    <div className="border border-seam bg-panel p-5">
      <div className="flex items-center justify-between">
        <p className="eyebrow">Compliance</p>
        {!editing && (
          <button
            type="button"
            onClick={() => setEditing(true)}
            className="text-xs text-steel underline decoration-seam underline-offset-4 transition-colors hover:text-bone"
          >
            Edit dates
          </button>
        )}
      </div>

      <div className="mt-4 space-y-4">
        <ComplianceRow label="Istimara (registration)" status={istimaraStatus} date={istimaraExpiry} />
        <ComplianceRow label="Fahes inspection" status={fahesStatus} date={fahesDue} />
      </div>

      {editing && (
        <form onSubmit={handleSave} className="mt-4 space-y-4 border-t border-seam pt-4">
          <label className="block">
            <span className="mb-1.5 block text-sm text-steel">Istimara expiry</span>
            <input
              value={istimara}
              onChange={(e) => setIstimara(e.target.value)}
              type="date"
              className={DATE_INPUT_CLASS}
            />
          </label>
          <label className="block">
            <span className="mb-1.5 block text-sm text-steel">Fahes due</span>
            <input value={fahes} onChange={(e) => setFahes(e.target.value)} type="date" className={DATE_INPUT_CLASS} />
          </label>

          {/* aria-live: this error appears asynchronously with no page
              navigation on failure — same reasoning as every other inline
              form in this app (e.g. components/OdometerForm.tsx). */}
          <div aria-live="polite">
            {error && <p className="border-l-2 border-red pl-3 text-sm text-red">{error}</p>}
          </div>

          <div className="flex gap-2">
            <button
              type="submit"
              disabled={isPending}
              className="border border-seam px-4 py-2 text-sm font-medium text-bone transition-colors hover:bg-panel-2 disabled:cursor-not-allowed disabled:opacity-50"
            >
              {isPending ? 'Saving…' : 'Save'}
            </button>
            <button
              type="button"
              onClick={handleCancel}
              className="border border-seam px-4 py-2 text-sm text-steel transition-colors hover:bg-panel-2 hover:text-bone"
            >
              Cancel
            </button>
          </div>
        </form>
      )}
    </div>
  );
}

function ComplianceRow({ label, status, date }: { label: string; status: ItemStatus; date: string | null }) {
  return (
    <div className="flex flex-wrap items-center justify-between gap-2">
      <span className="text-sm text-bone">{label}</span>
      <div className="flex flex-wrap items-center gap-3">
        <span className="mono-figures text-sm text-steel">{date ?? '—'}</span>
        <StatusPill state={status.state} />
        <span className="mono-figures text-xs text-steel-dim">{status.label}</span>
      </div>
    </div>
  );
}
