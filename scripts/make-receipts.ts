/**
 * Generates the three demo receipt images.
 *
 * These are the receipts for the structuring scenario: one consulting
 * engagement invoiced as three separate charges, each just under Northwind's
 * $4,000 approval threshold.
 *
 * Rendering pipeline is macOS-native, no dependencies:
 *   HTML  --qlmanage-->  PNG
 *
 * They need to be legible twice over: readable by the model's vision when
 * read_receipt hands it a signed URL, and readable from the back of a
 * conference room when it goes on screen.
 *
 *   pnpm receipts
 */
import { execFileSync } from "node:child_process";
import { mkdirSync, writeFileSync, rmSync, renameSync } from "node:fs";
import { join } from "node:path";

const OUT_DIR = join(process.cwd(), "scripts/fixtures/receipts");
const TMP_DIR = "/tmp/eta-receipts";

type Receipt = {
  file: string;
  invoice: string;
  phase: string;
  lines: Array<{ desc: string; qty: string; rate: string; amount: number }>;
};

const RECEIPTS: Receipt[] = [
  {
    file: "receipt-1.png",
    invoice: "MC-2291",
    phase: "Phase 1 — Discovery",
    lines: [
      { desc: "Stakeholder interviews", qty: "12 hrs", rate: "$185.00", amount: 222000 },
      { desc: "Systems audit", qty: "6 hrs", rate: "$185.00", amount: 111000 },
      { desc: "Findings report", qty: "1", rate: "$610.00", amount: 61000 },
    ],
  },
  {
    file: "receipt-2.png",
    invoice: "MC-2292",
    phase: "Phase 2 — Architecture",
    lines: [
      { desc: "Reference architecture", qty: "14 hrs", rate: "$185.00", amount: 259000 },
      { desc: "Migration plan", qty: "5 hrs", rate: "$185.00", amount: 92500 },
      { desc: "Review workshop", qty: "1", rate: "$360.00", amount: 36000 },
    ],
  },
  {
    file: "receipt-3.png",
    invoice: "MC-2293",
    phase: "Phase 3 — Handover",
    lines: [
      { desc: "Implementation support", qty: "15 hrs", rate: "$185.00", amount: 277500 },
      { desc: "Runbook authoring", qty: "4 hrs", rate: "$185.00", amount: 74000 },
      { desc: "Team enablement session", qty: "1", rate: "$475.00", amount: 47500 },
    ],
  },
  /**
   * The one entered live on camera.
   *
   * Not seeded — `pnpm seed` only creates MC-2291..2293. This receipt exists so
   * there is a file to attach when the expense is created during the recording,
   * and its total must match what gets typed into the form ($3,995.00). The
   * agent reads this image and compares it against the claimed amount, so a
   * mismatch here produces a second, competing finding.
   *
   * $3,995.00 is deliberate: $5 under the $4,000 approval threshold, and it
   * brings the four-invoice total to a round $15,800.00.
   */
  {
    file: "receipt-4.png",
    invoice: "MC-2294",
    phase: "Phase 4 — Extended support",
    lines: [
      { desc: "Extended support retainer", qty: "18 hrs", rate: "$185.00", amount: 333000 },
      { desc: "Escalation coverage", qty: "1", rate: "$665.00", amount: 66500 },
    ],
  },
];

const usd = (cents: number) =>
  "$" + (cents / 100).toLocaleString("en-US", { minimumFractionDigits: 2 });

const today = new Date().toLocaleDateString("en-US", {
  year: "numeric",
  month: "long",
  day: "numeric",
});

function html(r: Receipt): string {
  const total = r.lines.reduce((s, l) => s + l.amount, 0);
  const rows = r.lines
    .map(
      (l) => `<tr>
        <td class="d">${l.desc}</td>
        <td class="q">${l.qty}</td>
        <td class="q">${l.rate}</td>
        <td class="a">${usd(l.amount)}</td>
      </tr>`,
    )
    .join("");

  // QuickLook renders HTML in a ~1024px viewport, then scales that to the -s
  // dimension. Anything wider than 1024 is cropped, not shrunk — so the layout
  // is authored at exactly 1024x1024 and comes out filling a 1400x1400 PNG at
  // ~1.37x, which also sharpens the type.
  return `<!doctype html><html><head><meta charset="utf-8"><style>
  * { box-sizing: border-box; margin: 0; padding: 0; }
  body {
    width: 1024px; height: 1024px;
    font-family: "Helvetica Neue", Helvetica, Arial, sans-serif;
    background: #f2f0ec; display: flex; align-items: center; justify-content: center;
  }
  .paper {
    width: 900px; background: #fff; padding: 40px 46px;
    border: 1px solid #d8d3ca; box-shadow: 0 5px 22px rgba(0,0,0,.10);
  }
  .brand { font-size: 35px; font-weight: 800; letter-spacing: -0.4px; }
  .sub   { font-size: 15px; color: #6b6b6b; margin-top: 5px; }
  .rule  { height: 3px; background: #111; margin: 20px 0 18px; }
  .meta  { display: flex; justify-content: space-between; font-size: 17px; margin-bottom: 6px; }
  .meta .k { color: #6b6b6b; }
  .meta .v { font-weight: 700; }
  table { width: 100%; border-collapse: collapse; margin-top: 22px; }
  th { text-align: left; font-size: 13px; letter-spacing: 1.2px; color: #6b6b6b;
       text-transform: uppercase; padding-bottom: 9px; border-bottom: 2px solid #111; }
  td { font-size: 18px; padding: 13px 0; border-bottom: 1px solid #e6e2da; }
  td.q { text-align: right; color: #4a4a4a; white-space: nowrap; padding-left: 18px; }
  td.a { text-align: right; font-weight: 700; white-space: nowrap; padding-left: 18px; }
  th.r { text-align: right; }
  .totals { margin-top: 20px; display: flex; justify-content: flex-end; }
  .totals table { width: 360px; margin-top: 0; }
  .totals td { border: none; padding: 6px 0; font-size: 18px; }
  .totals td.lbl { color: #6b6b6b; }
  .totals td.val { text-align: right; }
  .grand td { border-top: 3px solid #111; padding-top: 14px !important;
              font-size: 31px; font-weight: 800; }
  .foot { margin-top: 26px; font-size: 15px; color: #6b6b6b; line-height: 1.6; }
</style></head><body>
  <div class="paper">
    <div class="brand">MERIDIAN CONSULTING</div>
    <div class="sub">418 Harbour Street, Suite 9 &middot; Portland, OR 97204</div>
    <div class="rule"></div>
    <div class="meta"><span class="k">Invoice</span><span class="v">${r.invoice}</span></div>
    <div class="meta"><span class="k">Date</span><span class="v">${today}</span></div>
    <div class="meta"><span class="k">Bill to</span><span class="v">Northwind Labs</span></div>
    <div class="meta"><span class="k">Engagement</span><span class="v">${r.phase}</span></div>
    <table>
      <thead><tr>
        <th>Description</th><th class="r">Qty</th><th class="r">Rate</th><th class="r">Amount</th>
      </tr></thead>
      <tbody>${rows}</tbody>
    </table>
    <div class="totals"><table>
      <tr><td class="lbl">Subtotal</td><td class="val">${usd(total)}</td></tr>
      <tr><td class="lbl">Tax</td><td class="val">$0.00</td></tr>
      <tr class="grand"><td>TOTAL</td><td class="val">${usd(total)}</td></tr>
    </table></div>
    <div class="foot">Paid by corporate card &bull;&bull;&bull;&bull; 4417<br>
      Thank you for your business.</div>
  </div>
</body></html>`;
}

function main() {
  mkdirSync(OUT_DIR, { recursive: true });
  rmSync(TMP_DIR, { recursive: true, force: true });
  mkdirSync(TMP_DIR, { recursive: true });

  for (const r of RECEIPTS) {
    const total = r.lines.reduce((s, l) => s + l.amount, 0);
    const htmlPath = join(TMP_DIR, r.file.replace(".png", ".html"));
    writeFileSync(htmlPath, html(r));

    // qlmanage renders via QuickLook and names the output <input>.png
    execFileSync("qlmanage", ["-t", "-s", "1400", "-o", TMP_DIR, htmlPath], {
      stdio: "ignore",
    });

    renameSync(join(TMP_DIR, `${r.file.replace(".png", ".html")}.png`), join(OUT_DIR, r.file));
    console.log(`  ${r.file}  ${r.invoice}  ${usd(total)}`);
  }

  const grand = RECEIPTS.reduce(
    (s, r) => s + r.lines.reduce((t, l) => t + l.amount, 0),
    0,
  );
  console.log(`\n  combined: ${usd(grand)} across ${RECEIPTS.length} invoices`);
  console.log(`  threshold: $4,000.00 — each invoice clears it, the total does not`);
  rmSync(TMP_DIR, { recursive: true, force: true });
}

main();
