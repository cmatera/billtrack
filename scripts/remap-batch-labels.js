// One-off, narrowly-scoped tool: relabel specific lineItems.batch values for
// a single warrant, with no Anthropic API call.
//
// Why this exists: scan-warrant-issues.js's --id audit mode can reveal a
// batch mislabeling — an "orphan" batch label present only in lineItems
// (no matching summaryRows row) whose dollar amount exactly matches a
// "NO LINE ITEMS" batch that DOES have a summaryRows row. Confirmed real
// case (2026-06-25): batches 834-839 in lineItems have no summaryRows row,
// but their amounts match batches 854-859's summaryRows rows exactly, to
// the cent — a classic OCR digit-confusion pattern (the tens digit "5"
// misread as "3") on one scanned section of the source PDF. The money was
// never lost or duplicated; it's tagged with the wrong batch number. This
// only touches the lineItems.batch field — amounts, vendors, invoiceCount,
// categories, and the warrant total are all already correct and untouched.
//
// Usage (relabel one or more old->new batch pairs for one warrant):
//
//   docker compose exec ledger node scripts/remap-batch-labels.js \
//     --id=2026-06-25 --mappings=834:854,835:855,836:856,837:857,838:858,839:859,865:866 \
//     --dry-run
//
//   docker compose exec ledger node scripts/remap-batch-labels.js \
//     --id=2026-06-25 --mappings=834:854,835:855,836:856,837:857,838:858,839:859,865:866
//
// --id and --mappings are both required. Each pair is "oldBatch:newBatch".
// Refuses to apply a mapping whose new batch doesn't already have a
// summaryRows row (relabeling onto a batch that doesn't exist would just
// create a fresh mismatch) — pass --force-unknown-target to override.

const path = require("path");
const Database = require("better-sqlite3");

const DATA_DIR = process.env.DATA_DIR || path.join(__dirname, "..", "data");
const DB_FILE = path.join(DATA_DIR, "warrants.db");

const args = process.argv.slice(2);
const DRY_RUN = args.includes("--dry-run");
const FORCE_UNKNOWN_TARGET = args.includes("--force-unknown-target");
const ONLY_ID = (args.find((a) => a.startsWith("--id=")) || "").slice(5) || null;
const MAPPINGS_RAW = (args.find((a) => a.startsWith("--mappings=")) || "").slice(11) || null;

function parseMappings(raw) {
  return raw.split(",").map((pair) => {
    const [from, to] = pair.split(":").map((s) => s.trim());
    if (!from || !to) {
      throw new Error(`Bad mapping "${pair}" — expected "oldBatch:newBatch"`);
    }
    return { from, to };
  });
}

function main() {
  if (!ONLY_ID || !MAPPINGS_RAW) {
    console.error(
      "Usage: node scripts/remap-batch-labels.js --id=<warrant-id> --mappings=<old:new,old:new,...> [--dry-run] [--force-unknown-target]"
    );
    process.exit(1);
  }
  const mappings = parseMappings(MAPPINGS_RAW);

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
  const knownSummaryBatches = new Set(summaryRows.map((r) => String(r.batch || "")));

  console.log(`${ONLY_ID}:`);
  let anyBlocked = false;
  mappings.forEach(({ from, to }) => {
    const matching = lineItems.filter((li) => String(li.batch || "") === from);
    const sum = Math.round(matching.reduce((a, li) => a + (Number(li.amount) || 0), 0) * 100) / 100;
    const targetKnown = knownSummaryBatches.has(to);
    const blocked = !targetKnown && !FORCE_UNKNOWN_TARGET;
    if (blocked) anyBlocked = true;
    console.log(
      `  ${from} -> ${to}: ${matching.length} item(s), $${sum}${targetKnown ? "" : "  [target batch has no summaryRows row]"}${blocked ? "  BLOCKED — pass --force-unknown-target to override" : ""}`
    );
  });

  if (anyBlocked) {
    console.error("\nOne or more mappings blocked. Nothing changed.");
    process.exit(1);
  }

  if (DRY_RUN) {
    console.log("\n[dry run] Nothing written — rerun without --dry-run to save it.");
    return;
  }

  const byOld = new Map(mappings.map((m) => [m.from, m.to]));
  const relabeled = lineItems.map((li) => {
    const b = String(li.batch || "");
    if (byOld.has(b)) {
      return { ...li, batch: byOld.get(b) };
    }
    return li;
  });

  db.prepare("UPDATE warrants SET lineItems = ?, updatedAt = ? WHERE id = ?").run(
    JSON.stringify(relabeled),
    new Date().toISOString(),
    ONLY_ID
  );
  console.log("\nSaved.");
}

main();
