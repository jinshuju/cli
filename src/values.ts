/** A plain object: something with keys, that is not a list. */
export function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

/** A value with nothing inside it: text, a number, a boolean, or null. */
export function isScalar(value: unknown): boolean {
  return value === null || ['string', 'number', 'boolean'].includes(typeof value);
}
