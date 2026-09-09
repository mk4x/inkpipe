// The local API the desktop UI talks to.
//
// Bound to loopback and protected by a token generated per launch (ADR 0002):
// any process running as this user could otherwise drive the pipeline, and the
// pipeline holds the content private key and can write to the vault.
//
// This process is the only place the private key exists at runtime. The webview
// never sees it, which is what preserves the property decision 16 wanted.

import Fastify, { type FastifyInstance, type FastifyRequest, type FastifyReply } from 'fastify';
import { randomUUID, randomBytes, timingSafeEqual } from 'node:crypto';
import { InkpipeClient, ApiError } from '@inkpipe/client';
import { toBase64Url } from '@inkpipe/crypto';
import { collectDrafts, renderNote, type Draft } from '../../../agent/src/pipeline.ts';
import { ollamaModel } from '../../../agent/src/transcribe.ts';
import { writeNote, push as pushVault, isDirty, isGitRepo, VaultError } from '../../../agent/src/vault.ts';
import {
  loadConfig, saveConfig, configExists, glossaryFor, addGlossaryTerms,
  Config, ConfigError, type Config as ConfigType,
} from './config.ts';
import { createKeys, loadKeys, keystoreExists, type DeviceKeys } from './keystore.ts';

export interface ServiceOptions {
  configPath?: string;
  keystorePath?: string;
  /** Injected in tests so no real model is needed. */
  modelFactory?: (config: ConfigType) => (prompt: string, image: Uint8Array) => Promise<string>;
}

export interface ServiceHandle {
  app: FastifyInstance;
  token: string;
}

/** Constant-time compare so the token cannot be guessed a byte at a time. */
function tokensMatch(a: string, b: string): boolean {
  const left = Buffer.from(a);
  const right = Buffer.from(b);
  if (left.length !== right.length) return false;
  return timingSafeEqual(left, right);
}

export function createService(options: ServiceOptions = {}): ServiceHandle {
  const token = randomBytes(24).toString('base64url');
  const app = Fastify({ logger: false, bodyLimit: 32 * 1024 * 1024 });

  // In-memory draft cache. Drafts are expensive (a model call per page) and the
  // preview needs to re-render them as the user edits, so they are computed
  // once per refresh rather than per request.
  let drafts: Draft[] = [];
  let refreshing = false;
  let lastError: string | null = null;

  const state = () => {
    const configured = configExists(options.configPath) && keystoreExists(options.keystorePath);
    return { configured };
  };

  const readConfig = (): ConfigType => loadConfig(options.configPath);
  const readKeys = (): DeviceKeys => loadKeys(options.keystorePath);

  const clientFor = (config: ConfigType, keys: DeviceKeys) =>
    new InkpipeClient({
      baseUrl: config.serverUrl,
      credentials: { deviceId: config.deviceId, ed25519PrivateKey: keys.identity.privateKey },
    });

  // --- auth --------------------------------------------------------------
  app.addHook('onRequest', async (request: FastifyRequest, reply: FastifyReply) => {
    // Only the API is guarded. The static UI bundle carries no secrets, and
    // guarding it would mean the page could not load in order to present the
    // token it was given. Liveness is exempt so a supervisor can poll it.
    const path = request.url.split('?')[0];
    if (!path.startsWith('/api/') || path === '/api/health') return;

    const provided = request.headers['x-inkpipe-ui-token'];
    if (typeof provided !== 'string' || !tokensMatch(provided, token)) {
      reply.code(401).send({ error: 'unauthorised', message: 'bad or missing UI token' });
    }
  });

  app.get('/api/health', async () => ({ ok: true }));

  // --- status ------------------------------------------------------------
  app.get('/api/status', async () => {
    if (!state().configured) {
      return { configured: false };
    }
    const config = readConfig();
    const keys = readKeys();

    const [serverReachable, ollamaReachable, vaultOk, vaultClean] = await Promise.all([
      reachable(`${config.serverUrl}/health`),
      reachable(`${config.model.host}/api/tags`),
      isGitRepo(config.vault.root).catch(() => false),
      isDirty(config.vault.root).then((d) => !d).catch(() => false),
    ]);

    let pending = 0;
    if (serverReachable) {
      try {
        const listed = await clientFor(config, keys).get<{ blobs: unknown[] }>('/blobs');
        pending = listed.blobs.length;
      } catch { /* reported via serverReachable */ }
    }

    return {
      configured: true,
      serverUrl: config.serverUrl,
      serverReachable,
      ollamaReachable,
      model: config.model.name,
      vaultRoot: config.vault.root,
      vaultOk,
      vaultClean,
      pending,
      drafts: drafts.length,
      refreshing,
      lastError,
    };
  });

  // --- setup -------------------------------------------------------------
  app.post('/api/setup', async (request, reply) => {
    if (state().configured) {
      return reply.code(409).send({ error: 'already_configured', message: 'config already exists' });
    }

    const body = z_SetupRequest.safeParse(request.body);
    if (!body.success) {
      return reply.code(400).send({ error: 'bad_request', message: body.error.message });
    }

    if (!(await isGitRepo(body.data.vault.root))) {
      return reply.code(400).send({
        error: 'bad_vault',
        message: `${body.data.vault.root} is not a git repository. inkpipe commits notes, so the vault must be one.`,
      });
    }

    const keys = createKeys(options.keystorePath);

    let registered: { accountId: string; deviceId: string };
    try {
      registered = await new InkpipeClient({ baseUrl: body.data.serverUrl })
        .post<{ accountId: string; deviceId: string }>('/pair/register-pc', {
          joinToken: body.data.joinToken,
          ed25519PublicKey: toBase64Url(keys.identity.publicKey),
          x25519PublicKey: toBase64Url(keys.content.publicKey),
          label: body.data.label,
        });
    } catch (error) {
      const apiError = error as ApiError;
      return reply.code(502).send({
        error: 'registration_failed',
        message: `could not register with ${body.data.serverUrl}: ${apiError.message}`,
      });
    }

    const config = Config.parse({
      version: 1,
      serverUrl: body.data.serverUrl,
      deviceId: registered.deviceId,
      vault: body.data.vault,
      courses: body.data.courses ?? [],
      defaultCourse: body.data.defaultCourse ?? 'General',
      model: body.data.model ?? {},
      pollSeconds: body.data.pollSeconds ?? 60,
      verbosity: body.data.verbosity ?? 'cleaned',
      cloudEscalationEnabled: false,
    });
    saveConfig(config, options.configPath);

    return reply.code(201).send({ deviceId: registered.deviceId });
  });

  // --- pairing -----------------------------------------------------------
  app.post('/api/pairing', async (_request, reply) => {
    if (!state().configured) {
      return reply.code(409).send({ error: 'not_configured', message: 'run setup first' });
    }
    const config = readConfig();
    const keys = readKeys();
    try {
      const pairing = await clientFor(config, keys).post<Record<string, unknown>>(
        '/pair/create', { ttlSeconds: 300 },
      );
      // The QR payload is exactly what the phone needs and nothing more.
      return reply.send({
        qr: JSON.stringify({
          v: 1,
          serverUrl: config.serverUrl,
          pairingToken: pairing.pairingToken,
          x25519PublicKey: pairing.x25519PublicKey,
        }),
        expiresAt: pairing.expiresAt,
      });
    } catch (error) {
      return reply.code(502).send({ error: 'pairing_failed', message: (error as Error).message });
    }
  });

  // --- drafts ------------------------------------------------------------
  app.post('/api/refresh', async (_request, reply) => {
    if (!state().configured) {
      return reply.code(409).send({ error: 'not_configured', message: 'run setup first' });
    }
    if (refreshing) {
      return reply.code(202).send({ refreshing: true });
    }

    const config = readConfig();
    const keys = readKeys();
    refreshing = true;
    lastError = null;

    try {
      const model = options.modelFactory
        ? options.modelFactory(config)
        : ollamaModel({
            model: config.model.name,
            host: config.model.host,
            numCtx: config.model.numCtx,
            timeoutMs: config.model.timeoutMs,
          });

      drafts = await collectDrafts({
        client: clientFor(config, keys),
        contentPrivateKey: keys.content.privateKey,
        course: config.defaultCourse,
        glossary: glossaryFor(config, config.defaultCourse),
        model,
      });
      return reply.send({ drafts: drafts.length });
    } catch (error) {
      lastError = (error as Error).message;
      return reply.code(502).send({ error: 'refresh_failed', message: lastError });
    } finally {
      refreshing = false;
    }
  });

  app.get('/api/drafts', async () => ({
    drafts: drafts.map((draft) => ({
      sessionId: draft.sessionId,
      suggestedTitle: draft.suggestedTitle,
      course: draft.course,
      pages: draft.pages.map((page) => ({
        blobId: page.blobId,
        seq: page.seq,
        markdown: page.markdown,
        ok: page.ok,
        variantUsed: page.variantUsed,
        failureReason: page.failureReason,
        sanitiserChanges: page.sanitiserChanges,
        // The preview must show the photograph beside the text, so the image
        // travels to the UI as a data URL rather than a file path.
        imageDataUrl: `data:image/webp;base64,${Buffer.from(page.vaultImage).toString('base64')}`,
      })),
    })),
  }));

  // --- approve -----------------------------------------------------------
  app.post<{ Params: { sessionId: string } }>('/api/drafts/:sessionId/approve', async (request, reply) => {
    const draft = drafts.find((d) => d.sessionId === request.params.sessionId);
    if (!draft) {
      return reply.code(404).send({ error: 'not_found', message: 'no such draft' });
    }

    const body = z_ApproveRequest.safeParse(request.body);
    if (!body.success) {
      return reply.code(400).send({ error: 'bad_request', message: body.error.message });
    }

    const config = readConfig();
    const keys = readKeys();

    // The user's edits win over the model's proposal, always.
    const edited: Draft = {
      ...draft,
      suggestedTitle: body.data.title,
      course: body.data.course,
      pages: draft.pages.map((page) => {
        const override = body.data.pages?.find((p) => p.blobId === page.blobId);
        return override ? { ...page, markdown: override.markdown, ok: true } : page;
      }),
    };

    try {
      const result = await writeNote(
        {
          root: config.vault.root,
          notesPath: config.vault.notesPath,
          attachmentsPath: config.vault.attachmentsPath,
        },
        {
          course: edited.course,
          title: edited.suggestedTitle,
          markdown: renderNote(edited, config.vault.attachmentsPath),
          images: edited.pages.map((p) => ({ filename: p.imageFilename, bytes: p.vaultImage })),
        },
      );

      // Only once the note is safely on disk and committed do we release the
      // blobs. A crash before this point redelivers rather than losing pages.
      await clientFor(config, keys).post('/blobs/ack', { blobIds: draft.blobIds });
      drafts = drafts.filter((d) => d.sessionId !== draft.sessionId);

      // Corrections feed the glossary (PREPARATION section 9).
      if (body.data.glossaryTerms && body.data.glossaryTerms.length > 0) {
        saveConfig(addGlossaryTerms(config, edited.course, body.data.glossaryTerms), options.configPath);
      }

      return reply.send({
        notePath: result.notePath,
        commitSha: result.commitSha,
        acked: draft.blobIds.length,
      });
    } catch (error) {
      if (error instanceof VaultError) {
        return reply.code(409).send({ error: error.code, message: error.message });
      }
      return reply.code(500).send({ error: 'write_failed', message: (error as Error).message });
    }
  });

  // --- push --------------------------------------------------------------
  app.post('/api/push', async (_request, reply) => {
    const config = readConfig();
    try {
      const outcome = await pushVault(config.vault.root, config.vault.remote, config.vault.branch);
      return reply.send({ outcome });
    } catch (error) {
      if (error instanceof VaultError) {
        return reply.code(409).send({ error: error.code, message: error.message });
      }
      return reply.code(500).send({ error: 'push_failed', message: (error as Error).message });
    }
  });

  // --- config ------------------------------------------------------------
  app.get('/api/config', async (_request, reply) => {
    if (!state().configured) return reply.code(409).send({ error: 'not_configured', message: 'run setup first' });
    return reply.send(readConfig());
  });

  app.put('/api/config', async (request, reply) => {
    const parsed = Config.safeParse(request.body);
    if (!parsed.success) {
      return reply.code(400).send({ error: 'bad_request', message: parsed.error.message });
    }
    saveConfig(parsed.data, options.configPath);
    return reply.send({ saved: true });
  });

  app.setErrorHandler((error, _request, reply) => {
    if (error instanceof ConfigError) {
      reply.code(409).send({ error: error.code, message: error.message });
      return;
    }
    reply.code(500).send({ error: 'internal', message: error.message });
  });

  return { app, token };
}

async function reachable(url: string): Promise<boolean> {
  try {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 3000);
    try {
      return (await fetch(url, { signal: controller.signal })).ok;
    } finally {
      clearTimeout(timer);
    }
  } catch {
    return false;
  }
}

// Schemas kept local: these are the UI contract, not the wire protocol, so they
// deliberately do not live in @inkpipe/protocol.
import { z } from 'zod';

const z_SetupRequest = z.object({
  serverUrl: z.string().url(),
  joinToken: z.string().min(8),
  label: z.string().min(1).max(64).default('desktop'),
  vault: z.object({
    root: z.string().min(1),
    notesPath: z.string().min(1),
    attachmentsPath: z.string().min(1).default('Images'),
    autoPush: z.boolean().default(false),
    remote: z.string().min(1).default('origin'),
    branch: z.string().min(1).default('main'),
  }),
  courses: z.array(z.object({
    name: z.string().min(1).max(64),
    glossary: z.array(z.string()).default([]),
  })).optional(),
  defaultCourse: z.string().min(1).optional(),
  model: z.object({
    name: z.string().min(1).default('qwen2.5vl:7b'),
    host: z.string().url().default('http://127.0.0.1:11434'),
    numCtx: z.number().int().min(2048).max(131072).default(4096),
    timeoutMs: z.number().int().min(10_000).max(900_000).default(180_000),
  }).optional(),
  pollSeconds: z.number().int().min(10).max(3600).optional(),
  verbosity: z.enum(['verbatim', 'cleaned', 'expanded']).optional(),
});

const z_ApproveRequest = z.object({
  title: z.string().min(1).max(120),
  course: z.string().min(1).max(64),
  pages: z.array(z.object({
    blobId: z.string().uuid(),
    markdown: z.string(),
  })).optional(),
  /** Terms the user corrected, folded into the course glossary. */
  glossaryTerms: z.array(z.string().min(1).max(64)).optional(),
});
