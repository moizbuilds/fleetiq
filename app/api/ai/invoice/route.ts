/**
 * AI invoice-extraction API — POST /api/ai/invoice with a multipart
 * FormData `photo` field. Reads a photographed garage invoice with Claude's
 * vision capability and returns structured fields for components/
 * ServiceForm.tsx to PRE-FILL — this route never writes to the database
 * (globals.md: "extraction pre-fills forms; never auto-saves"). Saving only
 * happens when the user reviews the pre-filled form and clicks "Log
 * service", which goes through lib/actions/services.ts's completeService
 * exactly like a fully manual entry would.
 *
 * WHY this is a Route Handler taking multipart FormData directly, rather
 * than the two-step "upload via Server Action, then pass a URL back" shape
 * lib/actions/services.ts's uploadInvoicePhoto uses: extraction needs the
 * raw image BYTES to send to Claude's vision API, not a URL to fetch back —
 * so the photo has to arrive as a real file upload to begin with. The Blob
 * upload below (so the photo can be displayed/audited later) piggybacks on
 * that same already-received file instead of asking the browser to upload
 * it a second time.
 *
 * WHY `await auth()` + `resolveTenantId()` instead of `requireTenant()`:
 * same reasoning as app/api/ai/schedule/route.ts — a fetch() caller needs a
 * parseable 401 JSON body, never requireTenant()'s redirect().
 */
import { randomUUID } from 'node:crypto';
import { NextResponse } from 'next/server';
import { put } from '@vercel/blob';
import { getApiAuth, resolveTenantId } from '@/lib/auth';
import { getDb } from '@/lib/db';
import { getAnthropic } from '@/lib/ai/client';
import { extractInvoice, type InvoiceImage } from '@/lib/ai/invoice';
import { checkRateLimit, RATE_LIMITS } from '@/lib/rate-limit';
import { MAX_PHOTO_BYTES, isAllowedPhotoType } from '@/lib/photo';
import type { InvoiceExtractionResponse } from '@/lib/types';

const BAD_PHOTO_MESSAGE = 'Upload a JPEG, PNG or WebP photo.';
const EXTRACTION_FAILED_MESSAGE = "Couldn't read this invoice — fill the form manually.";

// Maps an already-validated photo MIME type to the file extension the Blob
// pathname uses. This is the only place in the app that turns a MIME type
// back into a filename extension — lib/actions/services.ts's
// uploadInvoicePhoto has the browser's original filename to work with
// instead, so it never needed this.
const EXTENSION_BY_TYPE: Record<string, string> = {
  'image/jpeg': 'jpg',
  'image/png': 'png',
  'image/webp': 'webp',
};

export async function POST(request: Request) {
  const { userId, orgId } = await getApiAuth();
  if (!userId) {
    return NextResponse.json({ error: 'Not signed in' }, { status: 401 });
  }
  const tenantId = await resolveTenantId(userId, orgId ?? null);

  const db = getDb();

  // Rate limit BEFORE ever reading the upload body, same ordering rule as
  // app/api/ai/schedule/route.ts — a tenant that's already exhausted its
  // hourly budget gets the same 429 whether or not they even attached a
  // valid photo.
  const { invoice: invoiceLimit } = RATE_LIMITS;
  const rateLimit = await checkRateLimit(db, tenantId, 'invoice', invoiceLimit.limit, invoiceLimit.windowMinutes);
  if (!rateLimit.allowed) {
    return NextResponse.json(
      {
        error: `Invoice scanning is limited to ${invoiceLimit.limit} per hour. Try again in ${rateLimit.retryAfterMinutes} minutes.`,
      },
      { status: 429 },
    );
  }

  let formData: FormData;
  try {
    formData = await request.formData();
  } catch {
    // Not a parseable multipart body at all — same user-facing message as
    // "no valid photo attached" below; there's no meaningful distinction to
    // surface to a real client that only ever sends FormData.
    return NextResponse.json({ error: BAD_PHOTO_MESSAGE }, { status: 415 });
  }

  const photo = formData.get('photo');
  if (!(photo instanceof File) || photo.size === 0 || !isAllowedPhotoType(photo.type)) {
    return NextResponse.json({ error: BAD_PHOTO_MESSAGE }, { status: 415 });
  }
  if (photo.size > MAX_PHOTO_BYTES) {
    return NextResponse.json({ error: 'Photo must be 5MB or smaller.' }, { status: 413 });
  }

  const bytes = await photo.arrayBuffer();
  const base64 = Buffer.from(bytes).toString('base64');
  // Safe cast: isAllowedPhotoType above already narrowed photo.type to one
  // of exactly these three strings — see lib/photo.ts's ALLOWED_PHOTO_TYPES.
  const image: InvoiceImage = { base64, mediaType: photo.type as InvoiceImage['mediaType'] };

  let extraction;
  try {
    extraction = await extractInvoice(getAnthropic(), image);
  } catch {
    // Covers a Claude API failure (network, 5xx, timeout) AND a parse/schema
    // failure (lib/ai/parse.ts's AiParseError) — same "never fabricate a
    // result" reasoning as app/api/ai/schedule/route.ts. Manual entry is
    // still the fallback: this route never got far enough to touch the
    // database either way.
    return NextResponse.json({ error: EXTRACTION_FAILED_MESSAGE }, { status: 502 });
  }

  // Blob upload is best-effort. WHY it can't assume a token exists the way
  // lib/actions/services.ts's uploadInvoicePhoto does: that action is only
  // ever reachable from a form field ServiceForm hides entirely when
  // `hasPhotoUpload` (== Boolean(BLOB_READ_WRITE_TOKEN)) is false. THIS
  // route has no such gate on the caller side — extraction is useful with
  // or without photo storage — so it has to check for itself and degrade to
  // `photoUrl: null` rather than let `put()` throw with no token
  // configured. A working extraction is still worth returning even if the
  // Blob upload itself fails for some other reason (a transient network
  // blip): the user gets pre-filled fields either way, only the stored
  // photo attachment is lost.
  let photoUrl: string | null = null;
  if (process.env.BLOB_READ_WRITE_TOKEN) {
    try {
      // No `?? 'jpg'` fallback here: photo.type was already checked against
      // isAllowedPhotoType above (line 84), which only returns true for
      // exactly the three keys this map defines — an unmapped type can
      // never reach this line, so a fallback here would be dead code.
      const ext = EXTENSION_BY_TYPE[photo.type];
      const blob = await put(`invoices/${tenantId}/${randomUUID()}.${ext}`, photo, { access: 'public' });
      photoUrl = blob.url;
    } catch {
      photoUrl = null;
    }
  }

  // Annotated against the shared lib/types.ts contract (final review, item
  // 4) instead of an inline object literal — components/InvoiceScan.tsx casts
  // its fetch() response to this exact same type, so a field renamed or
  // dropped on either side now fails `tsc`, instead of only surfacing as a
  // silent `undefined` in the browser.
  const responseBody: InvoiceExtractionResponse = { extraction, photoUrl };
  return NextResponse.json(responseBody);
}
