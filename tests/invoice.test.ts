// Unit tests for lib/ai/invoice.ts's prompt-independent parts — the pieces
// that don't need a real Claude call to verify:
//   1. `extractJson(msg, aiInvoiceSchema)` against a fake vision response,
//      mirroring tests/parse.test.ts's coverage but for the invoice schema
//      specifically (valid shape, fenced JSON, schema-violating negative
//      odometer).
//   2. `buildNotesFromExtraction` — a pure function of an already-parsed
//      AiInvoice, so it needs no Message/network fixture at all.
//
// No network calls anywhere here — extractInvoice itself (the function that
// actually calls client.messages.create) is exercised by Task 10's eval
// harness against the real API, not here.
import { describe, it, expect } from 'vitest';
import type Anthropic from '@anthropic-ai/sdk';
import { extractJson } from '@/lib/ai/parse';
import { buildNotesFromExtraction } from '@/lib/ai/invoice';
import { aiInvoiceSchema, MAX_SERVICE_NOTES_LENGTH, type AiInvoice } from '@/lib/types';

// Same fixture shape as tests/parse.test.ts's fakeMessage — duplicated
// rather than imported/shared because it's a small, self-contained piece of
// test scaffolding, not application code (see that file's header for the
// structural-typing reasoning on why a plain object works here).
function fakeMessage(content: Anthropic.Message['content']): Anthropic.Message {
  return {
    id: 'msg_test',
    container: null,
    content,
    model: 'claude-sonnet-5',
    role: 'assistant',
    stop_details: null,
    stop_reason: 'end_turn',
    stop_sequence: null,
    type: 'message',
    usage: {
      cache_creation: null,
      cache_creation_input_tokens: null,
      cache_read_input_tokens: null,
      inference_geo: null,
      input_tokens: 10,
      output_tokens: 10,
      output_tokens_details: null,
      server_tool_use: null,
      service_tier: null,
    },
  };
}

const validInvoice: AiInvoice = {
  garageName: 'Al Rayyan Auto Service',
  serviceDate: '2026-06-15',
  odometerKm: 45231,
  totalCostQar: 350,
  lineItems: [
    { description: 'Oil change', partOrService: 'service', costQar: 150 },
    { description: 'Oil filter', partOrService: 'part', costQar: 50 },
    { description: 'Labour', partOrService: 'other', costQar: 150 },
  ],
  confidenceNotes: '',
};

describe('extractJson against aiInvoiceSchema', () => {
  it('parses a valid invoice extraction from a single text block', () => {
    const msg = fakeMessage([{ type: 'text', citations: null, text: JSON.stringify(validInvoice) }]);
    const result = extractJson(msg, aiInvoiceSchema);
    expect(result).toEqual(validInvoice);
  });

  it('strips a ```json markdown fence before parsing', () => {
    const fenced = '```json\n' + JSON.stringify(validInvoice) + '\n```';
    const msg = fakeMessage([{ type: 'text', citations: null, text: fenced }]);
    const result = extractJson(msg, aiInvoiceSchema);
    expect(result).toEqual(validInvoice);
  });

  it('parses null fields for an unreadable invoice (never a guessed value)', () => {
    const unreadable = {
      garageName: null,
      serviceDate: null,
      odometerKm: null,
      totalCostQar: null,
      lineItems: [],
      confidenceNotes: 'Photo was too blurry to read anything reliably.',
    };
    const msg = fakeMessage([{ type: 'text', citations: null, text: JSON.stringify(unreadable) }]);
    const result = extractJson(msg, aiInvoiceSchema);
    expect(result).toEqual(unreadable);
  });

  it('throws AiParseError on a schema violation (negative odometer)', () => {
    const invalid = { ...validInvoice, odometerKm: -100 };
    const msg = fakeMessage([{ type: 'text', citations: null, text: JSON.stringify(invalid) }]);
    expect(() => extractJson(msg, aiInvoiceSchema)).toThrow();
  });

  it('throws on a schema violation (odometer of exactly 0, which .positive() rejects)', () => {
    const invalid = { ...validInvoice, odometerKm: 0 };
    const msg = fakeMessage([{ type: 'text', citations: null, text: JSON.stringify(invalid) }]);
    expect(() => extractJson(msg, aiInvoiceSchema)).toThrow();
  });
});

describe('buildNotesFromExtraction', () => {
  it('builds one "description — QAR cost" line per line item', () => {
    const extraction: AiInvoice = { ...validInvoice, confidenceNotes: '' };
    expect(buildNotesFromExtraction(extraction)).toBe(
      'Oil change — QAR 150\nOil filter — QAR 50\nLabour — QAR 150',
    );
  });

  it('omits "QAR null" for a line item with no cost — just the description', () => {
    const extraction: AiInvoice = {
      ...validInvoice,
      lineItems: [
        { description: 'Discount', partOrService: 'other', costQar: null },
        { description: 'Oil change', partOrService: 'service', costQar: 150 },
      ],
      confidenceNotes: '',
    };
    expect(buildNotesFromExtraction(extraction)).toBe('Discount\nOil change — QAR 150');
  });

  it('appends "AI notes: ..." when confidenceNotes is non-empty', () => {
    const extraction: AiInvoice = {
      ...validInvoice,
      lineItems: [{ description: 'Oil change', partOrService: 'service', costQar: 150 }],
      confidenceNotes: 'Odometer reading was handwritten and hard to read.',
    };
    expect(buildNotesFromExtraction(extraction)).toBe(
      'Oil change — QAR 150\nAI notes: Odometer reading was handwritten and hard to read.',
    );
  });

  it('does NOT append an "AI notes:" suffix when confidenceNotes is empty', () => {
    const extraction: AiInvoice = {
      ...validInvoice,
      lineItems: [{ description: 'Oil change', partOrService: 'service', costQar: 150 }],
      confidenceNotes: '',
    };
    expect(buildNotesFromExtraction(extraction)).not.toContain('AI notes:');
  });

  it('does NOT append an "AI notes:" suffix when confidenceNotes is only whitespace', () => {
    const extraction: AiInvoice = {
      ...validInvoice,
      lineItems: [{ description: 'Oil change', partOrService: 'service', costQar: 150 }],
      confidenceNotes: '   ',
    };
    expect(buildNotesFromExtraction(extraction)).not.toContain('AI notes:');
  });

  it('handles no line items and only confidenceNotes (no stray leading blank line)', () => {
    const extraction: AiInvoice = {
      garageName: null,
      serviceDate: null,
      odometerKm: null,
      totalCostQar: null,
      lineItems: [],
      confidenceNotes: 'Entire invoice was illegible.',
    };
    expect(buildNotesFromExtraction(extraction)).toBe('AI notes: Entire invoice was illegible.');
  });

  it('returns an empty string when there are no line items and no confidenceNotes', () => {
    const extraction: AiInvoice = {
      garageName: 'Some Garage',
      serviceDate: null,
      odometerKm: null,
      totalCostQar: null,
      lineItems: [],
      confidenceNotes: '',
    };
    expect(buildNotesFromExtraction(extraction)).toBe('');
  });

  it('truncates the summary at MAX_SERVICE_NOTES_LENGTH characters', () => {
    const longDescription = 'x'.repeat(2000);
    const extraction: AiInvoice = {
      garageName: null,
      serviceDate: null,
      odometerKm: null,
      totalCostQar: null,
      lineItems: [{ description: longDescription, partOrService: 'other', costQar: null }],
      confidenceNotes: '',
    };
    const result = buildNotesFromExtraction(extraction);
    expect(result.length).toBe(MAX_SERVICE_NOTES_LENGTH);
    expect(result).toBe(longDescription.slice(0, MAX_SERVICE_NOTES_LENGTH));
  });
});
