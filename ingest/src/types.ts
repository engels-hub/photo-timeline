/** A photo as the storage backend describes it, before any metadata is read. */
export interface PhotoRef {
  /** Stable identifier. Re-running ingest against the same store must yield the same id. */
  id: string;
  /** Display filename, e.g. "IMG_4021.HEIC". */
  filename: string;
  /** Absolute URL or filesystem path used to fetch bytes. */
  location: string;
  byteSize?: number;
  contentType?: string;
}

/**
 * Everything ingest needs from a photo store.
 *
 * `readPrefix` exists because EXIF lives at the start of a file: reading the
 * first ~128 KB is enough to place a photo on the map, versus several MB to
 * download it whole. Backends that cannot serve partial reads fall back to
 * `readFull` and the ingest simply runs slower.
 */
export interface PhotoSource {
  readonly kind: string;
  list(): AsyncIterable<PhotoRef>;
  readPrefix(ref: PhotoRef, bytes: number): Promise<Uint8Array>;
  readFull(ref: PhotoRef): Promise<Uint8Array>;
  /** True when the backend honours HTTP range requests (or is a local file). */
  supportsPartialRead(): Promise<boolean>;
}

/** A photo that carried both coordinates and a GPS timestamp. */
export interface PhotoRecord {
  id: string;
  filename: string;
  location: string;
  /** True instant in UTC. */
  tUtc: string;
  /**
   * Which tags produced tUtc. 'gps' is UTC by spec; 'exif-offset' is
   * DateTimeOriginal combined with OffsetTimeOriginal. Both are exact.
   */
  timeSource: 'gps' | 'exif-offset';
  lat: number;
  lon: number;
  /** Metres above sea level, when GPSAltitude was present. */
  alt?: number;
  width?: number;
  height?: number;
  /** EXIF Orientation, 1-8. The viewer must honour this or photos appear rotated. */
  orientation?: number;
  make?: string;
  model?: string;
}

/** A photo that was dropped, and why. Surfaced so the count is never a mystery. */
export interface SkippedPhoto {
  filename: string;
  reason: SkipReason;
  detail?: string;
}

export type SkipReason =
  | 'no-exif'
  /** GPS tags are present but their values were blanked out before upload. */
  | 'gps-redacted'
  | 'no-gps-coords'
  | 'no-gps-time'
  | 'unreadable'
  | 'not-an-image';

export interface Manifest {
  version: 1;
  generatedAt: string;
  photoCount: number;
  /** Time-ordered. The viewer relies on this and does not re-sort. */
  photos: PhotoRecord[];
  bounds: { minLat: number; minLon: number; maxLat: number; maxLon: number } | null;
  timespan: { start: string; end: string } | null;
  skipped: SkippedPhoto[];
}
