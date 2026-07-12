/**
 * The confirm/correct vehicle-details form — shown by components/
 * VehicleForm.tsx once a VIN has decoded OR the user chose "Skip VIN".
 * Every field is editable regardless of which path got here; a blank field
 * that vPIC couldn't decode shows a placeholder saying so instead of a
 * silent empty box.
 *
 * WHY `make`/`model`/`year`/`engine` are controlled (useState) while every
 * other field is left uncontrolled (defaultValue + read via FormData at
 * submit): only those four feed the `decodeSource` computation below —
 * "did the user change anything vPIC decoded". Fields that don't affect
 * that decision (nickname, plate, dates, odometer) don't need React state
 * at all; FormData reads the DOM's current value regardless of whether
 * React is "controlling" it, so adding state for them would just be more
 * code with no behavior difference — the naive alternative.
 */
'use client';

// CONCEPT: useActionState wires a form up to a Server Action — it returns
// [state, formAction, isPending]. `state` is whatever the action last
// returned (here, `{ error? }`), `formAction` is what you pass to the
// form's `action` prop, and `isPending` is true while the action is
// in-flight, so the submit button can show "Saving…" without any manual
// fetch/loading-state plumbing.
import { useActionState, useState } from 'react';
import { createVehicle, type CreateVehicleState } from '@/lib/actions/vehicles';
import type { VinDecodeResult } from '@/lib/types';
import { FIELD_INPUT_CLASS } from './VehicleForm';

const VPIC_BLANK_PLACEHOLDER = "vPIC couldn't decode this — fill it in";
const initialState: CreateVehicleState = {};

function Field({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <label className="block">
      <span className="mb-1.5 block text-sm text-steel">{label}</span>
      {children}
    </label>
  );
}

export function VehicleDetailsForm({
  decodeResult,
  hasPhotoUpload,
}: {
  decodeResult: VinDecodeResult | null;
  hasPhotoUpload: boolean;
}) {
  const [state, formAction, isPending] = useActionState<CreateVehicleState, FormData>(
    createVehicle,
    initialState,
  );

  const [make, setMake] = useState(decodeResult?.make ?? '');
  const [model, setModel] = useState(decodeResult?.model ?? '');
  const [year, setYear] = useState(decodeResult?.year?.toString() ?? '');
  const [engine, setEngine] = useState(decodeResult?.engine ?? '');

  // decodeSource, computed fresh on every render rather than stored in its
  // own state: it's a pure function of "is there a decode result" and
  // "does the current field value match what vPIC originally reported" —
  // storing it separately would risk it drifting out of sync with the
  // fields it's derived from (the exact one-source-of-truth trap the
  // project's standards call out).
  const edited =
    decodeResult !== null &&
    (make !== (decodeResult.make ?? '') ||
      model !== (decodeResult.model ?? '') ||
      year !== (decodeResult.year?.toString() ?? '') ||
      engine !== (decodeResult.engine ?? ''));
  const decodeSource = decodeResult === null ? 'manual' : edited ? 'mixed' : 'vpic';

  return (
    <form
      action={formAction}
      className="space-y-6 border border-seam bg-panel p-5"
      aria-label="Vehicle details"
    >
      <input type="hidden" name="vin" value={decodeResult?.vin ?? ''} />
      <input type="hidden" name="decodeSource" value={decodeSource} />

      <div>
        <p className="eyebrow">Step 2 — Vehicle details</p>
        <p className="mt-2 text-sm text-steel">
          {decodeResult
            ? 'Every field below is editable — correct anything vPIC got wrong.'
            : 'Fill in what you know. Everything except nickname is optional for now.'}
        </p>
      </div>

      <Field label="Nickname">
        <input
          name="nickname"
          required
          maxLength={80}
          placeholder="e.g. The Beast, Delivery Van 2"
          autoComplete="off"
          className={FIELD_INPUT_CLASS}
        />
      </Field>

      <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
        <Field label="Make">
          <input
            value={make}
            onChange={(e) => setMake(e.target.value)}
            name="make"
            maxLength={80}
            autoComplete="off"
            placeholder={
              decodeResult ? (decodeResult.make === null ? VPIC_BLANK_PLACEHOLDER : undefined) : 'e.g. Toyota'
            }
            className={FIELD_INPUT_CLASS}
          />
        </Field>
        <Field label="Model">
          <input
            value={model}
            onChange={(e) => setModel(e.target.value)}
            name="model"
            maxLength={80}
            autoComplete="off"
            placeholder={
              decodeResult
                ? decodeResult.model === null
                  ? VPIC_BLANK_PLACEHOLDER
                  : undefined
                : 'e.g. Land Cruiser'
            }
            className={FIELD_INPUT_CLASS}
          />
        </Field>
        <Field label="Year">
          <input
            value={year}
            onChange={(e) => setYear(e.target.value)}
            name="year"
            type="number"
            inputMode="numeric"
            min={1950}
            max={2035}
            placeholder={
              decodeResult ? (decodeResult.year === null ? VPIC_BLANK_PLACEHOLDER : undefined) : 'e.g. 2020'
            }
            className={`${FIELD_INPUT_CLASS} mono-figures`}
          />
        </Field>
        <Field label="Plate">
          <input
            name="plate"
            maxLength={20}
            autoComplete="off"
            placeholder="e.g. 123456"
            className={`${FIELD_INPUT_CLASS} mono-figures`}
          />
        </Field>
      </div>

      <Field label="Engine">
        <input
          value={engine}
          onChange={(e) => setEngine(e.target.value)}
          name="engine"
          maxLength={80}
          autoComplete="off"
          placeholder={
            decodeResult
              ? decodeResult.engine === null
                ? VPIC_BLANK_PLACEHOLDER
                : undefined
              : 'e.g. 2.8L 4-cyl Diesel'
          }
          className={FIELD_INPUT_CLASS}
        />
      </Field>

      <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
        <Field label="Istimara expiry">
          <input name="istimaraExpiry" type="date" className={`${FIELD_INPUT_CLASS} mono-figures`} />
        </Field>
        <Field label="Fahes inspection due">
          <input name="fahesDue" type="date" className={`${FIELD_INPUT_CLASS} mono-figures`} />
        </Field>
      </div>

      <Field label="Initial odometer (km)">
        <input
          name="initialOdometerKm"
          type="number"
          inputMode="numeric"
          min={1}
          placeholder="e.g. 45000"
          className={`${FIELD_INPUT_CLASS} mono-figures`}
        />
      </Field>

      {hasPhotoUpload ? (
        <Field label="Photo (optional)">
          <input
            name="photo"
            type="file"
            accept="image/jpeg,image/png,image/webp"
            className="block w-full text-sm text-steel file:mr-4 file:border file:border-seam file:bg-panel-2 file:px-3 file:py-1.5 file:text-sm file:text-bone"
          />
        </Field>
      ) : (
        <p className="text-sm text-steel-dim">Photo uploads need Blob storage — coming with deploy.</p>
      )}

      {/* aria-live: useActionState re-renders this form with the action's
          result after submit with no navigation — same reasoning as the
          decode message in VehicleForm.tsx. */}
      <div aria-live="polite">
        {state.error && <p className="border-l-2 border-red pl-3 text-sm text-red">{state.error}</p>}
      </div>

      <button
        type="submit"
        disabled={isPending}
        className="border border-seam px-5 py-2.5 text-sm font-medium text-bone transition-colors hover:bg-panel-2 disabled:cursor-not-allowed disabled:opacity-50"
      >
        {isPending ? 'Saving…' : 'Save vehicle'}
      </button>
    </form>
  );
}
