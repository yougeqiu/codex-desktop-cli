import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  AppServerClient,
  DEFAULT_URL,
  normalizeWinPath,
  parseArgs,
  resolveEndpoint,
  selectProjectForCwd,
} from '../scripts/lib/client.mjs';

test('parseArgs parses positional args, flags, --key=value, and -h', () => {
  const res = parseArgs(['send', '--new', '--cwd=E:\\proj', '--model', 'gpt-6.2-sol', '--wait', '-h']);
  assert.deepEqual(res.positional, ['send']);
  assert.equal(res.options.new, true);
  assert.equal(res.options.cwd, 'E:\\proj');
  assert.equal(res.options.model, 'gpt-6.2-sol');
  assert.equal(res.options.wait, true);
  assert.equal(res.options.help, true);
});

test('resolveEndpoint respects priority: --url > env > state.json > default', () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'codexctl-test-'));
  const statePath = path.join(tmpDir, 'state.json');
  fs.writeFileSync(statePath, '\uFEFF' + JSON.stringify({ websocketUrl: 'ws://127.0.0.1:9001' }), 'utf8');

  assert.equal(resolveEndpoint({ url: 'ws://127.0.0.1:9999' }, { CODEX_APP_SERVER_WS_URL: 'ws://127.0.0.1:8888' }, statePath), 'ws://127.0.0.1:9999');
  assert.equal(resolveEndpoint({}, { CODEX_APP_SERVER_WS_URL: 'ws://127.0.0.1:8888' }, statePath), 'ws://127.0.0.1:8888');
  assert.equal(resolveEndpoint({}, {}, statePath), 'ws://127.0.0.1:9001');
  assert.equal(resolveEndpoint({}, {}, path.join(tmpDir, 'missing.json')), DEFAULT_URL);

  fs.rmSync(tmpDir, { recursive: true, force: true });
});

test('normalizeWinPath strips UNC prefix, trailing slashes, and folds case on win32', () => {
  assert.equal(normalizeWinPath('\\\\?\\E:/Projects/MyApp\\\\', 'win32'), 'e:\\projects\\myapp');
  assert.equal(normalizeWinPath('E:\\Projects\\MyApp\\', 'linux'), 'E:\\Projects\\MyApp');
});

test('selectProjectForCwd matches p.roots[].path preferring exact match and most recent project', () => {
  const projects = [
    { id: 'old-root', name: 'ws-old', roots: [{ path: 'D:\\work' }], createdAt: 100, recencyAt: null },
    { id: 'new-root', name: 'ws-new', roots: [{ path: 'D:\\work' }], createdAt: 200, recencyAt: 500 },
    { id: 'sub-proj', name: 'sub', roots: [{ path: 'D:\\work\\app' }], createdAt: 150, recencyAt: 300 },
  ];

  const exact = selectProjectForCwd(projects, 'd:\\work\\', 'win32');
  assert.equal(exact.status, 'matched');
  assert.equal(exact.projectId, 'new-root');
  assert.equal(exact.matchType, 'exact');

  const subExact = selectProjectForCwd(projects, 'D:\\work\\app', 'win32');
  assert.equal(subExact.projectId, 'sub-proj');
  assert.equal(subExact.matchType, 'exact');

  const ancestor = selectProjectForCwd(projects, 'D:\\work\\app\\packages\\cli', 'win32');
  assert.equal(ancestor.projectId, 'sub-proj');
  assert.equal(ancestor.matchType, 'ancestor');

  const unmatched = selectProjectForCwd(projects, 'E:\\other', 'win32');
  assert.equal(unmatched.status, 'unmatched');
});

test('AppServerClient completes initialize handshake, RPC call, and notification waiter', async () => {
  const sent = [];
  class MockWebSocket extends EventTarget {
    constructor(url) {
      super();
      this.url = url;
      queueMicrotask(() => this.dispatchEvent(new Event('open')));
    }
    send(raw) {
      const msg = JSON.parse(raw);
      sent.push(msg);
      if (msg.method === 'initialize') {
        queueMicrotask(() => this.dispatchEvent(new MessageEvent('message', {
          data: JSON.stringify({ jsonrpc: '2.0', id: msg.id, result: { userAgent: 'Mock/1.0' } }),
        })));
      } else if (msg.method === 'ping') {
        queueMicrotask(() => {
          this.dispatchEvent(new MessageEvent('message', {
            data: JSON.stringify({ jsonrpc: '2.0', id: msg.id, result: { ok: true } }),
          }));
          this.dispatchEvent(new MessageEvent('message', {
            data: JSON.stringify({ jsonrpc: '2.0', method: 'turn/completed', params: { threadId: 't-1' } }),
          }));
        });
      }
    }
    close() {}
  }

  const client = new AppServerClient('ws://127.0.0.1:8798', { WebSocketImpl: MockWebSocket });
  const init = await client.connect(2000);
  assert.equal(init.userAgent, 'Mock/1.0');

  const waitDone = client.waitNotification((m) => m.method === 'turn/completed' && m.params?.threadId === 't-1', 2000);
  const res = await client.call('ping', {});
  const note = await waitDone;
  assert.deepEqual(res, { ok: true });
  assert.equal(note.params.threadId, 't-1');
  assert.equal(sent.some((m) => m.method === 'initialized'), true);
});
