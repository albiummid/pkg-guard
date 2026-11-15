import * as path from 'path';

/**
 * The package.jsons above a folder, nearest first, up to `top` (or the file system root). Answers are remembered per
 * folder until `invalidate` is called, so repeated edits in one file do not touch the file system.
 */
export function createManifestLookup(exists: (file: string) => boolean) {
  const cache = new Map<string, readonly string[]>();
  return {
    above(dir: string, top: string | undefined): readonly string[] {
      const key = `${top ?? ''}\n${dir}`;
      const hit = cache.get(key);
      if (hit) return hit;
      const out: string[] = [];
      for (let d = dir; ; d = path.dirname(d)) {
        const file = path.join(d, 'package.json');
        if (exists(file)) out.push(file);
        if (d === top || path.dirname(d) === d) break;
      }
      cache.set(key, out);
      return out;
    },
    /** A package.json was created, deleted or moved somewhere. */
    invalidate(): void {
      cache.clear();
    },
  };
}
