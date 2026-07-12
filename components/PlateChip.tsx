/**
 * A small stylized rendering of a Qatari vehicle plate — white background,
 * black mono digits, a narrow maroon accent band down the left edge (per
 * .superpowers/sdd/globals.md's design system) — used anywhere a vehicle's
 * plate number appears (dashboard rows, the detail page header). Purely
 * presentational: no data fetching, no interactivity.
 *
 * WHY it renders nothing at all for a null plate, rather than an empty chip
 * or a "—" placeholder: a vehicle added without a plate yet (task-4-brief.md
 * allows this) shouldn't get a chip-shaped gap in the layout implying a
 * plate exists but is blank — the caller's own layout (flex/gap) already
 * collapses cleanly around a component that renders null.
 */
export function PlateChip({ plate }: { plate: string | null }) {
  if (plate === null) return null;

  return (
    <span
      className="mono-figures inline-flex items-stretch overflow-hidden rounded"
      aria-label={`Plate ${plate}`}
    >
      {/* The maroon band is decorative (mimicking a real plate's printed
          accent stripe), not a status color — globals.md's "red/amber/green
          are the ONLY saturated colors, used ONLY for status" rule is about
          the app's own signal colors, not about faithfully reproducing a
          real-world object's actual colors. */}
      <span className="w-1.5 bg-[#7a1f2b]" aria-hidden="true" />
      <span className="bg-white px-2 py-0.5 text-xs font-semibold tracking-wider text-black">{plate}</span>
    </span>
  );
}
