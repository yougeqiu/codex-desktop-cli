#!/usr/bin/env node
// Auto-approve daemon: answers app-server server->client approval requests while running.
import process from 'node:process';
import { AppServerClient, parseArgs, resolveEndpoint } from './lib/client.mjs';

const { options } = parseArgs(process.argv.slice(2));
if (options.help === true) {
  console.log('usage: node codex-autoapprove.mjs [--url ws://...]');
  process.exit(0);
}

const url = resolveEndpoint(options);
const client = new AppServerClient(url, {
  clientInfo: { name: 'codex-autoapprove', version: '1.0' },
  onRequest(m, c) {
    console.log(new Date().toISOString(), 'REQUEST', m.method, JSON.stringify(m.params).slice(0, 500));
    const shape = /fileChange|applyPatch/i.test(m.method)
      ? { decision: 'accept' }
      : { decision: 'acceptForSession' };
    c.respond(m.id, shape);
    console.log('  -> replied', JSON.stringify(shape));
  },
  onNotification(m) {
    if (/approv|completed/i.test(m.method)) {
      console.log(new Date().toISOString(), 'NOTE', m.method, JSON.stringify(m.params).slice(0, 300));
    }
  },
});

try {
  await client.connect(10000);
  console.log('listening for approval requests on', url);
  client.socket.addEventListener('close', () => {
    console.log('closed, exiting');
    process.exit(0);
  });
} catch (err) {
  console.error('init failed:', err.message);
  process.exit(1);
}
