import type { PhotoRef } from '../types.js';

const IMAGE_EXT = /\.(jpe?g|heic|heif|png|tiff?|webp|avif|dng)$/i;

export function looksLikeImage(name: string): boolean {
  return IMAGE_EXT.test(name.split('?')[0]);
}

/** Filename without directory components or query string. */
function basename(pathOrUrl: string): string {
  const clean = pathOrUrl.split('?')[0].split('#')[0];
  const parts = clean.split('/').filter(Boolean);
  return decodeURIComponent(parts[parts.length - 1] ?? clean);
}

export type ListingFormat = 'json' | 's3-xml' | 'html-index' | 'unknown';

export function detectFormat(body: string, contentType = ''): ListingFormat {
  const head = body.slice(0, 2000).trimStart();
  if (contentType.includes('json') || head.startsWith('{') || head.startsWith('[')) return 'json';
  if (head.includes('<ListBucketResult') || head.includes('<Contents>')) return 's3-xml';
  if (/<a\s[^>]*href=/i.test(body)) return 'html-index';
  return 'unknown';
}

/**
 * The upload service's listing format is not known yet (its host is not
 * reachable from the development environment), so rather than guess one shape
 * and be wrong, this handles the three that static and object-storage hosts
 * actually serve: a JSON listing, an S3/R2 XML bucket listing, and an
 * Nginx/Apache autoindex page.
 *
 * `baseUrl` resolves relative hrefs and keys into absolute URLs.
 */
export function parseListing(body: string, baseUrl: string, contentType = ''): PhotoRef[] {
  switch (detectFormat(body, contentType)) {
    case 'json':
      return parseJsonListing(body, baseUrl);
    case 's3-xml':
      return parseS3Listing(body, baseUrl);
    case 'html-index':
      return parseHtmlListing(body, baseUrl);
    default:
      return [];
  }
}

function toRef(nameOrUrl: string, baseUrl: string, extra: Partial<PhotoRef> = {}): PhotoRef {
  const absolute = new URL(nameOrUrl, baseUrl).toString();
  const filename = extra.filename ?? basename(nameOrUrl);
  return {
    id: extra.id ?? filename,
    filename,
    location: absolute,
    ...(extra.byteSize !== undefined ? { byteSize: extra.byteSize } : {}),
    ...(extra.contentType !== undefined ? { contentType: extra.contentType } : {}),
  };
}

function parseJsonListing(body: string, baseUrl: string): PhotoRef[] {
  let data: unknown;
  try {
    data = JSON.parse(body);
  } catch {
    return [];
  }

  // Accept a bare array, or an object wrapping one under a conventional key.
  let items: unknown[] = [];
  if (Array.isArray(data)) {
    items = data;
  } else if (data && typeof data === 'object') {
    const obj = data as Record<string, unknown>;
    for (const key of ['files', 'items', 'photos', 'objects', 'data', 'results', 'entries']) {
      if (Array.isArray(obj[key])) {
        items = obj[key] as unknown[];
        break;
      }
    }
  }

  const refs: PhotoRef[] = [];
  for (const item of items) {
    if (typeof item === 'string') {
      if (looksLikeImage(item)) refs.push(toRef(item, baseUrl));
      continue;
    }
    if (!item || typeof item !== 'object') continue;

    const obj = item as Record<string, unknown>;
    const pick = (...keys: string[]): string | undefined => {
      for (const k of keys) if (typeof obj[k] === 'string' && obj[k]) return obj[k] as string;
      return undefined;
    };

    const url = pick('url', 'href', 'link', 'path', 'location', 'src');
    const name = pick('filename', 'name', 'key', 'file', 'title');
    const target = url ?? name;
    if (!target || !looksLikeImage(name ?? target)) continue;

    const size = obj.size ?? obj.bytes ?? obj.byteSize ?? obj.contentLength;
    refs.push(
      toRef(target, baseUrl, {
        ...(name ? { filename: basename(name) } : {}),
        ...(pick('id', 'key', 'uuid', 'hash') ? { id: pick('id', 'key', 'uuid', 'hash')! } : {}),
        ...(typeof size === 'number' ? { byteSize: size } : {}),
        ...(pick('contentType', 'mimeType', 'type')
          ? { contentType: pick('contentType', 'mimeType', 'type')! }
          : {}),
      }),
    );
  }
  return refs;
}

function parseS3Listing(body: string, baseUrl: string): PhotoRef[] {
  const refs: PhotoRef[] = [];
  const contents = body.matchAll(/<Contents>([\s\S]*?)<\/Contents>/g);
  for (const [, block] of contents) {
    const key = /<Key>([\s\S]*?)<\/Key>/.exec(block)?.[1];
    if (!key || !looksLikeImage(key)) continue;
    const size = Number(/<Size>(\d+)<\/Size>/.exec(block)?.[1]);
    refs.push(
      toRef(key, baseUrl, {
        id: key,
        ...(Number.isFinite(size) ? { byteSize: size } : {}),
      }),
    );
  }
  return refs;
}

function parseHtmlListing(body: string, baseUrl: string): PhotoRef[] {
  const refs: PhotoRef[] = [];
  const seen = new Set<string>();
  for (const [, href] of body.matchAll(/<a\s[^>]*href=["']([^"']+)["']/gi)) {
    if (href.startsWith('?') || href.startsWith('#') || href === '../') continue;
    if (!looksLikeImage(href)) continue;
    const ref = toRef(href, baseUrl);
    if (seen.has(ref.location)) continue;
    seen.add(ref.location);
    refs.push(ref);
  }
  return refs;
}
