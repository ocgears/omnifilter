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

// GET /settings: how the server is set up (server/lib/settings.js).
export interface ServerSettings {
  // 'cloud' for the hosted demo.
  mode: 'standard' | 'cloud';
  // Where signed-in users' filters run: on the server, on this device's
  // GPU, or on the device where the browser can and otherwise the server.
  processing: 'server' | 'device' | 'device-first';
  // Guests: the server's filters, the device's only, or no guests.
  guests: 'server' | 'device' | 'off';
  // How many photos an account may keep, or null for any number.
  maxStoredPhotos: number | null;
  // Kept photos longer than this on a side are kept scaled down to it, or
  // null if they're kept as they are.
  keepMaxSide: number | null;
  // Whether a kept photo can be shared by a link anyone can open.
  sharing?: boolean;
  // The largest photo the server takes, and takes from a guest, in pixels.
  maxPixels: number;
  guestMaxPixels: number;
}

// One filter in the stack being edited. tOption is null for "none".
export interface Layer {
  tOption: string | null;
  params: ParamValues;
  amount: number;
  blend: string;
}

// A saved photo, from GET /getAll or POST /newcontent: what it was made
// with, its size and type, and a thumbnail; the photo itself comes from GET
// /content/:id (PhotoApi.file). A photo kept in this browser (as a guest)
// has the photo itself in `file` instead (older ones: in `content`, as a
// data URL).
export interface Photo {
  _id: string;
  file?: Blob;
  content?: string;
  thumb?: string;
  mime?: string;
  width?: number;
  height?: number;
  tOption?: string;
  tParams?: ParamValues;
  tStack?: { tOption: string; tParams?: ParamValues; amount?: number; blend?: string }[];
  createdAt?: string;
  // Set while it's shared by link: its public page is /p/<shareId>.
  shareId?: string;
}

// The body of POST /newcontent.
export interface TransformRequest {
  content: string;
  tOption?: string;
  params?: ParamValues;
  stack?: { tOption: string; params: ParamValues; amount: number; blend: string }[];
}
