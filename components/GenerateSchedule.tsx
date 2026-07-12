/**
 * Empty-state "Generate schedule" flow for a vehicle with no schedule items
 * yet (app/vehicles/[id]/page.tsx). Calls app/api/ai/schedule/route.ts,
 * then hands the result to components/ScheduleReview.tsx for review and
 * editing — this component itself never writes anything to the database
 * (globals.md: "extraction pre-fills forms; never auto-saves").
 *
 * WHY generation only stays reachable from this empty state, never as a
 * "regenerate" once real schedule items exist: an already-saved schedule
 * may mix AI-sourced items with user edits/additions (source: 'ai' vs
 * 'user') — silently regenerating over that would discard those edits with
 * no clear merge story. That's out of scope for this task; the vehicle
 * page (see its branch on `items.length === 0`) only ever renders this
 * component when there's nothing to protect yet.
 */
'use client';

import { useState } from 'react';
import { ScheduleReview } from './ScheduleReview';
import type { AiSchedule } from '@/lib/types';

// A small explicit state machine (rather than separate loading/error
// booleans) so "loading" and "error" can never both be true at once, and
// the success branch always carries the schedule it succeeded WITH — no
// stale "the last error" lingering next to a fresh result.
type FlowState =
  | { status: 'idle' }
  | { status: 'loading' }
  | { status: 'error'; message: string }
  | { status: 'success'; schedule: AiSchedule };

export function GenerateSchedule({ vehicleId }: { vehicleId: string }) {
  const [state, setState] = useState<FlowState>({ status: 'idle' });

  async function handleGenerate() {
    setState({ status: 'loading' });
    try {
      const res = await fetch('/api/ai/schedule', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ vehicleId }),
      });
      const body = await res.json();

      if (!res.ok) {
        setState({ status: 'error', message: body.error ?? 'Something went wrong.' });
        return;
      }

      setState({ status: 'success', schedule: body as AiSchedule });
    } catch {
      // Network drop / DNS failure / etc. — never fabricate a result here;
      // the same "Generate schedule" button below doubles as the retry.
      setState({ status: 'error', message: 'Network error — check your connection and try again.' });
    }
  }

  if (state.status === 'success') {
    return <ScheduleReview vehicleId={vehicleId} items={state.schedule.items} />;
  }

  return (
    <div className="border border-seam bg-panel p-6 text-center">
      <p className="text-sm text-steel">No maintenance schedule yet for this vehicle.</p>

      <button
        type="button"
        onClick={handleGenerate}
        disabled={state.status === 'loading'}
        className="mt-4 border border-seam px-5 py-2.5 text-sm font-medium text-bone transition-colors hover:bg-panel-2 disabled:cursor-not-allowed disabled:opacity-50"
      >
        {state.status === 'loading' ? 'Generating recommended schedule…' : 'Generate schedule'}
      </button>

      {/* aria-live: this message appears asynchronously with no page
          navigation — same reasoning as the vehicle-add form's decode
          error (components/VehicleForm.tsx). The button above doubles as
          "retry": it's re-enabled the instant status leaves 'loading'. */}
      <div aria-live="polite">
        {state.status === 'error' && (
          <p className="mt-4 border-l-2 border-red pl-3 text-sm text-red">{state.message}</p>
        )}
      </div>
    </div>
  );
}
