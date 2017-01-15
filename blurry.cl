__kernel void blurry(__global unsigned char* pixels, __global unsigned char* pixelsOut, int numRGBElements, int width, int height){
  const int i = get_global_id(0);
  pixelsOut[i] = ((pixels[i - 3] * 0.333) + (pixels[i] * 0.333) + (pixels[i + 3] * 0.333));
}
