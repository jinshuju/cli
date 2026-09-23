import { loadConfig, type LoadedConfig } from './config.js';
import { refreshOAuthToken, shouldRefresh } from './auth.js';
import { AuthError, HttpError, TransportError } from './errors.js';

export { HttpError, TransportError } from './errors.js';
import { VERSION } from './version.js';

export type HttpMethod = 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE';

/** A repeated parameter arrives as a list; everything else is one value. */
export type QueryValues = Record<string, string | readonly string[] | undefined>;

export type HttpRequest = {
  method: HttpMethod;
  path: string;
  /** The query string, as values; how they are spelled on the wire is this module's business. */
  query?: QueryValues;
  body?: unknown;
  /**
   * A multipart body, for the three endpoints that take a file. fetch sets its
   * own Content-Type here, boundary included, so the JSON one must not be sent.
   */
  form?: FormData;
};

export interface HttpClient {
  request<T>(request: HttpRequest): Promise<T>;
}

/**
 * The path with its query string. A list value repeats its parameter as
 * `name[]=a&name[]=b`, which is how Rails reads a list. Joining them with a
 * comma would ask for one keyword containing a comma instead of two keywords.
 */
export function withQuery(path: string, query?: QueryValues): string {
  const params = new URLSearchParams();
  for (const [name, value] of Object.entries(query ?? {})) {
    if (value === undefined) continue;
    if (typeof value === 'string') {
      params.set(name, value);
    } else {
      for (const item of value) params.append(`${name}[]`, item);
    }
  }
  const search = params.toString();
  return search ? `${path}?${search}` : path;
}

export type HttpClientOptions = {
  /** How long one attempt may take. */
  timeoutMs?: number;
  /** How many times a retryable failure is tried again. */
  retries?: number;
  /** How to wait between attempts; tests replace it so nothing actually sleeps. */
  sleep?: (ms: number) => Promise<void>;
};

/**
 * A minute: long enough for an upload or a `--all` page on a slow link, short
 * enough that a connection the network dropped does not hold a script forever.
 */
export const DEFAULT_TIMEOUT_MS = 60_000;
export const DEFAULT_RETRIES = 3;

/** Backoff between attempts when the server does not say how long to wait. */
const BACKOFF_BASE_MS = 500;
const BACKOFF_CAP_MS = 8_000;

/**
 * A 429 and a 503 say "not now", whatever the request was; the server has not
 * acted on it. The other server-side failures are retried only for a read: a
 * POST that timed out at a gateway may well have landed, and sending it again
 * would create the entry twice.
 */
const RETRY_ANY = new Set([429, 503]);
const RETRY_READS = new Set([500, 502, 504]);

/** How much of an unexpected body is worth putting in front of a reader. */
const MAX_SNIPPET = 200;

type ParsedBody = { json: true; value: unknown } | { json: false };

function parseBody(text: string): ParsedBody {
  if (!text) return { json: true, value: undefined };
  try {
    return { json: true, value: JSON.parse(text) as unknown };
  } catch {
    return { json: false };
  }
}

function snippet(text: string): string {
  const flat = text.replace(/\s+/g, ' ').trim();
  return flat.length <= MAX_SNIPPET ? flat : `${flat.slice(0, MAX_SNIPPET)}…`;
}

/**
 * What to say about a request the server refused.
 *
 * A server that stated a reason has it repeated verbatim, which is the whole of
 * the message and reads as it always did. Everything else falls back through
 * what the body does carry rather than to the HTTP status text: answering
 * "Unprocessable Entity" to a batch whose response named the offending row and
 * field is throwing away the only useful part of the answer.
 */
function describeFailure(response: Response, text: string, parsed: ParsedBody): string {
  const status = `${response.status} ${response.statusText}`.trim();
  if (!parsed.json) {
    return text.trim() ? `${status}, and the body is not JSON: ${snippet(text)}` : status;
  }
  if (parsed.value === undefined || parsed.value === null) return status;

  const body = parsed.value as Record<string, unknown>;
  const stated = body.message ?? body.error_description;
  if (typeof stated === 'string' && stated.trim()) return stated;

  return rowErrors(body) ?? `${status}: ${snippet(JSON.stringify(parsed.value))}`;
}

/**
 * A batch write answers per row: `{errors: [{index, reason}]}`. The index is the
 * caller's own array position, and is left as the server gave it so it lines up
 * with both the payload that was sent and what `--output json` shows.
 */
function rowErrors(body: Record<string, unknown>): string | undefined {
  const errors = body.errors;
  if (!Array.isArray(errors) || errors.length === 0) return undefined;

  const lines = errors.map((item) => {
    if (typeof item === 'string') return item;
    if (item === null || typeof item !== 'object') return String(item);
    const { index, reason, message } = item as { index?: unknown; reason?: unknown; message?: unknown };
    const said = [reason, message].find((value) => typeof value === 'string' && value.trim());
    const text = (said as string | undefined) ?? JSON.stringify(item);
    return typeof index === 'number' ? `row ${index}: ${text}` : text;
  });

  return `${lines.length} row${lines.length === 1 ? '' : 's'} rejected — ${lines.join('; ')}`;
}

/**
 * `Retry-After` is seconds or an HTTP date. Either becomes a wait in
 * milliseconds; anything else means the server gave no usable answer.
 */
function retryAfterMs(response: Response): number | undefined {
  const header = response.headers.get('retry-after');
  if (!header) return undefined;
  if (/^\d+$/.test(header)) return Number.parseInt(header, 10) * 1000;
  const at = Date.parse(header);
  return Number.isNaN(at) ? undefined : Math.max(0, at - Date.now());
}

/** Doubling from half a second, with a little jitter so retries do not march in step. */
function backoffMs(attempt: number): number {
  const base = Math.min(BACKOFF_CAP_MS, BACKOFF_BASE_MS * 2 ** attempt);
  return Math.round(base * (0.75 + Math.random() * 0.5));
}

function isTimeout(error: unknown): boolean {
  const name = (error as { name?: string } | null)?.name;
  return name === 'TimeoutError' || name === 'AbortError';
}

function describeTransport(error: unknown): string {
  const cause = (error as { cause?: { message?: string; code?: string } } | null)?.cause;
  const detail = cause?.code ?? cause?.message ?? (error as Error)?.message ?? String(error);
  return `could not reach the server: ${detail}`;
}

function wait(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export class JinshujuHttpClient implements HttpClient {
  private readonly timeoutMs: number;
  private readonly retries: number;
  private readonly sleep: (ms: number) => Promise<void>;

  constructor(
    private config: LoadedConfig = loadConfig(),
    options: HttpClientOptions = {}
  ) {
    this.timeoutMs = options.timeoutMs ?? config.timeoutMs ?? DEFAULT_TIMEOUT_MS;
    this.retries = options.retries ?? DEFAULT_RETRIES;
    this.sleep = options.sleep ?? wait;
  }

  async request<T>(request: HttpRequest): Promise<T> {
    return this.requestWithAuth<T>(request, true);
  }

  private async requestWithAuth<T>(request: HttpRequest, allowRefresh: boolean): Promise<T> {
    const headers: Record<string, string> = {
      Authorization: await this.authorizationHeader(),
      Accept: 'application/json',
      'User-Agent': `jinshuju-cli/${VERSION} node/${process.versions.node}`
    };
    if (!request.form) headers['Content-Type'] = 'application/json';

    const response = await this.send(request, headers);

    // Only an OAuth session can be refreshed; an access token that stopped
    // working has to be replaced by whoever issued it.
    if (response.status === 401 && allowRefresh && !this.config.accessToken && this.config.auth?.refresh_token) {
      await response.text();
      this.config.auth = await refreshOAuthToken(this.config);
      return this.requestWithAuth<T>(request, false);
    }

    const text = await response.text();
    const parsed = parseBody(text);

    // Parsing is not allowed to decide whether the request failed. A 500 answers
    // with an HTML error page and a gateway with its own, and parsing first
    // turned both into "Unexpected token '<'", throwing away the status that was
    // the only thing that said what had happened.
    if (!response.ok) {
      throw new HttpError(describeFailure(response, text, parsed), response.status, parsed.json ? parsed.value : text);
    }
    if (!parsed.json) {
      throw new HttpError(
        `${response.status} ${response.statusText}, but the body is not JSON: ${snippet(text)}`,
        response.status,
        text
      );
    }
    return parsed.value as T;
  }

  /**
   * One request, tried again when trying again is safe and could help. Every
   * attempt has its own deadline; without one a connection the network quietly
   * dropped would hold the command open for as long as the caller waited.
   */
  private async send(request: HttpRequest, headers: Record<string, string>): Promise<Response> {
    const read = request.method === 'GET';
    for (let attempt = 0; ; attempt += 1) {
      const last = attempt >= this.retries;
      let response: Response;
      try {
        response = await fetch(`${this.config.host}${withQuery(request.path, request.query)}`, {
          method: request.method,
          headers,
          body: request.form ?? (request.body === undefined ? undefined : JSON.stringify(request.body)),
          signal: AbortSignal.timeout(this.timeoutMs)
        });
      } catch (error) {
        const timedOut = isTimeout(error);
        if (read && !last) {
          await this.sleep(backoffMs(attempt));
          continue;
        }
        throw new TransportError(
          timedOut ? `request timed out after ${this.timeoutMs}ms` : describeTransport(error),
          timedOut,
          error
        );
      }

      const again = RETRY_ANY.has(response.status) || (read && RETRY_READS.has(response.status));
      if (!again || last) return response;

      // The body is drained so the connection goes back to the pool.
      await response.text();
      await this.sleep(retryAfterMs(response) ?? backoffMs(attempt));
    }
  }

  /**
   * An explicitly configured credential outranks a stored session: someone who
   * set a token in the environment meant this request to use it, and finding a
   * login from last week used instead would be a surprise with no signal.
   * `auth status` says which one is in play and where it came from.
   */
  private async authorizationHeader(): Promise<string> {
    if (this.config.accessToken) return `Bearer ${this.config.accessToken}`;

    if (this.config.apiKey && this.config.apiSecret) {
      const credentials = Buffer.from(`${this.config.apiKey}:${this.config.apiSecret}`).toString('base64');
      return `Basic ${credentials}`;
    }

    if (this.config.auth?.access_token) {
      if (shouldRefresh(this.config.auth) && this.config.auth.refresh_token) {
        this.config.auth = await refreshOAuthToken(this.config);
      }
      return `Bearer ${this.config.auth.access_token}`;
    }

    throw new AuthError(
      'Missing authentication. Run `jinshuju auth login`, or configure JINSHUJU_ACCESS_TOKEN, or JINSHUJU_API_KEY with JINSHUJU_API_SECRET.'
    );
  }
}
