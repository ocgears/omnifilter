# The test image

`docker/ci.Dockerfile` is everything the test suites need, in one image:
- Node 24 and Playwright's browsers (Chromium, WebKit and Firefox), from Microsoft's `mcr.microsoft.com/playwright` image. Its version matches `@playwright/test` in `package-lock.json`; when Playwright is upgraded, change the `FROM` line too.
- OpenCL on the CPU (pocl), for the server's filters.
- Vulkan on the CPU (Mesa's lavapipe), for the server's WebGPU backend.
- Xvfb, the native addon's build tools, and MongoDB 8, which starts with the container.

CI's `ci-image` job builds it on every push and runs the server tests and both browsers in it. The `ci image` workflow (`.github/workflows/ci-image.yml`) publishes it to GitHub's container registry whenever `docker/` changes, tagged with its commit, and as `latest` from master:

```
docker pull ghcr.io/ocgears/omnifilter-ci:latest
```

## Running the tests in it

```
docker/test.sh            # the server, client and end-to-end tests
docker/test.sh e2e        # or one of them: server, client, e2e
```

This is the way to run everything on a Mac that Playwright doesn't support (macOS 12 runs Chrome but not WebKit, so the iPhone project is skipped there). The checkout is mounted into the container; its `node_modules` stay in Docker volumes, since a Mac's won't run on Linux.

In the image, the browser's WebGPU runs on Chromium's SwiftShader, as in CI. The server's filters run on pocl, or on lavapipe with `OMNIFILTER_BACKEND=webgpu` and the `webgpu` package (see the CI workflow's `webgpu` job).

## On a real GPU

On a Linux machine with an NVIDIA GPU, its driver, and the [NVIDIA Container Toolkit](https://docs.nvidia.com/datacenter/cloud-native/container-toolkit/latest/install-guide.html):

```
docker/test.sh --gpu
```

This passes `--gpus all`. The image asks the toolkit for the driver's `compute` and `graphics` parts, so OpenCL (the server's filters) and Vulkan (the browser's WebGPU and the server's WebGPU backend) can both reach the GPU. The driver comes from the host at run time, so it isn't in the image.

`clinfo --list` and `vulkaninfo --summary` at the start of the run show what the container can see. If Chrome still reports SwiftShader, its WebGPU needs flags such as `--use-angle=vulkan --enable-features=Vulkan --disable-vulkan-surface`. [Google's write-up](https://developer.chrome.com/blog/supercharge-web-ai-testing) covers this, including a Colab T4.

The same image would run on a GPU cloud that takes Docker images, such as a Modal trial, to test on a real GPU without owning one.

## Using it in CI later

With the image published, CI jobs could run in it with `container: ghcr.io/ocgears/omnifilter-ci:<commit>` instead of installing packages each time. A new package on ghcr.io starts private to the ocgears org; to let anyone pull it, change its visibility under the org's Packages, `omnifilter-ci`, Package settings.
