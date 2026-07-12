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
 */
import { VehicleForm } from '@/components/VehicleForm';

export default function NewVehiclePage() {
  const hasPhotoUpload = Boolean(process.env.BLOB_READ_WRITE_TOKEN);

  return (
    <div>
      <h1 className="eyebrow">Add vehicle</h1>
      <p className="mt-3 text-steel">
        Decode a VIN to pre-fill the details, or skip straight to a manual entry.
      </p>
      <div className="mt-6">
        <VehicleForm hasPhotoUpload={hasPhotoUpload} />
      </div>
    </div>
  );
}
