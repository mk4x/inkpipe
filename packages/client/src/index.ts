// Signed HTTP client, shared by the phone app and the desktop agent.
//
// Both sides sign requests identically, and the signing string comes from
// @inkpipe/protocol rather than being rebuilt here, so client and server cannot
// disagree about what was signed.

import { AUTH_HEADERS, signingString } from '@inkpipe/protocol';
import { sign, toBase64Url, sha256Hex } from '@inkpipe/crypto';

export interface Credentials {
  deviceId: string;
  ed25519PrivateKey: Uint8Array;
}

export interface ClientOptions {
  baseUrl: string;
  credentials?: Credentials;
  /** Injectable for tests that need to forge a stale timestamp. */
  now?: () => Date;
  fetchImpl?: typeof fetch;
}

// Note: no TypeScript parameter properties anywhere in this repo. Node runs
// these files with strip-only type removal, which cannot synthesise the field
// assignments a parameter property implies. Assign explicitly instead.
export class ApiError extends Error {
  status: number;
  code: string;

  constructor(status: number, code: string, message: string) {
    super(message);
    this.name = 'ApiError';
    this.status = status;
    this.code = code;
  }
}

export class InkpipeClient {
  private readonly options: ClientOptions;

  constructor(options: ClientOptions) {
    this.options = options;
  }

  async request<T>(method: string, path: string, body?: unknown): Promise<T> {
    const { baseUrl, credentials } = this.options;
    const now = this.options.now ?? (() => new Date());
    const doFetch = this.options.fetchImpl ?? fetch;

    const rawBody = body === undefined ? '' : JSON.stringify(body);
    const headers: Record<string, string> = {};
    if (body !== undefined) headers['content-type'] = 'application/json';

    if (credentials) {
      const timestamp = now().toISOString();
      const message = new TextEncoder().encode(
        signingString({
          method,
          path,
          timestamp,
          bodySha256Hex: sha256Hex(new TextEncoder().encode(rawBody)),
        }),
      );
      headers[AUTH_HEADERS.deviceId] = credentials.deviceId;
      headers[AUTH_HEADERS.timestamp] = timestamp;
      headers[AUTH_HEADERS.signature] = toBase64Url(sign(message, credentials.ed25519PrivateKey));
    }

    const response = await doFetch(`${baseUrl}${path}`, {
      method,
      headers,
      body: body === undefined ? undefined : rawBody,
    });

    const responseText = await response.text();
    let parsed: unknown = undefined;
    if (responseText.length > 0) {
      try {
        parsed = JSON.parse(responseText);
      } catch {
        throw new ApiError(response.status, 'bad_response', `non-JSON response: ${responseText.slice(0, 200)}`);
      }
    }

    if (!response.ok) {
      const errorBody = parsed as { error?: string; message?: string } | undefined;
      throw new ApiError(
        response.status,
        errorBody?.error ?? 'unknown',
        errorBody?.message ?? `request failed with ${response.status}`,
      );
    }

    return parsed as T;
  }

  get<T>(path: string): Promise<T> {
    return this.request<T>('GET', path);
  }

  post<T>(path: string, body?: unknown): Promise<T> {
    return this.request<T>('POST', path, body ?? {});
  }
}
