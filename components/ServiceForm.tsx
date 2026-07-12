/**
 * The service-completion form (app/vehicles/[id]/log-service/page.tsx) —
 * pick a schedule item to mark done (or log an unscheduled repair), enter
 * the odometer/date/cost/notes, optionally attach an invoice photo, submit.
 * Every field is controlled (useState) for the same React-19-form-reset
 * reason as components/OdometerForm.tsx — see that file's header.
 */
'use client';

import { useActionState, useState } from 'react';
import { completeService, uploadInvoicePhoto, type CompleteServiceState } from '@/lib/actions/services';
import { ALLOWED_PHOTO_TYPES, MAX_PHOTO_BYTES, isAllowedPhotoType } from '@/lib/photo';

export interface ServiceScheduleItemOption {
  id: string;
  name: string;
  nextDueLabel: string;
}

interface ServiceFormProps {
  vehicleId: string;
  scheduleItems: ServiceScheduleItemOption[];
  preselectedItemId: string | null;
  latestReadingKm: number | null;
  today: string; // YYYY-MM-DD, computed server-side (app/vehicles/[id]/log-service/page.tsx)
  hasPhotoUpload: boolean;
}

const UNSCHEDULED = 'unscheduled';

// CONCEPT: a small state machine (rather than separate loading/error
// booleans) so "uploading" and "failed" and "attached" can never be
// simultaneously true, the same reasoning as components/
// GenerateSchedule.tsx's FlowState.
type PhotoState =
  | { status: 'idle' }
  | { status: 'uploading'; fileName: string }
  | { status: 'done'; fileName: string; url: string }
  | { status: 'error'; message: string };

const initialState: CompleteServiceState = {};

const FIELD_INPUT_CLASS =
  'w-full border border-seam bg-panel-2 px-3 py-2 text-bone placeholder:text-steel-dim focus-visible:outline-none';

export function ServiceForm({
  vehicleId,
  scheduleItems,
  preselectedItemId,
  latestReadingKm,
  today,
  hasPhotoUpload,
}: ServiceFormProps) {
  // Defaults to "unscheduled" unless a "Mark done" link explicitly
  // preselected a real schedule item — landing on this page any other way
  // shouldn't guess which item the user means.
  const [selectedItemId, setSelectedItemId] = useState<string>(preselectedItemId ?? UNSCHEDULED);
  const [title, setTitle] = useState('');
  const [odometerKm, setOdometerKm] = useState(latestReadingKm?.toString() ?? '');
  const [performedOn, setPerformedOn] = useState(today);
  const [costQar, setCostQar] = useState('');
  const [notes, setNotes] = useState('');
  const [photo, setPhoto] = useState<PhotoState>({ status: 'idle' });

  const [state, dispatch, isPending] = useActionState<
    CompleteServiceState,
    Parameters<typeof completeService>[0]
  >((_prevState, payload) => completeService(payload), initialState);

  async function handlePhotoChange(e: React.ChangeEvent<HTMLInputElement>) {
    const file = e.target.files?.[0] ?? null;
    if (!file) {
      setPhoto({ status: 'idle' });
      return;
    }
    if (!isAllowedPhotoType(file.type)) {
      setPhoto({ status: 'error', message: 'Photo must be a JPEG, PNG, or WEBP image.' });
      e.target.value = '';
      return;
    }
    if (file.size > MAX_PHOTO_BYTES) {
      setPhoto({ status: 'error', message: 'Photo must be 5MB or smaller.' });
      e.target.value = '';
      return;
    }

    setPhoto({ status: 'uploading', fileName: file.name });
    const formData = new FormData();
    formData.set('photo', file);
    const result = await uploadInvoicePhoto(formData);
    if (result.error || !result.url) {
      setPhoto({ status: 'error', message: result.error ?? 'Upload failed — try again.' });
      return;
    }
    setPhoto({ status: 'done', fileName: file.name, url: result.url });
  }

  function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    const isUnscheduled = selectedItemId === UNSCHEDULED;
    const parsedKm = Number(odometerKm);
    const parsedCost = costQar.trim() === '' ? null : Number(costQar);

    dispatch({
      vehicleId,
      scheduleItemId: isUnscheduled ? null : selectedItemId,
      title: isUnscheduled ? title.trim() : null,
      // NaN rides through on purpose (same reasoning as OdometerForm) — an
      // empty/garbage field should hit the server's z.number() check and
      // come back as a real validation error, never get silently treated
      // as 0.
      odometerKm: odometerKm.trim() === '' ? NaN : Math.trunc(parsedKm),
      performedOn,
      costQar: parsedCost !== null && !Number.isFinite(parsedCost) ? NaN : parsedCost,
      notes: notes.trim() || null,
      invoicePhotoUrl: photo.status === 'done' ? photo.url : null,
    });
  }

  const canSubmit =
    (selectedItemId === UNSCHEDULED ? title.trim() !== '' : true) &&
    odometerKm.trim() !== '' &&
    performedOn.trim() !== '' &&
    photo.status !== 'uploading';

  return (
    <form onSubmit={handleSubmit} className="space-y-6 border border-seam bg-panel p-5" aria-label="Log service">
      <fieldset>
        <legend className="eyebrow mb-3">What was done</legend>
        <div className="space-y-2">
          {scheduleItems.map((item) => (
            <label
              key={item.id}
              className="flex cursor-pointer items-center justify-between gap-3 border border-seam bg-panel-2 px-4 py-3 transition-colors has-[:checked]:border-bone has-[:focus-visible]:outline has-[:focus-visible]:outline-2 has-[:focus-visible]:outline-offset-2 has-[:focus-visible]:outline-bone hover:border-steel-dim"
            >
              <input
                type="radio"
                name="scheduleItem"
                value={item.id}
                checked={selectedItemId === item.id}
                onChange={() => setSelectedItemId(item.id)}
                className="sr-only"
              />
              <span className="min-w-0 truncate text-bone">{item.name}</span>
              <span className="mono-figures shrink-0 text-sm text-steel">{item.nextDueLabel}</span>
            </label>
          ))}

          <label className="flex cursor-pointer items-center justify-between gap-3 border border-seam bg-panel-2 px-4 py-3 transition-colors has-[:checked]:border-bone has-[:focus-visible]:outline has-[:focus-visible]:outline-2 has-[:focus-visible]:outline-offset-2 has-[:focus-visible]:outline-bone hover:border-steel-dim">
            <input
              type="radio"
              name="scheduleItem"
              value={UNSCHEDULED}
              checked={selectedItemId === UNSCHEDULED}
              onChange={() => setSelectedItemId(UNSCHEDULED)}
              className="sr-only"
            />
            <span className="text-bone">Unscheduled repair</span>
            <span className="text-sm text-steel">Not on the maintenance schedule</span>
          </label>
        </div>
      </fieldset>

      {selectedItemId === UNSCHEDULED && (
        <label className="block">
          <span className="mb-1.5 block text-sm text-steel">What was it?</span>
          <input
            value={title}
            onChange={(e) => setTitle(e.target.value)}
            maxLength={80}
            placeholder="e.g. Replaced flat tyre"
            autoComplete="off"
            className={FIELD_INPUT_CLASS}
          />
        </label>
      )}

      <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
        <label className="block">
          <span className="mb-1.5 block text-sm text-steel">Odometer (km)</span>
          <input
            value={odometerKm}
            onChange={(e) => setOdometerKm(e.target.value)}
            type="number"
            inputMode="numeric"
            min={1}
            className={`${FIELD_INPUT_CLASS} mono-figures`}
          />
        </label>
        <label className="block">
          <span className="mb-1.5 block text-sm text-steel">Date</span>
          <input
            value={performedOn}
            onChange={(e) => setPerformedOn(e.target.value)}
            type="date"
            max={today}
            className={`${FIELD_INPUT_CLASS} mono-figures`}
          />
        </label>
      </div>

      <label className="block">
        <span className="mb-1.5 block text-sm text-steel">Cost (QAR, optional)</span>
        <input
          value={costQar}
          onChange={(e) => setCostQar(e.target.value)}
          type="number"
          inputMode="decimal"
          min={0}
          step="0.01"
          placeholder="e.g. 250"
          className={`${FIELD_INPUT_CLASS} mono-figures`}
        />
      </label>

      <label className="block">
        <span className="mb-1.5 block text-sm text-steel">Notes (optional)</span>
        <textarea
          value={notes}
          onChange={(e) => setNotes(e.target.value)}
          maxLength={1000}
          rows={3}
          placeholder="Parts used, garage name, anything worth remembering"
          className="w-full border border-seam bg-panel-2 px-3 py-2 text-bone placeholder:text-steel-dim focus-visible:outline-none"
        />
      </label>

      {hasPhotoUpload ? (
        <div>
          <label className="block">
            <span className="mb-1.5 block text-sm text-steel">Invoice photo (optional)</span>
            <input
              type="file"
              accept={ALLOWED_PHOTO_TYPES.join(',')}
              onChange={handlePhotoChange}
              className="block w-full text-sm text-steel file:mr-4 file:border file:border-seam file:bg-panel-2 file:px-3 file:py-1.5 file:text-sm file:text-bone"
            />
          </label>
          {/* Task 7: invoice scan pre-fill — once an invoice photo is
              attached above, a future task reads it back with Claude and
              pre-fills odometer/date/cost/notes from the extraction
              (globals.md: extraction pre-fills forms, never auto-saves).
              This mount point is where that "Use scanned values" review UI
              will render once the photo finishes uploading. */}
          <div aria-live="polite">
            {photo.status === 'uploading' && (
              <p className="mt-1.5 text-sm text-steel">Uploading {photo.fileName}…</p>
            )}
            {photo.status === 'done' && (
              <p className="mt-1.5 text-sm text-steel">Attached: {photo.fileName}</p>
            )}
            {photo.status === 'error' && <p className="mt-1.5 text-sm text-red">{photo.message}</p>}
          </div>
        </div>
      ) : (
        <p className="text-sm text-steel-dim">Invoice photo uploads need Blob storage — coming with deploy.</p>
      )}

      {/* aria-live: this form's error appears asynchronously with no
          navigation on failure (a success redirects away entirely) — same
          reasoning as every other form in this app. */}
      <div aria-live="polite">
        {state.error && <p className="border-l-2 border-red pl-3 text-sm text-red">{state.error}</p>}
      </div>

      <button
        type="submit"
        disabled={isPending || !canSubmit}
        className="border border-seam px-5 py-2.5 text-sm font-medium text-bone transition-colors hover:bg-panel-2 disabled:cursor-not-allowed disabled:opacity-50"
      >
        {isPending ? 'Saving…' : 'Log service'}
      </button>
    </form>
  );
}
