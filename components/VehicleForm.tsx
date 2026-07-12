/**
 * Add-vehicle form (Task 4) — the two-path flow described in the spec:
 * decode a VIN via NHTSA's free vPIC API and confirm/correct the result, OR
 * skip straight to a blank manual form. Either path lands on the same
 * fully-editable field set and the same `createVehicle` server action.
 *
 * What this does: renders a small "Step 1" VIN-decode strip (always
 * visible) above the actual vehicle-details form. The details form only
 * appears once the user has either decoded a VIN successfully or clicked
 * "Skip VIN". Decoding is a client-side `fetch()` to app/api/vin/route.ts —
 * it has to be, since it's triggered by a button click *after* the page has
 * already rendered, which a Server Component can't react to.
 *
 * WHY the VIN section stays visible even after a form appears: re-decoding
 * a different VIN is how the "form state rebuilds if a new VIN is decoded"
 * identity rule (globals.md) actually gets exercised — `VehicleDetailsForm`
 * below is keyed by the decoded VIN (or the literal 'manual'), so typing a
 * new VIN and decoding again fully remounts the details form with fresh
 * state instead of leaving stale edited values from the previous vehicle.
 *
 * WHY an `initialVin` prop (fix round 1, ruling #3): components/
 * EmptyFleetVin.tsx (the dashboard's empty-fleet VIN input) navigates to
 * `/vehicles/new?vin=<VIN>` rather than decoding inline itself — this
 * component is the one place that already owns the decode flow, so it
 * lifts that trigger in as a prop and auto-runs the SAME `handleDecode`
 * a manual button click would, instead of a second copy of that logic
 * living in the dashboard component.
 */
'use client';

// CONCEPT: useState holds a value that persists across re-renders and
// triggers a re-render when changed via its setter — this component uses
// it for "has the user decoded/skipped yet" and "what did vPIC return".
// CONCEPT: useEffect runs a side effect (something that isn't just
// "compute a value from props/state") after React has committed a render —
// used below to auto-trigger a decode once, right after this component
// mounts with a VIN already supplied.
import { useEffect, useRef, useState } from 'react';
import type { VinDecodeResult } from '@/lib/types';
import { isValidVin } from '@/lib/vin';
import { VehicleDetailsForm } from './VehicleDetailsForm';

const FIELD_INPUT_CLASS =
  'w-full border border-seam bg-panel-2 px-3 py-2 text-bone placeholder:text-steel-dim focus-visible:outline-none';

export function VehicleForm({
  hasPhotoUpload,
  initialVin = null,
}: {
  hasPhotoUpload: boolean;
  // Pre-fills the VIN field (and, if it's shaped like a real VIN, triggers
  // an immediate decode) — set by app/vehicles/new/page.tsx from the `vin`
  // search param. `null` (the default) is the normal "blank form" case a
  // direct visit to /vehicles/new still gets.
  initialVin?: string | null;
}) {
  // Clamped/normalized the same way a keystroke into this field would be
  // (uppercase, 17-char cap) — initialVin comes straight from the URL
  // (attacker/user-controlled), and a controlled input's VALUE isn't
  // constrained by its `maxLength` attribute the way typed keystrokes are.
  const [vinInput, setVinInput] = useState((initialVin ?? '').trim().toUpperCase().slice(0, 17));
  const [decoding, setDecoding] = useState(false);
  const [decodeError, setDecodeError] = useState<string | null>(null);
  const [decodeResult, setDecodeResult] = useState<VinDecodeResult | null>(null);
  // WHY a separate flag instead of inferring "skipped" from decodeResult
  // being null: decodeResult is ALSO null before the user has done anything
  // at all — without this flag there'd be no way to tell "hasn't acted yet"
  // apart from "chose manual", and the details form would show up before
  // the user asked for it.
  const [skipped, setSkipped] = useState(false);

  const showDetailsForm = decodeResult !== null || skipped;
  const vinIsValidShape = isValidVin(vinInput);

  async function handleDecode() {
    if (!vinIsValidShape) {
      setDecodeError('VIN must be 17 characters (letters and numbers, excluding I, O, Q).');
      return;
    }

    setDecoding(true);
    setDecodeError(null);

    try {
      const res = await fetch(`/api/vin?vin=${encodeURIComponent(vinInput)}`);
      const body = await res.json();

      if (!res.ok) {
        // Decode failure never blocks the manual path — "Skip VIN" stays
        // clickable right below this message; nothing here disables it.
        setDecodeError(body.error ?? 'VIN decode failed.');
        return;
      }

      setDecodeResult(body as VinDecodeResult);
      setSkipped(false);
    } catch {
      setDecodeError('VIN service unreachable — add the vehicle manually');
    } finally {
      setDecoding(false);
    }
  }

  // Auto-run the decode — the exact same handleDecode a manual "Decode VIN"
  // click calls — when this component mounts already holding a VIN from the
  // URL (fix round 1, ruling #3). A ref (not a dependency array) guards
  // "only once": handleDecode is a plain function redefined every render
  // (it closes over the latest vinInput), so listing it as a dependency
  // would refire this effect on every state change it causes, not just on
  // mount — the ref sidesteps that without needing useCallback for a
  // function that's only ever called from two places (a click handler, and
  // here). The ref is set BEFORE scheduling anything, so React's Strict
  // Mode dev-only effect/cleanup/effect replay still only ever queues one
  // microtask (the second invocation sees the ref already true and returns
  // immediately) — no cleanup/cancellation needed the way
  // components/IgnitionSequence.tsx's cancellable rAF/timers need one.
  const autoDecodeRanRef = useRef(false);
  useEffect(() => {
    if (autoDecodeRanRef.current) return;
    autoDecodeRanRef.current = true;
    if (initialVin === null || !isValidVin(initialVin)) return;
    // Deferred into a microtask instead of called synchronously in the
    // effect body, to satisfy react-hooks/set-state-in-effect — same
    // "setState only from a callback, never synchronously inside an
    // effect" reasoning as IgnitionSequence, just via queueMicrotask
    // instead of requestAnimationFrame since this is a one-shot network
    // call, not a frame-synced animation.
    queueMicrotask(() => {
      void handleDecode();
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  return (
    <div className="space-y-8">
      <section className="border border-seam bg-panel p-5">
        <p className="eyebrow">Step 1 — Decode VIN (optional)</p>
        <div className="mt-4 flex flex-col gap-3 sm:flex-row sm:items-end">
          <label className="flex-1">
            <span className="mb-1.5 flex items-baseline justify-between text-sm text-steel">
              <span>VIN</span>
              <span className="mono-figures text-xs text-steel-dim">
                {vinInput.length.toString().padStart(2, '0')} / 17
              </span>
            </span>
            <input
              value={vinInput}
              onChange={(e) => setVinInput(e.target.value.toUpperCase())}
              maxLength={17}
              placeholder="e.g. 1HGCM82633A004352"
              autoComplete="off"
              spellCheck={false}
              className={`${FIELD_INPUT_CLASS} mono-figures tracking-[0.08em]`}
            />
          </label>
          <div className="flex gap-2">
            <button
              type="button"
              onClick={handleDecode}
              disabled={decoding || vinInput.length === 0}
              className="border border-seam px-4 py-2 text-sm text-bone transition-colors hover:bg-panel-2 disabled:cursor-not-allowed disabled:opacity-50"
            >
              {decoding ? 'Decoding…' : 'Decode VIN'}
            </button>
            <button
              type="button"
              onClick={() => {
                setSkipped(true);
                setDecodeResult(null);
                setDecodeError(null);
              }}
              className="border border-seam px-4 py-2 text-sm text-steel transition-colors hover:bg-panel-2 hover:text-bone"
            >
              Skip VIN — add manually
            </button>
          </div>
        </div>
        {/* aria-live: this message appears asynchronously after a fetch
            completes, with no page navigation to draw a screen reader's
            attention to it — without aria-live, someone using assistive
            tech would have no signal that anything happened at all. */}
        <div aria-live="polite">
          {decodeError && (
            <p className="mt-4 border-l-2 border-red pl-3 text-sm text-red">{decodeError}</p>
          )}
          {decodeResult && (
            <p className="mt-4 border-l-2 border-green pl-3 text-sm text-steel">
              Decoded — review and correct any field below before saving.
            </p>
          )}
        </div>
      </section>

      {showDetailsForm && (
        <VehicleDetailsForm
          // Keying on the decoded VIN (or the literal 'manual') is what
          // rebuilds this subtree's state when a different VIN is decoded —
          // see the file header and globals.md's identity rule.
          key={decodeResult?.vin ?? 'manual'}
          decodeResult={decodeResult}
          hasPhotoUpload={hasPhotoUpload}
        />
      )}
    </div>
  );
}

export { FIELD_INPUT_CLASS };
