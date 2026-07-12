/**
 * Due-status engine — turns stored THRESHOLDS (a next-due km reading, a
 * next-due calendar date) into a display status (overdue / due_soon / ok /
 * no_data) at render time.
 *
 * This is the sharp end of the project's core rule: "deadlines stored,
 * countdowns computed" (see globals.md). Task 2's schema only ever stores a
 * fixed threshold — `nextDueKm`, `nextDueDate` — never "km remaining" or
 * "days left". If a countdown were stored instead, it would silently go
 * stale the moment a day passed without anyone opening the app. Every
 * function here is the one place that combines (threshold, current odometer
 * reading, today's date) into a status a component can render — recomputed
 * fresh on every page load, so the numbers are always correct as of "now"
 * with no background job needed to keep them in sync.
 *
 * Pure functions only: no DB import, no Clerk, no `Date.now()` — `today` is
 * always an injected parameter. WHY: a function that reads the system clock
 * itself can only be tested by mocking global time; injecting `today: Date`
 * lets every test pick an exact date and assert an exact status with no
 * mocking (// CONCEPT: injected clock).
 *
 * `ItemStatus` and the threshold-shape types are re-exported from
 * lib/types.ts so UI components (Tasks 6/8) import the shared contract from
 * the one shared file instead of reaching into this module directly.
 */

// ---------------------------------------------------------------------------
// Tunable thresholds — single source of truth for "how close counts as
// due_soon". Both boundaries are INCLUSIVE (exactly 1,000 km or 30 days
// remaining is already due_soon, not ok) — see task-3-brief.md.
// ---------------------------------------------------------------------------
export const DUE_SOON_KM = 1000;
export const DUE_SOON_DAYS = 30;

export type ItemState = 'overdue' | 'due_soon' | 'ok' | 'no_data';

export interface ItemStatus {
  state: ItemState;
  // Signed remainder: positive = km/days remaining, negative = overdue by
  // that amount, null = this dimension has no threshold (or, for km, no
  // odometer reading to compare against).
  dueInKm: number | null;
  dueInDays: number | null;
  label: string;
}

// The subset of a schedule item's fields this module needs. A real
// ScheduleItem (lib/db/schema.ts) has more columns, but TypeScript's
// structural typing lets any object with at least these fields be passed in
// — the caller never has to construct a throwaway object shaped exactly
// like this.
export interface DueThresholds {
  nextDueKm: number | null;
  nextDueDate: string | null;
}

// intervalConsumedPct additionally needs the interval lengths (km/months) on
// top of the thresholds, to know what "100% consumed" means.
export interface IntervalThresholds extends DueThresholds {
  intervalKm: number | null;
  intervalMonths: number | null;
}

const stateRank: Record<ItemState, number> = { overdue: 0, due_soon: 1, ok: 2, no_data: 3 };

// ---------------------------------------------------------------------------
// Date math — all in UTC, on plain YYYY-MM-DD date strings (Postgres `date`
// columns round-trip as strings, never as timezone-bearing Date objects).
// WHY UTC instead of the server's local timezone: comparing a stored date
// string against `new Date()` in local time can shift the day count by one
// depending on what timezone the process happens to run in (a Vercel
// function vs. a laptop) — parsing both sides as UTC midnight removes that
// entire class of off-by-one bug.
// ---------------------------------------------------------------------------
function daysUntil(dateStr: string, today: Date): number {
  // CONCEPT: injected clock — `today` is a parameter, not `new Date()`, so
  // tests can pick an exact "now" and get a deterministic, non-flaky result.
  const todayDateStr = today.toISOString().slice(0, 10);
  const todayUtcMs = Date.parse(`${todayDateStr}T00:00:00.000Z`);
  const dueUtcMs = Date.parse(`${dateStr}T00:00:00.000Z`);
  return Math.round((dueUtcMs - todayUtcMs) / 86_400_000);
}

// ---------------------------------------------------------------------------
// Formatting — one source of truth so every label (and every UI component
// that shows a raw km number) formats numbers identically. WHY export this
// specifically: without it, a component built in Task 8 could format km
// slightly differently ("20000km" vs "20,000 km") and the two would drift.
// ---------------------------------------------------------------------------
export function formatKm(n: number): string {
  return `${n.toLocaleString('en-US')} km`;
}

function formatDays(n: number): string {
  return `${n} day${n === 1 ? '' : 's'}`;
}

// Builds the human-readable label shared by computeItemStatus and
// computeComplianceStatus, given the already-decided state and remainders.
// WHY one shared builder instead of writing the string inline in both
// compute functions: the overdue/"due in" wording rules (below) are
// non-trivial (which dimension leads, singular "1 day", "overdue now" vs.
// "overdue by 0 km") — duplicating them risks the two functions drifting
// apart on wording over time.
function buildLabel(state: ItemState, dueInKm: number | null, dueInDays: number | null): string {
  if (state === 'overdue') {
    const kmOverdue = dueInKm !== null && dueInKm <= 0;
    const dayOverdue = dueInDays !== null && dueInDays <= 0;

    if (kmOverdue && dayOverdue) {
      const kmOver = -dueInKm!;
      const dayOver = -dueInDays!;
      if (kmOver === 0 && dayOver === 0) return 'overdue now';
      // Coordinator decision: when both dimensions are overdue, the larger
      // raw overshoot leads the label (ties go to km) — no unit
      // normalization here, unlike worstFirst's tie-break below.
      return kmOver >= dayOver ? `overdue by ${formatKm(kmOver)}` : `overdue by ${formatDays(dayOver)}`;
    }
    if (kmOverdue) {
      const kmOver = -dueInKm!;
      return kmOver === 0 ? 'overdue now' : `overdue by ${formatKm(kmOver)}`;
    }
    // dayOverdue must be true here: buildLabel is only called with
    // state === 'overdue' when at least one dimension actually is.
    const dayOver = -dueInDays!;
    return dayOver === 0 ? 'overdue now' : `overdue by ${formatDays(dayOver)}`;
  }

  // ok / due_soon: neither dimension can be overdue here (overall state is
  // the worst of the two — see worstOf below), so any present remainder is
  // guaranteed positive. List km first, then days, joined with "or".
  const parts: string[] = [];
  if (dueInKm !== null) parts.push(formatKm(dueInKm));
  if (dueInDays !== null) parts.push(formatDays(dueInDays));
  return `due in ${parts.join(' or ')}`;
}

// Combines two independent per-dimension states into one overall state,
// ignoring whichever dimension has no threshold (null). WHY worst-of instead
// of, say, always favoring km: a maintenance item due by whichever comes
// first (km OR calendar time) is only as safe as its most urgent dimension —
// an oil change due by mileage doesn't get a pass because the calendar
// clock still has time left.
function worstOf(a: ItemState | null, b: ItemState | null): ItemState {
  const candidates = [a, b].filter((s): s is ItemState => s !== null);
  return candidates.reduce((worst, s) => (stateRank[s] < stateRank[worst] ? s : worst));
}

function stateFor(remaining: number, soonBoundary: number): ItemState {
  if (remaining <= 0) return 'overdue';
  if (remaining <= soonBoundary) return 'due_soon';
  return 'ok';
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

// The core status computation for a maintenance schedule item, which may be
// due by km, by calendar date, or both ("whichever comes first").
export function computeItemStatus(
  item: DueThresholds,
  currentKm: number | null,
  today: Date,
): ItemStatus {
  const hasKmThreshold = item.nextDueKm !== null;
  const hasDateThreshold = item.nextDueDate !== null;

  const dueInKm = hasKmThreshold && currentKm !== null ? item.nextDueKm! - currentKm : null;
  const dueInDays = hasDateThreshold ? daysUntil(item.nextDueDate!, today) : null;

  // no_data only when NEITHER dimension produced a usable remainder. A
  // months-only item is never no_data (its date dimension doesn't need
  // currentKm at all) — only a km-only item with no odometer reading yet
  // ends up here.
  if (dueInKm === null && dueInDays === null) {
    const label = hasKmThreshold ? 'no odometer reading yet' : 'no data available';
    return { state: 'no_data', dueInKm: null, dueInDays: null, label };
  }

  const kmState = dueInKm === null ? null : stateFor(dueInKm, DUE_SOON_KM);
  const dayState = dueInDays === null ? null : stateFor(dueInDays, DUE_SOON_DAYS);
  const state = worstOf(kmState, dayState);

  return { state, dueInKm, dueInDays, label: buildLabel(state, dueInKm, dueInDays) };
}

// Date-only variant for compliance deadlines (Istimara/Fahes expiry) that
// have no odometer dimension at all.
export function computeComplianceStatus(dateStr: string | null, today: Date): ItemStatus {
  if (dateStr === null) {
    return { state: 'no_data', dueInKm: null, dueInDays: null, label: 'no compliance date set' };
  }

  const dueInDays = daysUntil(dateStr, today);
  const state = stateFor(dueInDays, DUE_SOON_DAYS);
  return { state, dueInKm: null, dueInDays, label: buildLabel(state, null, dueInDays) };
}

// Normalizes a status's remaining "distance" onto a single comparable scale
// so a worstFirst tie-break can compare a km remainder against a day
// remainder. WHY divide by the respective DUE_SOON_* constant rather than
// comparing raw numbers: 5 km and 5 days are not equally urgent (5 km is
// nothing, 5 days is close to due_soon's 30-day boundary) — dividing each by
// its own "how much counts as soon" threshold puts both on a 0-ish-to-1-ish
// scale where smaller (more negative, if overdue) always means more urgent.
function remainingDistance(status: ItemStatus): number {
  const normKm = status.dueInKm === null ? Infinity : status.dueInKm / DUE_SOON_KM;
  const normDays = status.dueInDays === null ? Infinity : status.dueInDays / DUE_SOON_DAYS;
  return Math.min(normKm, normDays);
}

// Sorts a list of statuses worst-first (overdue, due_soon, ok, no_data),
// breaking ties within a state by which is most urgent.
export function worstFirst(statuses: ItemStatus[]): ItemStatus[] {
  // WHY spread into a new array before sorting: Array.prototype.sort
  // mutates in place — a dashboard component that passes its own state
  // array in would have that array silently reordered out from under it if
  // this didn't copy first.
  return [...statuses].sort((a, b) => {
    const rankDiff = stateRank[a.state] - stateRank[b.state];
    if (rankDiff !== 0) return rankDiff;
    return remainingDistance(a) - remainingDistance(b);
  });
}

// Average calendar days per month, used only to convert a stored
// `intervalMonths` into a day count for the time-based consumption
// fraction below. WHY an average instead of exact calendar months: the
// schema stores `nextDueDate` (the threshold) but not the interval's start
// date, so there's no exact day-count to work from — a fixed average
// (365.25 / 12) is the only way to turn "6 months" into a day span at all.
const AVG_DAYS_PER_MONTH = 30.44;

// Powers the IntervalGauge (Task 8): what fraction of a maintenance
// interval has been consumed so far, as a percentage. Takes the max of the
// km-based and time-based fractions — whichever dimension is closer to its
// limit is what the gauge should reflect, same "whichever comes first"
// logic as computeItemStatus.
export function intervalConsumedPct(
  item: IntervalThresholds,
  currentKm: number | null,
  today: Date,
): number | null {
  let kmPct: number | null = null;
  if (item.intervalKm !== null && item.intervalKm > 0 && item.nextDueKm !== null && currentKm !== null) {
    const consumedKm = item.intervalKm - (item.nextDueKm - currentKm);
    kmPct = (consumedKm / item.intervalKm) * 100;
  }

  let timePct: number | null = null;
  if (item.intervalMonths !== null && item.intervalMonths > 0 && item.nextDueDate !== null) {
    const intervalDays = item.intervalMonths * AVG_DAYS_PER_MONTH;
    const remainingDays = daysUntil(item.nextDueDate, today);
    const consumedDays = intervalDays - remainingDays;
    timePct = (consumedDays / intervalDays) * 100;
  }

  if (kmPct === null && timePct === null) return null;

  const pct = Math.max(kmPct ?? -Infinity, timePct ?? -Infinity);
  // Cap at 0-120: the IntervalGauge (globals.md) treats anything past 100%
  // as "redline", capped at a fixed maximum rather than growing unbounded
  // for a wildly overdue item.
  return Math.min(120, Math.max(0, pct));
}
