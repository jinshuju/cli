import { PreflightError, type Refusal } from './errors.js';
import { OPERATIONS, SPEC_DATE } from './generated/operations.js';
import type { HttpClient, HttpRequest } from './http.js';
import { validate, type Issue } from './schema.js';
import { operationOf, type OperationId } from './spec.js';
import { isRecord } from './values.js';

/**
 * The one look the CLI takes at a body before sending it.
 *
 * API v1 validates every request against the openapi.yaml it runs, the only
 * copy never out of date, and its 400 says what is wrong. An installed CLI
 * keeps the spec it shipped with until someone upgrades it, so a check here
 * against that copy would refuse, from then on, each field type, key and
 * value the API learns: an old client would be stricter than the API it
 * talks to. So the look is a narrow one. It refuses what no newer spec could
 * have made right — a key that is required, a value of the wrong type, null
 * where nothing may be null, a field read back and written back as it came —
 * and sends everything else for the API to judge: a key or a value this copy
 * does not list may be one the API has learned since. Three days of the
 * CLI's 400s were mostly the first kind: a field's `validation` written back
 * as `form get` returned it, `null` for every key left unset, a choice to
 * update named by its value rather than its api_code.
 *
 * What the look finds is said at once, every reason at its pointer, and
 * nothing is sent. `--as-is` sends the body anyway, for when the API has in
 * fact learned what this copy refuses; the refusal names the day the copy was
 * fetched so that case can be told.
 */

/** The client with the look on the way: a request whose body it refuses never reaches the one wrapped. */
export function checked(client: HttpClient, asIs: boolean): HttpClient {
  if (asIs) return client;
  return {
    async request<T>(request: HttpRequest): Promise<T> {
      const refusals = preflight(request);
      if (refusals.length > 0) throw new PreflightError(describe(refusals), refusals);
      return client.request<T>(request);
    }
  };
}

/** What a request's body is refused for, each at its pointer; nothing when it may go. */
export function preflight(request: HttpRequest): Refusal[] {
  const id = operationOf(request);
  if (id === undefined || request.body === undefined) return [];
  const schema = OPERATIONS[id].body?.content['application/json'];
  if (schema === undefined) return [];

  // What the server reads is the JSON, where an undefined key is no key at all.
  const body: unknown = JSON.parse(JSON.stringify(request.body));
  const refusals: Refusal[] = [];
  const at = new Set<string>();
  const refuse = (refusal: Refusal | undefined) => {
    if (refusal === undefined || at.has(refusal.pointer)) return;
    at.add(refusal.pointer);
    refusals.push(refusal);
  };
  for (const issue of validate(schema, body)) refuse(refusalOf(issue, request.method));
  for (const refusal of ownRules(id, body)) refuse(refusal);
  return refusals;
}

/**
 * The issues a newer spec could not have made right, as refusals; the rest
 * as nothing. A key the schema does not list, a value outside its list, a
 * range or a length may all have grown since this copy was fetched, and a
 * shape guessed at (anyOf, oneOf) may have been the wrong guess. A required
 * key, a type and a null are not that kind of thing.
 */
function refusalOf(issue: Issue, method: string): Refusal | undefined {
  if (!issue.certain) return undefined;
  const { pointer, kind, value } = issue;
  if (kind === 'required') return { pointer, message: `${issue.message}${hint(pointer)}` };
  if (kind === 'type') {
    if (value === null) {
      const instead = method === 'PATCH' || method === 'PUT' ? 'to leave it unchanged' : 'instead';
      return { pointer, message: `is null; leave the key out ${instead}` };
    }
    return { pointer, message: `${issue.message}, got ${JSON.stringify(value)}` };
  }
  if (kind === 'unknown_key' && lastSegment(pointer) === 'validation' && isRecord(value)) {
    return { pointer, message: flattened(value, issue.takes ?? []) };
  }
  return undefined;
}

/**
 * `validation` is how a field reads: `form get` and `field list` answer
 * `{validation: {required, unique, minimum_length, …}}`, and a field written
 * back as it came carries it. The write takes the same keys flat on the
 * field, so the message says the payload that would do, worked out from the
 * keys the write does take rather than from a list kept here.
 */
function flattened(validation: Record<string, unknown>, takes: readonly string[]): string {
  const flat = Object.fromEntries(Object.entries(validation).filter(([key]) => takes.includes(key)));
  const dropped = Object.keys(validation).filter((key) => !takes.includes(key));
  const parts = ['validation is how a field reads, not how it is written'];
  if (Object.keys(flat).length > 0) parts.push(`write its keys flat on the field: ${JSON.stringify(flat)}`);
  if (dropped.length > 0) parts.push(`leave out ${dropped.join(', ')}, which a write does not take`);
  return parts.join('; ');
}

/** What to add to a refusal at this pointer, when the spec's own words would leave the caller guessing. */
function hint(pointer: string): string {
  if (/\/update_choices\/\d+\/update\/\d+\/api_code$/.test(pointer)) {
    return '; a choice to update is named by its api_code, which `jinshuju field list` shows';
  }
  return '';
}

/**
 * What the API refuses by a rule of its own rather than by the schema, and
 * says so plainly — kept here only where the CLI can say it sooner and name
 * its own command for the right way.
 */
function ownRules(id: OperationId, body: unknown): Refusal[] {
  const refusals: Refusal[] = [];
  if ((id === 'updateForm' || id === 'updateTable') && isRecord(body) && isRecord(body.fields)) {
    const updates = Array.isArray(body.fields.update) ? body.fields.update : [];
    updates.forEach((field: unknown, index) => {
      if (isRecord(field) && 'choices' in field) {
        refusals.push({
          pointer: `/fields/update/${index}/choices`,
          message:
            'choices are not changed on update; change them with ' +
            '`jinshuju field update-choices <api-code> --json \'{"add":[…],"update":[…],"remove":[…]}\'`'
        });
      }
    });
  }
  if (id === 'createForm' && isRecord(body) && Array.isArray(body.fields)) {
    const first = body.fields[0];
    const typeOf = (field: unknown) => (isRecord(field) ? field.type : undefined);
    if (body.fields.some((field) => typeOf(field) === 'PageBreak') && typeOf(first) !== 'PageBreak') {
      refusals.push({
        pointer: '/fields/0',
        message: 'a form with page breaks starts with one; put a PageBreak first'
      });
    }
  }
  return refusals;
}

function describe(refusals: readonly Refusal[]): string {
  const copy = SPEC_DATE === undefined ? 'the openapi.yaml' : `the openapi.yaml of ${SPEC_DATE}`;
  return [
    `the payload would be refused, by ${copy} this CLI shipped with:`,
    ...refusals.map(({ pointer, message }) => `  ${pointer || '/'}: ${message}`),
    'Nothing was sent. --as-is sends it anyway, for the API to judge by the spec it runs.'
  ].join('\n');
}

function lastSegment(pointer: string): string {
  return pointer
    .slice(pointer.lastIndexOf('/') + 1)
    .replace(/~1/g, '/')
    .replace(/~0/g, '~');
}
