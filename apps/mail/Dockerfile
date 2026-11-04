# Mail service image; runs on any Docker host (we use Fly.io). Build from the repo root:
#   docker build -f apps/mail/Dockerfile .
FROM node:26-bookworm-slim AS build
ENV CI=true
WORKDIR /repo
COPY . .
# Node 25+ no longer bundles corepack: install the pnpm that package.json `packageManager` pins.
RUN npm install -g --silent "$(node -p 'require("./package.json").packageManager')"
RUN pnpm install --frozen-lockfile --filter @omni/mail...
RUN pnpm --filter @omni/mail build \
 && pnpm --filter @omni/mail deploy --prod --config.node-linker=hoisted /out \
 && cp -r apps/mail/dist /out/dist \
 && cp -r packages/db/migrations /out/migrations

FROM node:26-bookworm-slim
ENV NODE_ENV=production
# The runtime only runs node; drop the bundled npm (and its advisories).
RUN rm -rf /usr/local/lib/node_modules/npm /usr/local/bin/npm /usr/local/bin/npx
WORKDIR /app
COPY --from=build --chown=node:node /out/package.json ./
COPY --from=build --chown=node:node /out/node_modules ./node_modules
COPY --from=build --chown=node:node /out/dist ./dist
# Applied by dist/migrate.js, fly.toml's release_command, before each new version goes live.
COPY --from=build --chown=node:node /out/migrations ./migrations
USER node
EXPOSE 8788
CMD ["node", "--enable-source-maps", "dist/main.js"]
