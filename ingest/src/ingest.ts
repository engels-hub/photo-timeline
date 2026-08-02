import { extractMetadata } from './exif.js';
import type { Manifest, PhotoRecord, PhotoSource, SkippedPhoto } from './types.js';

/**
 * Prefix sizes tried in turn. Most JPEGs put EXIF in the first few KB; HEIC
 * places its metadata box further in, and some cameras write a large preview
 * ahead of the tags. Escalating avoids downloading whole photos in the common
 * case while still finding metadata in the awkward ones.
 */
const PREFIX_STEPS = [128 * 1024, 1024 * 1024];

export interface IngestOptions {
  source: PhotoSource;
  concurrency?: number;
  onProgress?: (done: number, record: PhotoRecord | null) => void;
}

async function readMetadata(source: PhotoSource, ref: Parameters<PhotoSource['readPrefix']>[0]) {
  let last: Awaited<ReturnType<typeof extractMetadata>> | undefined;

  for (const size of PREFIX_STEPS) {
    // No point re-reading a prefix larger than the file itself.
    if (ref.byteSize !== undefined && size >= ref.byteSize) break;
    const bytes = await source.readPrefix(ref, size);
    last = await extractMetadata(ref, bytes);
    if (last.ok) return last;
  }

  // Fall back to the whole file before giving up.
  const bytes = await source.readFull(ref);
  const result = await extractMetadata(ref, bytes);
  return result.ok ? result : (last ?? result);
}

/**
 * Read every photo in the source, keep the ones carrying GPS coordinates and a
 * GPS timestamp, and return them ordered in time.
 *
 * Photos without that metadata are dropped by design, but each one is recorded
 * in `skipped` with a reason, so a surprising photo count can be explained
 * rather than guessed at.
 */
export async function ingest(options: IngestOptions): Promise<Manifest> {
  const { source, concurrency = 8, onProgress } = options;

  const refs: Awaited<ReturnType<typeof collect>> = await collect(source);
  const photos: PhotoRecord[] = [];
  const skipped: SkippedPhoto[] = [];
  let done = 0;
  let cursor = 0;

  async function worker() {
    while (cursor < refs.length) {
      const ref = refs[cursor++];
      let record: PhotoRecord | null = null;
      try {
        const result = await readMetadata(source, ref);
        if (result.ok) {
          record = { ...result.record, location: ref.location };
          photos.push(record);
        } else {
          skipped.push({ filename: ref.filename, reason: result.reason, detail: result.detail });
        }
      } catch (err) {
        skipped.push({
          filename: ref.filename,
          reason: 'unreadable',
          detail: (err as Error).message,
        });
      }
      onProgress?.(++done, record);
    }
  }

  await Promise.all(
    Array.from({ length: Math.min(concurrency, refs.length || 1) }, () => worker()),
  );

  photos.sort((a, b) => a.tUtc.localeCompare(b.tUtc) || a.filename.localeCompare(b.filename));

  return {
    version: 1,
    generatedAt: new Date().toISOString(),
    photoCount: photos.length,
    photos,
    bounds: computeBounds(photos),
    timespan: photos.length
      ? { start: photos[0].tUtc, end: photos[photos.length - 1].tUtc }
      : null,
    skipped,
  };
}

async function collect(source: PhotoSource) {
  const refs = [];
  for await (const ref of source.list()) refs.push(ref);
  return refs;
}

export function computeBounds(photos: PhotoRecord[]): Manifest['bounds'] {
  if (photos.length === 0) return null;
  let minLat = Infinity,
    minLon = Infinity,
    maxLat = -Infinity,
    maxLon = -Infinity;
  for (const p of photos) {
    if (p.lat < minLat) minLat = p.lat;
    if (p.lat > maxLat) maxLat = p.lat;
    if (p.lon < minLon) minLon = p.lon;
    if (p.lon > maxLon) maxLon = p.lon;
  }
  return { minLat, minLon, maxLat, maxLon };
}
