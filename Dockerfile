# ---- build stage ----
FROM node:20-alpine AS build
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci
COPY tsconfig.json tsup.config.ts ./
COPY src ./src
RUN npm run build && npm prune --omit=dev

# ---- runtime stage ----
FROM node:20-alpine AS runtime
ENV NODE_ENV=production
WORKDIR /app

# Run as the built-in non-root user.
USER node

COPY --chown=node:node --from=build /app/node_modules ./node_modules
COPY --chown=node:node --from=build /app/dist ./dist
COPY --chown=node:node package.json ./

# Configure at runtime via OX_MCP_* env vars (no secrets are baked in).
# Per-section fields: OX_MCP_[ID_]<SECTION>_<FIELD>, SECTION ∈ MAIL|CALDAV|CARDDAV:
#   OX_MCP_MAIL_SERVER / _USER / _APP_PASSWORD        mail section (email_* tools)
#   OX_MCP_CALDAV_SERVER / _USER / _APP_PASSWORD      calDav section (calendar_* tools)
#   OX_MCP_CARDDAV_SERVER / _USER / _APP_PASSWORD     cardDav section (contact_* tools)
#   OX_MCP_MAIL_IMAP_HOST/_PORT, _SMTP_HOST/_PORT     split mail endpoints (optional)
#   OX_MCP_ACCOUNTS                                   comma-separated ids for multi-account
#   OX_MCP_ENABLE_<TOOL|SECTION>                      e.g. OX_MCP_ENABLE_EMAIL_SEND=true
#   OX_MCP_CONFIG                                     explicit config file path (must exist)
# See README for the full list and per-account/auth-type variables.

# MCP server speaks JSON-RPC over stdio.
ENTRYPOINT ["node", "dist/index.js"]
