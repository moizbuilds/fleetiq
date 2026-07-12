/**
 * Vehicle detail page's service history — newest first (lib/queries.ts's
 * getVehicleDetail already orders it that way). Every field (date, title,
 * km, cost, invoice link) stays fully visible; only a long notes field
 * truncates, with an inline "Show more" toggle per row, so one wordy
 * service log entry can't push every other entry off screen.
 */
'use client';

import { useState } from 'react';
import { formatKm } from '@/lib/status';
import type { VehicleDetail } from '@/lib/types';

const NOTE_PREVIEW_LENGTH = 140;

export function HistoryTimeline({ entries }: { entries: VehicleDetail['history'] }) {
  if (entries.length === 0) {
    return <p className="text-sm text-steel">No services logged yet.</p>;
  }

  return (
    <ol className="space-y-3">
      {entries.map((entry) => (
        <HistoryRow key={entry.id} entry={entry} />
      ))}
    </ol>
  );
}

function HistoryRow({ entry }: { entry: VehicleDetail['history'][number] }) {
  const [expanded, setExpanded] = useState(false);
  const needsTruncation = (entry.notes?.length ?? 0) > NOTE_PREVIEW_LENGTH;
  const shownNotes =
    entry.notes === null ? null : expanded || !needsTruncation ? entry.notes : `${entry.notes.slice(0, NOTE_PREVIEW_LENGTH)}…`;

  return (
    <li className="border border-seam bg-panel p-4">
      <div className="flex flex-wrap items-baseline justify-between gap-x-4 gap-y-1">
        <div className="min-w-0">
          <span className="mono-figures text-xs text-steel-dim">{entry.performedOn}</span>
          <p className="mt-0.5 text-bone">{entry.title}</p>
          {entry.scheduleItemName && entry.scheduleItemName !== entry.title && (
            <p className="text-xs text-steel">{entry.scheduleItemName}</p>
          )}
        </div>
        <div className="ml-auto flex items-baseline gap-4 text-right">
          <span className="mono-figures text-sm text-steel">{formatKm(entry.odometerKm)}</span>
          <span className="mono-figures text-sm text-bone">
            {entry.costQar !== null ? `${Number(entry.costQar).toFixed(2)} QAR` : '—'}
          </span>
        </div>
      </div>

      {shownNotes && (
        <p className="mt-2 text-sm text-steel">
          {shownNotes}{' '}
          {needsTruncation && (
            <button
              type="button"
              onClick={() => setExpanded((e) => !e)}
              className="text-steel underline decoration-seam underline-offset-4 hover:text-bone"
            >
              {expanded ? 'Show less' : 'Show more'}
            </button>
          )}
        </p>
      )}

      {entry.invoicePhotoUrl && (
        <a
          href={entry.invoicePhotoUrl}
          target="_blank"
          rel="noopener noreferrer"
          className="mt-2 inline-block text-xs text-steel underline decoration-seam underline-offset-4 hover:text-bone"
        >
          Invoice ↗<span className="sr-only"> (opens in a new tab)</span>
        </a>
      )}
    </li>
  );
}
