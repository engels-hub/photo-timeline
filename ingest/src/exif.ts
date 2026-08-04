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

/**
 * "2026:07:13 15:11:16" + "+03:00" -> an exact instant.
 *
 * DateTimeOriginal alone is unusable, being a wall clock with no zone, but
 * paired with OffsetTimeOriginal (EXIF 2.31) it is precise. Both phones in the
 * real album write the offset, which matters because their GPS timestamps were
 * redacted — see resolveTime.
 */
export function offsetTimeToUtc(dateTimeOriginal: unknown, offset: unknown): Date | null {
  if (typeof dateTimeOriginal !== 'string' || typeof offset !== 'string') return null;
  const m = /^(\d{4}):(\d{2}):(\d{2})[ T](\d{2}):(\d{2}):(\d{2})/.exec(dateTimeOriginal.trim());
  if (!m) return null;
  const off = /^([+-])(\d{2}):?(\d{2})$/.exec(offset.trim());
  if (!off) return null;

  const [, y, mo, d, h, mi, s] = m;
  const sign = off[1] === '-' ? -1 : 1;
  const offsetMinutes = sign * (Number(off[2]) * 60 + Number(off[3]));

  const ms = Date.UTC(Number(y), Number(mo) - 1, Number(d), Number(h), Number(mi), Number(s));
  const date = new Date(ms - offsetMinutes * 60_000);
  return Number.isNaN(date.getTime()) ? null : date;
}

export type TimeSource = 'gps' | 'exif-offset';

/**
 * Resolve one true UTC instant.
 *
 * GPS time is preferred: it is UTC by spec and needs no interpretation. But
 * every photo in the real album has its GPS block redacted, so the offset pair
 * is a required fallback rather than a nicety. Both yield an exact instant; a
 * bare DateTimeOriginal with no offset does not, and is refused.
 */
export function resolveTime(
  parsed: Record<string, unknown>,
): { tUtc: Date; timeSource: TimeSource } | null {
  const fromGps = gpsTimestampToUtc(parsed.GPSDateStamp, parsed.GPSTimeStamp);
  if (fromGps) return { tUtc: fromGps, timeSource: 'gps' };

  const fromOffset = offsetTimeToUtc(
    parsed.DateTimeOriginal ?? parsed.DateTimeDigitized,
    parsed.OffsetTimeOriginal ?? parsed.OffsetTimeDigitized ?? parsed.OffsetTime,
  );
  if (fromOffset) return { tUtc: fromOffset, timeSource: 'exif-offset' };

  return null;
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
 * Distinguish "this photo never had a fix" from "the coordinates were removed".
 *
 * A stripping tool — notably Android's photo picker, which redacts location
 * for apps lacking ACCESS_MEDIA_LOCATION — leaves the GPS IFD entries in place
 * and blanks their values, so GPSLatitude arrives as [null, null, null] and
 * exifr computes NaN. A camera that simply had no fix omits the tags entirely.
 *
 * The difference matters: redaction happened somewhere in the upload path and
 * can be avoided, whereas a missing fix cannot be recovered at all.
 */
function classifyMissingCoords(parsed: Record<string, unknown>): SkipReason {
  const hasGpsTags = Object.keys(parsed).some((k) => k.startsWith('GPS'));
  const blanked =
    Number.isNaN(parsed.latitude as number) || Number.isNaN(parsed.longitude as number);
  return hasGpsTags && blanked ? 'gps-redacted' : 'no-gps-coords';
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
  if (!hasRealCoords(lat, lon)) {
    return { ok: false, reason: classifyMissingCoords(parsed) };
  }

  const time = resolveTime(parsed);
  if (!time) return { ok: false, reason: 'no-gps-time' };
  const { tUtc, timeSource } = time;

  const altRaw = parsed.GPSAltitude;
  const alt = typeof altRaw === 'number' && Number.isFinite(altRaw) ? altRaw : undefined;

  return {
    ok: true,
    record: {
      id: ref.id,
      filename: ref.filename,
      tUtc: tUtc.toISOString(),
      timeSource,
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
