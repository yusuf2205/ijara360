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
RUN npm run build -w @ijara360/api
CMD ["node", "apps/api/dist/main.js"]

FROM base AS web
RUN npm run build -w @ijara360/web
RUN chown -R node:node /app/apps/web/.next
CMD ["node", "node_modules/next/dist/bin/next", "start", "apps/web", "-p", "3000"]
