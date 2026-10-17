# Everything the test suites need, in one image: Node 24 and Playwright's
# browsers (Chromium, WebKit and Firefox, from Microsoft's Playwright image,
# matching the @playwright/test version in package-lock.json), OpenCL on the
# CPU (pocl), Vulkan on the CPU (Mesa's lavapipe, for the WebGPU backend),
# Xvfb, the native addon's build tools, and MongoDB.
#
#   docker build -f docker/ci.Dockerfile -t omnifilter-ci .
#   docker/test.sh                      # every suite, in that image
#
# On a machine with an NVIDIA GPU and the NVIDIA Container Toolkit,
# `docker/test.sh --gpu` also hands the container the GPU, for OpenCL and
# Vulkan (so WebGPU) on real hardware. See docs/DOCKER.md.
FROM mcr.microsoft.com/playwright:v1.64.1-noble

ARG DEBIAN_FRONTEND=noninteractive
RUN apt-get update \
  && apt-get install -y --no-install-recommends \
     python3 make g++ ocl-icd-opencl-dev pocl-opencl-icd clinfo \
     libvulkan1 mesa-vulkan-drivers vulkan-tools xvfb gnupg \
  && curl -fsSL https://www.mongodb.org/static/pgp/server-8.0.asc \
     | gpg --dearmor -o /usr/share/keyrings/mongodb-server-8.0.gpg \
  && echo "deb [ signed-by=/usr/share/keyrings/mongodb-server-8.0.gpg ] https://repo.mongodb.org/apt/ubuntu noble/mongodb-org/8.0 multiverse" \
     > /etc/apt/sources.list.d/mongodb-org-8.0.list \
  && apt-get update \
  && apt-get install -y --no-install-recommends mongodb-org-server \
  && rm -rf /var/lib/apt/lists/* \
  # NVIDIA's OpenCL driver, for when the toolkit mounts it in (--gpu).
  && mkdir -p /etc/OpenCL/vendors \
  && echo libnvidia-opencl.so.1 > /etc/OpenCL/vendors/nvidia.icd

# What the NVIDIA Container Toolkit should mount in, when there's a GPU:
# compute for OpenCL, graphics for Vulkan.
ENV NVIDIA_DRIVER_CAPABILITIES=compute,graphics,utility \
    ONNXRUNTIME_NODE_INSTALL_CUDA=skip \
    OMNIFILTER_BUILD_FROM_SOURCE=1

COPY docker/ci-entrypoint.sh /usr/local/bin/omnifilter-ci
ENTRYPOINT ["omnifilter-ci"]
CMD ["bash"]
