/**
 * evals/lib/normalize.ts
 *
 * Normalization + comparison helpers shared by the invoice eval's scorer
 * (evals/lib/score.ts) and unit-tested for free in tests/eval-normalize.test.ts.
 *
 * WHY this needs to exist at all: comparing an AI extraction to a gold
 * answer with `===` would fail on formatting differences that don't
 * represent a real mistake — "QAR 1,250.00" vs 1250, "Al Rayyan Auto Care"
 * vs "al-rayyan auto care  ", "15/06/2026" vs "2026-06-15". A naive
 * string-match scorer would either under-count correct answers (penalizing
 * cosmetic differences) or, if built too loosely, over-count wrong ones —
 * exactly the failure mode Moiz's eval standard calls out ("normalize
 * scoring carefully... don't let a naive string-match under- or overstate
 * accuracy"). Every comparison the invoice scorer makes goes through one of
 * the functions below so that rule is enforced in exactly one place.
 *
 * WHY numbersMatch/stringsMatch/datesMatch take BOTH sides through the same
 * normalizer instead of normalizing only the model's output: the gold JSON
 * is hand-authored and could itself contain "250" vs "250.0" or extra
 * whitespace — normalizing symmetrically means a gold-authoring quirk can
 * never masquerade as (or mask) a real scoring bug.
 */

// ---------------------------------------------------------------------------
// Eastern Arabic-Indic digits (٠-٩) -> ASCII digits (0-9).
//
// WHY this is needed: one of the 15 synthetic invoice fixtures renders its
// subtotal using Eastern Arabic numerals (as a real Qatar garage receipt
// sometimes does) specifically to test whether Claude's vision reading
// correctly interprets the VALUE of those glyphs rather than choking on
// them. The model is expected to respond with a normal ASCII number either
// way (the schema requires z.number()) — this helper exists so the
// normalizer itself (and its unit tests) can be verified independent of any
// real model call, and as defense-in-depth if a raw string ever needs
// parsing (e.g. hand-authoring gold data by eye off a fixture spec).
// ---------------------------------------------------------------------------
const EASTERN_ARABIC_DIGITS: Record<string, string> = {
  '٠': '0',
  '١': '1',
  '٢': '2',
  '٣': '3',
  '٤': '4',
  '٥': '5',
  '٦': '6',
  '٧': '7',
  '٨': '8',
  '٩': '9',
};

export function easternArabicToAscii(input: string): string {
  return input.replace(/[٠-٩]/g, (digit) => EASTERN_ARABIC_DIGITS[digit] ?? digit);
}

// Parses a number out of either an already-numeric value or a
// currency-formatted string ("QAR 1,250.00", "١٢٥٠", "1250"). Returns null
// for anything that isn't parseable, rather than 0 or NaN — a scorer that
// silently coerced "unparseable" to 0 would make a garbled extraction look
// like a confident (and wrong) zero-cost answer instead of a clear miss.
export function parseNumber(value: unknown): number | null {
  if (value === null || value === undefined) return null;
  if (typeof value === 'number') return Number.isFinite(value) ? value : null;
  if (typeof value !== 'string') return null;

  const ascii = easternArabicToAscii(value);
  // Strip currency words/symbols and thousands-separator commas, then pull
  // out the first signed decimal number left in the string.
  const stripped = ascii.replace(/qar|ر\.?ق\.?/gi, '').replace(/,/g, '');
  const match = stripped.match(/-?\d+(?:\.\d+)?/);
  if (!match) return null;

  const parsed = parseFloat(match[0]);
  return Number.isFinite(parsed) ? parsed : null;
}

// Casefold + trim + collapse internal whitespace + strip punctuation.
// WHY strip punctuation rather than just lowercase+trim: garage names and
// line-item descriptions are the fields most likely to differ only in
// punctuation between what the model reads and what gold says ("Al-Rayyan"
// vs "Al Rayyan", "Oil Change." vs "oil change") — none of those represent
// a real extraction error.
//
// WHY punctuation is replaced with a SPACE, not deleted outright: deleting
// "-" would turn "Al-Rayyan" into "alrayyan" (one word) while "Al Rayyan"
// normalizes to "al rayyan" (two words) — a real bug this file's own test
// suite (tests/eval-normalize.test.ts) caught, where two spellings of the
// exact same garage name failed to match after normalization. Replacing
// with a space first, THEN collapsing repeated whitespace, means either
// spelling converges on the same "al rayyan".
export function normalizeString(value: string | null | undefined): string {
  if (value === null || value === undefined) return '';
  return value
    .normalize('NFKC') // collapse full-width/compatibility variants first
    .toLowerCase()
    .replace(/[.,/#!$%^&*;:{}=\-_`~()"'’]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

// Normalizes a date string to YYYY-MM-DD, or null if it can't be parsed.
// Handles the ISO format the schema/prompt asks for directly, plus
// DD/MM/YYYY and DD-MM-YYYY (Qatar's everyday day-first convention) as a
// defensive fallback in case a model ever drifts from the requested format.
// WHY day-first (not month-first) for the slash/dash fallback: this app's
// entire audience is Qatar-based (globals.md's Gulf/Qatar framing) — a
// bare "05/06/2026" from this app's data almost certainly means 5 June, not
// May 6th.
export function normalizeDate(value: string | null | undefined): string | null {
  if (!value) return null;
  const ascii = easternArabicToAscii(value.trim());

  const iso = ascii.match(/^(\d{4})-(\d{2})-(\d{2})/);
  if (iso) return `${iso[1]}-${iso[2]}-${iso[3]}`;

  const dayFirst = ascii.match(/^(\d{1,2})[/-](\d{1,2})[/-](\d{4})$/);
  if (dayFirst) {
    const [, day, month, year] = dayFirst;
    return `${year}-${month.padStart(2, '0')}-${day.padStart(2, '0')}`;
  }

  return null;
}

// ---------------------------------------------------------------------------
// Symmetric comparators — null only ever matches null (an extraction that
// confidently returns a wrong number is a different failure than one that
// correctly abstained with null, so the two must never compare equal).
// ---------------------------------------------------------------------------

export function numbersMatch(a: unknown, b: unknown, tolerance = 0): boolean {
  const na = parseNumber(a);
  const nb = parseNumber(b);
  if (na === null && nb === null) return true;
  if (na === null || nb === null) return false;
  return Math.abs(na - nb) <= tolerance;
}

export function stringsMatch(a: string | null | undefined, b: string | null | undefined): boolean {
  const sa = normalizeString(a);
  const sb = normalizeString(b);
  const aWasNull = a === null || a === undefined;
  const bWasNull = b === null || b === undefined;
  if (aWasNull && bWasNull) return true;
  if (aWasNull || bWasNull) return false;
  return sa === sb;
}

export function datesMatch(a: string | null | undefined, b: string | null | undefined): boolean {
  const da = normalizeDate(a);
  const db = normalizeDate(b);
  if (da === null && db === null) return true;
  if (da === null || db === null) return false;
  return da === db;
}

// ---------------------------------------------------------------------------
// Line-item scoring: set overlap on normalized description, reported as
// precision/recall/F1 rather than exact-order/exact-count equality — the
// AI has no reason to list line items in the same order as the invoice, and
// the brief calls for "set overlap", not a positional diff.
//
// WHY a Set (not a multiset/bag): two distinct line items on the same
// invoice occasionally share a description ("Labour" appearing twice) —
// collapsing duplicates trades a small amount of precision at that edge for
// a much simpler, well-understood metric. Documented here rather than
// silently changing behavior if it's ever revisited.
// ---------------------------------------------------------------------------
export interface LineItemLike {
  description: string;
}

export interface LineItemScore {
  precision: number;
  recall: number;
  f1: number;
}

export function scoreLineItems(predicted: LineItemLike[], gold: LineItemLike[]): LineItemScore {
  const predSet = new Set(predicted.map((item) => normalizeString(item.description)).filter((d) => d !== ''));
  const goldSet = new Set(gold.map((item) => normalizeString(item.description)).filter((d) => d !== ''));

  if (goldSet.size === 0) {
    // Nothing to find — a prediction with nothing extra is a perfect
    // match; any extra predicted item is a false positive against an
    // empty gold set.
    return predSet.size === 0 ? { precision: 1, recall: 1, f1: 1 } : { precision: 0, recall: 1, f1: 0 };
  }
  if (predSet.size === 0) return { precision: 0, recall: 0, f1: 0 };

  let matches = 0;
  for (const desc of predSet) if (goldSet.has(desc)) matches++;

  const precision = matches / predSet.size;
  const recall = matches / goldSet.size;
  const f1 = precision + recall === 0 ? 0 : (2 * precision * recall) / (precision + recall);
  return { precision, recall, f1 };
}
