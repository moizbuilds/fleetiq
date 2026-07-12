/**
 * Dashboard route ("/") — the instrument-panel fleet overview: one row per
 * vehicle, worst-first, each showing its odometer and worst maintenance/
 * compliance item at a glance. Full design (Task 8) replacing the Task 1
 * placeholder — see .superpowers/sdd/globals.md's Design System section
 * and lib/queries.ts's getFleetStatus for how each row's data is computed.
 */
import Link from 'next/link';
import { requireTenant } from '@/lib/auth';
import { getDb } from '@/lib/db';
import { getFleetStatus } from '@/lib/queries';
import { VehicleRow } from '@/components/VehicleRow';

export default async function Home() {
  const { tenantId } = await requireTenant();
  const db = getDb();
  const fleet = await getFleetStatus(db, tenantId, new Date());

  if (fleet.length === 0) {
    return (
      <div className="flex min-h-[60vh] flex-col items-center justify-center text-center">
        <p className="eyebrow">No vehicles</p>
        <p className="mt-3 max-w-sm text-sm text-steel">Add your first vehicle to start tracking.</p>
        <Link
          href="/vehicles/new"
          className="mt-6 border border-seam px-5 py-2.5 text-sm font-medium text-bone transition-colors hover:bg-panel-2"
        >
          Add vehicle
        </Link>
      </div>
    );
  }

  const overdueCount = fleet.filter((v) => v.worst.state === 'overdue').length;
  const dueSoonCount = fleet.filter((v) => v.worst.state === 'due_soon').length;
  // A vehicle with nothing tracked yet (no schedule, no compliance dates)
  // folds into the "ok" count here — there's nothing overdue or due soon
  // about it, and this top-line strip only has three colored buckets
  // (globals.md: red/amber/green are the only saturated colors). Its row
  // still reads "No maintenance items yet" further down, so this fold-in
  // never hides the actual state from anyone looking at the row itself.
  const okCount = fleet.length - overdueCount - dueSoonCount;

  return (
    <div>
      <p className="eyebrow">Fleet status</p>
      <p className="mono-figures mt-2 text-sm">
        <span className="text-red">{overdueCount} overdue</span>
        <span className="text-steel-dim"> · </span>
        <span className="text-amber">{dueSoonCount} due soon</span>
        <span className="text-steel-dim"> · </span>
        <span className="text-green">{okCount} ok</span>
      </p>

      <div className="mt-6 space-y-3">
        {fleet.map((vehicle, index) => (
          <VehicleRow key={vehicle.id} vehicle={vehicle} index={index} />
        ))}
      </div>
    </div>
  );
}
