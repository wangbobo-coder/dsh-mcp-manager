/**
 * Liveness probe: is a configured server actually reachable?
 *
 * Scanning config files tells you what is configured, not what works. A dead
 * entry is indistinguishable from a live one on disk, and that is the single
 * most common source of "my MCP tools vanished" reports. So each server gets a
 * real handshake:
 *
 *   - stdio   spawn the command, write `initialize`, read the reply, then
 *             `tools/list`, then shut it down. This is the only way to learn
 *             whether the command exists, whether the package resolves, and
 *             whether the entry's env is complete.
 *   - remote  POST `initialize` to the URL and accept either a JSON body or an
 *             event stream, then `tools/list` over the negotiated session.
 *
 * Everything is time-boxed and every failure is reported as data (code plus
 * detail) rather than thrown, because a probe failing is normal, not an error.
 */

import { spawn } from 'node:child_process';

const PROTOCOL_VERSION = '2025-06-18';
/*
 * Sent to every server we handshake with, so a server's logs attribute the
 * connection to this plugin and a version we still recognise. `test-release.mjs`
 * asserts it matches package.json — a stale value here is otherwise invisible.
 */
const CLIENT_INFO = { name: 'dsh-mcp-manager', version: '0.1.2' };

function rpcRequest(id, method, params) {
  return JSON.stringify({ jsonrpc: '2.0', id, method, params });
}

function parseJsonRpcLine(line) {
  const text = line.trim();
  if (!text) return null;
  if (text.startsWith('{')) {
    try { return JSON.parse(text); } catch { return null; }
  }
  if (text.startsWith('data:')) {
    const body = text.slice(5).trim();
    if (!body) return null;
    try { return JSON.parse(body); } catch { return null; }
  }
  return null;
}

/* ------------------------------------------------------------------ stdio -- */

function probeStdio(server, timeoutMs) {
  return new Promise((resolve) => {
    if (!server.command) {
      resolve({ status: 'error', code: 'error.probe.noCommand', detail: 'stdio server has no command' });
      return;
    }
    const started = Date.now();
    let settled = false;
    let buffer = '';
    let tools = [];
    let serverInfo = null;
    let stderrTail = '';
    let nextId = 1;
    let child;
    try {
      child = spawn(server.command, server.args ?? [], {
        cwd: server.cwd || undefined,
        env: { ...process.env, ...(server.env ?? {}) },
        shell: process.platform === 'win32',
        stdio: ['pipe', 'pipe', 'pipe'],
        windowsHide: true,
      });
    } catch (error) {
      resolve({ status: 'error', code: 'error.probe.spawn', detail: String(error && error.message ? error.message : error) });
      return;
    }

    const finish = (result) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      try { child.kill('SIGKILL'); } catch { /* already gone */ }
      resolve({ ...result, elapsedMs: Date.now() - started, serverInfo, toolCount: tools.length, tools: tools.slice(0, 50), stderrTail: stderrTail.slice(-800) });
    };

    const timer = setTimeout(() => {
      finish({ status: 'error', code: 'error.probe.timeout', detail: `no complete handshake within ${timeoutMs}ms` });
    }, timeoutMs);

    child.on('error', (error) => {
      finish({ status: 'error', code: 'error.probe.spawn', detail: String(error && error.message ? error.message : error) });
    });
    child.on('exit', (code, signal) => {
      if (!settled) {
        finish({
          status: 'error',
          code: code === 0 ? 'error.probe.exited' : 'error.probe.exitCode',
          detail: `process exited (code ${code ?? 'null'}, signal ${signal ?? 'none'}) before the handshake finished`,
        });
      }
    });
    child.stderr?.on('data', (chunk) => {
      stderrTail = (stderrTail + chunk.toString('utf8')).slice(-4000);
    });

    const send = (id, method, params) => {
      try {
        child.stdin.write(`${rpcRequest(id, method, params)}\n`);
      } catch (error) {
        finish({ status: 'error', code: 'error.probe.write', detail: String(error && error.message ? error.message : error) });
      }
    };

    let stage = 'initialize';
    child.stdout?.on('data', (chunk) => {
      buffer += chunk.toString('utf8');
      let newline = buffer.indexOf('\n');
      while (newline >= 0) {
        const line = buffer.slice(0, newline);
        buffer = buffer.slice(newline + 1);
        newline = buffer.indexOf('\n');
        const message = parseJsonRpcLine(line);
        if (!message) continue;
        if (message.id === 1 && stage === 'initialize') {
          if (message.error) {
            finish({ status: 'error', code: 'error.probe.protocol', detail: String(message.error.message ?? 'initialize rejected') });
            return;
          }
          serverInfo = message.result?.serverInfo ?? null;
          stage = 'tools';
          send(nextId += 1, 'notifications/initialized', undefined);
          send(nextId += 1, 'tools/list', {});
          continue;
        }
        if (message.id === 3 && stage === 'tools') {
          if (message.error) {
            finish({ status: 'error', code: 'error.probe.protocol', detail: String(message.error.message ?? 'tools/list rejected') });
            return;
          }
          tools = Array.isArray(message.result?.tools) ? message.result.tools : [];
          finish({ status: 'ok', code: 'probe.ok' });
          return;
        }
      }
    });

    send(1, 'initialize', {
      protocolVersion: PROTOCOL_VERSION,
      capabilities: {},
      clientInfo: CLIENT_INFO,
    });
  });
}

/* ----------------------------------------------------------------- remote -- */

async function probeRemote(server, timeoutMs) {
  if (!server.url) return { status: 'error', code: 'error.probe.noUrl', detail: 'remote server has no URL' };
  const started = Date.now();
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  const headers = { 'content-type': 'application/json', accept: 'application/json, text/event-stream', ...(server.headers ?? {}) };
  try {
    const initResponse = await fetch(server.url, {
      method: 'POST',
      headers,
      signal: controller.signal,
      body: JSON.stringify({
        jsonrpc: '2.0', id: 1, method: 'initialize',
        params: { protocolVersion: PROTOCOL_VERSION, capabilities: {}, clientInfo: CLIENT_INFO },
      }),
    });
    if (!initResponse.ok) {
      return { status: 'error', code: `error.probe.http${initResponse.status}`, detail: `${initResponse.status} ${initResponse.statusText}`.trim(), elapsedMs: Date.now() - started };
    }
    const sessionId = initResponse.headers.get('mcp-session-id') ?? undefined;
    const initBody = await readRpcBody(initResponse);
    if (initBody?.error) {
      return { status: 'error', code: 'error.probe.protocol', detail: String(initBody.error.message ?? 'initialize rejected'), elapsedMs: Date.now() - started };
    }
    const serverInfo = initBody?.result?.serverInfo ?? null;

    const nextHeaders = { ...headers };
    if (sessionId) nextHeaders['mcp-session-id'] = sessionId;
    // `notifications/initialized` is fire-and-forget; a failure here is not fatal.
    fetch(server.url, {
      method: 'POST', headers: nextHeaders, signal: controller.signal,
      body: JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized' }),
    }).catch(() => undefined);

    const listResponse = await fetch(server.url, {
      method: 'POST', headers: nextHeaders, signal: controller.signal,
      body: JSON.stringify({ jsonrpc: '2.0', id: 2, method: 'tools/list', params: {} }),
    });
    const listBody = await readRpcBody(listResponse);
    const tools = Array.isArray(listBody?.result?.tools) ? listBody.result.tools : [];
    if (!listResponse.ok) {
      return { status: 'error', code: `error.probe.http${listResponse.status}`, detail: `${listResponse.status} ${listResponse.statusText}`.trim(), elapsedMs: Date.now() - started, serverInfo };
    }
    return { status: 'ok', code: 'probe.ok', elapsedMs: Date.now() - started, serverInfo, toolCount: tools.length, tools: tools.slice(0, 50), sessionId };
  } catch (error) {
    const aborted = error && (error.name === 'AbortError' || error.code === 'ABORT_ERR');
    return {
      status: 'error',
      code: aborted ? 'error.probe.timeout' : 'error.probe.network',
      detail: aborted ? `no answer within ${timeoutMs}ms` : String(error && error.message ? error.message : error),
      elapsedMs: Date.now() - started,
    };
  } finally {
    clearTimeout(timer);
  }
}

async function readRpcBody(response) {
  const type = response.headers.get('content-type') ?? '';
  if (type.includes('text/event-stream')) {
    const text = await response.text();
    for (const line of text.split('\n')) {
      const message = parseJsonRpcLine(line);
      if (message && (message.id !== undefined || message.result || message.error)) return message;
    }
    return null;
  }
  try {
    const text = await response.text();
    if (!text.trim()) return null;
    return JSON.parse(text);
  } catch {
    return null;
  }
}

/* ------------------------------------------------------------------- api --- */

/**
 * Probe one canonical server. Never throws; returns a result object whose
 * `status` is `ok` or `error` and whose `code` is a stable diagnostic id.
 */
export async function probeServer(server, { timeoutMs = 20000 } = {}) {
  if (!server) return { status: 'error', code: 'error.probe.missing', detail: 'no server' };
  if (server.transport === 'stdio') return probeStdio(server, timeoutMs);
  return probeRemote(server, timeoutMs);
}

/** Probe a batch with limited concurrency so we never fork the whole matrix. */
export async function probeMany(servers, { timeoutMs = 20000, concurrency = 4 } = {}) {
  const results = new Map();
  const queue = [...servers];
  const workers = Array.from({ length: Math.min(concurrency, queue.length || 1) }, async () => {
    for (;;) {
      const next = queue.shift();
      if (!next) return;
      results.set(next.key, await probeServer(next.server, { timeoutMs }));
    }
  });
  await Promise.all(workers);
  return results;
}
