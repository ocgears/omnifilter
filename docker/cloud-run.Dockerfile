# The hosted demo's image, for Google Cloud Run (docs/CLOUD_RUN.md): the API
# in cloud mode, serving the built client from the same address.
#
#   docker build -f docker/cloud-run.Dockerfile -t omnifilter-cloud .
#
# In cloud mode visitors' photos are filtered on their own GPU, in the
# browser, so unlike the root Dockerfile this has no OpenCL (no native addon,
# no pocl) and no neural style models: the server signs people in and keeps
# their photos. A small image starts quickly when Cloud Run scales up from
# nothing.

# ---- build: the Angular client ----
FROM node:24-trixie-slim AS client
WORKDIR /usr/src/app
COPY client/package.json client/package-lock.json ./client/
RUN npm ci --prefix client --no-audit --no-fund
COPY . .
# OMNIFILTER_API=/ : the page calls the API at its own address (the default,
# port 3000 of the page's host, is for docker compose and `npm start`).
RUN OMNIFILTER_API=/ node scripts/client.js build --production

# ---- runtime ----
FROM node:24-trixie-slim
ENV NODE_ENV=production \
    OMNIFILTER_MODE=cloud
WORKDIR /usr/src/app
# --ignore-scripts skips building the native OpenCL addon (the "install"
# script); without it the server reports the filters as unavailable rather
# than failing, and in cloud mode it never runs them. sharp, which reads
# kept photos, and bcrypt ship prebuilt and need no script. Then ONNX
# Runtime goes (180 MB, an optional package for the neural style filters,
# which a cloud-mode server doesn't run either; without it they report
# themselves unavailable), and so do sharp's builds for musl (Alpine), so a
# new instance has less image to fetch.
COPY package.json package-lock.json ./
RUN npm ci --omit=dev --ignore-scripts --no-audit --no-fund \
  && rm -rf node_modules/onnxruntime-node node_modules/onnxruntime-common node_modules/@img/*linuxmusl* \
  && npm pkg delete scripts.install \
  && npm cache clean --force
COPY server ./server
RUN rm -rf server/test
COPY --from=client /usr/src/app/dist ./dist
# Node's compile cache, filled here by loading the server's modules once, so
# a new instance (the first request after an idle spell waits for it) skips
# compiling them. Node keeps a cache for each user, so it's filled as the
# user the server runs as.
ENV NODE_COMPILE_CACHE=/usr/src/app/.node-compile-cache
RUN mkdir -p "$NODE_COMPILE_CACHE" && chown node "$NODE_COMPILE_CACHE"
USER node
RUN node -e "require('./server/server.js'); require('sharp'); setTimeout(() => process.exit(0), 100)" \
  && test -n "$(ls -A "$NODE_COMPILE_CACHE"/*/)"

# Cloud Run says which port to listen on in PORT (8080).
ENV PORT=8080
EXPOSE 8080
CMD ["node", "server/server.js"]
