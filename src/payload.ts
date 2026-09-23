import { UsageError } from './errors.js';

/**
 * What a form or table payload has to look like before it is worth sending.
 *
 * Only the shape is checked here: an object, a name, fields that are objects
 * with a type and without an api_code. Which types exist, which a table takes,
 * which a scene allows and what each one needs is the server's vocabulary, and
 * `jinshuju field types` reads it from there. A copy kept here was already
 * wrong once — it refused every question type an exam scene has — and would be
 * wrong again the next time the server learned a type.
 */

export type ContainerPayload = {
  name: string;
  fields?: Array<Record<string, unknown> & { type: string }>;
  [key: string]: unknown;
};

export function validateContainerPayload(payload: unknown, what: 'form' | 'table'): ContainerPayload {
  if (!payload || typeof payload !== 'object' || Array.isArray(payload)) {
    throw new UsageError(`the ${what} payload must be a JSON object`);
  }
  const container = payload as Record<string, unknown>;
  if (typeof container.name !== 'string' || container.name.trim() === '') {
    throw new UsageError(`the ${what} payload needs a non-empty "name"`);
  }
  if (container.fields !== undefined) {
    if (!Array.isArray(container.fields)) throw new UsageError('"fields" must be a list of field objects');
    container.fields.forEach((field, index) => {
      if (!field || typeof field !== 'object' || Array.isArray(field)) {
        throw new UsageError(`fields[${index}] must be an object`);
      }
      const shape = field as Record<string, unknown>;
      if ('api_code' in shape) {
        throw new UsageError(`fields[${index}] carries an api_code; leave it out, the backend assigns one`);
      }
      if (typeof shape.type !== 'string' || shape.type === '') {
        throw new UsageError(`fields[${index}] needs a "type"; run \`jinshuju field types\` for the list`);
      }
    });
  }
  return container as ContainerPayload;
}
