// Unit tests for lib/status.ts — the due-status engine.
//
// WHY these are written before lib/status.ts exists (strict TDD): the whole
// point of this module is "given this threshold, this odometer reading, and
// this date, what status shows on screen" — a huge grid of edge cases
// (exactly-at-threshold, both-dimensions-overdue, missing odometer data...).
// Writing the assertions first, from the spec, forces every edge case to be
// decided BEFORE the implementation exists to accidentally match — if the
// tests were written after, it's too easy to just describe whatever the code
// already does instead of what it should do.
import { describe, it, expect } from 'vitest';
import {
  computeItemStatus,
  computeComplianceStatus,
  worstFirst,
  intervalConsumedPct,
  formatKm,
  DUE_SOON_KM,
  DUE_SOON_DAYS,
  type ItemStatus,
} from '@/lib/status';

// Fixed "now" used across tests. Deliberately NOT midnight, to prove the
// module truncates to a calendar date (UTC) rather than doing a raw
// millisecond subtraction that would be thrown off by time-of-day.
const TODAY = new Date('2026-07-12T15:42:00.000Z');

describe('formatKm', () => {
  it('adds thousands separators and a unit suffix', () => {
    expect(formatKm(1200)).toBe('1,200 km');
    expect(formatKm(400)).toBe('400 km');
    expect(formatKm(0)).toBe('0 km');
  });
});

describe('computeItemStatus — km-only item', () => {
  it('is "ok" when far from the threshold', () => {
    const status = computeItemStatus({ nextDueKm: 20000, nextDueDate: null }, 18000, TODAY);
    expect(status.state).toBe('ok');
    expect(status.dueInKm).toBe(2000);
    expect(status.dueInDays).toBeNull();
    expect(status.label).toBe('due in 2,000 km');
  });

  it('is "due_soon" at the exact 1,000km inclusive boundary', () => {
    const status = computeItemStatus(
      { nextDueKm: 20000, nextDueDate: null },
      20000 - DUE_SOON_KM,
      TODAY,
    );
    expect(status.state).toBe('due_soon');
    expect(status.dueInKm).toBe(DUE_SOON_KM);
    expect(status.label).toBe('due in 1,000 km');
  });

  it('is "ok" one km outside the due_soon boundary', () => {
    const status = computeItemStatus(
      { nextDueKm: 20000, nextDueDate: null },
      20000 - (DUE_SOON_KM + 1),
      TODAY,
    );
    expect(status.state).toBe('ok');
  });

  it('is overdue when currentKm has passed nextDueKm', () => {
    const status = computeItemStatus({ nextDueKm: 20000, nextDueDate: null }, 20230, TODAY);
    expect(status.state).toBe('overdue');
    expect(status.dueInKm).toBe(-230);
    expect(status.label).toBe('overdue by 230 km');
  });

  it('is "overdue now" (not "overdue by 0 km") exactly at the threshold', () => {
    const status = computeItemStatus({ nextDueKm: 20000, nextDueDate: null }, 20000, TODAY);
    expect(status.state).toBe('overdue');
    expect(status.dueInKm).toBe(0);
    expect(status.label).toBe('overdue now');
  });

  it('is no_data when there is no odometer reading yet', () => {
    const status = computeItemStatus({ nextDueKm: 20000, nextDueDate: null }, null, TODAY);
    expect(status.state).toBe('no_data');
    expect(status.dueInKm).toBeNull();
    expect(status.dueInDays).toBeNull();
    expect(status.label).toBe('no odometer reading yet');
  });
});

describe('computeItemStatus — months-only item (date threshold)', () => {
  it('is "ok" well before the due date', () => {
    const status = computeItemStatus({ nextDueKm: null, nextDueDate: '2026-12-01' }, null, TODAY);
    expect(status.state).toBe('ok');
    expect(status.dueInKm).toBeNull();
    expect(status.dueInDays).toBeGreaterThan(DUE_SOON_DAYS);
    expect(status.label).toBe(`due in ${status.dueInDays} days`);
  });

  it('is "due_soon" at the exact 30-day inclusive boundary', () => {
    const status = computeItemStatus({ nextDueKm: null, nextDueDate: '2026-08-11' }, null, TODAY);
    expect(status.dueInDays).toBe(DUE_SOON_DAYS);
    expect(status.state).toBe('due_soon');
    expect(status.label).toBe('due in 30 days');
  });

  it('is "ok" one day outside the due_soon boundary', () => {
    const status = computeItemStatus({ nextDueKm: null, nextDueDate: '2026-08-12' }, null, TODAY);
    expect(status.dueInDays).toBe(DUE_SOON_DAYS + 1);
    expect(status.state).toBe('ok');
  });

  it('is overdue when the due date is in the past', () => {
    const status = computeItemStatus({ nextDueKm: null, nextDueDate: '2026-07-05' }, null, TODAY);
    expect(status.state).toBe('overdue');
    expect(status.dueInDays).toBe(-7);
    expect(status.label).toBe('overdue by 7 days');
  });

  it('singularizes "1 day" (no trailing s)', () => {
    const status = computeItemStatus({ nextDueKm: null, nextDueDate: '2026-07-13' }, null, TODAY);
    expect(status.dueInDays).toBe(1);
    expect(status.label).toBe('due in 1 day');
  });

  it('is "overdue now" exactly on the due date (0 days remaining)', () => {
    const status = computeItemStatus({ nextDueKm: null, nextDueDate: '2026-07-12' }, null, TODAY);
    expect(status.state).toBe('overdue');
    expect(status.dueInDays).toBe(0);
    expect(status.label).toBe('overdue now');
  });

  it('a months-only item is never no_data, even with no odometer reading', () => {
    const status = computeItemStatus({ nextDueKm: null, nextDueDate: '2026-12-01' }, null, TODAY);
    expect(status.state).not.toBe('no_data');
  });

  it('truncates to calendar date — time-of-day on `today` does not shift the day count', () => {
    const midnightToday = new Date('2026-07-12T00:00:00.000Z');
    const lateToday = new Date('2026-07-12T23:59:59.000Z');
    const a = computeItemStatus({ nextDueKm: null, nextDueDate: '2026-07-13' }, null, midnightToday);
    const b = computeItemStatus({ nextDueKm: null, nextDueDate: '2026-07-13' }, null, lateToday);
    expect(a.dueInDays).toBe(1);
    expect(b.dueInDays).toBe(1);
  });
});

describe('computeItemStatus — both dimensions present (whichever-first wins)', () => {
  it('overall state is the worse of the two dimensions (km due_soon, date ok -> due_soon)', () => {
    const status = computeItemStatus(
      { nextDueKm: 20000, nextDueDate: '2027-01-01' }, // date is far off
      20000 - 500, // 500km remaining -> due_soon
      TODAY,
    );
    expect(status.state).toBe('due_soon');
    expect(status.dueInKm).toBe(500);
    expect(status.dueInDays).toBeGreaterThan(DUE_SOON_DAYS);
  });

  it('overall state is overdue if either dimension is overdue, even if the other is fine', () => {
    const status = computeItemStatus(
      { nextDueKm: 20000, nextDueDate: '2027-01-01' },
      20500, // 500km over -> overdue
      TODAY,
    );
    expect(status.state).toBe('overdue');
  });

  it('label lists km first, then days, when both are present and not overdue', () => {
    const status = computeItemStatus(
      { nextDueKm: 20000, nextDueDate: '2026-07-24' },
      19600, // 400 km remaining
      TODAY,
    );
    expect(status.dueInKm).toBe(400);
    expect(status.dueInDays).toBe(12);
    expect(status.label).toBe('due in 400 km or 12 days');
  });

  it('when both dimensions are overdue, the larger overshoot leads the label (km bigger)', () => {
    const status = computeItemStatus(
      { nextDueKm: 20000, nextDueDate: '2026-07-02' }, // 10 days overdue
      20500, // 500 km overdue
      TODAY,
    );
    expect(status.label).toBe('overdue by 500 km');
  });

  it('when both dimensions are overdue, the larger overshoot leads the label (days bigger)', () => {
    const status = computeItemStatus(
      { nextDueKm: 20000, nextDueDate: '2026-06-01' }, // 41 days overdue
      20005, // 5 km overdue
      TODAY,
    );
    expect(status.label).toBe('overdue by 41 days');
  });

  it('is "overdue now" when both dimensions are overdue by exactly zero', () => {
    const status = computeItemStatus(
      { nextDueKm: 20000, nextDueDate: '2026-07-12' },
      20000,
      TODAY,
    );
    expect(status.label).toBe('overdue now');
  });

  it('date logic still runs even when currentKm is null and a km threshold also exists', () => {
    const status = computeItemStatus(
      { nextDueKm: 20000, nextDueDate: '2026-07-05' }, // 7 days overdue
      null,
      TODAY,
    );
    expect(status.state).toBe('overdue');
    expect(status.dueInKm).toBeNull();
    expect(status.dueInDays).toBe(-7);
    expect(status.label).toBe('overdue by 7 days');
  });
});

describe('computeComplianceStatus (date-only variant)', () => {
  it('is no_data when there is no date set', () => {
    const status = computeComplianceStatus(null, TODAY);
    expect(status.state).toBe('no_data');
    expect(status.dueInDays).toBeNull();
  });

  it('is ok/due_soon/overdue purely from the date, same boundaries as the date dimension above', () => {
    expect(computeComplianceStatus('2026-12-01', TODAY).state).toBe('ok');
    expect(computeComplianceStatus('2026-08-11', TODAY).state).toBe('due_soon');
    expect(computeComplianceStatus('2026-07-05', TODAY).state).toBe('overdue');
    expect(computeComplianceStatus('2026-07-05', TODAY).label).toBe('overdue by 7 days');
    expect(computeComplianceStatus('2026-07-12', TODAY).label).toBe('overdue now');
  });
});

describe('worstFirst', () => {
  function status(partial: Partial<ItemStatus>): ItemStatus {
    return { state: 'ok', dueInKm: null, dueInDays: null, label: '', ...partial };
  }

  it('orders overdue < due_soon < ok < no_data', () => {
    const noData = status({ state: 'no_data' });
    const ok = status({ state: 'ok', dueInKm: 5000 });
    const dueSoon = status({ state: 'due_soon', dueInKm: 500 });
    const overdue = status({ state: 'overdue', dueInKm: -100 });

    const sorted = worstFirst([ok, noData, overdue, dueSoon]);
    expect(sorted.map((s) => s.state)).toEqual(['overdue', 'due_soon', 'ok', 'no_data']);
  });

  it('breaks ties within a state by smallest normalized remaining distance (more urgent first)', () => {
    // due_soon by days (5/30 ≈ 0.167 normalized) is more urgent than
    // due_soon by km (500/1000 = 0.5 normalized), even though 500 > 5.
    const dueSoonByKm = status({ state: 'due_soon', dueInKm: 500 });
    const dueSoonByDays = status({ state: 'due_soon', dueInDays: 5 });

    const sorted = worstFirst([dueSoonByKm, dueSoonByDays]);
    expect(sorted).toEqual([dueSoonByDays, dueSoonByKm]);
  });

  it('orders overdue ties by which is more overdue (more negative normalized remainder first)', () => {
    const barelyOverdueByDays = status({ state: 'overdue', dueInDays: -1 }); // -1/30 ≈ -0.033
    const wayOverdueByKm = status({ state: 'overdue', dueInKm: -2000 }); // -2000/1000 = -2

    const sorted = worstFirst([barelyOverdueByDays, wayOverdueByKm]);
    expect(sorted).toEqual([wayOverdueByKm, barelyOverdueByDays]);
  });

  it('does not mutate the input array (pure sort — returns a copy)', () => {
    const input = [status({ state: 'ok' }), status({ state: 'overdue' })];
    const original = [...input];
    worstFirst(input);
    expect(input).toEqual(original);
  });
});

describe('intervalConsumedPct', () => {
  it('computes from km alone when only the km dimension is available', () => {
    const pct = intervalConsumedPct(
      { intervalKm: 10000, intervalMonths: null, nextDueKm: 20000, nextDueDate: null },
      15000, // consumed = 10000 - (20000 - 15000) = 5000 -> 50%
      TODAY,
    );
    expect(pct).toBe(50);
  });

  it('computes from time alone when only the date dimension is available', () => {
    const pct = intervalConsumedPct(
      { intervalKm: null, intervalMonths: 6, nextDueKm: null, nextDueDate: '2026-07-12' },
      null, // due exactly today -> 0 days remaining -> fully consumed
      TODAY,
    );
    expect(pct).toBe(100);
  });

  it('takes the max of the km-based and time-based fractions', () => {
    const pct = intervalConsumedPct(
      {
        intervalKm: 10000,
        intervalMonths: 6,
        nextDueKm: 20000,
        nextDueDate: '2026-07-12', // time fraction = 100%
      },
      18000, // km fraction = 10000 - (20000-18000) = 8000 -> 80%
      TODAY,
    );
    expect(pct).toBe(100); // max(80, 100)
  });

  it('is null when neither dimension is computable', () => {
    const pct = intervalConsumedPct(
      { intervalKm: 10000, intervalMonths: null, nextDueKm: 20000, nextDueDate: null },
      null, // no odometer reading, and no date dimension at all
      TODAY,
    );
    expect(pct).toBeNull();
  });

  it('clamps below 0 up to 0 (well before the interval started)', () => {
    const pct = intervalConsumedPct(
      { intervalKm: 1000, intervalMonths: null, nextDueKm: 2000, nextDueDate: null },
      0, // consumed = 1000 - (2000-0) = -1000 -> -100%
      TODAY,
    );
    expect(pct).toBe(0);
  });

  it('clamps above 120 down to 120 (way overdue)', () => {
    const pct = intervalConsumedPct(
      { intervalKm: 1000, intervalMonths: null, nextDueKm: 2000, nextDueDate: null },
      3000, // consumed = 1000 - (2000-3000) = 2000 -> 200%
      TODAY,
    );
    expect(pct).toBe(120);
  });

  it('computes partial time-based consumption: 6-month interval with 92 days elapsed', () => {
    // intervalDays = 6 * 30.44 = 182.64
    // consumedDays = 182.64 - 92 = 90.64
    // timePct = (90.64 / 182.64) * 100 ≈ 49.63%
    // Rounded to nearest integer = 50% (or if using Math.round)
    const pct = intervalConsumedPct(
      {
        intervalKm: null,
        intervalMonths: 6,
        nextDueKm: null,
        nextDueDate: '2026-10-12', // exactly 92 days after TODAY
      },
      null,
      TODAY,
    );
    // toBeCloseTo with 1 decimal place to account for rounding
    expect(pct).toBeCloseTo(49.63, 1);
  });

  it('exact tie in both-overdue label: equal km and day overshoots lead with km', () => {
    // When both dimensions are overdue by exactly the same amount, km leads per the tie rule
    const status = computeItemStatus(
      { nextDueKm: 20000, nextDueDate: '2026-06-22' }, // 20 days overdue
      20020, // 20 km overdue
      TODAY,
    );
    expect(status.state).toBe('overdue');
    expect(status.dueInKm).toBe(-20);
    expect(status.dueInDays).toBe(-20);
    expect(status.label).toBe('overdue by 20 km');
  });

  it('due_soon km + ok date combination: label includes both dimensions', () => {
    // km dimension is due_soon (≤ 1000 km remaining)
    // date dimension is ok (> 30 days remaining)
    // overall state is the worse one: due_soon
    const status = computeItemStatus(
      { nextDueKm: 20000, nextDueDate: '2026-08-15' }, // 34 days remaining (ok)
      19200, // 800 km remaining (due_soon, ≤ 1000)
      TODAY,
    );
    expect(status.state).toBe('due_soon');
    expect(status.dueInKm).toBe(800);
    expect(status.dueInDays).toBe(34);
    expect(status.label).toBe('due in 800 km or 34 days');
  });
});
