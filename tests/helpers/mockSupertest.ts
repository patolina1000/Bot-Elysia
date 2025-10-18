import http from 'node:http';
import type { AddressInfo } from 'node:net';

export interface SupertestResponse {
  status: number;
  body: any;
  text: string;
  headers: Record<string, string>;
}

class TestRequest implements PromiseLike<SupertestResponse> {
  private headers: Record<string, string> = {};
  private queryParams: Record<string, string> = {};
  private payload: any;

  constructor(private readonly app: any, private readonly method: string, private readonly path: string) {}

  set(name: string | Record<string, string>, value?: string): this {
    if (typeof name === 'string') {
      if (value === undefined) {
        return this;
      }
      this.headers[name.toLowerCase()] = value;
      return this;
    }

    for (const [key, val] of Object.entries(name ?? {})) {
      this.headers[key.toLowerCase()] = String(val);
    }
    return this;
  }

  query(params: Record<string, unknown>): this {
    for (const [key, value] of Object.entries(params ?? {})) {
      if (value === undefined || value === null) continue;
      this.queryParams[key] = String(value);
    }
    return this;
  }

  send(payload: any): this {
    this.payload = payload;
    return this;
  }

  async expect(status: number): Promise<SupertestResponse> {
    const response = await this.execute();
    if (response.status !== status) {
      throw new Error(`Expected status ${status} but received ${response.status}`);
    }
    return response;
  }

  then<TResult1 = SupertestResponse, TResult2 = never>(
    onfulfilled?: ((value: SupertestResponse) => TResult1 | PromiseLike<TResult1>) | undefined | null,
    onrejected?: ((reason: any) => TResult2 | PromiseLike<TResult2>) | undefined | null
  ): Promise<TResult1 | TResult2> {
    return this.execute().then(onfulfilled, onrejected);
  }

  private buildUrl(base: string): string {
    const query = new URLSearchParams(this.queryParams);
    if (query.toString()) {
      return `${base}${this.path}?${query.toString()}`;
    }
    return `${base}${this.path}`;
  }

  private async execute(): Promise<SupertestResponse> {
    const server = http.createServer(this.app);

    await new Promise<void>((resolve) => {
      server.listen(0, '127.0.0.1', () => resolve());
    });

    const { port } = server.address() as AddressInfo;
    const url = this.buildUrl(`http://127.0.0.1:${port}`);

    const headers = { ...this.headers };
    let body: string | undefined;

    if (this.payload !== undefined) {
      if (typeof this.payload === 'string' || this.payload instanceof Buffer) {
        body = this.payload.toString();
      } else {
        body = JSON.stringify(this.payload);
        headers['content-type'] = headers['content-type'] ?? 'application/json';
      }
    }

    const response = await fetch(url, {
      method: this.method,
      headers,
      body,
    });

    const text = await response.text();
    let parsed: any = null;
    try {
      parsed = text ? JSON.parse(text) : null;
    } catch {
      parsed = text;
    }

    const result: SupertestResponse = {
      status: response.status,
      body: parsed,
      text,
      headers: Object.fromEntries(response.headers.entries()),
    };

    await new Promise<void>((resolve) => server.close(() => resolve()));

    return result;
  }
}

class SupertestAgent {
  constructor(private readonly app: any) {}

  get(path: string): TestRequest {
    return new TestRequest(this.app, 'GET', path);
  }

  post(path: string): TestRequest {
    return new TestRequest(this.app, 'POST', path);
  }

  put(path: string): TestRequest {
    return new TestRequest(this.app, 'PUT', path);
  }

  delete(path: string): TestRequest {
    return new TestRequest(this.app, 'DELETE', path);
  }
}

export default function supertest(app: any): SupertestAgent {
  return new SupertestAgent(app);
}
