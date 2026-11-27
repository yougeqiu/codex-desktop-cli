#!/usr/bin/env node
// Generic JSON-RPC call: node codex-call.mjs <method> [paramsJson] [--url ws://...]
import process from 'node:process';
import { AppServerClient, parseArgs, resolveEndpoint } from './lib/client.mjs';

const { positional, options } = parseArgs(process.argv.slice(2));
if (options.help === true || !positional[0]) {
  console.log('usage: node codex-call.mjs <method> [paramsJson] [--url ws://...]');
  process.exit(positional[0] ? 0 : 1);
}

const method = positional[0];
const params = positional[1] ? JSON.parse(positional[1]) : {};
const url = resolveEndpoint(options);

const client = new AppServerClient(url, { clientInfo: { name: 'codex-call', version: '1.0' } });
try {
  await client.connect(10000);
  const res = await client.call(method, params, Number(options.timeout ?? 30) * 1000);
  console.log(JSON.stringify(res));
  client.close();
  process.exit(0);
} catch (err) {
  console.error('ERR:', err.message);
  client.close();
  process.exit(1);
}
