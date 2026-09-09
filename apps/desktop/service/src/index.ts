// Entry point for the desktop sidecar.
//
// Serves the built UI and the local API from one loopback port, prints the URL
// with the session token in the fragment, and opens a browser unless told not
// to. The Tauri shell will spawn this and point its webview at the same URL.
//
//   node apps/desktop/service/src/index.ts [--port 5272] [--no-open]

import { existsSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawn } from 'node:child_process';
import { createService } from './api.ts';

const HERE = dirname(fileURLToPath(import.meta.url));
const UI_DIST = join(HERE, '../../ui/dist');

const args = process.argv.slice(2);
const port = args.includes('--port') ? Number(args[args.indexOf('--port') + 1]) : 5272;
const shouldOpen = !args.includes('--no-open');

const { app, token } = createService();

// Serve the built UI, when it has been built. In development the Vite dev
// server proxies here instead, so a missing dist is not an error.
if (existsSync(UI_DIST)) {
  const fastifyStatic = (await import('@fastify/static')).default;
  await app.register(fastifyStatic, { root: UI_DIST, prefix: '/' });

  // Any non-API route falls through to the app shell.
  app.setNotFoundHandler((request, reply) => {
    if (request.url.startsWith('/api/')) {
      reply.code(404).send({ error: 'not_found', message: 'no such endpoint' });
      return;
    }
    reply.sendFile('index.html');
  });
}

// Loopback only. This process holds the content private key and can write to
// the vault, so it must never be reachable from the network.
await app.listen({ port, host: '127.0.0.1' });

const url = `http://127.0.0.1:${port}/#token=${token}`;
console.log(`inkpipe desktop service listening on 127.0.0.1:${port}`);
console.log(`open: ${url}`);
if (!existsSync(UI_DIST)) {
  console.log('note: the UI is not built. Run "npm run ui:build", or use the Vite dev server.');
}

if (shouldOpen && existsSync(UI_DIST)) {
  openBrowser(url);
}

function openBrowser(target: string): void {
  const [command, commandArgs] =
    process.platform === 'win32' ? ['cmd', ['/c', 'start', '', target]]
    : process.platform === 'darwin' ? ['open', [target]]
    : ['xdg-open', [target]];
  try {
    spawn(command, commandArgs, { detached: true, stdio: 'ignore' }).unref();
  } catch {
    // Not being able to open a browser is not a reason to fail to start.
  }
}

for (const signal of ['SIGINT', 'SIGTERM'] as const) {
  process.on(signal, () => {
    void app.close().then(() => process.exit(0));
  });
}
