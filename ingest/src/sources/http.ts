import type { PhotoRef, PhotoSource } from '../types.js';
import { parseListing } from './listing.js';

export interface HttpSourceOptions {
  /** Directory URL that returns a listing, e.g. https://upload.d0b0.lv/trip */
  baseUrl: string;
  /** Extra request headers, typically Authorization. */
  headers?: Record<string, string>;
  /** Explicit listing URL, when the directory URL itself does not return one. */
  listUrl?: string;
  fetchImpl?: typeof fetch;
}

/**
 * Reads photos from an HTTP host.
 *
 * Built against the adapter interface rather than a specific API because
 * upload.d0b0.lv is not reachable from this development environment, so its
 * listing shape could not be inspected. The listing parser accepts the formats
 * such hosts commonly serve; pointing this at the real host is a URL change,
 * and `probe()` reports what the host actually supports.
 */
export class HttpSource implements PhotoSource {
  readonly kind = 'http';
  protected readonly headers: Record<string, string>;
  protected readonly fetchImpl: typeof fetch;
  private partialRead: boolean | undefined;

  constructor(private readonly options: HttpSourceOptions) {
    this.headers = options.headers ?? {};
    this.fetchImpl = options.fetchImpl ?? fetch;
  }

  protected get listingUrl(): string {
    return this.options.listUrl ?? this.options.baseUrl;
  }

  /** Subclasses fetch through this so configured auth headers are always sent. */
  protected fetchWithHeaders(url: string, init: RequestInit = {}): Promise<Response> {
    return this.fetchImpl(url, {
      ...init,
      headers: { ...this.headers, ...(init.headers as Record<string, string>) },
    });
  }

  async *list(): AsyncIterable<PhotoRef> {
    const res = await this.fetchImpl(this.listingUrl, { headers: this.headers });
    if (!res.ok) {
      throw new Error(
        `Listing ${this.listingUrl} failed: HTTP ${res.status} ${res.statusText}. ` +
          `If the directory needs auth, pass --header "Authorization: ...".`,
      );
    }
    const body = await res.text();
    const refs = parseListing(body, this.listingUrl, res.headers.get('content-type') ?? '');

    if (refs.length === 0) {
      throw new Error(
        `No image entries found at ${this.listingUrl}. The response was ` +
          `${body.length} bytes of ${res.headers.get('content-type') ?? 'unknown type'}. ` +
          `Its listing format may need a new parser in sources/listing.ts.`,
      );
    }
    for (const ref of refs) yield ref;
  }

  /**
   * Fetch only the leading bytes, where EXIF lives. Verified during development
   * to cut a metadata read to roughly 1% of a photo's bytes. Hosts that ignore
   * Range return 200 with the whole body, which is still correct, just slower.
   */
  async readPrefix(ref: PhotoRef, bytes: number): Promise<Uint8Array> {
    const res = await this.fetchImpl(ref.location, {
      headers: { ...this.headers, Range: `bytes=0-${bytes - 1}` },
    });
    if (!res.ok && res.status !== 206) {
      throw new Error(`Fetch ${ref.filename} failed: HTTP ${res.status}`);
    }
    const buf = new Uint8Array(await res.arrayBuffer());
    return res.status === 206 ? buf : buf.subarray(0, bytes);
  }

  async readFull(ref: PhotoRef): Promise<Uint8Array> {
    const res = await this.fetchImpl(ref.location, { headers: this.headers });
    if (!res.ok) throw new Error(`Fetch ${ref.filename} failed: HTTP ${res.status}`);
    return new Uint8Array(await res.arrayBuffer());
  }

  async supportsPartialRead(): Promise<boolean> {
    if (this.partialRead !== undefined) return this.partialRead;
    try {
      const res = await this.fetchImpl(this.listingUrl, {
        method: 'HEAD',
        headers: this.headers,
      });
      this.partialRead = (res.headers.get('accept-ranges') ?? '').includes('bytes');
    } catch {
      this.partialRead = false;
    }
    return this.partialRead;
  }

  /** Diagnostics for pointing ingest at a host for the first time. */
  async probe(): Promise<{
    reachable: boolean;
    status?: number;
    contentType?: string;
    acceptsRanges?: boolean;
    imagesFound?: number;
    error?: string;
  }> {
    try {
      const res = await this.fetchImpl(this.listingUrl, { headers: this.headers });
      const body = await res.text();
      const refs = parseListing(body, this.listingUrl, res.headers.get('content-type') ?? '');
      let acceptsRanges: boolean | undefined;
      if (refs[0]) {
        const probe = await this.fetchImpl(refs[0].location, {
          headers: { ...this.headers, Range: 'bytes=0-1023' },
        });
        acceptsRanges = probe.status === 206;
      }
      return {
        reachable: res.ok,
        status: res.status,
        contentType: res.headers.get('content-type') ?? undefined,
        imagesFound: refs.length,
        ...(acceptsRanges !== undefined ? { acceptsRanges } : {}),
      };
    } catch (err) {
      return { reachable: false, error: (err as Error).message };
    }
  }
}
