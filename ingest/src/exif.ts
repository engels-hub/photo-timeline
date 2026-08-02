import exifr from 'exifr';
import type { PhotoRecord, PhotoRef, SkipReason } from './types.js';

export type ExtractResult =
  | { ok: true; record: Omit<PhotoRecord, 'location'> }
  | { ok: false; reason: SkipReason; detail?: string };

/**
 * EXIF GPSDateStamp is "YYYY:MM:DD" and GPSTimeStamp is h/m/s, both UTC by
 * spec. exifr hands GPSTimeStamp back as either a numeric triple or a string
 * like "13:32:7" (note the unpadded seconds) depending on the tag encoding, so
 * both shapes are handled here.
 *
 * This is deliberately preferred over DateTimeOriginal, which is a naive local
 * wall-clock string with no zone attached — exifr parses it as if it were UTC,
 * which silently shifts every photo by the local offset. Measured at +2h for a
 * CEST photo during development.
 */
export function gpsTimestampToUtc(dateStamp: unknown, timeStamp: unknown): Date | null {
  if (dateStamp == null || timeStamp == null) return null;

  const dateParts = String(dateStamp).trim().split(/[:\-]/).map(Number);
  if (dateParts.length !== 3 || dateParts.some((n) => !Number.isFinite(n))) return null;
  const [year, month, day] = dateParts;

  const timeParts = Array.isArray(timeStamp)
    ? timeStamp.map(Number)
    : String(timeStamp).trim().split(':').map(Number);
  if (timeParts.length !== 3 || timeParts.some((n) => !Number.isFinite(n))) return null;
  const [hour, minute, second] = timeParts;

  // Reject values that would silently roll over into a different day/hour.
  if (month < 1 || month > 12 || day < 1 || day > 31) return null;
  if (hour > 23 || minute > 59 || second >= 61) return null;

  const ms = Date.UTC(year, month - 1, day, hour, minute, Math.floor(second));
  const date = new Date(ms);
  return Number.isNaN(date.getTime()) ? null : date;
}

/** Coordinates of exactly 0,0 mean "GPS chip reported nothing", not Null Island. */
function hasRealCoords(lat: unknown, lon: unknown): lat is number {
  return (
    typeof lat === 'number' &&
    typeof lon === 'number' &&
    Number.isFinite(lat) &&
    Number.isFinite(lon) &&
    Math.abs(lat) <= 90 &&
    Math.abs(lon) <= 180 &&
    !(lat === 0 && lon === 0)
  );
}

/**
 * Pull the fields the timeline needs out of a photo's leading bytes.
 * Photos missing coordinates or a GPS time are rejected rather than guessed at.
 */
export async function extractMetadata(
  ref: PhotoRef,
  bytes: Uint8Array,
): Promise<ExtractResult> {
  let parsed: Record<string, unknown> | undefined;
  try {
    parsed = (await exifr.parse(bytes, {
      gps: true,
      exif: true,
      // `tiff` enables IFD0, where Make/Model/Orientation live.
      tiff: true,
      translateValues: false,
    })) as Record<string, unknown> | undefined;
  } catch (err) {
    return { ok: false, reason: 'unreadable', detail: (err as Error).message };
  }

  if (!parsed) return { ok: false, reason: 'no-exif' };

  const lat = parsed.latitude as number | undefined;
  const lon = parsed.longitude as number | undefined;
  if (!hasRealCoords(lat, lon)) return { ok: false, reason: 'no-gps-coords' };

  const tUtc = gpsTimestampToUtc(parsed.GPSDateStamp, parsed.GPSTimeStamp);
  if (!tUtc) return { ok: false, reason: 'no-gps-time' };

  const altRaw = parsed.GPSAltitude;
  const alt = typeof altRaw === 'number' && Number.isFinite(altRaw) ? altRaw : undefined;

  return {
    ok: true,
    record: {
      id: ref.id,
      filename: ref.filename,
      tUtc: tUtc.toISOString(),
      lat: lat as number,
      lon: lon as number,
      ...(alt !== undefined ? { alt: Math.round(alt * 10) / 10 } : {}),
      ...(typeof parsed.ExifImageWidth === 'number'
        ? { width: parsed.ExifImageWidth as number }
        : {}),
      ...(typeof parsed.ExifImageHeight === 'number'
        ? { height: parsed.ExifImageHeight as number }
        : {}),
      ...(typeof parsed.Orientation === 'number'
        ? { orientation: parsed.Orientation as number }
        : {}),
      ...(typeof parsed.Make === 'string' ? { make: (parsed.Make as string).trim() } : {}),
      ...(typeof parsed.Model === 'string' ? { model: (parsed.Model as string).trim() } : {}),
    },
  };
}
