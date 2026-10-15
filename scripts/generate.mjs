/**
 * spec/openapi.yaml -> src/generated/operations.ts
 *
 * The one place that reads OpenAPI. What it writes is what API v1 says each
 * operation takes — method, path, parameters, request body — and nothing a
 * reader of the output needs: descriptions, examples and responses stay
 * behind. Which commands exist is still the CLI's to decide; this decides what
 * a request may carry.
 *
 * The output is committed, so a change to openapi.yaml reaches review as a
 * change to what the CLI may send, and CI regenerates it to prove the two
 * agree.
 *
 * Usage: npm run generate
 */
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { parse } from 'yaml';

const root = new URL('..', import.meta.url);
const spec = parse(readFileSync(new URL('spec/openapi.yaml', root), 'utf8'));

const METHODS = ['get', 'post', 'put', 'patch', 'delete'];
const SCHEMA_REF = '#/components/schemas/';

/**
 * The schema keywords the tests know how to check (src/testing/conformance.ts),
 * by what they hold. A keyword missing from both lists stops the generator:
 * dropping one it did not understand would let the tests pass a request the
 * spec refuses.
 */
const KEYWORDS = {
  value: ['type', 'enum', 'const', 'required', 'dependentRequired', 'pattern'],
  number: ['minimum', 'maximum', 'minLength', 'maxLength', 'minItems', 'maxItems'],
  schema: ['items', 'not', 'if', 'then', 'else', 'contains'],
  schemas: ['allOf', 'oneOf', 'anyOf']
};
/**
 * Words for people and for code generators, which constrain nothing; `format`,
 * which only the server asserts; and `discriminator`, whose oneOf beside it
 * already says which shape a value fits.
 */
const IGNORED = new Set([
  'description',
  'title',
  'summary',
  'example',
  'examples',
  'default',
  'format',
  'contentMediaType',
  'discriminator',
  'deprecated',
  'externalDocs',
  'xml'
]);

function fail(message) {
  console.error(`generate: ${message}`);
  process.exit(1);
}

/** `#/components/parameters/PageLimit` and the like. */
function lookup(ref) {
  if (!ref.startsWith('#/')) fail(`external $ref is not supported: ${ref}`);
  let node = spec;
  for (const part of ref.slice(2).split('/')) {
    node = node?.[part.replace(/~1/g, '/').replace(/~0/g, '~')];
    if (node === undefined) fail(`unresolved $ref: ${ref}`);
  }
  return node;
}

/** The named schemas the output refers to, filled in as they are met. */
const named = new Map();

/** A schema cut down to its constraints. A named one stays a reference, which is what keeps the output small. */
function constraints(schema, where) {
  if (schema === true || schema === false) return schema;
  if (!schema || typeof schema !== 'object' || Array.isArray(schema)) fail(`${where}: not a schema`);

  if (typeof schema.$ref === 'string') {
    if (!schema.$ref.startsWith(SCHEMA_REF)) return constraints(lookup(schema.$ref), schema.$ref);
    const name = schema.$ref.slice(SCHEMA_REF.length);
    if (!named.has(name)) {
      named.set(name, undefined);
      named.set(name, constraints(lookup(schema.$ref), name));
    }
    const siblings = Object.keys(schema).filter((key) => key !== '$ref' && !IGNORED.has(key));
    if (siblings.length > 0) fail(`${where}: keywords beside a $ref are not supported (${siblings.join(', ')})`);
    return { $ref: name };
  }

  const out = {};
  for (const [key, value] of Object.entries(schema)) {
    if (IGNORED.has(key) || key.startsWith('x-')) continue;
    if (KEYWORDS.value.includes(key) || KEYWORDS.number.includes(key)) out[key] = value;
    else if (KEYWORDS.schema.includes(key)) out[key] = constraints(value, `${where}/${key}`);
    else if (KEYWORDS.schemas.includes(key))
      out[key] = value.map((item, i) => constraints(item, `${where}/${key}/${i}`));
    else if (key === 'properties') {
      out.properties = Object.fromEntries(
        Object.entries(value).map(([name, property]) => [name, constraints(property, `${where}/properties/${name}`)])
      );
    } else if (key === 'additionalProperties') {
      out.additionalProperties =
        typeof value === 'boolean' ? value : constraints(value, `${where}/additionalProperties`);
    } else fail(`${where}: schema keyword "${key}" is not supported; teach src/testing/conformance.ts, then here`);
  }
  return out;
}

function parameter(raw, where) {
  const param = raw.$ref ? lookup(raw.$ref) : raw;
  if (!param.schema) fail(`${where}: parameter ${param.name} has no schema`);
  const out = { name: param.name, in: param.in };
  if (param.required) out.required = true;
  if (param.style !== undefined) out.style = param.style;
  if (param.explode !== undefined) out.explode = param.explode;
  out.schema = constraints(param.schema, `${where}/${param.name}`);
  return out;
}

const operations = {};
for (const [path, item] of Object.entries(spec.paths ?? {})) {
  for (const method of METHODS) {
    const op = item[method];
    if (!op) continue;
    const id = op.operationId;
    if (!id) fail(`${method.toUpperCase()} ${path} has no operationId`);
    if (operations[id]) fail(`operationId ${id} is used twice`);
    const where = `${id} (${method.toUpperCase()} ${path})`;

    // An operation's own parameter replaces the path's of the same name and place.
    const byKey = new Map();
    for (const raw of [...(item.parameters ?? []), ...(op.parameters ?? [])]) {
      const param = parameter(raw, where);
      byKey.set(`${param.in}:${param.name}`, param);
    }
    const parameters = [...byKey.values()];
    for (const [, name] of path.matchAll(/\{([^}]+)\}/g)) {
      if (!parameters.some((param) => param.in === 'path' && param.name === name)) {
        fail(`${where}: {${name}} is in the path but not among its parameters`);
      }
    }

    const operation = { method: method.toUpperCase(), path, parameters };
    if (op.requestBody) {
      const body = op.requestBody.$ref ? lookup(op.requestBody.$ref) : op.requestBody;
      operation.body = {
        ...(body.required ? { required: true } : {}),
        content: Object.fromEntries(
          Object.entries(body.content ?? {}).map(([type, media]) => [
            type,
            constraints(media.schema ?? {}, `${where} body ${type}`)
          ])
        )
      };
    }
    operations[id] = operation;
  }
}

const server = spec.servers?.[0]?.url;
if (!server) fail('servers[0].url is missing, and the base path comes from it');
const basePath = new URL(server).pathname.replace(/\/$/, '');

const sorted = (record) => Object.fromEntries(Object.entries(record).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)));
const ids = Object.keys(operations).sort();

const output = `// Generated by scripts/generate.mjs from spec/openapi.yaml (${spec.info.title} ${spec.info.version}).
// Do not edit: change the spec and run \`npm run generate\`.

import type { Operation, Schema } from '../spec.js';

/** The path every operation's path is relative to, from \`servers\`. */
export const BASE_PATH = ${JSON.stringify(basePath)};

export type OperationId =
${ids.map((id) => `  | ${JSON.stringify(id)}`).join('\n')};

export const OPERATIONS: { readonly [id in OperationId]: Operation } = ${JSON.stringify(sorted(operations))};

/** The named schemas a parameter or a request body refers to. */
export const SCHEMAS: { readonly [name: string]: Schema } = ${JSON.stringify(sorted(Object.fromEntries(named)))};
`;

mkdirSync(new URL('src/generated/', root), { recursive: true });
writeFileSync(new URL('src/generated/operations.ts', root), output);
console.log(`src/generated/operations.ts: ${ids.length} operations, ${named.size} schemas`);
