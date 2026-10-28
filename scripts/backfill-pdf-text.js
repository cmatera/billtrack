// One-time (and now also daily-automatic — see server.js) backfill: indexes
// the already-stored source PDFs for full-text search (see GET /api/search
// in server.js). Two kinds of warrant need this: ones saved before the
// pdfText column existed at all (pdfText is NULL), and ones whose stored
// pdfText looks too sparse to be real — confirmed on real data where a
// scanned 30-page document (no actual text layer, just a scanner's own
// page-number stamp) produced pdfText but it was useless for search. Both
// are pure local extraction — pdftotext first, falling back to OCR
// (ocrmypdf + tesseract) only for the sparse case — no Anthropic API calls,
// no cost, and it doesn't need the server running (it writes to the
// database directly). See scripts/lib/pdf-text.js for why/how.
//
// Run inside the container:
//
//   docker compose exec ledger node scripts/backfill-pdf-text.js --dry-run
//   docker compose exec ledger node scripts/backfill-pdf-text.js
//   docker compose exec ledger node scripts/backfill-pdf-text.js --id=2026-03-10
//
// Requires poppler-utils (pdftotext/pdfinfo) and ocrmypdf in the image —
// see Dockerfile. If ocrmypdf is missing, sparse PDFs just keep whatever
// plain pdftotext got instead of failing the whole run.

const fs = require("fs");
const path = require("path");
const Database = require("better-sqlite3");
const { extractPdfText, isLikelySparse, pdfPageCount } = require("./lib/pdf-text");

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
  if (!FORCE) {
    // Needs a pass if there's no text at all yet, OR what's there looks too
    // sparse to be real (the scanned-PDF case — see this file's header).
    // The sparse check needs the actual PDF on disk to get a page count, so
    // this does a filesystem/pdfinfo check per candidate row rather than
    // staying a pure in-memory filter — fine at this app's scale (dozens of
    // warrants, not thousands).
    rows = rows.filter((r) => {
      if (!r.pdfText || !r.pdfText.trim()) return true;
      const pdfPath = path.join(UPLOADS_DIR, r.sourcePdfPath);
      if (!pdfPath.startsWith(UPLOADS_DIR) || !fs.existsSync(pdfPath)) return false; // can't recheck it, and it'll just fail below anyway if forced
      return isLikelySparse(r.pdfText, pdfPageCount(pdfPath));
    });
  }

  if (!rows.length) {
    console.log(ONLY_ID ? "No matching warrant (or it's already indexed — pass --force to redo it)." : "Nothing to backfill — every warrant with a source PDF is already indexed.");
    return;
  }

  console.log(`${DRY_RUN ? "[dry run] " : ""}Indexing ${rows.length} warrant${rows.length === 1 ? "" : "s"} for search...\n`);

  let ok = 0,
    failed = 0,
    ocrCount = 0;
  for (const row of rows) {
    const label = row.label || row.id;
    const pdfPath = path.join(UPLOADS_DIR, row.sourcePdfPath);
    if (!pdfPath.startsWith(UPLOADS_DIR) || !fs.existsSync(pdfPath)) {
      console.log(`✗ ${label}: source PDF missing on disk — skipping.`);
      failed++;
      continue;
    }
    try {
      const { text, ocrUsed } = extractPdfText(pdfPath);
      if (ocrUsed) ocrCount++;
      console.log(`✓ ${label}: ${text.length.toLocaleString()} characters indexed.${ocrUsed ? " (needed OCR — this PDF has no real text layer)" : ""}`);
      if (!DRY_RUN) {
        db.prepare("UPDATE warrants SET pdfText = ?, updatedAt = ? WHERE id = ?").run(text, new Date().toISOString(), row.id);
      }
      ok++;
    } catch (e) {
      console.log(`✗ ${label}: extraction failed (${(e && e.message) || e}) — skipping.`);
      failed++;
    }
  }

  console.log(`\n${DRY_RUN ? "[dry run] " : ""}Done: ${ok} indexed (${ocrCount} needed OCR), ${failed} skipped.`);
  if (DRY_RUN && ok) console.log("Nothing was written — rerun without --dry-run to save it.");
}

main();
