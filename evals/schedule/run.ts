/**
 * evals/schedule/run.ts
 *
 * The maintenance-schedule generation eval — calls lib/ai/schedule.ts's
 * generateSchedule for 5 real-world vehicles and checks the result against
 * a list of ASSERTIONS (not a gold answer).
 *
 * WHY this is a sanity/assertion eval, not a gold-diff eval like
 * evals/invoice/run.ts: there's no single "correct" maintenance schedule
 * for a 2022 Toyota Hiace to diff against — a legitimate response could
 * reasonably suggest a 7,000km oil interval or a 10,000km one, list Bosch
 * or Denso as the battery brand, phrase the rationale differently every
 * single run. What CAN be checked mechanically, every run, regardless of
 * the model's specific wording: did it cover all 10 required categories,
 * are the numbers internally sensible (oil interval in a plausible range,
 * battery tracked by time not distance, tyres tracked by distance not
 * time), does every item actually have brand suggestions. Those are
 * assertions, not a diff against one fixed "gold" schedule.
 *
 * Usage:
 *   npm run eval:schedule              — calls the real Anthropic API
 *                                         (costs money, needs
 *                                         ANTHROPIC_API_KEY)
 *   npm run eval:schedule -- --selftest — dry run: feeds four hand-built
 *                                         schedules (valid; missing
 *                                         tyres/battery-by-distance;
 *                                         brake-pads-replaced-by-brake-
 *                                         fluid; air+cabin filter collapsed
 *                                         into one item) through the SAME
 *                                         assertion function via a fake
 *                                         client, proving the assertions
 *                                         actually fire before spending a
 *                                         cent on the real API.
 */
import type Anthropic from '@anthropic-ai/sdk';
import { getAnthropic } from '../../lib/ai/client';
import { MODEL } from '../../lib/ai/model';
import { generateSchedule, REQUIRED_CATEGORIES, type VehicleForSchedule } from '../../lib/ai/schedule';
import type { AiSchedule, AiScheduleItem } from '../../lib/types';
import { normalizeString } from '../lib/normalize';

const VEHICLES: (VehicleForSchedule & { label: string })[] = [
  { label: 'Toyota Hiace 2022 (2.8L diesel)', make: 'Toyota', model: 'Hiace', year: 2022, engine: '2.8L diesel' },
  { label: 'Nissan Urvan NV350 2019', make: 'Nissan', model: 'Urvan NV350', year: 2019, engine: null },
  { label: 'Mitsubishi L200 2021 (diesel)', make: 'Mitsubishi', model: 'L200', year: 2021, engine: 'diesel' },
  { label: 'Toyota Corolla 2023 (1.6L)', make: 'Toyota', model: 'Corolla', year: 2023, engine: '1.6L' },
  { label: 'Ford Transit 2020 (2.2L diesel)', make: 'Ford', model: 'Transit', year: 2020, engine: '2.2L diesel' },
];

// Keyword matchers per required category, run against a NORMALIZED item
// name (evals/lib/normalize.ts's normalizeString — casefolded, punctuation
// stripped). WHY "contains X and not Y" rather than exact string equality:
// AI output varies run-to-run in EXACT wording ("Engine oil change" vs
// "Oil change (engine)" vs "Oil & filter change") — matching by category
// keyword is what makes this eval robust to that variance instead of
// re-failing every run over cosmetic wording.
//
// WHY every matcher below is written as "must contain X, must NOT contain
// Y" instead of just "must contain X": a bare substring check can be
// satisfied by an item from a DIFFERENT category that happens to share a
// word — e.g. "Brake fluid flush" contains "brake" but never touches pads,
// and "Cabin air filter" contains both "air" and "cabin". A matcher that
// only checked the positive keyword would let that wrong item stand in for
// the missing one and report the category present when it silently isn't.
// Each matcher is documented with what it MUST and MUST NOT match so a
// future edit that loosens one back to a bare substring check is an
// obvious diff against its own comment.
const CATEGORY_MATCHERS: Record<(typeof REQUIRED_CATEGORIES)[number], (normalizedName: string) => boolean> = {
  // MUST match: "Engine oil change", "Oil change (engine)", "Oil & filter change".
  // MUST NOT match: "Oil filter" alone (excluded via !filter, so one item
  // can't double-count as both oil-change and oil-filter categories), or
  // "Transmission oil change" / "Transmission oil" — Gulf/GCC manuals
  // routinely call ATF "transmission oil", so without this exclusion a
  // schedule that swapped the real engine-oil item out for a
  // transmission-oil item would silently satisfy this category too.
  'oil change': (n) => n.includes('oil') && !n.includes('filter') && !n.includes('transmission'),
  // MUST match: "Oil filter", "Engine oil filter".
  // MUST NOT match: "Transmission oil filter" / "Transmission filter" —
  // same transmission-oil naming risk as 'oil change' above, kept
  // symmetric with it.
  'oil filter': (n) => n.includes('oil') && n.includes('filter') && !n.includes('transmission'),
  // MUST match: "Air filter", "Engine air filter".
  // MUST NOT match: "Cabin air filter" — the cabin and engine air filters
  // are physically different parts on different intervals. Without this
  // exclusion, a single "Cabin air filter" item would satisfy BOTH this
  // category and 'cabin filter' below, masking a genuinely missing engine
  // air filter.
  'air filter': (n) => n.includes('air') && n.includes('filter') && !n.includes('cabin'),
  // MUST match: "Cabin filter", "Cabin air filter", "AC cabin filter".
  // MUST NOT match anything without "cabin" — deliberately does NOT
  // exclude "air" (a cabin filter is legitimately an air filter for the
  // cabin), so the mutual exclusivity with 'air filter' lives entirely in
  // that matcher's "not cabin" clause, not duplicated here.
  'cabin filter': (n) => n.includes('cabin') && n.includes('filter'),
  // MUST match: "Brake pads", "Front brake pads", "Brake pads and discs".
  // MUST NOT match: "Brake fluid flush" or "Brake inspection" alone — a
  // schedule can legitimately service brake fluid or run an inspection
  // without ever replacing pads, so "brake" by itself is not proof pads
  // were covered. Requires the pad/disc concept explicitly (some
  // schedules phrase pad replacement as "brake pads/discs").
  'brake pads': (n) => n.includes('brake') && (n.includes('pad') || n.includes('disc')),
  // MUST match: "Tyres", "Tires", "Tyre rotation".
  // MUST NOT match anything else in this domain's 10 categories — no
  // other required item's real-world name plausibly contains "tyre"/"tire".
  tyres: (n) => n.includes('tyre') || n.includes('tire'),
  // MUST match: "Battery", "12V battery".
  // MUST NOT match anything else — no other category's real-world naming
  // contains "battery".
  battery: (n) => n.includes('battery'),
  // MUST match: "Coolant", "Antifreeze", "Coolant/antifreeze flush".
  // MUST NOT match anything else — neither term overlaps another
  // category's naming.
  coolant: (n) => n.includes('coolant') || n.includes('antifreeze'),
  // MUST match: "Transmission fluid", "Transmission oil".
  // MUST NOT match anything else — the reverse risk (this item ALSO
  // satisfying 'oil change'/'oil filter' when it's phrased "transmission
  // oil") is blocked in those two matchers' "not transmission" clauses,
  // not here, so the exclusion lives in exactly one place per direction.
  'transmission fluid': (n) => n.includes('transmission'),
  // MUST match: "Belts", "Serpentine belt", "Timing belt", "Drive belt".
  // MUST NOT match anything else — no other required category's naming
  // contains "belt".
  belts: (n) => n.includes('belt'),
};

function itemsMatching(items: AiScheduleItem[], category: (typeof REQUIRED_CATEGORIES)[number]): AiScheduleItem[] {
  const matcher = CATEGORY_MATCHERS[category];
  return items.filter((item) => matcher(normalizeString(item.name)));
}

// Runs every assertion against one vehicle's generated schedule and returns
// the list of failure strings (empty = fully passed). Each failure names
// the vehicle AND the offending item/value, per the brief — a bare "FAILED"
// with no value is useless for deciding whether a bad prompt or a flaky
// model call caused it.
export function checkSchedule(vehicleLabel: string, schedule: AiSchedule): string[] {
  const failures: string[] = [];
  const items = schedule.items;

  // 1. All 10 required categories present.
  for (const category of REQUIRED_CATEGORIES) {
    if (itemsMatching(items, category).length === 0) {
      failures.push(`[${vehicleLabel}] missing category "${category}" — no item name matched`);
    }
  }

  // 2. Oil-change interval within a plausible real-world range.
  for (const item of itemsMatching(items, 'oil change')) {
    if (item.intervalKm === null || item.intervalKm < 5000 || item.intervalKm > 15000) {
      failures.push(`[${vehicleLabel}] "${item.name}" oil-change intervalKm out of [5000,15000]: ${item.intervalKm}`);
    }
  }

  // 3. Every item: >=1 non-null interval, brand suggestions present, and
  // (belt-and-suspenders on top of aiScheduleSchema's own bounds, which
  // generateSchedule already validated through) intervals within the
  // schema's own bounds.
  for (const item of items) {
    if (item.intervalKm === null && item.intervalMonths === null) {
      failures.push(`[${vehicleLabel}] "${item.name}" has neither intervalKm nor intervalMonths`);
    }
    if (item.brandRecommendations.length === 0) {
      failures.push(`[${vehicleLabel}] "${item.name}" has no brand recommendations`);
    }
    if (item.intervalKm !== null && (item.intervalKm <= 0 || item.intervalKm > 100_000)) {
      failures.push(`[${vehicleLabel}] "${item.name}" intervalKm out of bounds: ${item.intervalKm}`);
    }
    if (item.intervalMonths !== null && (item.intervalMonths <= 0 || item.intervalMonths > 120)) {
      failures.push(`[${vehicleLabel}] "${item.name}" intervalMonths out of bounds: ${item.intervalMonths}`);
    }
  }

  // 4. Battery is tracked by TIME (a battery dies of age/heat, not
  // distance) — must have intervalMonths.
  for (const item of itemsMatching(items, 'battery')) {
    if (item.intervalMonths === null) {
      failures.push(`[${vehicleLabel}] battery "${item.name}" missing intervalMonths`);
    }
  }

  // 5. Tyres are tracked by DISTANCE — must have intervalKm.
  for (const item of itemsMatching(items, 'tyres')) {
    if (item.intervalKm === null) {
      failures.push(`[${vehicleLabel}] tyres "${item.name}" missing intervalKm`);
    }
  }

  return failures;
}

// ---------------------------------------------------------------------------
// --selftest support: a fake Anthropic client that always returns a given
// AiSchedule as the model's JSON response, plus two hand-built schedules
// (one that should pass every assertion, one deliberately broken) used to
// prove checkSchedule actually fires before the real API is ever called.
// ---------------------------------------------------------------------------
function makeFakeClient(response: AiSchedule): Anthropic {
  const fakeMessage: Anthropic.Message = {
    id: 'msg_selftest',
    container: null,
    content: [{ type: 'text', citations: null, text: JSON.stringify(response) }],
    model: MODEL,
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
  return { messages: { create: async () => fakeMessage } } as unknown as Anthropic;
}

function buildValidSchedule(): AiSchedule {
  return {
    items: [
      { name: 'Engine oil change', intervalKm: 8000, intervalMonths: null, brandRecommendations: ['Castrol', 'Shell'], rationale: 'Heat-adjusted interval.' },
      { name: 'Oil filter', intervalKm: 8000, intervalMonths: null, brandRecommendations: ['Toyota OEM', 'Denso'], rationale: 'Changed with oil.' },
      { name: 'Air filter', intervalKm: 15000, intervalMonths: null, brandRecommendations: ['Denso', 'K&N'], rationale: 'Dusty conditions.' },
      { name: 'Cabin filter', intervalKm: 15000, intervalMonths: null, brandRecommendations: ['Mann', 'Bosch'], rationale: 'AC airflow.' },
      { name: 'Brake pads', intervalKm: 40000, intervalMonths: null, brandRecommendations: ['Brembo', 'Bosch'], rationale: 'Urban stop-and-go.' },
      { name: 'Tyres', intervalKm: 50000, intervalMonths: null, brandRecommendations: ['Bridgestone', 'Michelin'], rationale: 'Heat wear.' },
      { name: 'Battery', intervalKm: null, intervalMonths: 24, brandRecommendations: ['ACDelco', 'Bosch'], rationale: 'Heat shortens battery life.' },
      { name: 'Coolant', intervalKm: null, intervalMonths: 24, brandRecommendations: ['Toyota OEM', 'Prestone'], rationale: 'Prevents overheating.' },
      { name: 'Transmission fluid', intervalKm: 60000, intervalMonths: null, brandRecommendations: ['Toyota OEM', 'Valvoline'], rationale: 'Heat load.' },
      { name: 'Belts', intervalKm: 80000, intervalMonths: null, brandRecommendations: ['Gates', 'Continental'], rationale: 'Heat-cracking risk.' },
    ],
  };
}

// Same schedule, deliberately broken in 2 ways: battery tracked by
// DISTANCE instead of time (should fail assertion 4), and tyres item
// dropped entirely (should fail assertion 1 AND assertion 5's "no tyres
// item at all" case — a missing category with no matching item never
// reaches the intervalKm check for that category in the first place, so
// it only surfaces once, as the missing-category failure).
function buildBrokenSchedule(): AiSchedule {
  const valid = buildValidSchedule();
  return {
    items: valid.items
      .filter((item) => item.name !== 'Tyres')
      .map((item) => (item.name === 'Battery' ? { ...item, intervalKm: 20000, intervalMonths: null } : item)),
  };
}

// Regression fixture for the "brake pads" matcher bug: the pads item is
// swapped for a brake-FLUID item, all other 9 categories left valid. Before
// the fix, 'brake pads': (n) => n.includes('brake') matched "Brake fluid
// flush" too (it contains "brake"), so a schedule that never actually
// covers pad replacement would silently report the category present. This
// proves the tightened matcher (requires "pad" or "disc") reports the
// category missing instead of passing it.
function buildBrakeFluidOnlySchedule(): AiSchedule {
  const valid = buildValidSchedule();
  return {
    items: valid.items.map((item) =>
      item.name === 'Brake pads'
        ? { ...item, name: 'Brake fluid flush', rationale: 'Brake fluid absorbs moisture under heat.' }
        : item,
    ),
  };
}

// Regression fixture for the air-filter/cabin-filter collision: the
// separate "Air filter" and "Cabin filter" items are collapsed into one
// "Cabin air filter" item, all other 8 categories left valid. Before the
// fix, both 'air filter' and 'cabin filter' matched on "air"+"filter" with
// no exclusion, so this single item satisfied BOTH categories and a
// schedule that never actually covers the engine air filter would silently
// report it present. Proves the tightened 'air filter' matcher (excludes
// "cabin") reports air filter missing while cabin filter still correctly
// reports present from the same item.
function buildCollapsedAirCabinFilterSchedule(): AiSchedule {
  const valid = buildValidSchedule();
  const withoutAirAndCabin = valid.items.filter((item) => item.name !== 'Air filter' && item.name !== 'Cabin filter');
  return {
    items: [
      ...withoutAirAndCabin,
      {
        name: 'Cabin air filter',
        intervalKm: 15000,
        intervalMonths: null,
        brandRecommendations: ['Mann', 'Bosch'],
        rationale: 'AC airflow and cabin dust.',
      },
    ],
  };
}

// Exported (not just called from main() below) so tests/eval-selftest.test.ts
// can invoke this exact discrimination check directly and assert on its
// return value — same one-source-of-truth reasoning as evals/selftest.ts's
// checkScorerDiscrimination: the vitest wiring must exercise the identical
// function the CLI runs, not a re-implementation that could drift.
export async function selftest(): Promise<boolean> {
  console.log('[--selftest] Dry run: checking a hand-built valid schedule and three deliberately broken ones.\n');

  const validClient = makeFakeClient(buildValidSchedule());
  const validSchedule = await generateSchedule(validClient, VEHICLES[0]);
  const validFailures = checkSchedule('selftest-valid', validSchedule);
  console.log(`Valid schedule: ${validFailures.length === 0 ? 'PASS (0 failures, as expected)' : `FAIL — unexpected failures:\n  ${validFailures.join('\n  ')}`}`);

  const brokenClient = makeFakeClient(buildBrokenSchedule());
  const brokenSchedule = await generateSchedule(brokenClient, VEHICLES[0]);
  const brokenFailures = checkSchedule('selftest-broken', brokenSchedule);
  const caughtMissingTyres = brokenFailures.some((f) => f.includes('missing category "tyres"'));
  const caughtBatteryKm = brokenFailures.some((f) => f.includes('battery') && f.includes('missing intervalMonths'));
  console.log(`\nBroken schedule: ${brokenFailures.length} failure(s) found:\n  ${brokenFailures.join('\n  ')}`);

  // Regression case 1: brake pads replaced by a brake-FLUID item. Must
  // report "brake pads" missing — a loose 'brake' substring matcher would
  // wrongly pass this.
  const brakeFluidClient = makeFakeClient(buildBrakeFluidOnlySchedule());
  const brakeFluidSchedule = await generateSchedule(brakeFluidClient, VEHICLES[0]);
  const brakeFluidFailures = checkSchedule('selftest-brake-fluid-only', brakeFluidSchedule);
  const caughtMissingBrakePads = brakeFluidFailures.some((f) => f.includes('missing category "brake pads"'));
  console.log(`\nBrake-pads-replaced-by-brake-fluid schedule: ${brakeFluidFailures.length} failure(s) found:\n  ${brakeFluidFailures.join('\n  ')}`);

  // Regression case 2: air filter + cabin filter collapsed into one
  // "Cabin air filter" item. Must report "air filter" missing while still
  // reporting "cabin filter" present — a loose matcher with no cabin
  // exclusion would wrongly pass both from the single item.
  const collapsedFilterClient = makeFakeClient(buildCollapsedAirCabinFilterSchedule());
  const collapsedFilterSchedule = await generateSchedule(collapsedFilterClient, VEHICLES[0]);
  const collapsedFilterFailures = checkSchedule('selftest-collapsed-air-cabin', collapsedFilterSchedule);
  const caughtMissingAirFilter = collapsedFilterFailures.some((f) => f.includes('missing category "air filter"'));
  const stillReportsCabinFilterPresent = !collapsedFilterFailures.some((f) => f.includes('missing category "cabin filter"'));
  console.log(`\nCollapsed-air-cabin-filter schedule: ${collapsedFilterFailures.length} failure(s) found:\n  ${collapsedFilterFailures.join('\n  ')}`);

  const ok =
    validFailures.length === 0 &&
    caughtMissingTyres &&
    caughtBatteryKm &&
    caughtMissingBrakePads &&
    caughtMissingAirFilter &&
    stillReportsCabinFilterPresent;
  console.log(ok ? '\n[--selftest] OK — assertions pass a valid schedule and catch every broken one.' : '\n[--selftest] FAILED — assertions did not discriminate correctly.');
  return ok;
}

async function main() {
  const doSelftest = process.argv.includes('--selftest');

  if (doSelftest) {
    const ok = await selftest();
    process.exit(ok ? 0 : 1);
  }

  if (!process.env.ANTHROPIC_API_KEY) {
    console.error('Set ANTHROPIC_API_KEY to run evals');
    process.exit(1);
  }

  const client = getAnthropic();
  let anyFailures = false;

  for (const vehicle of VEHICLES) {
    try {
      const schedule = await generateSchedule(client, vehicle);
      const failures = checkSchedule(vehicle.label, schedule);
      if (failures.length === 0) {
        console.log(`[PASS] ${vehicle.label} — all assertions passed (${schedule.items.length} items).`);
      } else {
        anyFailures = true;
        console.error(`[FAIL] ${vehicle.label} — ${failures.length} failure(s):`);
        for (const f of failures) console.error(`  ${f}`);
      }
    } catch (err) {
      anyFailures = true;
      console.error(`[FAIL] ${vehicle.label} — generateSchedule threw: ${err instanceof Error ? err.message : err}`);
    }
  }

  if (anyFailures) {
    console.error('\nFAILED — see failures above.');
    process.exit(1);
  }
  console.log('\nPASSED — all 5 vehicles covered all 10 categories with sane intervals.');
}

// Guarded so this module can be imported by tests/eval-selftest.test.ts
// (for the `selftest` function above) without also running the real,
// key-gated main() as a side effect of import.
if (require.main === module) {
  main().catch((err) => {
    console.error('Eval run crashed:', err);
    process.exit(1);
  });
}
