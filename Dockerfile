FROM node:20-bookworm-slim

WORKDIR /app

# poppler-utils (pdftoppm/pdfinfo) rasterizes PDFs for the one-time
# scripts/backfill-summary-rows.js script — see its header for usage.
RUN apt-get update \
  && apt-get install -y --no-install-recommends poppler-utils \
  && rm -rf /var/lib/apt/lists/*

COPY package.json package-lock.json* ./
RUN npm install --omit=dev

COPY server.js ./
COPY public ./public
COPY scripts ./scripts

ENV PORT=3000
EXPOSE 3000

CMD ["node", "server.js"]
