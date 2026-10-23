FROM node:22-bookworm-slim AS base
RUN apt-get update && apt-get install -y --no-install-recommends openssl ca-certificates && rm -rf /var/lib/apt/lists/*
WORKDIR /app
ENV NEXT_TELEMETRY_DISABLED=1
COPY package.json package-lock.json ./
COPY apps/api/package.json apps/api/package.json
COPY apps/web/package.json apps/web/package.json
COPY prisma ./prisma
RUN npm ci --no-fund
COPY apps ./apps
COPY scripts ./scripts
# COPY keeps the release checkout's modes; the runtime user "node" must be able to read the code.
RUN chmod -R a+rX apps scripts prisma package.json package-lock.json
RUN npm run db:generate

FROM base AS api
# Tesseract reads passport/ID-card MRZ on-device for KYC; eng covers the Latin MRZ (OCR-B). API image only.
# fonts-dejavu-core lets sharp/resvg render text (used by the OCR self-test to synthesise a sample MRZ).
RUN apt-get update && apt-get install -y --no-install-recommends tesseract-ocr tesseract-ocr-eng fonts-dejavu-core && rm -rf /var/lib/apt/lists/*
RUN npm run build -w @ijara360/api
CMD ["node", "apps/api/dist/main.js"]

FROM base AS web
# apps/web/public/app is the Flutter web build shipped with the release (scripts/Publish-Project.ps1).
RUN test -f apps/web/public/app/index.html
RUN npm run build -w @ijara360/web
RUN chown -R node:node /app/apps/web/.next
CMD ["node", "node_modules/next/dist/bin/next", "start", "apps/web", "-p", "3000"]
