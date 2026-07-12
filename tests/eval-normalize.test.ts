// Unit tests for evals/lib/normalize.ts — the scoring normalizer the
// invoice eval (evals/invoice/run.ts) relies on to decide whether an AI
// extraction "matches" gold. This normalizer is real logic that can be
// wrong (an off-by-one in the Arabic-digit map, a punctuation regex that
// eats a real character, a date parser that gets day/month backwards) — so
// per Moiz's eval standard ("normalize scoring carefully... don't let a
// naive string-match under- or overstate accuracy"), it gets its own
// free/pure test file here rather than only being exercised indirectly by
// a real (paid) eval run.
import { describe, it, expect } from 'vitest';
import {
  easternArabicToAscii,
  parseNumber,
  normalizeString,
  normalizeDate,
  numbersMatch,
  stringsMatch,
  datesMatch,
  scoreLineItems,
} from '@/evals/lib/normalize';

describe('easternArabicToAscii', () => {
  it('converts Eastern Arabic-Indic digits to ASCII', () => {
    expect(easternArabicToAscii('١٢٥٠')).toBe('1250');
  });

  it('leaves ASCII digits and other characters untouched', () => {
    expect(easternArabicToAscii('QAR 1250.00')).toBe('QAR 1250.00');
  });
});

describe('parseNumber', () => {
  it('parses a currency-formatted string with commas and decimals', () => {
    expect(parseNumber('QAR 1,250.00')).toBe(1250);
  });

  it('parses Eastern Arabic-Indic digits', () => {
    expect(parseNumber('١٢٥٠')).toBe(1250);
  });

  it('parses a plain number value unchanged', () => {
    expect(parseNumber(1250)).toBe(1250);
    expect(parseNumber(45231)).toBe(45231);
  });

  it('parses a plain numeric string', () => {
    expect(parseNumber('159.75')).toBe(159.75);
  });

  it('returns null for null, undefined, and unparseable input', () => {
    expect(parseNumber(null)).toBeNull();
    expect(parseNumber(undefined)).toBeNull();
    expect(parseNumber('not a number')).toBeNull();
  });

  it('does not silently coerce an unparseable value to 0', () => {
    // A scorer that treated "unparseable" as 0 would make a garbled
    // extraction look like a confident (and wrong) zero-cost answer.
    expect(parseNumber('N/A')).not.toBe(0);
    expect(parseNumber('N/A')).toBeNull();
  });
});

describe('normalizeString', () => {
  it('casefolds, trims, and collapses internal whitespace', () => {
    expect(normalizeString('  Al Rayyan   Auto Care  ')).toBe('al rayyan auto care');
  });

  it('strips punctuation that does not change meaning', () => {
    expect(normalizeString('Al-Rayyan Auto Care!!')).toBe('al rayyan auto care');
    expect(normalizeString('Oil Change.')).toBe('oil change');
  });

  it('treats null/undefined as empty string', () => {
    expect(normalizeString(null)).toBe('');
    expect(normalizeString(undefined)).toBe('');
  });
});

describe('normalizeDate', () => {
  it('passes through an ISO YYYY-MM-DD date', () => {
    expect(normalizeDate('2026-06-15')).toBe('2026-06-15');
  });

  it('converts DD/MM/YYYY (Qatar day-first convention) to ISO', () => {
    expect(normalizeDate('15/06/2026')).toBe('2026-06-15');
  });

  it('converts DD-MM-YYYY to ISO', () => {
    expect(normalizeDate('15-06-2026')).toBe('2026-06-15');
  });

  it('returns null for null/undefined/unparseable input', () => {
    expect(normalizeDate(null)).toBeNull();
    expect(normalizeDate(undefined)).toBeNull();
    expect(normalizeDate('not a date')).toBeNull();
  });
});

describe('numbersMatch', () => {
  it('matches equal numbers exactly (tolerance 0 by default)', () => {
    expect(numbersMatch(1250, 1250)).toBe(true);
  });

  it('matches a currency-formatted string against a plain number', () => {
    expect(numbersMatch('QAR 1,250.00', 1250)).toBe(true);
  });

  it('treats null as matching only null', () => {
    expect(numbersMatch(null, null)).toBe(true);
    expect(numbersMatch(null, 1250)).toBe(false);
    expect(numbersMatch(1250, null)).toBe(false);
  });

  it('rejects a mismatched number even by a small amount at tolerance 0', () => {
    expect(numbersMatch(1250, 1251)).toBe(false);
  });

  it('respects a positive tolerance when given one', () => {
    expect(numbersMatch(1250, 1251, 1)).toBe(true);
    expect(numbersMatch(1250, 1260, 1)).toBe(false);
  });
});

describe('stringsMatch', () => {
  it('matches after casefold/punctuation normalization', () => {
    expect(stringsMatch('Al Rayyan Auto Care', 'al rayyan auto care')).toBe(true);
    expect(stringsMatch('Al-Rayyan Auto Care', 'Al Rayyan Auto Care')).toBe(true);
  });

  it('treats null as matching only null', () => {
    expect(stringsMatch(null, null)).toBe(true);
    expect(stringsMatch(null, 'Al Rayyan Auto Care')).toBe(false);
  });

  it('rejects genuinely different strings', () => {
    expect(stringsMatch('Al Rayyan Auto Care', 'Doha Motors Workshop')).toBe(false);
  });
});

describe('datesMatch', () => {
  it('matches an ISO date against a day-first slash date for the same day', () => {
    expect(datesMatch('2026-06-15', '15/06/2026')).toBe(true);
  });

  it('treats null as matching only null', () => {
    expect(datesMatch(null, null)).toBe(true);
    expect(datesMatch(null, '2026-06-15')).toBe(false);
  });

  it('rejects different dates', () => {
    expect(datesMatch('2026-06-15', '2026-06-16')).toBe(false);
  });
});

describe('scoreLineItems', () => {
  it('scores a perfect match as precision=recall=f1=1', () => {
    const gold = [{ description: 'Engine oil change' }, { description: 'Oil filter' }];
    const predicted = [{ description: 'engine oil change' }, { description: 'OIL FILTER' }];
    expect(scoreLineItems(predicted, gold)).toEqual({ precision: 1, recall: 1, f1: 1 });
  });

  it('scores partial overlap correctly', () => {
    // 1 correct, 1 extra (false positive), 1 missed (false negative)
    const gold = [{ description: 'Engine oil change' }, { description: 'Oil filter' }];
    const predicted = [{ description: 'Engine oil change' }, { description: 'Brake pads' }];
    const score = scoreLineItems(predicted, gold);
    expect(score.precision).toBeCloseTo(0.5);
    expect(score.recall).toBeCloseTo(0.5);
    expect(score.f1).toBeCloseTo(0.5);
  });

  it('scores zero predictions against a non-empty gold as all zero', () => {
    expect(scoreLineItems([], [{ description: 'Engine oil change' }])).toEqual({ precision: 0, recall: 0, f1: 0 });
  });

  it('scores an empty gold with no predictions as a perfect match', () => {
    expect(scoreLineItems([], [])).toEqual({ precision: 1, recall: 1, f1: 1 });
  });
});
