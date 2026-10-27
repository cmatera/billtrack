// One-time backfill: fills in the row-level `summaryRows` detail (the thing
// that powers the "click a category to see every transaction" drill-down)
// for warrants that were saved before that column existed. Those warrants
// still have their original source PDF on disk — this re-reads it directly
// and re-runs the normal extraction, without touching the browser at all.
//
// It deliberately leaves dateISO/total/categories/vendors/reconciled alone.
// Only the summaryRows column is written, so the totals you already trust
// can't drift — this only adds the detail underneath them.
//
// Run inside the running container (it calls the server's own /api/extract
// over localhost, so the server must already be up):
//
//   docker compose exec ledger node scripts/backfill-summary-rows.js --dry-run
//   docker compose exec ledger node scripts/backfill-summary-rows.js
//   docker compose exec ledger node scripts/backfill-summary-rows.js --id=2026-03-10
//
// Requires poppler-utils (pdftoppm/pdfinfo) in the image — see Dockerfile.

const fs = require("fs");
const os = require("os");
const path = require("path");
const crypto = require("crypto");
const { execFileSync } = require("child_process");
const Database = require("better-sqlite3");

const DATA_DIR = process.env.DATA_DIR || path.join(__dirname, "..", "data");
const DB_FILE = path.join(DATA_DIR, "warrants.db");
const UPLOADS_DIR = path.join(DATA_DIR, "uploads");
const PORT = process.env.PORT || 3000;
const EXTRACT_URL = `http://localhost:${PORT}/api/extract`;
const BATCH = 6; // same page-batch size the browser uses

const args = process.argv.slice(2);
const DRY_RUN = args.includes("--dry-run");
const ONLY_ID = (args.find((a) => a.startsWith("--id=")) || "").slice(5) || null;
const FORCE = args.includes("--force"); // reprocess even if summaryRows is already populated

// ---- the same 13-category taxonomy as public/index.html (categorize()) ---
function categorize(rawLabel) {
  const s = String(rawLabel || "").toLowerCase();
  const has = (...terms) => terms.some((t) => s.includes(t));
  if (has("special education") && has("transport")) return "Special Education — Transportation";
  if (has("special education")) return "Special Education — Tuition & Services";
  if (has("transport") || has("bus fee")) return "Transportation — General (Contracted)";
  if (has("maintenance") || has("facility") || has("facilities")) return "Maintenance & Facilities";
  if (has("capital")) return "Capital Projects";
  if (has("utilit")) return "Utilities";
  if (has("technology") || has("software")) return "Technology";
  if (has("athletic")) return "Athletics";
  if (has("food service")) return "Food Services";
  if (has("admin") || has("tuition reimbursement")) return "Administration";
  if (has("early learning") || has("elementary") || has("middle school") || has("high school") || has("library")) return "Curriculum / Instructional";
  if (has("health")) return "Health";
  return "Extracurricular & Revolving Funds";
}

function round2(n) {
  return Math.round((Number(n) || 0) * 100) / 100;
}

// Same prompt the browser sends per page-batch (public/index.html, extractionPrompt()).
function extractionPrompt(startPage, endPage, totalPages) {
  return [
    "You are reading pages " + startPage + "-" + endPage + " of a " + totalPages + "-page Massachusetts school district bill schedule (a Munis \"Invoice Entry Proof List\" warrant). Page conventions for the WHOLE document, which may extend beyond these images:",
    "- The first page of the whole document is a cover letter stating the warrant date and a grand total.",
    "- The second page of the whole document is a batch-summary table with columns BATCH | DEPARTMENT | AMOUNT | INVOICES.",
    "- Every later page is an invoice-detail page listing individual vendor invoices for one batch (vendor, amount, description, sometimes an \"EXCEEDS PO BY\" column).",
    "",
    "From ONLY the pages shown in THESE images, extract this JSON object and reply with ONLY the JSON, no other text:",
    "{",
    '  "coverDate": "MM/DD/YYYY, or null if no cover page is in these images",',
    '  "coverTotal": number or null,',
    '  "warrantNo": "string like \\"24\\", or null",',
    '  "summaryRows": [{"batch":"string","department":"string","amount":number,"invoices":number}],',
    '  "lineItems": [{"batch":"string","vendor":"string","amount":number,"description":"string","exceedsPoBy":number}]',
    "}",
    "Omit summaryRows entries unless a batch-summary table page is in these images. Include a lineItems entry for every invoice line visible on any invoice-detail page in these images. Use null for anything not visible in these pages — other pages elsewhere in the document may supply it.",
  ].join("\n");
}

async function callExtract(prompt, images) {
  const resp = await fetch(EXTRACT_URL, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ prompt, images }),
  });
  if (resp.status === 503) throw { code: "not_granted" };
  if (resp.status === 429) throw { code: "rate_limited" };
  if (!resp.ok) {
    const body = await resp.json().catch(() => ({}));
    throw { code: resp.status === 422 ? "invalid_json" : "upstream_error", message: body.error };
  }
  return resp.json();
}

// Rasterizes a PDF to one JPEG per page in a fresh temp dir and returns the
// sorted file list. poppler zero-pads the page-number suffix to the width
// needed for the total page count, so a plain string sort is already in
// page order (verified: a 12-page doc produces p-01.jpg..p-12.jpg).
function rasterizePdf(pdfPath) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "bsl-"));
  execFileSync("pdftoppm", ["-jpeg", "-r", "150", pdfPath, path.join(dir, "p")]);
  const files = fs
    .readdirSync(dir)
    .filter((f) => f.endsWith(".jpg"))
    .sort()
    .map((f) => path.join(dir, f));
  return { dir, files };
}

function cleanupDir(dir) {
  try {
    fs.rmSync(dir, { recursive: true, force: true });
  } catch (_) {}
}

async function extractWarrantFromPages(pageFiles, label) {
  const merged = { coverDate: null, coverTotal: null, warrantNo: null, summaryRows: [], lineItems: [] };
  const total = pageFiles.length;
  for (let i = 0; i < total; i += BATCH) {
    const chunk = pageFiles.slice(i, i + BATCH);
    const startPage = i + 1;
    const endPage = Math.min(i + BATCH, total);
    console.log(`  [${label}] reading pages ${startPage}-${endPage} of ${total}...`);
    const images = chunk.map((f) => ({ data: fs.readFileSync(f).toString("base64"), mediaType: "image/jpeg" }));
    const prompt = extractionPrompt(startPage, endPage, total);
    let data;
    try {
      data = await callExtract(prompt, images);
    } catch (e) {
      if (e && e.code === "not_granted") {
        throw new Error("ANTHROPIC_API_KEY is not configured on the server — cannot run the backfill.");
      }
      if (e && e.code === "rate_limited") {
        console.log(`  [${label}] rate-limited, retrying once after a short pause...`);
        await new Promise((r) => setTimeout(r, 5000));
        try {
          data = await callExtract(prompt, images);
        } catch (e2) {
          console.log(`  [${label}] skipping pages ${startPage}-${endPage} after a second failure: ${e2.message || e2.code}`);
          continue;
        }
      } else {
        console.log(`  [${label}] retrying pages ${startPage}-${endPage} once after an error: ${e.message || e.code}`);
        try {
          data = await callExtract(prompt, images);
        } catch (e2) {
          console.log(`  [${label}] skipping pages ${startPage}-${endPage} after a second failure: ${e2.message || e2.code}`);
          continue;
        }
      }
    }
    if (data && typeof data === "object") {
      if (Array.isArray(data.summaryRows)) merged.summaryRows.push(...data.summaryRows);
      if (Array.isArray(data.lineItems)) merged.lineItems.push(...data.lineItems);
    }
  }
  return merged;
}

// Same fallback as the browser's openReview(): if no batch-summary table was
// found anywhere in the document but there are vendor line items, synthesize
// one summary row per line item instead of leaving the category empty.
function toSummaryRows(merged) {
  let rows = (merged.summaryRows || []).map((r) => ({
    batch: r.batch || "—",
    department: r.department || "",
    category: categorize(r.department),
    amount: round2(r.amount),
  }));
  if (!rows.length && merged.lineItems && merged.lineItems.length) {
    rows = merged.lineItems.map((li) => ({
      batch: "—",
      department: li.vendor || "",
      category: categorize((li.vendor || "") + " " + (li.description || "")),
      amount: round2(li.amount),
    }));
  }
  return rows;
}

async function main() {
  if (!fs.existsSync(DB_FILE)) {
    console.error(`No database found at ${DB_FILE}`);
    process.exit(1);
  }
  const db = new Database(DB_FILE);

  let rows = db.prepare("SELECT * FROM warrants WHERE sourcePdfPath IS NOT NULL ORDER BY dateISO").all();
  if (ONLY_ID) rows = rows.filter((r) => r.id === ONLY_ID);
  if (!FORCE) {
    rows = rows.filter((r) => {
      let parsed;
      try {
        parsed = JSON.parse(r.summaryRows || "[]");
      } catch (_) {
        parsed = [];
      }
      return !Array.isArray(parsed) || parsed.length === 0;
    });
  }

  if (!rows.length) {
    console.log(ONLY_ID ? `No matching warrant (or it already has summaryRows — pass --force to redo it).` : "Nothing to backfill — every warrant with a source PDF already has row-level detail.");
    return;
  }

  console.log(`${DRY_RUN ? "[dry run] " : ""}Backfilling ${rows.length} warrant${rows.length === 1 ? "" : "s"}...`);
  console.log(`(Each re-reads its stored PDF through the Anthropic API — same cost as a normal upload, a few cents each.)\n`);

  let ok = 0,
    failed = 0;
  for (const row of rows) {
    const label = row.label || row.id;
    const pdfRelPath = row.sourcePdfPath;
    const pdfPath = path.join(UPLOADS_DIR, pdfRelPath);
    if (!pdfPath.startsWith(UPLOADS_DIR) || !fs.existsSync(pdfPath)) {
      console.log(`✗ ${label}: source PDF missing on disk (${pdfRelPath}) — skipping.`);
      failed++;
      continue;
    }

    let raster;
    try {
      raster = rasterizePdf(pdfPath);
    } catch (e) {
      console.log(`✗ ${label}: failed to rasterize PDF (${(e && e.message) || e}) — skipping.`);
      failed++;
      continue;
    }

    try {
      if (!raster.files.length) {
        console.log(`✗ ${label}: PDF has no readable pages — skipping.`);
        failed++;
        continue;
      }
      const merged = await extractWarrantFromPages(raster.files, label);
      const summaryRows = toSummaryRows(merged);

      if (!summaryRows.length) {
        console.log(`✗ ${label}: extraction found no batch-summary rows or line items — leaving as-is.`);
        failed++;
        continue;
      }

      const newTotal = round2(summaryRows.reduce((s, r) => s + r.amount, 0));
      const oldTotal = row.total == null ? null : round2(row.total);
      const note = oldTotal != null && Math.abs(newTotal - oldTotal) > 0.02 ? `  (⚠ sums to ${newTotal.toFixed(2)}, stored total is ${oldTotal.toFixed(2)} — categories/total left untouched either way)` : "";
      console.log(`✓ ${label}: ${summaryRows.length} row(s) recovered.${note}`);

      if (!DRY_RUN) {
        db.prepare("UPDATE warrants SET summaryRows = ?, updatedAt = ? WHERE id = ?").run(JSON.stringify(summaryRows), new Date().toISOString(), row.id);
      }
      ok++;
    } finally {
      cleanupDir(raster.dir);
    }
  }

  console.log(`\n${DRY_RUN ? "[dry run] " : ""}Done: ${ok} backfilled, ${failed} skipped.`);
  if (DRY_RUN && ok) console.log("Nothing was written — rerun without --dry-run to save it.");
}

main().catch((e) => {
  console.error("Backfill failed:", (e && e.message) || e);
  process.exit(1);
});
