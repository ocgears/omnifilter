# Running on more GPUs: a plan

Omnifilter was built and tested on one machine: a 2015 MacBook Pro with an Intel Iris 6100 (OpenCL 1.2, macOS 12), plus pocl on the CPU in Docker. This document is the plan for running well on everything else: other GPU vendors, other operating systems, containers, the cloud and the browser.

*Written October 2026. Driver and API support changes quickly, so the "today" columns below should be re-checked before each phase starts.*

## Where things stand

The design already helps here. Filters don't talk to OpenCL directly. They build a **plan**: a list of named buffers and kernel passes (`server/lib/filters/plan.js`), which the native addon runs (`native/omnifilter.cpp`). The plan format says nothing OpenCL-specific beyond kernel names and argument types, so a second backend can run the same plans.

The kernels: 56 kernels in about 1,800 lines of OpenCL C 1.2 (`native/kernels/*.cl`). 14 of them read images (textures), the histogram and Voronoi kernels use atomics, and none use double precision.

Assumptions baked in that won't hold everywhere:

| Assumption | Where | Breaks on |
|---|---|---|
| Banded launches use 16x16 work-groups | `omnifilter.cpp`, band loop | Devices whose maximum work-group size or shape is smaller, e.g. Apple's CPU device (1024x1x1), some mobile GPUs |
| Images (textures) are supported, up to 16384 px per side | 14 kernels; `image_codec.js` caps input at 16384 | OpenCL 3.0 devices without image support; GPUs with 8192 limits |
| The first device of the wanted type is the right one | `PickDevice` | Machines with an integrated *and* a discrete GPU, or several platforms (e.g. pocl and a vendor driver) |
| Every kernel is short enough to dodge the display watchdog | banding sizes tuned by hand on the Iris 6100 | Slower GPUs (watchdog kills), and needlessly slow on compute GPUs with no watchdog |
| The whole image fits in one device allocation | `CL_DEVICE_MAX_MEM_ALLOC_SIZE` check | GPUs with small allocation limits (often 1/4 of memory) at 50 MP |
| macOS or Linux, x64 | `binding.gyp` | Windows (no OpenCL headers or library configured); prebuilt binaries for arm64. *Fixed in Phase 1.* |

## The situations to cover

| Situation | OpenCL today | Plan |
|---|---|---|
| macOS, Intel GPU | Works (this machine) | Keep |
| macOS, Apple Silicon | Apple still ships OpenCL 1.2, but it has been deprecated since 2018 and gets no fixes | Phase 0 testing now; WebGPU backend (Phase 3) is the long-term path |
| Linux, NVIDIA | NVIDIA driver includes OpenCL 3.0 | Phase 0 (device choice, work-group sizes), Phase 2 (Docker) |
| Linux, AMD | ROCm OpenCL, or Mesa's Rusticl on radeonsi | Phase 0, Phase 2 |
| Linux, Intel | Intel compute-runtime for Gen12 (Tiger Lake) and newer; Gen8-Gen11 only have a frozen legacy runtime since late 2024. Rusticl on iris covers both | Phase 0, Phase 2 |
| Linux, Arm Mali / Qualcomm Adreno (boards, Chromebooks, Asahi Macs) | Mesa's Rusticl now enables Panfrost, Freedreno and Asahi by default ([Phoronix](https://phoronix.com/news/Rusticl-2026)) | Phase 0 is the main work: these devices are the most likely to hit the work-group and image assumptions |
| Windows, NVIDIA / AMD / Intel | Vendor drivers include OpenCL | Phase 1 (build on Windows) |
| Windows on Arm | Microsoft's OpenCL-on-D3D12 layer (OpenCLOn12) | Phase 1, then WebGPU |
| WSL2 | Intel GPUs have OpenCL in WSL2 ([Phoronix](https://www.phoronix.com/news/Intel-oneAPI-L0-WSL2)); NVIDIA provides CUDA there, not OpenCL | Falls back to CPU (pocl) until the WebGPU backend |
| Docker on a Linux GPU host | Possible, but needs the vendor's OpenCL driver passed in | Phase 2 |
| Docker on macOS / Windows | No GPU access; pocl on the CPU (current image) | Keep; it's the "works anywhere" baseline |
| Cloud GPU instance (NVIDIA T4/L4/A10 etc.) | NVIDIA OpenCL | Phase 2's NVIDIA image |
| No GPU | pocl, or Apple's CPU device | Keep, fix the work-group bug (Phase 0) |
| The user's browser | n/a | Phase 4: WebGPU live preview |

## Phase 0: make the OpenCL path portable

Cheap, and it fixes real bugs. Everything else builds on it.

**Status (October 2026): done, with three changes from the plan below.** The whole test suite now passes on Apple's CPU device as well as the GPU (it was 124 of 166). Work-group sizes, device choice (`npm run devices`), fitting buffers and textures to the device, adaptive band sizes and the CI workflow (`.github/workflows/test.yml`) are in. The changes:
* *Suggested work-group size query:* not used. Passes without a work-group size already let the driver choose, and banded passes want square tiles, which the query wouldn't give.
* *Kernels without images:* devices without image support hide the 14 texture filters instead of getting buffer-based copies of them. Such devices are rare (every desktop GPU, pocl, Rusticl and clvk support images), and the copies would double those kernels.
* *Tiling:* filters too big for the device run on a scaled-down copy instead of being split into exact tiles. On this machine everything fits at the 50 megapixel limit; exact tiling can come later if a small-memory GPU needs it.
* *CI:* the workflow runs every test on pocl (Node 22 and 24) and Mesa's Rusticl, and found a Rusticl crash that now has a workaround (see Phase 1).

1. **Ask the device for its limits instead of assuming them.** At init, read `CL_DEVICE_MAX_WORK_ITEM_SIZES`, `CL_DEVICE_MAX_WORK_GROUP_SIZE`, `CL_DEVICE_IMAGE_SUPPORT`, `CL_DEVICE_IMAGE2D_MAX_WIDTH/HEIGHT`, `CL_DEVICE_IMAGE3D_MAX_*`, `CL_DEVICE_LOCAL_MEM_SIZE`, `CL_DEVICE_GLOBAL_MEM_SIZE` and `CL_DEVICE_MAX_MEM_ALLOC_SIZE`, and for each kernel `CL_KERNEL_WORK_GROUP_SIZE`. Expose them through `deviceInfo()`.
   * Banded launches pick a tile that fits: 16x16 where allowed, otherwise the largest shape the device and kernel accept (e.g. 64x1). This fixes `OMNIFILTER_DEVICE=cpu` on macOS. On OpenCL 3.1 drivers, use the new suggested work-group size query (`clGetKernelSuggestedLocalWorkSizeKHR`) instead of guessing, keeping the fallback for OpenCL 1.2 (Apple).
   * Kernels that use `__local` arrays (histograms) check that the local memory fits.
   * The image size cap in `image_codec.js` comes from the device instead of the constant 16384.
2. **Choosing a device.** Add `native.devices()` listing every platform and device, and let `OMNIFILTER_DEVICE` also take a name fragment or index (`OMNIFILTER_DEVICE="RTX"`, `OMNIFILTER_DEVICE=1`). By default prefer a discrete GPU over an integrated one, and skip a device whose kernel compile fails, logging why, instead of giving up.
3. **Fallbacks for missing features.**
   * Devices without image support: give `common.cl` a buffer-based `sample_bilinear()` helper and compile with `-D NO_IMAGES`. The 14 texture kernels get a buffer path, and the addon then passes buffers where plans ask for `img`.
   * Very large images, or GPUs with small allocations: tile the image. Run the plan on overlapping tiles, each with a halo as wide as the filter's reach, and stitch the results. Filters declare their reach (e.g. blur radius); whole-image filters (equalize, auto levels) need a global first pass and opt out.
4. **Watchdog-aware banding.** Only GPUs that drive a display have a watchdog. Time the first band of each banded pass and size later bands to stay under ~0.5 s: big bands on compute GPUs and in Docker, small ones on laptops.
5. **Test kernels on several OpenCL implementations in CI.** pocl (already used in Docker) and Mesa's Rusticl are two independent compilers that run in plain GitHub Actions runners, Rusticl on llvmpipe (Mesa's software rasteriser) or on lavapipe through Zink. Running the existing reference tests on both catches most "works on my driver" bugs before they reach real GPUs. Precision differs a little between vendors, so tolerances may need to be per-test rather than "within 1".

## Phase 1: build and ship on every OS

**Status (October 2026): in progress.** Done so far:
* The addon is loaded by `server/lib/native.js` (instead of the `bindings` package), and `npm install` runs `scripts/install-native.js`, which downloads a prebuilt binary matching a hash of the native source, checks its SHA-256 and that it loads, and otherwise compiles. A missing OpenCL runtime no longer stops the server starting.
* `.github/workflows/prebuilds.yml` builds the addon for linux-x64 and linux-arm64 (on Debian 11, for older glibc), darwin-arm64 and darwin-x64 (cross-compiled), and win32-x64 and win32-arm64 (OpenCL headers from vcpkg), and checks each loads. Publishing them to the `native-prebuilds` release is a manual run of the workflow for now (not yet done); the run prints each binary's SHA-256, and `npm install` only uses a binary once its checksum is committed to `native/prebuilds.json`.
* CI also builds and loads the addon on Windows, and on macOS checks every filter if the runner has an OpenCL device.
* `GET /device` and a line in the page show which device the filters run on.
* CI found that Mesa's Rusticl (llvmpipe) crashes in `sin`, `cos` and `tan`. Kernels for Rusticl devices are compiled with a workaround that uses `sinpi`/`cospi` instead (see `common.cl`); the per-filter `npm run check-device` found it.

1. **Windows:** have `binding.gyp` find the Khronos OpenCL headers and ICD loader (vcpkg's `opencl` package or the Khronos OpenCL-SDK). Every vendor driver installs its runtime behind that one loader.
2. **Prebuilt binaries:** build the addon in CI for linux-x64, linux-arm64, darwin-x64, darwin-arm64, win32-x64 and win32-arm64 with `prebuildify`, so `npm install` doesn't need a compiler. N-API is ABI-stable, so one binary per platform covers every Node version.
3. **Show what was picked:** the server already logs the device at startup. Add `GET /device` so the page can show "running on: NVIDIA RTX 4060 (OpenCL 3.0)" or "CPU (pocl)".

## Phase 2: GPUs in Docker

The current image uses pocl so it runs anywhere. Add image variants that use the host's GPU on Linux, picked with Docker Compose profiles:

| Variant | Image contents | Run with |
|---|---|---|
| `cpu` (default) | pocl | nothing extra (works on macOS and Windows hosts too) |
| `nvidia` | OpenCL ICD loader only; the driver comes from the host | NVIDIA Container Toolkit, `gpus: all`. Its default `compute` capability mounts the host's OpenCL library and ICD file ([NVIDIA docs](https://docs.nvidia.com/datacenter/cloud-native/container-toolkit/1.20.1/docker-specialized.html)) |
| `intel` | `intel-opencl-icd` | `devices: [/dev/dri]` |
| `amd` | ROCm OpenCL runtime, or Mesa Rusticl | `devices: [/dev/kfd, /dev/dri]` |

Each variant keeps pocl as a fallback (the default `OMNIFILTER_DEVICE=auto` prefers the GPU and falls back to it), and the startup log warns when no GPU is visible, the most common container mistake.

## Phase 3: a second backend, WebGPU

OpenCL's future is uneven. Apple has deprecated it, and NVIDIA doesn't offer it under WSL2. A second backend makes Omnifilter independent of any one vendor's OpenCL.

**Why WebGPU rather than Metal, CUDA or Vulkan directly.** One WebGPU port runs on Metal (Apple), Vulkan (Linux, Android) and Direct3D 12 (Windows), and the same shader code runs in the browser (Phase 4). Writing Metal, CUDA and Vulkan backends separately would mean three ports of the 56 kernels.

**Done (October 2026), as an opt-in: `OMNIFILTER_BACKEND=webgpu`.** Phase 4 had already written the kernels in WGSL, so the server now runs them too (Slang, the trial this plan first suggested, wasn't needed):

* **One copy of the WebGPU code.** The WGSL kernels and the plan engine moved to `server/lib/webgpu/` as plain JavaScript (with `.d.ts` types); the browser bundles them, the way it already bundled the filter definitions, and adds only drawing and camera frames (`client/src/gpu/engine.ts`).
* **A backend switch** in `gpu_filters.js`: `OMNIFILTER_BACKEND=opencl` (the default) or `webgpu`. Everything above it (working sizes, fitting plans to the device, stacks, the job queue) is shared. `OMNIFILTER_DEVICE` picks `auto`, `gpu`, `low-power` or `cpu` (a software adapter); `auto` falls back to a software adapter when there's no GPU.
* **Dawn in its own process** (`webgpu/worker.js`): Dawn's Node bindings, the [`webgpu`](https://www.npmjs.com/package/webgpu) npm package, are still a 0.x release, so a crash there fails the filters it was running and restarts, rather than taking the server down. Pixels and plans go to it as structured clones (a copy each way, a few milliseconds for a phone photo).
* **Bands**, as with OpenCL: kernels the plans run in bands of rows (`bilateral`, `median`, the Kuwaharas, `motion_blur`, `convolve`) are submitted a band at a time, so one dispatch over a 50 MP photo can't trip the OS's GPU watchdog. (Unlike the addon, band heights are fixed, not tuned from timing.)
* **Not a dependency.** The package is about 140 MB with binaries for every platform, and only some servers want it: `npm install webgpu` adds it. Its macOS binary needs macOS 26 (`webgpu@0.2` runs on older macOS, which is how it was developed on macOS 12).

**How it's tested:** `server/test/webgpu_test.js` runs every filter (with each of its choices), every preset, every blend mode and two images tall enough for several bands with both backends and compares them pixel by pixel; CI does this on Mesa's lavapipe (Vulkan on the CPU) against pocl, then runs `npm run check-device` and the whole server suite with `OMNIFILTER_BACKEND=webgpu`. On the Iris 6100 (Dawn on Metal) against its OpenCL, the results match as closely as the browser's do.

**Limits to know about:**
* WebGPU doesn't report how much memory a GPU has. Plans are fitted to four times the largest buffer it allows; set `OMNIFILTER_GPU_MEMORY_MB` for the real figure. A plan that still runs out of memory fails that request with a 400, as a too-large image does on OpenCL.
* Neural styles still run on ONNX Runtime (Phase 5).

**Still to do:** a Docker image with Vulkan (Mesa for AMD and Intel GPUs; NVIDIA's container toolkit for NVIDIA), timed band heights, and trying it on Apple Silicon (macOS 26), Windows on Arm and WSL2, where it should be most useful. Make it the default where OpenCL is missing once it has run for a while.

**Cheaper alternatives, still worth knowing:**
* **clvk**, a conformant OpenCL 3.0 built on Vulkan ([Vulkan docs](https://docs.vulkan.org/tutorial/latest/Advanced_Vulkan_Compute/05_OpenCL_on_Vulkan/01_introduction.html)), gives OpenCL on machines that only have Vulkan drivers without changing any Omnifilter code. Users install it as an OpenCL driver. Running it on macOS through MoltenVK is unproven.
* **Rusticl on Zink** (Mesa) is another OpenCL-over-Vulkan route, and OpenCL 3.1 conformant on some drivers. Whether it works on NVIDIA's own Vulkan driver is untested.
* **pocl's own GPU drivers** (CUDA, Level Zero, Vulkan) are less mature, but worth a test on NVIDIA under WSL2.

**Considered and not chosen (October 2026):** Halide (excellent for image pipelines, but a rewrite into ahead-of-time C++ pipelines), SYCL via AdaptiveCpp or DPC++ (heavy toolchain aimed at HPC; Apple support only emerging), CubeCL (Rust, pre-1.0), Kompute or raw Vulkan (WebGPU already runs on Vulkan with far less code), and separate CUDA or Metal ports (Slang can generate those later if needed).

## Phase 4: the GPU in the browser

**Started (October 2026), ahead of Phase 3.** The page runs the server's filter plans on the viewer's own GPU through WebGPU, for a live preview. WebGPU is in Chrome/Edge, in Safari 26 (iOS and macOS), in Chrome on most Android phones (not yet Samsung's Exynos GPUs), and in Firefox on Windows and Apple Silicon Macs. Elsewhere the page works as before, with the server doing everything ([status summary](https://svilenkovic.com/3d/webgpu-adoption-2026)).

What's done, in `client/src/gpu/` (plain TypeScript, no Angular) and `server/lib/webgpu/` (the parts the server's WebGPU backend shares, Phase 3):

* **WGSL versions of all 56 kernels** (`server/lib/webgpu/kernels/`), one per OpenCL kernel and under the same name. Each is declared once with its argument list in the OpenCL order, and `kernel.js` generates its bindings, a uniform struct for the scalars and the `GUARD` macros, so the bodies read like the OpenCL ones. Images (`image2d_t`) are plain buffers with nearest and bilinear helpers, so no textures or samplers are needed; work-group kernels (histograms, scans) use workgroup memory and atomics. Rounding to bytes matches `convert_uchar4_sat_rte`.
* **A plan engine** (`server/lib/webgpu/engine.js`, which `client/src/gpu/engine.ts` extends with drawing and camera frames) for the format `native/omnifilter.cpp` runs: buffers, passes, `buf`/`img`/`img3d`/`data`/`int`/`float` arguments, global sizes.
* **The same plans as the server.** The client bundles `server/lib/filters` (every module except the neural styles and `.cube` loading, which `lut_files.js` and `cube_looks.js` keep server-side), so the preview runs exactly the server's kernels, weights and sizes. Filters with a working size run at the size the server would use for the full photo.
* **Stacks** (`stack.ts`) with blending, keeping each layer's result so a change reruns only from that layer.
* **The editor:** the photo shows the stack applied live; hold to compare with the original; preset looks show as thumbnails of the photo; the status line says how long an update took.
* **Live camera:** the stack runs on every camera frame (copied to the GPU with `copyExternalImageToTexture` and scaled there, about 960 px), and the shutter takes the unfiltered frame as the photo, for the server to filter at full size. On the Iris 6100, light stacks run at 15 to 30 ms a frame and Comic book at about 65 ms (painterly filters run at the frame's size here, not the server's working size).

**How close the results are:** `e2e/gpu.spec.js` runs every filter (with each of its choices), every preset and every blend mode both ways and compares them pixel by pixel. On an Intel Iris 6100 (WebGPU on Metal) against the same GPU's OpenCL, nearly everything is identical or a level apart; a handful of pixels differ in Kuwahara and oil paint (near ties between regions), and reaction-diffusion drifts slightly (thousands of steps of a chaotic simulation).

**Speed** (1024 px preview, Intel Iris 6100 from 2015): colour and blur filters and light stacks update in about 15 to 40 ms; the painterly presets (Comic book, Oil on canvas) take 200 to 300 ms, as they run at the server's working size (up to 2000 px). Phone numbers are still to be measured on real devices.

Still to do:

* **Measure on phones** (an iPhone on iOS 26, a Pixel), and pick the preview size per device.

### WebGL2, for browsers without WebGPU

**Done (October 2026).** Browsers without WebGPU (iOS before 26, Android phones whose GPU Chrome blocks, Firefox on Linux and Intel Macs) run the same plans with WebGL2, which nearly every browser has: the live preview, the live camera, the preset thumbnails and full-size filtering in a Web Worker (on an `OffscreenCanvas`). The page picks WebGPU when it can and loads the WebGL2 engine (a 13 kB chunk) only when it can't. In `client/src/gpu/webgl2/`:

* **The same WGSL kernels, translated.** WebGL2 has no compute shaders, so each kernel runs as a fragment shader that draws its output buffer, one fragment per four elements. That works for every kernel that writes only its own element, which is 50 of the 57. `wgsl.ts` translates them to GLSL ES 3.00 when they're first used: it works out every expression's type the way WGSL does (GLSL has no type inference or implicit conversions), maps the built-ins (`round` is `roundEven`, `select` is `mix` or `?:`), and turns buffer reads into texture fetches and the one write into the fragment's result. It refuses a kernel that writes any other element, so a new kernel can't be quietly wrong. There's no second copy of any kernel to keep in step.
* **Buffers as textures** (RGBA32UI, four 32-bit words a texel, 4096 texels a row) holding the same bytes as WebGPU's buffers, so a buffer reads as pixels, floats or ints just as the WGSL reads it.
* **The other seven on the CPU** (`cpu-kernels.ts`): the histograms (WGSL's atomics), their prefix sums (work-group memory) and planting Voronoi seeds. They read the image back, which costs more than the arithmetic, but only Equalize, Auto levels, CLAHE and Stained glass use them.
* **One fix the translation adds:** GLSL compilers may rearrange float maths, so a value WGSL works out as exactly 0 can come out a hair below it, and its square root is NaN. Square roots take `max(x, 0)` first (Halftone needed it).

**How it's tested:** `e2e/gpu.spec.js` runs its comparisons twice, with WebGPU and with WebGL2 (`OMNIFILTER_FORCE_WEBGL2` makes the page and its worker use WebGL2), with the same tolerances. On the Iris 6100 every filter, preset and blend mode passes on both. The live preview, camera and cloud-mode tests run on WebGL2 as well, and unit tests check the translation and the CPU kernels.

## Phase 5: neural styles on the GPU

The ONNX styles currently run on the CPU. ONNX Runtime has GPU "execution providers": CUDA (NVIDIA), DirectML (Windows), CoreML (Apple) and WebGPU ([ONNX Runtime docs](https://onnxruntime.ai/docs/execution-providers/)). Which ones the `onnxruntime-node` npm package ships differs by version and platform, and we're pinned to 1.19.2 for macOS 12, so the first step is to check what's actually in the package. Then add `OMNIFILTER_ORT_PROVIDERS` (e.g. `cuda,cpu`) with automatic fallback to the CPU, and log which provider loaded.

## Testing matrix

| Where | What it proves | Cost |
|---|---|---|
| GitHub Actions, Linux: pocl + Rusticl/llvmpipe | Kernels are portable across two OpenCL compilers; Docker image builds | Free, every push |
| GitHub Actions, macOS (Apple Silicon) | Builds and runs on Apple's OpenCL, if the runner VM exposes a GPU; otherwise the CPU device | Free; check first whether OpenCL works in the runner |
| GitHub Actions, Windows | Builds with the Khronos loader; tests run on WARP or are skipped | Free |
| Cloud GPU spot instance, run by hand before releases | NVIDIA path, `nvidia` Docker image | A few dollars per run |
| Any real hardware to hand (an AMD or Intel Linux box, an Apple Silicon Mac, a Mali board) | Vendor-driver quirks | Free, ad hoc |

## Suggested order

1. **Phase 0.** A few days. It fixes known bugs (the work-group size, the 16384 cap) and makes every later step safer.
2. **Phases 1 and 2.** About a week together. Windows, prebuilt binaries and GPU Docker images cover most real hardware with the existing kernels.
3. **Phase 3.** Done as an opt-in (see above), reusing Phase 4's kernels; next, a Vulkan Docker image and real hardware beyond the Iris.
4. **Phase 4.** Started first after all (see above): the WGSL kernels it needed are written, and Phase 3 can reuse them.
5. **Phase 5.** Independent of the others; can happen whenever.
