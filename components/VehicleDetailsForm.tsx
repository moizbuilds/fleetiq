/**
 * The confirm/correct vehicle-details form — shown by components/
 * VehicleForm.tsx once a VIN has decoded OR the user chose "Skip VIN".
 * Every field is editable regardless of which path got here; a blank field
 * that vPIC couldn't decode shows a placeholder saying so instead of a
 * silent empty box.
 *
 * WHY every text/date/number field is controlled (useState, value +
 * onChange) instead of left uncontrolled with defaultValue: React 19's
 * `<form action={...}>` calls the browser's native form-reset
 * (`requestFormReset`) on every uncontrolled input the moment the form is
 * submitted — BEFORE the server action has even resolved, let alone
 * returned. If the action comes back with `{ error }` (a failed Zod
 * validation, a DB error), an uncontrolled field's DOM value is already
 * gone; the form re-renders with the error message but every field the
 * user carefully typed is blank. A controlled field's value lives in React
 * state, which the reset never touches, so it survives a failed submit
 * exactly like the four vPIC-decode fields (make/model/year/engine)
 * already did before this fix — this file just extends that same pattern
 * to nickname/plate/dates/odometer instead of leaving them exposed to the
 * bug. (Nothing here is a NEW pattern; it's closing a gap where only 4 of
 * 10 fields had it.)
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
import { ALLOWED_PHOTO_TYPES, MAX_PHOTO_BYTES, isAllowedPhotoType } from '@/lib/photo';
import { FIELD_INPUT_CLASS } from './VehicleForm';

const VPIC_BLANK_PLACEHOLDER = "vPIC couldn't decode this — fill it in";
const REATTACH_PHOTO_SUFFIX = ' Please re-attach the photo.';
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

  // The rest of the fields — controlled for the reset-survival reason
  // explained in the file header above. They don't feed decodeSource (only
  // make/model/year/engine do), so unlike those four they start blank
  // regardless of decodeResult.
  const [nickname, setNickname] = useState('');
  const [plate, setPlate] = useState('');
  const [istimaraExpiry, setIstimaraExpiry] = useState('');
  const [fahesDue, setFahesDue] = useState('');
  const [initialOdometerKm, setInitialOdometerKm] = useState('');

  // A native <input type="file">'s value can't be set from JS (browsers
  // block it — a page being able to programmatically point a file input at
  // an arbitrary local path would be a huge security hole), so unlike every
  // other field above, this one CAN'T be made controlled. The mitigation
  // instead: (a) validate the file the instant it's chosen, mirroring the
  // server's own rule via the shared lib/photo.ts constants, so a bad photo
  // never leaves this browser tab in the first place; (b) remember only the
  // file's NAME in state (not the File object itself — state survives the
  // reset, the File object living in the DOM node does not), so if the
  // action still comes back with an error, we know a photo HAD been chosen
  // even though the browser already cleared the input, and can tell the
  // user to re-attach it instead of leaving them wondering why it vanished.
  const [photoName, setPhotoName] = useState<string | null>(null);
  const [photoClientError, setPhotoClientError] = useState<string | null>(null);

  function handlePhotoChange(e: React.ChangeEvent<HTMLInputElement>) {
    const file = e.target.files?.[0] ?? null;
    if (!file) {
      setPhotoName(null);
      setPhotoClientError(null);
      return;
    }
    if (!isAllowedPhotoType(file.type)) {
      setPhotoClientError('Photo must be a JPEG, PNG, or WEBP image.');
      setPhotoName(null);
      e.target.value = ''; // don't let a rejected file ride along on submit
      return;
    }
    if (file.size > MAX_PHOTO_BYTES) {
      setPhotoClientError('Photo must be 5MB or smaller.');
      setPhotoName(null);
      e.target.value = '';
      return;
    }
    setPhotoClientError(null);
    setPhotoName(file.name);
  }

  // decodeSource, computed fresh on every render rather than stored in its
  // own state: it's a pure function of "is there a decode result" and
  // "does the current field value match what vPIC originally reported" —
  // storing it separately would risk it drifting out of sync with the
  // fields it's derived from (the exact one-source-of-truth trap the
  // project's standards call out).
  //
  // MINOR fix: both sides are `.trim()`-ed before comparing. Without it, a
  // stray leading/trailing space the user types (or that a paste brings in)
  // would make `edited` true even though the field means the same thing —
  // flipping decodeSource from 'vpic' to 'mixed' for no real change.
  const edited =
    decodeResult !== null &&
    (make.trim() !== (decodeResult.make ?? '').trim() ||
      model.trim() !== (decodeResult.model ?? '').trim() ||
      year.trim() !== (decodeResult.year?.toString() ?? '').trim() ||
      engine.trim() !== (decodeResult.engine ?? '').trim());
  const decodeSource = decodeResult === null ? 'manual' : edited ? 'mixed' : 'vpic';

  // If the server action rejected the submit AND a photo had been chosen,
  // the browser already blanked the file input (same native reset behavior
  // this whole file is written around) — tell the user explicitly instead
  // of letting them resubmit with no photo and no idea why.
  const displayedError = state.error
    ? state.error + (photoName ? REATTACH_PHOTO_SUFFIX : '')
    : null;

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
          value={nickname}
          onChange={(e) => setNickname(e.target.value)}
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
            value={plate}
            onChange={(e) => setPlate(e.target.value)}
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
          <input
            value={istimaraExpiry}
            onChange={(e) => setIstimaraExpiry(e.target.value)}
            name="istimaraExpiry"
            type="date"
            className={`${FIELD_INPUT_CLASS} mono-figures`}
          />
        </Field>
        <Field label="Fahes inspection due">
          <input
            value={fahesDue}
            onChange={(e) => setFahesDue(e.target.value)}
            name="fahesDue"
            type="date"
            className={`${FIELD_INPUT_CLASS} mono-figures`}
          />
        </Field>
      </div>

      <Field label="Initial odometer (km)">
        <input
          value={initialOdometerKm}
          onChange={(e) => setInitialOdometerKm(e.target.value)}
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
            accept={ALLOWED_PHOTO_TYPES.join(',')}
            onChange={handlePhotoChange}
            className="block w-full text-sm text-steel file:mr-4 file:border file:border-seam file:bg-panel-2 file:px-3 file:py-1.5 file:text-sm file:text-bone"
          />
          {/* aria-live: the client-side photo check runs on file selection,
              not on submit — same async-update-with-no-navigation reasoning
              as the decode message in VehicleForm.tsx. */}
          <div aria-live="polite">
            {photoClientError && <p className="mt-1.5 text-sm text-red">{photoClientError}</p>}
          </div>
        </Field>
      ) : (
        <p className="text-sm text-steel-dim">Photo uploads need Blob storage — coming with deploy.</p>
      )}

      {/* aria-live: useActionState re-renders this form with the action's
          result after submit with no navigation — same reasoning as the
          decode message in VehicleForm.tsx. */}
      <div aria-live="polite">
        {displayedError && <p className="border-l-2 border-red pl-3 text-sm text-red">{displayedError}</p>}
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
