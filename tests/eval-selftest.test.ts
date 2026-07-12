// Wires evals/selftest.ts's and evals/schedule/run.ts's discrimination
// checks into `npm run test` — both are pure (no network, no API key) so
// they run for free on every test run, proving on every commit (not just
// when someone remembers to run the CLI by hand) that:
//   1. the invoice scorer (evals/lib/score.ts) accepts a correct answer
//      and catches a wrong one, and
//   2. the schedule eval's assertions (evals/schedule/run.ts's
//      checkSchedule) pass a valid schedule and catch a broken one.
// A scorer/assertion set that always said "pass" would be a green eval
// that proves nothing — this is what stops that from happening silently.
import { describe, it, expect } from 'vitest';
import { checkScorerDiscrimination } from '@/evals/selftest';
import { selftest as scheduleSelftest } from '@/evals/schedule/run';

describe('invoice scorer discrimination (evals/selftest.ts)', () => {
  it('accepts a reformatted-but-correct extraction as a full match', () => {
    const result = checkScorerDiscrimination();
    expect(result.perfectMatchOk).toBe(true);
  });

  it('catches a 2-field perturbation (wrong garage, wrong total)', () => {
    const result = checkScorerDiscrimination();
    expect(result.perturbationCaught).toBe(true);
  });
});

describe('schedule eval assertions (evals/schedule/run.ts)', () => {
  it('passes a valid schedule and catches a broken one', async () => {
    const ok = await scheduleSelftest();
    expect(ok).toBe(true);
  });
});
