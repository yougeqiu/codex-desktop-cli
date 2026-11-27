#!/usr/bin/env node
// File-input wrapper for steering an active turn: node codex-steer.mjs <threadId> <expectedTurnId> <textFile>
import fs from 'node:fs';
import process from 'node:process';
import { AppServerClient, parseArgs, resolveEndpoint } from './lib/client.mjs';

const { positional, options } = parseArgs(process.argv.slice(2));
const [threadId, turnId, textFile] = positional;
if (options.help === true || !threadId || !turnId || !textFile) {
  console.log('usage: node codex-steer.mjs <threadId> <expectedTurnId> <textFile> [--url ws://...]');
  process.exit(options.help === true ? 0 : 1);
}

const text = fs.readFileSync(textFile, 'utf8').trim();
const url = resolveEndpoint(options);
const client = new AppServerClient(url, { clientInfo: { name: 'codex-steer', version: '1.0' } });

try {
  await client.connect(10000);
  const r = await client.call('turn/steer', { threadId, expectedTurnId: turnId, input: [{ type: 'text', text }] });
  console.log('steered:', JSON.stringify(r).slice(0, 300));
  client.close();
  process.exit(0);
} catch (err) {
  console.error('ERR:', err.message);
  client.close();
  process.exit(1);
}
