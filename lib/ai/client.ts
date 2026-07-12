/**
 * Anthropic SDK client — the ONE place FleetIQ constructs an Anthropic
 * client. Every AI feature (schedule generation now, invoice extraction
 * later) imports `getAnthropic()` from here instead of `new Anthropic()`
 * itself, so the timeout/retry/fail-closed behavior below only has to be
 * right in one place (globals.md's "single lazy SDK client" rule).
 */
import Anthropic from '@anthropic-ai/sdk';

// Lazy singleton. WHY not a top-level `new Anthropic()`: Next.js imports route
// modules at build time, so an import-time throw would make builds require live
// keys. Failing closed on first USE keeps both rules: no key → clear 500 at
// request time, never a fabricated result; builds stay key-free.
let client: Anthropic | null = null;
export function getAnthropic(): Anthropic {
  if (!process.env.ANTHROPIC_API_KEY) throw new Error('ANTHROPIC_API_KEY is required');
  return (client ??= new Anthropic({ timeout: 60_000, maxRetries: 2 }));
}
export const MODEL = 'claude-sonnet-5';
