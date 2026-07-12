/**
 * Editable review table for an AI-generated maintenance schedule — shown
 * after app/api/ai/schedule/route.ts returns Claude's draft, before
 * anything is saved (globals.md: "extraction pre-fills forms; never
 * auto-saves"). Every field is editable so an obviously-wrong AI value
 * (a bad interval, a brand that isn't sold locally) can be corrected before
 * the user commits to it via the "Accept schedule" button.
 *
 * WHY this needs its own row-state model instead of editing AiScheduleItem
 * objects directly: an AiScheduleItem's intervalKm/intervalMonths are
 * `number | null`, but a controlled <input type="number"> needs a STRING
 * value (an empty string for "blank", never `null` or `NaN`) — converting
 * between the two happens once, at the row/item boundary (toEditableRow /
 * toAiScheduleItem below), instead of scattering `?? ''` and manual
 * `Number(...)` calls throughout the JSX.
 */
'use client';

import { useState, useTransition } from 'react';
import { acceptSchedule } from '@/lib/actions/schedule';
import type { AiScheduleItem } from '@/lib/types';

const FIELD_INPUT_CLASS =
  'w-full border border-seam bg-panel-2 px-2 py-1.5 text-sm text-bone placeholder:text-steel-dim focus-visible:outline-none';

interface EditableRow {
  key: string;
  name: string;
  km: string;
  months: string;
  brands: string;
  rationale: string;
}

// CONCEPT: crypto.randomUUID() generates a client-only identifier used
// purely as React's list `key` — it's never sent to the server. WHY not the
// row's array index: deleting a row in the middle of the list shifts every
// later row's index, and React would then reuse the WRONG row's input
// state for whichever row slides into that index next — the project's
// identity rule (globals.md), just applied at the row level instead of the
// whole-component level.
function toEditableRow(item: AiScheduleItem): EditableRow {
  return {
    key: crypto.randomUUID(),
    name: item.name,
    km: item.intervalKm !== null ? item.intervalKm.toString() : '',
    months: item.intervalMonths !== null ? item.intervalMonths.toString() : '',
    brands: item.brandRecommendations.join(', '),
    rationale: item.rationale,
  };
}

function emptyRow(): EditableRow {
  return { key: crypto.randomUUID(), name: '', km: '', months: '', brands: '', rationale: '' };
}

// Converts one edited row back into the shape acceptSchedule (and its
// server-side aiScheduleSchema re-validation) expects — blank number
// fields become `null`, and the comma-joined brands text splits back into
// a string array with empty entries (a trailing comma, a double comma)
// dropped.
function toAiScheduleItem(row: EditableRow): AiScheduleItem {
  const km = row.km.trim();
  const months = row.months.trim();
  return {
    name: row.name,
    intervalKm: km === '' ? null : Number(km),
    intervalMonths: months === '' ? null : Number(months),
    brandRecommendations: row.brands
      .split(',')
      .map((b) => b.trim())
      .filter((b) => b.length > 0),
    rationale: row.rationale,
  };
}

export function ScheduleReview({ vehicleId, items }: { vehicleId: string; items: AiScheduleItem[] }) {
  // Seeded once from the props passed in when this component first
  // mounts — the parent (app/vehicles/[id]/page.tsx's client button) only
  // ever renders this component once per successful generation, so there's
  // no later prop change this state needs to react to.
  const [rows, setRows] = useState<EditableRow[]>(() => items.map(toEditableRow));
  const [error, setError] = useState<string | null>(null);
  const [isPending, startTransition] = useTransition();

  function updateRow(key: string, patch: Partial<EditableRow>) {
    setRows((prev) => prev.map((r) => (r.key === key ? { ...r, ...patch } : r)));
  }

  function deleteRow(key: string) {
    setRows((prev) => prev.filter((r) => r.key !== key));
  }

  function addRow() {
    setRows((prev) => [...prev, emptyRow()]);
  }

  function handleAccept() {
    setError(null);
    startTransition(async () => {
      const result = await acceptSchedule(vehicleId, rows.map(toAiScheduleItem));
      // On success acceptSchedule calls redirect(), which throws
      // internally and never returns here at all — this branch only runs
      // when it comes back with a validation/ownership error instead.
      if (result?.error) {
        setError(result.error);
      }
    });
  }

  return (
    <div className="space-y-6">
      {/* Disclaimer banner — styled distinctly from the rest of the page
          (panel-2 fill + its own eyebrow) so it reads as a persistent
          caveat, not a dismissible toast. Amber is deliberately NOT used
          here: amber is reserved for due-soon status only (globals.md). */}
      <div className="border border-seam bg-panel-2 p-4">
        <p className="eyebrow">AI Schedule</p>
        <p className="mt-2 text-sm text-bone">AI-recommended — verify against your owner&apos;s manual.</p>
        <p className="mt-1 text-sm text-steel">
          Brand suggestions are AI suggestions — verify local availability.
        </p>
      </div>

      <div className="overflow-x-auto border border-seam bg-panel">
        <table className="w-full min-w-[760px] text-left text-sm">
          <thead>
            <tr className="border-b border-seam text-steel">
              <th className="px-3 py-2 font-medium">Item</th>
              <th className="px-3 py-2 font-medium">Interval (km)</th>
              <th className="px-3 py-2 font-medium">Interval (months)</th>
              <th className="px-3 py-2 font-medium">Brands</th>
              <th className="px-3 py-2 font-medium">Rationale</th>
              <th className="px-3 py-2 font-medium">
                <span className="sr-only">Remove</span>
              </th>
            </tr>
          </thead>
          <tbody>
            {rows.map((row) => (
              <tr key={row.key} className="border-b border-seam last:border-b-0">
                <td className="px-3 py-2">
                  <input
                    value={row.name}
                    onChange={(e) => updateRow(row.key, { name: e.target.value })}
                    maxLength={60}
                    className={FIELD_INPUT_CLASS}
                    aria-label="Item name"
                  />
                </td>
                <td className="px-3 py-2">
                  <input
                    value={row.km}
                    onChange={(e) => updateRow(row.key, { km: e.target.value })}
                    type="number"
                    inputMode="numeric"
                    min={1}
                    className={`${FIELD_INPUT_CLASS} mono-figures`}
                    aria-label="Interval in kilometers"
                  />
                </td>
                <td className="px-3 py-2">
                  <input
                    value={row.months}
                    onChange={(e) => updateRow(row.key, { months: e.target.value })}
                    type="number"
                    inputMode="numeric"
                    min={1}
                    className={`${FIELD_INPUT_CLASS} mono-figures`}
                    aria-label="Interval in months"
                  />
                </td>
                <td className="px-3 py-2">
                  <input
                    value={row.brands}
                    onChange={(e) => updateRow(row.key, { brands: e.target.value })}
                    placeholder="e.g. Castrol, Mobil 1"
                    className={FIELD_INPUT_CLASS}
                    aria-label="Brand recommendations, comma separated"
                  />
                </td>
                <td className="px-3 py-2 text-steel" title={row.rationale}>
                  {row.rationale || '—'}
                </td>
                <td className="px-3 py-2">
                  <button
                    type="button"
                    onClick={() => deleteRow(row.key)}
                    className="border border-seam px-2 py-1 text-xs text-red transition-colors hover:bg-panel-2"
                  >
                    Remove
                  </button>
                </td>
              </tr>
            ))}
            {rows.length === 0 && (
              <tr>
                <td colSpan={6} className="px-3 py-4 text-center text-steel">
                  No items — add one below or generate again.
                </td>
              </tr>
            )}
          </tbody>
        </table>
      </div>

      <button
        type="button"
        onClick={addRow}
        className="border border-seam px-4 py-2 text-sm text-steel transition-colors hover:bg-panel-2 hover:text-bone"
      >
        + Add item
      </button>

      {/* aria-live: an accept failure re-renders this message with no page
          navigation, same reasoning as the vehicle-add form's error. */}
      <div aria-live="polite">
        {error && <p className="border-l-2 border-red pl-3 text-sm text-red">{error}</p>}
      </div>

      <button
        type="button"
        onClick={handleAccept}
        disabled={isPending || rows.length === 0}
        className="border border-seam px-5 py-2.5 text-sm font-medium text-bone transition-colors hover:bg-panel-2 disabled:cursor-not-allowed disabled:opacity-50"
      >
        {isPending ? 'Saving…' : 'Accept schedule'}
      </button>
    </div>
  );
}
