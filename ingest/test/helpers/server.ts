import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';

export interface MockHost {
  url: string;
  /** Bytes actually served, to prove range requests avoid full downloads. */
  bytesServed: () => number;
  requests: () => string[];
  close: () => Promise<void>;
}

export interface MockHostOptions {
  photos: { name: string; body: Buffer }[];
  /** How the directory listing is rendered. */
  listing: 'json' | 'json-objects' | 's3-xml' | 'html-index';
  /** When false, Range headers are ignored and the whole file is returned. */
  supportRanges?: boolean;
}

function renderListing(opts: MockHostOptions): { body: string; type: string } {
  const names = opts.photos.map((p) => p.name);
  switch (opts.listing) {
    case 'json':
      return { body: JSON.stringify(names), type: 'application/json' };
    case 'json-objects':
      return {
        body: JSON.stringify({
          files: opts.photos.map((p) => ({
            name: p.name,
            url: `/${p.name}`,
            size: p.body.length,
            contentType: 'image/jpeg',
          })),
        }),
        type: 'application/json',
      };
    case 's3-xml':
      return {
        body:
          `<?xml version="1.0" encoding="UTF-8"?><ListBucketResult>` +
          opts.photos
            .map((p) => `<Contents><Key>${p.name}</Key><Size>${p.body.length}</Size></Contents>`)
            .join('') +
          `</ListBucketResult>`,
        type: 'application/xml',
      };
    case 'html-index':
      return {
        body:
          `<html><body><h1>Index of /trip</h1><a href="../">../</a>` +
          names.map((n) => `<a href="${n}">${n}</a>`).join('') +
          `<a href="notes.txt">notes.txt</a></body></html>`,
        type: 'text/html',
      };
  }
}

/** An in-process stand-in for a photo host, used to test HttpSource offline. */
export async function startMockHost(options: MockHostOptions): Promise<MockHost> {
  const supportRanges = options.supportRanges ?? true;
  const byName = new Map(options.photos.map((p) => [p.name, p.body]));
  let bytesServed = 0;
  const requests: string[] = [];

  const server: Server = createServer((req, res) => {
    const path = decodeURIComponent((req.url ?? '/').split('?')[0]);
    requests.push(`${req.method} ${path} ${req.headers.range ?? ''}`.trim());

    if (path === '/' || path === '/trip' || path === '/trip/') {
      const { body, type } = renderListing(options);
      if (req.method === 'HEAD') {
        res.writeHead(200, { 'content-type': type, 'accept-ranges': supportRanges ? 'bytes' : 'none' });
        return res.end();
      }
      res.writeHead(200, {
        'content-type': type,
        'accept-ranges': supportRanges ? 'bytes' : 'none',
      });
      return res.end(body);
    }

    const body = byName.get(path.replace(/^\//, ''));
    if (!body) {
      res.writeHead(404);
      return res.end('not found');
    }

    const range = supportRanges ? req.headers.range : undefined;
    if (range) {
      const m = /bytes=(\d+)-(\d*)/.exec(range);
      if (m) {
        const start = Number(m[1]);
        const end = Math.min(m[2] ? Number(m[2]) : body.length - 1, body.length - 1);
        const slice = body.subarray(start, end + 1);
        bytesServed += slice.length;
        res.writeHead(206, {
          'content-type': 'image/jpeg',
          'content-range': `bytes ${start}-${end}/${body.length}`,
          'accept-ranges': 'bytes',
        });
        return res.end(slice);
      }
    }
    bytesServed += body.length;
    res.writeHead(200, { 'content-type': 'image/jpeg', 'content-length': body.length });
    res.end(body);
  });

  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address() as AddressInfo;

  return {
    url: `http://127.0.0.1:${port}/trip`,
    bytesServed: () => bytesServed,
    requests: () => requests,
    close: () => new Promise<void>((resolve) => server.close(() => resolve())),
  };
}
