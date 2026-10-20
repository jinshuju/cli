import { BASE_PATH, OPERATIONS, SCHEMAS, type OperationId } from '../generated/operations.js';
import type { HttpRequest } from '../http.js';
import type { Schema } from '../spec.js';

/**
 * Holds a request the CLI built to openapi.yaml, for the tests. It is never
 * part of a command: the API checks every body against the spec it runs, and
 * a copy checked here would refuse what the API has since learned. What the
 * tests want to know is narrower — whether a body the CLI itself puts together,
 * or a help example spells out, is one the spec takes — and this answers it.
 *
 * It knows the keywords scripts/generate.mjs keeps, and the generator stops on
 * one it does not, so nothing in the spec is passed over here unnoticed.
 */

/** What is wrong with a request, one line each; nothing when the spec takes it. */
export function nonconformities(request: HttpRequest): string[] {
  const id = operationOf(request);
  if (!id) return [`${request.method} ${request.path}: openapi.yaml has no such operation`];
  const op = OPERATIONS[id];
  const report = (where: string, issues: readonly Issue[]) =>
    issues.map((issue) => `${id} ${where}${issue.pointer} ${issue.message}, got ${JSON.stringify(issue.value)}`);
  const found: string[] = [];

  // A document a query parameter carries went as its text, as given; it is
  // held to the document's schema here, the way a body is.
  for (const param of op.parameters) {
    const text = param.in === 'query' && param.content !== undefined ? request.query?.[param.name] : undefined;
    if (text === undefined) continue;
    if (typeof text !== 'string') {
      found.push(`${id} ${param.name} is one ${param.content} value, not a list, got ${JSON.stringify(text)}`);
      continue;
    }
    let document: unknown;
    try {
      document = JSON.parse(text);
    } catch {
      found.push(`${id} ${param.name} is not ${param.content}, got ${JSON.stringify(text)}`);
      continue;
    }
    found.push(...report(param.name, validate(param.schema, document)));
  }

  const schema = op.body?.content['application/json'];
  if (schema !== undefined && request.body !== undefined) {
    // What the server reads is the JSON, where an undefined key is no key at all.
    found.push(...report('body', validate(schema, JSON.parse(JSON.stringify(request.body)))));
  }
  return found;
}

/**
 * The operation a request was sent to, read off its method and path, so a
 * request is held to the spec without trusting how it was built.
 */
export function operationOf(request: Pick<HttpRequest, 'method' | 'path'>): OperationId | undefined {
  if (!request.path.startsWith(BASE_PATH)) return undefined;
  const path = request.path.slice(BASE_PATH.length);
  const matches = (Object.keys(OPERATIONS) as OperationId[]).filter((id) => {
    const op = OPERATIONS[id];
    if (op.method !== request.method) return false;
    const pattern = op.path.replace(/[.*+?^$()|[\]\\]/g, '\\$&').replace(/\{[^}]+\}/g, '[^/]+');
    return new RegExp(`^${pattern}$`).test(path);
  });
  // A literal segment beats a parameter: /entries/count is not /entries/{serial_number}.
  return matches.sort((a, b) => literalLength(OPERATIONS[b].path) - literalLength(OPERATIONS[a].path))[0];
}

function literalLength(path: string): number {
  return path.replace(/\{[^}]+\}/g, '').length;
}

export interface Issue {
  /** JSON Pointer to the value, `` for the value itself. */
  readonly pointer: string;
  readonly message: string;
  readonly value: unknown;
}

/** The ways a value breaks a schema, first found first. */
export function validate(schema: Schema | boolean, value: unknown, pointer = ''): Issue[] {
  if (schema === true) return [];
  if (schema === false) return [{ pointer, message: 'is not allowed here', value }];
  const s = resolved(schema);
  const issues: Issue[] = [];
  const issue = (message: string) => issues.push({ pointer, message, value });

  if (s.type !== undefined) {
    const types = typeof s.type === 'string' ? [s.type] : s.type;
    if (!types.some((type) => isType(value, type))) {
      issue(`must be ${types.join(' or ')}`);
      return issues;
    }
  }
  if (s.enum !== undefined && !s.enum.some((option) => same(option, value))) {
    issue(`must be one of ${s.enum.map((option) => String(option)).join(', ')}`);
  }
  if (s.const !== undefined && !same(s.const, value)) issue(`must be ${JSON.stringify(s.const)}`);

  if (typeof value === 'number') {
    if (s.minimum !== undefined && value < s.minimum) issue(`must be at least ${s.minimum}`);
    if (s.maximum !== undefined && value > s.maximum) issue(`must be at most ${s.maximum}`);
  }
  if (typeof value === 'string') {
    const length = [...value].length;
    if (s.minLength !== undefined && length < s.minLength) issue(`must be at least ${s.minLength} long`);
    if (s.maxLength !== undefined && length > s.maxLength) issue(`must be at most ${s.maxLength} long`);
    if (s.pattern !== undefined && !new RegExp(s.pattern, 'u').test(value)) issue(`must match ${s.pattern}`);
  }
  if (Array.isArray(value)) {
    if (s.minItems !== undefined && value.length < s.minItems) issue(`must have at least ${s.minItems} items`);
    if (s.maxItems !== undefined && value.length > s.maxItems) issue(`must have at most ${s.maxItems} items`);
    const items = s.items;
    if (items !== undefined)
      value.forEach((item, index) => issues.push(...validate(items, item, `${pointer}/${index}`)));
    const contains = s.contains;
    if (contains !== undefined && !value.some((item) => validate(contains, item).length === 0)) {
      issue('must contain a matching item');
    }
  }
  if (isPlainObject(value)) issues.push(...objectIssues(s, value, pointer));

  for (const part of s.allOf ?? []) issues.push(...validate(part, value, pointer));
  if (s.anyOf !== undefined && !s.anyOf.some((part) => validate(part, value, pointer).length === 0)) {
    issues.push(...closest(s.anyOf, value, pointer));
  }
  if (s.oneOf !== undefined) {
    const matching = s.oneOf.filter((part) => validate(part, value, pointer).length === 0).length;
    if (matching === 0) issues.push(...closest(s.oneOf, value, pointer));
    if (matching > 1) issue('matches more than one of the shapes it may take');
  }
  if (s.not !== undefined && validate(s.not, value, pointer).length === 0) issue('is not allowed in this shape');
  if (s.if !== undefined) {
    const branch = validate(s.if, value, pointer).length === 0 ? s.then : s.else;
    if (branch !== undefined) issues.push(...validate(branch, value, pointer));
  }
  return issues;
}

function objectIssues(s: Schema, value: Record<string, unknown>, pointer: string): Issue[] {
  const issues: Issue[] = [];
  const missing = (name: string, message: string) =>
    issues.push({ pointer: `${pointer}/${escape(name)}`, message, value: undefined });
  for (const name of s.required ?? []) if (!(name in value)) missing(name, 'is required');
  for (const [name, needs] of Object.entries(s.dependentRequired ?? {})) {
    if (!(name in value)) continue;
    for (const needed of needs) if (!(needed in value)) missing(needed, `is required with ${name}`);
  }
  for (const [name, item] of Object.entries(value)) {
    const where = `${pointer}/${escape(name)}`;
    const declared = s.properties?.[name];
    if (declared !== undefined) issues.push(...validate(declared, item, where));
    else if (s.additionalProperties === false)
      issues.push({ pointer: where, message: 'is not a key it takes', value: item });
    else if (s.additionalProperties !== undefined) issues.push(...validate(s.additionalProperties, item, where));
  }
  return issues;
}

/**
 * Why a value fits none of the shapes it may take, told by the one it came
 * closest to. A shape it fails at its own level — a string where an object was
 * wanted — is further off than one it fails only further in.
 */
function closest(parts: readonly (Schema | boolean)[], value: unknown, pointer: string): Issue[] {
  const distance = (issues: Issue[]) =>
    issues.filter((issue) => issue.pointer === pointer).length * 1000 + issues.length;
  const tries = parts.map((part) => validate(part, value, pointer)).sort((a, b) => distance(a) - distance(b));
  return tries[0] ?? [];
}

function resolved(schema: Schema): Schema {
  let current = schema;
  while (current.$ref !== undefined) {
    const target = SCHEMAS[current.$ref];
    if (!target) throw new Error(`openapi.yaml has no schema ${current.$ref}`);
    current = target;
  }
  return current;
}

function isType(value: unknown, type: string): boolean {
  switch (type) {
    case 'null':
      return value === null;
    case 'boolean':
      return typeof value === 'boolean';
    case 'integer':
      return typeof value === 'number' && Number.isInteger(value);
    case 'number':
      return typeof value === 'number' && Number.isFinite(value);
    case 'string':
      return typeof value === 'string';
    case 'array':
      return Array.isArray(value);
    case 'object':
      return isPlainObject(value);
    default:
      return true;
  }
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function same(a: unknown, b: unknown): boolean {
  return a === b || JSON.stringify(a) === JSON.stringify(b);
}

function escape(name: string): string {
  return name.replace(/~/g, '~0').replace(/\//g, '~1');
}
