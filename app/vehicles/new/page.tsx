/**
 * Add-vehicle page ("/vehicles/new") — Task 4.
 *
 * This is a Server Component whose only job is a single environment check:
 * whether Vercel Blob is configured at all. That decision has to happen on
 * the server (env vars aren't readable in the browser), and it has to
 * happen before the form renders — the naive alternative (always rendering
 * a photo field, then failing at submit time if Blob isn't configured)
 * would let a user fill out a whole form only to discover the photo upload
 * never had anywhere to go.
 *
 * WHY it also reads a `vin` search param (fix round 1, ruling #3): the
 * dashboard's empty-fleet state (components/EmptyFleetVin.tsx) navigates
 * here as `/vehicles/new?vin=<VIN>` instead of decoding inline itself, so
 * VehicleForm's own decode flow runs exactly once, in exactly one place.
 * `vin` comes straight from the URL — attacker/user-controlled — but it's
 * never trusted directly: it's only ever handed to VehicleForm as a
 * plain STRING to re-validate and (if it looks like a real VIN) feed through
 * the SAME `/api/vin` fetch a manual "Decode VIN" click would trigger, so a
 * malformed or malicious query string just fails that validation like any
 * other bad VIN typed by hand.
 */
import { VehicleForm } from '@/components/VehicleForm';

export default async function NewVehiclePage({
  searchParams,
}: {
  searchParams: Promise<{ vin?: string }>;
}) {
  const hasPhotoUpload = Boolean(process.env.BLOB_READ_WRITE_TOKEN);
  const { vin } = await searchParams;

  return (
    <div>
      <h1 className="eyebrow">Add vehicle</h1>
      <p className="mt-3 text-steel">
        Decode a VIN to pre-fill the details, or skip straight to a manual entry.
      </p>
      <div className="mt-6">
        <VehicleForm hasPhotoUpload={hasPhotoUpload} initialVin={vin ?? null} />
      </div>
    </div>
  );
}
