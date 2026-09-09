// Talking to the sidecar.
//
// The UI token is injected by the Tauri shell (or, in dev, read from the URL
// hash). It never lives in localStorage: a token that outlives the process it
// authenticates is a token that can be replayed against the next one.

const params = new URLSearchParams(location.hash.slice(1));
export const UI_TOKEN = params.get('token') ?? '';

export class ServiceError extends Error {
  status: number;
  code: string;

  constructor(status: number, code: string, message: string) {
    super(message);
    this.name = 'ServiceError';
    this.status = status;
    this.code = code;
  }
}

async function call<T>(method: string, path: string, body?: unknown): Promise<T> {
  const response = await fetch(path, {
    method,
    headers: {
      'x-inkpipe-ui-token': UI_TOKEN,
      ...(body === undefined ? {} : { 'content-type': 'application/json' }),
    },
    body: body === undefined ? undefined : JSON.stringify(body),
  });

  const text = await response.text();
  const parsed = text ? JSON.parse(text) : undefined;

  if (!response.ok) {
    const err = parsed as { error?: string; message?: string } | undefined;
    throw new ServiceError(response.status, err?.error ?? 'unknown', err?.message ?? `HTTP ${response.status}`);
  }
  return parsed as T;
}

export interface Status {
  configured: boolean;
  serverUrl?: string;
  serverReachable?: boolean;
  ollamaReachable?: boolean;
  model?: string;
  vaultRoot?: string;
  vaultOk?: boolean;
  vaultClean?: boolean;
  pending?: number;
  drafts?: number;
  refreshing?: boolean;
  lastError?: string | null;
}

export interface PageDraft {
  blobId: string;
  seq: number;
  markdown: string;
  ok: boolean;
  variantUsed: string | null;
  failureReason: string | null;
  sanitiserChanges: string[];
  imageDataUrl: string;
}

export interface Draft {
  sessionId: string;
  suggestedTitle: string;
  course: string;
  pages: PageDraft[];
}

export const api = {
  status: () => call<Status>('GET', '/api/status'),
  setup: (body: unknown) => call<{ deviceId: string }>('POST', '/api/setup', body),
  pairing: () => call<{ qr: string; expiresAt: string }>('POST', '/api/pairing'),
  refresh: () => call<{ drafts: number }>('POST', '/api/refresh'),
  drafts: () => call<{ drafts: Draft[] }>('GET', '/api/drafts'),
  approve: (sessionId: string, body: unknown) =>
    call<{ notePath: string; commitSha: string; acked: number }>(
      'POST', `/api/drafts/${sessionId}/approve`, body,
    ),
  push: () => call<{ outcome: string }>('POST', '/api/push'),
  config: () => call<Record<string, unknown>>('GET', '/api/config'),
};
