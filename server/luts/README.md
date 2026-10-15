# Colour grading LUTs

Drop `.cube` files (3D LUTs, as exported by Lightroom, DaVinci Resolve, Photoshop and most
colour-grading tools) into this folder and restart the server. Each appears as a filter in the
"Looks" group, named after the file (or its `TITLE` line), and runs on the GPU through a 3D texture.

Sizes from 2 to 65 are supported. 1D LUTs are not.
