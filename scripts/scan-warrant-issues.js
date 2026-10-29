// Read-only diagnostic: scan every stored warrant for the two bugs fixed in
// commit 87f3144 (a duplicated/rescanned PDF page inflating lineItems; a
// leaked Munis remit-code prefix splitting one vendor into two keys), WITHOUT
// calling the Anthropic API and WITHOUT changing anything in the database.
//
// Why this exists: re-running backfill-summary-rows.js --force costs an API
// call per warrant and re-extracts from scratch. Most warrants were probably
// never affected by either bug, so there's no reason to touch them. Run this
// first to find out exactly which ones actually need the fix sequence
// (backfill-summary-rows.js --force + recompute-totals.js) — likely just a
// short list, not the whole history.
//
//   docker compose exec ledger node scripts/scan-warrant-issues.js
//
// Flags two independent signatures per warrant, either of which means
// "affected" (mirrors reviewFlags()/batchReconciliationMismatches() in
// public/index.html and stripVendorCodePrefix() in backfill-summary-rows.js,
// applied here read-only against whatever is already stored):
//
//   batch-mismatch            a batch's lineItems don't sum to its own
//                             summaryRows amount — the signature of a
//                             duplicated page. Skipped for warrants whose
//                             summaryRows were synthesized (one row per line
//                             item, by construction — nothing independent to
//                             check against).
//   vendor-prefix-collision   a vendors key equals another vendors key once
//                             a leaked "00000 "-style remit-code prefix is
//                             stripped off — the signature of the vendor
//                             fragmentation bug.

const path = require("path");
const Database = require("better-sqlite3");

const DATA_DIR = process.env.DATA_DIR || path.join(__dirname, "..", "data");
const DB_FILE = path.join(DATA_DIR, "warrants.db");

const BATCH_RECONCILE_TOLERANCE = 0.02;

function round2(n) {
  return Math.round((Number(n) || 0) * 100) / 100;
}

// Same regex as stripVendorCodePrefix() in public/index.html and
// scripts/backfill-summary-rows.js.
function stripVendorCodePrefix(s) {
  return String(s || "").replace(/^(?:\d{1,6}\s+)?\d{5}\s+(?=\S)/, "");
}

// Same logic as batchReconciliationMismatches() in public/index.html.
function batchMismatches(summaryRows, lineItems) {
  const rows = summaryRows || [];
  if (!rows.length || rows.every((r) => r.batch === "—")) return [];
  const items = lineItems || [];
  const byBatch = {};
  items.forEach((li) => {
    const b = li.batch || "";
    byBatch[b] = round2((byBatch[b] || 0) + (Number(li.amount) || 0));
  });
  return rows.filter((r) => {
    const b = r.batch || "";
    if (!b || b === "—") return false;
    return Math.abs((byBatch[b] || 0) - (Number(r.amount) || 0)) > BATCH_RECONCILE_TOLERANCE;
  });
}

function vendorPrefixCollisions(vendors) {
  const keys = Object.keys(vendors || {});
  const keySet = new Set(keys);
  const collisions = [];
  keys.forEach((k) => {
    const stripped = stripVendorCodePrefix(k);
    if (stripped !== k && keySet.has(stripped)) {
      collisions.push([k, stripped]);
    }
  });
  return collisions;
}

function main() {
  if (!require("fs").existsSync(DB_FILE)) {
    console.error(`No database found at ${DB_FILE}`);
    process.exit(1);
  }
  const db = new Database(DB_FILE);
  const rows = db
    .prepare(
      "SELECT id, dateISO, label, total, invoiceCount, summaryRows, lineItems, vendors FROM warrants ORDER BY dateISO"
    )
    .all();

  let affectedCount = 0;
  rows.forEach((row) => {
    const summaryRows = row.summaryRows ? JSON.parse(row.summaryRows) : [];
    const lineItems = row.lineItems ? JSON.parse(row.lineItems) : [];
    const vendors = row.vendors ? JSON.parse(row.vendors) : {};

    const mismatches = batchMismatches(summaryRows, lineItems);
    const collisions = vendorPrefixCollisions(vendors);

    if (mismatches.length || collisions.length) {
      affectedCount++;
      console.log(`\n${row.id} (${row.label || row.dateISO}):`);
      if (mismatches.length) {
        console.log(
          `  batch-mismatch: ${mismatches.length} batch(es) don't reconcile — batch ${mismatches
            .map((m) => m.batch)
            .join(", ")}`
        );
      }
      if (collisions.length) {
        console.log(
          `  vendor-prefix-collision: ${collisions.map(([a, b]) => `"${a}" / "${b}"`).join(", ")}`
        );
      }
    }
  });

  console.log(`\nScanned ${rows.length} warrant(s); ${affectedCount} affected.`);
  if (affectedCount) {
    console.log(
      "For each affected id, run: backfill-summary-rows.js --force --id=<id>, then recompute-totals.js --id=<id> (--dry-run first)."
    );
  }
}

main();
