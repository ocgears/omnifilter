__kernel void blurry(__global int* pixels, __global int* pixelsOut, int lengthPix){

  pixelsOut[0] = 0;
  pixelsOut[1] = 0;
  pixelsOut[2] = 0;
  pixelsOut[lengthPix - 1] = 0;
  pixelsOut[lengthPix - 2] = 0;
  pixelsOut[lengthPix - 3] = 0;
  int temp = 0;

  for( int i = 3; i < lengthPix - 4 ; i += 1){
    temp = ((pixels[i - 3] * 0.45) + (pixels[i] * 0.45) + (pixels[i + 3] * 0.45));
    pixelsOut[i] =  temp > 255 ? 255 : temp;

  }

}
