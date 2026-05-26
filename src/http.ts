import { loadConfig, type LoadedConfig } from './config.js';

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
    private readonly config: LoadedConfig = loadConfig(),
    private readonly baseUrl = 'https://jinshuju.net'
  ) {}

  async request<T>(request: HttpRequest): Promise<T> {
    if (!this.config.apiKey || !this.config.apiSecret) {
      throw new Error('Missing JINSHUJU_API_KEY or JINSHUJU_API_SECRET');
    }

    const credentials = Buffer.from(`${this.config.apiKey}:${this.config.apiSecret}`).toString('base64');
    const response = await fetch(`${this.baseUrl}${request.path}`, {
      method: request.method,
      headers: {
        Authorization: `Basic ${credentials}`,
        Accept: 'application/json',
        'Content-Type': 'application/json'
      },
      body: request.body === undefined ? undefined : JSON.stringify(request.body)
    });

    const text = await response.text();
    const body = text ? JSON.parse(text) : undefined;
    if (!response.ok) {
      const error = new Error(body?.message ?? response.statusText);
      Object.assign(error, { status: response.status, body });
      throw error;
    }
    return body as T;
  }
}
