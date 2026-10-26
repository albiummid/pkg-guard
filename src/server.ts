// Line-delimited JSON-RPC over stdio, used by the JetBrains plugin. One request per line: {"id":1,"method":"scan","params":{...}}.
// Replies are {"id":1,"result":...} or {"id":1,"error":"message"}. Anything else on stdout would corrupt the stream, so logs go to stderr.
import * as readline from 'readline';
import { bumpTargets } from './bump';
import { formatReport } from './compat';
import { RangeUpdate, compatFor, fixEffect, latestStable, rangeEdits } from './core';
import { Fix, buildFindings } from './findings';
import { clearOsvCache } from './osv';
import { DepEntry } from './packageJson';
import { clearRegistryCache, fetchInfo } from './registry';
import { changelogBetween, fetchMeta, npmUrl } from './repo';
import { Settings, scan } from './scan';
import { compare, isStable } from './semver';

type Params = Record<string, any>;

async function doScan(p: Params) {
  const settings = p.settings as Settings;
  const result = await scan(p.text, p.pkgFile, settings);
  const info: Record<string, { latest?: string; versions: string[]; deprecated: Record<string, string> }> = {};
  const bumps: Record<string, ReturnType<typeof bumpTargets>> = {};
  for (const [name, i] of result.info) {
    // manifests are large and only needed server-side
    info[name] = { latest: i.latest, versions: i.versions.filter(isStable).sort((a, b) => compare(b, a)).slice(0, 80), deprecated: i.deprecated };
    const installed = result.installed.get(name);
    if (installed) bumps[name] = bumpTargets(installed, i.versions);
  }
  return {
    entries: result.entries,
    installed: Object.fromEntries(result.installed),
    findings: buildFindings(result, settings),
    info,
    bumps,
    lock: result.lock,
    pm: result.pm,
    source: result.source,
    notes: result.notes,
  };
}

async function doCompat(p: Params) {
  const info = await fetchInfo(p.name, p.registry);
  if (!info) throw new Error(`Could not read ${p.name} from the registry.`);
  const installed = new Map<string, string>(Object.entries(p.installed ?? {}));
  const report = await compatFor({ text: p.text, pkgFile: p.pkgFile, name: p.name, target: p.target, info, registry: p.registry, installed });
  return { ...report, text: formatReport(p.name, installed.get(p.name), p.target, report) };
}

async function doVersions(p: Params) {
  const info = await fetchInfo(p.name, p.registry);
  if (!info) return null;
  return { latest: latestStable(info), versions: info.versions.filter(isStable).sort((a, b) => compare(b, a)).slice(0, 80), deprecated: info.deprecated };
}

async function doChangelog(p: Params) {
  const meta = await fetchMeta(p.name, p.registry);
  if (!meta?.repo) return { url: npmUrl(p.name) };
  const releases = meta.repo.host === 'github' ? `${meta.repo.url}/releases` : meta.repo.url;
  const res = await changelogBetween(p.name, meta.repo, p.from, p.to);
  return res ? { source: res.source, markdown: res.markdown, url: releases } : { url: releases };
}

async function doRepoUrl(p: Params) {
  const meta = await fetchMeta(p.name, p.registry);
  const url = meta?.repo ? (meta.repo.directory && meta.repo.host === 'github' ? `${meta.repo.url}/tree/HEAD/${meta.repo.directory}` : meta.repo.url) : meta?.homepage;
  return { url: url ?? null, npm: npmUrl(p.name) };
}

const methods: Record<string, (p: Params) => unknown | Promise<unknown>> = {
  ping: () => 'pong',
  scan: doScan,
  compat: doCompat,
  versions: doVersions,
  changelog: doChangelog,
  repoUrl: doRepoUrl,
  rangeEdits: (p) => rangeEdits(p.text, p.updates as RangeUpdate[]),
  fixEffect: (p) => fixEffect(p.text, p.entry as DepEntry, p.fix as Fix),
  clearCache: () => {
    clearOsvCache();
    clearRegistryCache();
    return true;
  },
};

export async function handle(line: string): Promise<string> {
  let id: unknown = null;
  try {
    const req = JSON.parse(line);
    id = req.id ?? null;
    const fn = methods[req.method];
    if (!fn) throw new Error(`unknown method: ${req.method}`);
    return JSON.stringify({ id, result: await fn(req.params ?? {}) });
  } catch (e) {
    return JSON.stringify({ id, error: e instanceof Error ? e.message : String(e) });
  }
}

if (require.main === module) {
  const rl = readline.createInterface({ input: process.stdin, crlfDelay: Infinity });
  rl.on('line', (line) => {
    if (line.trim()) void handle(line).then((out) => process.stdout.write(out + '\n'));
  });
  rl.on('close', () => process.exit(0));
}
