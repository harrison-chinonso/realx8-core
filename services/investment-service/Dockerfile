# investment, deployed on its own.
#
# Build from the REPO ROOT so the workspace manifests and shared/ come along:
#   docker build -f services/investment-service/Dockerfile -t realx8-investment .
#
# Dependencies install at the workspace root rather than inside this service's
# folder: shared/src requires sequelize and nodemailer, and Node resolves those
# by walking up from shared/ — it never looks in services/*/node_modules.
#
# Only needed for the FULL split. To run just this service off the standard
# image instead, keep the root Dockerfile and override the command.
FROM node:20-alpine
ENV NODE_ENV=production
WORKDIR /app
COPY . .
RUN npm ci --omit=dev || npm install --omit=dev
RUN mkdir -p /app/uploads
EXPOSE 3004
CMD ["node", "services/investment-service/src/index.js"]
