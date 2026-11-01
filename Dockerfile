# One image: the API serves the built web app. x86-64 (Motherboxx is an i5-10600T).
FROM node:22-alpine AS build
WORKDIR /src
RUN corepack enable
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml tsconfig.base.json ./
COPY packages/core/package.json packages/core/
COPY apps/api/package.json apps/api/
COPY apps/web/package.json apps/web/
RUN pnpm install --frozen-lockfile --filter "./packages/*" --filter "./apps/*"
COPY packages packages
COPY apps apps
RUN pnpm --filter @optimystic/web build \
 && pnpm --filter @optimystic/api build \
 && pnpm --filter @optimystic/api deploy --prod --legacy /out

FROM node:22-alpine
ENV NODE_ENV=production PORT=8080 HOST=0.0.0.0 WEB_DIST=/app/web
WORKDIR /app
COPY --from=build /out/node_modules ./node_modules
COPY --from=build /out/package.json ./package.json
COPY --from=build /src/apps/api/dist ./dist
COPY --from=build /src/apps/web/dist ./web
USER node
EXPOSE 8080
# busybox wget is in the alpine base, so the compose healthcheck works as written
HEALTHCHECK --interval=30s --timeout=5s --retries=3 CMD wget -qO- http://localhost:8080/api/health || exit 1
CMD ["node", "dist/index.js"]
