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

/** ADR 0003 and ADR 0004. Everything the model added that is not on the page,
 *  with how much it should be trusted. `disputed` means the sources contradict
 *  the page, which usually means the page is wrong. */
export interface Expansion {
  term: string;
  text: string;
  confidence: 'high' | 'low' | 'unsupported' | 'disputed' | 'contradicted' | 'refused' | 'sourced';
  reason: string | null;
  agreement: number | null;
  sources: Array<{ title: string; url: string }>;
}

export interface Draft {
  sessionId: string;
  suggestedTitle: string;
  course: string;
  pages: PageDraft[];
  /** Absent when expansion is switched off. */
  expansions?: Expansion[];
  expansionError?: string | null;
}

export interface OllamaStatus {
  host: string;
  running: boolean;
  installed: boolean;
  version: string | null;
  install: { platform: string; command: string; note: string } | null;
  models: { name: string; sizeBytes: number; vision: boolean }[];
  recommended: { name: string; label: string; note: string; recommended: boolean }[];
  rejected: Record<string, string>;
}

export interface PullState {
  model: string;
  status: string;
  percent?: number;
  done: boolean;
  error?: string;
  idle?: boolean;
}

export const api = {
  status: () => call<Status>('GET', '/api/status'),
  setup: (body: unknown) =>
    call<{ deviceId: string; recoveryPhrase: string }>('POST', '/api/setup', body),
  pairing: () => call<{ qr: string; expiresAt: string }>('POST', '/api/pairing'),
  refresh: () => call<{ drafts: number }>('POST', '/api/refresh'),
  drafts: () => call<{ drafts: Draft[] }>('GET', '/api/drafts'),
  approve: (sessionId: string, body: unknown) =>
    call<{ notePath: string; commitSha: string; acked: number }>(
      'POST', `/api/drafts/${sessionId}/approve`, body,
    ),
  push: () => call<{ outcome: string }>('POST', '/api/push'),
  config: () => call<Record<string, unknown>>('GET', '/api/config'),

  restore: (body: unknown) =>
    call<{ deviceId: string; restored: boolean }>('POST', '/api/restore', body),

  ollamaStatus: (host?: string) =>
    call<OllamaStatus>('GET', `/api/ollama/status${host ? `?host=${encodeURIComponent(host)}` : ''}`),
  pullModel: (model: string, host?: string) =>
    call<{ started: boolean }>('POST', '/api/ollama/pull', { model, host }),
  pullStatus: () => call<PullState>('GET', '/api/ollama/pull'),
  probeModel: (model: string, numCtx: number, host?: string) =>
    call<{ ok: boolean; message: string; promptTokens?: number; suggestedNumCtx?: number }>(
      'POST', '/api/ollama/probe', { model, numCtx, host },
    ),
};
