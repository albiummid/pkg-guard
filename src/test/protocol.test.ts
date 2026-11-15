// The Kotlin model of the sidecar's JSON (platforms/jetbrains/.../Model.kt) must match the TypeScript types in src/types.
// Both sides are parsed into the same canonical shapes and compared, so adding, renaming or retyping a field on one side only fails here.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'fs';
import * as path from 'path';

const root = path.resolve(__dirname, '../..');
const typesDir = path.join(root, 'src/types');
const modelFile = path.join(root, 'platforms/jetbrains/src/main/kotlin/dev/pkgguard/Model.kt');

/** Kotlin class -> TypeScript type, where the names differ. */
const TS_NAME: Record<string, string> = { Entry: 'DepEntry', Pm: 'PackageManager', CompanionUpdate: 'Companion', Bump: 'BumpTargets', RepoUrl: 'RepoUrlResponse' };
/** TypeScript fields the plugin deliberately does not read. */
const UNREAD: Record<string, string[]> = { UpgradeReportResponse: ['report'] };

interface Field { optional: boolean; type: string }
type Shape = Record<string, Field>;

const strip = (text: string) => text.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/[^\n]*/g, '');

/** Splits on separators that are not nested in <>, (), {} or []. */
function splitTop(text: string, separators: string): string[] {
  const parts: string[] = [];
  let depth = 0;
  let current = '';
  for (const ch of text) {
    if ('<({['.includes(ch)) depth++;
    if ('>)}]'.includes(ch)) depth--;
    if (depth === 0 && separators.includes(ch)) {
      parts.push(current);
      current = '';
    } else current += ch;
  }
  parts.push(current);
  return parts.map((part) => part.trim()).filter(Boolean);
}

function matching(text: string, open: number): number {
  let depth = 0;
  for (let i = open; i < text.length; i++) {
    if ('{(['.includes(text[i])) depth++;
    if ('})]'.includes(text[i]) && --depth === 0) return i;
  }
  throw new Error('unbalanced brackets');
}

// ---- TypeScript side ----

const interfaces = new Map<string, string>(); // name -> body, `...Base;` first when it extends one
const unions = new Map<string, string[]>(); // name -> bodies of the object members
const aliases = new Map<string, string>(); // name -> type text

for (const file of fs.readdirSync(typesDir).filter((name) => name.endsWith('.ts'))) {
  const text = strip(fs.readFileSync(path.join(typesDir, file), 'utf8'));
  for (const match of text.matchAll(/export interface (\w+)(?: extends (\w+))? \{/g)) {
    const open = match.index! + match[0].length - 1;
    const body = text.slice(open + 1, matching(text, open));
    interfaces.set(match[1], match[2] ? `...${match[2]};${body}` : body);
  }
  for (const match of text.matchAll(/export type (\w+) =/g)) {
    const start = match.index! + match[0].length;
    let end = start;
    let depth = 0;
    for (; end < text.length; end++) {
      if ('{(['.includes(text[end])) depth++;
      if ('})]'.includes(text[end])) depth--;
      if (depth === 0 && text[end] === ';') break;
    }
    const value = text.slice(start, end).trim();
    const members = splitTop(value, '|');
    if (members.every((member) => member.startsWith('{'))) unions.set(match[1], members.map((member) => member.slice(1, -1)));
    else aliases.set(match[1], value);
  }
}

function tsFields(body: string, only?: string): Shape {
  const shape: Shape = {};
  for (const member of splitTop(body, ';')) {
    if (member.startsWith('...')) {
      Object.assign(shape, tsShape(member.slice(3)));
      continue;
    }
    const match = /^(\w+)(\?)?:\s*([\s\S]+)$/.exec(member);
    if (!match) throw new Error(`cannot read TypeScript member: ${member}`);
    if (only && match[1] !== only) continue;
    const nullable = /\|\s*null$/.test(match[3]);
    shape[match[1]] = { optional: !!match[2] || nullable, type: tsType(match[3].replace(/\s*\|\s*null$/, '')) };
  }
  return shape;
}

function tsShape(name: string): Shape {
  const body = interfaces.get(name);
  if (body !== undefined) return tsFields(body);
  const members = unions.get(name);
  if (members) {
    const shapes = members.map((member) => tsFields(member));
    const merged: Shape = {};
    for (const shape of shapes) for (const [key, field] of Object.entries(shape)) merged[key] ??= { ...field };
    for (const [key, field] of Object.entries(merged)) field.optional = shapes.some((shape) => !shape[key] || shape[key].optional);
    return merged;
  }
  const alias = aliases.get(name);
  const partial = alias && /^Partial<Record<(\w+),\s*(\w+)>>$/.exec(alias);
  if (partial) {
    const keys = splitTop(aliases.get(partial[1])!, '|').map((key) => key.replace(/'/g, ''));
    return Object.fromEntries(keys.map((key) => [key, { optional: true, type: tsType(partial[2]) }]));
  }
  throw new Error(`unknown TypeScript type ${name}`);
}

/** The canonical form of a TypeScript type: String, Int, Boolean, [item], {value of a map} or the name of an object shape. */
function tsType(text: string, seen = new Set<string>()): string {
  const type = text.trim();
  const parts = splitTop(type, '|');
  if (parts.length > 1) {
    const types = new Set(parts.map((part) => tsType(part, seen)));
    if (types.size !== 1) throw new Error(`cannot compare a mixed union: ${type}`);
    return [...types][0];
  }
  if (type.endsWith('[]')) return `[${tsType(type.slice(0, -2), seen)}]`;
  const map = /^(?:Record|Map)<string,\s*([\s\S]+)>$/.exec(type);
  if (map) return `{${tsType(map[1], seen)}}`;
  if (type === 'string' || /^'[^']*'$/.test(type)) return 'String';
  if (type === 'number') return 'Int';
  if (type === 'boolean') return 'Boolean';
  const indexed = /^(\w+)\['(\w+)'\]$/.exec(type);
  if (indexed) {
    // Only the named field is read: the rest of that type may use types the plugin never sees (Map, Set).
    const body = interfaces.get(indexed[1]);
    const field = body === undefined ? undefined : tsFields(body, indexed[2])[indexed[2]];
    if (!field) throw new Error(`no field ${type}`);
    return field.type;
  }
  if (interfaces.has(type) || unions.has(type)) return type;
  const alias = aliases.get(type);
  if (alias !== undefined) {
    if (/^Partial</.test(alias)) return type;
    if (seen.has(type)) throw new Error(`recursive alias ${type}`);
    return tsType(alias, new Set(seen).add(type));
  }
  throw new Error(`cannot read TypeScript type: ${type}`);
}

// ---- Kotlin side ----

interface KotlinField extends Field { nullable: boolean }

function kotlinType(text: string): string {
  const type = text.trim().replace(/\?$/, '');
  const list = /^List<([\s\S]+)>$/.exec(type);
  if (list) return `[${kotlinType(list[1])}]`;
  const map = /^Map<String,\s*([\s\S]+)>$/.exec(type);
  if (map) return `{${kotlinType(map[1])}}`;
  return TS_NAME[type] ?? type;
}

function kotlinClasses(): Map<string, Record<string, KotlinField>> {
  const text = strip(fs.readFileSync(modelFile, 'utf8'));
  const classes = new Map<string, Record<string, KotlinField>>();
  for (const match of text.matchAll(/data class (\w+)\(/g)) {
    const open = match.index! + match[0].length - 1;
    const shape: Record<string, KotlinField> = {};
    for (const param of splitTop(text.slice(open + 1, matching(text, open)), ',')) {
      const field = /^val (\w+):\s*([^=]+?)\s*(=[\s\S]*)?$/.exec(param);
      if (!field) throw new Error(`cannot read Kotlin parameter in ${match[1]}: ${param}`);
      const nullable = field[2].endsWith('?');
      // A default value makes the field safe to leave out of the JSON, like an optional TypeScript field.
      shape[field[1]] = { nullable, optional: nullable || field[3] !== undefined, type: kotlinType(field[2]) };
    }
    classes.set(match[1], shape);
  }
  return classes;
}

// ---- Comparison ----

test('the Kotlin protocol model matches the TypeScript types', () => {
  const kotlin = kotlinClasses();
  assert.ok(kotlin.size > 10, 'Model.kt should declare the protocol classes');
  const problems: string[] = [];
  for (const [kName, kShape] of kotlin) {
    const tName = TS_NAME[kName] ?? kName;
    let tShape: Shape;
    try {
      tShape = tsShape(tName);
    } catch (error) {
      problems.push(`${kName}: cannot read TypeScript type ${tName}: ${(error as Error).message}`);
      continue;
    }
    for (const [field, k] of Object.entries(kShape)) {
      const t = tShape[field];
      if (!t) {
        problems.push(`${kName}.${field}: not in TypeScript ${tName}`);
        continue;
      }
      if (k.type !== t.type) problems.push(`${kName}.${field}: Kotlin ${k.type}, TypeScript ${t.type}`);
      if (k.nullable && !t.optional) problems.push(`${kName}.${field}: nullable in Kotlin but required in TypeScript`);
      if (t.optional && !k.optional) problems.push(`${kName}.${field}: optional in TypeScript but neither nullable nor defaulted in Kotlin`);
    }
    for (const field of Object.keys(tShape)) {
      if (!kShape[field] && !UNREAD[kName]?.includes(field)) problems.push(`${kName}.${field}: in TypeScript ${tName} but missing in Kotlin`);
    }
  }
  assert.deepEqual(problems, [], `Model.kt and src/types disagree:\n  ${problems.join('\n  ')}`);
});

test('the check notices a disagreement', () => {
  assert.equal(kotlinType('List<Entry>?'), '[DepEntry]');
  assert.equal(tsType('Record<string, string[]>'), '{[String]}');
  assert.notEqual(tsType('number'), kotlinType('String'));
});
