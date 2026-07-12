/**
 * AI invoice/receipt extraction — reads a photographed garage invoice with
 * Claude's vision API and turns it into the structured `AiInvoice` shape
 * (lib/types.ts) that components/ServiceForm.tsx pre-fills from. Called
 * from app/api/ai/invoice/route.ts (a live request) and directly from
 * Task 10's eval script (no network/Next.js request needed) — same
 * dependency-injection reasoning as lib/ai/schedule.ts's `generateSchedule`:
 * the Anthropic client is a PARAMETER, not fetched internally via
 * getAnthropic(), so a plain script can call this against the real API
 * without going through a Next.js request at all.
 *
 * `buildNotesFromExtraction` lives in this file too (not inlined in
 * components/ServiceForm.tsx) so Task 10's eval and this file's own tests
 * can exercise the exact summary text a real scan would pre-fill, without
 * needing a browser. It's a PURE function (no Anthropic import in its own
 * call graph) — see its own comment below for why that separation matters.
 */
import type Anthropic from '@anthropic-ai/sdk';
// WHY `./model`, not `./client`: this file's buildNotesFromExtraction is
// reachable from a 'use client' component (components/ServiceForm.tsx) —
// importing MODEL from lib/ai/client.ts would drag that file's top-level
// `import Anthropic from '@anthropic-ai/sdk'` into the browser bundle along
// with it, purely to read a constant string. See lib/ai/model.ts's header.
import { MODEL } from './model';
import { extractJson } from './parse';
import { aiInvoiceSchema, MAX_SERVICE_NOTES_LENGTH, type AiInvoice } from '../types';

// CONCEPT: spelling out every field, its type, and its null case directly in
// the prompt (rather than just pointing at the Zod schema) is what makes
// Claude's JSON match aiInvoiceSchema on the first try — the model never
// sees the schema, only this text.
const PROMPT = `Extract structured data from this garage invoice/receipt photo. Read carefully — this is a real invoice, not a sample.

Extract:
- "garageName": the garage/shop name, or null if not legible
- "serviceDate": the service date in ISO format YYYY-MM-DD, or null if not legible or not present
- "odometerKm": the odometer reading in kilometers as a number, or null if not present or not legible. Handwritten numbers are especially easy to misread — if you are not confident, return null rather than guess, and explain why in confidenceNotes.
- "totalCostQar": the total amount charged, as a number, or null if not legible
- "lineItems": an array of {"description": string, "partOrService": "part" | "service" | "other", "costQar": number | null} for each line item on the invoice. Use "other" when a line item is neither clearly a part nor a service (e.g. a discount, a tax line, a disposal fee).
- "confidenceNotes": a short plain-English note on anything you weren't fully sure about — an unreadable field, an ambiguous handwritten number, a currency that wasn't QAR, anything you had to make a best-effort read on. Return an empty string "" if the invoice was fully legible with nothing to flag.

Rules:
- If a field is unreadable, blurry, cropped out, or simply not present on the invoice, return null for it. NEVER guess a plausible-sounding number — a wrong guess is worse than a blank field the person can fill in themselves.
- Assume all amounts are in Qatari Riyal (QAR) unless the invoice clearly states a different currency. If it does, report the ORIGINAL amount/currency in confidenceNotes instead of silently converting it — never invent an exchange rate.
- Respond with ONLY a JSON object of this exact shape, no other text, no markdown fence:
{"garageName": string | null, "serviceDate": string | null, "odometerKm": number | null, "totalCostQar": number | null, "lineItems": [{"description": string, "partOrService": "part" | "service" | "other", "costQar": number | null}], "confidenceNotes": string}`;

export interface InvoiceImage {
  base64: string;
  mediaType: 'image/jpeg' | 'image/png' | 'image/webp';
}

export async function extractInvoice(client: Anthropic, image: InvoiceImage): Promise<AiInvoice> {
  const msg = await client.messages.create({
    model: MODEL,
    max_tokens: 2000,
    messages: [
      {
        role: 'user',
        content: [
          { type: 'image', source: { type: 'base64', media_type: image.mediaType, data: image.base64 } },
          { type: 'text', text: PROMPT },
        ],
      },
    ],
  });

  return extractJson(msg, aiInvoiceSchema);
}

// Turns a raw extraction into the notes-field summary components/
// ServiceForm.tsx pre-fills — one line per invoice line item ("description
// — QAR cost"), followed by the model's own confidenceNotes if it flagged
// anything, truncated to the same MAX_SERVICE_NOTES_LENGTH the notes field
// itself enforces (lib/types.ts's completeServiceInputSchema).
//
// WHY this is a plain function of `AiInvoice` (no Anthropic/client.ts import
// anywhere in ITS call graph) rather than something computed inline where
// it's used: components/ServiceForm.tsx is a 'use client' component, so
// whatever it imports gets bundled into the BROWSER. If this function lived
// behind an import chain that pulls in lib/ai/client.ts's `new Anthropic()`
// call (needed by extractInvoice/getAnthropic, NOT by this function), the
// whole Anthropic SDK would ship to the browser just to format a notes
// string. This file still exports both functions — extractInvoice DOES
// depend on MODEL from ./client — but ServiceForm only ever calls
// buildNotesFromExtraction, and this function's own body never touches
// anything from ./client, so a tree-shaking bundler can drop that whole
// branch from the client bundle. (Verified via `npm run build`'s route
// bundle-size output — see task-7-report.md.)
export function buildNotesFromExtraction(extraction: AiInvoice): string {
  const lineSummaries = extraction.lineItems.map((item) =>
    item.costQar !== null ? `${item.description} — QAR ${item.costQar}` : item.description,
  );

  const confidenceNotes = extraction.confidenceNotes.trim();
  const parts = [lineSummaries.join('\n'), confidenceNotes ? `AI notes: ${confidenceNotes}` : ''].filter(
    (part) => part !== '',
  );

  return parts.join('\n').slice(0, MAX_SERVICE_NOTES_LENGTH);
}
