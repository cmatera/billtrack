// Shared PDF text extraction for full-text search. Used by both server.js
// (upload time) and scripts/backfill-pdf-text.js (the backfill), so the
// sparseness check they rely on can't drift between the two.
//
// Why this exists: some uploaded bill schedules are scanned documents with
// no real text layer at all — confirmed on real production data, where
// plain `pdftotext` returned nothing for an entire 30-page PDF except a
// scanner's own page-number stamp ("001\n\n\f002\n\n\f003..."). `pdftotext`
// can only read a text layer that's already there; it can't read pixels.
// isLikelySparse() below flags that case (based on how little text came
// back relative to the page count), and extractPdfText() falls back to OCR
// (ocrmypdf + tesseract) only when it's flagged, so the normal Munis
// warrants — which already have plenty of real text — never pay the OCR
// cost at all.
//
// --force-ocr (not --skip-text) is deliberate: a page like the ones above
// isn't text-free, it has that tiny page-number stamp, and ocrmypdf's
// --skip-text treats "has any text at all" as "already done" and leaves
// the rest of the page — the actual scanned content — untouched. Verified
// against a synthetic page with exactly this shape (an image plus a small
// stamp of real vector text): --skip-text skipped it entirely, --force-ocr
// correctly OCR'd the image content. --force-ocr rasterizes the whole page
// first, which also means it's safe to run on an already-fine page (it'll
// just OCR text that was already readable) — the sparseness gate below is
// what keeps it from being run needlessly, not a correctness requirement.
//
// OCR is slow (roughly a couple of seconds per page) and deliberately only
// ever called from the backfill script, which already runs as a spawned
// background process with live log streaming — never from the upload
// request handler in server.js, which stays on plain pdftotext so uploads
// stay fast. A scanned upload just won't be searchable until the next
// backfill run (manual or the daily automatic one) picks it up.

const fs = require("fs");
const os = require("os");
const path = require("path");
const { execFileSync } = require("child_process");

const MIN_CHARS_PER_PAGE = 25; // a real invoice-detail page runs into the hundreds of characters; a scanned page with just a stamp runs single digits to tens

function pdfPageCount(pdfPath) {
  try {
    const out = execFileSync("pdfinfo", [pdfPath]).toString("utf8");
    const m = out.match(/^Pages:\s+(\d+)/m);
    return m ? parseInt(m[1], 10) : null;
  } catch (e) {
    return null;
  }
}

function runPdftotext(pdfPath) {
  try {
    return execFileSync("pdftotext", [pdfPath, "-"], { maxBuffer: 20 * 1024 * 1024 }).toString("utf8");
  } catch (e) {
    return "";
  }
}

// Exported on its own so both the backfill script's row-selection filter
// and server.js's pending-count can decide "does this warrant's *already
// stored* pdfText look sparse enough to be worth re-extracting" using the
// exact same rule extractPdfText() uses internally.
function isLikelySparse(text, pages) {
  const len = (text || "").trim().length;
  if (!pages || pages < 1) return len < 300; // no page count on hand — flat floor
  return len < pages * MIN_CHARS_PER_PAGE;
}

// Returns { text, pages, ocrUsed }. Never throws — if ocrmypdf is missing
// or fails for any reason, this just falls back to whatever plain
// pdftotext got, since partial search coverage beats breaking the upload
// or the backfill run over an indexing step.
function extractPdfText(pdfPath) {
  const text = runPdftotext(pdfPath);
  const pages = pdfPageCount(pdfPath);
  if (!isLikelySparse(text, pages)) return { text, pages, ocrUsed: false };

  const workDir = fs.mkdtempSync(path.join(os.tmpdir(), "bsl-ocr-"));
  try {
    const ocrPath = path.join(workDir, "ocr.pdf");
    execFileSync("ocrmypdf", ["--force-ocr", "--quiet", pdfPath, ocrPath], { maxBuffer: 20 * 1024 * 1024 });
    const ocrText = runPdftotext(ocrPath);
    if (ocrText.trim().length > text.trim().length) return { text: ocrText, pages, ocrUsed: true };
    return { text, pages, ocrUsed: false };
  } catch (e) {
    return { text, pages, ocrUsed: false };
  } finally {
    fs.rmSync(workDir, { recursive: true, force: true });
  }
}

module.exports = { extractPdfText, isLikelySparse, pdfPageCount };
