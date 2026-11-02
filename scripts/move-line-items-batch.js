// One-off, narrowly-scoped tool: move SPECIFIC line items (by voucher) from
// one batch to another, with no Anthropic API call.
//
// Why this exists: remap-batch-labels.js relabels EVERY lineItem currently
// tagged with a given old batch — correct for a whole-batch OCR misread
// (e.g. "834" -> "854"), but wrong here. Confirmed real case (2026-10-29,
// batch 1419): 3 of that batch's 5 line items (vouchers 99554/99555/99556,
// ZOLL MEDICAL / MCKESSON MEDICAL, summing to exactly $477.85) were
// mistagged batch 1419 (Transportation Contracted) when they belong to
// batch 1415 (Health) — confirmed two ways: (1) 1419's line items summed to
// $477.85 over its own batch-summary total, which is exactly 1415's summary
// amount while 1415 itself had zero line items; (2) all 3 items use GL
// accounts prefixed "3205...", a distinct family from the other two 1419
// items ("3304..."), consistent with a medical/health account range.
// remap-batch-labels.js would have had to move all 5 of 1419's items, not
// just these 3 — this tool moves an explicit voucher list instead.
//
// Refuses to move a voucher that isn't found under --old-batch (never
// guesses), and refuses to move onto a target batch with no summaryRows row
// (would just create an orphan) unless --force-unknown-target is passed.
//
// Usage:
//
//   docker compose exec ledger node scripts/move-line-items-batch.js \
//     --id=2026-10-29 --old-batch=1419 --vouchers=99554,99555,99556 --new-batch=1415 --dry-run
//
// Drop --dry-run to save. Afterward, run recompute-totals.js if this changed
// which category a batch's dollars roll up to.

const path = require("path");
const Database = require("better-sqlite3");

const DATA_DIR = process.env.DATA_DIR || path.join(__dirname, "..", "data");
const DB_FILE = path.join(DATA_DIR, "warrants.db");

const args = process.argv.slice(2);
const DRY_RUN = args.includes("--dry-run");
const FORCE_UNKNOWN_TARGET = args.includes("--force-unknown-target");
const ONLY_ID = (args.find((a) => a.startsWith("--id=")) || "").slice(5) || null;
const OLD_BATCH = (args.find((a) => a.startsWith("--old-batch=")) || "").slice(12) || null;
const NEW_BATCH = (args.find((a) => a.startsWith("--new-batch=")) || "").slice(12) || null;
const VOUCHERS_RAW = (args.find((a) => a.startsWith("--vouchers=")) || "").slice(11) || null;

function round2(n) {
  return Math.round((Number(n) || 0) * 100) / 100;
}

function main() {
  if (!ONLY_ID || !OLD_BATCH || !NEW_BATCH || !VOUCHERS_RAW) {
    console.error(
      "Usage: node scripts/move-line-items-batch.js --id=<warrant-id> --old-batch=<old> --vouchers=<v1,v2,...> --new-batch=<new> [--force-unknown-target] [--dry-run]"
    );
    process.exit(1);
  }
  if (!require("fs").existsSync(DB_FILE)) {
    console.error(`No database found at ${DB_FILE}`);
    process.exit(1);
  }
  const vouchers = VOUCHERS_RAW.split(",").map((v) => v.trim()).filter(Boolean);
  if (!vouchers.length) {
    console.error("No vouchers given in --vouchers. Nothing changed.");
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

  const newBatchKnown = summaryRows.some((r) => String(r.batch || "") === NEW_BATCH);
  if (!newBatchKnown && !FORCE_UNKNOWN_TARGET) {
    console.error(`  Batch ${NEW_BATCH} has no summaryRows row — refusing to move onto an unknown batch. Pass --force-unknown-target to override. Nothing changed.`);
    process.exit(1);
  }

  const matches = [];
  const missing = [];
  vouchers.forEach((v) => {
    const found = lineItems.filter((li) => String(li.batch || "") === OLD_BATCH && String(li.voucher || "") === v);
    if (found.length !== 1) {
      missing.push({ voucher: v, found: found.length });
    } else {
      matches.push(found[0]);
    }
  });
  if (missing.length) {
    missing.forEach((m) => {
      console.error(`  Voucher ${m.voucher}: expected exactly 1 item in batch ${OLD_BATCH}, found ${m.found}.`);
    });
    console.error("  Nothing changed.");
    process.exit(1);
  }

  const moveTotal = round2(matches.reduce((s, li) => s + (Number(li.amount) || 0), 0));
  console.log(`${ONLY_ID}:`);
  matches.forEach((li) => {
    console.log(`  batch ${OLD_BATCH} -> ${NEW_BATCH}: voucher ${li.voucher} (${li.vendor}, $${li.amount}) — "${li.description}"`);
  });
  console.log(`  Total moving: $${moveTotal}`);

  if (DRY_RUN) {
    console.log("\n[dry run] Nothing written — rerun without --dry-run to save it.");
    return;
  }

  const movedVouchers = new Set(matches.map((li) => String(li.voucher || "")));
  const updated = lineItems.map((li) => {
    if (String(li.batch || "") === OLD_BATCH && movedVouchers.has(String(li.voucher || ""))) {
      return { ...li, batch: NEW_BATCH };
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
