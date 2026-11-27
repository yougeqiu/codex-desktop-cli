import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import process from 'node:process';

export const STATE_FILE = path.join(os.homedir(), '.codex-desktop', 'state.json');
export const DEFAULT_URL = 'ws://127.0.0.1:8798';

export function parseArgs(argv) {
  const positional = [];
  const options = {};
  for (let i = 0; i < argv.length; i++) {
    const v = argv[i];
    if (!v.startsWith('--')) {
      if (v === '-h') options.help = true;
      else positional.push(v);
      continue;
    }
    const eq = v.indexOf('=');
    if (eq > 2) {
      options[v.slice(2, eq)] = v.slice(eq + 1);
      continue;
    }
    const name = v.slice(2);
    const next = argv[i + 1];
    if (next !== undefined && !next.startsWith('--') && next !== '-h') {
      options[name] = next;
      i++;
    } else {
      options[name] = true;
    }
  }
  return { positional, options };
}

export function resolveEndpoint(options = {}, env = process.env, stateFile = STATE_FILE) {
  if (options.url) return String(options.url);
  if (env.CODEX_APP_SERVER_WS_URL) return env.CODEX_APP_SERVER_WS_URL;
  try {
    const raw = fs.readFileSync(stateFile, 'utf8').replace(/^\uFEFF/, '');
    const state = JSON.parse(raw);
    if (state.websocketUrl) return state.websocketUrl;
  } catch {}
  return DEFAULT_URL;
}

export function normalizeWinPath(p, platform = process.platform) {
  if (!p) return '';
  let s = String(p).trim().replace(/^\\\\\?\\/, '').replace(/\//g, '\\').replace(/\\+$/, '');
  if (platform === 'win32') s = s.toLowerCase();
  return s;
}

export function selectProjectForCwd(rawProjects, cwd, platform = process.platform) {
  const projects = [...(rawProjects ?? [])].sort((a, b) =>
    ((b?.recencyAt ?? b?.updatedAt ?? b?.createdAt ?? 0) - (a?.recencyAt ?? a?.updatedAt ?? a?.createdAt ?? 0))
  );
  const target = normalizeWinPath(cwd, platform);
  if (!target) return { status: 'unmatched', projectCount: projects.length };

  let best = null;
  let bestLen = -1;
  let bestType = null;
  for (const p of projects) {
    if (!p?.id) continue;
    const rawRoots = [
      ...(Array.isArray(p.roots) ? p.roots.map(r => (typeof r === 'string' ? r : r?.path)) : []),
      p.rootPath,
      ...(Array.isArray(p.rootPaths) ? p.rootPaths : []),
      p.path,
      p.cwd,
    ].filter(Boolean);
    for (const r of rawRoots) {
      const nr = normalizeWinPath(r, platform);
      if (!nr) continue;
      if (nr === target) {
        best = p;
        bestLen = nr.length;
        bestType = 'exact';
        break;
      }
      if (target.startsWith(nr + '\\') && nr.length > bestLen) {
        best = p;
        bestLen = nr.length;
        bestType = 'ancestor';
      }
    }
    if (bestType === 'exact') break;
  }
  if (!best) return { status: 'unmatched', projectCount: projects.length };
  return { status: 'matched', projectId: best.id, projectName: best.name ?? '', matchType: bestType };
}

export class AppServerClient {
  constructor(url, { clientInfo = { name: 'codexctl', version: '1.0' }, onRequest = null, onNotification = null, WebSocketImpl = globalThis.WebSocket } = {}) {
    this.url = url;
    this.clientInfo = clientInfo;
    this.onRequest = onRequest;
    this.onNotification = onNotification;
    this.WebSocketImpl = WebSocketImpl;
    this.nextId = 1;
    this.pending = new Map();
    this.waiters = new Set();
    this.notifications = [];
    this.socket = null;
  }

  async connect(timeoutMs = 10000) {
    await new Promise((resolve, reject) => {
      const ws = new this.WebSocketImpl(this.url);
      this.socket = ws;
      const timer = setTimeout(() => reject(new Error(`WebSocket open timed out: ${this.url}`)), timeoutMs);
      ws.addEventListener('message', (ev) => this.#onMessage(String(ev.data)));
      ws.addEventListener('open', () => { clearTimeout(timer); resolve(); }, { once: true });
      ws.addEventListener('error', () => { clearTimeout(timer); reject(new Error(`connect failed: ${this.url}`)); }, { once: true });
    });
    const init = await this.call('initialize', {
      clientInfo: this.clientInfo,
      capabilities: { experimentalApi: true },
    });
    this.socket.send(JSON.stringify({ jsonrpc: '2.0', method: 'initialized' }));
    return init;
  }

  call(method, params = {}, timeoutMs = 30000) {
    return new Promise((resolve, reject) => {
      const id = this.nextId++;
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`${method} timeout`));
      }, timeoutMs);
      this.pending.set(id, { resolve, reject, timer });
      this.socket.send(JSON.stringify({ jsonrpc: '2.0', id, method, params }));
    });
  }

  respond(id, result) {
    this.socket.send(JSON.stringify({ jsonrpc: '2.0', id, result }));
  }

  waitNotification(predicate, timeoutMs) {
    return new Promise((resolve, reject) => {
      const w = { predicate, resolve };
      const timer = setTimeout(() => {
        this.waiters.delete(w);
        reject(new Error('notification wait timeout'));
      }, timeoutMs);
      w.timer = timer;
      this.waiters.add(w);
    });
  }

  close() {
    try { this.socket?.close(); } catch {}
  }

  #onMessage(raw) {
    let m;
    try { m = JSON.parse(raw); } catch { return; }
    if (m.id !== undefined && !m.method && this.pending.has(m.id)) {
      const p = this.pending.get(m.id);
      this.pending.delete(m.id);
      clearTimeout(p.timer);
      m.error ? p.reject(new Error(JSON.stringify(m.error))) : p.resolve(m.result);
      return;
    }
    if (m.id !== undefined && m.method) {
      if (this.onRequest) this.onRequest(m, this);
      return;
    }
    if (!m.method) return;
    this.notifications.push(m);
    if (this.onNotification) this.onNotification(m);
    for (const w of [...this.waiters]) {
      if (w.predicate(m)) {
        this.waiters.delete(w);
        clearTimeout(w.timer);
        w.resolve(m);
      }
    }
  }
}
