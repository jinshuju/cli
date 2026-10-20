/**
 * What changed between two copies of openapi.yaml, for the spec-sync pull
 * request, and whether the change reaches what the CLI does.
 *
 * The CLI follows the spec in two places at run time: the method, path and
 * parameters of each operation it calls, which `call` checks and spells, and
 * the lists of values its flags read with `choices` and `bodyChoices`. A
 * change to either is a feat, and releases. A request body goes as given, so a
 * change to one moves only what the tests hold the CLI's own bodies to: a
 * chore, like a change to an operation the CLI does not call, or to prose.
 * Responses never count.
 *
 * Usage:
 *   node scripts/spec-diff.mjs <old openapi.yaml> <new openapi.yaml>          markdown
 *   node scripts/spec-diff.mjs --title <old openapi.yaml> <new openapi.yaml>  the title
 */
import { readFileSync, readdirSync } from 'node:fs';
import { join, relative } from 'node:path';
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

/** A node with references to parameters and bodies followed; schemas stay named. */
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

/** Each operation's request, as what `call` follows and as what goes through untouched. */
function operations(spec) {
  const out = new Map();
  for (const [path, item] of Object.entries(spec.paths ?? {})) {
    for (const method of METHODS) {
      const op = item[method];
      if (!op?.operationId) continue;
      const parameters = expanded(spec, {
        method,
        path,
        parameters: [...(item.parameters ?? []), ...(op.parameters ?? [])]
      });
      const body = expanded(spec, op.requestBody ?? null);
      out.set(op.operationId, {
        op,
        item,
        parameters: JSON.stringify(withoutProse(parameters)),
        parameterSchemas: reach(spec, parameters),
        body: JSON.stringify(withoutProse(body)),
        bodySchemas: reach(spec, body)
      });
    }
  }
  return out;
}

function schemas(spec) {
  return new Map(
    Object.entries(spec.components?.schemas ?? {}).map(([name, schema]) => [name, JSON.stringify(withoutProse(schema))])
  );
}

// --- what the CLI's source says it uses -----------------------------------------

/**
 * The operation ids the CLI names, and the value lists its flags read, off its
 * source. A lookup has to name its operation and its parameter or property in
 * literals to be read here; one that does not stops the script rather than
 * leaving a flag's list unwatched.
 */
function source(ids) {
  const used = new Set();
  const lookups = [];
  const unreadable = [];
  const root = new URL('..', import.meta.url).pathname;
  const walk = (dir) => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const file = join(dir, entry.name);
      if (entry.isDirectory()) {
        if (entry.name !== 'generated' && entry.name !== 'testing') walk(file);
        continue;
      }
      if (!file.endsWith('.ts') || file.endsWith('.test.ts')) continue;
      const text = readFileSync(file, 'utf8');
      for (const [, id] of text.matchAll(/'([A-Za-z]+)'/g)) if (ids.has(id)) used.add(id);
      for (const call of text.matchAll(/(?<!function )\b(choices|bodyChoices)\(([^)]*)\)/g)) {
        const literal = /^\s*'([A-Za-z]+)'\s*,\s*'([^']+)'\s*$/.exec(call[2]);
        if (literal) lookups.push({ kind: call[1], id: literal[1], path: literal[2] });
        else unreadable.push(`${relative(root, file)}: ${call[0]}`);
      }
    }
  };
  walk(join(root, 'src'));
  if (unreadable.length > 0) {
    console.error(
      `spec-diff: these lookups do not name their operation and field in literals:\n  ${unreadable.join('\n  ')}`
    );
    process.exit(1);
  }
  return { used, lookups };
}

/** What a lookup reads in one copy of the spec, as `choices` and `bodyChoices` read it. */
function valuesOf(spec, { kind, id, path }) {
  const resolved = (node) => {
    let current = node;
    for (let hops = 0; current && typeof current.$ref === 'string' && hops < 32; hops += 1) {
      current = lookup(spec, current.$ref);
    }
    return current;
  };
  const items = (schema) => (resolved(schema)?.type === 'array' ? resolved(resolved(schema).items) : resolved(schema));
  const property = (schema, name) => {
    const here = resolved(schema);
    if (!here) return undefined;
    if (here.properties?.[name]) return here.properties[name];
    for (const part of here.allOf ?? []) {
      const found = property(part, name);
      if (found) return found;
    }
    return undefined;
  };

  const walk = (start, steps) => {
    let schema = start;
    for (const step of steps) {
      const many = step.endsWith('[]');
      const next = property(schema, many ? step.slice(0, -2) : step);
      schema = many ? items(next) : next;
      if (!schema) break;
    }
    return schema;
  };

  let found;
  for (const [route, item] of Object.entries(spec.paths ?? {})) {
    for (const method of METHODS) if (item[method]?.operationId === id) found = { route, item, op: item[method] };
  }
  if (!found) return undefined;
  let schema;
  if (kind === 'choices') {
    // The parameter's name first, then on into a document it carries, which
    // the spec declares with `content` in place of `schema`.
    const [first, ...rest] = path.split('.');
    const name = first.endsWith('[]') ? first.slice(0, -2) : first;
    const parameters = [...(found.item.parameters ?? []), ...(found.op.parameters ?? [])].map(resolved);
    const parameter = parameters.find((candidate) => candidate?.name === name);
    schema = walk(items(parameter?.schema ?? parameter?.content?.['application/json']?.schema), rest);
  } else {
    schema = walk(resolved(found.op.requestBody)?.content?.['application/json']?.schema, path.split('.'));
  }
  const values = (resolved(schema)?.enum ?? []).filter((value) => typeof value === 'string');
  return values.length > 0 ? values : undefined;
}

// --- the comparison ----------------------------------------------------------

const oldOps = operations(before);
const newOps = operations(after);
const oldSchemas = schemas(before);
const newSchemas = schemas(after);
const schemaChanged = (name) => oldSchemas.get(name) !== newSchemas.get(name);
const { used, lookups } = source(new Set([...oldOps.keys(), ...newOps.keys()]));

const sorted = (items) => [...items].sort();
const added = sorted([...newOps.keys()].filter((id) => !oldOps.has(id)));
const removed = sorted([...oldOps.keys()].filter((id) => !newOps.has(id)));
const kept = sorted([...newOps.keys()].filter((id) => oldOps.has(id)));
const parametersChanged = kept.filter((id) => {
  const [old, now] = [oldOps.get(id), newOps.get(id)];
  return old.parameters !== now.parameters || [...now.parameterSchemas].some(schemaChanged);
});
const bodyChanged = kept.filter((id) => {
  const [old, now] = [oldOps.get(id), newOps.get(id)];
  return old.body !== now.body || [...now.bodySchemas].some(schemaChanged);
});

/** The value lists a flag reads that came out different, each with what it gained and lost. */
const movedLookups = lookups.flatMap((lookup) => {
  const [old, now] = [valuesOf(before, lookup), valuesOf(after, lookup)];
  if (JSON.stringify(old) === JSON.stringify(now)) return [];
  const gained = (now ?? []).filter((value) => !(old ?? []).includes(value));
  const lost = (old ?? []).filter((value) => !(now ?? []).includes(value));
  return [{ name: `${lookup.id} ${lookup.path}`, gained, lost }];
});

const reachesCli = [
  ...removed.filter((id) => used.has(id)).map((id) => ({ name: id, why: 'removed' })),
  ...parametersChanged.filter((id) => used.has(id)).map((id) => ({ name: id, why: 'method, path or parameters' })),
  ...movedLookups.map(({ name, gained, lost }) => ({
    name,
    why: [...gained.map((value) => `+${value}`), ...lost.map((value) => `−${value}`)].join(' ') || 'values'
  }))
];
const bodiesOnly = bodyChanged.filter((id) => used.has(id) && !parametersChanged.includes(id));
const elsewhere = {
  added: added.filter((id) => !used.has(id)),
  removed: removed.filter((id) => !used.has(id)),
  changed: [...new Set([...parametersChanged, ...bodyChanged])].filter((id) => !used.has(id)).sort()
};

function title() {
  if (reachesCli.length > 0) {
    const names = [...new Set(reachesCli.map((change) => change.name))];
    const more = names.length > 3 ? ` and ${names.length - 3} more` : '';
    return `feat: follow openapi.yaml changes to ${names.slice(0, 3).join(', ')}${more}`;
  }
  if (added.length + removed.length + parametersChanged.length + bodyChanged.length > 0) {
    return 'chore: sync openapi.yaml, nothing the CLI checks or offers changed';
  }
  return 'chore: sync openapi.yaml, prose only';
}

if (titleOnly) {
  console.log(title());
} else {
  const code = (item) => `\`${item}\``;
  const lines = [];
  if (reachesCli.length > 0) {
    lines.push(
      `- **What the CLI checks or offers changed**: ${reachesCli.map(({ name, why }) => `${code(name)} (${why})`).join(', ')}`
    );
  }
  if (bodiesOnly.length > 0) {
    lines.push(
      `- Request bodies the CLI sends as given changed, for the API to judge; the tests hold the CLI's own bodies to them: ${bodiesOnly.map(code).join(', ')}`
    );
  }
  const others = [
    ['added', elsewhere.added],
    ['removed', elsewhere.removed],
    ['changed', elsewhere.changed]
  ].filter(([, ids]) => ids.length > 0);
  if (others.length > 0) {
    lines.push(
      `- Operations the CLI does not call: ${others.map(([what, ids]) => `${what} ${ids.map(code).join(', ')}`).join('; ')}`
    );
  }
  const changedSchemas = sorted([...newSchemas.keys()].filter((name) => oldSchemas.has(name) && schemaChanged(name)));
  if (changedSchemas.length > 0) lines.push(`- Schemas changed: ${changedSchemas.map(code).join(', ')}`);
  console.log(lines.length > 0 ? lines.join('\n') : '- Only prose changed: descriptions, summaries or examples.');
}
