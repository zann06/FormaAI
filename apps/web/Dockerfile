# syntax=docker/dockerfile:1

# ---- build stage: produce the static SPA bundle ------------------------------
FROM node:22-bookworm-slim AS build
WORKDIR /app

COPY package.json package-lock.json ./
COPY packages/shared/package.json packages/shared/
COPY packages/docx-engine/package.json packages/docx-engine/
COPY packages/ai-providers/package.json packages/ai-providers/
COPY apps/api/package.json apps/api/
COPY apps/web/package.json apps/web/
RUN npm ci --workspaces --include-workspace-root

COPY packages/shared ./packages/shared
COPY apps/web ./apps/web
RUN npm run build --workspace @formaai/shared \
 && npm run build --workspace @formaai/web

# ---- runtime stage: nginx serving static files + proxying /api --------------
FROM nginx:1.27-alpine AS runtime

# The SPA talks to same-origin `/api`, so nginx proxies to the API service.
# `client_max_body_size` is raised to match MAX_FILE_MB (default 25 MB).
COPY apps/web/nginx.conf /etc/nginx/conf.d/default.conf
COPY --from=build /app/apps/web/dist /usr/share/nginx/html

EXPOSE 80
HEALTHCHECK --interval=30s --timeout=5s --retries=3 \
  CMD wget -q --spider http://127.0.0.1/ || exit 1

CMD ["nginx", "-g", "daemon off;"]
