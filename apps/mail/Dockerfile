# Mail service image; runs on any Docker host (we use Railway). Build from the repo root:
#   docker build -f apps/mail/Dockerfile .
FROM node:24-bookworm-slim AS build
ENV CI=true
RUN corepack enable
WORKDIR /repo
COPY . .
RUN pnpm install --frozen-lockfile --filter @omni/mail...
RUN pnpm --filter @omni/mail build \
 && pnpm --filter @omni/mail deploy --prod --config.node-linker=hoisted /out \
 && cp -r apps/mail/dist /out/dist

FROM node:24-bookworm-slim
ENV NODE_ENV=production
# The runtime only runs node; drop the bundled npm/corepack (and their advisories).
RUN rm -rf /usr/local/lib/node_modules/npm /usr/local/lib/node_modules/corepack \
  /usr/local/bin/npm /usr/local/bin/npx /usr/local/bin/corepack
WORKDIR /app
COPY --from=build --chown=node:node /out/package.json ./
COPY --from=build --chown=node:node /out/node_modules ./node_modules
COPY --from=build --chown=node:node /out/dist ./dist
USER node
EXPOSE 8788
CMD ["node", "--enable-source-maps", "dist/main.js"]
