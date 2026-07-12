/**
 * The dashboard's "ignition self-test" — on first mount, briefly flashes
 * every annunciator lamp lit in sequence (like a real vehicle's dash
 * lighting up every warning lamp for a second when you turn the key) and
 * rolls the odometer digits up from zero, before settling to the real
 * values. Purely a loading flourish, per .superpowers/sdd/globals.md.
 *
 * CONCEPT: `prefers-reduced-motion` is a media query that reflects the
 * user's OS-level "reduce motion" accessibility setting. Skipping this
 * animation for those users isn't optional politeness — motion like a
 * flashing/rolling display can trigger real physical discomfort (nausea,
 * vertigo) for people with vestibular disorders, so this component checks
 * it before ever starting the sequence and renders the FINAL values
 * immediately when the check fails.
 *
 * WHY a render-prop (`children` as a function) instead of this component
 * rendering the readout/lamps itself: VehicleRow's OdometerReadout and
 * AnnunciatorLamp strip sit in different flex columns of the row (center
 * vs. right), not adjacent DOM — a render-prop lets ONE animation-state
 * source (this component) drive both regions without forcing them into the
 * same physical wrapper element.
 */
'use client';

import { useEffect, useState } from 'react';

const FLASH_STAGGER_MS = 60;
const DIGIT_ROLL_MS = 400;

export interface IgnitionState {
  // Current value to show in OdometerReadout while rolling — starts at 0,
  // eases up to the real km over DIGIT_ROLL_MS, then holds there.
  displayKm: number | null;
  // Per-lamp "flash" flags — index i is true while lamp i is mid-flash
  // during the self-test sweep, independent of that lamp's real lit state.
  flashing: boolean[];
  // Once true, the self-test has finished (or was skipped for reduced
  // motion) — callers should render every lamp at its own real lit state.
  settled: boolean;
}

function restState(targetKm: number | null, lampCount: number): IgnitionState {
  return { displayKm: targetKm, flashing: Array(lampCount).fill(false), settled: true };
}

export function IgnitionSequence({
  targetKm,
  lampCount,
  children,
}: {
  targetKm: number | null;
  lampCount: number;
  children: (state: IgnitionState) => React.ReactNode;
}) {
  // Defaults to the FINAL state — before the reduced-motion check can run
  // (it needs the browser's `window`, so it only happens inside the effect
  // below), the readout/lamps already show real values rather than a
  // permanently-zeroed display if JS is slow to hydrate or never runs.
  const [state, setState] = useState<IgnitionState>(() => restState(targetKm, lampCount));

  useEffect(() => {
    const prefersMotion = window.matchMedia('(prefers-reduced-motion: no-preference)').matches;
    // Reduced motion: the useState initializer above already produced the
    // rest state, so there's nothing further to do — no setState call
    // needed here at all.
    if (!prefersMotion) return;

    let cancelled = false;
    let raf = 0;
    let lampTimers: ReturnType<typeof setTimeout>[] = [];
    let settleTimer: ReturnType<typeof setTimeout> | undefined;

    // WHY the whole sequence kicks off inside a requestAnimationFrame
    // callback instead of directly in the effect body: React's
    // react-hooks/set-state-in-effect rule flags a setState call made
    // SYNCHRONOUSLY while an effect is running (it can trigger a cascading
    // extra render before the browser ever paints) — deferring every
    // setState into a callback (rAF here, setTimeout below) is the
    // supported way to drive a self-contained animation from an effect.
    const kickoff = requestAnimationFrame(() => {
      if (cancelled) return;
      setState({ displayKm: 0, flashing: Array(lampCount).fill(false), settled: false });

      // Lamp flash sweep — lights lamp i, one at a time, staggered.
      lampTimers = Array.from({ length: lampCount }, (_, i) =>
        setTimeout(() => {
          if (cancelled) return;
          setState((prev) => {
            const flashing = [...prev.flashing];
            flashing[i] = true;
            return { ...prev, flashing };
          });
        }, i * FLASH_STAGGER_MS),
      );

      // Digit roll — a simple eased JS counter from 0 to targetKm using
      // requestAnimationFrame (CSS transform on a digit column would need a
      // fixed set of pre-rendered digit strips to slide past; a plain
      // counter is simpler and just as smooth for a ~400ms readout, per
      // task-8-brief.md's "keep simple and performant").
      const startedAt = performance.now();
      function tick(now: number) {
        if (cancelled) return;
        const progress = Math.min(1, (now - startedAt) / DIGIT_ROLL_MS);
        const eased = 1 - (1 - progress) ** 3; // ease-out cubic
        const km = targetKm === null ? null : Math.round(targetKm * eased);
        setState((prev) => ({ ...prev, displayKm: km }));
        if (progress < 1) raf = requestAnimationFrame(tick);
      }
      raf = requestAnimationFrame(tick);

      // Settle — once the longer of (lamp sweep, digit roll) has finished,
      // snap every lamp/digit to its real, final value.
      const settleDelay = Math.max(lampCount * FLASH_STAGGER_MS, DIGIT_ROLL_MS) + 120;
      settleTimer = setTimeout(() => {
        if (!cancelled) setState(restState(targetKm, lampCount));
      }, settleDelay);
    });

    return () => {
      cancelled = true;
      cancelAnimationFrame(kickoff);
      lampTimers.forEach(clearTimeout);
      clearTimeout(settleTimer);
      cancelAnimationFrame(raf);
    };
    // Deliberately empty deps: "run once per page load" (task-8-brief.md),
    // not once per prop change — a vehicle's targetKm/lampCount don't
    // change during a single page view without a full reload anyway.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  return <>{children(state)}</>;
}
