// Entry point for the queue server.
//
// Configuration is environment only, because this runs on a VPS under a process
// manager and a config file would be one more thing to keep in sync.
//
//   INKPIPE_PORT       default 3040 (docs/VPS_SETUP.md explains why 3040)
//   INKPIPE_HOST       default 127.0.0.1, since nginx terminates TLS in front
//   INKPIPE_DATA_DIR   default /var/lib/inkpipe
//   INKPIPE_JOIN_TOKEN required, no default: a guessable default would let
//                      anyone register a desktop against your server

import { createServer } from './server.ts';

const port = Number(process.env.INKPIPE_PORT ?? 3040);
const host = process.env.INKPIPE_HOST ?? '127.0.0.1';
const dataDir = process.env.INKPIPE_DATA_DIR ?? '/var/lib/inkpipe';
const joinToken = process.env.INKPIPE_JOIN_TOKEN;

if (!joinToken || joinToken.length < 16) {
  console.error('INKPIPE_JOIN_TOKEN must be set and at least 16 characters.');
  console.error('Generate one with:  openssl rand -base64 24');
  process.exit(2);
}

const app = createServer({ dataDir, joinToken });

await app.listen({ port, host });
console.log(`inkpipe server listening on ${host}:${port}, data in ${dataDir}`);

for (const signal of ['SIGINT', 'SIGTERM'] as const) {
  process.on(signal, () => {
    void app.close().then(() => process.exit(0));
  });
}
