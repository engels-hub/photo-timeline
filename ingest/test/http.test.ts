import { test } from 'node:test';
import assert from 'node:assert/strict';
import { ingest } from '../src/ingest.js';
import { HttpSource } from '../src/sources/http.js';
import { detectFormat, parseListing } from '../src/sources/listing.js';
import { makePhoto, makeRoute } from './helpers/fixtures.js';
import { startMockHost } from './helpers/server.js';

const LISTING_FORMATS = ['json', 'json-objects', 's3-xml', 'html-index'] as const;

for (const listing of LISTING_FORMATS) {
  test(`ingests a route from a ${listing} listing`, async () => {
    const photos = await makeRoute(5);
    const host = await startMockHost({ photos, listing });
    try {
      const manifest = await ingest({ source: new HttpSource({ baseUrl: host.url }) });
      assert.equal(manifest.photoCount, 5);
      assert.equal(manifest.skipped.length, 0);
      assert.equal(manifest.timespan?.start, '2026-07-14T09:00:00.000Z');
      assert.equal(manifest.timespan?.end, '2026-07-14T09:48:00.000Z');
      assert.ok(manifest.bounds);
    } finally {
      await host.close();
    }
  });
}

test('html listing ignores non-image links', () => {
  const refs = parseListing(
    `<a href="../">../</a><a href="a.jpg">a.jpg</a><a href="notes.txt">notes.txt</a>`,
    'http://h/trip',
  );
  assert.equal(refs.length, 1);
  assert.equal(refs[0].filename, 'a.jpg');
});

test('listing format detection', () => {
  assert.equal(detectFormat('[]', 'application/json'), 'json');
  assert.equal(detectFormat('  {"files":[]}'), 'json');
  assert.equal(detectFormat('<?xml?><ListBucketResult><Contents/></ListBucketResult>'), 's3-xml');
  assert.equal(detectFormat('<html><a href="x.jpg">x</a></html>'), 'html-index');
  assert.equal(detectFormat('total garbage'), 'unknown');
});

test('listing resolves relative names against the listing URL', () => {
  const refs = parseListing(JSON.stringify(['IMG_1.jpg']), 'https://upload.example.com/trip/');
  assert.equal(refs[0].location, 'https://upload.example.com/trip/IMG_1.jpg');
});

test('photos are ordered by GPS time regardless of listing order', async () => {
  const photos = [
    { name: 'c.jpg', body: await makePhoto({ utc: new Date('2026-07-14T18:00:00Z') }) },
    { name: 'a.jpg', body: await makePhoto({ utc: new Date('2026-07-14T09:00:00Z') }) },
    { name: 'b.jpg', body: await makePhoto({ utc: new Date('2026-07-14T12:00:00Z') }) },
  ];
  const host = await startMockHost({ photos, listing: 'json' });
  try {
    const manifest = await ingest({ source: new HttpSource({ baseUrl: host.url }) });
    assert.deepEqual(
      manifest.photos.map((p) => p.filename),
      ['a.jpg', 'b.jpg', 'c.jpg'],
    );
  } finally {
    await host.close();
  }
});

test('photos lacking required metadata are skipped with a stated reason', async () => {
  const photos = [
    { name: 'good.jpg', body: await makePhoto({}) },
    { name: 'nogps.jpg', body: await makePhoto({ noGps: true }) },
    { name: 'notime.jpg', body: await makePhoto({ noGpsTime: true }) },
    { name: 'bare.jpg', body: await makePhoto({ noExif: true }) },
  ];
  const host = await startMockHost({ photos, listing: 'json' });
  try {
    const manifest = await ingest({ source: new HttpSource({ baseUrl: host.url }) });
    assert.equal(manifest.photoCount, 1);
    assert.equal(manifest.skipped.length, 3);
    const byName = Object.fromEntries(manifest.skipped.map((s) => [s.filename, s.reason]));
    assert.equal(byName['nogps.jpg'], 'no-gps-coords');
    assert.equal(byName['notime.jpg'], 'no-gps-time');
  } finally {
    await host.close();
  }
});

test('reads metadata via range requests instead of downloading whole photos', async () => {
  // Pad the photos so a full download is obviously distinguishable from a
  // prefix read: this is the property that makes remote ingest practical.
  const base = await makePhoto({});
  const photos = [
    { name: 'big1.jpg', body: Buffer.concat([base, Buffer.alloc(4_000_000, 7)]) },
    { name: 'big2.jpg', body: Buffer.concat([base, Buffer.alloc(4_000_000, 7)]) },
  ];
  const totalSize = photos.reduce((n, p) => n + p.body.length, 0);

  const host = await startMockHost({ photos, listing: 'json' });
  try {
    const manifest = await ingest({ source: new HttpSource({ baseUrl: host.url }) });
    assert.equal(manifest.photoCount, 2);
    assert.ok(
      host.bytesServed() < totalSize * 0.2,
      `expected a small fraction of ${totalSize} bytes, served ${host.bytesServed()}`,
    );
    assert.ok(host.requests().every((r) => !r.startsWith('GET /big') || r.includes('bytes=')));
  } finally {
    await host.close();
  }
});

test('still works against a host that ignores Range requests', async () => {
  const photos = await makeRoute(3);
  const host = await startMockHost({ photos, listing: 'json', supportRanges: false });
  try {
    const source = new HttpSource({ baseUrl: host.url });
    assert.equal(await source.supportsPartialRead(), false);
    const manifest = await ingest({ source });
    assert.equal(manifest.photoCount, 3, 'correctness must not depend on range support');
  } finally {
    await host.close();
  }
});

test('sends configured auth headers on both listing and photo requests', async () => {
  const photos = await makeRoute(1);
  const host = await startMockHost({ photos, listing: 'json' });
  const seen: string[] = [];
  const spyFetch: typeof fetch = (input, init) => {
    seen.push(String((init?.headers as Record<string, string>)?.Authorization ?? ''));
    return fetch(input, init);
  };
  try {
    const source = new HttpSource({
      baseUrl: host.url,
      headers: { Authorization: 'Bearer test-token' },
      fetchImpl: spyFetch,
    });
    await ingest({ source });
    assert.ok(seen.length >= 2);
    assert.ok(seen.every((h) => h === 'Bearer test-token'), 'every request must carry auth');
  } finally {
    await host.close();
  }
});

test('an unparseable listing fails loudly rather than reporting zero photos', async () => {
  const host = await startMockHost({ photos: [], listing: 'json' });
  try {
    const source = new HttpSource({ baseUrl: host.url });
    await assert.rejects(
      () => ingest({ source }),
      /No image entries found/,
      'a silent empty result would look like a successful but empty trip',
    );
  } finally {
    await host.close();
  }
});

test('probe reports what a host supports', async () => {
  const photos = await makeRoute(2);
  const host = await startMockHost({ photos, listing: 'json' });
  try {
    const result = await new HttpSource({ baseUrl: host.url }).probe();
    assert.equal(result.reachable, true);
    assert.equal(result.imagesFound, 2);
    assert.equal(result.acceptsRanges, true);
  } finally {
    await host.close();
  }
});

test('probe reports unreachable hosts without throwing', async () => {
  const result = await new HttpSource({ baseUrl: 'http://127.0.0.1:1/trip' }).probe();
  assert.equal(result.reachable, false);
  assert.ok(result.error);
});
