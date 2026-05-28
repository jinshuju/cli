import { loadConfig, type LoadedConfig } from './config.js';
import { refreshOAuthToken, shouldRefresh } from './auth.js';

export type HttpMethod = 'GET' | 'POST' | 'PATCH' | 'DELETE';

export type HttpRequest = {
  method: HttpMethod | string;
  path: string;
  body?: unknown;
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
    const response = await fetch(`${this.baseUrl}${request.path}`, {
      method: request.method,
      headers: {
        Authorization: await this.authorizationHeader(),
        Accept: 'application/json',
        'Content-Type': 'application/json'
      },
      body: request.body === undefined ? undefined : JSON.stringify(request.body)
    });

    if (response.status === 401 && allowRefresh && this.config.auth?.refresh_token) {
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

  private async authorizationHeader(): Promise<string> {
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

    throw new Error('Missing authentication. Run `jinshuju auth login` or configure JINSHUJU_API_KEY and JINSHUJU_API_SECRET.');
  }
}
