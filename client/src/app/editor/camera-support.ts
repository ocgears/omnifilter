// Whether this browser can open a camera at all (it needs a secure page:
// HTTPS, or localhost).
export function cameraSupported(): boolean {
  return typeof navigator !== 'undefined' && !!navigator.mediaDevices?.getUserMedia;
}
