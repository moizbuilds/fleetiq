/**
 * evals/invoice/run.ts
 *
 * The invoice extraction eval — feeds each of the 15 synthetic Qatar garage
 * invoice images (evals/invoice/images/*.png) through lib/ai/invoice.ts's
 * extractInvoice (the SAME function app/api/ai/invoice/route.ts calls in
 * production, just with a client this script constructs itself — that's
 * the whole point of dependency-injecting the Anthropic client) and scores
 * the result against the hand-authored gold answer in evals/invoice/gold/.
 *
 * This is a GOLD-DIFF eval (compare against a known-correct answer),
 * unlike evals/schedule/run.ts which is a sanity/assertion eval — see that
 * file's header for why the two need different shapes.
 *
 * Usage:
 *   npm run eval:invoice              — calls the real Anthropic API (costs
 *                                        money, needs ANTHROPIC_API_KEY)
 *   npm run eval:invoice -- --selftest — dry-run: feeds each gold JSON back
 *                                        through extractInvoice via a FAKE
 *                                        client (no network, no key, costs
 *                                        nothing) to prove the scoring/
 *                                        reporting/exit-code plumbing works
 *                                        before spending a cent on the real
 *                                        run. See evals/selftest.ts for the
 *                                        companion check that the scorer
 *                                        actually CATCHES a wrong answer
 *                                        (this mode only proves it accepts
 *                                        a right one).
 */
import fs from 'node:fs';
import path from 'node:path';
import type Anthropic from '@anthropic-ai/sdk';
import { getAnthropic } from '../../lib/ai/client';
import { MODEL } from '../../lib/ai/model';
import { extractInvoice } from '../../lib/ai/invoice';
import type { AiInvoice } from '../../lib/types';
import { scoreInvoiceCase, type InvoiceCaseScore } from '../lib/score';

const IMAGES_DIR = path.join(__dirname, 'images');
const GOLD_DIR = path.join(__dirname, 'gold');

// Fields the exit code gates on — the ones ServiceForm.tsx actually pre-
// fills a compliance-relevant value from (odometer feeds interval math,
// cost feeds cost-per-km, date feeds history ordering). garageName and
// lineItems are still scored and reported, just not gate-worthy on their
// own: a missed garage name doesn't corrupt any derived number the way a
// wrong odometer reading would.
const GATE_FIELDS = ['odometerKm', 'totalCostQar', 'serviceDate'] as const;
const GATE_THRESHOLD = 0.8;

// Builds a minimal fake Anthropic client whose messages.create() always
// resolves with `response` as the model's JSON text — used only by
// --selftest. Shaped exactly like tests/invoice.test.ts's fakeMessage()
// fixture: extractInvoice only ever touches `.messages.create(...)` and
// the returned message's `.content`, so nothing else needs to be real.
function makeFakeClient(response: AiInvoice): Anthropic {
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
  return {
    messages: { create: async () => fakeMessage },
  } as unknown as Anthropic;
}

interface CaseResult {
  id: string;
  score?: InvoiceCaseScore;
  error?: string;
}

async function runCase(id: string, client: Anthropic): Promise<CaseResult> {
  const goldPath = path.join(GOLD_DIR, `${id}.json`);
  const gold = JSON.parse(fs.readFileSync(goldPath, 'utf8')) as AiInvoice;

  try {
    const imagePath = path.join(IMAGES_DIR, `${id}.png`);
    const base64 = fs.readFileSync(imagePath).toString('base64');
    const extracted = await extractInvoice(client, { base64, mediaType: 'image/png' });
    return { id, score: scoreInvoiceCase(extracted, gold) };
  } catch (err) {
    return { id, error: err instanceof Error ? err.message : String(err) };
  }
}

// Prints the per-field accuracy table and returns whether every gate field
// cleared GATE_THRESHOLD.
//
// WHY an errored/unscorable case counts as a FAILURE on every field rather
// than being dropped from the denominator: dropping it would silently
// shrink the sample size behind a rate that looks unchanged — exactly the
// "a dropped case shouldn't inflate the rate" failure the brief calls out.
// An image Claude couldn't extract at all is a real failure for a feature
// whose whole job is turning that image into usable data.
function report(results: CaseResult[]): boolean {
  const total = results.length;
  const errored = results.filter((r) => r.error);

  if (errored.length > 0) {
    console.error(`\n${errored.length}/${total} case(s) errored — counted as a FAILURE on every field, not dropped:`);
    for (const r of errored) console.error(`  [${r.id}] ${r.error}`);
  }

  const fieldNames = ['garageName', 'serviceDate', 'odometerKm', 'totalCostQar'] as const;
  const accuracy: Record<string, number> = {};
  for (const field of fieldNames) {
    const hits = results.reduce((sum, r) => sum + (r.score?.[field] ? 1 : 0), 0);
    accuracy[field] = hits / total;
  }
  const lineItemsF1Avg = results.reduce((sum, r) => sum + (r.score?.lineItemsF1 ?? 0), 0) / total;

  console.log('\n--- Per-field accuracy (across all %d cases; errors count as failures) ---', total);
  for (const field of fieldNames) {
    console.log(`  ${field.padEnd(14)} ${(accuracy[field] * 100).toFixed(1)}%`);
  }
  console.log(`  ${'lineItems F1'.padEnd(14)} ${(lineItemsF1Avg * 100).toFixed(1)}%`);

  const overall =
    (accuracy.garageName + accuracy.serviceDate + accuracy.odometerKm + accuracy.totalCostQar + lineItemsF1Avg) / 5;
  console.log(`  ${'OVERALL'.padEnd(14)} ${(overall * 100).toFixed(1)}%`);

  console.log(`\n--- Gate check (must be >= ${GATE_THRESHOLD * 100}%) ---`);
  let gatePassed = true;
  for (const field of GATE_FIELDS) {
    const pass = accuracy[field] >= GATE_THRESHOLD;
    if (!pass) gatePassed = false;
    console.log(`  ${field.padEnd(14)} ${(accuracy[field] * 100).toFixed(1)}% ${pass ? 'PASS' : 'FAIL'}`);
  }

  return gatePassed;
}

async function main() {
  const selftest = process.argv.includes('--selftest');

  // The real run needs a live key (and spends money); --selftest never
  // calls the network at all, so it must not be gated on one.
  if (!selftest && !process.env.ANTHROPIC_API_KEY) {
    console.error('Set ANTHROPIC_API_KEY to run evals');
    process.exit(1);
  }

  const ids = fs
    .readdirSync(GOLD_DIR)
    .filter((f) => f.endsWith('.json'))
    .map((f) => f.replace(/\.json$/, ''))
    .sort();

  if (selftest) {
    console.log(`[--selftest] Dry run: feeding each gold answer back through extractInvoice via a fake client.`);
  }

  const realClient = selftest ? null : getAnthropic();
  const results: CaseResult[] = [];
  for (const id of ids) {
    const gold = JSON.parse(fs.readFileSync(path.join(GOLD_DIR, `${id}.json`), 'utf8')) as AiInvoice;
    const client = selftest ? makeFakeClient(gold) : realClient!;
    results.push(await runCase(id, client));
  }

  const gatePassed = report(results);

  if (selftest) {
    // Fed perfect data through the real scorer — every gate field should
    // read 100%. If it doesn't, the scorer (not the AI) has a bug; fail
    // loudly instead of reporting a false "eval ran fine".
    if (!gatePassed) {
      console.error('\n[--selftest] FAILED — scoring a perfect gold-as-prediction run should pass every gate.');
      process.exit(1);
    }
    console.log('\n[--selftest] OK — scorer reports 100% when fed perfect data. Run evals/selftest.ts next to confirm it also catches wrong answers.');
    return;
  }

  if (!gatePassed) {
    console.error('\nFAILED — one or more gate fields fell below the accuracy threshold.');
    process.exit(1);
  }
  console.log('\nPASSED.');
}

// Guarded so this module can be imported (e.g. by a future test) without
// triggering a real run / process.exit as a side effect of import — the
// same reasoning as evals/selftest.ts's `require.main === module` guard.
if (require.main === module) {
  main().catch((err) => {
    console.error('Eval run crashed:', err);
    process.exit(1);
  });
}
