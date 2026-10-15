/**
 * What changed between two copies of openapi.yaml, for the spec-sync pull
 * request: which operations were added, removed or changed in what a request
 * may carry, which of them the CLI calls, and a conventional-commit title that
 * says so.
 *
 * Only the request side counts, as it does for src/generated: an operation
 * changed when its method, path, parameters or body changed, or any schema
 * they refer to, however deep. Prose and responses do not count.
 *
 * Usage:
 *   node scripts/spec-diff.mjs <old openapi.yaml> <new openapi.yaml>          markdown
 *   node scripts/spec-diff.mjs --title <old openapi.yaml> <new openapi.yaml>  the title
 */
import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { parse } from 'yaml';

const args = process.argv.slice(2);
const titleOnly = args[0] === '--title';
const [before, after] = (titleOnly ? args.slice(1) : args).map((file) => parse(readFileSync(file, 'utf8')));
if (!before || !after) {
  console.error('usage: node scripts/spec-diff.mjs [--title] <old openapi.yaml> <new openapi.yaml>');
  process.exit(1);
}

const METHODS = ['get', 'post', 'put', 'patch', 'delete'];
const PROSE = new Set(['description', 'summary', 'title', 'example', 'examples', 'externalDocs']);
const SCHEMA_REF = '#/components/schemas/';

function withoutProse(node) {
  if (Array.isArray(node)) return node.map(withoutProse);
  if (!node || typeof node !== 'object') return node;
  return Object.fromEntries(
    Object.entries(node)
      .filter(([key]) => !PROSE.has(key))
      .map(([key, value]) => [key, withoutProse(value)])
  );
}

function lookup(spec, ref) {
  return ref
    .slice(2)
    .split('/')
    .reduce((node, part) => node?.[part.replace(/~1/g, '/').replace(/~0/g, '~')], spec);
}

/** A parameter or body with the references to other parameters and bodies followed; schemas stay named. */
function expanded(spec, node) {
  if (Array.isArray(node)) return node.map((item) => expanded(spec, item));
  if (!node || typeof node !== 'object') return node;
  if (typeof node.$ref === 'string' && !node.$ref.startsWith(SCHEMA_REF))
    return expanded(spec, lookup(spec, node.$ref));
  return Object.fromEntries(Object.entries(node).map(([key, value]) => [key, expanded(spec, value)]));
}

/** Every named schema a node refers to, and those refer to, and so on. */
function reach(spec, node, found = new Set()) {
  if (Array.isArray(node)) node.forEach((item) => reach(spec, item, found));
  else if (node && typeof node === 'object') {
    if (typeof node.$ref === 'string' && node.$ref.startsWith(SCHEMA_REF)) {
      const name = node.$ref.slice(SCHEMA_REF.length);
      if (!found.has(name)) {
        found.add(name);
        reach(spec, spec.components?.schemas?.[name], found);
      }
    }
    for (const value of Object.values(node)) reach(spec, value, found);
  }
  return found;
}

function operations(spec) {
  const out = new Map();
  for (const [path, item] of Object.entries(spec.paths ?? {})) {
    for (const method of METHODS) {
      const op = item[method];
      if (!op?.operationId) continue;
      const shape = expanded(spec, {
        method,
        path,
        parameters: [...(item.parameters ?? []), ...(op.parameters ?? [])],
        body: op.requestBody
      });
      out.set(op.operationId, { own: JSON.stringify(withoutProse(shape)), schemas: reach(spec, shape) });
    }
  }
  return out;
}

function schemas(spec) {
  return new Map(
    Object.entries(spec.components?.schemas ?? {}).map(([name, schema]) => [name, JSON.stringify(withoutProse(schema))])
  );
}

const oldOps = operations(before);
const newOps = operations(after);
const oldSchemas = schemas(before);
const newSchemas = schemas(after);
const schemaChanged = (name) => oldSchemas.get(name) !== newSchemas.get(name);

const sorted = (items) => [...items].sort();
const added = sorted([...newOps.keys()].filter((id) => !oldOps.has(id)));
const removed = sorted([...oldOps.keys()].filter((id) => !newOps.has(id)));
const changed = sorted(
  [...newOps.keys()].filter((id) => {
    const old = oldOps.get(id);
    const now = newOps.get(id);
    return old && (old.own !== now.own || [...now.schemas].some(schemaChanged));
  })
);

/** The operation ids the CLI's own code names, read off its source. */
function usedByCli(ids) {
  const used = new Set();
  const walk = (dir) => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const file = join(dir, entry.name);
      if (entry.isDirectory()) {
        if (entry.name !== 'generated') walk(file);
      } else if (file.endsWith('.ts') && !file.endsWith('.test.ts')) {
        for (const [, id] of readFileSync(file, 'utf8').matchAll(/'([A-Za-z]+)'/g)) if (ids.has(id)) used.add(id);
      }
    }
  };
  walk(new URL('../src', import.meta.url).pathname);
  return used;
}

const used = usedByCli(new Set([...oldOps.keys(), ...newOps.keys()]));
const affected = [...removed, ...changed].filter((id) => used.has(id));

/**
 * A change to an operation the CLI calls is a feat, and releases: what the CLI
 * may send moved. Anything else is a chore, so a sync that touches nothing the
 * CLI calls neither releases nor adds a line to the changelog.
 */
function title() {
  if (affected.length > 0) {
    const named = affected.slice(0, 3).join(', ');
    const more = affected.length > 3 ? ` and ${affected.length - 3} more` : '';
    return `feat: follow openapi.yaml changes to ${named}${more}`;
  }
  if (added.length + removed.length + changed.length > 0) {
    return 'chore: sync openapi.yaml, no operation the CLI calls changed';
  }
  return 'chore: sync openapi.yaml, prose only';
}

if (titleOnly) {
  console.log(title());
} else {
  const mark = (id) => (used.has(id) ? `**\`${id}\`** (called by the CLI)` : `\`${id}\``);
  const lines = [];
  const section = (heading, items, format = (item) => `\`${item}\``) => {
    if (items.length > 0) lines.push(`- ${heading}: ${items.map(format).join(', ')}`);
  };
  section('Operations added', added, mark);
  section('Operations removed', removed, mark);
  section('Operations changed', changed, mark);
  section(
    'Schemas changed',
    sorted([...newSchemas.keys()].filter((name) => oldSchemas.has(name) && schemaChanged(name)))
  );
  console.log(lines.length > 0 ? lines.join('\n') : '- Only prose changed: descriptions, summaries or examples.');
}
