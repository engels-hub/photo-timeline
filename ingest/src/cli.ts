#!/usr/bin/env node
import { mkdir, writeFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { ingest } from './ingest.js';
import { D0b0Source } from './sources/d0b0.js';
import { HttpSource } from './sources/http.js';
import { LocalFolderSource } from './sources/local.js';
import type { PhotoSource, SkipReason } from './types.js';

const USAGE = `
trip-ingest — read photo metadata into a timeline manifest

  trip-ingest --d0b0               [options]   the shared upload.d0b0.lv album
  trip-ingest --url <listing-url>  [options]
  trip-ingest --dir <folder>       [options]
  trip-ingest --probe --url <url>              inspect a host without ingesting

Options:
  --out <file>          manifest path (default: web/public/trip.json)
  --folder <name>       album folder for --d0b0 (default: Trip_photos)
  --cookie <value>      trip_auth cookie; or set TRIP_AUTH_COOKIE
  --header "K: V"       extra request header, repeatable
  --concurrency <n>     parallel reads (default: 8)
  --help

Examples:
  TRIP_AUTH_COOKIE=… trip-ingest --d0b0
  trip-ingest --dir ~/Pictures/trip --out web/public/trip.json

The cookie is a secret: pass it via the environment rather than committing it.
`.trim();

interface Args {
  url?: string;
  dir?: string;
  d0b0: boolean;
  folder?: string;
  cookie?: string;
  out: string;
  headers: Record<string, string>;
  concurrency: number;
  probe: boolean;
  help: boolean;
}

export function parseArgs(argv: string[]): Args {
  const args: Args = {
    out: 'web/public/trip.json',
    d0b0: false,
    headers: {},
    concurrency: 8,
    probe: false,
    help: false,
  };
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    const next = () => {
      const value = argv[++i];
      if (value === undefined) throw new Error(`${arg} needs a value`);
      return value;
    };
    switch (arg) {
      case '--url':
        args.url = next();
        break;
      case '--dir':
        args.dir = next();
        break;
      case '--out':
        args.out = next();
        break;
      case '--concurrency':
        args.concurrency = Number(next());
        break;
      case '--d0b0':
        args.d0b0 = true;
        break;
      case '--folder':
        args.folder = next();
        break;
      case '--cookie':
        args.cookie = next();
        break;
      case '--probe':
        args.probe = true;
        break;
      case '--help':
      case '-h':
        args.help = true;
        break;
      case '--header': {
        const raw = next();
        const idx = raw.indexOf(':');
        if (idx === -1) throw new Error(`--header expects "Key: Value", got "${raw}"`);
        args.headers[raw.slice(0, idx).trim()] = raw.slice(idx + 1).trim();
        break;
      }
      default:
        throw new Error(`Unknown option: ${arg}`);
    }
  }
  return args;
}

const SKIP_LABELS: Record<SkipReason, string> = {
  'no-exif': 'no EXIF block',
  'gps-redacted': 'GPS tags present but blanked out (stripped before upload)',
  'no-gps-coords': 'no GPS coordinates',
  'no-gps-time': 'no GPS timestamp',
  unreadable: 'could not be read',
  'not-an-image': 'not an image',
};

async function main() {
  const args = parseArgs(process.argv.slice(2));
  if (args.help || (!args.url && !args.dir && !args.d0b0)) {
    console.log(USAGE);
    process.exit(args.help ? 0 : 1);
  }
  if (args.url && args.dir) throw new Error('Use either --url or --dir, not both');

  if (args.probe) {
    if (!args.url) throw new Error('--probe requires --url');
    const source = new HttpSource({ baseUrl: args.url, headers: args.headers });
    console.log(`Probing ${args.url} …`);
    const result = await source.probe();
    console.log(JSON.stringify(result, null, 2));
    if (!result.reachable) {
      console.error('\nHost not reachable. If this runs inside a sandbox, its egress');
      console.error('policy may be blocking the host rather than the host being down.');
      process.exit(1);
    }
    if (result.acceptsRanges === false) {
      console.warn('\nHost ignores Range requests: ingest must download full photos.');
    }
    return;
  }

  const cookie = args.cookie ?? process.env.TRIP_AUTH_COOKIE;
  const source: PhotoSource = args.d0b0
    ? new D0b0Source({
        ...(args.folder ? { folder: args.folder } : {}),
        ...(cookie ? { authCookie: cookie } : {}),
      })
    : args.url
      ? new HttpSource({ baseUrl: args.url, headers: args.headers })
      : new LocalFolderSource(args.dir!);

  const label = args.d0b0 ? `upload.d0b0.lv/${args.folder ?? 'Trip_photos'}` : (args.url ?? args.dir);
  if (args.d0b0 && !cookie) {
    console.warn('No trip_auth cookie given; the album will likely refuse the request.');
  }
  console.log(`Reading photos from ${label} …`);
  const started = Date.now();

  const manifest = await ingest({
    source,
    concurrency: args.concurrency,
    onProgress: (done) => {
      if (done % 25 === 0) process.stderr.write(`\r  ${done} photos read…`);
    },
  });
  process.stderr.write('\r\x1b[K');

  const outPath = resolve(args.out);
  await mkdir(dirname(outPath), { recursive: true });
  await writeFile(outPath, JSON.stringify(manifest, null, 2));

  const seconds = ((Date.now() - started) / 1000).toFixed(1);
  console.log(`\n${manifest.photoCount} photos mapped in ${seconds}s → ${args.out}`);

  if (manifest.timespan) {
    console.log(`  ${manifest.timespan.start} → ${manifest.timespan.end}`);
  }
  if (manifest.bounds) {
    const b = manifest.bounds;
    console.log(
      `  bounds ${b.minLat.toFixed(4)},${b.minLon.toFixed(4)} → ` +
        `${b.maxLat.toFixed(4)},${b.maxLon.toFixed(4)}`,
    );
  }

  if (manifest.skipped.length) {
    const counts = new Map<SkipReason, number>();
    for (const s of manifest.skipped) counts.set(s.reason, (counts.get(s.reason) ?? 0) + 1);
    console.log(`\n  ${manifest.skipped.length} skipped:`);
    for (const [reason, count] of counts) {
      console.log(`    ${count} × ${SKIP_LABELS[reason]}`);
    }
  }
}

main().catch((err) => {
  console.error(`\nError: ${err.message}`);
  process.exit(1);
});
