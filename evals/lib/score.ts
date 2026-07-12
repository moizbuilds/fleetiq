/**
 * evals/lib/score.ts
 *
 * The ONE function that scores an AI invoice extraction against a gold
 * answer — used by evals/invoice/run.ts (the real eval, calling the live
 * API) AND evals/selftest.ts (proves the scorer discriminates, no network
 * at all). Keeping this in one shared module rather than duplicating the
 * comparison logic in both scripts is the same one-source-of-truth
 * reasoning as lib/types.ts's header: a scoring rule that drifted between
 * the real run and the self-test would let the self-test "pass" while
 * testing a DIFFERENT scorer than the one actually used for real results.
 */
import type { AiInvoice } from '../../lib/types';
import { numbersMatch, stringsMatch, datesMatch, scoreLineItems } from './normalize';

// Per-field pass/fail for one invoice case. Booleans (not just an overall
// score) because the eval's exit-code gate and per-field accuracy table
// both need to know WHICH field failed, not just "this case scored 0.8".
export interface InvoiceCaseScore {
  garageName: boolean;
  serviceDate: boolean;
  odometerKm: boolean;
  totalCostQar: boolean;
  lineItemsF1: number;
}

export function scoreInvoiceCase(extracted: AiInvoice, gold: AiInvoice): InvoiceCaseScore {
  return {
    garageName: stringsMatch(extracted.garageName, gold.garageName),
    serviceDate: datesMatch(extracted.serviceDate, gold.serviceDate),
    odometerKm: numbersMatch(extracted.odometerKm, gold.odometerKm),
    totalCostQar: numbersMatch(extracted.totalCostQar, gold.totalCostQar),
    lineItemsF1: scoreLineItems(extracted.lineItems, gold.lineItems).f1,
  };
}
