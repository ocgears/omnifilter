'use strict';

// The fast-neural-style models from the ONNX model zoo
// (https://github.com/onnx/models, validated/vision/style_transfer/
// fast_neural_style), trained with the PyTorch examples code. They are
// downloaded on request by scripts/fetch-models.js, not shipped in the repo.

const path = require('path');

const BASE_URL = 'https://github.com/onnx/models/raw/main/validated/vision/style_transfer/fast_neural_style/model/';

exports.MODEL_DIR = process.env.OMNIFILTER_MODELS || path.join(__dirname, '..', '..', '..', 'models');

exports.STYLES = [
  { name: 'style_mosaic', label: 'Mosaic', file: 'mosaic-9.onnx',
    sha256: 'fa646dedade881243f8d5a2ceb7de2b93675b21fc24f7482894ac4851a9a0a47' },
  { name: 'style_candy', label: 'Candy', file: 'candy-9.onnx',
    sha256: '9d11a3529d1e547da6ae07201d93484dbab2ec0a3614535752c8f40f0fe2968a' },
  { name: 'style_rain_princess', label: 'Rain princess', file: 'rain-princess-9.onnx',
    sha256: '4162912e6f75fedef6f810ae989b9e10d3d5d43308dab34b027c850cf255e152' },
  { name: 'style_udnie', label: 'Udnie', file: 'udnie-9.onnx',
    sha256: '8656b6ce7dec8f22ee13c2d557d6b67bd6f550dde88d0f2e7c9972aeb765cc0d' },
  { name: 'style_pointilism', label: 'Pointillism', file: 'pointilism-9.onnx',
    sha256: '5ee2b8d4d6bc60a777f54e0fe96a1b717360a004b79d56c67390d4a975b14d98' }
].map((style) => Object.assign({ url: BASE_URL + style.file }, style));
