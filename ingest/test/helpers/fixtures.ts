import sharp from 'sharp';
// @ts-expect-error piexifjs ships no type declarations
import piexif from 'piexifjs';

// piexifjs predates EXIF 2.31 and does not know the offset tags, so register
// the one the fixtures need before dumping.
piexif.TAGS.Exif[36881] = { name: 'OffsetTimeOriginal', type: 'Ascii' };

function toDMS(value: number): [number, number][] {
  const abs = Math.abs(value);
  const deg = Math.floor(abs);
  const min = Math.floor((abs - deg) * 60);
  const sec = Math.round((((abs - deg) * 60) - min) * 6000);
  return [
    [deg, 1],
    [min, 1],
    [sec, 100],
  ];
}

export interface FixtureSpec {
  lat?: number;
  lon?: number;
  /** UTC instant written to GPSDateStamp/GPSTimeStamp. */
  utc?: Date;
  /** Local wall-clock string for DateTimeOriginal, deliberately zone-free. */
  localWallClock?: string;
  altitude?: number;
  make?: string;
  model?: string;
  orientation?: number;
  /** Omit GPS coordinates entirely. */
  noGps?: boolean;
  /** Omit GPS date/time while keeping coordinates. */
  noGpsTime?: boolean;
  /** Write no EXIF at all. */
  noExif?: boolean;
  /**
   * Write the GPS tags but blank their values, mimicking what Android's photo
   * picker does to images handed to an app without ACCESS_MEDIA_LOCATION.
   */
  blankGps?: boolean;
}

/** Build a small JPEG carrying real EXIF, for testing without private photos. */
export async function makePhoto(spec: FixtureSpec = {}): Promise<Buffer> {
  const jpeg = await sharp({
    create: {
      width: 64,
      height: 48,
      channels: 3,
      background: { r: 120, g: 160, b: 200 },
    },
  })
    .jpeg()
    .toBuffer();

  if (spec.noExif) return jpeg;

  const utc = spec.utc ?? new Date('2026-07-14T13:32:07Z');
  const pad = (n: number) => String(n).padStart(2, '0');

  const zeroth: Record<number, unknown> = {};
  if (spec.make) zeroth[piexif.ImageIFD.Make] = spec.make;
  if (spec.model) zeroth[piexif.ImageIFD.Model] = spec.model;
  if (spec.orientation) zeroth[piexif.ImageIFD.Orientation] = spec.orientation;

  const exif: Record<number, unknown> = {
    [piexif.ExifIFD.DateTimeOriginal]:
      spec.localWallClock ??
      `${utc.getUTCFullYear()}:${pad(utc.getUTCMonth() + 1)}:${pad(utc.getUTCDate())} ` +
        `${pad(utc.getUTCHours())}:${pad(utc.getUTCMinutes())}:${pad(utc.getUTCSeconds())}`,
    // Spec names for tags 40962/40963; exifr surfaces these as
    // ExifImageWidth / ExifImageHeight.
    [piexif.ExifIFD.PixelXDimension]: 64,
    [piexif.ExifIFD.PixelYDimension]: 48,
  };

  const gps: Record<number, unknown> = {};
  if (spec.blankGps) {
    gps[piexif.GPSIFD.GPSLatitude] = [[0, 0], [0, 0], [0, 0]];
    gps[piexif.GPSIFD.GPSLongitude] = [[0, 0], [0, 0], [0, 0]];
  } else if (!spec.noGps) {
    const lat = spec.lat ?? 41.3874;
    const lon = spec.lon ?? 2.1686;
    gps[piexif.GPSIFD.GPSLatitudeRef] = lat >= 0 ? 'N' : 'S';
    gps[piexif.GPSIFD.GPSLatitude] = toDMS(lat);
    gps[piexif.GPSIFD.GPSLongitudeRef] = lon >= 0 ? 'E' : 'W';
    gps[piexif.GPSIFD.GPSLongitude] = toDMS(lon);
    if (spec.altitude !== undefined) {
      gps[piexif.GPSIFD.GPSAltitudeRef] = 0;
      gps[piexif.GPSIFD.GPSAltitude] = [Math.round(spec.altitude * 100), 100];
    }
  }
  if (!spec.noGpsTime && !spec.noGps && !spec.blankGps) {
    gps[piexif.GPSIFD.GPSDateStamp] =
      `${utc.getUTCFullYear()}:${pad(utc.getUTCMonth() + 1)}:${pad(utc.getUTCDate())}`;
    gps[piexif.GPSIFD.GPSTimeStamp] = [
      [utc.getUTCHours(), 1],
      [utc.getUTCMinutes(), 1],
      [utc.getUTCSeconds(), 1],
    ];
  }

  const bytes = piexif.insert(
    piexif.dump({ '0th': zeroth, Exif: exif, GPS: gps }),
    jpeg.toString('binary'),
  );
  return Buffer.from(bytes, 'binary');
}

/** A short synthetic route through Barcelona, one photo every ~12 minutes. */
export async function makeRoute(count: number): Promise<{ name: string; body: Buffer }[]> {
  const start = new Date('2026-07-14T09:00:00Z');
  const photos = [];
  for (let i = 0; i < count; i++) {
    photos.push({
      name: `IMG_${String(1000 + i)}.jpg`,
      body: await makePhoto({
        lat: 41.3874 + i * 0.0021,
        lon: 2.1686 + i * 0.0034,
        utc: new Date(start.getTime() + i * 12 * 60_000),
        altitude: 12 + i,
        make: 'Apple',
        model: 'iPhone 15 Pro',
      }),
    });
  }
  return photos;
}
