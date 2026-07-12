/**
 * Extracts and validates structured JSON out of a raw Anthropic Messages API
 * response. Every AI feature that asks Claude for JSON (schedule generation
 * now, invoice extraction later) parses the response through this one
 * function instead of hand-rolling `JSON.parse(msg.content[0].text)` at each
 * call site.
 *
 * WHY that naive version breaks: `content[0]` is not reliably the text block.
 * Extended-thinking models can emit a `thinking` block BEFORE the `text`
 * block in the same response — code that blindly reads index 0 would try to
 * JSON.parse the model's internal reasoning and fail (or, worse, "succeed"
 * on the wrong data) the moment thinking is ever enabled. Finding the first
 * block whose `type` is literally `'text'` is the only version that's
 * correct regardless of what other block types precede it (globals.md's
 * Anthropic-response-parsing rule).
 *
 * WHY strip markdown fences before JSON.parse: even when a prompt asks for
 * "ONLY a JSON object", models sometimes wrap the answer in a ```json ...```
 * code fence out of habit. Stripping a leading/trailing fence (if present)
 * before parsing means a strict prompt still degrades gracefully instead of
 * throwing on cosmetic formatting.
 */
import type Anthropic from '@anthropic-ai/sdk';
import type { z } from 'zod';

// A dedicated error type (rather than letting JSON.parse's SyntaxError or a
// ZodError propagate directly) so every caller — the schedule route, the
// future invoice route — can catch exactly one error type and turn it into
// the same "couldn't generate right now" 502 response, regardless of
// whether the failure was "no text block", "not JSON", or "valid JSON, wrong
// shape". The original error (a SyntaxError or ZodError) is attached via the
// standard `cause` option, so it's still inspectable in logs — "surfaced",
// not swallowed — without forcing every call site to know about three
// different exception types.
export class AiParseError extends Error {
  constructor(message: string, options?: { cause?: unknown }) {
    super(message, options);
    this.name = 'AiParseError';
  }
}

export function extractJson<T>(msg: Anthropic.Message, schema: z.ZodType<T>): T {
  // CONCEPT: structural typing — `msg.content` is typed as
  // `Array<ContentBlock>`, a union of block shapes that all share a `type`
  // field. `.find` narrows to the `TextBlock` variant only where `type` is
  // literally `'text'`, which is what makes `block.text` type-check below.
  const textBlock = msg.content.find(
    (block): block is Anthropic.TextBlock => block.type === 'text',
  );

  if (!textBlock) {
    throw new AiParseError('Claude response had no text block to parse.');
  }

  const stripped = textBlock.text
    .trim()
    .replace(/^```(?:json)?\s*/i, '')
    .replace(/\s*```$/, '')
    .trim();

  let parsed: unknown;
  try {
    parsed = JSON.parse(stripped);
  } catch (cause) {
    throw new AiParseError('Claude response was not valid JSON.', { cause });
  }

  const result = schema.safeParse(parsed);
  if (!result.success) {
    throw new AiParseError('Claude response did not match the expected shape.', {
      cause: result.error,
    });
  }

  return result.data;
}
