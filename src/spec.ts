import { UsageError } from './errors.js';
import { BASE_PATH, OPERATIONS, SCHEMAS, type OperationId } from './generated/operations.js';
import type { HttpMethod, HttpRequest, QueryValues } from './http.js';

/**
 * What API v1 takes, as openapi.yaml says it, and the one way a command turns
 * an operation into a request.
 *
 * The commands decide what the CLI offers. Which operation lives at which
 * path, which parameters it has and of what type, how a list goes on the wire,
 * and which values a flag offers are the spec's, read from the generated table
 * rather than written down a second time here. When the spec changes,
 * `npm run spec:update` regenerates the table and the CLI follows.
 */

export type { OperationId } from './generated/operations.js';
export { BASE_PATH } from './generated/operations.js';

/** A JSON Schema cut down to the constraints scripts/generate.mjs keeps. */
export interface Schema {
  /** The name of a schema in SCHEMAS. */
  readonly $ref?: string;
  readonly type?: string | readonly string[];
  readonly enum?: readonly unknown[];
  readonly const?: unknown;
  readonly properties?: { readonly [name: string]: Schema | boolean };
  readonly required?: readonly string[];
  readonly dependentRequired?: { readonly [name: string]: readonly string[] };
  readonly additionalProperties?: Schema | boolean;
  readonly items?: Schema | boolean;
  readonly contains?: Schema | boolean;
  readonly allOf?: readonly (Schema | boolean)[];
  readonly oneOf?: readonly (Schema | boolean)[];
  readonly anyOf?: readonly (Schema | boolean)[];
  readonly not?: Schema | boolean;
  readonly if?: Schema | boolean;
  readonly then?: Schema | boolean;
  readonly else?: Schema | boolean;
  readonly minimum?: number;
  readonly maximum?: number;
  readonly minLength?: number;
  readonly maxLength?: number;
  readonly minItems?: number;
  readonly maxItems?: number;
  readonly pattern?: string;
}

export interface Parameter {
  readonly name: string;
  readonly in: string;
  readonly required?: boolean;
  readonly style?: string;
  readonly explode?: boolean;
  /**
   * The media type of a document the value carries as text in one query
   * value — `filters=[{"field":…}]` — when it does: `application/json`.
   * `schema` is then the document's.
   */
  readonly content?: string;
  readonly schema: Schema;
}

export interface Operation {
  readonly method: HttpMethod;
  /** Relative to BASE_PATH, with `{name}` for each path parameter. */
  readonly path: string;
  readonly parameters: readonly Parameter[];
  readonly body?: { readonly required?: boolean; readonly content: { readonly [mediaType: string]: Schema } };
}

export function operation(id: OperationId): Operation {
  return OPERATIONS[id];
}

// --- the request -----------------------------------------------------------

/** A query value as a command has it; `call` spells it for the wire. */
export type QueryValue = string | number | boolean | readonly string[] | undefined;

export interface CallParts {
  readonly path?: Readonly<Record<string, string | number | undefined>>;
  readonly query?: Readonly<Record<string, QueryValue>>;
  readonly body?: unknown;
  /** A multipart body, for the operations that take a file. */
  readonly form?: FormData;
}

/**
 * The request an operation is.
 *
 * Path and query come from the CLI's own flags and arguments, so they are held
 * to the operation's parameters here: one it does not have, a required one
 * left out, or a value that is not of its type is a usage error naming it. A
 * new parameter needs a new flag and so a new release anyway, which is why
 * this never makes an installed CLI stricter than a newer API.
 *
 * A body goes as given. It is the caller's payload as often as not, the API
 * validates it against the openapi.yaml it runs — the only copy never out of
 * date — and answers a 400 that says exactly what is wrong. A check here
 * would save that round trip at the price of refusing, in every CLI already
 * installed, each field type, key and value the API learns after it ships.
 */
export function call(id: OperationId, parts: CallParts = {}): HttpRequest {
  const op = OPERATIONS[id];
  const request: HttpRequest = {
    method: op.method,
    path: BASE_PATH + fillPath(id, op, parts.path ?? {})
  };

  const query = queryOf(id, op, parts.query ?? {});
  if (Object.keys(query).length > 0) request.query = query;

  if (parts.body !== undefined) {
    if (!op.body?.content['application/json']) throw new Error(`${id} takes no JSON body`);
    request.body = parts.body;
  }
  if (parts.form !== undefined) {
    if (!op.body?.content['multipart/form-data']) throw new Error(`${id} takes no multipart body`);
    request.form = parts.form;
  }
  if (op.body?.required && request.body === undefined && request.form === undefined) {
    throw new Error(`${id} needs a request body`);
  }
  return request;
}

function fillPath(id: OperationId, op: Operation, values: Readonly<Record<string, string | number | undefined>>) {
  for (const name of Object.keys(values)) {
    if (!op.parameters.some((param) => param.in === 'path' && param.name === name)) {
      throw new Error(`${id} has no path parameter ${name}`);
    }
  }
  return op.path.replace(/\{([^}]+)\}/g, (_, name: string) => {
    const value = values[name];
    if (value === undefined || value === '') throw new Error(`${id} needs its path parameter ${name}`);
    const param = op.parameters.find((candidate) => candidate.in === 'path' && candidate.name === name) as Parameter;
    check(param, [String(value)]);
    return encodeURIComponent(String(value));
  });
}

function queryOf(id: OperationId, op: Operation, values: Readonly<Record<string, QueryValue>>): QueryValues {
  const query: Record<string, string | readonly string[]> = {};
  for (const [name, value] of Object.entries(values)) {
    if (value === undefined) continue;
    const param = op.parameters.find((candidate) => candidate.in === 'query' && candidate.name === name);
    if (!param) {
      throw new UsageError(`${op.method} ${BASE_PATH}${op.path} takes no ${name} parameter (${id} in openapi.yaml)`);
    }
    if (param.content !== undefined) {
      // A document goes as its text in one value, never repeated the way a
      // list is, and as given: it is the caller's payload as often as not,
      // and the API judges it as it does a body. The tests hold the CLI's own
      // to the document's schema.
      if (typeof value !== 'string') throw new Error(`${id} ${name} is ${param.content} text, spelled by the command`);
      query[name] = value;
      continue;
    }
    const texts = typeof value === 'object' ? [...value] : [String(value)];
    check(param, texts);
    if (isArray(param.schema)) {
      // A list on one parameter is `name=a,b` when the spec says it does not
      // explode, and `name[]=a&name[]=b` otherwise, which is how Rails reads one.
      query[name] = param.explode === false ? texts.join(',') : texts;
    } else {
      // The spec's own prose lets a scalar repeat — `q[]=A&q[]=B` — so a list
      // is each of its values sent as the scalar.
      query[name] = typeof value === 'object' ? texts : (texts[0] as string);
    }
  }
  for (const param of op.parameters) {
    if (param.in === 'query' && param.required && query[param.name] === undefined) {
      throw new UsageError(`${param.name} is required (${id} in openapi.yaml)`);
    }
  }
  return query;
}

/**
 * Each value of a path or query parameter, held to the type it declares: the
 * one thing about it no later version of the API changes its mind on. A
 * range, a length or a list of values may grow, so those are the server's.
 */
function check(param: Parameter, texts: readonly string[]): void {
  const types = typesOf(isArray(param.schema) ? itemsOf(param.schema) : param.schema);
  if (types.length === 0) return;
  for (const text of texts) {
    if (types.some((type) => reads(text, type))) continue;
    throw new UsageError(`${param.name} must be ${types.map(article).join(' or ')}, got ${JSON.stringify(text)}`);
  }
}

/** Whether a string off the command line reads as a value of the type. */
function reads(text: string, type: string): boolean {
  switch (type) {
    case 'integer':
      return /^-?\d+$/.test(text);
    case 'number':
      return /^-?\d+(\.\d+)?$/.test(text);
    case 'boolean':
      return text === 'true' || text === 'false';
    case 'null':
      return false;
    default:
      return true;
  }
}

function article(type: string): string {
  return type === 'integer' || type === 'object' || type === 'array' ? `an ${type}` : `a ${type}`;
}

function isArray(schema: Schema): boolean {
  return typesOf(schema).includes('array');
}

function itemsOf(schema: Schema): Schema {
  const items = resolved(schema).items;
  return typeof items === 'object' ? items : {};
}

function typesOf(schema: Schema): readonly string[] {
  const type = resolved(schema).type;
  return type === undefined ? [] : typeof type === 'string' ? [type] : type;
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

// --- the vocabulary flags are checked by --------------------------------------

/**
 * Every lookup that found no list of values. These run as the commands load,
 * so a spec that dropped one must not take every command down with it, --help
 * included: the flag goes without a list and the server judges the value, and
 * a test fails on this list instead, in the sync pull request that dropped it.
 */
const unanswered: string[] = [];

export function unansweredLookups(): readonly string[] {
  return unanswered;
}

/**
 * The values a query parameter takes, for the flag that feeds it. `path` is
 * the parameter's name, and walks on into a document the parameter carries
 * the way `bodyChoices` walks a body: `filters[].operator`. A flag listing
 * the values itself is a second copy, and the second copy was already behind
 * once: a view type and two scenes the API had learned were refused by the
 * CLI before they reached it.
 */
export function choices(id: OperationId, path: string): readonly string[] | undefined {
  const [first, ...rest] = path.split('.') as [string, ...string[]];
  const name = first.endsWith('[]') ? first.slice(0, -2) : first;
  const param = OPERATIONS[id].parameters.find((candidate) => candidate.name === name);
  // A parameter that is a list offers its items' values.
  const start = param && (isArray(param.schema) ? itemsOf(param.schema) : param.schema);
  return enumOf(walk(start, rest), `${id} ${path}`);
}

/**
 * The values a property of a JSON body takes. `path` walks properties with
 * dots and steps into a list's items with `[]`: `fields[].type`.
 */
export function bodyChoices(id: OperationId, path: string): readonly string[] | undefined {
  return enumOf(walk(OPERATIONS[id].body?.content['application/json'], path.split('.')), `${id} ${path}`);
}

/** The schema the steps lead to: each names a property, and `[]` steps into a list's items. */
function walk(from: Schema | undefined, steps: readonly string[]): Schema | undefined {
  let schema = from;
  for (const step of steps) {
    if (!schema) break;
    const many = step.endsWith('[]');
    const property = propertyOf(schema, many ? step.slice(0, -2) : step);
    schema = property && (many ? itemsOf(property) : property);
  }
  return schema;
}

/** A property as an object schema or any of its allOf parts declares it. */
function propertyOf(schema: Schema, name: string): Schema | undefined {
  const here = resolved(schema);
  const own = here.properties?.[name];
  if (typeof own === 'object') return own;
  for (const part of here.allOf ?? []) {
    if (typeof part !== 'object') continue;
    const found = propertyOf(part, name);
    if (found) return found;
  }
  return undefined;
}

function enumOf(schema: Schema | undefined, what: string): readonly string[] | undefined {
  const values = (schema ? (resolved(schema).enum ?? []) : []).filter(
    (value): value is string => typeof value === 'string'
  );
  if (values.length > 0) return values;
  unanswered.push(what);
  return undefined;
}
