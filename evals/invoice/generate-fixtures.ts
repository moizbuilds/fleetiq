/**
 * evals/invoice/generate-fixtures.ts
 *
 * Produces the 15 synthetic Qatar garage invoice images (evals/invoice/
 * images/inv-01.png .. inv-15.png) that evals/invoice/run.ts feeds through
 * lib/ai/invoice.ts's extractInvoice, plus the gold JSON answer key
 * (evals/invoice/gold/inv-*.json) each image is scored against.
 *
 * WHY one script generates BOTH the image and its gold file, from one
 * FIXTURES array, instead of hand-drawing images in an image editor and
 * separately typing out gold JSON: an invoice image and its gold answer are
 * two views of the SAME data. Authoring them separately is exactly the
 * "written in two places that could drift" trap globals.md warns about —
 * a typo fixing the image later without touching the gold file (or vice
 * versa) would silently make the eval score against the wrong answer. Here,
 * `renderInvoiceHtml` and the gold-JSON writer both read off the same
 * `InvoiceFixture` object, so the two can never disagree.
 *
 * WHY Playwright (not an image-editing library) to produce the PNGs: this
 * needs to render real HTML/CSS (fonts, rotation, opacity) to a bitmap the
 * way a phone camera or scanner would produce one — a canvas-drawing
 * approach would require hand-positioning every line of text. Playwright's
 * `page.setContent()` + `screenshot()` renders arbitrary HTML through a
 * real browser engine entirely offline (no dev server, no network) — see
 * task-10-report.md for the runnable command.
 *
 * Run: `npx tsx evals/invoice/generate-fixtures.ts`
 */
import { chromium } from 'playwright';
import fs from 'node:fs';
import path from 'node:path';
import type { AiInvoiceLineItem } from '../../lib/types';

const IMAGES_DIR = path.join(__dirname, 'images');
const GOLD_DIR = path.join(__dirname, 'gold');

// ---------------------------------------------------------------------------
// Eastern Arabic-Indic digit rendering — the DISPLAY-side inverse of
// evals/lib/normalize.ts's easternArabicToAscii. Used only by the
// 'arabic-numeral-total' fixture below, to render its total the way a real
// Qatar garage receipt sometimes does, so the eval can check whether
// Claude's vision reading correctly interprets the VALUE of those glyphs
// (not whether it can transliterate them back to Arabic — gold always
// stores the plain number).
// ---------------------------------------------------------------------------
const EASTERN_ARABIC_DIGITS = ['٠', '١', '٢', '٣', '٤', '٥', '٦', '٧', '٨', '٩'];
function toEasternArabicDigits(n: number): string {
  return n
    .toFixed(2)
    .split('')
    .map((ch) => (ch >= '0' && ch <= '9' ? EASTERN_ARABIC_DIGITS[Number(ch)] : ch))
    .join('');
}

// One of the 5 deliberately-hard rendering styles the brief requires.
// 'normal' covers the other 10 fixtures (varied garages/services/decimals,
// no special rendering trick).
type FixtureStyle =
  | 'normal'
  | 'handwritten-odometer'
  | 'faded'
  | 'rotated'
  | 'no-odometer'
  | 'arabic-numeral-total'
  | 'long-list';

interface InvoiceFixture {
  id: string;
  garageName: string;
  address: string;
  invoiceNo: string;
  serviceDate: string; // ISO YYYY-MM-DD — the gold ground truth
  dateDisplay: string; // how the invoice itself prints the date (DD/MM/YYYY, Qatar convention)
  odometerKm: number | null;
  odometerLabel: string; // labels vary across real invoices ("Odometer", "Mileage", "KM")
  lineItems: AiInvoiceLineItem[];
  style: FixtureStyle;
}

// WHY totalCostQar is NOT a field on InvoiceFixture: it's always the sum of
// lineItems[].costQar (a garage receipt total is derived from its line
// items, never an independent fact) — computing it in one place
// (computeTotal, below) instead of typing a matching number by hand removes
// an entire class of "gold total doesn't match gold line items" bugs.
function computeTotal(lineItems: AiInvoiceLineItem[]): number {
  const total = lineItems.reduce((sum, item) => sum + (item.costQar ?? 0), 0);
  return Math.round(total * 100) / 100;
}

const FIXTURES: InvoiceFixture[] = [
  {
    id: 'inv-01',
    garageName: 'Al Rayyan Auto Care',
    address: 'Al Rayyan Road, Doha',
    invoiceNo: 'ARC-2201',
    serviceDate: '2026-01-14',
    dateDisplay: '14/01/2026',
    odometerKm: 45231,
    odometerLabel: 'Odometer',
    lineItems: [
      { description: 'Engine oil change', partOrService: 'service', costQar: 79.5 },
      { description: 'Oil filter', partOrService: 'part', costQar: 35.25 },
      { description: 'Air filter', partOrService: 'part', costQar: 45 },
    ],
    style: 'normal',
  },
  {
    id: 'inv-02',
    garageName: 'Doha Motors Workshop',
    address: 'C-Ring Road, Doha',
    invoiceNo: 'DMW-0876',
    serviceDate: '2026-02-03',
    dateDisplay: '03/02/2026',
    odometerKm: 88210,
    odometerLabel: 'Mileage',
    lineItems: [
      { description: 'Front brake pads', partOrService: 'part', costQar: 219.5 },
      { description: 'Brake service labour', partOrService: 'service', costQar: 90 },
    ],
    style: 'normal',
  },
  {
    id: 'inv-03',
    garageName: 'Industrial Area Garage 24',
    address: 'Street 24, Industrial Area, Doha',
    invoiceNo: 'IAG24-1543',
    serviceDate: '2026-01-27',
    dateDisplay: '27/01/2026',
    odometerKm: 132870,
    odometerLabel: 'KM',
    lineItems: [
      { description: 'Tyre — front left', partOrService: 'part', costQar: 240 },
      { description: 'Tyre — front right', partOrService: 'part', costQar: 240 },
      { description: 'Wheel alignment', partOrService: 'service', costQar: 60 },
    ],
    style: 'normal',
  },
  {
    id: 'inv-04',
    garageName: 'Al Wakrah Fast Fit',
    address: 'Al Wakrah Main Street',
    invoiceNo: 'AWFF-3390',
    serviceDate: '2026-03-11',
    dateDisplay: '11/03/2026',
    odometerKm: 61045,
    odometerLabel: 'Odometer',
    lineItems: [
      { description: 'Battery replacement (70Ah)', partOrService: 'part', costQar: 310 },
      { description: 'Battery installation', partOrService: 'service', costQar: 20 },
    ],
    style: 'normal',
  },
  {
    id: 'inv-05',
    garageName: 'Corniche Car Clinic',
    address: 'Corniche Street, Doha',
    invoiceNo: 'CCC-0234',
    serviceDate: '2026-02-19',
    dateDisplay: '19/02/2026',
    odometerKm: 27655,
    odometerLabel: 'Odometer',
    lineItems: [
      { description: 'Engine oil change', partOrService: 'service', costQar: 75 },
      { description: 'Oil filter', partOrService: 'part', costQar: 30 },
    ],
    style: 'handwritten-odometer',
  },
  {
    id: 'inv-06',
    garageName: 'Salwa Road Auto Center',
    address: 'Salwa Road, Doha',
    invoiceNo: 'SRAC-5512',
    serviceDate: '2026-03-22',
    dateDisplay: '22/03/2026',
    odometerKm: 94300,
    odometerLabel: 'Odometer',
    lineItems: [
      { description: 'Coolant flush', partOrService: 'service', costQar: 150 },
      { description: 'Coolant (5L)', partOrService: 'part', costQar: 60 },
    ],
    style: 'faded',
  },
  {
    id: 'inv-07',
    garageName: 'Umm Ghuwailina Garage',
    address: 'Umm Ghuwailina, Doha',
    invoiceNo: 'UGG-0091',
    serviceDate: '2026-04-02',
    dateDisplay: '02/04/2026',
    odometerKm: 71920,
    odometerLabel: 'Mileage',
    lineItems: [
      { description: 'Transmission fluid change', partOrService: 'service', costQar: 200 },
      { description: 'Transmission filter', partOrService: 'part', costQar: 90 },
    ],
    style: 'rotated',
  },
  {
    id: 'inv-08',
    garageName: 'Al Sadd Service Point',
    address: 'Al Sadd, Doha',
    invoiceNo: 'ASSP-6620',
    serviceDate: '2026-01-08',
    dateDisplay: '08/01/2026',
    odometerKm: null, // deliberately no odometer field at all on this invoice
    odometerLabel: 'Odometer',
    lineItems: [
      { description: 'General service', partOrService: 'service', costQar: 250 },
      { description: 'Spark plugs (set)', partOrService: 'part', costQar: 80 },
    ],
    style: 'no-odometer',
  },
  {
    id: 'inv-09',
    garageName: 'Barwa Village Auto',
    address: 'Barwa Village, Doha',
    invoiceNo: 'BVA-1187',
    serviceDate: '2026-02-27',
    dateDisplay: '27/02/2026',
    odometerKm: 39412,
    odometerLabel: 'Odometer',
    lineItems: [
      { description: 'Engine oil change', partOrService: 'service', costQar: 150 },
      { description: 'Labour', partOrService: 'other', costQar: 100 },
    ],
    style: 'arabic-numeral-total', // total printed as ٢٥٠.٠٠ on the invoice
  },
  {
    id: 'inv-10',
    garageName: 'Lusail Motors',
    address: 'Lusail Marina District',
    invoiceNo: 'LM-4471',
    serviceDate: '2026-03-30',
    dateDisplay: '30/03/2026',
    odometerKm: 18205,
    odometerLabel: 'Odometer',
    lineItems: [
      { description: 'Engine oil change', partOrService: 'service', costQar: 70 },
      { description: 'Oil filter', partOrService: 'part', costQar: 30 },
      { description: 'Air filter', partOrService: 'part', costQar: 40 },
      { description: 'Cabin filter', partOrService: 'part', costQar: 35 },
      { description: 'Front brake pads', partOrService: 'part', costQar: 200 },
      { description: 'Rear brake pads', partOrService: 'part', costQar: 180 },
      { description: 'Wiper blades (pair)', partOrService: 'part', costQar: 25 },
      { description: 'Battery terminal cleaning', partOrService: 'service', costQar: 15 },
      { description: 'Coolant top-up', partOrService: 'service', costQar: 20 },
    ],
    style: 'long-list', // a long, multi-page-looking service history in one visit
  },
  {
    id: 'inv-11',
    garageName: 'Duhail Auto Works',
    address: 'Duhail, Doha',
    invoiceNo: 'DAW-0765',
    serviceDate: '2026-04-15',
    dateDisplay: '15/04/2026',
    odometerKm: 103550,
    odometerLabel: 'KM',
    lineItems: [
      { description: 'Serpentine belt', partOrService: 'part', costQar: 140 },
      { description: 'Belt installation', partOrService: 'service', costQar: 60 },
    ],
    style: 'normal',
  },
  {
    id: 'inv-12',
    garageName: 'Al Khor Garage',
    address: 'Al Khor Corniche',
    invoiceNo: 'AKG-2903',
    serviceDate: '2026-01-30',
    dateDisplay: '30/01/2026',
    odometerKm: 55890,
    odometerLabel: 'Odometer',
    lineItems: [
      { description: 'Cabin air filter', partOrService: 'part', costQar: 45 },
      { description: 'AC system service', partOrService: 'service', costQar: 120 },
    ],
    style: 'normal',
  },
  {
    id: 'inv-13',
    garageName: 'Mesaieed Fleet Services',
    address: 'Mesaieed Industrial City',
    invoiceNo: 'MFS-8814',
    serviceDate: '2026-02-11',
    dateDisplay: '11/02/2026',
    odometerKm: 158700,
    odometerLabel: 'Odometer',
    lineItems: [
      { description: 'Engine oil change', partOrService: 'service', costQar: 85 },
      { description: 'Oil filter', partOrService: 'part', costQar: 35 },
    ],
    style: 'normal',
  },
  {
    id: 'inv-14',
    garageName: 'Wakra Tyre & Battery',
    address: 'Al Wakrah Industrial Area',
    invoiceNo: 'WTB-4028',
    serviceDate: '2026-03-05',
    dateDisplay: '05/03/2026',
    odometerKm: 76140,
    odometerLabel: 'Mileage',
    lineItems: [
      { description: 'Engine oil change', partOrService: 'service', costQar: 90 },
      { description: 'Oil filter', partOrService: 'part', costQar: 35 },
      { description: 'Front brake pads', partOrService: 'part', costQar: 210 },
      { description: 'Battery replacement (80Ah)', partOrService: 'part', costQar: 300 },
      { description: 'Tyre — rear left', partOrService: 'part', costQar: 230 },
      { description: 'Tyre — rear right', partOrService: 'part', costQar: 230 },
    ],
    style: 'normal', // comprehensive full-service invoice covering many categories at once
  },
  {
    id: 'inv-15',
    garageName: 'Gharrafa Auto Care',
    address: 'Al Gharrafa, Doha',
    invoiceNo: 'GAC-1356',
    serviceDate: '2026-04-22',
    dateDisplay: '22/04/2026',
    odometerKm: 21980,
    odometerLabel: 'Odometer',
    lineItems: [
      { description: 'Coolant flush', partOrService: 'service', costQar: 130 },
      { description: 'Serpentine belt', partOrService: 'part', costQar: 100 },
    ],
    style: 'normal',
  },
];

// Renders one fixture's full-page invoice HTML. Deliberately plain
// receipt/letterhead styling (not FleetIQ's own Tier-A design system) —
// these are stand-ins for a real garage's paper invoice, not app UI, so
// they only need to look like a plausible printed/scanned receipt a phone
// camera could have captured.
function renderInvoiceHtml(fixture: InvoiceFixture): string {
  const total = computeTotal(fixture.lineItems);

  const rows = fixture.lineItems
    .map(
      (item) => `
        <tr>
          <td>${item.description}</td>
          <td class="type">${item.partOrService}</td>
          <td class="cost">QAR ${item.costQar!.toFixed(2)}</td>
        </tr>`,
    )
    .join('');

  const odometerRow =
    fixture.style === 'no-odometer'
      ? ''
      : `<div class="meta-row"><span class="label">${fixture.odometerLabel}:</span> <span class="odo${
          fixture.style === 'handwritten-odometer' ? ' handwritten' : ''
        }">${fixture.odometerKm!.toLocaleString('en-US')} km</span></div>`;

  const totalDisplay =
    fixture.style === 'arabic-numeral-total' ? toEasternArabicDigits(total) : `QAR ${total.toFixed(2)}`;

  // 'faded' -> low-contrast text on a near-white background (simulates a
  // sun-bleached or badly-scanned receipt). 'rotated' -> the whole page
  // tilted a few degrees (simulates a hand-held photo, not a flatbed scan).
  const pageStyle = fixture.style === 'rotated' ? 'transform: rotate(3deg);' : '';
  const textColor = fixture.style === 'faded' ? '#c9c9c9' : '#1a1a1a';
  const bgColor = fixture.style === 'faded' ? '#fafafa' : '#ffffff';

  return `<!doctype html>
<html>
<head>
<meta charset="utf-8" />
<style>
  * { box-sizing: border-box; }
  body { margin: 0; padding: 40px; background: #e5e5e5; font-family: Arial, Helvetica, sans-serif; }
  .invoice {
    width: 560px;
    margin: 0 auto;
    background: ${bgColor};
    color: ${textColor};
    padding: 32px;
    border: 1px solid #ccc;
    ${pageStyle}
  }
  .garage-name { font-size: 22px; font-weight: bold; margin-bottom: 2px; }
  .address { font-size: 12px; color: ${fixture.style === 'faded' ? '#d5d5d5' : '#555'}; margin-bottom: 16px; }
  .meta-row { font-size: 13px; margin-bottom: 4px; }
  .label { font-weight: bold; }
  .odo { font-family: Georgia, serif; }
  .odo.handwritten {
    font-family: 'Bradley Hand', 'Noteworthy', 'Comic Sans MS', cursive;
    font-size: 20px;
    color: #1e3a8a;
  }
  table { width: 100%; border-collapse: collapse; margin-top: 16px; font-size: 13px; }
  th, td { text-align: left; padding: 6px 4px; border-bottom: 1px solid ${
    fixture.style === 'faded' ? '#eee' : '#ddd'
  }; }
  th.type, td.type { text-transform: capitalize; color: #777; width: 80px; }
  th.cost, td.cost { text-align: right; width: 100px; }
  .total-row { display: flex; justify-content: space-between; margin-top: 16px; font-size: 16px; font-weight: bold; border-top: 2px solid ${textColor}; padding-top: 10px; }
</style>
</head>
<body>
  <div class="invoice">
    <div class="garage-name">${fixture.garageName}</div>
    <div class="address">${fixture.address} · Invoice #${fixture.invoiceNo}</div>
    <div class="meta-row"><span class="label">Date:</span> ${fixture.dateDisplay}</div>
    ${odometerRow}
    <table>
      <thead><tr><th>Description</th><th class="type">Type</th><th class="cost">Cost</th></tr></thead>
      <tbody>${rows}</tbody>
    </table>
    <div class="total-row"><span>Total</span><span>${totalDisplay}</span></div>
  </div>
</body>
</html>`;
}

async function main() {
  fs.mkdirSync(IMAGES_DIR, { recursive: true });
  fs.mkdirSync(GOLD_DIR, { recursive: true });

  const browser = await chromium.launch();
  try {
    const page = await browser.newPage({ viewport: { width: 640, height: 900 } });

    for (const fixture of FIXTURES) {
      const html = renderInvoiceHtml(fixture);
      await page.setContent(html, { waitUntil: 'networkidle' });

      const invoiceEl = page.locator('.invoice');
      const imagePath = path.join(IMAGES_DIR, `${fixture.id}.png`);
      await invoiceEl.screenshot({ path: imagePath });

      // Gold answer key — the exact shape aiInvoiceSchema (lib/types.ts)
      // validates a real extraction against. confidenceNotes is always ""
      // here: that field records what the MODEL wasn't sure about, which
      // has no ground truth of its own, so it's excluded from scoring
      // (see evals/lib/score.ts) and left blank in gold.
      const gold = {
        garageName: fixture.garageName,
        serviceDate: fixture.serviceDate,
        odometerKm: fixture.odometerKm,
        totalCostQar: computeTotal(fixture.lineItems),
        lineItems: fixture.lineItems,
        confidenceNotes: '',
      };
      fs.writeFileSync(path.join(GOLD_DIR, `${fixture.id}.json`), JSON.stringify(gold, null, 2) + '\n');

      console.log(`Generated ${fixture.id} (${fixture.style}) — ${fixture.garageName}`);
    }
  } finally {
    await browser.close();
  }

  console.log(`\nDone — ${FIXTURES.length} fixtures written to ${IMAGES_DIR} and ${GOLD_DIR}.`);
}

main().catch((err) => {
  console.error('Fixture generation failed:', err);
  process.exit(1);
});
