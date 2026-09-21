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
    const body = text ? JSON.parse(text) : undefined;
    if (!response.ok) {
      const error = new Error(body?.message ?? body?.error_description ?? response.statusText);
      Object.assign(error, { status: response.status, body });
      throw error;
    }
    return body as T;
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

    throw new Error('Missing authentication. Run `jinshuju auth login`, or configure JINSHUJU_ACCESS_TOKEN, or JINSHUJU_API_KEY with JINSHUJU_API_SECRET.');
  }
}
