// Unit tests for the Zod schemas in lib/types.ts that validate untrusted AI
// output before it ever reaches the database.
//
// WHY these need their own test instead of trusting a code read: the
// original `aiScheduleItemSchema` accepted `intervalKm: 0` and negative
// months (Task 2 review finding #2) — a schema that *looks* like it
// enforces "at least one interval" but silently lets a meaningless interval
// through is exactly the kind of bug a naive re-read of the diff misses.
// These tests exercise the schema directly with `.safeParse()` (never
// throws, just reports success/failure) so the pass/fail is asserted, not
// assumed.
import { describe, it, expect } from 'vitest';
import { aiScheduleSchema, aiInvoiceSchema, AiScheduleItem } from '@/lib/types';

// A minimal valid schedule item, spread-overridden per test so each case
// only changes the one field under test.
const baseItem: AiScheduleItem = {
  name: 'Oil change',
  intervalKm: 10000,
  intervalMonths: null,
  brandRecommendations: ['Shell Helix'],
  rationale: 'Standard interval for this engine.',
};

function scheduleWith(item: Partial<typeof baseItem>) {
  return { items: [{ ...baseItem, ...item }] };
}

describe('aiScheduleSchema', () => {
  it('rejects an item with both intervalKm and intervalMonths null', () => {
    const result = aiScheduleSchema.safeParse(
      scheduleWith({ intervalKm: null, intervalMonths: null }),
    );
    expect(result.success).toBe(false);
  });

  it('rejects intervalKm: 0 (a real-world garage invoice extraction bug: 0 is not a valid interval)', () => {
    const result = aiScheduleSchema.safeParse(scheduleWith({ intervalKm: 0 }));
    expect(result.success).toBe(false);
  });

  it('rejects a negative intervalMonths', () => {
    const result = aiScheduleSchema.safeParse(
      scheduleWith({ intervalKm: null, intervalMonths: -6 }),
    );
    expect(result.success).toBe(false);
  });

  it('accepts a km-only item', () => {
    const result = aiScheduleSchema.safeParse(
      scheduleWith({ intervalKm: 10000, intervalMonths: null }),
    );
    expect(result.success).toBe(true);
  });

  it('accepts a months-only item', () => {
    const result = aiScheduleSchema.safeParse(
      scheduleWith({ intervalKm: null, intervalMonths: 24 }),
    );
    expect(result.success).toBe(true);
  });

  it('accepts an item with both km and months set', () => {
    const result = aiScheduleSchema.safeParse(
      scheduleWith({ intervalKm: 10000, intervalMonths: 12 }),
    );
    expect(result.success).toBe(true);
  });

  // WHY these caps exist at all (review round 1, finding #2): this schema is
  // the only gate on both a fresh AI response (app/api/ai/schedule/route.ts)
  // AND a client-edited payload re-validated by lib/actions/schedule.ts's
  // acceptSchedule server action — the latter is a real reachable endpoint,
  // so nothing besides this schema stops an arbitrarily large request body
  // from reaching Postgres. Bounds are set well above any real schedule, so
  // these tests assert the pathological case is rejected without needing to
  // assert exactly where a realistic one sits relative to the cap.
  it('rejects a schedule with 31 items (over the 30-item cap)', () => {
    const items = Array.from({ length: 31 }, (_, i) => ({ ...baseItem, name: `Item ${i}` }));
    const result = aiScheduleSchema.safeParse({ items });
    expect(result.success).toBe(false);
  });

  it('rejects an item with 6 brand recommendations (over the 5-brand cap)', () => {
    const result = aiScheduleSchema.safeParse(
      scheduleWith({ brandRecommendations: ['A', 'B', 'C', 'D', 'E', 'F'] }),
    );
    expect(result.success).toBe(false);
  });

  it('rejects intervalKm: 100001 (over the 100,000km cap)', () => {
    const result = aiScheduleSchema.safeParse(scheduleWith({ intervalKm: 100_001 }));
    expect(result.success).toBe(false);
  });

  it('accepts a legit 10-item schedule (well under every cap)', () => {
    const items = Array.from({ length: 10 }, (_, i) => ({
      ...baseItem,
      name: `Item ${i}`,
      brandRecommendations: ['Shell Helix', 'Castrol'],
    }));
    const result = aiScheduleSchema.safeParse({ items });
    expect(result.success).toBe(true);
  });
});

describe('aiInvoiceSchema', () => {
  const baseInvoice = {
    garageName: 'Al Rayyan Garage',
    serviceDate: '2026-07-01',
    odometerKm: 45000,
    totalCostQar: 350,
    lineItems: [],
    confidenceNotes: '',
  };

  it('rejects a negative odometerKm', () => {
    const result = aiInvoiceSchema.safeParse({ ...baseInvoice, odometerKm: -1 });
    expect(result.success).toBe(false);
  });

  it('accepts a valid invoice with a null odometerKm', () => {
    const result = aiInvoiceSchema.safeParse({ ...baseInvoice, odometerKm: null });
    expect(result.success).toBe(true);
  });
});
