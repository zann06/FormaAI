# syntax=docker/dockerfile:1

# ---- build stage: compile the API and workspace packages ----------------------
FROM node:22-bookworm-slim AS build
WORKDIR /app

# Install dependencies first so this layer is cached across source changes.
COPY package.json package-lock.json ./
COPY packages/shared/package.json packages/shared/
COPY packages/docx-engine/package.json packages/docx-engine/
COPY packages/ai-providers/package.json packages/ai-providers/
COPY apps/api/package.json apps/api/
COPY apps/web/package.json apps/web/
RUN npm ci --workspaces --include-workspace-root

# Build the workspace libraries first; the API imports their compiled output.
COPY packages ./packages
COPY apps/api ./apps/api
RUN npm run build --workspace @formaai/shared \
 && npm run build --workspace @formaai/docx-engine \
 && npm run build --workspace @formaai/ai-providers \
 && npm run build --workspace @formaai/api

# Drop dev dependencies for the runtime image.
RUN npm prune --omit=dev

# ---- runtime stage: API + LibreOffice for PDF conversion ---------------------
FROM node:22-bookworm-slim AS runtime
WORKDIR /app

# LibreOffice (headless) converts the final DOCX to PDF. Without it the API still
# runs and DOCX export works; PDF export returns PDF_CONVERTER_NOT_CONFIGURED.
RUN apt-get update \
 && apt-get install -y --no-install-recommends \
      libreoffice-writer \
      fonts-dejavu-core \
      fonts-liberation \
      tini \
 && rm -rf /var/lib/apt/lists/*

ENV NODE_ENV=production \
    API_HOST=0.0.0.0 \
    API_PORT=8787 \
    LIBREOFFICE_BIN=soffice

COPY --from=build /app/node_modules ./node_modules
COPY --from=build /app/package.json ./package.json
COPY --from=build /app/packages ./packages
COPY --from=build /app/apps/api/package.json ./apps/api/package.json
COPY --from=build /app/apps/api/dist ./apps/api/dist
COPY --from=build /app/apps/api/drizzle ./apps/api/drizzle
COPY --from=build /app/apps/api/drizzle.config.ts ./apps/api/drizzle.config.ts

RUN mkdir -p /app/data/storage && chown -R node:node /app/data
USER node
WORKDIR /app/apps/api

EXPOSE 8787
HEALTHCHECK --interval=30s --timeout=5s --start-period=20s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:8787/api/health').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"

ENTRYPOINT ["/usr/bin/tini", "--"]
CMD ["node", "dist/index.js"]
