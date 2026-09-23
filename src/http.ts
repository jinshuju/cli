import { loadConfig, type LoadedConfig } from './config.js';
import { refreshOAuthToken, shouldRefresh } from './auth.js';

export type HttpMethod = 'GET' | 'POST' | 'PATCH' | 'DELETE';

export type HttpRequest = {
  method: HttpMethod | string;
  path: string;
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

export class JinshujuHttpClient implements HttpClient {
  constructor(
    private config: LoadedConfig = loadConfig(),
    private readonly baseUrl = config.host
  ) {}

  async request<T>(request: HttpRequest): Promise<T> {
    return this.requestWithAuth<T>(request, true);
  }

  private async requestWithAuth<T>(request: HttpRequest, allowRefresh: boolean): Promise<T> {
    const headers: Record<string, string> = {
      Authorization: await this.authorizationHeader(),
      Accept: 'application/json'
    };
    if (!request.form) headers['Content-Type'] = 'application/json';

    const response = await fetch(`${this.baseUrl}${request.path}`, {
      method: request.method,
      headers,
      body: request.form ?? (request.body === undefined ? undefined : JSON.stringify(request.body))
    });

    // Only an OAuth session can be refreshed; an access token that stopped
    // working has to be replaced by whoever issued it.
    if (response.status === 401 && allowRefresh && !this.config.accessToken && this.config.auth?.refresh_token) {
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
      const error = new Error(describeFailure(response, text, parsed));
      Object.assign(error, { status: response.status, body: parsed.json ? parsed.value : text });
      throw error;
    }
    if (!parsed.json) {
      throw new Error(`${response.status} ${response.statusText}, but the body is not JSON: ${snippet(text)}`);
    }
    return parsed.value as T;
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

    throw new Error(
      'Missing authentication. Run `jinshuju auth login`, or configure JINSHUJU_ACCESS_TOKEN, or JINSHUJU_API_KEY with JINSHUJU_API_SECRET.'
    );
  }
}
