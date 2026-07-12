/**
 * Demo-mode banner — a persistent strip across the top of every page,
 * mounted only by app/layout.tsx's demo-mode branch (lib/demo.ts). Its one
 * job is to make it unmistakable that this isn't a real signed-in fleet:
 * the data is sample data, and nothing typed into the app leaves this
 * machine.
 *
 * WHY the "eyebrow" stencil-label treatment instead of amber/a warning
 * color: globals.css reserves red/amber/green as the ONLY saturated colors
 * in the app, and only for maintenance/compliance status (overdue/due-soon/
 * ok) — see app/globals.css's header comment. Demo mode isn't a warning
 * about something wrong with a vehicle, so borrowing that same amber would
 * visually claim a status meaning it doesn't have. A quiet panel-toned
 * strip using the same tokens as every other chrome element (nav rail,
 * SetupNotice) reads as "this is part of the app's own chrome", not "pay
 * attention, something needs fixing".
 */
export function DemoModeBanner() {
  return (
    <div className="border-b border-seam bg-panel-2 px-4 py-2.5 md:px-8">
      <p className="eyebrow">Demo mode</p>
      <p className="mt-1 text-xs text-steel">
        Sample fleet data — no sign-in, no live database, no external services.
      </p>
    </div>
  );
}
