// One-off, narrowly-scoped tool: recompute a single warrant's top-line
// categories/vendors/invoiceCount/reconciled fields directly from its
// already-correct summaryRows/lineItems columns, with no Anthropic API call.
//
// Why this exists: scripts/backfill-summary-rows.js deliberately only ever
// writes summaryRows/lineItems, never categories/vendors/invoiceCount/total/
// reconciled (see its own header) — so after running it with --force to pick
// up a fix to the extraction logic (e.g. the duplicate-page/vendor-prefix
// fix), those top-line fields are still whatever the OLD, buggy logic
// computed at original upload time. This script closes that gap for one
// warrant at a time: it recomputes categories (sum of summaryRows amounts
// by category) and vendors (sum of lineItems amounts by vendor — already
// deduped/normalized, since that happens upstream, before this ever runs)
// straight from what's already stored, and recomputes invoiceCount
// (lineItems.length) and reconciled (categories total vs the stored total)
// to match. total itself is left exactly as-is — it comes from the cover
// page, which isn't affected by either the duplicate-page bug or the
// vendor-prefix bug this was built to clean up after.
//
// Typical flow for a warrant flagged by Needs Review's new "batch-mismatch"
// badge (see reviewFlags() in public/index.html):
//
//   docker compose exec ledger node scripts/backfill-summary-rows.js --force --id=2026-06-04
//   docker compose exec ledger node scripts/recompute-totals.js --id=2026-06-04 --dry-run
//   docker compose exec ledger node scripts/recompute-totals.js --id=2026-06-04
//
// --id is required (no bulk mode) — this is a deliberate, narrow tool for
// correcting a specific flagged warrant, not a routine backfill.

const path = require("path");
const Database = require("better-sqlite3");

const DATA_DIR = process.env.DATA_DIR || path.join(__dirname, "..", "data");
const DB_FILE = path.join(DATA_DIR, "warrants.db");

const args = process.argv.slice(2);
const DRY_RUN = args.includes("--dry-run");
const ONLY_ID = (args.find((a) => a.startsWith("--id=")) || "").slice(5) || null;

function round2(n) {
  return Math.round((Number(n) || 0) * 100) / 100;
}

function sumValues(obj) {
  return round2(Object.values(obj || {}).reduce((a, b) => a + (Number(b) || 0), 0));
}

// Same aggregation public/index.html's buildCategories()/buildVendors() do —
// summaryRows/lineItems stored by the backfill script don't carry an
// "include" flag (that only exists in the browser's interactive review
// table), so every stored row is treated as included here.
function buildCategories(summaryRows) {
  const out = {};
  (summaryRows || []).forEach((r) => {
    const cat = r.category || "Uncategorized";
    out[cat] = round2((out[cat] || 0) + (Number(r.amount) || 0));
  });
  return out;
}
function buildVendors(lineItems) {
  const out = {};
  (lineItems || []).forEach((r) => {
    const v = r.vendor || "Unknown vendor";
    out[v] = round2((out[v] || 0) + (Number(r.amount) || 0));
  });
  return out;
}

function main() {
  if (!ONLY_ID) {
    console.error("Usage: node scripts/recompute-totals.js --id=<warrant-id> [--dry-run]");
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

  const summaryRows = row.summaryRows ? JSON.parse(row.summaryRows) : [];
  const lineItems = row.lineItems ? JSON.parse(row.lineItems) : [];
  if (!summaryRows.length && !lineItems.length) {
    console.error(`${ONLY_ID} has no summaryRows/lineItems to recompute from — run backfill-summary-rows.js first.`);
    process.exit(1);
  }

  const categories = buildCategories(summaryRows);
  const vendors = buildVendors(lineItems);
  const invoiceCount = lineItems.length || null;
  const categoriesSum = sumValues(categories);
  const oldVendorsSum = row.vendors ? sumValues(JSON.parse(row.vendors)) : null;
  const total = row.total == null ? null : round2(row.total);
  const reconciled = total != null ? Math.abs(round2(categoriesSum - total)) < 0.02 : row.reconciled === null ? null : Boolean(row.reconciled);

  console.log(`${ONLY_ID}:`);
  console.log(`  invoiceCount: ${row.invoiceCount}  ->  ${invoiceCount}`);
  console.log(`  vendors total: ${oldVendorsSum == null ? "(none stored)" : oldVendorsSum}  ->  ${sumValues(vendors)}`);
  console.log(`  categories total: ${categoriesSum}  (stored warrant total, unaffected by this fix: ${total})`);
  console.log(`  reconciled: ${row.reconciled}  ->  ${reconciled}`);

  if (DRY_RUN) {
    console.log("\n[dry run] Nothing written — rerun without --dry-run to save it.");
    return;
  }

  db.prepare("UPDATE warrants SET categories = ?, vendors = ?, invoiceCount = ?, reconciled = ?, updatedAt = ? WHERE id = ?").run(
    JSON.stringify(categories),
    JSON.stringify(vendors),
    invoiceCount,
    reconciled === null ? null : reconciled ? 1 : 0,
    new Date().toISOString(),
    ONLY_ID
  );
  console.log("\nSaved.");
}

main();
