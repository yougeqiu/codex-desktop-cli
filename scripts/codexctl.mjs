#!/usr/bin/env node
import fs from 'node:fs';
import path from 'node:path';
import process from 'node:process';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { AppServerClient, parseArgs, resolveEndpoint, selectProjectForCwd } from './lib/client.mjs';

const SCRIPTS_DIR = path.dirname(fileURLToPath(import.meta.url));

const USAGE = `codexctl — control Codex Desktop via its shared app-server (JSON-RPC over loopback WebSocket).

Usage:
  codexctl <command> [options]

Commands:
  status                                  Probe server, account, and Desktop UI attachment
  list [--limit N] [--search S]           List recent threads
  models [--hidden]                       List available models and reasoning efforts
  send --text T|--file F [--thread ID | --new [--cwd DIR]]
       [--model M] [--effort E] [--tier T] [--name N]
       [--approval A] [--attach|--no-attach] [--wait] [--timeout S]
                                          Start or continue a thread (auto-attaches detached Desktop)
  steer --thread ID (--text T|--file F) [--turn ID]
                                          Inject input into an active turn
  interrupt --thread ID                   Interrupt active turn on a thread
  read --thread ID [--all]                Read transcript (--all prints full untruncated messages)
  name --thread ID --name N               Rename a thread

Global options:
  --url ws://127.0.0.1:8798               Override WebSocket endpoint
  -h, --help                              Show this help message`;

function userInput(text) {
  return [{ type: 'text', text }];
}

function turnItemsText(turn) {
  return (turn?.items ?? []).filter(i => i.type === 'agentMessage').map(i => i.text);
}

function findDesktopAttachment(wsUrl) {
  if (process.platform !== 'win32') return null;
  let port = '8798';
  try { port = new URL(wsUrl).port || '8798'; } catch {}
  try {
    const taskOut = execFileSync('tasklist', ['/FI', 'IMAGENAME eq ChatGPT.exe', '/FO', 'CSV', '/NH'], { encoding: 'utf8', windowsHide: true });
    const chatGptPids = new Set();
    for (const line of taskOut.split(/\r?\n/)) {
      const m = line.match(/^"ChatGPT\.exe","(\d+)"/i);
      if (m) chatGptPids.add(m[1]);
    }
    if (chatGptPids.size === 0) return { running: false, chatGptCount: 0, attachedPids: [], port };
    const netOut = execFileSync('netstat', ['-ano', '-p', 'tcp'], { encoding: 'utf8', windowsHide: true });
    const attached = new Set();
    for (const line of netOut.split(/\r?\n/)) {
      const parts = line.trim().split(/\s+/);
      if (parts.length < 5 || parts[0] !== 'TCP') continue;
      const [, , remote, state, pid] = parts;
      if (state === 'ESTABLISHED' && remote === `127.0.0.1:${port}` && chatGptPids.has(pid)) {
        attached.add(pid);
      }
    }
    return { running: true, chatGptCount: chatGptPids.size, attachedPids: [...attached], port };
  } catch {
    return null;
  }
}

function isLoopbackPort(wsUrl) {
  try {
    const u = new URL(wsUrl);
    if (u.hostname === '127.0.0.1' || u.hostname === 'localhost') return u.port || '8798';
  } catch {}
  return null;
}

async function isReadyzOk(port) {
  try {
    const res = await fetch(`http://127.0.0.1:${port}/readyz`, { signal: AbortSignal.timeout(2000) });
    return res.ok;
  } catch {
    return false;
  }
}

function runPsScript(scriptName, args) {
  execFileSync(
    'powershell',
    ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', path.join(SCRIPTS_DIR, scriptName), ...args],
    { stdio: 'inherit' },
  );
}

async function ensureReadyIfNeeded(command, options, wsUrl) {
  if (process.platform !== 'win32' || options['no-attach'] === true) return;
  if (command !== 'send' && options.attach !== true) return;
  const port = isLoopbackPort(wsUrl);
  if (!port) return;
  const serverOk = await isReadyzOk(port);
  const ui = findDesktopAttachment(wsUrl);
  const detachedUi = Boolean(ui && ui.running && ui.attachedPids.length === 0);
  if (options.attach === true || detachedUi) {
    console.log(`[codexctl] ensuring Desktop is attached to ws://127.0.0.1:${port}...`);
    runPsScript('restart-desktop.ps1', ['-Port', String(port)]);
  } else if (!serverOk) {
    console.log(`[codexctl] starting shared app-server on port ${port}...`);
    runPsScript('start-server.ps1', ['-Port', String(port)]);
  }
}

async function main() {
  const { positional, options } = parseArgs(process.argv.slice(2));
  const command = positional[0];
  if (options.help === true || command === 'help') {
    console.log(USAGE);
    process.exit(0);
  }
  if (!command) {
    console.log(USAGE);
    process.exit(1);
  }

  const url = resolveEndpoint(options);
  await ensureReadyIfNeeded(command, options, url);

  const client = new AppServerClient(url, { clientInfo: { name: 'codexctl', version: '1.0' } });
  const init = await client.connect();

  switch (command) {
    case 'status': {
      console.log('endpoint:', url);
      console.log('server:', init.userAgent ?? JSON.stringify(init));
      console.log('codexHome:', init.codexHome);
      try {
        const acc = await client.call('account/read', {});
        console.log('account:', JSON.stringify(acc).slice(0, 300));
      } catch {}
      const list = await client.call('thread/list', { limit: 5, sortKey: 'recency_at', sortDirection: 'desc' });
      console.log('recent threads:', (list.data ?? []).length, '(top 5)');
      const ui = findDesktopAttachment(url);
      if (ui) {
        if (!ui.running) console.log('desktopUi: not running');
        else if (ui.attachedPids.length > 0) console.log(`desktopUi: attached to 127.0.0.1:${ui.port} (pids: ${ui.attachedPids.join(',')})`);
        else console.log(`desktopUi: DETACHED (${ui.chatGptCount} ChatGPT process(es) running in private mode, not connected to 127.0.0.1:${ui.port} — run restart-desktop.ps1)`);
      }
      break;
    }
    case 'list': {
      const limit = Number(options.limit ?? 20);
      const params = { limit, sortKey: 'recency_at', sortDirection: 'desc' };
      if (options.search) params.searchTerm = String(options.search);
      const r = await client.call('thread/list', params);
      for (const t of (r.data ?? [])) {
        console.log(`${t.id}  ${(t.preview ?? t.title ?? '').slice(0, 70)}  ${JSON.stringify(t.status?.type ?? t.status ?? '')}`);
      }
      break;
    }
    case 'models': {
      const r = await client.call('model/list', { includeHidden: options.hidden === true, limit: 100 });
      for (const m of (r.data ?? [])) {
        const efforts = (m.supportedReasoningEfforts ?? []).map(e => e.reasoningEffort).join('/');
        console.log(`${m.model}  "${m.displayName}"  defaultEffort=${m.defaultReasoningEffort}  efforts=[${efforts}]${m.isDefault ? '  *DEFAULT*' : ''}${m.hidden ? '  (hidden)' : ''}`);
      }
      break;
    }
    case 'send': {
      const text = options.text ?? (options.file ? fs.readFileSync(String(options.file), 'utf8') : null);
      if (!text) throw new Error('--text or --file required');
      let threadId = options.thread ? String(options.thread) : null;
      const resolvedCwd = path.resolve(String(options.cwd ?? process.cwd()));
      if (!threadId) {
        const projRes = await client.call('project/list', {}).catch(() => null);
        const proj = projRes
          ? selectProjectForCwd(projRes.data ?? projRes.projects ?? projRes.items ?? [], resolvedCwd)
          : { status: 'unavailable' };
        const startParams = { cwd: resolvedCwd };
        if (proj.status === 'matched') startParams.projectId = proj.projectId;
        const t = await client.call('thread/start', startParams).catch(() => client.call('thread/start', { cwd: resolvedCwd }));
        threadId = t.thread?.id;
        if (!threadId) throw new Error('thread/start returned no id');
        console.log('new thread:', threadId);
        if (proj.status === 'matched') {
          if (t.thread?.projectId === proj.projectId) {
            console.log(`project linked: ${proj.projectId} (${proj.projectName}, ${proj.matchType})`);
          } else {
            const ok = await client.call('thread/metadata/update', { threadId, projectId: proj.projectId }).then(() => true).catch(() => false);
            if (ok) console.log(`project linked: ${proj.projectId} (${proj.projectName}, ${proj.matchType})`);
          }
        } else if (proj.status === 'unmatched') {
          console.log(`WARN: cwd "${resolvedCwd}" matches no project in Desktop project/list; sidebar may hide it under an unlisted project until opened in Desktop.`);
        }
        const ui = findDesktopAttachment(url);
        if (ui && ui.running && ui.attachedPids.length === 0) {
          console.log(`WARN: Desktop UI is running detached from 127.0.0.1:${ui.port}; CLI threads will not show live until you run restart-desktop.ps1.`);
        }
      } else {
        await client.call('thread/resume', { threadId, excludeTurns: true }).catch(() => {});
      }
      if (options.name) {
        await client.call('thread/name/set', { threadId, name: String(options.name) }).catch(() => {});
      }
      const settings = {
        approvalPolicy: options.approval ? String(options.approval) : 'never',
        sandboxPolicy: { type: 'dangerFullAccess' },
      };
      if (options.model) settings.model = String(options.model);
      if (options.effort) settings.reasoningEffort = String(options.effort);
      if (options.tier) settings.serviceTier = String(options.tier);
      await client.call('thread/settings/update', { threadId, ...settings });
      console.log('settings:', JSON.stringify(settings));
      const donePromise = (options.wait === true)
        ? client.waitNotification(
            (m) => m.method === 'turn/completed' && (m.params?.threadId === threadId || m.params?.turn?.threadId === threadId),
            Number(options.timeout ?? 600) * 1000)
        : null;
      const turn = await client.call('turn/start', { threadId, input: userInput(String(text)) });
      const turnId = turn?.turn?.id ?? turn?.id;
      console.log('turn started:', turnId, 'thread:', threadId);
      if (donePromise) {
        const done = await donePromise;
        const t = done.params?.turn;
        console.log('turn completed:', t?.status, `durationMs=${t?.durationMs}`);
        for (const txt of turnItemsText(t)) console.log('--- agent ---\n' + txt);
      }
      break;
    }
    case 'steer': {
      const threadId = options.thread ? String(options.thread) : null;
      const text = options.text ?? (options.file ? fs.readFileSync(String(options.file), 'utf8').trim() : null);
      if (!threadId || !text) throw new Error('--thread and (--text or --file) required');
      let expectedTurnId = options.turn ? String(options.turn) : null;
      if (!expectedTurnId) {
        const turns = await client.call('thread/turns/list', { threadId, limit: 5, sortDirection: 'desc', itemsView: 'notLoaded' });
        const active = (turns.data ?? []).find(t => t.status === 'inProgress' || t.status === 'running');
        if (!active) throw new Error('no active turn to steer (use send when idle)');
        expectedTurnId = active.id;
      }
      const r = await client.call('turn/steer', { threadId, expectedTurnId, input: userInput(String(text)) });
      console.log('steered:', JSON.stringify(r).slice(0, 200));
      break;
    }
    case 'interrupt': {
      const threadId = options.thread ? String(options.thread) : null;
      if (!threadId) throw new Error('--thread required');
      const turns = await client.call('thread/turns/list', { threadId, limit: 1 });
      const active = (turns.data ?? []).find(t => t.status === 'inProgress' || t.status === 'running');
      if (!active) { console.log('no active turn'); break; }
      const r = await client.call('turn/interrupt', { threadId, turnId: active.id });
      console.log('interrupted turn', active.id, JSON.stringify(r).slice(0, 200));
      break;
    }
    case 'read': {
      const threadId = options.thread ? String(options.thread) : positional[1];
      if (!threadId) throw new Error('--thread required');
      await client.call('thread/resume', { threadId, excludeTurns: true }).catch(() => {});
      const read = await client.call('thread/read', { threadId, includeTurns: true });
      const turns = read?.thread?.turns ?? read?.turns ?? [];
      const limit = options.all === true ? Infinity : 2000;
      console.log(`thread ${threadId} — ${turns.length} turn(s)`);
      for (const t of turns) {
        console.log(`== turn ${t.id} [${t.status}] ==`);
        for (const item of (t.items ?? [])) {
          if (item.type === 'userMessage' || item.type === 'agentMessage') {
            const raw = String(item.text ?? (item.input ? JSON.stringify(item.input) : ''));
            console.log(`[${item.type}]`, limit === Infinity ? raw : raw.slice(0, limit));
          }
        }
      }
      break;
    }
    case 'name': {
      const threadId = options.thread ? String(options.thread) : null;
      if (!threadId || !options.name) throw new Error('--thread and --name required');
      await client.call('thread/name/set', { threadId, name: String(options.name) });
      console.log('renamed:', threadId);
      break;
    }
    default:
      console.error('unknown command:', command);
      console.log(USAGE);
      process.exit(1);
  }

  client.close();
  process.exit(0);
}

main().catch((e) => {
  console.error('ERROR:', e.message);
  process.exit(1);
});
