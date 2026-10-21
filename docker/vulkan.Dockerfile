# The API with the WebGPU backend (OMNIFILTER_BACKEND=webgpu): Dawn, from the
# `webgpu` npm package, on Vulkan. See docs/DOCKER.md, "The Vulkan image".
#
#   docker build -f docker/vulkan.Dockerfile -t omnifilter-vulkan .
#
# On its own it runs on Mesa's lavapipe, a Vulkan driver on the CPU, so it
# works anywhere the root image does. Given a GPU it uses that instead:
#
#   NVIDIA (with the NVIDIA Container Toolkit):  docker run --gpus all ...
#   AMD or Intel (Mesa's RADV or ANV):            docker run --device /dev/dri \
#     --group-add "$(stat -c %g /dev/dri/renderD128)" ...
#
# Unlike the root image there's no OpenCL (no native addon, no pocl): the
# filters run only through WebGPU.

# ---- build: the Angular client, and the server's packages with webgpu ----
FROM node:24-trixie-slim@sha256:7f486cabe892bff8fef04c0f7da8dba84a560be3e4e2740b7a86afc57ebec315 AS build
WORKDIR /usr/src/app

# --ignore-scripts skips compiling the OpenCL addon (the "install" script),
# which this image doesn't use, and ONNX Runtime's download of its CUDA
# provider. sharp and bcrypt ship prebuilt and need no script.
COPY package.json package-lock.json ./
RUN npm ci --ignore-scripts --no-audit --no-fund
COPY client/package.json client/package-lock.json ./client/
RUN npm ci --prefix client --no-audit --no-fund

COPY . .
# The same version CI tests (WEBGPU_VERSION in .github/workflows/test.yml).
# Its only install script is for macOS. Of its binaries for five platforms
# (140 MB) only this one's is kept. FETCH_MODELS=false leaves out the neural
# style models, as in the root Dockerfile.
ARG WEBGPU_VERSION=0.6.2
ARG FETCH_MODELS=true
RUN npm run build:prod && npm prune --omit=dev \
  && npm install --no-save --omit=dev --ignore-scripts --no-audit --no-fund webgpu@$WEBGPU_VERSION \
  && keep="linux-$(node -p process.arch)" \
  && find node_modules/webgpu/dist -mindepth 1 -maxdepth 1 ! -name "$keep" -exec rm -rf {} + \
  && if [ "$FETCH_MODELS" = "true" ]; then npm run fetch-models; else mkdir -p models; fi \
  && rm -rf node_modules/onnxruntime-node/bin/napi-v3/darwin node_modules/onnxruntime-node/bin/napi-v3/win32 \
     node_modules/onnxruntime-node/bin/napi-v3/linux/*/libonnxruntime_providers_cuda.so

# ---- runtime ----
FROM node:24-trixie-slim@sha256:7f486cabe892bff8fef04c0f7da8dba84a560be3e4e2740b7a86afc57ebec315

# The Vulkan loader, and Mesa's Vulkan drivers: lavapipe (the CPU), RADV
# (AMD), ANV (Intel) and others, used when /dev/dri is passed in. NVIDIA's
# driver comes from the host, mounted by the NVIDIA Container Toolkit; its
# Vulkan driver needs libglvnd (libGLdispatch), which libegl1 brings.
RUN apt-get update \
  && apt-get install -y --no-install-recommends libvulkan1 mesa-vulkan-drivers libegl1 \
  && rm -rf /var/lib/apt/lists/*

# OMNIFILTER_DEVICE=auto takes a GPU if Vulkan has one and falls back to
# lavapipe if not. The NVIDIA Container Toolkit mounts the Vulkan driver only
# with the "graphics" capability, which its default (compute,utility) leaves
# out.
ENV NODE_ENV=production \
    OMNIFILTER_BACKEND=webgpu \
    OMNIFILTER_DEVICE=auto \
    NVIDIA_DRIVER_CAPABILITIES=compute,graphics,utility

WORKDIR /usr/src/app
COPY --from=build /usr/src/app/package.json ./
RUN npm pkg delete scripts.install
COPY --from=build /usr/src/app/node_modules ./node_modules
COPY --from=build /usr/src/app/models ./models
COPY --from=build /usr/src/app/dist ./dist
COPY --from=build /usr/src/app/server ./server
COPY --from=build /usr/src/app/clientserver.js ./
# `docker run --rm omnifilter-vulkan npm run devices` shows the WebGPU
# adapter, and `npm run check-device` runs every filter on it.
COPY --from=build /usr/src/app/scripts/devices.js /usr/src/app/scripts/check-device.js ./scripts/
RUN rm -rf server/test

USER node
EXPOSE 3000 5000

HEALTHCHECK --interval=30s --timeout=5s --start-period=30s --retries=3 \
  CMD node -e "fetch('http://localhost:' + (process.env.PORT || 3000) + '/device').then((r) => process.exit(r.ok ? 0 : 1), () => process.exit(1))"

CMD ["node", "server/server.js"]
