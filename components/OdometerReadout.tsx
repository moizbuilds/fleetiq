/**
 * The odometer readout — the dashboard/detail page's signature "each digit
 * gets its own cell" numeric display, styled after a mechanical odometer
 * drum. Every digit lives in its own bordered box so
 * components/IgnitionSequence.tsx can roll the whole readout up from zero
 * on page load, the way a real odometer's wheels spin into place.
 *
 * WHY grouping is a wider GAP between digit cells instead of rendering a
 * comma character in its own cell: a comma isn't a digit — giving it a
 * full bordered cell like every other character would visually claim it's
 * "part of the number", the way a real 6-wheel odometer drum has no comma
 * wheel at all, just evenly spaced digit wheels with a small physical gap
 * between thousand-groups.
 *
 * `size="lg"` is the dashboard's big centerpiece readout; `size="sm"` is
 * the vehicle detail page header's smaller inline version.
 */
import { formatKm } from '@/lib/status';

const CELL_CLASS: Record<'lg' | 'sm', string> = {
  lg: 'h-12 w-8 text-xl sm:h-14 sm:w-9 sm:text-2xl',
  sm: 'h-8 w-5 text-sm',
};

export function OdometerReadout({ km, size = 'lg' }: { km: number | null; size?: 'lg' | 'sm' }) {
  const cellClass = CELL_CLASS[size];

  if (km === null) {
    const placeholderDigitCount = size === 'lg' ? 6 : 5;
    return (
      <span className="inline-flex items-center gap-2">
        <span className="inline-flex gap-0.5" aria-hidden="true">
          {Array.from({ length: placeholderDigitCount }).map((_, i) => (
            <span
              key={i}
              className={`mono-figures flex items-center justify-center border border-seam bg-panel-2 font-semibold text-steel-dim ${cellClass}`}
            >
              —
            </span>
          ))}
        </span>
        {/* One "no reading yet" for assistive tech (announced instead of
            five meaningless dashes), one visible-but-aria-hidden so a
            sighted user gets the same words without a screen reader
            announcing them twice. */}
        <span className="sr-only">no reading yet</span>
        <span aria-hidden="true" className="text-xs text-steel-dim">
          no reading yet
        </span>
      </span>
    );
  }

  const groups = km.toLocaleString('en-US').split(',');

  return (
    <span className="inline-flex items-center gap-2">
      <span className="inline-flex gap-1.5" aria-hidden="true">
        {groups.map((group, gi) => (
          <span key={gi} className="inline-flex gap-0.5">
            {group.split('').map((digit, di) => (
              <span
                key={di}
                className={`mono-figures flex items-center justify-center border border-seam bg-panel-2 font-semibold text-bone ${cellClass}`}
              >
                {digit}
              </span>
            ))}
          </span>
        ))}
      </span>
      <span className="sr-only">{formatKm(km)}</span>
      <span aria-hidden="true" className="text-xs text-steel">
        km
      </span>
    </span>
  );
}
