/**
 * Inline VIN-decode input for the dashboard's empty-fleet state
 * (app/page.tsx) — lets a first-time user skip straight from "no vehicles
 * yet" into a pre-filled add-vehicle form, instead of landing on a blank
 * /vehicles/new page and having to find the VIN field themselves.
 *
 * WHY the actual decode call does NOT happen here: components/
 * VehicleForm.tsx already owns the whole VIN flow — the fetch to
 * app/api/vin/route.ts, the confirm/correct details form, the createVehicle
 * server action. Re-implementing any of that in a second component would be
 * exactly the kind of duplicated logic that drifts (globals.md's
 * one-source-of-truth rule). This component's only job is a client-side
 * SHAPE check (fast feedback, same message VehicleForm uses) before
 * navigating to `/vehicles/new?vin=<VIN>` — VehicleForm's `initialVin` prop
 * then auto-runs its OWN existing decode function on mount (fix round 1,
 * ruling #3), so there's still exactly one place that calls vPIC.
 */
'use client';

// CONCEPT: useRouter (the App Router's client-side navigation hook) gives a
// `.push()` that changes the URL and re-renders the new route WITHOUT a full
// page reload — the right tool here since this is a button click, not a
// form submission Next.js could handle with a plain <Link>/redirect.
import { useRouter } from 'next/navigation';
import { useState } from 'react';
import { isValidVin } from '@/lib/vin';

// Identical wording to components/VehicleForm.tsx's own inline VIN error —
// a user decoding from the dashboard vs. from /vehicles/new directly should
// never see two different phrasings of the same validation rule.
const VIN_ERROR_MESSAGE = 'VIN must be 17 characters (letters and numbers, excluding I, O, Q).';

export function EmptyFleetVin() {
  const router = useRouter();
  const [vin, setVin] = useState('');
  const [error, setError] = useState<string | null>(null);

  function handleDecodeClick() {
    if (!isValidVin(vin)) {
      setError(VIN_ERROR_MESSAGE);
      return;
    }
    setError(null);
    router.push(`/vehicles/new?vin=${encodeURIComponent(vin)}`);
  }

  return (
    <div className="mt-8 w-full max-w-sm border border-seam bg-panel p-5 text-left">
      <p className="eyebrow">Or decode a VIN</p>
      <div className="mt-3 flex flex-col gap-3 sm:flex-row sm:items-end">
        <label className="flex-1">
          <span className="mb-1.5 flex items-baseline justify-between text-sm text-steel">
            <span>VIN</span>
            <span className="mono-figures text-xs text-steel-dim">
              {vin.length.toString().padStart(2, '0')} / 17
            </span>
          </span>
          <input
            value={vin}
            onChange={(e) => setVin(e.target.value.toUpperCase())}
            maxLength={17}
            placeholder="e.g. 1HGCM82633A004352"
            autoComplete="off"
            spellCheck={false}
            className="mono-figures w-full border border-seam bg-panel-2 px-3 py-2 tracking-[0.08em] text-bone placeholder:text-steel-dim"
          />
        </label>
        <button
          type="button"
          onClick={handleDecodeClick}
          disabled={vin.length === 0}
          className="border border-seam px-4 py-2 text-sm text-bone transition-colors hover:bg-panel-2 disabled:cursor-not-allowed disabled:opacity-50"
        >
          Decode VIN
        </button>
      </div>
      {/* aria-live: the validation error appears without any navigation or
          page reload — same reasoning as every other inline form message in
          this app (e.g. components/VehicleForm.tsx's decode error). */}
      <div aria-live="polite">
        {error && <p className="mt-3 border-l-2 border-red pl-3 text-sm text-red">{error}</p>}
      </div>
    </div>
  );
}
