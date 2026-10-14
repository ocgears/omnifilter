// Native bridge between Node and the GPU, using OpenCL for the compute work and
// N-API (via node-addon-api) for the JavaScript bindings. N-API is ABI-stable,
// so this addon keeps working across Node versions without code changes.
//
// JS API (wrapped by server/lib/gpu_filters.js, which also picks the device):
//   devices()                       -> every OpenCL device on every platform:
//                                      [{ index, platform, name, type, limits... }]
//   init(kernelSource, deviceIndex, buildOptions?)
//                                   build every kernel in the source for one
//                                   device (an index from devices()), with
//                                   optional OpenCL compiler options
//   deviceInfo()                    -> the chosen device, as in devices()
//   kernels()                       -> names of the compiled kernels
//   filter(rgba, width, height, plan) -> Promise<Buffer>
//
// A plan describes a pipeline that runs entirely on the device:
//   {
//     buffers: [{ name, bytes, init?: TypedArray, zero?: bool }, ...],
//     passes:  [{ kernel, args: [...], global?: [x, y?], local?: [x, y?], band?: rows }, ...],
//     output:  'bufferName'     // must hold width * height * 4 bytes (RGBA)
//   }
// The input image is always available as the buffer 'src'. Kernel arguments:
//   { buf: name }                          a buffer
//   { img: name, width?, height?, format? } a buffer copied into a 2D image
//        (texture), so the kernel can use hardware bilinear sampling;
//        format is 'rgba8' (default) or 'rgba32f'
//   { img3d: name, size }                  a buffer of size^3 RGBA floats copied
//                                          into a 3D image (e.g. a colour LUT)
//   { int: n } / { float: x }              scalars
//   { data: TypedArray }                   a small read-only array (weights...)
// The global size defaults to [width, height]. A plan's local size is the
// work-group size it would like: the addon shrinks it to what the device and
// kernel allow, keeping the number of work-groups, so kernels must work with
// smaller groups than they ask for.
//
// With band set, a 2D pass is launched in bands of rows, waiting for each to
// finish: GPUs that also drive a display are reset by the OS if one job runs
// for more than a few seconds, so heavy kernels on big images run as several
// short jobs. The first band has at most `band` rows; each later band is sized
// from how long the one before took, aiming at OMNIFILTER_BAND_MS (default
// 100) milliseconds, so bands stay short on a slow laptop GPU and grow to the
// whole image on a fast one. A banded kernel's last argument must be an int
// `row0`, which the addon sets to each band's first row.
//
// Set OMNIFILTER_PROFILE=1 to print how long each pass (and band) took on the
// device, measured with OpenCL profiling events.

#define CL_TARGET_OPENCL_VERSION 120
#ifdef __APPLE__
#define CL_SILENCE_DEPRECATION
#include <OpenCL/opencl.h>
#else
#include <CL/cl.h>
#endif

#include <napi.h>

#include <algorithm>
#include <chrono>
#include <cmath>
#include <cstdint>
#include <cstdio>
#include <cstdlib>
#include <map>
#include <mutex>
#include <stdexcept>
#include <string>
#include <utility>
#include <vector>

namespace {

enum class ArgKind { Buffer, Image, Image3D, Int, Float, Data };

struct Arg {
  ArgKind kind;
  std::string name;
  cl_int i = 0;
  cl_float f = 0;
  std::vector<uint8_t> data;
  size_t width = 0, height = 0, depth = 0;
  bool floatFormat = false;
};

struct Pass {
  std::string kernel;
  std::vector<Arg> args;
  cl_uint dims = 2;
  size_t global[2] = {0, 0};
  size_t local[2] = {0, 0};
  bool hasGlobal = false;
  bool hasLocal = false;
  size_t band = 0;
};

struct BufferSpec {
  std::string name;
  size_t bytes;
  std::vector<uint8_t> init;
  bool zero = false;
};

struct Plan {
  std::vector<BufferSpec> buffers;
  std::vector<Pass> passes;
  std::string output;
};

void Check(cl_int err, const std::string& what) {
  if (err != CL_SUCCESS) {
    throw std::runtime_error(what + " failed (OpenCL error " + std::to_string(err) + ")");
  }
}

std::string DeviceString(cl_device_id device, cl_device_info param) {
  size_t size = 0;
  Check(clGetDeviceInfo(device, param, 0, nullptr, &size), "clGetDeviceInfo");
  std::string value(size, '\0');
  Check(clGetDeviceInfo(device, param, size, &value[0], nullptr), "clGetDeviceInfo");
  while (!value.empty() && value.back() == '\0') value.pop_back();
  return value;
}

template <typename T>
T DeviceValue(cl_device_id device, cl_device_info param) {
  T value{};
  Check(clGetDeviceInfo(device, param, sizeof(T), &value, nullptr), "clGetDeviceInfo");
  return value;
}

std::string PlatformString(cl_platform_id platform, cl_platform_info param) {
  size_t size = 0;
  Check(clGetPlatformInfo(platform, param, 0, nullptr, &size), "clGetPlatformInfo");
  std::string value(size, '\0');
  Check(clGetPlatformInfo(platform, param, size, &value[0], nullptr), "clGetPlatformInfo");
  while (!value.empty() && value.back() == '\0') value.pop_back();
  return value;
}

size_t RoundUp(size_t n, size_t multiple) {
  return (n + multiple - 1) / multiple * multiple;
}

const char* TypeName(cl_device_id device) {
  const cl_device_type type = DeviceValue<cl_device_type>(device, CL_DEVICE_TYPE);
  return (type & CL_DEVICE_TYPE_GPU) ? "gpu"
         : (type & CL_DEVICE_TYPE_CPU) ? "cpu"
         : (type & CL_DEVICE_TYPE_ACCELERATOR) ? "accelerator" : "other";
}

// The limits that decide how kernels can be launched on a device.
struct Limits {
  size_t maxItem[3] = {1, 1, 1};  // largest work-group in each dimension
  size_t maxGroup = 1;            // largest work-group in total
  cl_ulong maxAlloc = 0;          // largest single buffer
  bool imageSupport = false;
  size_t image2dMax[2] = {0, 0};
};

Limits ReadLimits(cl_device_id device) {
  Limits limits;
  const cl_uint dims = DeviceValue<cl_uint>(device, CL_DEVICE_MAX_WORK_ITEM_DIMENSIONS);
  std::vector<size_t> sizes(std::max<cl_uint>(dims, 3), 1);
  Check(clGetDeviceInfo(device, CL_DEVICE_MAX_WORK_ITEM_SIZES, dims * sizeof(size_t), sizes.data(), nullptr),
        "clGetDeviceInfo");
  for (int d = 0; d < 3; d++) limits.maxItem[d] = std::max<size_t>(1, sizes[d]);
  limits.maxGroup = std::max<size_t>(1, DeviceValue<size_t>(device, CL_DEVICE_MAX_WORK_GROUP_SIZE));
  limits.maxAlloc = DeviceValue<cl_ulong>(device, CL_DEVICE_MAX_MEM_ALLOC_SIZE);
  limits.imageSupport = DeviceValue<cl_bool>(device, CL_DEVICE_IMAGE_SUPPORT) == CL_TRUE;
  if (limits.imageSupport) {
    limits.image2dMax[0] = DeviceValue<size_t>(device, CL_DEVICE_IMAGE2D_MAX_WIDTH);
    limits.image2dMax[1] = DeviceValue<size_t>(device, CL_DEVICE_IMAGE2D_MAX_HEIGHT);
  }
  return limits;
}

// What the JS side needs to know about a device to choose one and to fit
// filters to it.
Napi::Object DescribeDevice(Napi::Env env, cl_platform_id platform, cl_device_id device) {
  const Limits limits = ReadLimits(device);
  Napi::Object info = Napi::Object::New(env);
  info.Set("platform", PlatformString(platform, CL_PLATFORM_NAME));
  info.Set("platformVendor", PlatformString(platform, CL_PLATFORM_VENDOR));
  info.Set("name", DeviceString(device, CL_DEVICE_NAME));
  info.Set("vendor", DeviceString(device, CL_DEVICE_VENDOR));
  info.Set("version", DeviceString(device, CL_DEVICE_VERSION));
  info.Set("driverVersion", DeviceString(device, CL_DRIVER_VERSION));
  info.Set("type", TypeName(device));
  // Deprecated after OpenCL 1.2 but still answered; false means a discrete GPU
  // with its own memory.
  cl_bool unified = CL_TRUE;
  if (clGetDeviceInfo(device, CL_DEVICE_HOST_UNIFIED_MEMORY, sizeof(unified), &unified, nullptr) == CL_SUCCESS) {
    info.Set("unifiedMemory", unified == CL_TRUE);
  }
  info.Set("available", DeviceValue<cl_bool>(device, CL_DEVICE_AVAILABLE) == CL_TRUE);
  info.Set("compilerAvailable", DeviceValue<cl_bool>(device, CL_DEVICE_COMPILER_AVAILABLE) == CL_TRUE);
  info.Set("computeUnits", DeviceValue<cl_uint>(device, CL_DEVICE_MAX_COMPUTE_UNITS));
  info.Set("globalMemBytes", static_cast<double>(DeviceValue<cl_ulong>(device, CL_DEVICE_GLOBAL_MEM_SIZE)));
  info.Set("maxAllocBytes", static_cast<double>(limits.maxAlloc));
  info.Set("localMemBytes", static_cast<double>(DeviceValue<cl_ulong>(device, CL_DEVICE_LOCAL_MEM_SIZE)));
  info.Set("maxWorkGroupSize", static_cast<double>(limits.maxGroup));
  Napi::Array items = Napi::Array::New(env, 3);
  for (uint32_t d = 0; d < 3; d++) items.Set(d, static_cast<double>(limits.maxItem[d]));
  info.Set("maxWorkItemSizes", items);
  info.Set("imageSupport", limits.imageSupport);
  if (limits.imageSupport) {
    info.Set("image2dMaxWidth", static_cast<double>(limits.image2dMax[0]));
    info.Set("image2dMaxHeight", static_cast<double>(limits.image2dMax[1]));
  }
  return info;
}

struct DeviceEntry {
  cl_platform_id platform;
  cl_device_id device;
};

// Every OpenCL device on every platform, in a stable order; devices() and
// init() refer to devices by their position in this list.
std::vector<DeviceEntry> AllDevices() {
  std::vector<DeviceEntry> all;
  cl_uint numPlatforms = 0;
  if (clGetPlatformIDs(0, nullptr, &numPlatforms) != CL_SUCCESS || numPlatforms == 0) return all;
  std::vector<cl_platform_id> platforms(numPlatforms);
  Check(clGetPlatformIDs(numPlatforms, platforms.data(), nullptr), "clGetPlatformIDs");
  for (cl_platform_id platform : platforms) {
    cl_uint count = 0;
    if (clGetDeviceIDs(platform, CL_DEVICE_TYPE_ALL, 0, nullptr, &count) != CL_SUCCESS || count == 0) continue;
    std::vector<cl_device_id> devices(count);
    Check(clGetDeviceIDs(platform, CL_DEVICE_TYPE_ALL, count, devices.data(), nullptr), "clGetDeviceIDs");
    for (cl_device_id device : devices) all.push_back({platform, device});
  }
  return all;
}

// Releases an OpenCL memory object when it goes out of scope, so an exception
// part way through a filter run can't leak device memory.
class MemGuard {
 public:
  explicit MemGuard(cl_mem mem = nullptr) : mem_(mem) {}
  ~MemGuard() { if (mem_) clReleaseMemObject(mem_); }
  MemGuard(MemGuard&& other) noexcept : mem_(other.mem_) { other.mem_ = nullptr; }
  MemGuard(const MemGuard&) = delete;
  MemGuard& operator=(const MemGuard&) = delete;
  cl_mem get() const { return mem_; }

 private:
  cl_mem mem_;
};

// Owns the OpenCL device, context, queue and compiled kernels. Setting these up
// (especially compiling the program) is expensive, so it happens once in init()
// and is reused by every filter() call.
class Gpu {
 public:
  static Gpu& Instance() {
    static Gpu gpu;
    return gpu;
  }

  void Init(const std::string& source, size_t index, const std::string& options) {
    std::lock_guard<std::mutex> lock(mutex_);
    Release();

    const std::vector<DeviceEntry> all = AllDevices();
    if (all.empty()) throw std::runtime_error("No OpenCL devices found; is an OpenCL driver installed?");
    if (index >= all.size()) throw std::runtime_error("There is no OpenCL device " + std::to_string(index));
    platform_ = all[index].platform;
    device_ = all[index].device;

    // Leave nothing half set up if any step fails (say the kernels don't
    // compile for this device), so the caller can try another device.
    try {
      Setup(source, options);
    } catch (...) {
      Release();
      throw;
    }
  }

  Napi::Array Devices(Napi::Env env) {
    const std::vector<DeviceEntry> all = AllDevices();
    Napi::Array list = Napi::Array::New(env, all.size());
    for (size_t i = 0; i < all.size(); i++) {
      Napi::Object info = DescribeDevice(env, all[i].platform, all[i].device);
      info.Set("index", static_cast<double>(i));
      list.Set(static_cast<uint32_t>(i), info);
    }
    return list;
  }

  Napi::Object Info(Napi::Env env) {
    std::lock_guard<std::mutex> lock(mutex_);
    RequireInit();
    return DescribeDevice(env, platform_, device_);
  }

  Napi::Array KernelNames(Napi::Env env) {
    std::lock_guard<std::mutex> lock(mutex_);
    RequireInit();
    Napi::Array names = Napi::Array::New(env, kernels_.size());
    uint32_t i = 0;
    for (const auto& entry : kernels_) names.Set(i++, entry.first);
    return names;
  }

  // Runs on a libuv worker thread (see FilterWorker), never on the JS thread.
  void Run(const uint8_t* in, uint8_t* out, cl_int width, cl_int height, const Plan& plan) {
    // OpenCL calls are thread safe, but clSetKernelArg on a shared kernel is
    // not, so serialise whole runs. The device can only do one at a time anyway.
    std::lock_guard<std::mutex> lock(mutex_);
    RequireInit();

    const size_t imageBytes = static_cast<size_t>(width) * height * 4;
    const cl_ulong maxAlloc = limits_.maxAlloc;
    cl_int err;

    std::map<std::string, MemGuard> buffers;
    std::map<std::string, size_t> sizes;
    auto create = [&](const std::string& name, size_t bytes, const void* init) {
      if (bytes == 0 || bytes > maxAlloc) {
        throw std::runtime_error("Buffer '" + name + "' (" + std::to_string(bytes) +
                                 " bytes) doesn't fit in the OpenCL device's memory");
      }
      cl_mem_flags flags = CL_MEM_READ_WRITE | (init ? CL_MEM_COPY_HOST_PTR : 0);
      cl_mem mem = clCreateBuffer(context_, flags, bytes, const_cast<void*>(init), &err);
      Check(err, "clCreateBuffer(" + name + ")");
      buffers.emplace(name, MemGuard(mem));
      sizes[name] = bytes;
    };

    create("src", imageBytes, in);
    for (const BufferSpec& spec : plan.buffers) {
      if (!spec.init.empty()) {
        create(spec.name, spec.bytes, spec.init.data());
      } else if (spec.zero) {
        std::vector<uint8_t> zeros(spec.bytes, 0);
        create(spec.name, spec.bytes, zeros.data());
      } else {
        create(spec.name, spec.bytes, nullptr);
      }
    }

    // Images are created on first use and refreshed from their buffer every
    // time a pass reads them, since earlier passes may have changed it.
    std::map<std::string, MemGuard> images;
    // Kept alive until the final blocking read, which guarantees every kernel
    // that uses them has finished.
    std::vector<MemGuard> temporaries;
    // With profiling on: (label, event) for every kernel launch.
    std::vector<std::pair<std::string, cl_event>> events;
    struct EventGuard {
      std::vector<std::pair<std::string, cl_event>>& list;
      ~EventGuard() { for (auto& e : list) clReleaseEvent(e.second); }
    } eventGuard{events};

    for (size_t p = 0; p < plan.passes.size(); p++) {
      const Pass& pass = plan.passes[p];
      auto found = kernels_.find(pass.kernel);
      if (found == kernels_.end()) throw std::runtime_error("Unknown kernel: " + pass.kernel);
      cl_kernel kernel = found->second;
      const std::string where = "pass " + std::to_string(p) + " (" + pass.kernel + ")";

      cl_uint expected = 0;
      Check(clGetKernelInfo(kernel, CL_KERNEL_NUM_ARGS, sizeof(expected), &expected, nullptr),
            "clGetKernelInfo");
      if (expected != pass.args.size()) {
        throw std::runtime_error(where + " expects " + std::to_string(expected) +
                                 " arguments but got " + std::to_string(pass.args.size()));
      }

      for (cl_uint a = 0; a < pass.args.size(); a++) {
        const Arg& arg = pass.args[a];
        const std::string argWhere = where + " argument " + std::to_string(a);
        switch (arg.kind) {
          case ArgKind::Buffer: {
            cl_mem mem = Lookup(buffers, arg.name, argWhere);
            Check(clSetKernelArg(kernel, a, sizeof(cl_mem), &mem), "clSetKernelArg(" + argWhere + ")");
            break;
          }
          case ArgKind::Image:
          case ArgKind::Image3D: {
            cl_mem buffer = Lookup(buffers, arg.name, argWhere);
            const bool is3d = arg.kind == ArgKind::Image3D;
            const size_t w = arg.width ? arg.width : width;
            const size_t h = arg.height ? arg.height : height;
            const size_t d = is3d ? arg.depth : 1;
            if (!limits_.imageSupport) {
              throw std::runtime_error(argWhere + ": this device has no image (texture) support");
            }
            if (!is3d && (w > limits_.image2dMax[0] || h > limits_.image2dMax[1])) {
              throw std::runtime_error(argWhere + ": a " + std::to_string(w) + "x" + std::to_string(h) +
                                       " image is larger than this device allows (" +
                                       std::to_string(limits_.image2dMax[0]) + "x" +
                                       std::to_string(limits_.image2dMax[1]) + ")");
            }
            const size_t pixelBytes = arg.floatFormat ? 16 : 4;
            // Divide rather than multiply, so huge sizes can't overflow past the check.
            const size_t available = sizes[arg.name] / pixelBytes;
            if (w > available || h > available / w || d > available / w / h) {
              throw std::runtime_error(argWhere + ": buffer '" + arg.name + "' is too small for the image");
            }
            const std::string key = arg.name + "/" + std::to_string(w) + "x" + std::to_string(h) +
                                    "x" + std::to_string(d) + (arg.floatFormat ? "f" : "u");
            auto image = images.find(key);
            if (image == images.end()) {
              cl_image_format format = {CL_RGBA, static_cast<cl_channel_type>(
                                                     arg.floatFormat ? CL_FLOAT : CL_UNORM_INT8)};
              cl_image_desc desc = {};
              desc.image_type = is3d ? CL_MEM_OBJECT_IMAGE3D : CL_MEM_OBJECT_IMAGE2D;
              desc.image_width = w;
              desc.image_height = h;
              desc.image_depth = d;
              cl_mem mem = clCreateImage(context_, CL_MEM_READ_ONLY, &format, &desc, nullptr, &err);
              Check(err, "clCreateImage(" + argWhere + ")");
              image = images.emplace(key, MemGuard(mem)).first;
            }
            const size_t origin[3] = {0, 0, 0};
            const size_t region[3] = {w, h, d};
            Check(clEnqueueCopyBufferToImage(queue_, buffer, image->second.get(), 0, origin, region,
                                             0, nullptr, nullptr),
                  "clEnqueueCopyBufferToImage(" + argWhere + ")");
            cl_mem mem = image->second.get();
            Check(clSetKernelArg(kernel, a, sizeof(cl_mem), &mem), "clSetKernelArg(" + argWhere + ")");
            break;
          }
          case ArgKind::Int:
            Check(clSetKernelArg(kernel, a, sizeof(cl_int), &arg.i), "clSetKernelArg(" + argWhere + ")");
            break;
          case ArgKind::Float:
            Check(clSetKernelArg(kernel, a, sizeof(cl_float), &arg.f), "clSetKernelArg(" + argWhere + ")");
            break;
          case ArgKind::Data: {
            cl_mem mem = clCreateBuffer(context_, CL_MEM_READ_ONLY | CL_MEM_COPY_HOST_PTR,
                                        arg.data.size(), const_cast<uint8_t*>(arg.data.data()), &err);
            Check(err, "clCreateBuffer(" + argWhere + ")");
            temporaries.emplace_back(mem);
            Check(clSetKernelArg(kernel, a, sizeof(cl_mem), &mem), "clSetKernelArg(" + argWhere + ")");
            break;
          }
        }
      }

      size_t global[2] = {static_cast<size_t>(width), static_cast<size_t>(height)};
      cl_uint dims = 2;
      if (pass.hasGlobal) {
        dims = pass.dims;
        global[0] = pass.global[0];
        global[1] = pass.global[1];
      }
      size_t local[2] = {pass.local[0], pass.local[1]};
      if (pass.hasLocal) FitLocal(pass.kernel, dims, global, local);
      // Without an explicit local size the driver picks a work-group shape
      // that suits the device, and any global size is allowed.
      if (pass.band && dims == 2 && !pass.hasLocal) {
        if (pass.args.empty() || pass.args.back().kind != ArgKind::Int) {
          throw std::runtime_error(where + ": a banded kernel's last argument must be an int row0");
        }
        const cl_uint rowArg = static_cast<cl_uint>(pass.args.size() - 1);
        // Square work-groups keep neighbourhood reads cache-friendly (left to
        // itself the driver picks thin one-row groups for short, wide bands):
        // 16x16 where the device and kernel allow it, otherwise as close as
        // they allow, e.g. 256x1 on a CPU device. The global size is rounded
        // up to whole groups (kernels skip pixels outside the image).
        const size_t maxGroup = kernelGroup_.at(pass.kernel);
        const size_t ty = std::max<size_t>(1, std::min({size_t(16), limits_.maxItem[1], maxGroup}));
        const size_t tx = std::max<size_t>(1, std::min({size_t(256) / ty, limits_.maxItem[0], maxGroup / ty}));
        const size_t bandLocal[2] = {tx, ty};
        const size_t paddedWidth = RoundUp(global[0], tx);
        // Start small, in case this device is slower than the one the plan was
        // tuned on, then size each band from how long the last one took.
        size_t rows = RoundUp(std::min<size_t>(pass.band, 64), ty);
        Check(clFinish(queue_), "clFinish(" + where + ")");  // so the first band is timed alone
        for (size_t y0 = 0; y0 < global[1];) {
          const cl_int row0 = static_cast<cl_int>(y0);
          const size_t n = std::min(rows, global[1] - y0);
          const size_t size[2] = {paddedWidth, RoundUp(n, ty)};
          Check(clSetKernelArg(kernel, rowArg, sizeof(cl_int), &row0), "clSetKernelArg(" + where + " row0)");
          cl_event event = nullptr;
          const auto start = std::chrono::steady_clock::now();
          Check(clEnqueueNDRangeKernel(queue_, kernel, 2, nullptr, size, bandLocal, 0, nullptr,
                                       profiling_ ? &event : nullptr),
                "clEnqueueNDRangeKernel(" + where + ")");
          if (event) events.emplace_back(where + " rows " + std::to_string(y0) + "+" + std::to_string(n), event);
          Check(clFinish(queue_), "clFinish(" + where + ")");
          const double ms = std::chrono::duration<double, std::milli>(std::chrono::steady_clock::now() - start).count();
          y0 += n;
          // Aim for bandTargetMs_ per band, changing by at most 4x at a time.
          const double scale = std::min(4.0, std::max(0.25, bandTargetMs_ / std::max(ms, 0.01)));
          rows = std::max(ty, RoundUp(static_cast<size_t>(rows * scale), ty));
        }
      } else {
        cl_event event = nullptr;
        Check(clEnqueueNDRangeKernel(queue_, kernel, dims, nullptr, global,
                                     pass.hasLocal ? local : nullptr, 0, nullptr,
                                     profiling_ ? &event : nullptr),
              "clEnqueueNDRangeKernel(" + where + ")");
        if (event) events.emplace_back(where, event);
      }
    }

    cl_mem result = Lookup(buffers, plan.output, "plan output");
    if (sizes[plan.output] != imageBytes) {
      throw std::runtime_error("Plan output '" + plan.output + "' is not a width x height RGBA buffer");
    }
    Check(clEnqueueReadBuffer(queue_, result, CL_TRUE, 0, imageBytes, out, 0, nullptr, nullptr),
          "clEnqueueReadBuffer");

    double total = 0;
    for (auto& e : events) {
      cl_ulong start = 0, end = 0;
      clGetEventProfilingInfo(e.second, CL_PROFILING_COMMAND_START, sizeof(start), &start, nullptr);
      clGetEventProfilingInfo(e.second, CL_PROFILING_COMMAND_END, sizeof(end), &end, nullptr);
      const double ms = (end - start) / 1e6;
      total += ms;
      std::fprintf(stderr, "[omnifilter] %8.2f ms  %s\n", ms, e.first.c_str());
    }
    if (!events.empty()) std::fprintf(stderr, "[omnifilter] %8.2f ms  total kernel time\n", total);
  }

 private:
  Gpu() = default;
  ~Gpu() { Release(); }

  void Setup(const std::string& source, const std::string& options) {
    limits_ = ReadLimits(device_);
    const char* bandMs = std::getenv("OMNIFILTER_BAND_MS");
    bandTargetMs_ = bandMs && std::atof(bandMs) > 0 ? std::atof(bandMs) : 100.0;

    cl_int err;
    context_ = clCreateContext(nullptr, 1, &device_, nullptr, nullptr, &err);
    Check(err, "clCreateContext");

    const char* profile = std::getenv("OMNIFILTER_PROFILE");
    profiling_ = profile && *profile && std::string(profile) != "0";
    queue_ = clCreateCommandQueue(context_, device_, profiling_ ? CL_QUEUE_PROFILING_ENABLE : 0, &err);
    Check(err, "clCreateCommandQueue");

    const char* src = source.c_str();
    size_t length = source.size();
    program_ = clCreateProgramWithSource(context_, 1, &src, &length, &err);
    Check(err, "clCreateProgramWithSource");

    err = clBuildProgram(program_, 1, &device_, options.empty() ? nullptr : options.c_str(), nullptr, nullptr);
    if (err != CL_SUCCESS) {
      // The build log is the only way to see kernel compile errors.
      size_t logSize = 0;
      clGetProgramBuildInfo(program_, device_, CL_PROGRAM_BUILD_LOG, 0, nullptr, &logSize);
      std::string log(logSize, '\0');
      clGetProgramBuildInfo(program_, device_, CL_PROGRAM_BUILD_LOG, logSize, &log[0], nullptr);
      throw std::runtime_error("OpenCL kernels failed to compile (error " +
                               std::to_string(err) + "):\n" + log);
    }

    cl_uint count = 0;
    Check(clCreateKernelsInProgram(program_, 0, nullptr, &count), "clCreateKernelsInProgram");
    std::vector<cl_kernel> kernels(count, nullptr);
    Check(clCreateKernelsInProgram(program_, count, kernels.data(), nullptr),
          "clCreateKernelsInProgram");
    // Each kernel moves into kernels_ (which Release() frees) as it's named;
    // if a query fails part way, free the ones that haven't moved yet.
    struct KernelGuard {
      std::vector<cl_kernel>& list;
      ~KernelGuard() { for (cl_kernel k : list) if (k) clReleaseKernel(k); }
    } kernelGuard{kernels};
    for (cl_kernel& slot : kernels) {
      cl_kernel kernel = slot;
      size_t size = 0;
      Check(clGetKernelInfo(kernel, CL_KERNEL_FUNCTION_NAME, 0, nullptr, &size), "clGetKernelInfo");
      std::string name(size, '\0');
      Check(clGetKernelInfo(kernel, CL_KERNEL_FUNCTION_NAME, size, &name[0], nullptr),
            "clGetKernelInfo");
      while (!name.empty() && name.back() == '\0') name.pop_back();
      auto existing = kernels_.find(name);
      if (existing != kernels_.end()) clReleaseKernel(existing->second);
      kernels_[name] = kernel;
      slot = nullptr;
      // A kernel can allow smaller work-groups than the device, e.g. when it
      // uses barriers or a lot of registers.
      size_t group = 0;
      Check(clGetKernelWorkGroupInfo(kernel, device_, CL_KERNEL_WORK_GROUP_SIZE, sizeof(group), &group, nullptr),
            "clGetKernelWorkGroupInfo(" + name + ")");
      kernelGroup_[name] = std::max<size_t>(1, std::min(group, limits_.maxGroup));
    }
  }

  void RequireInit() const {
    if (!program_) throw std::runtime_error("GPU not initialised; call init() first");
  }

  static cl_mem Lookup(const std::map<std::string, MemGuard>& buffers, const std::string& name,
                       const std::string& where) {
    auto found = buffers.find(name);
    if (found == buffers.end()) throw std::runtime_error(where + ": unknown buffer '" + name + "'");
    return found->second.get();
  }

  // A plan's local size is a preference: shrink it to what the device and
  // kernel allow, keeping the number of work-groups, since kernels that work
  // per group (one tile per group, say) rely on that.
  void FitLocal(const std::string& kernel, cl_uint dims, size_t global[2], size_t local[2]) const {
    const size_t maxGroup = kernelGroup_.at(kernel);
    size_t fitted[2] = {local[0], dims > 1 ? local[1] : 1};
    for (cl_uint d = 0; d < dims; d++) fitted[d] = std::max<size_t>(1, std::min(fitted[d], limits_.maxItem[d]));
    while (fitted[0] * fitted[1] > maxGroup) {
      size_t& bigger = fitted[0] >= fitted[1] ? fitted[0] : fitted[1];
      bigger = (bigger + 1) / 2;
    }
    for (cl_uint d = 0; d < dims; d++) {
      const size_t groups = (global[d] + local[d] - 1) / local[d];
      global[d] = groups * fitted[d];
      local[d] = fitted[d];
    }
  }

  void Release() {
    for (auto& entry : kernels_) clReleaseKernel(entry.second);
    kernels_.clear();
    if (program_) clReleaseProgram(program_);
    if (queue_) clReleaseCommandQueue(queue_);
    if (context_) clReleaseContext(context_);
    program_ = nullptr;
    queue_ = nullptr;
    context_ = nullptr;
    device_ = nullptr;
    platform_ = nullptr;
    kernelGroup_.clear();
    limits_ = Limits();
  }

  std::mutex mutex_;
  bool profiling_ = false;
  double bandTargetMs_ = 100;
  Limits limits_;
  cl_platform_id platform_ = nullptr;
  cl_device_id device_ = nullptr;
  cl_context context_ = nullptr;
  cl_command_queue queue_ = nullptr;
  cl_program program_ = nullptr;
  std::map<std::string, cl_kernel> kernels_;
  std::map<std::string, size_t> kernelGroup_;  // largest work-group per kernel
};

// Runs a filter off the JS thread so a large image doesn't block the server,
// and settles a Promise with the result.
class FilterWorker : public Napi::AsyncWorker {
 public:
  FilterWorker(Napi::Env env, std::vector<uint8_t>&& pixels, cl_int width, cl_int height,
               Plan&& plan)
      : Napi::AsyncWorker(env),
        deferred_(Napi::Promise::Deferred::New(env)),
        in_(std::move(pixels)),
        width_(width),
        height_(height),
        plan_(std::move(plan)) {}

  Napi::Promise Promise() const { return deferred_.Promise(); }

  void Execute() override {
    try {
      out_.resize(in_.size());
      Gpu::Instance().Run(in_.data(), out_.data(), width_, height_, plan_);
    } catch (const std::exception& e) {
      SetError(e.what());
    }
  }

  void OnOK() override {
    // Copying a large result can fail for lack of memory; reject rather than
    // let the exception escape, since nothing up the stack here would catch it.
    try {
      deferred_.Resolve(Napi::Buffer<uint8_t>::Copy(Env(), out_.data(), out_.size()));
    } catch (const Napi::Error& e) {
      deferred_.Reject(e.Value());
    }
  }

  void OnError(const Napi::Error& error) override { deferred_.Reject(error.Value()); }

 private:
  Napi::Promise::Deferred deferred_;
  std::vector<uint8_t> in_;
  std::vector<uint8_t> out_;
  cl_int width_;
  cl_int height_;
  Plan plan_;
};

std::vector<uint8_t> Bytes(const Napi::Value& value, const std::string& what) {
  if (!value.IsTypedArray()) throw Napi::TypeError::New(value.Env(), what + " must be a typed array");
  Napi::TypedArray array = value.As<Napi::TypedArray>();
  const uint8_t* start = static_cast<const uint8_t*>(array.ArrayBuffer().Data()) + array.ByteOffset();
  return std::vector<uint8_t>(start, start + array.ByteLength());
}

size_t PositiveInt(Napi::Env env, const Napi::Value& value, const std::string& what) {
  if (!value.IsNumber()) throw Napi::TypeError::New(env, what + " must be a number");
  int64_t n = value.As<Napi::Number>().Int64Value();
  if (n <= 0 || n > (int64_t(1) << 31)) throw Napi::RangeError::New(env, what + " is out of range");
  return static_cast<size_t>(n);
}

// A buffer size in bytes. Unlike PositiveInt this can pass 2^31 (CPU devices
// allow buffers of several GB), up to the largest integer a double holds
// exactly; Run() then checks it against the device's largest allocation.
// Fractions are dropped, as Int64Value() does.
size_t ByteCount(Napi::Env env, const Napi::Value& value, const std::string& what) {
  if (!value.IsNumber()) throw Napi::TypeError::New(env, what + " must be a number");
  const double n = std::floor(value.As<Napi::Number>().DoubleValue());
  constexpr double kMaxExact = 9007199254740992.0;  // 2^53
  // Written so NaN fails too.
  if (!(n >= 1 && n <= kMaxExact) || static_cast<uint64_t>(n) > static_cast<uint64_t>(SIZE_MAX)) {
    throw Napi::RangeError::New(env, what + " is out of range");
  }
  return static_cast<size_t>(n);
}

// Reads a [x] or [x, y] size array.
cl_uint Dims(Napi::Env env, const Napi::Value& value, size_t out[2], const std::string& what) {
  if (!value.IsArray()) throw Napi::TypeError::New(env, what + " must be an array");
  Napi::Array array = value.As<Napi::Array>();
  if (array.Length() < 1 || array.Length() > 2) {
    throw Napi::RangeError::New(env, what + " must have 1 or 2 entries");
  }
  out[1] = 1;
  for (uint32_t i = 0; i < array.Length(); i++) out[i] = PositiveInt(env, array.Get(i), what);
  return array.Length();
}

Arg ParseArg(Napi::Env env, const Napi::Value& value, const std::string& where) {
  if (!value.IsObject()) throw Napi::TypeError::New(env, where + " must be an object");
  Napi::Object obj = value.As<Napi::Object>();
  Arg arg;
  if (obj.Has("buf")) {
    arg.kind = ArgKind::Buffer;
    arg.name = obj.Get("buf").ToString().Utf8Value();
  } else if (obj.Has("img")) {
    arg.kind = ArgKind::Image;
    arg.name = obj.Get("img").ToString().Utf8Value();
    if (obj.Has("width")) arg.width = PositiveInt(env, obj.Get("width"), where + ".width");
    if (obj.Has("height")) arg.height = PositiveInt(env, obj.Get("height"), where + ".height");
    if (obj.Has("format")) {
      std::string format = obj.Get("format").ToString().Utf8Value();
      if (format != "rgba8" && format != "rgba32f") {
        throw Napi::RangeError::New(env, where + ".format must be 'rgba8' or 'rgba32f'");
      }
      arg.floatFormat = format == "rgba32f";
    }
  } else if (obj.Has("img3d")) {
    arg.kind = ArgKind::Image3D;
    arg.name = obj.Get("img3d").ToString().Utf8Value();
    arg.width = arg.height = arg.depth = PositiveInt(env, obj.Get("size"), where + ".size");
    arg.floatFormat = true;
  } else if (obj.Has("int")) {
    arg.kind = ArgKind::Int;
    arg.i = static_cast<cl_int>(obj.Get("int").ToNumber().Int32Value());
  } else if (obj.Has("float")) {
    arg.kind = ArgKind::Float;
    arg.f = static_cast<cl_float>(obj.Get("float").ToNumber().DoubleValue());
  } else if (obj.Has("data")) {
    arg.kind = ArgKind::Data;
    arg.data = Bytes(obj.Get("data"), where + ".data");
    if (arg.data.empty()) throw Napi::RangeError::New(env, where + ".data is empty");
  } else {
    throw Napi::TypeError::New(env, where + " must have one of buf, img, img3d, int, float, data");
  }
  return arg;
}

Plan ParsePlan(Napi::Env env, const Napi::Value& value) {
  if (!value.IsObject()) throw Napi::TypeError::New(env, "filter(): plan must be an object");
  Napi::Object obj = value.As<Napi::Object>();
  Plan plan;
  std::map<std::string, bool> names = {{"src", true}};

  if (obj.Has("buffers")) {
    Napi::Value list = obj.Get("buffers");
    if (!list.IsArray()) throw Napi::TypeError::New(env, "plan.buffers must be an array");
    Napi::Array array = list.As<Napi::Array>();
    for (uint32_t i = 0; i < array.Length(); i++) {
      const std::string where = "plan.buffers[" + std::to_string(i) + "]";
      if (!array.Get(i).IsObject()) throw Napi::TypeError::New(env, where + " must be an object");
      Napi::Object b = array.Get(i).As<Napi::Object>();
      BufferSpec spec;
      spec.name = b.Get("name").ToString().Utf8Value();
      if (names.count(spec.name)) throw Napi::Error::New(env, where + ": duplicate buffer '" + spec.name + "'");
      names[spec.name] = true;
      spec.bytes = ByteCount(env, b.Get("bytes"), where + ".bytes");
      if (b.Has("init") && !b.Get("init").IsUndefined()) {
        spec.init = Bytes(b.Get("init"), where + ".init");
        if (spec.init.size() != spec.bytes) {
          throw Napi::RangeError::New(env, where + ".init must contain exactly bytes bytes");
        }
      }
      spec.zero = b.Has("zero") && b.Get("zero").ToBoolean().Value();
      plan.buffers.push_back(std::move(spec));
    }
  }

  Napi::Value passList = obj.Get("passes");
  if (!passList.IsArray()) throw Napi::TypeError::New(env, "plan.passes must be an array");
  Napi::Array passes = passList.As<Napi::Array>();
  for (uint32_t i = 0; i < passes.Length(); i++) {
    const std::string where = "plan.passes[" + std::to_string(i) + "]";
    if (!passes.Get(i).IsObject()) throw Napi::TypeError::New(env, where + " must be an object");
    Napi::Object p = passes.Get(i).As<Napi::Object>();
    Pass pass;
    pass.kernel = p.Get("kernel").ToString().Utf8Value();
    Napi::Value args = p.Get("args");
    if (!args.IsArray()) throw Napi::TypeError::New(env, where + ".args must be an array");
    Napi::Array argArray = args.As<Napi::Array>();
    for (uint32_t a = 0; a < argArray.Length(); a++) {
      Arg arg = ParseArg(env, argArray.Get(a), where + ".args[" + std::to_string(a) + "]");
      if ((arg.kind == ArgKind::Buffer || arg.kind == ArgKind::Image ||
           arg.kind == ArgKind::Image3D) && !names.count(arg.name)) {
        throw Napi::Error::New(env, where + " uses unknown buffer '" + arg.name + "'");
      }
      pass.args.push_back(std::move(arg));
    }
    if (p.Has("global") && !p.Get("global").IsUndefined()) {
      pass.dims = Dims(env, p.Get("global"), pass.global, where + ".global");
      pass.hasGlobal = true;
    }
    if (p.Has("local") && !p.Get("local").IsUndefined()) {
      size_t local[2];
      cl_uint dims = Dims(env, p.Get("local"), local, where + ".local");
      if (!pass.hasGlobal || dims != pass.dims) {
        throw Napi::Error::New(env, where + ".local needs a global size with the same dimensions");
      }
      pass.local[0] = local[0];
      pass.local[1] = local[1];
      pass.hasLocal = true;
    }
    if (p.Has("band") && !p.Get("band").IsUndefined()) {
      pass.band = PositiveInt(env, p.Get("band"), where + ".band");
    }
    plan.passes.push_back(std::move(pass));
  }

  plan.output = obj.Has("output") ? obj.Get("output").ToString().Utf8Value() : "src";
  if (!names.count(plan.output)) {
    throw Napi::Error::New(env, "plan.output names unknown buffer '" + plan.output + "'");
  }
  return plan;
}

Napi::Value Devices(const Napi::CallbackInfo& info) {
  try {
    return Gpu::Instance().Devices(info.Env());
  } catch (const std::exception& e) {
    throw Napi::Error::New(info.Env(), e.what());
  }
}

Napi::Value Init(const Napi::CallbackInfo& info) {
  Napi::Env env = info.Env();
  if (!info[0].IsString()) {
    throw Napi::TypeError::New(env, "init(kernelSource, deviceIndex): kernelSource must be a string");
  }
  if (!info[1].IsNumber() || info[1].As<Napi::Number>().Int64Value() < 0) {
    throw Napi::TypeError::New(env, "init(kernelSource, deviceIndex): deviceIndex must be an index from devices()");
  }
  const std::string options = info[2].IsString() ? info[2].As<Napi::String>().Utf8Value() : "";
  try {
    Gpu::Instance().Init(info[0].As<Napi::String>().Utf8Value(),
                         static_cast<size_t>(info[1].As<Napi::Number>().Int64Value()), options);
  } catch (const std::exception& e) {
    throw Napi::Error::New(env, e.what());
  }
  return env.Undefined();
}

Napi::Value DeviceInfo(const Napi::CallbackInfo& info) {
  try {
    return Gpu::Instance().Info(info.Env());
  } catch (const std::exception& e) {
    throw Napi::Error::New(info.Env(), e.what());
  }
}

Napi::Value Kernels(const Napi::CallbackInfo& info) {
  try {
    return Gpu::Instance().KernelNames(info.Env());
  } catch (const std::exception& e) {
    throw Napi::Error::New(info.Env(), e.what());
  }
}

Napi::Value Filter(const Napi::CallbackInfo& info) {
  Napi::Env env = info.Env();

  if (!info[0].IsTypedArray() ||
      info[0].As<Napi::TypedArray>().TypedArrayType() != napi_uint8_array) {
    throw Napi::TypeError::New(env, "filter(): pixels must be a Buffer or Uint8Array");
  }
  if (!info[1].IsNumber() || !info[2].IsNumber()) {
    throw Napi::TypeError::New(env, "filter(): width and height must be numbers");
  }

  Napi::Uint8Array pixels = info[0].As<Napi::Uint8Array>();
  int64_t width = info[1].As<Napi::Number>().Int64Value();
  int64_t height = info[2].As<Napi::Number>().Int64Value();
  if (width <= 0 || height <= 0 || width > 65535 || height > 65535) {
    throw Napi::RangeError::New(env, "filter(): width and height must be between 1 and 65535");
  }
  if (pixels.ElementLength() != static_cast<size_t>(width * height * 4)) {
    throw Napi::RangeError::New(env, "filter(): pixels must contain width * height * 4 bytes (RGBA)");
  }

  // Copy the pixels so JS can't modify them while the GPU works on them. Copy
  // before parsing the plan: reading the plan can run JS (getters), which could
  // detach or shrink the pixel buffer and leave pixels.Data() dangling.
  std::vector<uint8_t> copy(pixels.Data(), pixels.Data() + pixels.ElementLength());

  Plan plan = ParsePlan(env, info[3]);
  FilterWorker* worker = new FilterWorker(env, std::move(copy), static_cast<cl_int>(width),
                                          static_cast<cl_int>(height), std::move(plan));
  Napi::Promise promise = worker->Promise();
  worker->Queue();  // the worker deletes itself once it has settled the promise
  return promise;
}

Napi::Object Initialize(Napi::Env env, Napi::Object exports) {
  exports.Set("devices", Napi::Function::New(env, Devices));
  exports.Set("init", Napi::Function::New(env, Init));
  exports.Set("deviceInfo", Napi::Function::New(env, DeviceInfo));
  exports.Set("kernels", Napi::Function::New(env, Kernels));
  exports.Set("filter", Napi::Function::New(env, Filter));
  return exports;
}

}  // namespace

NODE_API_MODULE(omnifilter, Initialize)
