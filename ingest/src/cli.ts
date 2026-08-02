#!/usr/bin/env node
import { mkdir, writeFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { ingest } from './ingest.js';
import { HttpSource } from './sources/http.js';
import { LocalFolderSource } from './sources/local.js';
import type { PhotoSource, SkipReason } from './types.js';

const USAGE = `
trip-ingest — read photo metadata into a timeline manifest

  trip-ingest --url <listing-url>  [options]
  trip-ingest --dir <folder>       [options]
  trip-ingest --probe --url <url>            inspect a host without ingesting

Options:
  --out <file>          manifest path (default: web/public/trip.json)
  --header "K: V"       extra request header, repeatable (e.g. Authorization)
  --concurrency <n>     parallel reads (default: 8)
  --help

Examples:
  trip-ingest --probe --url https://upload.d0b0.lv/trip
  trip-ingest --url https://upload.d0b0.lv/trip --out web/public/trip.json
`.trim();

interface Args {
  url?: string;
  dir?: string;
  out: string;
  headers: Record<string, string>;
  concurrency: number;
  probe: boolean;
  help: boolean;
}

export function parseArgs(argv: string[]): Args {
  const args: Args = {
    out: 'web/public/trip.json',
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
  'no-gps-coords': 'no GPS coordinates',
  'no-gps-time': 'no GPS timestamp',
  unreadable: 'could not be read',
  'not-an-image': 'not an image',
};

async function main() {
  const args = parseArgs(process.argv.slice(2));
  if (args.help || (!args.url && !args.dir)) {
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

  const source: PhotoSource = args.url
    ? new HttpSource({ baseUrl: args.url, headers: args.headers })
    : new LocalFolderSource(args.dir!);

  console.log(`Reading photos from ${args.url ?? args.dir} …`);
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
