// One-off, narrowly-scoped tool: correct a misread voucher number on a
// specific lineItem, with no Anthropic API call.
//
// Why this exists: none of the other correction tools touch the voucher
// field — correct-invoice-amount.js only changes amounts, remap-batch-
// labels.js only changes the batch field. Confirmed real case (2026-07-31):
// STAPLES' "Supplies for teachers" invoice in batch 1030 was extracted with
// voucher "97387", but the actual printed voucher (confirmed against the
// source PDF) is "97397" — a single-digit misread (9 read as 8). This
// accidentally collided with the true, separately-missing voucher 97387
// that belongs to an MPC Services invoice in batch 1032 (see
// add-missing-invoice.js), which is what surfaced this in the first place.
//
// Matched by batch + old voucher (not old voucher alone) so this can't
// accidentally touch the wrong item if a voucher number is duplicated
// across batches. Refuses to introduce a NEW collision — if the new
// voucher number already exists elsewhere in this warrant — unless
// --force is passed.
//
// Usage:
//
//   docker compose exec ledger node scripts/correct-voucher-number.js \
//     --id=2026-07-31 --batch=1030 --old-voucher=97387 --new-voucher=97397 --dry-run
//
// Drop --dry-run to save.

const path = require("path");
const Database = require("better-sqlite3");

const DATA_DIR = process.env.DATA_DIR || path.join(__dirname, "..", "data");
const DB_FILE = path.join(DATA_DIR, "warrants.db");

const args = process.argv.slice(2);
const DRY_RUN = args.includes("--dry-run");
const FORCE = args.includes("--force");
const ONLY_ID = (args.find((a) => a.startsWith("--id=")) || "").slice(5) || null;
const BATCH = (args.find((a) => a.startsWith("--batch=")) || "").slice(8) || null;
const OLD_VOUCHER = (args.find((a) => a.startsWith("--old-voucher=")) || "").slice(14) || null;
const NEW_VOUCHER = (args.find((a) => a.startsWith("--new-voucher=")) || "").slice(14) || null;

function main() {
  if (!ONLY_ID || !BATCH || !OLD_VOUCHER || !NEW_VOUCHER) {
    console.error(
      "Usage: node scripts/correct-voucher-number.js --id=<warrant-id> --batch=<b> --old-voucher=<old> --new-voucher=<new> [--force] [--dry-run]"
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
  const matches = lineItems.filter(
    (li) => String(li.batch || "") === BATCH && String(li.voucher || "") === OLD_VOUCHER
  );
  if (matches.length !== 1) {
    console.error(
      `  Expected exactly 1 lineItem in batch ${BATCH} with voucher ${OLD_VOUCHER}, found ${matches.length}. Nothing changed.`
    );
    process.exit(1);
  }
  const collision = lineItems.find((li) => String(li.voucher || "") === NEW_VOUCHER);
  if (collision && !FORCE) {
    console.error(
      `  Voucher ${NEW_VOUCHER} already exists elsewhere (batch ${collision.batch}, ${collision.vendor}, $${collision.amount}) — pass --force to override. Nothing changed.`
    );
    process.exit(1);
  }

  console.log(`${ONLY_ID}:`);
  console.log(
    `  batch ${BATCH} (${matches[0].vendor}, $${matches[0].amount}): voucher ${OLD_VOUCHER} -> ${NEW_VOUCHER}`
  );

  if (DRY_RUN) {
    console.log("\n[dry run] Nothing written — rerun without --dry-run to save it.");
    return;
  }

  const updated = lineItems.map((li) => {
    if (String(li.batch || "") === BATCH && String(li.voucher || "") === OLD_VOUCHER) {
      return { ...li, voucher: NEW_VOUCHER };
    }
    return li;
  });

  db.prepare("UPDATE warrants SET lineItems = ?, updatedAt = ? WHERE id = ?").run(
    JSON.stringify(updated),
    new Date().toISOString(),
    ONLY_ID
  );
  console.log("\nSaved.");
}

main();
