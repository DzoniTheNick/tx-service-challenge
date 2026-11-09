# Local dev/test image for the Enterprise AI Assistant (Cloudflare Agents app).
#
# It runs `yarn dev:all`, which starts two processes:
#   - the app (Vite + Workers runtime) on :5173  ← open this in your browser
#   - the Acme MCP worker on :8788               ← internal, used by the app
#
# Workers AI has no local simulator, so the app proxies inference to Cloudflare.
# That means valid Cloudflare credentials MUST be provided at runtime
# (CLOUDFLARE_ACCOUNT_ID + CLOUDFLARE_API_TOKEN). See docker-compose.yml / .env.
FROM node:24-bookworm

# ca-certificates for the HTTPS calls wrangler makes to the Cloudflare API.
RUN apt-get update \
 && apt-get install -y --no-install-recommends ca-certificates \
 && rm -rf /var/lib/apt/lists/*

ENV COREPACK_ENABLE_DOWNLOAD_PROMPT=0
WORKDIR /app

# Yarn 4 (version comes from package.json "packageManager").
RUN corepack enable

# Install dependencies first for better layer caching. Only the manifests and
# lockfile are needed; copying them separately means `yarn install` is re-run
# only when dependencies actually change.
COPY package.json yarn.lock .yarnrc.yml ./
COPY mcp-server/package.json ./mcp-server/package.json
RUN corepack prepare yarn@4.18.1 --activate \
 && yarn install --immutable

# Now copy the rest of the source (node_modules is excluded via .dockerignore,
# so the correct-platform binaries installed above are preserved).
COPY . .

EXPOSE 5173 8788

# Seed the local skills KV (falls back to bundled skills if this is skipped),
# then launch both servers. Vite binds 0.0.0.0 (see vite.config.ts) so the
# published port is reachable from the host browser.
CMD ["bash", "-lc", "yarn seed; exec yarn dev:all"]
