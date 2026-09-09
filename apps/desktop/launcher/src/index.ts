// The desktop launcher: what a shortcut actually runs.
//
// ADR 0005. Starts the service, waits for it to answer, opens a chromeless
// window on it, and shuts the service down when that window closes. One
// process to start, one window to close, no terminal.
//
//   node apps/desktop/launcher/src/index.ts [--port 0] [--no-window]
//
// Port 0 by default, meaning the operating system picks a free one. A fixed
// port fails on the second launch and, worse, could collide with something else
// already listening, and this service holds the content private key.

import { existsSync, mkdirSync } from 'node:fs';
import { spawn, type ChildProcess } from 'node:child_process';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { homedir } from 'node:os';
import { createService } from '../../service/src/api.ts';
import { findBrowser, windowArgs } from './window.ts';

const HERE = dirname(fileURLToPath(import.meta.url));
const UI_DIST = join(HERE, '../../ui/dist');

const args = process.argv.slice(2);
const portArg = args.includes('--port') ? Number(args[args.indexOf('--port') + 1]) : 0;
const openWindow = !args.includes('--no-window');

/** Beside the config, so uninstalling one place removes everything. */
function profileDir(): string {
  const base = process.platform === 'win32'
    ? process.env.APPDATA ?? join(homedir(), 'AppData', 'Roaming')
    : process.env.XDG_CONFIG_HOME ?? join(homedir(), '.config');
  const dir = join(base, 'inkpipe', 'window-profile');
  mkdirSync(dir, { recursive: true });
  return dir;
}

const { app, token } = createService();

if (existsSync(UI_DIST)) {
  const fastifyStatic = (await import('@fastify/static')).default;
  await app.register(fastifyStatic, { root: UI_DIST, prefix: '/' });
  app.setNotFoundHandler((request, reply) => {
    if (request.url.startsWith('/api/')) {
      reply.code(404).send({ error: 'not_found', message: 'no such endpoint' });
      return;
    }
    reply.sendFile('index.html');
  });
} else {
  console.error('The interface is not built. Run "npm run ui:build" first.');
  process.exit(1);
}

// Loopback only. This process holds the content private key and can write to
// the vault, so it must never be reachable from the network.
await app.listen({ port: portArg, host: '127.0.0.1' });

const address = app.server.address();
const port = typeof address === 'object' && address ? address.port : portArg;
const url = `http://127.0.0.1:${port}/#token=${token}`;

console.log(`inkpipe listening on 127.0.0.1:${port}`);

let window: ChildProcess | null = null;

if (openWindow) {
  const browser = findBrowser(existsSync);
  if (browser) {
    window = spawn(browser.path, windowArgs(url, profileDir()), {
      stdio: 'ignore',
      detached: false,
    });
    console.log(`window opened with ${browser.name}`);

    // The window IS the application. Closing it exits, the way a desktop app
    // behaves, rather than leaving a service running that nothing points at.
    window.on('exit', () => {
      void shutdown(0);
    });
    window.on('error', (error) => {
      console.error(`could not open a window: ${error.message}`);
      console.log(`open this instead: ${url}`);
    });
  } else {
    // Not fatal. Everything works in an ordinary browser, it just does not look
    // like an app, which is exactly the state ADR 0005 set out to improve.
    console.error('No Chromium based browser was found, so there is no window.');
    console.log(`open this instead: ${url}`);
  }
}

async function shutdown(code: number): Promise<void> {
  try {
    await app.close();
  } catch {
    // Already closing. Exiting is still the right outcome.
  }
  process.exit(code);
}

for (const signal of ['SIGINT', 'SIGTERM'] as const) {
  process.on(signal, () => {
    // Kill the window too, otherwise closing the terminal leaves an orphan
    // pointing at a service that is gone.
    if (window && !window.killed) window.kill();
    void shutdown(0);
  });
}
