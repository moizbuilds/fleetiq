/**
 * Settings page's tracker-integration panel (Task 9) — lets a tenant
 * generate (or regenerate) the API key their GPS tracker device uses to
 * authenticate against app/api/integrations/odometer/route.ts, and shows
 * the webhook's connection docs (endpoint, header, example request) below
 * it.
 *
 * WHY the raw key only ever lives in THIS component's state, never in a
 * prop from the server: lib/actions/apiKeys.ts's rotateApiKey stores only
 * the key's hash and returns the raw string exactly once, to whichever
 * request just generated it. app/settings/page.tsx (a Server Component)
 * only ever knows whether a key exists and when it was created — it can't
 * hand this component a raw key because the server itself doesn't have one
 * to give after the initial response.
 */
'use client';

import { useState, useTransition } from 'react';
import { rotateApiKey } from '@/lib/actions/apiKeys';

interface ApiKeyPanelProps {
  keyCreatedAtLabel: string | null; // null = no key generated yet
  endpointUrl: string;
}

const EXAMPLE_BODY = `{
  "vin": "1HGCM82633A004352",
  "readingKm": 84210
}`;

export function ApiKeyPanel({ keyCreatedAtLabel, endpointUrl }: ApiKeyPanelProps) {
  const [createdAtLabel, setCreatedAtLabel] = useState(keyCreatedAtLabel);
  const [rawKey, setRawKey] = useState<string | null>(null);
  const [confirming, setConfirming] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);
  const [isPending, startTransition] = useTransition();

  const hasKey = createdAtLabel !== null;

  function generate() {
    setError(null);
    startTransition(async () => {
      try {
        const result = await rotateApiKey();
        setRawKey(result.raw);
        setCreatedAtLabel('just now');
        setConfirming(false);
        setCopied(false);
      } catch {
        setError("Couldn't generate a key right now — try again.");
      }
    });
  }

  async function handleCopy() {
    if (!rawKey) return;
    // CONCEPT: navigator.clipboard.writeText is the browser API for
    // programmatically copying text — it needs a secure context (https, or
    // localhost in dev), which every real deployment of this app already is.
    await navigator.clipboard.writeText(rawKey);
    setCopied(true);
    setTimeout(() => setCopied(false), 2000);
  }

  return (
    <div className="space-y-6">
      <div className="border border-seam bg-panel p-5">
        <p className="eyebrow">Tracker API key</p>

        {!hasKey && !confirming && (
          <div className="mt-4">
            <p className="text-sm text-steel">No key generated yet — a tracker device can&apos;t connect until one exists.</p>
            <button
              type="button"
              onClick={generate}
              disabled={isPending}
              className="mt-4 border border-seam px-5 py-2.5 text-sm font-medium text-bone transition-colors hover:bg-panel-2 disabled:cursor-not-allowed disabled:opacity-50"
            >
              {isPending ? 'Generating…' : 'Generate key'}
            </button>
          </div>
        )}

        {hasKey && !confirming && (
          <div className="mt-4 flex flex-wrap items-center justify-between gap-3">
            <p className="text-sm text-steel">
              Key created <span className="mono-figures text-bone">{createdAtLabel}</span>
            </p>
            <button
              type="button"
              onClick={() => setConfirming(true)}
              className="border border-red px-4 py-2 text-sm text-red transition-colors hover:bg-panel-2"
            >
              Regenerate key
            </button>
          </div>
        )}

        {confirming && (
          <div className="mt-4 space-y-3 border-t border-seam pt-4">
            <p className="text-sm text-steel">
              The old key stops working immediately. Any tracker device using it will need the new one.
            </p>
            <div className="flex gap-2">
              <button
                type="button"
                onClick={generate}
                disabled={isPending}
                className="border border-red px-4 py-2 text-sm text-red transition-colors hover:bg-panel-2 disabled:cursor-not-allowed disabled:opacity-50"
              >
                {isPending ? 'Regenerating…' : 'Yes, regenerate'}
              </button>
              <button
                type="button"
                onClick={() => setConfirming(false)}
                className="border border-seam px-4 py-2 text-sm text-steel transition-colors hover:bg-panel-2 hover:text-bone"
              >
                Cancel
              </button>
            </div>
          </div>
        )}

        {/* aria-live: the error/success states below appear asynchronously
            with no navigation, same reasoning as every other inline form in
            this app (e.g. components/OdometerForm.tsx). */}
        <div aria-live="polite">
          {error && <p className="mt-3 border-l-2 border-red pl-3 text-sm text-red">{error}</p>}

          {rawKey && (
            <div className="mt-4 border border-seam bg-panel-2 p-4">
              <p className="eyebrow">Shown once — store it safely</p>
              <div className="mt-2 flex flex-wrap items-center gap-3">
                <code className="mono-figures break-all text-sm text-bone">{rawKey}</code>
                <button
                  type="button"
                  onClick={handleCopy}
                  className="shrink-0 border border-seam px-3 py-1.5 text-xs text-bone transition-colors hover:bg-panel"
                >
                  {copied ? 'Copied' : 'Copy'}
                </button>
              </div>
              <p className="mt-2 text-xs text-steel-dim">
                This key will not be shown again. If you lose it, regenerate a new one.
              </p>
            </div>
          )}
        </div>
      </div>

      <div className="border border-seam bg-panel p-5">
        <p className="eyebrow">Connecting a GPS tracker</p>
        <p className="mt-3 text-sm text-steel">
          Configure your tracker (or its integration platform) to POST each odometer reading to this endpoint.
        </p>

        <dl className="mt-4 space-y-3 text-sm">
          <div>
            <dt className="text-steel">Endpoint</dt>
            <dd className="mono-figures mt-1 break-all text-bone">{endpointUrl}</dd>
          </div>
          <div>
            <dt className="text-steel">Auth header</dt>
            <dd className="mono-figures mt-1 text-bone">x-fleetiq-key: &lt;your key&gt;</dd>
          </div>
        </dl>

        <p className="mt-4 text-sm text-steel">Example request:</p>
        <pre className="mono-figures mt-2 overflow-x-auto border border-seam bg-panel-2 p-4 text-xs text-bone">
          {`curl -X POST ${endpointUrl} \\
  -H "x-fleetiq-key: fiq_xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx" \\
  -H "Content-Type: application/json" \\
  -d '${EXAMPLE_BODY.replace(/\n\s*/g, ' ')}'`}
        </pre>

        <p className="mt-3 text-xs text-steel-dim">
          Send either <code className="mono-figures">vin</code> or <code className="mono-figures">vehicleId</code> (not
          both). <code className="mono-figures">recordedAt</code> is accepted but ignored — every reading is
          timestamped by the server, never by the device&apos;s own clock. A reading below the vehicle&apos;s last
          known mileage is rejected (409) rather than silently accepted, so a tracker glitch can&apos;t corrupt the
          vehicle&apos;s history.
        </p>
      </div>
    </div>
  );
}
