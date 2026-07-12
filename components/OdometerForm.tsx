/**
 * The odometer-log form (app/odometer/page.tsx) — pick a vehicle from the
 * fleet, type a new reading, submit. Everything here is a controlled field
 * (useState, value + onChange) for the same reason components/
 * VehicleDetailsForm.tsx's fields are: React 19's `<form action={fn}>`
 * calls the browser's native form-reset on every uncontrolled input the
 * moment the action is dispatched, BEFORE it resolves — an uncontrolled
 * field's value would already be gone by the time a failed submit's error
 * comes back, even though this form doesn't use FormData at all (it calls
 * logOdometer directly with a typed object, so there's no `name=` attribute
 * for a native reset to even target) — controlled state is what actually
 * survives regardless.
 */
'use client';

// CONCEPT: useActionState wires a component up to an async "action" — it
// returns [state, dispatch, isPending]. Unlike components/
// VehicleDetailsForm.tsx (which binds `dispatch` to a native
// `<form action={dispatch}>` and lets the browser build a FormData), this
// form calls `dispatch(payload)` itself from a plain onSubmit handler with
// a typed object — every field is already tracked in React state, so
// round-tripping through FormData (string-only) and re-parsing it back into
// numbers/booleans would just be extra code with nothing to gain.
import { useActionState, useState } from 'react';
import { logOdometer } from '@/lib/actions/odometer';
import { formatKm } from '@/lib/status';

export interface OdometerVehicleOption {
  id: string;
  nickname: string;
  plate: string | null;
  lastReadingLabel: string;
}

interface SubmitPayload {
  vehicleId: string;
  readingKm: number;
  isCorrection: boolean;
  note: string | null;
}

// Richer than lib/actions/odometer.ts's own `LogOdometerState` — this form
// needs to tell "nothing submitted yet" apart from "just succeeded", so the
// action wrapper below stashes the logged km on success instead of an empty
// object being ambiguous between the two.
interface FormState {
  error?: string;
  loggedKm?: number;
}

const initialState: FormState = {};

const BIG_INPUT_CLASS =
  'mono-figures w-full border border-seam bg-panel-2 px-4 py-4 text-4xl text-bone placeholder:text-steel-dim focus-visible:outline-none sm:text-5xl';

export function OdometerForm({ vehicles }: { vehicles: OdometerVehicleOption[] }) {
  const [vehicleId, setVehicleId] = useState(vehicles[0]?.id ?? '');
  const [readingKm, setReadingKm] = useState('');
  const [isCorrection, setIsCorrection] = useState(false);
  const [note, setNote] = useState('');

  // Defined inside the component so it can reach the setters above and
  // clear the entry fields the moment a submit actually succeeds — see the
  // WHY note above `FormState` for why success needs its own signal instead
  // of reusing lib/actions/odometer.ts's plain `{ error? }` shape as-is.
  async function submitReading(_prevState: FormState, payload: SubmitPayload): Promise<FormState> {
    const result = await logOdometer(payload);
    if (result.error) {
      return { error: result.error };
    }
    setReadingKm('');
    setIsCorrection(false);
    setNote('');
    return { loggedKm: payload.readingKm };
  }

  const [state, dispatch, isPending] = useActionState<FormState, SubmitPayload>(
    submitReading,
    initialState,
  );

  function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    const parsedKm = Number(readingKm);
    dispatch({
      vehicleId,
      // NaN rides through on purpose rather than being coerced to 0 — an
      // empty or garbage km field should hit the server's z.number() check
      // (which rejects NaN) and come back as a real validation error, never
      // silently get treated as "0 km entered".
      readingKm: readingKm.trim() === '' ? NaN : Math.trunc(parsedKm),
      isCorrection,
      note: isCorrection ? note.trim() || null : null,
    });
  }

  const selectedVehicle = vehicles.find((v) => v.id === vehicleId);
  const canSubmit = vehicleId !== '' && readingKm.trim() !== '' && (!isCorrection || note.trim() !== '');

  return (
    <form onSubmit={handleSubmit} className="space-y-6 border border-seam bg-panel p-5" aria-label="Log odometer reading">
      <fieldset>
        <legend className="eyebrow mb-3">Vehicle</legend>
        <div className="space-y-2">
          {vehicles.map((v) => (
            <label
              key={v.id}
              className="flex cursor-pointer items-center justify-between gap-3 border border-seam bg-panel-2 px-4 py-3 transition-colors has-[:checked]:border-bone has-[:focus-visible]:outline has-[:focus-visible]:outline-2 has-[:focus-visible]:outline-offset-2 has-[:focus-visible]:outline-bone hover:border-steel-dim"
            >
              <input
                type="radio"
                name="vehicle"
                value={v.id}
                checked={vehicleId === v.id}
                onChange={() => setVehicleId(v.id)}
                className="sr-only"
              />
              <span className="min-w-0 truncate text-bone">
                {v.nickname}
                {v.plate ? <span className="text-steel"> · {v.plate}</span> : null}
              </span>
              <span className="mono-figures shrink-0 text-sm text-steel">{v.lastReadingLabel}</span>
            </label>
          ))}
        </div>
      </fieldset>

      <label className="block">
        <span className="eyebrow mb-2 block">New reading (km)</span>
        <input
          value={readingKm}
          onChange={(e) => setReadingKm(e.target.value)}
          type="number"
          inputMode="numeric"
          min={1}
          placeholder="0"
          className={BIG_INPUT_CLASS}
        />
      </label>

      <label className="flex items-center gap-2 text-sm text-steel">
        <input
          type="checkbox"
          checked={isCorrection}
          onChange={(e) => setIsCorrection(e.target.checked)}
          className="h-4 w-4 border border-seam bg-panel-2 accent-bone"
        />
        This is a correction (e.g. odometer replaced) — allows a reading lower than the last one
      </label>

      {isCorrection && (
        <label className="block">
          <span className="mb-1.5 block text-sm text-steel">Note (required for a correction)</span>
          <textarea
            value={note}
            onChange={(e) => setNote(e.target.value)}
            maxLength={300}
            rows={2}
            placeholder="e.g. Dashboard/odometer replaced after accident repair"
            className="w-full border border-seam bg-panel-2 px-3 py-2 text-bone placeholder:text-steel-dim focus-visible:outline-none"
          />
        </label>
      )}

      {/* aria-live: this form never navigates on submit — the error or
          success message replaces the previous one in place, so a screen
          reader needs an explicit signal that something changed. */}
      <div aria-live="polite">
        {state.error && <p className="border-l-2 border-red pl-3 text-sm text-red">{state.error}</p>}
        {!state.error && state.loggedKm !== undefined && !isPending && (
          <p className="border-l-2 border-green pl-3 text-sm text-steel">
            Logged. {selectedVehicle?.nickname ?? 'Vehicle'} now at {formatKm(state.loggedKm)}.
          </p>
        )}
      </div>

      <button
        type="submit"
        disabled={isPending || !canSubmit}
        className="border border-seam px-5 py-2.5 text-sm font-medium text-bone transition-colors hover:bg-panel-2 disabled:cursor-not-allowed disabled:opacity-50"
      >
        {isPending ? 'Logging…' : 'Log reading'}
      </button>
    </form>
  );
}
