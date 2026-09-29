# Quran Reader, hosted mode. The corpus is downloaded and hash-verified at build time
# (npm run corpus:fetch); nothing licensed is baked into the repository.
#
#   docker build -t quran-reader .
#   docker run -p 4317:4317 -v qo-state:/app/data/state \
#     -e SONIOX_API_KEY=... -e OPENROUTER_API_KEY=... -e QO_PUBLIC_ORIGIN=https://your.domain \
#     -e QO_TRUST_PROXY=1 quran-reader
#
# Put it behind an HTTPS reverse proxy that forwards WebSockets (see docs/DEPLOY.md).

FROM node:24-slim AS build
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci
COPY . .
RUN npm run corpus:fetch \
 && npm run corpus:import -- --manifest corpus/sources.json \
 && npm run corpus:validate \
 && npm run wbw:import \
 && npx tsx scripts/create-content-template.ts \
 && npm run build

FROM node:24-slim AS runtime
WORKDIR /app
ENV NODE_ENV=production QO_HOSTED=1 QO_HOST=0.0.0.0 PORT=4317
COPY --from=build /app/package.json /app/package-lock.json ./
RUN npm ci --omit=dev
COPY --from=build /app/src ./src
COPY --from=build /app/scripts/sponsor-pool.ts ./scripts/sponsor-pool.ts
COPY --from=build /app/scripts/project-cost.ts ./scripts/project-cost.ts
COPY --from=build /app/scripts/sync-content.ts ./scripts/sync-content.ts
COPY --from=build /app/corpus ./corpus
COPY --from=build /app/tsconfig.json ./
COPY --from=build /app/dist ./dist
COPY --from=build /app/data/processed/fonts ./data/processed/fonts
COPY --from=build /app/data/processed/content-template.json ./data/processed/content-template.json
# Credits, visitor-signing secret: keep on a volume so they survive redeploys.
VOLUME ["/app/data/state"]
EXPOSE 4317
HEALTHCHECK --interval=30s --timeout=3s CMD node -e "fetch('http://127.0.0.1:'+(process.env.PORT||4317)+'/healthz').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"
CMD ["npx", "tsx", "src/server/main.ts"]

# Public deployment: authenticated content lives on its own renewable cache volume.
# This image contains no bundled verse, translation, or word-gloss cache.
FROM runtime AS live
ENV QO_REQUIRE_CONTENT_SYNC=1 QO_CONTENT_STORE=/app/data/live
VOLUME ["/app/data/live"]

# Keep the reproducible bundled target for local use and credential-free CI checks.
FROM runtime AS bundled
COPY --from=build /app/data/processed ./data/processed
