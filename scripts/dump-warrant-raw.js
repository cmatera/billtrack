// Read-only diagnostic: print a warrant's raw stored summaryRows and
// lineItems, optionally filtered to one batch, so a persistent
// batch-mismatch (from scan-warrant-issues.js / reviewFlags()) can be
// inspected directly instead of guessed at. Makes no API calls and writes
// nothing.
//
//   docker compose exec ledger node scripts/dump-warrant-raw.js --id=2026-08-06
//   docker compose exec ledger node scripts/dump-warrant-raw.js --id=2026-08-06 --batch=1057

const path = require("path");
const Database = require("better-sqlite3");

const DATA_DIR = process.env.DATA_DIR || path.join(__dirname, "..", "data");
const DB_FILE = path.join(DATA_DIR, "warrants.db");

const args = process.argv.slice(2);
const ONLY_ID = (args.find((a) => a.startsWith("--id=")) || "").slice(5) || null;
const ONLY_BATCH = (args.find((a) => a.startsWith("--batch=")) || "").slice(8) || null;

function round2(n) {
  return Math.round((Number(n) || 0) * 100) / 100;
}

function main() {
  if (!ONLY_ID) {
    console.error("Usage: node scripts/dump-warrant-raw.js --id=<warrant-id> [--batch=<batch>]");
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

  let summaryRows = row.summaryRows ? JSON.parse(row.summaryRows) : [];
  let lineItems = row.lineItems ? JSON.parse(row.lineItems) : [];

  if (ONLY_BATCH) {
    summaryRows = summaryRows.filter((r) => String(r.batch || "") === ONLY_BATCH);
    lineItems = lineItems.filter((li) => String(li.batch || "") === ONLY_BATCH);
  }

  console.log(`${ONLY_ID}${ONLY_BATCH ? ` (batch ${ONLY_BATCH})` : ""}:`);
  console.log(`\nsummaryRows (${summaryRows.length}):`);
  console.log(JSON.stringify(summaryRows, null, 2));
  console.log(`\nlineItems (${lineItems.length}), sum = ${round2(lineItems.reduce((a, li) => a + (Number(li.amount) || 0), 0))}:`);
  console.log(JSON.stringify(lineItems, null, 2));
}

main();
