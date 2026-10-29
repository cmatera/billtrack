// One-off, narrowly-scoped tool: directly correct a specific lineItem's
// amount (matched by batch+voucher) and/or a specific summaryRows row's
// amount (matched by batch), with no Anthropic API call.
//
// Why this exists: a GL-split invoice (one invoice, Net Amount allocated
// across two or more GL account lines) can get misread as just one of its
// GL sub-amounts instead of the invoice's actual Net Amount — in either the
// line-item extraction, the batch-summary extraction, or both. Confirmed
// real case (2026-09-03): batch 1176 (Whitewater, Inc., voucher 98096) has
// true Net Amount $16,408.00 ($14,000.00 + $2,408.00 across two GL lines)
// — the line item already has this right, but the summary row only
// captured the $14,000.00 GL line. Batch 1177 (Deere & Company, voucher
// 98097) has true Net Amount $52,812.79 ($52,000.00 + $812.79) — BOTH the
// line item ($2,812.79) and the summary row ($52,000.00) only captured one
// GL sub-amount each, neither the full figure. This can't be derived from
// already-stored data the way the duplicate-page or batch-mislabel fixes
// could — it requires a human reading the true Net Amount off the source
// PDF (or the Munis "Invoice Entry Proof List" screen) and supplying it
// here directly.
//
// Usage (either or both of --voucher/--line-amount and --batch/--summary-amount):
//
//   docker compose exec ledger node scripts/correct-invoice-amount.js \
//     --id=2026-09-03 --batch=1176 --summary-amount=16408.00 --dry-run
//
//   docker compose exec ledger node scripts/correct-invoice-amount.js \
//     --id=2026-09-03 --voucher=98097 --line-amount=52812.79 --batch=1177 --summary-amount=52812.79 --dry-run
//
// Drop --dry-run to save. Afterward, run recompute-totals.js --id=<id> to
// rebuild categories/vendors/invoiceCount/reconciled from the corrected data.
// --batch alone requires exactly one summaryRows row for that batch (pass
// --department to disambiguate a batch with more than one row) — refuses
// rather than guessing which row to correct.

const path = require("path");
const Database = require("better-sqlite3");

const DATA_DIR = process.env.DATA_DIR || path.join(__dirname, "..", "data");
const DB_FILE = path.join(DATA_DIR, "warrants.db");

const args = process.argv.slice(2);
const DRY_RUN = args.includes("--dry-run");
const ONLY_ID = (args.find((a) => a.startsWith("--id=")) || "").slice(5) || null;
const VOUCHER = (args.find((a) => a.startsWith("--voucher=")) || "").slice(10) || null;
const LINE_AMOUNT = (args.find((a) => a.startsWith("--line-amount=")) || "").slice(14) || null;
const BATCH = (args.find((a) => a.startsWith("--batch=")) || "").slice(8) || null;
const SUMMARY_AMOUNT = (args.find((a) => a.startsWith("--summary-amount=")) || "").slice(17) || null;
const DEPARTMENT = (args.find((a) => a.startsWith("--department=")) || "").slice(13) || null;

function round2(n) {
  return Math.round((Number(n) || 0) * 100) / 100;
}

function main() {
  if (!ONLY_ID || (!VOUCHER && !BATCH) || (VOUCHER && !LINE_AMOUNT) || (BATCH && !SUMMARY_AMOUNT && !VOUCHER)) {
    console.error(
      "Usage: node scripts/correct-invoice-amount.js --id=<warrant-id> " +
        "[--voucher=<v> --line-amount=<amt>] [--batch=<b> --summary-amount=<amt>] [--department=<d>] [--dry-run]"
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

  let lineItems = row.lineItems ? JSON.parse(row.lineItems) : [];
  let summaryRows = row.summaryRows ? JSON.parse(row.summaryRows) : [];
  let changed = false;

  console.log(`${ONLY_ID}:`);

  if (VOUCHER && LINE_AMOUNT) {
    const matches = lineItems.filter((li) => String(li.voucher || "") === VOUCHER);
    if (matches.length !== 1) {
      console.error(`  Expected exactly 1 lineItem with voucher ${VOUCHER}, found ${matches.length}. Nothing changed.`);
      process.exit(1);
    }
    const old = matches[0].amount;
    console.log(`  lineItem voucher ${VOUCHER} (${matches[0].vendor}): amount ${old} -> ${round2(LINE_AMOUNT)}`);
    lineItems = lineItems.map((li) =>
      String(li.voucher || "") === VOUCHER ? { ...li, amount: round2(LINE_AMOUNT) } : li
    );
    changed = true;
  }

  if (BATCH && SUMMARY_AMOUNT) {
    let matches = summaryRows.filter((r) => String(r.batch || "") === BATCH);
    if (DEPARTMENT) matches = matches.filter((r) => String(r.department || "") === DEPARTMENT);
    if (matches.length !== 1) {
      console.error(
        `  Expected exactly 1 summaryRows row for batch ${BATCH}${DEPARTMENT ? ` / department "${DEPARTMENT}"` : ""}, found ${matches.length}. Pass --department to disambiguate. Nothing changed.`
      );
      process.exit(1);
    }
    const old = matches[0].amount;
    console.log(
      `  summaryRows batch ${BATCH} (${matches[0].department}): amount ${old} -> ${round2(SUMMARY_AMOUNT)}`
    );
    summaryRows = summaryRows.map((r) => {
      if (String(r.batch || "") !== BATCH) return r;
      if (DEPARTMENT && String(r.department || "") !== DEPARTMENT) return r;
      return { ...r, amount: round2(SUMMARY_AMOUNT) };
    });
    changed = true;
  }

  if (!changed) {
    console.error("  Nothing to change given the arguments provided.");
    process.exit(1);
  }

  if (DRY_RUN) {
    console.log("\n[dry run] Nothing written — rerun without --dry-run to save it.");
    return;
  }

  db.prepare("UPDATE warrants SET lineItems = ?, summaryRows = ?, updatedAt = ? WHERE id = ?").run(
    JSON.stringify(lineItems),
    JSON.stringify(summaryRows),
    new Date().toISOString(),
    ONLY_ID
  );
  console.log("\nSaved. Run recompute-totals.js --id=" + ONLY_ID + " next to rebuild categories/vendors/invoiceCount/reconciled.");
}

main();
