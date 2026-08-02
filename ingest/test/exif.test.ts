import { test } from 'node:test';
import assert from 'node:assert/strict';
import { extractMetadata, gpsTimestampToUtc } from '../src/exif.js';
import { makePhoto } from './helpers/fixtures.js';

const ref = { id: 'x', filename: 'x.jpg', location: '/x.jpg' };

test('gpsTimestampToUtc handles the numeric-triple form', () => {
  const d = gpsTimestampToUtc('2026:07:14', [13, 32, 7]);
  assert.equal(d?.toISOString(), '2026-07-14T13:32:07.000Z');
});

test('gpsTimestampToUtc handles the unpadded string form exifr can return', () => {
  // exifr returns e.g. "13:32:7" for some encodings; naive splitting on ":"
  // and assuming two digits would misread the seconds.
  const d = gpsTimestampToUtc('2026:07:14', '13:32:7');
  assert.equal(d?.toISOString(), '2026-07-14T13:32:07.000Z');
});

test('gpsTimestampToUtc rejects malformed or out-of-range values', () => {
  assert.equal(gpsTimestampToUtc(null, [1, 2, 3]), null);
  assert.equal(gpsTimestampToUtc('2026:07:14', null), null);
  assert.equal(gpsTimestampToUtc('nonsense', '13:32:7'), null);
  assert.equal(gpsTimestampToUtc('2026:13:14', '13:32:7'), null, 'month 13');
  assert.equal(gpsTimestampToUtc('2026:07:14', '25:00:00'), null, 'hour 25');
});

test('GPS time is used as the instant, not the zone-free DateTimeOriginal', async () => {
  // The photo claims 15:32 local wall-clock but 13:32 UTC via GPS: a CEST
  // capture. Trusting DateTimeOriginal would place it two hours late.
  const photo = await makePhoto({
    utc: new Date('2026-07-14T13:32:07Z'),
    localWallClock: '2026:07:14 15:32:07',
  });
  const result = await extractMetadata(ref, photo);
  assert.ok(result.ok);
  assert.equal(result.record.tUtc, '2026-07-14T13:32:07.000Z');
});

test('extracts coordinates, altitude and camera identity', async () => {
  const photo = await makePhoto({
    lat: 41.3874,
    lon: 2.1686,
    altitude: 123.4,
    make: 'Apple',
    model: 'iPhone 15 Pro',
    orientation: 6,
  });
  const result = await extractMetadata(ref, photo);
  assert.ok(result.ok);
  assert.ok(Math.abs(result.record.lat - 41.3874) < 1e-5);
  assert.ok(Math.abs(result.record.lon - 2.1686) < 1e-5);
  assert.equal(result.record.alt, 123.4);
  assert.equal(result.record.make, 'Apple');
  assert.equal(result.record.model, 'iPhone 15 Pro');
  assert.equal(result.record.orientation, 6);
});

test('handles southern and western hemispheres', async () => {
  const photo = await makePhoto({ lat: -33.8688, lon: -151.2093 });
  const result = await extractMetadata(ref, photo);
  assert.ok(result.ok);
  assert.ok(result.record.lat < 0, 'latitude should stay negative');
  assert.ok(result.record.lon < 0, 'longitude should stay negative');
});

test('skips photos with no EXIF at all', async () => {
  const result = await extractMetadata(ref, await makePhoto({ noExif: true }));
  assert.equal(result.ok, false);
  assert.ok(result.ok === false && ['no-exif', 'no-gps-coords'].includes(result.reason));
});

test('skips photos with no GPS coordinates', async () => {
  const result = await extractMetadata(ref, await makePhoto({ noGps: true }));
  assert.equal(result.ok, false);
  assert.ok(result.ok === false && result.reason === 'no-gps-coords');
});

test('skips photos that have coordinates but no GPS timestamp', async () => {
  const result = await extractMetadata(ref, await makePhoto({ noGpsTime: true }));
  assert.equal(result.ok, false);
  assert.ok(result.ok === false && result.reason === 'no-gps-time');
});

test('treats 0,0 as a missing fix rather than Null Island', async () => {
  const result = await extractMetadata(ref, await makePhoto({ lat: 0, lon: 0 }));
  assert.equal(result.ok, false);
  assert.ok(result.ok === false && result.reason === 'no-gps-coords');
});
