/**
 * The Claude model id every AI feature in FleetIQ calls — kept in its own
 * zero-dependency file (rather than living in lib/ai/client.ts, where it
 * originally did) so a module that only needs this STRING doesn't also pull
 * in the real Anthropic SDK constructor.
 *
 * WHY this split exists: lib/ai/invoice.ts's `buildNotesFromExtraction` is
 * a pure function reachable from components/ServiceForm.tsx, a 'use client'
 * component — anything it imports ships to the BROWSER. Before this file
 * existed, invoice.ts imported MODEL from lib/ai/client.ts, and client.ts's
 * top-level `import Anthropic from '@anthropic-ai/sdk'` (needed by
 * getAnthropic(), not by MODEL) came along with it — confirmed by
 * `npm run build`'s client chunk output containing the SDK's constructor
 * logic (an `ANTHROPIC_API_KEY` env-var lookup) inside a ~450KB browser
 * bundle for a form that only ever formats a notes string. lib/ai/client.ts
 * now re-exports MODEL from here so nothing importing it via './client'
 * had to change.
 */
export const MODEL = 'claude-sonnet-5';
