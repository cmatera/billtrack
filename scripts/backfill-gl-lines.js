// One-time backfill: adds `glLines` (GL allocation account + amount per
// voucher) onto warrants that were saved before GL capture existed, WITHOUT
// touching anything else already stored for them.
//
// Why this is a separate, narrower tool than backfill-summary-rows.js:
// that script re-runs extraction and overwrites the ENTIRE summaryRows and
// lineItems columns. Running it with --force across the 22 production
// warrants cleaned up this session would silently wipe out every one-off
// correction made by hand (voucher-number fixes, added missing invoices,
// batch relabels, corrected amounts) by replacing them with a fresh
// extraction pass that has no guarantee of reproducing those same fixes.
// This script instead re-reads each warrant's source PDF ONLY to harvest
// glLines, then merges those onto the EXISTING stored lineItems by matching
// voucher number — amount, vendor, description, batch, voucher, and
// summaryRows are left completely untouched either way.
//
// Safety check before applying: a fresh extraction pass can still misread a
// GL line (that's the exact Bug #4 failure mode this session kept finding).
// So a voucher's new glLines are only applied if they sum to within $0.02 of
// that lineItem's ALREADY-TRUSTED stored amount. If they don't, the item is
// left as-is (empty glLines) and reported as needing a manual look — never
// silently applied.
//
// Run inside the running container (it calls the server's own /api/extract
// over localhost, so the server must already be up):
//
//   docker compose exec ledger node scripts/backfill-gl-lines.js --dry-run
//   docker compose exec ledger node scripts/backfill-gl-lines.js
//   docker compose exec ledger node scripts/backfill-gl-lines.js --id=2026-07-31
//
// Drop --dry-run to save. By default, a warrant is skipped if every one of
// its stored lineItems already has non-empty glLines (nothing to add) —
// pass --force to re-run it anyway.
//
// Requires poppler-utils (pdftoppm/pdfinfo) in the image — see Dockerfile.

const fs = require("fs");
const os = require("os");
const path = require("path");
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
const FORCE = args.includes("--force");

const GL_SUM_TOLERANCE = 0.02;

function round2(n) {
  return Math.round((Number(n) || 0) * 100) / 100;
}

// Same prompt the browser sends per page-batch (public/index.html,
// extractionPrompt()) — kept as a plain copy since this script runs
// standalone. Only the GL-line portion of the result is used below.
function extractionPrompt(startPage, endPage, totalPages) {
  return [
    "You are reading pages " + startPage + "-" + endPage + " of a " + totalPages + "-page Massachusetts school district bill schedule (a Munis \"Invoice Entry Proof List\" warrant). Page conventions for the WHOLE document, which may extend beyond these images:",
    "- The first page of the whole document is a cover letter stating the warrant date and a grand total.",
    "- The second page of the whole document is a batch-summary table with columns BATCH | DEPARTMENT | AMOUNT | INVOICES.",
    "- Every later page is an invoice-detail page listing individual vendor invoices for one batch (vendor, amount, description). Near the right edge of these invoice-detail pages there are often two separate numeric columns that are easy to confuse: \"EXCEEDS PO BY\" and \"PO BALANCE\". They are NOT the same thing: \"EXCEEDS PO BY\" is usually blank or \".00\" (most invoices do not exceed their purchase order), while \"PO BALANCE\" is a different, often much larger, running-balance figure that has nothing to do with exceeding the PO. Only read the \"EXCEEDS PO BY\" column for the exceedsPoBy field below — never substitute the \"PO BALANCE\" column's value for it, even though the two columns sit next to each other and look similar.",
    "- Each invoice-detail line also has a \"VOUCHER\" column (a 5-digit number, distinct from both \"PO\" and \"DOCUMENT INVOICE\") — this is Munis's own unique ID for that line. Read it exactly as printed; never leave it blank if a number is visible in that column.",
    "- Below each voucher's invoice line, one or more GL allocation lines follow, each showing an account code (two numbers, e.g. \"42260010 57000\" or \"S0198030 61355\") and a dollar amount. A single invoice is very often split across two or more GL lines — sometimes across different funding sources (part from a Town Capital account prefixed \"S0...\", part from a Revolving Fund account prefixed \"S1...\", part from an ordinary General Fund account with no letter prefix). Capture EVERY GL line for that voucher, not just the first one — a GL line can be visually separated from the others, wrapping past an address block near the bottom of the page. The GL line amounts, summed, MUST equal that line's NET AMOUNT — if what you've captured doesn't add up to the NET AMOUNT you read, look again for a GL line you missed rather than reporting a value that doesn't reconcile.",
    "",
    "From ONLY the pages shown in THESE images, extract this JSON object and reply with ONLY the JSON, no other text:",
    "{",
    '  "summaryRows": [{"batch":"string","department":"string","amount":number,"invoices":number}],',
    '  "lineItems": [{"batch":"string","vendor":"string","amount":number,"description":"string","exceedsPoBy":number,"voucher":"string or null","glLines":[{"account":"string","amount":number}]}]',
    "}",
    "Omit summaryRows entries unless a batch-summary table page is in these images. Include a lineItems entry for every invoice line visible on any invoice-detail page in these images. voucher must be the \"VOUCHER\" column's value specifically, as a string (e.g. \"95891\"); use null only if that column is genuinely blank for that line. glLines must list every GL allocation line belonging to that voucher, each with its account code exactly as printed (both numbers, e.g. \"42260010 57000\") and its own dollar amount; use an empty array only if no GL lines are visible for that line in these pages.",
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

function rasterizePdf(pdfPath) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "bsl-gl-"));
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

async function extractGlLinesFromPages(pageFiles, label) {
  const byVoucher = new Map(); // voucher (string) -> glLines array (last write wins if seen twice)
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
        console.log(`  [${label}] rate limited reading pages ${startPage}-${endPage} — waiting 20s and retrying once...`);
        await new Promise((r) => setTimeout(r, 20000));
        try {
          data = await callExtract(prompt, images);
        } catch (e2) {
          console.log(`  [${label}] pages ${startPage}-${endPage}: still failing after retry (${(e2 && e2.message) || e2}) — skipping this chunk.`);
          continue;
        }
      } else {
        console.log(`  [${label}] pages ${startPage}-${endPage}: extraction failed (${(e && e.message) || e}) — skipping this chunk.`);
        continue;
      }
    }
    if (data && Array.isArray(data.lineItems)) {
      data.lineItems.forEach((li) => {
        const v = li && li.voucher != null ? String(li.voucher).trim() : "";
        if (!v) return;
        const glLines = Array.isArray(li.glLines)
          ? li.glLines.map((g) => ({ account: String(g.account || "").trim(), amount: round2(g.amount) })).filter((g) => g.account || g.amount)
          : [];
        if (glLines.length) byVoucher.set(v, glLines);
      });
    }
  }
  return byVoucher;
}

async function main() {
  if (!fs.existsSync(DB_FILE)) {
    console.error(`No database found at ${DB_FILE}`);
    process.exit(1);
  }
  const db = new Database(DB_FILE);

  const parseLineItems = (text) => {
    try {
      const parsed = JSON.parse(text || "[]");
      return Array.isArray(parsed) ? parsed : [];
    } catch (_) {
      return [];
    }
  };

  let rows = db.prepare("SELECT * FROM warrants WHERE sourcePdfPath IS NOT NULL ORDER BY dateISO").all();
  if (ONLY_ID) rows = rows.filter((r) => r.id === ONLY_ID);

  if (!FORCE) {
    rows = rows.filter((r) => {
      const items = parseLineItems(r.lineItems);
      return items.length && items.some((li) => !Array.isArray(li.glLines) || !li.glLines.length);
    });
  }

  if (!rows.length) {
    console.log(ONLY_ID ? "No matching warrant (or every line item already has GL lines — pass --force to redo it)." : "Nothing to backfill — every warrant either has no line items yet or already has GL lines on all of them.");
    return;
  }

  console.log(`${DRY_RUN ? "[dry run] " : ""}Backfilling GL lines for ${rows.length} warrant${rows.length === 1 ? "" : "s"}...`);
  console.log(`(Each re-reads its stored PDF through the Anthropic API — same cost as a normal upload, a few cents each. Only glLines is written; everything else already stored — amounts, vouchers, batches, corrections — is left exactly as-is.)\n`);

  let totalApplied = 0,
    totalMismatch = 0,
    totalUnmatched = 0;

  for (const row of rows) {
    const label = row.label || row.id;
    const pdfRelPath = row.sourcePdfPath;
    const pdfPath = path.join(UPLOADS_DIR, pdfRelPath);
    if (!pdfPath.startsWith(UPLOADS_DIR) || !fs.existsSync(pdfPath)) {
      console.log(`✗ ${label}: source PDF missing on disk (${pdfRelPath}) — skipping.`);
      continue;
    }

    const existingLineItems = parseLineItems(row.lineItems);
    if (!existingLineItems.length) {
      console.log(`✗ ${label}: no stored line items to match against — skipping (run backfill-summary-rows.js first).`);
      continue;
    }

    // Guard against a voucher number appearing more than once in this
    // warrant's OWN stored data (the confirmed real collision pattern from
    // Bug #4) — matching would be ambiguous, so those vouchers are excluded
    // from matching entirely rather than guessed at.
    const voucherCounts = new Map();
    existingLineItems.forEach((li) => {
      const v = li && li.voucher != null ? String(li.voucher).trim() : "";
      if (!v) return;
      voucherCounts.set(v, (voucherCounts.get(v) || 0) + 1);
    });

    let raster;
    try {
      raster = rasterizePdf(pdfPath);
    } catch (e) {
      console.log(`✗ ${label}: failed to rasterize PDF (${(e && e.message) || e}) — skipping.`);
      continue;
    }

    try {
      if (!raster.files.length) {
        console.log(`✗ ${label}: PDF has no readable pages — skipping.`);
        continue;
      }
      const glByVoucher = await extractGlLinesFromPages(raster.files, label);

      let applied = 0,
        mismatch = 0,
        unmatched = 0;
      const updatedLineItems = existingLineItems.map((li) => {
        const v = li && li.voucher != null ? String(li.voucher).trim() : "";
        const hasGl = Array.isArray(li.glLines) && li.glLines.length;
        if (hasGl && !FORCE) return li; // already has GL data, leave alone
        if (!v || voucherCounts.get(v) !== 1) {
          unmatched++;
          return li;
        }
        const glLines = glByVoucher.get(v);
        if (!glLines) {
          unmatched++;
          return li;
        }
        const glSum = round2(glLines.reduce((s, g) => s + (Number(g.amount) || 0), 0));
        const storedAmount = round2(li.amount);
        if (Math.abs(glSum - storedAmount) > GL_SUM_TOLERANCE) {
          mismatch++;
          console.log(`  ⚠ ${label} voucher ${v} (${li.vendor}): fresh GL lines sum to ${glSum.toFixed(2)}, but the stored amount is ${storedAmount.toFixed(2)} — not applying, left as-is. Needs a manual look if GL data matters for this one.`);
          return li;
        }
        applied++;
        return { ...li, glLines };
      });

      totalApplied += applied;
      totalMismatch += mismatch;
      totalUnmatched += unmatched;
      console.log(`✓ ${label}: ${applied} line item(s) got GL lines, ${mismatch} skipped (sum mismatch), ${unmatched} skipped (no voucher match).`);

      if (!DRY_RUN && applied > 0) {
        db.prepare("UPDATE warrants SET lineItems = ?, updatedAt = ? WHERE id = ?").run(JSON.stringify(updatedLineItems), new Date().toISOString(), row.id);
      }
    } finally {
      cleanupDir(raster.dir);
    }
  }

  console.log(`\n${DRY_RUN ? "[dry run] " : ""}Done: ${totalApplied} line item(s) got GL lines, ${totalMismatch} flagged for manual review, ${totalUnmatched} left unmatched across all warrants processed.`);
  if (DRY_RUN && totalApplied) console.log("Nothing was written — rerun without --dry-run to save it.");
}

main().catch((e) => {
  console.error("Backfill failed:", (e && e.message) || e);
  process.exit(1);
});
