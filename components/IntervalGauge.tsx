/**
 * A thin horizontal gauge showing how much of a maintenance item's interval
 * has been consumed so far (lib/status.ts's intervalConsumedPct) — styled
 * after a real gauge's fill sweep. Purely decorative alongside the item's
 * own text (which already states the remaining km/days in words), so this
 * is `aria-hidden` throughout; nothing here is the only carrier of any
 * information a screen reader needs.
 *
 * Per .superpowers/sdd/globals.md: a 4px track (the --seam color), filled
 * green under 70%, amber 70–99%, red at 100%+ — AND the last 12% of the
 * TRACK itself is permanently tinted red, like a tachometer's redline zone,
 * regardless of how far the actual fill has reached.
 */
export function IntervalGauge({ pct }: { pct: number | null }) {
  const clamped = pct === null ? 0 : Math.min(100, Math.max(0, pct));
  const fillColor =
    pct === null ? 'var(--steel-dim)' : pct >= 100 ? 'var(--red)' : pct >= 70 ? 'var(--amber)' : 'var(--green)';

  return (
    <div aria-hidden="true" className="relative h-1 w-full overflow-hidden rounded-full bg-seam">
      {/* Redline zone — painted first (bottom layer) so the fill above it
          only shows through wherever the fill HASN'T yet reached; it's a
          fixed reference mark on the track, not derived from this item's
          own pct. */}
      <div className="absolute inset-y-0 right-0 w-[12%] bg-red/30" />
      <div
        className="absolute inset-y-0 left-0 transition-[width] duration-300 ease-out"
        style={{ width: `${clamped}%`, backgroundColor: fillColor }}
      />
    </div>
  );
}
