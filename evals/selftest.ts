/**
 * evals/selftest.ts
 *
 * Proves evals/lib/score.ts's scorer actually DISCRIMINATES — that a wrong
 * extraction gets caught, not just that a right one passes. `run.ts
 * --selftest` (evals/invoice/run.ts) already proves the perfect-data case
 * (feeds gold back as the "prediction" and expects every gate field at
 * 100%); this file is the other half: perturb a couple of fields and check
 * the same scoring function reports them as WRONG.
 *
 * WHY this matters on its own, separate from the perfect-data check: a
 * scorer that always returns `true` (or normalizes so aggressively that
 * everything looks equal) would pass the perfect-data check trivially
 * while never catching a single real mistake — exactly the kind of eval
 * that looks green but tells you nothing. Moiz's eval standard requires
 * proving the scoring logic works before trusting any accuracy number it
 * reports; this is that proof, and it costs nothing to run (no network,
 * no API key) because it only exercises evals/lib/score.ts directly.
 *
 * Run directly: `npx tsx evals/selftest.ts`
 * Also imported (pure, no CLI side effects) by tests/eval-selftest.test.ts
 * so `npm run test` re-checks this on every run for free.
 */
import type { AiInvoice } from '../lib/types';
import { scoreInvoiceCase } from './lib/score';

const GOLD: AiInvoice = {
  garageName: 'Al Rayyan Auto Care',
  serviceDate: '2026-01-14',
  odometerKm: 45231,
  totalCostQar: 159.75,
  lineItems: [
    { description: 'Engine oil change', partOrService: 'service', costQar: 79.5 },
    { description: 'Oil filter', partOrService: 'part', costQar: 35.25 },
    { description: 'Air filter', partOrService: 'part', costQar: 45 },
  ],
  confidenceNotes: '',
};

export interface DiscriminationResult {
  perfectMatchOk: boolean;
  perturbationCaught: boolean;
  details: string[];
}

// Runs both halves of the proof and returns a structured result, so both
// the CLI entry point below and tests/eval-selftest.test.ts can assert on
// it without parsing console output.
export function checkScorerDiscrimination(): DiscriminationResult {
  const details: string[] = [];

  // Half 1: gold scored against itself (formatted slightly differently —
  // extra whitespace, different case — to also prove normalization, not
  // just literal equality) must pass every field and hit F1 = 1.
  const identicalButReformatted: AiInvoice = {
    ...GOLD,
    garageName: '  AL RAYYAN auto care  ',
    lineItems: GOLD.lineItems.map((item) => ({ ...item, description: item.description.toUpperCase() })),
  };
  const perfectScore = scoreInvoiceCase(identicalButReformatted, GOLD);
  const perfectMatchOk =
    perfectScore.garageName &&
    perfectScore.serviceDate &&
    perfectScore.odometerKm &&
    perfectScore.totalCostQar &&
    perfectScore.lineItemsF1 === 1;
  details.push(`Perfect (reformatted) match: ${JSON.stringify(perfectScore)} -> ${perfectMatchOk ? 'PASS' : 'FAIL'}`);

  // Half 2: perturb exactly 2 fields — totalCostQar off by a real amount
  // (not a rounding-tolerance-sized nudge) and garageName swapped to a
  // DIFFERENT garage entirely — and confirm the scorer flags BOTH as
  // wrong, while the untouched fields (serviceDate, odometerKm, lineItems)
  // still correctly read as matching.
  const perturbed: AiInvoice = {
    ...GOLD,
    garageName: 'Doha Motors Workshop', // wrong garage entirely
    totalCostQar: GOLD.totalCostQar! + 200, // materially wrong amount
  };
  const perturbedScore = scoreInvoiceCase(perturbed, GOLD);
  const perturbationCaught =
    perturbedScore.garageName === false &&
    perturbedScore.totalCostQar === false &&
    perturbedScore.serviceDate === true &&
    perturbedScore.odometerKm === true &&
    perturbedScore.lineItemsF1 === 1;
  details.push(`Perturbed (2 fields) match: ${JSON.stringify(perturbedScore)} -> ${perturbationCaught ? 'CAUGHT' : 'MISSED'}`);

  return { perfectMatchOk, perturbationCaught, details };
}

if (require.main === module) {
  const result = checkScorerDiscrimination();
  for (const line of result.details) console.log(line);

  const ok = result.perfectMatchOk && result.perturbationCaught;
  console.log(ok ? '\nPASS — scorer accepts correct data and catches perturbed data.' : '\nFAIL — see above.');
  process.exit(ok ? 0 : 1);
}
