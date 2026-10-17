import { HttpClient } from '@angular/common/http';
import { Injectable, inject } from '@angular/core';
import { firstValueFrom } from 'rxjs';
import { API_BASE } from './api-base';
import { AuthService } from './auth.service';
import { Device, Filter, Photo, PresetList, ServerSettings, TransformRequest } from './models';

// How many photos' files PhotoApi.file keeps, for Save and Share again.
const FILES_KEPT = 3;

// The photo and filter endpoints of the API (server/routes/content_routes.js).
@Injectable({ providedIn: 'root' })
export class PhotoApi {
  private readonly http = inject(HttpClient);
  private readonly apiBase = inject(API_BASE);
  private readonly auth = inject(AuthService);

  // The last few photo files fetched (or just kept), newest last, and the
  // file itself once it has arrived.
  private readonly files = new Map<string, { file: Promise<Blob>; ready?: Blob }>();

  private authHeaders(): Record<string, string> {
    const token = this.auth.token();
    return token ? { token } : {};
  }

  filters(): Promise<Filter[]> {
    return firstValueFrom(this.http.get<Filter[]>(this.apiBase + '/filters'));
  }

  presets(): Promise<PresetList> {
    return firstValueFrom(this.http.get<PresetList>(this.apiBase + '/presets'));
  }

  device(): Promise<Device> {
    return firstValueFrom(this.http.get<Device>(this.apiBase + '/device'));
  }

  // The user's saved photos, newest first.
  all(): Promise<Photo[]> {
    return firstValueFrom(
      this.http.get<Photo[]>(this.apiBase + '/getAll', { headers: this.authHeaders() }),
    );
  }

  // Runs the filters on the server and saves the result. The photo goes as
  // a file (see sendPhoto).
  async transform(body: TransformRequest): Promise<Photo> {
    const { content, ...recipe } = body;
    return this.sendPhoto('/newcontent', await (await fetch(content)).blob(), recipe);
  }

  // How the server is set up: where filters run, for whom, and how many
  // photos an account may keep.
  settings(): Promise<ServerSettings> {
    return firstValueFrom(this.http.get<ServerSettings>(this.apiBase + '/settings'));
  }

  // Runs the filters on the server without saving anything (guest mode).
  // Resolves with the photo, without an _id.
  preview(body: TransformRequest): Promise<Omit<Photo, '_id'>> {
    return firstValueFrom(this.http.post<Omit<Photo, '_id'>>(this.apiBase + '/transform', body));
  }

  // Saves a photo made elsewhere (as a guest, or on this device's GPU) to the
  // account, with what it was made with: `file`, or the photo's own.
  async import(photo: Omit<Photo, '_id'>, file?: Blob): Promise<Photo> {
    const recipe = {
      createdAt: photo.createdAt,
      ...(photo.tStack?.length
        ? {
            stack: photo.tStack.map((l) => ({
              tOption: l.tOption,
              params: l.tParams,
              amount: l.amount,
              blend: l.blend,
            })),
          }
        : { tOption: photo.tOption ?? '', params: photo.tParams }),
    };
    return this.sendPhoto('/import', file ?? (await photoFile(photo)), recipe);
  }

  // Sends a photo as the file itself, and what it was made with as JSON in
  // a header (server/routes/content_routes.js): a quarter less to upload
  // than a data URL, and the server holds one copy of it rather than three.
  private sendPhoto(path: string, file: Blob, recipe: object): Promise<Photo> {
    return firstValueFrom(
      this.http.post<Photo>(this.apiBase + path, file, {
        headers: {
          ...this.authHeaders(),
          'Content-Type': file.type.startsWith('image/') ? file.type : 'image/unknown',
          // Headers carry only ASCII, which this is once escaped.
          'Omnifilter-Recipe': JSON.stringify(recipe).replace(
            /[\u007f-\uffff]/g,
            (c) => '\\u' + c.charCodeAt(0).toString(16).padStart(4, '0'),
          ),
        },
      }),
    );
  }

  // The photo itself, as a file: from the server (GET /content/:id), or for
  // one kept in this browser, its own. The last few are kept, so Save then
  // Share fetches it once.
  file(photo: Photo): Promise<Blob> {
    const known = this.files.get(photo._id);
    if (known) return known.file;
    const fetched =
      photo.file || photo.content
        ? photoFile(photo)
        : firstValueFrom(
            this.http.get(this.apiBase + '/content/' + encodeURIComponent(photo._id), {
              headers: this.authHeaders(),
              responseType: 'blob',
            }),
          );
    this.remember(photo._id, fetched);
    return fetched;
  }

  // The file of a photo that's already to hand, such as one just kept.
  remember(id: string, file: Blob | Promise<Blob>): void {
    const entry: { file: Promise<Blob>; ready?: Blob } = { file: Promise.resolve(file) };
    entry.file.then(
      (blob) => (entry.ready = blob),
      () => this.files.get(id) === entry && this.files.delete(id),
    );
    this.files.delete(id);
    this.files.set(id, entry);
    while (this.files.size > FILES_KEPT) this.files.delete(this.files.keys().next().value!);
  }

  // A photo's file if it has already arrived, or null: Share has to call
  // the browser straight from the tap, without waiting.
  fileIfReady(photo: Photo): Blob | null {
    return this.files.get(photo._id)?.ready ?? null;
  }

  delete(photo: Photo): Promise<{ msg: string }> {
    return firstValueFrom(
      this.http.delete<{ msg: string }>(this.apiBase + '/delete/' + encodeURIComponent(photo._id), {
        headers: this.authHeaders(),
      }),
    );
  }
}

// A photo kept in this browser as a file: its own, or one from its data URL.
export async function photoFile(photo: Pick<Photo, 'file' | 'content'>): Promise<Blob> {
  if (photo.file) return photo.file;
  if (!photo.content) throw new Error('The photo is not in this browser');
  return (await fetch(photo.content)).blob();
}
