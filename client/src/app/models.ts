// The shapes of what the API sends and takes. See server/routes/content_routes.js
// and server/lib/stack.js.

export interface RangeParam {
  name: string;
  label: string;
  type: 'range';
  min: number;
  max: number;
  step: number;
  default: number;
}

export interface SelectParam {
  name: string;
  label: string;
  type: 'select';
  options: { value: string; label: string }[];
  default: string;
}

export type FilterParam = RangeParam | SelectParam;

export type ParamValues = Record<string, string | number>;

// One entry of GET /filters.
export interface Filter {
  name: string;
  label: string;
  group: string;
  description?: string;
  params: FilterParam[];
  // false when the server's device can't run it.
  available?: boolean;
  unavailableReason?: string;
}

export interface PresetLayer {
  tOption: string;
  params?: ParamValues;
  amount?: number;
  blend?: string;
}

export interface Preset {
  name: string;
  label: string;
  description?: string;
  stack: PresetLayer[];
}

// GET /presets.
export interface PresetList {
  maxLayers: number;
  layerParams: FilterParam[];
  presets: Preset[];
}

// GET /device.
export interface Device {
  name: string;
  type: string;
  platform: string;
}

// One filter in the stack being edited. tOption is null for "none".
export interface Layer {
  tOption: string | null;
  params: ParamValues;
  amount: number;
  blend: string;
}

// A saved photo, from GET /getAll or POST /newcontent.
export interface Photo {
  _id: string;
  content: string;
  tOption?: string;
  tParams?: ParamValues;
  tStack?: { tOption: string; tParams?: ParamValues; amount?: number; blend?: string }[];
  createdAt?: string;
}

// The body of POST /newcontent.
export interface TransformRequest {
  content: string;
  tOption?: string;
  params?: ParamValues;
  stack?: { tOption: string; params: ParamValues; amount: number; blend: string }[];
}
