import type { PhotoRef } from '../types.js';
import { HttpSource, type HttpSourceOptions } from './http.js';
import { looksLikeImage } from './listing.js';

const DEFAULT_ORIGIN = 'https://upload.d0b0.lv';
const DEFAULT_FOLDER = 'Trip_photos';

export interface D0b0Options {
  origin?: string;
  folder?: string;
  /** Value of the trip_auth cookie. Never commit this. */
  authCookie?: string;
  fetchImpl?: typeof fetch;
}

/**
 * The upload.d0b0.lv photo album.
 *
 * Its API, read from the upload page's own JavaScript:
 *   GET /api/files?folder=<folder>   -> { files: [{ name, size, image }] }
 *   GET /file?folder=<f>&name=<n>    -> the original bytes (honours Range)
 *   GET /thumb?folder=<f>&name=<n>   -> server-generated thumbnail
 *   GET /thumb?big=1&folder=…&name=… -> larger preview
 *
 * Photo URLs are query-string based rather than path based, so the generic
 * listing parser (which resolves names as relative paths) cannot construct
 * them; this builds them explicitly.
 */
export class D0b0Source extends HttpSource {
  readonly origin: string;
  readonly folder: string;

  constructor(options: D0b0Options = {}) {
    const origin = options.origin ?? DEFAULT_ORIGIN;
    const folder = options.folder ?? DEFAULT_FOLDER;
    const headers: Record<string, string> = {};
    if (options.authCookie) {
      headers.Cookie = options.authCookie.includes('=')
        ? options.authCookie
        : `trip_auth=${options.authCookie}`;
    }
    const opts: HttpSourceOptions = {
      baseUrl: origin,
      listUrl: `${origin}/api/files?folder=${encodeURIComponent(folder)}`,
      headers,
      ...(options.fetchImpl ? { fetchImpl: options.fetchImpl } : {}),
    };
    super(opts);
    this.origin = origin;
    this.folder = folder;
  }

  fileUrl(name: string): string {
    return (
      `${this.origin}/file?folder=${encodeURIComponent(this.folder)}` +
      `&name=${encodeURIComponent(name)}`
    );
  }

  thumbUrl(name: string, big = false): string {
    return (
      `${this.origin}/thumb?${big ? 'big=1&' : ''}` +
      `folder=${encodeURIComponent(this.folder)}&name=${encodeURIComponent(name)}`
    );
  }

  override async *list(): AsyncIterable<PhotoRef> {
    const res = await this.fetchWithHeaders(this.listingUrl);
    if (!res.ok) {
      throw new Error(
        `Listing failed: HTTP ${res.status}. If this is 401/403 the trip_auth ` +
          `cookie is missing or expired — pass --cookie or set TRIP_AUTH_COOKIE.`,
      );
    }
    const data = (await res.json()) as { files?: { name: string; size?: number; image?: boolean }[] };
    const files = data.files ?? [];
    if (files.length === 0) {
      throw new Error(`Album "${this.folder}" is empty, or the folder name is wrong.`);
    }

    for (const file of files) {
      // The album also holds video; only still images carry the EXIF we read.
      if (file.image === false || !looksLikeImage(file.name)) continue;
      yield {
        id: file.name,
        filename: file.name,
        location: this.fileUrl(file.name),
        // The album renders its own thumbnails, so the viewer never needs this
        // project to generate derivatives.
        thumbUrl: this.thumbUrl(file.name),
        previewUrl: this.thumbUrl(file.name, true),
        ...(typeof file.size === 'number' ? { byteSize: file.size } : {}),
      };
    }
  }
}
