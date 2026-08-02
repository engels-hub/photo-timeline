import { readdir, readFile, stat, open } from 'node:fs/promises';
import { join, relative, resolve } from 'node:path';
import type { PhotoRef, PhotoSource } from '../types.js';
import { looksLikeImage } from './listing.js';

/** Reads photos from a directory tree. Used for local trips and for tests. */
export class LocalFolderSource implements PhotoSource {
  readonly kind = 'local';
  private readonly root: string;

  constructor(root: string) {
    this.root = resolve(root);
  }

  async *list(): AsyncIterable<PhotoRef> {
    yield* this.walk(this.root);
  }

  private async *walk(dir: string): AsyncIterable<PhotoRef> {
    const entries = await readdir(dir, { withFileTypes: true });
    // Stable ordering so repeated runs produce identical manifests.
    entries.sort((a, b) => a.name.localeCompare(b.name));
    for (const entry of entries) {
      const full = join(dir, entry.name);
      if (entry.isDirectory()) {
        yield* this.walk(full);
      } else if (entry.isFile() && looksLikeImage(entry.name)) {
        const info = await stat(full);
        yield {
          id: relative(this.root, full),
          filename: entry.name,
          location: full,
          byteSize: info.size,
        };
      }
    }
  }

  async readPrefix(ref: PhotoRef, bytes: number): Promise<Uint8Array> {
    const handle = await open(ref.location, 'r');
    try {
      const buf = new Uint8Array(bytes);
      const { bytesRead } = await handle.read(buf, 0, bytes, 0);
      return buf.subarray(0, bytesRead);
    } finally {
      await handle.close();
    }
  }

  async readFull(ref: PhotoRef): Promise<Uint8Array> {
    return new Uint8Array(await readFile(ref.location));
  }

  async supportsPartialRead(): Promise<boolean> {
    return true;
  }
}
