kernel void toSepia(read_only image2d_t srcImg, write_only image2d_t dstImg)
{
  const sampler_t smp =
    CLK_NORMALIZE_COORDS_FALSE | //Natural coordinates
    CLK_ADDRESS_CLAMP_TO_EDGE | //Clamp to zeros
    CLK_FILTER_LINEAR;

  int2 coord = (int2)(get_global_id(0), get_global_id(1));

  uint4 rgba = read_imageui(srcImg, smp, coord); //The byte order is RGBA

  float4 rgbafloat = convert_float4(rgba) / 255.0f; //Convert to normalized [0..1] float

  //Convert RGB to luminance (make the image sepia).
  float luminance = sqrt(0.43f * rbgafloat.z * rbgafloat.z + 0.74f * rbgafloat.y * rbgafloat.y + 1.07f * rbgafloat.x * rbgafloat.x);

  rgba.x = rgba.y = rgba.z = (uint) (luminance * 255.0f);
  rgba.w = 255;

  write_imageui(dstImg, coord, rgba);
}
