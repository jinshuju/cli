/** The command line itself was wrong: a flag, an argument, an input file. */
export class UsageError extends Error {
  override name = 'UsageError';
}

/** No credential, or one the server would not take. */
export class AuthError extends Error {
  override name = 'AuthError';
}

/** A response the server sent and refused with. `status` and `body` are what it said. */
export class HttpError extends Error {
  constructor(
    message: string,
    readonly status: number,
    readonly body: unknown
  ) {
    super(message);
    this.name = 'HttpError';
  }
}

/** No response at all: the connection failed, or the request ran out of time. */
export class TransportError extends Error {
  constructor(
    message: string,
    readonly timedOut: boolean,
    cause?: unknown
  ) {
    super(message, { cause });
    this.name = 'TransportError';
  }
}

/**
 * The server took the request and turned down what it carried: an import
 * whose rows it would not write, say. Exits as a refused 4xx would.
 */
export class RefusedError extends Error {
  override name = 'RefusedError';
}

/**
 * What kind of failure it was, which is what a script branches on. The exit
 * code says it without parsing anything; `--output json` also says it in
 * words, alongside the status and body the server answered with.
 */
export type ErrorKind = 'unexpected' | 'usage' | 'auth' | 'not_found' | 'refused' | 'server' | 'transport';

export const EXIT_CODES: Readonly<Record<ErrorKind, number>> = {
  unexpected: 1,
  usage: 2,
  auth: 3,
  not_found: 4,
  refused: 5,
  server: 6,
  transport: 7
};

export type ClassifiedError = {
  kind: ErrorKind;
  exitCode: number;
  message: string;
  status?: number;
  body?: unknown;
};

function kindOfStatus(status: number): ErrorKind {
  if (status === 401 || status === 403) return 'auth';
  if (status === 404) return 'not_found';
  if (status >= 500) return 'server';
  if (status >= 400) return 'refused';
  // A 2xx that reached here carried a body nobody could read.
  return 'server';
}

/**
 * Sorts a failure into its kind. An error that wraps another — "the form was
 * created, but its settings were refused" — is sorted by what it wraps, so a
 * partial failure exits the way its refused half would have.
 */
export function classify(error: unknown): ClassifiedError {
  const message = error instanceof Error ? error.message : String(error);
  if (error instanceof UsageError) return { kind: 'usage', exitCode: EXIT_CODES.usage, message };
  if (error instanceof AuthError) return { kind: 'auth', exitCode: EXIT_CODES.auth, message };
  if (error instanceof RefusedError) return { kind: 'refused', exitCode: EXIT_CODES.refused, message };
  if (error instanceof TransportError) return { kind: 'transport', exitCode: EXIT_CODES.transport, message };
  if (error instanceof HttpError) {
    const kind = kindOfStatus(error.status);
    return { kind, exitCode: EXIT_CODES[kind], message, status: error.status, body: error.body };
  }
  const cause = (error as { cause?: unknown } | null)?.cause;
  if (cause instanceof Error && cause !== error) {
    const inner = classify(cause);
    return { ...inner, message };
  }
  return { kind: 'unexpected', exitCode: EXIT_CODES.unexpected, message };
}
