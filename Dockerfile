# syntax=docker/dockerfile:1
# One image per commit, run unchanged on Windows, on Mac and in Azure: the gr8r-studio web app
# served by the Launch Tracker server. Only JavaScript is built, on the build machine's own
# platform, so the amd64 and arm64 images differ only in their Node.js runtime.
FROM --platform=$BUILDPLATFORM node:22.23.4-alpine@sha256:fe4f6d74e20370acb04ad889077d14d0f64a9c8ea6a42bc60cddf1e844699914 AS build

FROM build AS web
WORKDIR /src
COPY gr8r-studio/package.json gr8r-studio/package-lock.json ./
RUN npm ci --ignore-scripts --no-audit --no-fund
COPY gr8r-studio/ ./
RUN npm run build

FROM build AS server
WORKDIR /src
COPY server/package.json server/package-lock.json ./
RUN npm ci --ignore-scripts --no-audit --no-fund
COPY server/ ./
RUN npm run build \
 && rm dist/*.test.js \
 && npm prune --omit=dev --no-audit --no-fund \
 && if find node_modules -name '*.node' | grep .; then echo 'Native add-ons would be built for the wrong platform.' >&2; exit 1; fi

FROM gcr.io/distroless/nodejs22-debian13:nonroot@sha256:10747a1323be68f206aed893599d43e6697ad67257e7c42703553f99fbce3d33
ARG GIT_COMMIT=""
LABEL org.opencontainers.image.title="Launch Tracker" \
      org.opencontainers.image.source="https://github.com/muttonkodibiriyani/Project-Management-Tool" \
      org.opencontainers.image.revision="${GIT_COMMIT}"
ENV GIT_COMMIT=${GIT_COMMIT}
WORKDIR /app
COPY LICENSE NOTICE ./
COPY --from=server /src/package.json ./
COPY --from=server /src/node_modules ./node_modules
COPY --from=server /src/dist ./dist
COPY --from=web /src/dist ./public
USER nonroot
EXPOSE 8080
HEALTHCHECK --interval=30s --timeout=5s --start-period=10s \
  CMD ["/nodejs/bin/node", "-e", "fetch('http://127.0.0.1:'+(process.env.PORT||8080)+'/healthz').then(r=>process.exit(r.ok?0:1),()=>process.exit(1))"]
CMD ["dist/index.js"]
