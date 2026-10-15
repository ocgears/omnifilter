'use strict';

// Makes the height and width of an ONNX model's image input/output dynamic.
//
// The published fast-neural-style models declare a fixed 1x3x224x224 input,
// although the network itself (convolutions, instance norm, upsampling) works
// at any size. ONNX Runtime rejects other sizes because of that declaration,
// so this rewrites dims 2 and 3 of the named input and output to symbolic
// dims ('height', 'width') and drops the intermediate shape hints.
//
// An .onnx file is a protobuf ModelProto. Rather than pull in a protobuf
// library for one edit, this walks the wire format directly:
//   ModelProto.graph (7) -> GraphProto.input (11) / output (12) / value_info (13)
//   ValueInfoProto.name (1), .type (2) -> TypeProto.tensor_type (1)
//   -> Tensor.shape (2) -> TensorShapeProto.dim (1)
//   -> Dimension.dim_value (1, varint) | dim_param (2, string)

const VARINT = 0;
const LEN = 2;

function readVarint(buf, pos) {
  let value = 0;
  let scale = 1;
  for (;;) {
    if (pos >= buf.length) throw new Error('Truncated protobuf varint');
    const byte = buf[pos++];
    value += (byte & 0x7f) * scale;
    if (byte < 0x80) return { value: value, pos: pos };
    scale *= 128;
  }
}

function encodeVarint(value) {
  const bytes = [];
  do {
    let byte = value % 128;
    value = Math.floor(value / 128);
    if (value > 0) byte |= 0x80;
    bytes.push(byte);
  } while (value > 0);
  return Buffer.from(bytes);
}

// Splits a message into its fields, keeping each field's original bytes.
function parse(buf) {
  const fields = [];
  let pos = 0;
  while (pos < buf.length) {
    const start = pos;
    const tag = readVarint(buf, pos);
    pos = tag.pos;
    const field = Math.floor(tag.value / 8);
    const wire = tag.value % 8;
    let payload = null;
    if (wire === VARINT) {
      pos = readVarint(buf, pos).pos;
    } else if (wire === LEN) {
      const len = readVarint(buf, pos);
      payload = buf.subarray(len.pos, len.pos + len.value);
      pos = len.pos + len.value;
    } else if (wire === 1) {
      pos += 8;
    } else if (wire === 5) {
      pos += 4;
    } else {
      throw new Error('Unsupported protobuf wire type ' + wire);
    }
    if (pos > buf.length) throw new Error('Truncated protobuf field');
    fields.push({ field: field, wire: wire, payload: payload, raw: buf.subarray(start, pos) });
  }
  return fields;
}

function lenField(field, payload) {
  return Buffer.concat([encodeVarint(field * 8 + LEN), encodeVarint(payload.length), payload]);
}

function stringOf(message, fieldNumber) {
  const f = parse(message).find((x) => x.field === fieldNumber && x.wire === LEN);
  return f ? f.payload.toString('utf8') : null;
}

// Rewrites a message: fn(field) returns undefined to keep it, null to drop it,
// or a new payload Buffer for a length-delimited field.
function rewrite(message, fn) {
  return Buffer.concat(parse(message).map((f) => {
    const result = fn(f);
    if (result === undefined) return f.raw;
    if (result === null) return Buffer.alloc(0);
    return lenField(f.field, result);
  }));
}

function symbolicDims(valueInfo, names) {
  return rewrite(valueInfo, (f) => {
    if (f.field !== 2 || f.wire !== LEN) return undefined; // type
    return rewrite(f.payload, (t) => {
      if (t.field !== 1 || t.wire !== LEN) return undefined; // tensor_type
      return rewrite(t.payload, (s) => {
        if (s.field !== 2 || s.wire !== LEN) return undefined; // shape
        let index = 0;
        return rewrite(s.payload, (d) => {
          if (d.field !== 1 || d.wire !== LEN) return undefined; // dim
          const name = names[index++];
          return name ? lenField(2, Buffer.from(name, 'utf8')) : undefined;
        });
      });
    });
  });
}

exports.makeSpatialDimsDynamic = function(model, inputName, outputName) {
  let found = 0;
  const dims = [null, null, 'height', 'width'];
  const out = rewrite(model, (f) => {
    if (f.field !== 7 || f.wire !== LEN) return undefined; // graph
    return rewrite(f.payload, (g) => {
      if (g.wire !== LEN) return undefined;
      if (g.field === 13) return null; // value_info: stale fixed-size shape hints
      if (g.field !== 11 && g.field !== 12) return undefined;
      const name = stringOf(g.payload, 1);
      if (name !== (g.field === 11 ? inputName : outputName)) return undefined;
      found++;
      return symbolicDims(g.payload, dims);
    });
  });
  if (found !== 2) {
    throw new Error('Model has no input "' + inputName + '" and output "' + outputName + '"');
  }
  return out;
};
