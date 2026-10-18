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
FROM node:25-trixie-slim@sha256:aabbe39553d15ede8a97cc60c9e1a97034ff772afcf696ea42b94e7f5f2ec71b AS client
WORKDIR /usr/src/app
COPY client/package.json client/package-lock.json ./client/
RUN npm ci --prefix client --no-audit --no-fund
COPY . .
# OMNIFILTER_API=/ : the page calls the API at its own address (the default,
# port 3000 of the page's host, is for docker compose and `npm start`).
RUN OMNIFILTER_API=/ node scripts/client.js build --production

# ---- runtime ----
FROM node:25-trixie-slim@sha256:aabbe39553d15ede8a97cc60c9e1a97034ff772afcf696ea42b94e7f5f2ec71b
# Reading a photo takes a lot of memory for a moment (a 49 megapixel GIF,
# about 250 MB), and the server has 512 MiB. Fewer malloc arenas, one libvips
# thread (there's one CPU), and big allocations handed straight back to the
# system keep the peak down and stop it from staying up: four such GIFs one
# after another peaked at 310 MiB, and the server went back to 49 MiB.
ENV NODE_ENV=production \
    OMNIFILTER_MODE=cloud \
    MALLOC_ARENA_MAX=2 \
    MALLOC_MMAP_THRESHOLD_=131072 \
    VIPS_CONCURRENCY=1
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
