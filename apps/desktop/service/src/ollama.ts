// Ollama detection, installation guidance, model pulls, and the context check.
//
// Decision 18: the wizard does everything it can, but it does not silently
// escalate privileges and it does not pipe a remote script into a shell. It
// shows the exact command, you approve it, and the OS shows its own prompt.
//
// ADR 0001 finding 3b is why `probeContext` exists: the same prepared page cost
// qwen2.5vl:7b about 1600 image tokens and granite3.2-vision:2b 7529. A model
// whose images overflow the context fails with an HTTP 400 mid-session rather
// than degrading, so the wizard checks before you rely on it.

import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

const run = promisify(execFile);

export interface OllamaModel {
  name: string;
  sizeBytes: number;
  /** Ollama reports vision models with a "vision" capability family. */
  vision: boolean;
}

/** Models measured in ADR 0001, best first. Shown as suggestions in the wizard
 *  so a new user is not guessing from a list of hundreds. */
export const RECOMMENDED_MODELS = [
  {
    name: 'qwen2.5vl:7b',
    label: 'Qwen2.5-VL 7B',
    note: 'Measured best on the corpus. CER 0.10 on linear pages. About 6 GB.',
    recommended: true,
  },
  {
    name: 'qwen2.5vl:32b',
    label: 'Qwen2.5-VL 32B',
    note: 'Untested here. Needs roughly 20 GB of VRAM, more than a 16 GB card has.',
    recommended: false,
  },
] as const;

/** Models ADR 0001 tested and rejected, so the wizard can warn rather than let
 *  someone rediscover the same failure. */
export const REJECTED_MODELS: Record<string, string> = {
  'minicpm-v': 'Rejected in ADR 0001: produced degenerate repetition on every corpus page.',
  'minicpm-v:8b': 'Rejected in ADR 0001: produced degenerate repetition on every corpus page.',
  'granite3.2-vision': 'Rejected in ADR 0001: CER above 1.7, and its images cost over 7000 tokens.',
  'granite3.2-vision:2b': 'Rejected in ADR 0001: CER above 1.7, and its images cost over 7000 tokens.',
  'llama3.2-vision': 'Will not load on Ollama 0.33: unknown model architecture "mllama".',
  'llama3.2-vision:11b': 'Will not load on Ollama 0.33: unknown model architecture "mllama".',
};

export async function isServerRunning(host: string, timeoutMs = 3000): Promise<boolean> {
  try {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    try {
      return (await fetch(`${host}/api/tags`, { signal: controller.signal })).ok;
    } finally {
      clearTimeout(timer);
    }
  } catch {
    return false;
  }
}

/**
 * Is the binary on this process's PATH?
 *
 * Note what this does NOT mean. Ollama installs to a per-user directory that is
 * often absent from the PATH a background service inherits, so a `false` here
 * is perfectly compatible with Ollama being installed and serving requests.
 * Callers must treat a reachable server as authoritative: see `detect()`.
 */
export async function isBinaryOnPath(): Promise<{ onPath: boolean; version?: string }> {
  const candidates = [
    'ollama',
    // Windows per-user install, which is the default and is usually not on the
    // PATH of anything that did not start from a fresh shell.
    process.env.LOCALAPPDATA ? `${process.env.LOCALAPPDATA}\\Programs\\Ollama\\ollama.exe` : null,
    '/usr/local/bin/ollama',
    '/opt/homebrew/bin/ollama',
  ].filter((c): c is string => c !== null);

  for (const candidate of candidates) {
    try {
      const { stdout } = await run(candidate, ['--version'], { timeout: 5000 });
      return { onPath: true, version: stdout.trim() };
    } catch {
      // Try the next location.
    }
  }
  return { onPath: false };
}

export interface Detection {
  /** Ollama is usable: either the binary was found or the server answered. */
  installed: boolean;
  running: boolean;
  version: string | null;
}

/**
 * Whether Ollama is usable at all.
 *
 * A reachable server is proof of installation and outranks a failed PATH
 * lookup. Getting this backwards told a user with a working Ollama to install
 * the copy they already had.
 */
export async function detect(host: string): Promise<Detection> {
  const [running, binary] = await Promise.all([isServerRunning(host), isBinaryOnPath()]);
  return {
    installed: binary.onPath || running,
    running,
    version: binary.version ?? null,
  };
}

/**
 * The exact command to install Ollama, per platform.
 *
 * Returned rather than executed. On Windows this triggers a UAC prompt, and on
 * Linux it is a remote script that needs sudo. Neither is something this
 * process should do behind the user's back.
 */
export function installInstructions(): { platform: string; command: string; note: string } {
  if (process.platform === 'win32') {
    return {
      platform: 'Windows',
      command: 'winget install --id Ollama.Ollama',
      note: 'Windows will show its own permission prompt. inkpipe cannot and does not bypass it.',
    };
  }
  if (process.platform === 'darwin') {
    return {
      platform: 'macOS',
      command: 'brew install ollama',
      note: 'Or download the installer from ollama.com.',
    };
  }
  return {
    platform: 'Linux',
    command: 'curl -fsSL https://ollama.com/install.sh | sh',
    note: 'Run this yourself in a terminal. inkpipe will not pipe a remote script into a shell for you.',
  };
}

export async function listModels(host: string): Promise<OllamaModel[]> {
  const response = await fetch(`${host}/api/tags`);
  if (!response.ok) throw new Error(`ollama returned ${response.status} listing models`);

  const body = (await response.json()) as {
    models?: { name: string; size?: number; details?: { families?: string[] } }[];
  };

  return (body.models ?? []).map((m) => ({
    name: m.name,
    sizeBytes: m.size ?? 0,
    vision: (m.details?.families ?? []).some((f) => /clip|vision|mllama|qwen2vl|qwen25vl/i.test(f)),
  }));
}

export interface PullProgress {
  status: string;
  completedBytes?: number;
  totalBytes?: number;
  percent?: number;
}

/**
 * Pull a model, reporting progress.
 *
 * Ollama streams newline-delimited JSON. A multi-gigabyte download with no
 * feedback looks identical to a hang, so the wizard needs each line.
 */
export async function pullModel(
  host: string,
  name: string,
  onProgress: (progress: PullProgress) => void,
  signal?: AbortSignal,
): Promise<void> {
  const response = await fetch(`${host}/api/pull`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ model: name, stream: true }),
    signal,
  });

  if (!response.ok || !response.body) {
    throw new Error(`ollama returned ${response.status} pulling ${name}`);
  }

  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';

  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;

    buffer += decoder.decode(value, { stream: true });
    const lines = buffer.split('\n');
    // The last element may be a partial line, so it stays in the buffer.
    buffer = lines.pop() ?? '';

    for (const line of lines) {
      if (line.trim().length === 0) continue;
      let parsed: { status?: string; completed?: number; total?: number; error?: string };
      try {
        parsed = JSON.parse(line);
      } catch {
        continue;
      }
      if (parsed.error) throw new Error(parsed.error);

      onProgress({
        status: parsed.status ?? 'working',
        completedBytes: parsed.completed,
        totalBytes: parsed.total,
        percent: parsed.total && parsed.completed
          ? Math.round((parsed.completed / parsed.total) * 100)
          : undefined,
      });
    }
  }
}

export interface ContextProbe {
  ok: boolean;
  /** Tokens this model charged for the probe image, when it told us. */
  promptTokens?: number;
  /** A num_ctx that would fit, when the probe overflowed. */
  suggestedNumCtx?: number;
  message: string;
}

/**
 * Check that a real prepared page fits this model's context.
 *
 * ADR 0001 finding 3b: image token cost varies more than 4x between models, so
 * "1600px is fine" is not portable. Overflow is an HTTP 400 mid-session, which
 * is a miserable way to discover it.
 */
export async function probeContext(
  host: string,
  model: string,
  numCtx: number,
  image: Uint8Array,
): Promise<ContextProbe> {
  try {
    const response = await fetch(`${host}/api/generate`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        model,
        prompt: 'Reply with the single word: ok',
        images: [Buffer.from(image).toString('base64')],
        stream: false,
        options: { temperature: 0, num_predict: 4, num_ctx: numCtx },
      }),
    });

    if (response.ok) {
      return { ok: true, message: `A prepared page fits in ${numCtx} tokens of context.` };
    }

    const text = await response.text();
    const tokens = Number(text.match(/n_prompt_tokens[^0-9]*(\d+)/)?.[1] ?? NaN);
    const requested = Number(text.match(/request \((\d+) tokens\)/)?.[1] ?? NaN);
    const actual = Number.isFinite(tokens) ? tokens : requested;

    if (Number.isFinite(actual)) {
      // Round up to the next power of two with headroom for the transcript.
      const needed = nextPowerOfTwo(actual + 2048);
      return {
        ok: false,
        promptTokens: actual,
        suggestedNumCtx: needed,
        message:
          `A prepared page costs ${actual} tokens with this model, which does not fit in ` +
          `${numCtx}. Raise the context to ${needed}, or choose a different model.`,
      };
    }

    return { ok: false, message: `Ollama refused the probe: ${text.slice(0, 200)}` };
  } catch (error) {
    return { ok: false, message: `Could not reach Ollama: ${(error as Error).message}` };
  }
}

function nextPowerOfTwo(n: number): number {
  let value = 4096;
  while (value < n) value *= 2;
  return value;
}
