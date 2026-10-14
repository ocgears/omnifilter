# omnifilter        [![test](https://github.com/AaronFilson/omnifilter/actions/workflows/test.yml/badge.svg)](https://github.com/AaronFilson/omnifilter/actions/workflows/test.yml)
###### An image processing library designed on the theory of parallel processing to apply filters to photos extremely quickly and efficiently.

## Contents
+   [Overview](https://github.com/AaronFilson/omnifilter#overview)
+   [Usage](https://github.com/AaronFilson/omnifilter#usage)
+   [Filters](https://github.com/AaronFilson/omnifilter#filters)
+   [How the GPU part works](https://github.com/AaronFilson/omnifilter#how-the-gpu-part-works)
+   [Neural style transfer](https://github.com/AaronFilson/omnifilter#neural-style-transfer)
+   [Authors](https://github.com/AaronFilson/omnifilter#authors)
+   [License](https://github.com/AaronFilson/omnifilter#license)

# Overview
The Omnifilter app is designed to enable the work of filtering images provided by a user on a multitude of server environments. As node.js is fantastic for making web apps, OpenCL is a way to harness the fantastic power of GPUs and multi-core CPUs. It runs on macOS out of the box, and on Linux with an OpenCL driver installed.

Our application is still under development, thank you for your patience.

# Usage

### Requirements
* Node.js 20.9 or newer for the API server, and 22.22 or newer (or 24.15+) to build the web client, which uses Angular 22
* MongoDB (`brew install mongodb-community`, or any MongoDB 4.2+ server)
* An OpenCL runtime:
  * **macOS:** built in, nothing to install. (Apple has deprecated OpenCL in favour of Metal, but it still works on current macOS, Intel and Apple Silicon.)
  * **Linux:** the ICD loader (`apt install ocl-icd-libopencl1`), plus a driver for your device: your GPU vendor's, Mesa's Rusticl (`mesa-opencl-icd`), or `pocl-opencl-icd` to run on the CPU.
  * **Windows:** comes with the NVIDIA, AMD and Intel GPU drivers.

`npm install` installs the native GPU addon. When the [prebuilds workflow](.github/workflows/prebuilds.yml) has published a binary for your platform built from the same source (Linux, macOS and Windows, x64 and arm64), it downloads that, checks its SHA-256 and that it loads. Otherwise it compiles the addon, which needs:
* A C++ compiler: on macOS `xcode-select --install`; on Linux `build-essential`; on Windows the "Desktop development with C++" workload of Visual Studio or its Build Tools.
* The OpenCL headers and loader library: built into macOS; on Linux `apt install ocl-icd-opencl-dev`; on Windows, set `OPENCL_SDK` to a folder with `include/CL/cl.h` and `lib/OpenCL.lib`, such as the unzipped [Khronos OpenCL-SDK](https://github.com/KhronosGroup/OpenCL-SDK/releases) for x64, or vcpkg's `installed\<triplet>` folder after `vcpkg install opencl:x64-windows` (or `arm64-windows`).

Set `OMNIFILTER_BUILD_FROM_SOURCE=1` (or `true`/`yes`) to always compile, or `OMNIFILTER_PREBUILD_URL` to download prebuilt binaries from somewhere else.

### Running locally
```
npm install      # also installs the native GPU addon (downloaded or compiled)
npm run build    # builds the Angular client into dist/ (`npm run build:prod` for a minified one)
npm start        # starts MongoDB (data in ./db), the client on :5000 and the API on :3000
```
The web client is in `client/`, an Angular 22 app with its own `package.json`; `npm run build` installs its packages the first time. It's built for phones first and works on any screen size: pick or take a photo (or drop or paste one on a computer), choose a preset look or stack filters, and save or share the results. Where the browser has WebGPU (Chrome, Edge, Safari 26 on iPhone and Mac, Chrome on most Android phones), the photo shows the filters applied live on the device's own GPU as you change them, and the live camera shows them on every frame, running the same filter plans as the server (see [docs/GPU_SUPPORT.md](docs/GPU_SUPPORT.md#phase-4-the-gpu-in-the-browser)); Transform still makes the full-size result on the server. While working on the client, `cd client && npx ng serve` serves it on http://localhost:4200 and rebuilds on every change; start the API with `CORS_ORIGINS=http://localhost:4200 node server/server.js`. On macOS 12 and 13, set `NG_BUILD_SASS_EMBEDDED=0` for `ng` commands (the build scripts do this for you): Angular's default Sass compiler needs macOS 14.
Optionally, `npm run fetch-models` downloads the neural style transfer models (about 34 MB); see [Neural style transfer](#neural-style-transfer).
Then open http://localhost:5000. On startup the API server logs which device the filters will run on, e.g.
`Filters will run on GPU: Intel(R) Iris(TM) Graphics 6100 (OpenCL 1.2, 48 compute units)`.

`npm run devices` lists the OpenCL devices on the machine and which one the filters use. By default that's the best GPU (a discrete one before an integrated one), falling back to any other device, such as the CPU, if there's no GPU or its driver can't compile the kernels. Set `OMNIFILTER_DEVICE=cpu` to run the same kernels on the CPU instead (handy for comparing speed). The page shows which device the filters run on.

`npm run check-device` runs every filter on the chosen device and reports which work, fail or crash, carrying on after a crash, and exits with an error if anything failed; it's the first thing to try on a new GPU or driver.

### Configuration
| Variable | What it does |
|---|---|
| `APP_SECRET` | The key that signs login tokens; set it to a long random string (`openssl rand -hex 32`). Without it the server generates a random key at startup, so everyone is signed out when it restarts. Logins last 7 days, and changing a password signs out other sessions. |
| `OMNIFILTER_MAX_PIXELS` | Largest image accepted, in pixels (default 50 million). Images are also limited to 16384 pixels per side. The limits are checked from the file header, so a small file that would decode to gigabytes is refused before it's decoded. |
| `OMNIFILTER_DEVICE` | Which OpenCL device to use: `auto` or `any` (default: the best GPU, else any device), `gpu`, `cpu`, `accelerator`, a device number from `npm run devices`, or part of a device's name, e.g. `RTX`, `pocl` or `3060` (a number that isn't a device number is matched against names). If no device can be set up, the server tries again after 5 minutes. |
| `OMNIFILTER_BAND_MS` | Target time for each band of a heavy kernel, in milliseconds (default 100). Bands keep a GPU that also drives the display from being reset by the OS; see [How the GPU part works](#how-the-gpu-part-works). |
| `OMNIFILTER_CL_OPTIONS` | Extra OpenCL compiler options for the kernels. |
| `OMNIFILTER_PROFILE` | Set to `1` to log how long every pass took on the device. |
| `OMNIFILTER_MODELS` | Folder holding the neural style models (default `models/`). |
| `MONGOLAB_URI` | MongoDB connection string (default `mongodb://localhost/omnifilter_app_dev`). |
| `PORT` | The API's port (default 3000). |
| `HOSTURL`, `CLIENTPORT` | Where the client is served (default `http://localhost:` and 5000); the API accepts browser requests from that address. |
| `CORS_ORIGINS` | Comma-separated list of web addresses allowed to call the API from a browser, replacing the one above, e.g. `https://photos.example,http://localhost:5000`. Not needed when the API serves the built client itself (it does whenever `dist/` exists). |
| `AUTH_RATE_PER_MINUTE`, `AUTH_RATE_BURST` | Sign-ins and sign-ups allowed per client IP address: a burst of 5, then 10 a minute by default. |
| `OMNIFILTER_API` | At client build time: the API's address, if it isn't port 3000 of the page's host (`/` for the same address as the page). |

Emails are unique (case-insensitive). Older databases may hold mixed-case emails: those accounts can still sign in, and `node scripts/migrate-emails.js` (`--dry-run` to only look) lowercases them all and lists any two accounts that share an email. MongoDB can't build the unique index until such duplicates are removed; the server logs a warning when that happens.

To keep one client from swamping the server, a couple of photos are processed at once, at most 8 more wait (after that the API answers 503), and each user can have one photo in progress (429). Requests whose client goes away leave the queue. Deleting an account needs its current password. Filtered photos are stored as JPEG or PNG, or as a smaller JPEG/WebP when a PNG would be too big for the database.

### Running with Docker
```
docker compose up --build
```
Then open http://localhost:5000. This starts MongoDB, the API and the client in containers. The ports are only reachable from this computer.

Containers can't reach the GPU on macOS or Windows, so the image uses [pocl](https://portablecl.org/), an OpenCL driver that runs the same kernels on the container's CPU. The filters work, just without the GPU speedup.

Any Docker runtime works (Docker Desktop, OrbStack, [Colima](https://github.com/abiosoft/colima)). On macOS 12, which current Docker Desktop no longer supports, use Colima with QEMU: `brew install colima docker docker-compose docker-buildx`, then `colima start --memory 4`. Colima needs QEMU on macOS 12, but Homebrew's QEMU (10 and later) needs Xcode 15, which macOS 12 can't run, so install QEMU 9.1 instead.

### Tests
```
npm test             # server tests (mocha), starts MongoDB from ./db if it isn't running
npm run test:client  # web client unit tests (Vitest, in jsdom)
npm run test:e2e     # the whole app in a browser (Playwright), desktop and phone sized: sign up, filter photos, presets, delete, sign out
```
The end-to-end tests run twice, as a desktop browser and as a phone (Pixel 7 size, touch), and check that the page never scrolls sideways and the Transform button stays on screen. `e2e/gpu.spec.js` also runs every filter, preset and blend mode both with the server's OpenCL code and with the browser's WebGPU code and compares the results pixel by pixel (on Linux, Chromium uses SwiftShader, its software GPU). They build the client, start the API on port 3930 serving it, and use the `omnifilter_e2e` database, which they empty first. Install the browser once with `npx playwright install chromium`; on macOS 12, which Playwright's Chromium doesn't support, they use the installed Google Chrome instead.
The GPU tests compare every filter's output against a plain JavaScript implementation of the same convolution, pixel by pixel.

# Filters

55 filters, all running on the GPU except the neural styles. Pick one in the web page and adjust its settings; `GET /filters` lists them with their parameters.

| Group | Filters | What's interesting on the GPU |
|---|---|---|
| Blur & sharpen | Gaussian, box, motion blur, sharpen, unsharp mask, tilt-shift | Separable convolution (two 1D passes); motion blur samples a texture at any angle |
| Edges & relief | Emboss, Laplacian edges, Sobel (with "neon" direction colouring), pencil sketch | Small convolutions with bias / absolute value; sketch is a colour-dodge blend of two pipelines |
| Colour | Greyscale, sepia, invert, saturation, hue rotate, brightness/contrast, channel swap, vintage, gamma, threshold, posterize, solarize, duotone | One 4x5 colour-matrix kernel covers most of these |
| Looks | Teal & orange, warm film, bleach bypass, cross process, faded matte, vignette, plus any `.cube` LUT in `server/luts/` | 3D lookup tables in a 3D texture, interpolated by the texture hardware |
| Stylize | Bilateral smoothing, cartoon, Kuwahara, oil paint (anisotropic Kuwahara), median, crosshatch | Heavy per-pixel maths; median uses a radix select instead of sorting |
| Retro | Pixelate, ordered dither (incl. Game Boy palette), CMYK halftone, ASCII art | Bayer dithering is GPU-friendly where Floyd-Steinberg isn't |
| Distort | Swirl, pinch/bulge, fisheye, ripple, lens distortion, chromatic aberration | Texture sampling with hardware bilinear interpolation |
| Auto adjust | Auto levels/colour, histogram equalization, CLAHE (local contrast) | Atomic histograms in local memory, parallel reduction and prefix sum |
| Generative | Stained glass, reaction-diffusion | Jump Flooding Algorithm for Voronoi cells; thousands of simulation steps |
| Neural style | Mosaic, Candy, Rain princess, Udnie, Pointillism | Pretrained networks run with ONNX Runtime (see below) |

To add your own colour grade, drop a `.cube` file (exported from Lightroom, DaVinci Resolve, etc.) into `server/luts/` and restart the server.

### Stacking filters

Filters can be stacked, up to 8 at a time, like adjustment layers in a photo editor. Each one is applied to the result of the ones above it, then laid over that result with a **strength** (0-100%) and a **blend mode**: normal, multiply, screen, overlay, soft light, darken, lighten, difference, colour or luminosity. The blend modes use the [W3C compositing formulas](https://www.w3.org/TR/compositing-1/) (the same as CSS and most photo editors) and run on the GPU (`native/kernels/blend.cl`).

Some combinations that work well, all available as preset looks in the page (`GET /presets`, defined in `server/lib/stack.js`):

| Preset | Stack |
|---|---|
| Comic book | bilateral smoothing, posterize, Sobel "ink" edges *multiplied* on top, a CMYK halftone *multiplied* at 35% |
| Dreamy glow | brightness/contrast, then blurred copies *screened* and *soft-lit* over the sharp image (the Orton effect) |
| Coloured pencil | colour sketch with a graphite sketch *multiplied* over it |
| Oil on canvas | oil paint, then an emboss *overlaid* for brush relief |
| Neon night | darkened photo with neon Sobel edges *screened* on top |
| Risograph | sunset duotone with a mono halftone *soft-lit* over it |
| Gritty detail | CLAHE, unsharp mask, bleach bypass at 70% |
| Toy camera | tilt-shift, cross process at 60%, heavy vignette |

Through the API, send `stack` instead of `tOption` and `params`:
```
POST /newcontent
{ "content": "data:image/jpeg;base64,...",
  "stack": [ { "tOption": "sepia" },
             { "tOption": "vignette", "params": { "strength": 80 }, "blend": "multiply", "amount": 60 } ] }
```
The saved photo records the layers in `tStack`.

Transparent images keep their transparency through every filter and blend: filters work on colours weighted by opacity, so the hidden colour of invisible pixels never bleeds into visible ones. A blended layer fades between the image below and the blended result, so a half-transparent photo stays half-transparent however many layers it has.

# How the GPU part works

```
browser --(base64 image)--> server/routes/content_routes.js
          server/lib/image_codec.js        decode to raw RGBA pixels (sharp)
          server/lib/gpu_filters.js        look up the filter, validate its parameters
          server/lib/filters/*.js          describe the filter as a "plan": buffers + kernel passes
          native/omnifilter.cpp            C++ addon: runs the plan on the GPU
          native/kernels/*.cl              OpenCL kernels, one GPU thread per pixel
```

* **Node to C++** uses [N-API](https://nodejs.org/api/n-api.html) through [node-addon-api](https://github.com/nodejs/node-addon-api). N-API is ABI-stable, so the addon doesn't break when Node or V8 changes. `binding.gyp` tells node-gyp how to compile it and link OpenCL.
* **C++ to GPU** uses [OpenCL 1.2](https://registry.khronos.org/OpenCL/specs/opencl-1.2.pdf). At startup the addon picks a GPU and compiles every kernel in `native/kernels/` once. A filter is a *plan*: named device buffers plus a list of kernel passes and their arguments (buffers, scalars, small arrays, or buffers presented as 2D/3D images so kernels can use texture sampling). The whole pipeline runs on the device and only the final image is copied back.
* Plans run on a worker thread (`Napi::AsyncWorker`) and return a Promise, so the server keeps handling requests while the GPU works. Plans are queued in JavaScript and run one at a time, so waiting ones don't tie up Node's worker threads.
* **Adding a filter** usually means writing a kernel (if none of the existing ones fit) and a short definition in `server/lib/filters/`; the UI builds its controls from the definition's parameters. See `blur.js` for simple examples and `generative.js` for multi-pass ones.
* **The GPU watchdog.** On a GPU that also drives the display, macOS kills any single GPU job that runs for more than a few seconds, sometimes silently leaving the output half-processed. Heavy kernels therefore run in bands of rows (`band` in the plan), each a separate short job. The first band is small, and each later band is sized from how long the last one took, aiming at about 100 ms, so bands stay short on a slow laptop GPU and grow to the whole image on a fast one. Painterly filters also run at a reduced working size and are scaled back up.
* **Fitting the device.** The addon reads each device's limits (work-group sizes, largest buffer, largest texture, memory) and adapts: work-group sizes shrink to what the device allows, and a filter whose buffers or textures wouldn't fit runs on a scaled-down copy of the image. Filters that need textures are hidden on a device without image support.
* **Profiling.** Set `OMNIFILTER_PROFILE=1` to print how long every pass took on the device (OpenCL profiling events).

So far it has been tested on Intel integrated graphics on macOS and on the CPU (pocl). [docs/GPU_SUPPORT.md](docs/GPU_SUPPORT.md) is the plan for other GPUs, operating systems, Docker GPU access and a WebGPU backend.

On a 2015 MacBook Pro (Intel Iris 6100), a 12 megapixel blur takes about 0.85s on the GPU versus 6.2s for the same OpenCL kernel on the CPU. Most filters take 100-600 ms on a 10 megapixel photo, much of that copying the image to and from the GPU.

# Neural style transfer

The "Neural style" filters repaint a photo in the style of an artwork using small pretrained networks ([fast neural style](https://github.com/onnx/models/tree/main/validated/vision/style_transfer/fast_neural_style), Johnson et al. 2016) from the ONNX model zoo.

* **ONNX** is an open file format for trained neural networks: the layers and their learned weights, independent of the framework (PyTorch, TensorFlow, ...) that trained them.
* **[ONNX Runtime](https://onnxruntime.ai/)** is Microsoft's open-source engine for running ONNX models fast on CPUs and GPUs. The Node bindings are the `onnxruntime-node` package.

To enable them, run `npm run fetch-models` (downloads and checksum-verifies five 6.7 MB models into `models/`). `onnxruntime-node` is an optional dependency, pinned to 1.19.2 because later releases no longer support macOS 12 / Intel Macs. The published models only accept 224x224 images, so `server/lib/onnx_dynamic.js` rewrites that size declaration in the model file at load time; the network itself works at any size.

### Authors
Aaron Filson [Github](https://github.com/aaronfilson)<br/>
Stephen Salzer [Github](https://github.com/scoobahsteve)</br>
Rob Merrill [Github](https://github.com/robgmerrill)</br>
Erika Hokanson [Github](https://github.com/erikawho)<br>
Gene Troy [Github](https://github.com/energene)<br/>

## License

This project is licensed under the terms of the MIT license. (view file titled [LICENSE](https://github.com/AaronFilson/omnifilter/blob/master/LICENSE))
