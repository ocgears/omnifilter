__kernel void blurry(__global int* pixels, __global int* pixelsOut, int lengthPix){

  pixelsOut[0] = 0;
  pixelsOut[1] = 0;
  pixelsOut[2] = 0;
  pixelsOut[lengthPix - 1] = 0;
  pixelsOut[lengthPix - 2] = 0;
  pixelsOut[lengthPix - 3] = 0;

  for( int i = 3; i < lengthPix - 7 ; i += 1){
    pixelsOut[i] = ((pixels[i - 3] * 0.45) + (pixels[i] * 0.45) + (pixels[i + 3] * 0.45));
    if(pixelsOut[i] > 255) pixelsOut[i] = 255;

  }

}
