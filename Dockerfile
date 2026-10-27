FROM node:20-bookworm-slim

WORKDIR /app

# poppler-utils (pdftoppm/pdfinfo) rasterizes PDFs for the one-time
# scripts/backfill-summary-rows.js script — see its header for usage.
# tar builds the downloadable backup archives (server.js's createBackup());
# listed explicitly even though Debian normally ships it, so this doesn't
# depend on that happening to stay true.
RUN apt-get update \
  && apt-get install -y --no-install-recommends poppler-utils tar \
  && rm -rf /var/lib/apt/lists/*

COPY package.json package-lock.json* ./
RUN npm install --omit=dev

COPY server.js ./
COPY public ./public
COPY scripts ./scripts

ENV PORT=3000
EXPOSE 3000

CMD ["node", "server.js"]
