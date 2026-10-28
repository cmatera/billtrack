FROM node:20-bookworm-slim

WORKDIR /app

# poppler-utils (pdftoppm/pdfinfo/pdftotext) rasterizes PDFs for
# scripts/backfill-summary-rows.js and extracts text for full-text search
# (server.js, scripts/backfill-pdf-text.js) — see those files' headers.
# tar builds the downloadable backup archives (server.js's createBackup());
# listed explicitly even though Debian normally ships it, so this doesn't
# depend on that happening to stay true.
# ocrmypdf (+ its own dependencies: tesseract-ocr, ghostscript, qpdf,
# pikepdf, a Python runtime) is the fallback for scanned bill schedules that
# have no real text layer at all — pdftotext can only read a text layer
# that's already there, it can't OCR pixels. Confirmed necessary on real
# data: some uploaded warrants are scanned, and without this, those specific
# vendors' invoices are invisible to /api/search no matter how many times
# the backfill runs. See scripts/lib/pdf-text.js for the detection logic and
# why it's gated (OCR only runs on PDFs that look sparse, not on every
# upload). This pulls in a meaningful dependency chain, so expect a
# noticeably larger image and a longer build than before this was added.
RUN apt-get update \
  && apt-get install -y --no-install-recommends poppler-utils tar ocrmypdf \
  && rm -rf /var/lib/apt/lists/*

COPY package.json package-lock.json* ./
RUN npm install --omit=dev

COPY server.js ./
COPY public ./public
COPY scripts ./scripts

ENV PORT=3000
EXPOSE 3000

CMD ["node", "server.js"]
