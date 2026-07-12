/**
 * "Scan invoice" panel — mounted inside components/ServiceForm.tsx (Task 6's
 * marked mount point). Lets the user photograph a garage invoice, sends it
 * to app/api/ai/invoice/route.ts, and hands the parsed result back to
 * ServiceForm via `onExtracted` for PRE-FILLING only — this component never
 * writes anything itself (globals.md: "extraction pre-fills forms; never
 * auto-saves").
 *
 * WHY this is visible even when Blob photo storage isn't configured
 * (`hasPhotoStorage: false`): extraction only needs Claude's vision API, not
 * storage — app/api/ai/invoice/route.ts degrades to `photoUrl: null` when
 * there's no BLOB_READ_WRITE_TOKEN rather than failing the whole request.
 * The manual "Invoice photo" upload field elsewhere in ServiceForm genuinely
 * DOES require Blob (it calls `put()` directly with no fallback), so that
 * one stays gated — this component just says so in its own copy instead of
 * disappearing.
 */
'use client';

import { useRef, useState } from 'react';
import { ALLOWED_PHOTO_TYPES, MAX_PHOTO_BYTES, isAllowedPhotoType } from '@/lib/photo';
import type { AiInvoice } from '@/lib/types';

interface InvoiceScanResponse {
  extraction: AiInvoice;
  photoUrl: string | null;
}

// CONCEPT: a small state machine (rather than separate loading/error
// booleans) so "scanning" and "error" can never be simultaneously true —
// same reasoning as components/GenerateSchedule.tsx's FlowState. This
// state is scoped to the SCAN ATTEMPT only; it's entirely independent of
// ServiceForm's own PhotoState for the separate manual-attach field below
// this component.
type ScanState = { status: 'idle' } | { status: 'scanning' } | { status: 'error'; message: string };

interface InvoiceScanProps {
  hasPhotoStorage: boolean;
  onExtracted: (extraction: AiInvoice, photoUrl: string | null) => void;
}

export function InvoiceScan({ hasPhotoStorage, onExtracted }: InvoiceScanProps) {
  // The chosen File lives in plain component state (not tied to the input's
  // DOM value) so the "Scan invoice" button can read it on click — a native
  // file input's value can't be read except through its own change event,
  // so this is what lets scanning be a separate step from picking the file
  // (matching the brief's "choose file, then click Scan invoice" flow).
  const inputRef = useRef<HTMLInputElement>(null);
  const [file, setFile] = useState<File | null>(null);
  const [state, setState] = useState<ScanState>({ status: 'idle' });

  // Same client-side pre-check pattern as components/VehicleDetailsForm.tsx:
  // catches an obviously-wrong file the instant it's chosen, mirroring the
  // server's own rule via the shared lib/photo.ts constants — purely a
  // faster feedback loop, since app/api/ai/invoice/route.ts enforces the
  // same limits as the actual authority.
  function handleFileChange(e: React.ChangeEvent<HTMLInputElement>) {
    const selected = e.target.files?.[0] ?? null;
    if (!selected) {
      setFile(null);
      return;
    }
    if (!isAllowedPhotoType(selected.type)) {
      setState({ status: 'error', message: 'Photo must be a JPEG, PNG, or WEBP image.' });
      setFile(null);
      e.target.value = '';
      return;
    }
    if (selected.size > MAX_PHOTO_BYTES) {
      setState({ status: 'error', message: 'Photo must be 5MB or smaller.' });
      setFile(null);
      e.target.value = '';
      return;
    }
    setState({ status: 'idle' });
    setFile(selected);
  }

  async function handleScan() {
    if (!file) return;
    setState({ status: 'scanning' });
    try {
      const formData = new FormData();
      formData.set('photo', file);
      const res = await fetch('/api/ai/invoice', { method: 'POST', body: formData });
      const body = await res.json();

      if (!res.ok) {
        // The route's own message — never fabricate a friendlier one here;
        // manual entry (the rest of this form) stays fully usable either
        // way, since nothing above this point has touched any form field.
        setState({ status: 'error', message: body.error ?? 'Something went wrong.' });
        return;
      }

      const { extraction, photoUrl } = body as InvoiceScanResponse;
      onExtracted(extraction, photoUrl);
      setState({ status: 'idle' });
      setFile(null);
      if (inputRef.current) inputRef.current.value = '';
    } catch {
      // Network drop / DNS failure — never fabricate a result; the file
      // stays selected so "Scan invoice" doubles as the retry.
      setState({ status: 'error', message: 'Network error — check your connection and try again.' });
    }
  }

  const scanning = state.status === 'scanning';

  return (
    <div className="border border-seam bg-panel-2 p-4">
      <p className="eyebrow">AI Scan</p>
      <p className="mt-2 text-sm text-steel">
        Scan a garage invoice photo to pre-fill the fields below. Every field stays editable — nothing saves
        until you click Log service.
        {!hasPhotoStorage &&
          " The invoice photo itself won't be stored (photo storage isn't configured), but scanning still works."}
      </p>

      <div className="mt-3 flex flex-wrap items-center gap-3">
        <input
          ref={inputRef}
          type="file"
          accept={ALLOWED_PHOTO_TYPES.join(',')}
          onChange={handleFileChange}
          disabled={scanning}
          aria-label="Invoice photo to scan"
          className="block text-sm text-steel file:mr-4 file:border file:border-seam file:bg-panel file:px-3 file:py-1.5 file:text-sm file:text-bone disabled:opacity-50"
        />
        <button
          type="button"
          onClick={handleScan}
          disabled={!file || scanning}
          className="border border-seam px-4 py-1.5 text-sm font-medium text-bone transition-colors hover:bg-panel disabled:cursor-not-allowed disabled:opacity-50"
        >
          {scanning ? 'Reading invoice…' : 'Scan invoice'}
        </button>
      </div>

      {/* aria-live: this status appears asynchronously with no page
          navigation, same reasoning as every other async message in this
          app (e.g. components/GenerateSchedule.tsx's error). */}
      <div aria-live="polite">
        {scanning && <p className="mt-1.5 text-sm text-steel">Reading invoice…</p>}
        {state.status === 'error' && <p className="mt-1.5 text-sm text-red">{state.message}</p>}
      </div>
    </div>
  );
}
