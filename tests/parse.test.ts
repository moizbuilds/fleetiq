// Unit tests for lib/ai/parse.ts — the "get JSON out of a Claude response"
// helper every AI feature shares.
//
// WHY these are written before lib/ai/parse.ts's behavior is trusted (TDD):
// this module exists specifically to survive a handful of real-world
// response shapes (thinking block first, markdown-fenced JSON, plain JSON)
// while rejecting garbage and schema mismatches with one consistent error
// type. Asserting each shape up front means the implementation has to
// actually handle all of them, not just whichever one was written first.
//
// No network calls anywhere here — see fakeMessage() below.
import { describe, it, expect } from 'vitest';
import type Anthropic from '@anthropic-ai/sdk';
import { extractJson, AiParseError } from '@/lib/ai/parse';
import { aiScheduleSchema } from '@/lib/types';

// CONCEPT: structural typing — TypeScript only checks that this plain
// object has every field Anthropic.Message's interface declares; it doesn't
// care that the object was never touched by the real SDK or a network call.
// That's what lets these tests build a fake "response" entirely in memory.
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

const validSchedule = {
  items: [
    {
      name: 'Oil change',
      intervalKm: 10000,
      intervalMonths: 6,
      brandRecommendations: ['Castrol', 'Mobil 1'],
      rationale: 'Standard interval for this engine in hot climates.',
    },
  ],
};

describe('extractJson', () => {
  it('parses plain JSON in a single text block', () => {
    const msg = fakeMessage([
      { type: 'text', citations: null, text: JSON.stringify(validSchedule) },
    ]);

    const result = extractJson(msg, aiScheduleSchema);
    expect(result).toEqual(validSchedule);
  });

  it('finds the text block even when a thinking block comes first', () => {
    const msg = fakeMessage([
      { type: 'thinking', thinking: 'Let me consider the vehicle...', signature: 'sig' },
      { type: 'text', citations: null, text: JSON.stringify(validSchedule) },
    ]);

    const result = extractJson(msg, aiScheduleSchema);
    expect(result).toEqual(validSchedule);
  });

  it('strips a ```json markdown fence before parsing', () => {
    const fenced = '```json\n' + JSON.stringify(validSchedule) + '\n```';
    const msg = fakeMessage([{ type: 'text', citations: null, text: fenced }]);

    const result = extractJson(msg, aiScheduleSchema);
    expect(result).toEqual(validSchedule);
  });

  it('strips a plain ``` fence (no language tag) before parsing', () => {
    const fenced = '```\n' + JSON.stringify(validSchedule) + '\n```';
    const msg = fakeMessage([{ type: 'text', citations: null, text: fenced }]);

    const result = extractJson(msg, aiScheduleSchema);
    expect(result).toEqual(validSchedule);
  });

  it('throws AiParseError on garbage (not JSON at all)', () => {
    const msg = fakeMessage([
      { type: 'text', citations: null, text: 'Sorry, I cannot help with that.' },
    ]);

    expect(() => extractJson(msg, aiScheduleSchema)).toThrow(AiParseError);
  });

  it('throws AiParseError when there is no text block at all', () => {
    const msg = fakeMessage([
      { type: 'thinking', thinking: 'Just thinking, no answer yet.', signature: 'sig' },
    ]);

    expect(() => extractJson(msg, aiScheduleSchema)).toThrow(AiParseError);
  });

  it('throws AiParseError (with the ZodError surfaced as cause) when valid JSON fails the schema', () => {
    const invalidShape = { items: [{ name: 'Oil change' /* missing everything else */ }] };
    const msg = fakeMessage([{ type: 'text', citations: null, text: JSON.stringify(invalidShape) }]);

    try {
      extractJson(msg, aiScheduleSchema);
      expect.unreachable('extractJson should have thrown');
    } catch (err) {
      expect(err).toBeInstanceOf(AiParseError);
      expect((err as AiParseError).cause).toBeDefined();
    }
  });
});
