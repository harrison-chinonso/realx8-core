# Realx8-Core — the whole backend in one image.
#
# By default the container runs server.js, which serves every service from one
# process on one port. The SAME image runs a partial split (SERVICES=auth,user
# plus the other services' URLs) or a single service on its own
# (`node services/auth-service/src/index.js`) — no rebuild, just a different
# command or environment. That is what makes scaling out a deploy-config change.

FROM node:20-alpine AS deps
WORKDIR /app
# Only the manifests, so a source-only change reuses the install layer.
COPY package.json package-lock.json* ./
COPY shared/package.json                       shared/
COPY services/api-gateway/package.json         services/api-gateway/
COPY services/auth-service/package.json        services/auth-service/
COPY services/user-service/package.json        services/user-service/
COPY services/property-service/package.json    services/property-service/
COPY services/investment-service/package.json  services/investment-service/
COPY services/crm-service/package.json         services/crm-service/
COPY services/finance-service/package.json     services/finance-service/
COPY services/notification-service/package.json services/notification-service/
COPY services/support-service/package.json     services/support-service/
# Workspace install, hoisted to /app/node_modules. It has to be the root:
# shared/src requires sequelize and nodemailer, and Node resolves those by
# walking up from shared/ — it never looks inside services/*/node_modules.
RUN npm ci --omit=dev || npm install --omit=dev

FROM node:20-alpine
ENV NODE_ENV=production
WORKDIR /app
COPY --from=deps /app/node_modules ./node_modules
COPY . .
# user-service serves this over /uploads; mount a volume so it survives deploys.
RUN mkdir -p /app/uploads
EXPOSE 3000
CMD ["node", "server.js"]
