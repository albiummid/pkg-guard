import { compare, parse } from './semver';

export interface RepoRef {
  url: string;
  directory?: string;
  host?: 'github';
  owner?: string;
  repo?: string;
}

/** Turns package.json `repository` values (string, object, git+https, git://, github: shorthand, ssh) into a browsable URL. */
export function normalizeRepo(r: unknown): RepoRef | null {
  let raw: string | undefined;
  let directory: string | undefined;
  if (typeof r === 'string') raw = r;
  else if (r && typeof r === 'object') {
    raw = (r as any).url;
    directory = (r as any).directory;
  }
  if (!raw) return null;
  let s = raw.trim().replace(/^git\+/, '');
  let m: RegExpExecArray | null;
  if ((m = /^(?:github:)?([\w.-]+)\/([\w.-]+)$/.exec(s))) s = `https://github.com/${m[1]}/${m[2]}`;
  else if ((m = /^(gitlab|bitbucket):([\w.-]+)\/([\w.-]+)$/.exec(s))) s = `https://${m[1]}.${m[1] === 'gitlab' ? 'com' : 'org'}/${m[2]}/${m[3]}`;
  else if ((m = /^git@([^:]+):(.+)$/.exec(s))) s = `https://${m[1]}/${m[2]}`;
  else s = s.replace(/^git:\/\//, 'https://').replace(/^ssh:\/\/git@/, 'https://');
  s = s.replace(/\.git$/, '').replace(/\/$/, '');
  if (!/^https?:\/\//.test(s)) return null;
  const gh = /^https:\/\/github\.com\/([\w.-]+)\/([\w.-]+)/.exec(s);
  return gh ? { url: `https://github.com/${gh[1]}/${gh[2]}`, directory, host: 'github', owner: gh[1], repo: gh[2] } : { url: s, directory };
}

export interface PackageMeta {
  repo: RepoRef | null;
  homepage?: string;
  bugs?: string;
}

export async function fetchMeta(name: string, registry: string): Promise<PackageMeta | null> {
  try {
    const res = await fetch(`${registry.replace(/\/$/, '')}/${name.replace('/', '%2f')}/latest`, { signal: AbortSignal.timeout(15000) });
    if (!res.ok) return null;
    const j: any = await res.json();
    return { repo: normalizeRepo(j.repository), homepage: j.homepage, bugs: typeof j.bugs === 'string' ? j.bugs : j.bugs?.url };
  } catch {
    return null;
  }
}

export function npmUrl(name: string): string {
  return `https://www.npmjs.com/package/${name}`;
}

const VER_AT_END = /(\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?)$/;

/** Version a release tag stands for ("v1.2.3", "pkg@1.2.3", "pkg-v1.2.3"), or null. */
export function tagVersion(tag: string): string | null {
  return VER_AT_END.exec(tag.trim())?.[1] ?? null;
}

function inRange(v: string, from: string, to: string): boolean {
  return compare(v, from) > 0 && compare(v, to) <= 0;
}

/** Sections of a CHANGELOG.md whose heading names a version in (from, to]. */
export function sliceChangelog(md: string, from: string, to: string): string | null {
  const heads = [...md.matchAll(/^#{1,3}\s+.*$/gm)];
  const out: string[] = [];
  heads.forEach((h, i) => {
    const v = /\[?v?(\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?)\]?/.exec(h[0])?.[1];
    if (!v || !parse(v) || !inRange(v, from, to)) return;
    out.push(md.slice(h.index!, heads[i + 1]?.index ?? md.length).trimEnd());
  });
  return out.length ? out.join('\n\n') : null;
}

interface GhRelease {
  tag_name: string;
  body?: string;
  html_url?: string;
}

const CACHE_MS = 10 * 60 * 1000;
const releaseCache = new Map<string, { t: number; list: GhRelease[] }>();
const changelogCache = new Map<string, { t: number; text: string | null; file: string }>();

/** GitHub Releases of a repo (cached: the anonymous API allows only 60 requests an hour). */
async function fetchReleases(repo: RepoRef): Promise<GhRelease[]> {
  const key = `${repo.owner}/${repo.repo}`;
  const hit = releaseCache.get(key);
  if (hit && Date.now() - hit.t < CACHE_MS) return hit.list;
  const list: GhRelease[] = [];
  try {
    for (let page = 1; page <= 3; page++) {
      const res = await fetch(`https://api.github.com/repos/${key}/releases?per_page=100&page=${page}`, {
        headers: { accept: 'application/vnd.github+json', 'user-agent': 'pkg-guard' },
        signal: AbortSignal.timeout(15000),
      });
      if (!res.ok) break;
      const batch = (await res.json()) as GhRelease[];
      list.push(...batch);
      if (batch.length < 100) break;
    }
  } catch {
    /* keep whatever was fetched */
  }
  releaseCache.set(key, { t: Date.now(), list });
  return list;
}

async function fetchChangelogFile(repo: RepoRef): Promise<{ text: string | null; file: string }> {
  const key = `${repo.owner}/${repo.repo}/${repo.directory ?? ''}`;
  const hit = changelogCache.get(key);
  if (hit && Date.now() - hit.t < CACHE_MS) return hit;
  const base = repo.directory ? `${repo.directory}/` : '';
  let found: { text: string | null; file: string } = { text: null, file: '' };
  for (const file of ['CHANGELOG.md', 'Changelog.md', 'changelog.md', 'CHANGES.md', 'HISTORY.md']) {
    try {
      const res = await fetch(`https://raw.githubusercontent.com/${repo.owner}/${repo.repo}/HEAD/${base}${file}`, { signal: AbortSignal.timeout(15000) });
      if (!res.ok) continue;
      found = { text: await res.text(), file };
      break;
    } catch {
      /* try next */
    }
  }
  changelogCache.set(key, { t: Date.now(), ...found });
  return found;
}

/** Release notes for versions in (from, to]: GitHub Releases first, then CHANGELOG.md in the repo. */
export async function changelogBetween(name: string, repo: RepoRef, from: string, to: string): Promise<{ markdown: string; source: string } | null> {
  if (repo.host !== 'github') return null;
  const notes: { v: string; tag: string; body: string; url?: string }[] = [];
  for (const r of await fetchReleases(repo)) {
    const v = tagVersion(r.tag_name ?? '');
    // monorepos tag several packages; keep tags that name this package or are bare versions
    const forThis = /^v?\d/.test(r.tag_name) || r.tag_name.startsWith(`${name}@`) || r.tag_name.includes(name.split('/').pop()!);
    if (v && forThis && inRange(v, from, to)) notes.push({ v, tag: r.tag_name, body: r.body ?? '', url: r.html_url });
  }
  if (notes.length) {
    notes.sort((a, b) => compare(b.v, a.v));
    return {
      source: 'GitHub Releases',
      markdown: notes.map((n) => `## ${n.url ? `[${n.tag}](${n.url})` : n.tag}\n\n${n.body.trim() || '_No release notes._'}`).join('\n\n---\n\n'),
    };
  }
  const { text, file } = await fetchChangelogFile(repo);
  const slice = text ? sliceChangelog(text, from, to) : null;
  return slice ? { markdown: slice, source: file } : null;
}
