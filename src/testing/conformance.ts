import { OPERATIONS } from '../generated/operations.js';
import type { HttpRequest } from '../http.js';
import { validate, type Issue } from '../schema.js';
import { operationOf } from '../spec.js';

/**
 * Holds a request the CLI built to openapi.yaml, for the tests, every issue
 * counted. The CLI itself looks at a body only through src/preflight.ts,
 * which refuses the few kinds of issue a newer spec could not have made
 * right. What the tests want to know is wider — whether a body the CLI itself
 * puts together, or a help example spells out, is one the spec takes at all —
 * and this answers it.
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
