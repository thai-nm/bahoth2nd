# Two-stage build. One process serves the static client and the WebSocket
# endpoint on one port — see docs/03-architecture.md#35-build-and-deploy-shape.

FROM node:22-slim AS build
WORKDIR /app

COPY package.json package-lock.json ./
COPY packages/shared/package.json   packages/shared/
COPY packages/content/package.json  packages/content/
COPY packages/engine/package.json   packages/engine/
COPY packages/server/package.json   packages/server/
COPY packages/client/package.json   packages/client/
RUN npm ci

COPY tsconfig.base.json tsconfig.json ./
COPY packages ./packages
RUN npm run build

# Drop dev dependencies from the tree we copy forward.
RUN npm prune --omit=dev

FROM node:22-slim AS runtime
WORKDIR /app
ENV NODE_ENV=production

COPY --from=build /app/node_modules ./node_modules
COPY --from=build /app/package.json ./package.json
COPY --from=build /app/packages/shared/dist   ./packages/shared/dist
COPY --from=build /app/packages/shared/package.json   ./packages/shared/
COPY --from=build /app/packages/content/dist  ./packages/content/dist
COPY --from=build /app/packages/content/fixtures ./packages/content/fixtures
COPY --from=build /app/packages/content/package.json  ./packages/content/
COPY --from=build /app/packages/engine/dist   ./packages/engine/dist
COPY --from=build /app/packages/engine/package.json   ./packages/engine/
COPY --from=build /app/packages/server/dist   ./packages/server/dist
COPY --from=build /app/packages/server/package.json   ./packages/server/
COPY --from=build /app/packages/client/dist   ./packages/client/dist

# Real content is a MOUNTED VOLUME, never baked into the image, so the
# published artifact carries no copyrighted text.
# See docs/01-overview.md#intellectual-property-position.
ENV CONTENT_DIR=/app/content \
    DATA_DIR=/app/data \
    CLIENT_DIR=/app/packages/client/dist \
    PORT=8080
VOLUME ["/app/data"]

EXPOSE 8080
USER node
CMD ["node", "packages/server/dist/index.js"]
