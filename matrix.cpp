#ifndef _WIN32
#include <unistd.h>
#endif

#ifdef __APPLE__
#include <OpenCL/opencl.h>
#else
#include <CL/cl.h>
#endif

#include <nan.h>
#include <stdio.h>
#include <stdlib.h>
#include <stdint.h>
#include <iostream>

#define MEM_SIZE (21000000)
#define MAX_SOURCE_SIZE (0x100000)

using namespace v8;
using v8::Local;
using Nan::New;
using Nan::Null;
using Nan::To;

NAN_METHOD(Blurry) {
  // if(true){
  //   printf("The size of an int is : %d \n", sizeof(int) );
  //   printf("The size of a short unsigned int is : %d \n", sizeof(ushort));
  //   ushort try1 = 255;
  //   ushort try2 = 0;
  //   printf("As a trial here are two unsigned short ints, from the bottom to top of the needed range: %d - %d \n", try2, try1);
  //   // exit(0);
  // }

  cl_device_id device_id = NULL;
  cl_context context = NULL;
  cl_command_queue command_queue = NULL;
  cl_mem memobjIn = NULL;
  cl_mem memobjOut = NULL;
  cl_program program = NULL;
  cl_kernel kernel = NULL;
  cl_platform_id platform_id = NULL;
  cl_uint ret_num_devices;
  cl_uint ret_num_platforms;
  cl_int ret;
  ushort *outImg;
  ushort *simpleArray;

  Local<Uint8Array> converter = info[0].As<Uint8Array>();
  Nan::TypedArrayContents<uint8_t> Arr(converter);

  Nan::Maybe<int> maybeInt = To<int>(info[1]);
  int width;
  if (maybeInt.IsNothing() == false) {
    width = maybeInt.FromJust();

  } else {
    printf("Error converting width \n");
    exit(1);
  }

  Nan::Maybe<int> maybeInt2 = To<int>(info[2]);
  int height;
  if (maybeInt2.IsNothing() == false) {
    height = maybeInt2.FromJust();

  } else {
    printf("Error converting height \n");
    exit(1);
  }

  int numRGBElements = width * height * 3;
  outImg = (ushort *)malloc(numRGBElements * sizeof(ushort));
  simpleArray = (ushort *)malloc(numRGBElements * sizeof(ushort));

  for (int m = 0; m < numRGBElements; m++){
    simpleArray[m] = (*Arr)[m];
  }
  free(&Arr);

  FILE *fp;
  char fileName[] = "./blurry.cl";
  char *source_str;
  size_t source_size;

  /* Load the source code containing the kernel*/
  fp = fopen(fileName, "r");
  if (!fp) {
    fprintf(stderr, "Failed to load kernel.\n");
    exit(1);
  }
  source_str = (char*)malloc(MAX_SOURCE_SIZE);
  source_size = fread(source_str, 1, MAX_SOURCE_SIZE, fp);
  fclose(fp);

  /* Get Platform and Device Info */
  ret = clGetPlatformIDs(1, &platform_id, &ret_num_platforms);
  ret = clGetDeviceIDs(platform_id, CL_DEVICE_TYPE_DEFAULT, 1, &device_id, &ret_num_devices);

  /* Create OpenCL context */
  context = clCreateContext(NULL, 1, &device_id, NULL, NULL, &ret);

  /* Create Command Queue */
  command_queue = clCreateCommandQueue(context, device_id, 0, &ret);

  /* Create Memory Buffer */
  memobjIn  = clCreateBuffer(context, CL_MEM_READ_WRITE,
                               numRGBElements * sizeof(ushort), NULL, &ret);

  memobjOut = clCreateBuffer(context, CL_MEM_READ_WRITE,
                               numRGBElements * sizeof(ushort), NULL, &ret);

  /* Create Kernel Program from the source */
  program = clCreateProgramWithSource(context, 1, (const char **)&source_str,
                                          (const size_t *)&source_size, &ret);

  /* Build Kernel Program */
  ret = clBuildProgram(program, 1, &device_id, NULL, NULL, NULL);

  /* Create OpenCL Kernel */
  kernel = clCreateKernel(program, "blurry", &ret);

  ret = clEnqueueWriteBuffer(command_queue, memobjIn, CL_TRUE, 0,
                               numRGBElements * sizeof(ushort),
                               simpleArray, 0, NULL, NULL);

  /* Set OpenCL Kernel Parameters */
  ret = clSetKernelArg(kernel, 0, sizeof(cl_mem), (void *)&memobjIn);
  ret = clSetKernelArg(kernel, 1, sizeof(cl_mem), (void *)&memobjOut);
  ret = clSetKernelArg(kernel, 2, sizeof(int),    (void *)&numRGBElements);
  ret = clSetKernelArg(kernel, 3, sizeof(int),    (void *)&width);
  ret = clSetKernelArg(kernel, 4, sizeof(int),    (void *)&height);
  cl_uint work_dim = 1;
  size_t global_item_size[1];
  size_t local_item_size[1];

  global_item_size[0] = 2;
  local_item_size[0] = 1;

  /* Execute OpenCL Kernel */
  ret = clEnqueueNDRangeKernel(command_queue, kernel, work_dim, NULL,
                                 global_item_size, local_item_size,
                                 0, NULL, NULL);

  /* Copy results from the memory buffer */
  ret = clEnqueueReadBuffer(command_queue, memobjOut, CL_TRUE, 0,
              width * height * 3 * sizeof(ushort), (void *)outImg, 0, NULL, NULL);

  /* Finalization */
  ret = clFlush(command_queue);
  ret = clFinish(command_queue);
  ret = clReleaseKernel(kernel);
  ret = clReleaseProgram(program);
  ret = clReleaseMemObject(memobjIn);
  ret = clReleaseMemObject(memobjOut);
  ret = clReleaseCommandQueue(command_queue);
  ret = clReleaseContext(context);
  free(simpleArray);

  v8::Isolate* isolate = v8::Isolate::GetCurrent();

  // We will be creating temporary handles so we use a handle scope.
  EscapableHandleScope handle_scope(isolate);

  // Create a new empty array.
  Local<Array> workOut = Array::New(isolate, numRGBElements);

  for(int i = 0; i < numRGBElements; i++){
    workOut->Set(i, Integer::New(isolate, outImg[i]));
  }

  info.GetReturnValue().Set(handle_scope.Escape(workOut));
  free(outImg);
  free(&workOut);

}

NAN_MODULE_INIT(Init) {
      Nan::Set(target, New("blurry").ToLocalChecked(),
          Nan::GetFunction(New<FunctionTemplate>(Blurry)).ToLocalChecked());
}

NODE_MODULE(blurry, Init);
