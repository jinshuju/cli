import { SCHEMAS } from './generated/operations.js';
import type { Schema } from './spec.js';
import { isRecord } from './values.js';

/**
 * A value held to a schema, as scripts/generate.mjs keeps one. The keywords
 * the generator keeps are exactly the ones checked here, and it stops on one
 * it does not know, so nothing in openapi.yaml is passed over unnoticed.
 *
 * Each issue says which kind of rule the value broke, and whether that rule
 * was certainly the one that applied. A value that may be one of several
 * shapes (oneOf, anyOf) is told about the shape it came closest to, and that
 * is a guess, so nothing found under it is certain. A discriminator's branch
 * is no guess — the value's own `type` named it — and what is found under it
 * is as certain as anything found directly.
 */

export type IssueKind =
  /** Not of the type the schema says: a string where a number goes, null where nothing may be. */
  | 'type'
  /** A key the schema requires is missing. */
  | 'required'
  /** Outside the list the schema gives, or not the one constant it names. */
  | 'enum'
  /** A key on an object that takes only the keys it names. */
  | 'unknown_key'
  /** Outside a range or a length, or not matching a pattern. */
  | 'range'
  /** Fits none of several shapes, more than one of them, or one it must not. */
  | 'shape';

export interface Issue {
  /** JSON Pointer to the value, `` for the value itself. */
  readonly pointer: string;
  readonly kind: IssueKind;
  readonly message: string;
  readonly value: unknown;
  /** Whether the rule broken was certainly the one that applied, and not the closest of several shapes. */
  readonly certain: boolean;
  /** For an unknown key, the keys the object does take. */
  readonly takes?: readonly string[];
}

/** The ways a value breaks a schema, first found first. */
export function validate(schema: Schema | boolean, value: unknown, pointer = '', certain = true): Issue[] {
  if (schema === true) return [];
  if (schema === false) return [{ pointer, kind: 'shape', message: 'is not allowed here', value, certain }];
  const s = resolved(schema);
  const issues: Issue[] = [];
  const issue = (kind: IssueKind, message: string) => issues.push({ pointer, kind, message, value, certain });

  if (s.type !== undefined) {
    const types = typeof s.type === 'string' ? [s.type] : s.type;
    if (!types.some((type) => isType(value, type))) {
      issue('type', `must be ${types.join(' or ')}`);
      return issues;
    }
  }
  if (s.enum !== undefined && !s.enum.some((option) => same(option, value))) {
    issue('enum', `must be one of ${s.enum.map((option) => String(option)).join(', ')}`);
  }
  if (s.const !== undefined && !same(s.const, value)) issue('enum', `must be ${JSON.stringify(s.const)}`);

  if (typeof value === 'number') {
    if (s.minimum !== undefined && value < s.minimum) issue('range', `must be at least ${s.minimum}`);
    if (s.maximum !== undefined && value > s.maximum) issue('range', `must be at most ${s.maximum}`);
  }
  if (typeof value === 'string') {
    const length = [...value].length;
    if (s.minLength !== undefined && length < s.minLength) issue('range', `must be at least ${s.minLength} long`);
    if (s.maxLength !== undefined && length > s.maxLength) issue('range', `must be at most ${s.maxLength} long`);
    if (s.pattern !== undefined && !new RegExp(s.pattern, 'u').test(value)) issue('range', `must match ${s.pattern}`);
  }
  if (Array.isArray(value)) {
    if (s.minItems !== undefined && value.length < s.minItems) issue('range', `must have at least ${s.minItems} items`);
    if (s.maxItems !== undefined && value.length > s.maxItems) issue('range', `must have at most ${s.maxItems} items`);
    const items = s.items;
    if (items !== undefined) {
      value.forEach((item, index) => issues.push(...validate(items, item, `${pointer}/${index}`, certain)));
    }
    const contains = s.contains;
    if (contains !== undefined && !value.some((item) => validate(contains, item).length === 0)) {
      issue('shape', 'must contain a matching item');
    }
  }
  if (isRecord(value)) issues.push(...objectIssues(s, value, pointer, certain));

  for (const part of s.allOf ?? []) issues.push(...validate(part, value, pointer, certain));
  if (s.discriminator !== undefined && isRecord(value)) {
    issues.push(...discriminated(s, value, pointer, certain));
  } else {
    if (s.anyOf !== undefined) issues.push(...alternatives(s.anyOf, value, pointer, certain, 'anyOf'));
    if (s.oneOf !== undefined) issues.push(...alternatives(s.oneOf, value, pointer, certain, 'oneOf'));
  }
  if (s.not !== undefined && validate(s.not, value, pointer).length === 0)
    issue('shape', 'is not allowed in this shape');
  if (s.if !== undefined) {
    const branch = validate(s.if, value, pointer).length === 0 ? s.then : s.else;
    if (branch !== undefined) issues.push(...validate(branch, value, pointer, certain));
  }
  return issues;
}

function objectIssues(s: Schema, value: Record<string, unknown>, pointer: string, certain: boolean): Issue[] {
  const issues: Issue[] = [];
  const missing = (name: string, message: string) =>
    issues.push({ pointer: `${pointer}/${escape(name)}`, kind: 'required', message, value: undefined, certain });
  for (const name of s.required ?? []) if (!(name in value)) missing(name, 'is required');
  for (const [name, needs] of Object.entries(s.dependentRequired ?? {})) {
    if (!(name in value)) continue;
    for (const needed of needs) if (!(needed in value)) missing(needed, `is required with ${name}`);
  }
  for (const [name, item] of Object.entries(value)) {
    const where = `${pointer}/${escape(name)}`;
    const declared = s.properties?.[name];
    if (declared !== undefined) issues.push(...validate(declared, item, where, certain));
    else if (s.additionalProperties === false) {
      issues.push({
        pointer: where,
        kind: 'unknown_key',
        message: 'is not a key it takes',
        value: item,
        certain,
        takes: Object.keys(s.properties ?? {})
      });
    } else if (s.additionalProperties !== undefined) {
      issues.push(...validate(s.additionalProperties, item, where, certain));
    }
  }
  return issues;
}

/**
 * The one of several shapes a value is, named by its own discriminator
 * property. A value naming a shape this copy of the spec does not list is held
 * to none of them: the API may have learned the shape since, and the closest
 * of the others would be told about keys it never had.
 */
function discriminated(s: Schema, value: Record<string, unknown>, pointer: string, certain: boolean): Issue[] {
  const { propertyName, mapping } = s.discriminator as NonNullable<Schema['discriminator']>;
  const tag = value[propertyName];
  const where = `${pointer}/${escape(propertyName)}`;
  if (tag === undefined) {
    // Unless the object's own required list has said so already.
    if (s.required?.includes(propertyName)) return [];
    return [{ pointer: where, kind: 'required', message: 'is required', value: undefined, certain }];
  }
  const branch = typeof tag === 'string' ? mapping[tag] : undefined;
  if (branch === undefined) {
    // Unless the property's own list of values has said so already.
    if (s.properties?.[propertyName] !== undefined) return [];
    const known = Object.keys(mapping).join(', ');
    return [{ pointer: where, kind: 'enum', message: `must be one of ${known}`, value: tag, certain }];
  }
  return validate({ $ref: branch }, value, pointer, certain);
}

/** A value held to one of several shapes: the one its tag names when they are told apart by one, else the closest. */
function alternatives(
  parts: readonly (Schema | boolean)[],
  value: unknown,
  pointer: string,
  certain: boolean,
  how: 'anyOf' | 'oneOf'
): Issue[] {
  const named = discriminatedAmong(parts, value, pointer, certain);
  if (named !== undefined) return named;
  const fitting = parts.filter((part) => validate(part, value, pointer).length === 0).length;
  if (fitting === 0) return closest(parts, value, pointer);
  if (how === 'oneOf' && fitting > 1) {
    return [{ pointer, kind: 'shape', message: 'matches more than one of the shapes it may take', value, certain }];
  }
  return [];
}

/**
 * Among shapes each told apart by the same discriminator — a form's field
 * types beside a table's — the one the value's own tag names, held to with
 * certainty. Nothing to say when the shapes are not all of that kind, or the
 * tag names a different shape in each. A tag none of them lists names no
 * shape, and that is an answer rather than a guess: the API may have learned
 * the type since, and the closest of the others would be told about keys it
 * never had, which is what the API's own validation does and what sent a
 * caller off to change a type that was right.
 */
function discriminatedAmong(
  parts: readonly (Schema | boolean)[],
  value: unknown,
  pointer: string,
  certain: boolean
): Issue[] | undefined {
  if (!isRecord(value)) return undefined;
  const unions = parts.flatMap((part) => {
    const here = typeof part === 'object' ? resolved(part) : undefined;
    return here?.discriminator === undefined ? [] : [here.discriminator];
  });
  if (unions.length === 0 || unions.length !== parts.length) return undefined;
  const names = new Set(unions.map((union) => union.propertyName));
  if (names.size !== 1) return undefined;
  const propertyName = unions[0]?.propertyName as string;
  const tag = value[propertyName];
  if (tag === undefined) {
    const where = `${pointer}/${escape(propertyName)}`;
    return [{ pointer: where, kind: 'required', message: 'is required', value: undefined, certain }];
  }
  const branches = new Set(
    unions.flatMap((union) => {
      const branch = typeof tag === 'string' ? union.mapping[tag] : undefined;
      return branch === undefined ? [] : [branch];
    })
  );
  if (branches.size > 1) return undefined;
  const [branch] = branches;
  return branch === undefined ? [] : validate({ $ref: branch }, value, pointer, certain);
}

/**
 * Why a value fits none of the shapes it may take, told by the one it came
 * closest to. A shape it fails at its own level — a string where an object was
 * wanted — is further off than one it fails only further in. Which shape was
 * meant is a guess, so nothing found this way is certain.
 */
function closest(parts: readonly (Schema | boolean)[], value: unknown, pointer: string): Issue[] {
  const distance = (issues: Issue[]) =>
    issues.filter((issue) => issue.pointer === pointer).length * 1000 + issues.length;
  const tries = parts.map((part) => validate(part, value, pointer, false)).sort((a, b) => distance(a) - distance(b));
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
      return isRecord(value);
    default:
      return true;
  }
}

function same(a: unknown, b: unknown): boolean {
  return a === b || JSON.stringify(a) === JSON.stringify(b);
}

/** A key as a JSON Pointer segment spells it. */
function escape(name: string): string {
  return name.replace(/~/g, '~0').replace(/\//g, '~1');
}
