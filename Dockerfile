# Docker containers can't reach the GPU on macOS or Windows (and on Linux only
# with vendor tooling), so this image ships pocl, a portable OpenCL driver that
# runs the same kernels on the container's CPU. See docker-compose.yml.

# ---- build: compile the native OpenCL addon and build the Angular client ----
FROM node:24-trixie-slim AS build

# Compiler toolchain for node-gyp, plus the OpenCL headers and ICD loader.
RUN apt-get update \
  && apt-get install -y --no-install-recommends python3 make g++ ocl-icd-opencl-dev \
  && rm -rf /var/lib/apt/lists/*

WORKDIR /usr/src/app

# Install dependencies first so this layer is cached until they change.
# npm ci also compiles the addon (the "install" script), so it needs the
# addon's source and the install script, but not the kernels (native/kernels,
# read at run time), so editing a kernel doesn't redo this layer.
# Keep this list in step with what binding.gyp ("sources") and
# scripts/install-native.js (SOURCES, and anything else it reads) use.
COPY package.json package-lock.json binding.gyp ./
COPY native/omnifilter.cpp ./native/
COPY scripts/install-native.js ./scripts/
# ONNX Runtime's installer would also fetch a 500 MB CUDA (NVIDIA) provider.
# The addon is compiled here rather than downloaded, since the toolchain is
# installed anyway and the runtime stage copies it from build/Release.
ENV ONNXRUNTIME_NODE_INSTALL_CUDA=skip \
    OMNIFILTER_BUILD_FROM_SOURCE=1
RUN npm ci

# The Angular client's packages (client/ is its own npm package), cached the
# same way.
COPY client/package.json client/package-lock.json ./client/
RUN npm ci --prefix client --no-audit --no-fund

COPY . .
# Build the client into dist/ (minified, without source maps), drop dev
# dependencies, download the neural style models
# (about 34 MB, checksum-verified), and remove the macOS and Windows binaries
# that ONNX Runtime ships alongside the Linux ones. Build with
# --build-arg FETCH_MODELS=false to leave the models out; the neural styles
# then report that they're missing and every other filter works as usual.
ARG FETCH_MODELS=true
RUN npm run build:prod && npm prune --omit=dev \
  && if [ "$FETCH_MODELS" = "true" ]; then npm run fetch-models; else mkdir -p models; fi \
  && rm -rf node_modules/onnxruntime-node/bin/napi-v3/darwin node_modules/onnxruntime-node/bin/napi-v3/win32 \
     node_modules/onnxruntime-node/bin/napi-v3/linux/*/libonnxruntime_providers_cuda.so

# ---- runtime ----
FROM node:24-trixie-slim

# The OpenCL ICD loader, and pocl as the OpenCL driver.
RUN apt-get update \
  && apt-get install -y --no-install-recommends ocl-icd-libopencl1 pocl-opencl-icd \
  && rm -rf /var/lib/apt/lists/*

# pocl exposes a CPU device, so accept any OpenCL device rather than only GPUs.
ENV NODE_ENV=production \
    OMNIFILTER_DEVICE=any

WORKDIR /usr/src/app
COPY --from=build /usr/src/app/package.json ./
# The addon is already built, and its source and install script aren't in this
# image, so drop the "install" script rather than have a later `npm install`
# or `npm rebuild` fail on it.
RUN npm pkg delete scripts.install
COPY --from=build /usr/src/app/node_modules ./node_modules
COPY --from=build /usr/src/app/build/Release/omnifilter.node ./build/Release/
COPY --from=build /usr/src/app/native/kernels ./native/kernels
COPY --from=build /usr/src/app/models ./models
COPY --from=build /usr/src/app/dist ./dist
COPY --from=build /usr/src/app/server ./server
COPY --from=build /usr/src/app/clientserver.js ./
# `docker run --rm omnifilter npm run devices` lists the OpenCL devices, and
# `docker run --rm omnifilter npm run check-device` runs every filter on one.
COPY --from=build /usr/src/app/scripts/devices.js /usr/src/app/scripts/check-device.js ./scripts/

USER node
EXPOSE 3000 5000

# Healthy once the API answers. docker-compose.yml gives the client server,
# which runs from the same image, a healthcheck of its own.
HEALTHCHECK --interval=30s --timeout=5s --start-period=30s --retries=3 \
  CMD node -e "fetch('http://localhost:' + (process.env.PORT || 3000) + '/device').then((r) => process.exit(r.ok ? 0 : 1), () => process.exit(1))"

# The API server; docker-compose.yml runs the client server from the same image.
CMD ["node", "server/server.js"]
