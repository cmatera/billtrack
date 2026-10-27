// One-time backfill: indexes the already-stored source PDFs for full-text
// search (see GET /api/search in server.js), for warrants saved before the
// pdfText column existed. Unlike backfill-summary-rows.js, this is pure
// local text extraction (pdftotext) — no Anthropic API calls, no cost, and
// it doesn't need the server running (it writes to the database directly).
//
// Run inside the container:
//
//   docker compose exec ledger node scripts/backfill-pdf-text.js --dry-run
//   docker compose exec ledger node scripts/backfill-pdf-text.js
//   docker compose exec ledger node scripts/backfill-pdf-text.js --id=2026-03-10
//
// Requires poppler-utils (pdftotext) in the image — see Dockerfile.

const fs = require("fs");
const path = require("path");
const { execFileSync } = require("child_process");
const Database = require("better-sqlite3");

const DATA_DIR = process.env.DATA_DIR || path.join(__dirname, "..", "data");
const DB_FILE = path.join(DATA_DIR, "warrants.db");
const UPLOADS_DIR = path.join(DATA_DIR, "uploads");

const args = process.argv.slice(2);
const DRY_RUN = args.includes("--dry-run");
const ONLY_ID = (args.find((a) => a.startsWith("--id=")) || "").slice(5) || null;
const FORCE = args.includes("--force");

function main() {
  if (!fs.existsSync(DB_FILE)) {
    console.error(`No database found at ${DB_FILE}`);
    process.exit(1);
  }
  const db = new Database(DB_FILE);

  const cols = db.prepare("PRAGMA table_info(warrants)").all().map((c) => c.name);
  if (!cols.includes("pdfText")) {
    console.error("This database predates the pdfText column — pull/rebuild the app image first, then rerun this.");
    process.exit(1);
  }

  let rows = db.prepare("SELECT * FROM warrants WHERE sourcePdfPath IS NOT NULL ORDER BY dateISO").all();
  if (ONLY_ID) rows = rows.filter((r) => r.id === ONLY_ID);
  if (!FORCE) rows = rows.filter((r) => !r.pdfText || !r.pdfText.trim());

  if (!rows.length) {
    console.log(ONLY_ID ? "No matching warrant (or it's already indexed — pass --force to redo it)." : "Nothing to backfill — every warrant with a source PDF is already indexed.");
    return;
  }

  console.log(`${DRY_RUN ? "[dry run] " : ""}Indexing ${rows.length} warrant${rows.length === 1 ? "" : "s"} for search...\n`);

  let ok = 0,
    failed = 0;
  for (const row of rows) {
    const label = row.label || row.id;
    const pdfPath = path.join(UPLOADS_DIR, row.sourcePdfPath);
    if (!pdfPath.startsWith(UPLOADS_DIR) || !fs.existsSync(pdfPath)) {
      console.log(`✗ ${label}: source PDF missing on disk — skipping.`);
      failed++;
      continue;
    }
    try {
      const text = execFileSync("pdftotext", [pdfPath, "-"], { maxBuffer: 20 * 1024 * 1024 }).toString("utf8");
      console.log(`✓ ${label}: ${text.length.toLocaleString()} characters indexed.`);
      if (!DRY_RUN) {
        db.prepare("UPDATE warrants SET pdfText = ?, updatedAt = ? WHERE id = ?").run(text, new Date().toISOString(), row.id);
      }
      ok++;
    } catch (e) {
      console.log(`✗ ${label}: pdftotext failed (${(e && e.message) || e}) — skipping.`);
      failed++;
    }
  }

  console.log(`\n${DRY_RUN ? "[dry run] " : ""}Done: ${ok} indexed, ${failed} skipped.`);
  if (DRY_RUN && ok) console.log("Nothing was written — rerun without --dry-run to save it.");
}

main();
