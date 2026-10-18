'use strict';
/**
 * serial.js —— 串口会话管理
 * 真正干活的是 scripts/serial-bridge.ps1（.NET SerialPort + 行协议），
 * 这里只做会话登记、转发与清理。
 */
const path = require('path');
const crypto = require('crypto');
const { spawn } = require('child_process');
const toolchain = require('./toolchain');

const ROOT = toolchain.ROOT;
const BRIDGE = path.join(ROOT, 'scripts', 'serial-bridge.ps1');

const sessions = new Map(); // sessionId -> { proc, port, baud, listeners:Set, backlog:[] }

function assertPort(port) {
  if (!/^[A-Za-z0-9\\/._-]{2,64}$/.test(port || '')) throw new Error('端口名不合法：' + port);
  return port;
}

function open(port, baud = 115200, opts = {}) {
  assertPort(port);
  const b = parseInt(baud, 10);
  if (!Number.isFinite(b) || b < 300 || b > 4000000) throw new Error('波特率不合法：' + baud);

  const args = ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', BRIDGE,
    '-Port', port, '-Baud', String(b)];
  if (opts.dtr) args.push('-DtrEnable');
  if (opts.rts) args.push('-RtsEnable');

  const proc = spawn('powershell.exe', args, { cwd: ROOT, windowsHide: true });
  const id = crypto.randomBytes(6).toString('hex');
  const session = { id, proc, port, baud: b, listeners: new Set(), backlog: [], ready: false, exitReason: null, buffer: '' };
  sessions.set(id, session);

  const emit = (event) => {
    for (const fn of session.listeners) { try { fn(event); } catch (_) { /* ignore */ } }
    if (session.listeners.size === 0) {
      session.backlog.push(event);
      if (session.backlog.length > 500) session.backlog.shift();
    }
  };

  const handleLine = (line) => {
    if (!line) return;
    const idx = line.indexOf('|');
    const tag = idx === -1 ? line : line.slice(0, idx);
    const rest = idx === -1 ? '' : line.slice(idx + 1);
    if (tag === 'READY') { session.ready = true; emit({ type: 'ready', text: rest }); }
    else if (tag === 'DATA') {
      const buf = Buffer.from(rest, 'base64');
      emit({ type: 'data', hex: buf.toString('hex'), text: buf.toString('utf8'), ts: Date.now() });
    }
    else if (tag === 'ERROR') emit({ type: 'error', text: rest, ts: Date.now() });
    else if (tag === 'CLOSED') { session.exitReason = rest; emit({ type: 'closed', text: rest, ts: Date.now() }); }
    else emit({ type: 'log', text: line, ts: Date.now() });
  };

  proc.stdout.on('data', (buf) => {
    session.buffer += buf.toString('utf8');
    let nl;
    while ((nl = session.buffer.indexOf('\n')) >= 0) {
      const line = session.buffer.slice(0, nl).replace(/\r$/, '');
      session.buffer = session.buffer.slice(nl + 1);
      handleLine(line);
    }
  });
  proc.stderr.on('data', (buf) => emit({ type: 'stderr', text: buf.toString('utf8'), ts: Date.now() }));
  proc.on('error', (err) => emit({ type: 'error', text: String(err.message || err), ts: Date.now() }));
  proc.on('close', (code) => {
    emit({ type: 'closed', text: session.exitReason || `进程退出（code=${code}）`, ts: Date.now() });
    sessions.delete(id);
  });

  return { ok: true, sessionId: id, port, baud: b };
}

function write(id, data, asHex = false) {
  const s = sessions.get(id);
  if (!s) throw new Error('串口会话不存在或已关闭：' + id);
  let buf, encoding = 'utf8';
  // 前端「HEX 发送」时会同时给 data（二进制字符串）与 hex 两个字段。
  // 优先信任 hex：只有它能保证 >0x7F 的字节不被重新编码（见 web/README 存疑项 3）。
  const explicitHex = (data && typeof data === 'object' && typeof data.hex === 'string') ? data.hex : null;
  if (asHex || explicitHex !== null) {
    const clean = String(explicitHex !== null ? explicitHex : data).replace(/[^0-9a-fA-F]/g, '');
    if (clean.length % 2 !== 0) throw new Error('十六进制数据长度必须是偶数');
    buf = Buffer.from(clean, 'hex');
    encoding = 'hex';
  } else {
    buf = Buffer.from(String(data), 'utf8');
  }
  s.proc.stdin.write('SEND ' + buf.toString('base64') + '\n');
  return { ok: true, bytes: buf.length, encoding };
}

function close(id) {
  const s = sessions.get(id);
  if (!s) return { ok: false, reason: '会话不存在' };
  try { s.proc.stdin.write('CLOSE\n'); } catch (_) { /* ignore */ }
  setTimeout(() => { try { if (!s.proc.killed) s.proc.kill(); } catch (_) { /* ignore */ } }, 800);
  return { ok: true };
}

function subscribe(id, fn, sendBacklog = true) {
  const s = sessions.get(id);
  if (!s) return null;
  if (sendBacklog && s.backlog.length) {
    const b = s.backlog.splice(0, s.backlog.length);
    for (const ev of b) { try { fn(ev); } catch (_) { /* ignore */ } }
  }
  s.listeners.add(fn);
  return () => s.listeners.delete(fn);
}

function list() {
  return [...sessions.values()].map(s => ({ id: s.id, port: s.port, baud: s.baud, ready: s.ready, listeners: s.listeners.size }));
}

function closeAll() {
  for (const id of [...sessions.keys()]) close(id);
}

module.exports = { open, write, close, subscribe, list, closeAll };
