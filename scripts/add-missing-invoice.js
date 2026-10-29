// One-off, narrowly-scoped tool: append a line item that the extraction
// missed entirely, with no Anthropic API call.
//
// Why this exists: correct-invoice-amount.js can only correct an amount on
// a line item that's already stored — it has nothing to fix if an invoice
// was dropped from extraction altogether. Confirmed real case (2026-07-31,
// batch 1032): vouchers ran 97386, [gap], 97388 — voucher 97387 (MPC
// Services Inc, $12,025.16, "Elem. Pump 1&2/ Repair") never made it into
// lineItems at all. Checked directly against the source PDF's own page
// subtotal ("3 HELD INVOICES ... TOTAL 20,948.09") to confirm both the
// missing invoice's amount AND that the batch's summaryRows amount
// ($20,447.57) was itself short by exactly the same missing-GL-line pattern
// seen elsewhere in this cleanup — use correct-invoice-amount.js's
// --batch/--summary-amount to fix that half separately.
//
// Refuses to add a voucher that already exists in lineItems (use
// correct-invoice-amount.js for a correction, not this) or to add onto a
// batch with no existing summaryRows row (would just create an orphan).
//
// Usage:
//
//   docker compose exec ledger node scripts/add-missing-invoice.js \
//     --id=2026-07-31 --batch=1032 --voucher=97387 --vendor="MPC SERVICES INC" \
//     --amount=12025.16 --description="Elem. Pump 1&2/ Repair" --dry-run
//
// Drop --dry-run to save. Afterward, run correct-invoice-amount.js to fix
// the batch's summaryRows total if it also needs correcting, then
// recompute-totals.js to rebuild categories/vendors/invoiceCount/reconciled.

const path = require("path");
const Database = require("better-sqlite3");

const DATA_DIR = process.env.DATA_DIR || path.join(__dirname, "..", "data");
const DB_FILE = path.join(DATA_DIR, "warrants.db");

const args = process.argv.slice(2);
const DRY_RUN = args.includes("--dry-run");
const ONLY_ID = (args.find((a) => a.startsWith("--id=")) || "").slice(5) || null;
const BATCH = (args.find((a) => a.startsWith("--batch=")) || "").slice(8) || null;
const VOUCHER = (args.find((a) => a.startsWith("--voucher=")) || "").slice(10) || null;
const VENDOR = (args.find((a) => a.startsWith("--vendor=")) || "").slice(9) || null;
const AMOUNT = (args.find((a) => a.startsWith("--amount=")) || "").slice(9) || null;
const DESCRIPTION = (args.find((a) => a.startsWith("--description=")) || "").slice(14) || "";
const EXCEEDS_PO_BY = (args.find((a) => a.startsWith("--exceeds-po-by=")) || "").slice(16) || "0";

function round2(n) {
  return Math.round((Number(n) || 0) * 100) / 100;
}

function main() {
  if (!ONLY_ID || !BATCH || !VOUCHER || !VENDOR || !AMOUNT) {
    console.error(
      "Usage: node scripts/add-missing-invoice.js --id=<warrant-id> --batch=<b> --voucher=<v> --vendor=<name> --amount=<amt> [--description=<desc>] [--exceeds-po-by=<amt>] [--dry-run]"
    );
    process.exit(1);
  }
  if (!require("fs").existsSync(DB_FILE)) {
    console.error(`No database found at ${DB_FILE}`);
    process.exit(1);
  }
  const db = new Database(DB_FILE);
  const row = db.prepare("SELECT * FROM warrants WHERE id = ?").get(ONLY_ID);
  if (!row) {
    console.error(`No warrant found with id ${ONLY_ID}`);
    process.exit(1);
  }

  const lineItems = row.lineItems ? JSON.parse(row.lineItems) : [];
  const summaryRows = row.summaryRows ? JSON.parse(row.summaryRows) : [];

  const existing = lineItems.find((li) => String(li.voucher || "") === VOUCHER);
  if (existing) {
    console.error(
      `  Voucher ${VOUCHER} already exists in lineItems (amount ${existing.amount}) — use correct-invoice-amount.js to correct it, not this tool. Nothing changed.`
    );
    process.exit(1);
  }
  const batchKnown = summaryRows.some((r) => String(r.batch || "") === BATCH);
  if (!batchKnown) {
    console.error(`  Batch ${BATCH} has no summaryRows row — refusing to add onto an unknown batch. Nothing changed.`);
    process.exit(1);
  }

  const newItem = {
    vendor: VENDOR,
    description: DESCRIPTION,
    amount: round2(AMOUNT),
    exceedsPoBy: round2(EXCEEDS_PO_BY),
    batch: BATCH,
    voucher: VOUCHER,
  };

  console.log(`${ONLY_ID}:`);
  console.log(`  Adding voucher ${VOUCHER} to batch ${BATCH}: ${VENDOR}, $${newItem.amount} — "${DESCRIPTION}"`);

  if (DRY_RUN) {
    console.log("\n[dry run] Nothing written — rerun without --dry-run to save it.");
    return;
  }

  const updated = [...lineItems, newItem];
  db.prepare("UPDATE warrants SET lineItems = ?, updatedAt = ? WHERE id = ?").run(
    JSON.stringify(updated),
    new Date().toISOString(),
    ONLY_ID
  );
  console.log("\nSaved.");
}

main();
