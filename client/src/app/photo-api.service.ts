import { HttpClient } from '@angular/common/http';
import { Injectable, inject } from '@angular/core';
import { firstValueFrom } from 'rxjs';
import { API_BASE } from './api-base';
import { AuthService } from './auth.service';
import { Device, Filter, Photo, PresetList, TransformRequest } from './models';

// The photo and filter endpoints of the API (server/routes/content_routes.js).
@Injectable({ providedIn: 'root' })
export class PhotoApi {
  private readonly http = inject(HttpClient);
  private readonly apiBase = inject(API_BASE);
  private readonly auth = inject(AuthService);

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

  // Runs the filters on the server and saves the result.
  transform(body: TransformRequest): Promise<Photo> {
    return firstValueFrom(
      this.http.post<Photo>(this.apiBase + '/newcontent', body, { headers: this.authHeaders() }),
    );
  }

  delete(photo: Photo): Promise<{ msg: string }> {
    return firstValueFrom(
      this.http.delete<{ msg: string }>(this.apiBase + '/delete/' + encodeURIComponent(photo._id), {
        headers: this.authHeaders(),
      }),
    );
  }
}
