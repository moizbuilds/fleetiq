/**
 * One vehicle's row on the dashboard (app/page.tsx) — the app's signature
 * "gauge cluster" look: a slot-numbered eyebrow + nickname, a plate chip, a
 * big odometer readout, and the vehicle's single worst maintenance/
 * compliance item with its own lamp strip and interval gauge — all inside
 * one full-width panel that's a single link to the vehicle's detail page.
 * Wrapped in IgnitionSequence so the whole row performs its "lights up,
 * then settles" self-test on first load.
 *
 * 'use client': IgnitionSequence's render-prop (`children` as a function)
 * can only be passed from one Client Component to another — a function
 * can't cross the Server-to-Client boundary (React Server Components can't
 * serialize a closure). Since app/page.tsx (a Server Component) only ever
 * passes this component plain, serializable vehicle data, marking THIS
 * component 'use client' keeps that boundary in exactly one place.
 */
'use client';

import Link from 'next/link';
import { OdometerReadout } from './OdometerReadout';
import { AnnunciatorLamp } from './AnnunciatorLamp';
import { IntervalGauge } from './IntervalGauge';
import { PlateChip } from './PlateChip';
import { IgnitionSequence } from './IgnitionSequence';
import type { FleetVehicleStatus, ItemState } from '@/lib/types';

// A dashboard row only ever shows up to 5 lamps at once — beyond that, a
// "+N" count takes over rather than the lamp strip growing unbounded for a
// vehicle with a long neglected schedule.
const MAX_LAMPS = 5;

const WORST_TEXT_COLOR: Record<ItemState, string> = {
  overdue: 'text-red',
  due_soon: 'text-amber',
  ok: 'text-green',
  no_data: 'text-steel-dim',
};

export function VehicleRow({ vehicle, index }: { vehicle: FleetVehicleStatus; index: number }) {
  // The lamp strip only shows items that AREN'T fully ok — an all-ok
  // vehicle's row has no lamps at all, the same "quiet unless something
  // needs attention" instrument-panel philosophy as the lamps themselves.
  const attentionItems = vehicle.items.filter((item) => item.status.state !== 'ok');
  const shownLamps = attentionItems.slice(0, MAX_LAMPS);
  const overflowCount = attentionItems.length - shownLamps.length;

  const worstItem = vehicle.items[0] ?? null;
  const worstLabel = worstItem ? `${worstItem.name} — ${worstItem.status.label}` : 'No maintenance items yet';
  const worstColorClass = WORST_TEXT_COLOR[vehicle.worst.state];

  return (
    <IgnitionSequence targetKm={vehicle.latestReadingKm} lampCount={shownLamps.length}>
      {(anim) => (
        <Link
          href={`/vehicles/${vehicle.id}`}
          className="group block border border-seam bg-panel p-5 transition-colors hover:border-steel-dim focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-bone"
        >
          <div className="flex flex-col gap-6 md:flex-row md:items-center md:justify-between">
            {/* Left: identity */}
            <div className="min-w-0 md:w-64 md:shrink-0">
              <p className="eyebrow truncate">
                VEHICLE {String(index + 1).padStart(2, '0')} · {vehicle.nickname}
              </p>
              <div className="mt-2 flex flex-wrap items-center gap-2">
                <PlateChip plate={vehicle.plate} />
                <span className="text-sm text-steel">
                  {[vehicle.make, vehicle.model, vehicle.year].filter(Boolean).join(' ') || '—'}
                </span>
              </div>
            </div>

            {/* Center: odometer */}
            <div className="min-w-0 md:flex-1 md:px-6">
              <OdometerReadout km={anim.displayKm} size="lg" />
            </div>

            {/* Right: worst item + lamp strip + gauge */}
            <div className="min-w-0 md:w-72 md:shrink-0">
              <p className={`mono-figures truncate text-sm ${worstColorClass}`}>{worstLabel}</p>

              {shownLamps.length > 0 && (
                <div className="mt-2 flex items-center gap-1.5">
                  {shownLamps.map((item, i) => (
                    <AnnunciatorLamp
                      key={item.id}
                      state={item.status.state}
                      label={`${item.name}: ${item.status.label}`}
                      lit={anim.flashing[i] || anim.settled}
                    />
                  ))}
                  {overflowCount > 0 && <span className="mono-figures text-xs text-steel-dim">+{overflowCount}</span>}
                </div>
              )}

              {worstItem && (
                <div className="mt-2">
                  <IntervalGauge pct={worstItem.intervalConsumedPct} />
                </div>
              )}
            </div>
          </div>
        </Link>
      )}
    </IgnitionSequence>
  );
}
