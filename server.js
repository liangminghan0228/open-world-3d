'use strict';
/* 旷野 · 多端同步服务（无第三方依赖）
 * 职责：玩家位置广播 / 聊天 / 世界留言持久化 / 对讲语音片段转发
 */
const http = require('http');
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');

const PORT = +(process.env.OW_PORT || 8787);
const HOST = process.env.OW_HOST || '127.0.0.1';
const DATA_DIR = process.env.OW_DATA || path.join(__dirname, 'data');
const NOTES_FILE = path.join(DATA_DIR, 'notes.json');
const VISITS_FILE = path.join(DATA_DIR, 'visits.json');
const MAX_NOTES = 240;
const MAX_VISITS = 400;
const MAX_CLIENTS = 60;
const GUID = '258EAFA5-E914-47DA-95CA-C5AB0DC85B11';

try { fs.mkdirSync(DATA_DIR, { recursive: true }); } catch (e) { }

let notes = [];
try {
  const raw = JSON.parse(fs.readFileSync(NOTES_FILE, 'utf8'));
  if (Array.isArray(raw)) notes = raw;
} catch (e) { notes = []; }

const clients = new Map();
let nextId = 1;
let noteSeq = notes.reduce((m, n) => Math.max(m, n.id || 0), 0);

/* 到访记录：ip -> { ip, t(最后到访), c(次数), n(昵称) } */
let visits = [];
try {
  const raw = JSON.parse(fs.readFileSync(VISITS_FILE, 'utf8'));
  if (Array.isArray(raw)) visits = raw.filter(v => v && v.ip).slice(-MAX_VISITS);
} catch (e) { visits = []; }
let dirtyVisits = false;

const server = http.createServer((req, res) => {
  if (req.url && req.url.indexOf('/health') === 0) {
    res.writeHead(200, { 'Content-Type': 'text/plain' });
    res.end('ok clients=' + clients.size + ' notes=' + notes.length);
    return;
  }
  res.writeHead(404, { 'Content-Type': 'text/plain' });
  res.end('not found');
});

/* ---------------- WebSocket 基础 ---------------- */
function frame(str) {
  const buf = Buffer.from(str);
  const len = buf.length;
  let head;
  if (len < 126) {
    head = Buffer.alloc(2); head[0] = 0x81; head[1] = len;
  } else if (len < 65536) {
    head = Buffer.alloc(4); head[0] = 0x81; head[1] = 126; head.writeUInt16BE(len, 2);
  } else {
    head = Buffer.alloc(10); head[0] = 0x81; head[1] = 127; head.writeBigUInt64BE(BigInt(len), 2);
  }
  return Buffer.concat([head, buf]);
}
function send(c, obj) {
  if (!c.alive) return;
  try { c.sock.write(frame(typeof obj === 'string' ? obj : JSON.stringify(obj))); } catch (e) { }
}
function sendRaw(c, buf) {
  if (!c.alive) return;
  try { c.sock.write(buf); } catch (e) { }
}

server.on('upgrade', (req, socket) => {
  const key = req.headers['sec-websocket-key'];
  if (!key || clients.size >= MAX_CLIENTS) {
    socket.write('HTTP/1.1 503 Service Unavailable\r\n\r\n');
    socket.destroy();
    return;
  }
  const accept = crypto.createHash('sha1').update(key + GUID).digest('base64');
  socket.write(
    'HTTP/1.1 101 Switching Protocols\r\n' +
    'Upgrade: websocket\r\n' +
    'Connection: Upgrade\r\n' +
    'Sec-WebSocket-Accept: ' + accept + '\r\n\r\n'
  );
  socket.setNoDelay(true);
  socket.setTimeout(0);

  const c = {
    id: nextId++, sock: socket, buf: Buffer.alloc(0), alive: true,
    ip: clientIp(req, socket), counted: false,
    name: '旅人', x: 0, z: 0, y: 0, h: 0, w: 'pistol', veh: '', last: Date.now(), lastP: 0
  };
  clients.set(c.id, c);
  socket.on('data', d => onData(c, d));
  socket.on('close', () => bye(c));
  socket.on('error', () => bye(c));
  socket.on('end', () => bye(c));
  recordVisit(c);
  send(c, { t: 'welcome', id: c.id, n: clients.size, notes: notes.slice(-MAX_NOTES), visits: visitList(), vt: visits.length, ip: maskIp(c.ip) });
  broadcast({ t: 'join', i: c.id, n: c.name }, c.id);
});

function bye(c) {
  if (!c.alive) return;
  c.alive = false;
  clients.delete(c.id);
  broadcast({ t: 'left', i: c.id, n: clients.size });
  try { c.sock.destroy(); } catch (e) { }
}

function onData(c, d) {
  c.buf = Buffer.concat([c.buf, d]);
  while (c.buf.length >= 2) {
    const b0 = c.buf[0], b1 = c.buf[1];
    const op = b0 & 0x0f;
    const masked = (b1 & 0x80) !== 0;
    const l0 = b1 & 0x7f;
    let off = 2, len = l0;
    if (l0 === 126) {
      if (c.buf.length < 4) return;
      len = c.buf.readUInt16BE(2); off = 4;
    } else if (l0 === 127) {
      if (c.buf.length < 10) return;
      const big = c.buf.readBigUInt64BE(2);
      if (big > 200000n) { bye(c); return; }
      len = Number(big); off = 10;
    }
    const mk = masked ? 4 : 0;
    if (c.buf.length < off + mk + len) return;
    const mask = masked ? Buffer.from(c.buf.slice(off, off + 4)) : null;
    const pay = Buffer.from(c.buf.slice(off + mk, off + mk + len));
    c.buf = c.buf.slice(off + mk + len);
    if (mask) for (let i = 0; i < pay.length; i++) pay[i] ^= mask[i & 3];

    if (op === 0x8) { bye(c); return; }
    if (op === 0x9) {
      const pong = Buffer.alloc(2 + pay.length);
      pong[0] = 0x8a; pong[1] = pay.length;
      pay.copy(pong, 2);
      sendRaw(c, pong);
      continue;
    }
    if (op !== 0x1) { c.last = Date.now(); continue; }

    c.last = Date.now();
    let m;
    try { m = JSON.parse(pay.toString('utf8')); } catch (e) { continue; }
    if (m && typeof m.t === 'string') onMsg(c, m);
  }
}

/* ---------------- 业务 ---------------- */
const r1 = v => Math.round((+v || 0) * 10) / 10;
const r2 = v => Math.round((+v || 0) * 100) / 100;
const clamp = (v, a, b) => (v < a ? a : v > b ? b : v);
const clean = (s, n) => String(s == null ? '' : s).replace(/[\r\n\t]/g, ' ').trim().slice(0, n);

/* ---------------- 到访记录 ---------------- */
function clientIp(req, socket) {
  const xf = req.headers['x-forwarded-for'] || req.headers['x-real-ip'] || '';
  let ip = String(xf).split(',')[0].trim();
  if (!ip && socket) ip = socket.remoteAddress || '';
  if (ip.indexOf('::ffff:') === 0) ip = ip.slice(7);
  if (ip === '::1' || ip === '') ip = '127.0.0.1';
  return clean(ip, 46);
}
function maskIp(ip) {
  const v4 = ip.split('.');
  if (v4.length === 4) return v4[0] + '.' + v4[1] + '.*.*';
  const v6 = ip.split(':').filter(Boolean);
  if (v6.length >= 2) return v6.slice(0, 2).join(':') + ':****';
  return ip;
}
function recordVisit(c) {
  if (!c.ip) return;
  const now = Date.now();
  const v = visits.find(x => x.ip === c.ip);
  if (v) {
    v.t = now;
    if (c.name) v.n = c.name;
    if (!c.counted) v.c = (v.c || 1) + 1;
  } else {
    visits.push({ ip: c.ip, t: now, c: 1, n: c.name || '旅人' });
    if (visits.length > MAX_VISITS) visits = visits.slice(-MAX_VISITS);
  }
  c.counted = true;
  dirtyVisits = true;
  pushVisits();
}
function visitList() {
  return visits.slice(-40).map(v => ({ i: maskIp(v.ip), n: v.n || '旅人', t: v.t, c: v.c || 1 }));
}
function pushVisits() {
  broadcast({ t: 'visits', l: visitList(), on: clients.size, vt: visits.length });
}

function broadcast(obj, exceptId) {
  const s = JSON.stringify(obj);
  for (const c of clients.values()) {
    if (c.id === exceptId) continue;
    send(c, s);
  }
}
function broadcastNear(src, obj, range) {
  const s = JSON.stringify(obj);
  for (const c of clients.values()) {
    if (c.id === src.id) continue;
    const dx = c.x - src.x, dz = c.z - src.z;
    if (dx * dx + dz * dz <= range * range) send(c, s);
  }
}

function onMsg(c, m) {
  switch (m.t) {
    case 'hi': {
      c.name = clean(m.n, 12) || ('旅人' + c.id);
      if (typeof m.x === 'number') c.x = m.x;
      if (typeof m.z === 'number') c.z = m.z;
      if (typeof m.y === 'number') c.y = m.y;
      recordVisit(c);
      broadcast({ t: 'join', i: c.id, n: c.name }, c.id);
      send(c, { t: 'hello', id: c.id, n: clients.size, notes: notes.slice(-MAX_NOTES), visits: visitList(), vt: visits.length, ip: maskIp(c.ip) });
      break;
    }
    case 'p': {
      c.x = +m.x || 0; c.z = +m.z || 0; c.y = +m.y || 0; c.h = +m.h || 0;
      c.w = clean(m.w, 10) || 'pistol';
      c.veh = clean(m.v, 10);
      const now = Date.now();
      if (now - c.lastP < 85) break;
      c.lastP = now;
      broadcastNear(c, {
        t: 'p', i: c.id, n: c.name,
        x: r1(c.x), z: r1(c.z), y: r1(c.y), h: r2(c.h), w: c.w, v: c.veh
      }, 300);
      break;
    }
    case 'say': {
      const txt = clean(m.m, 120);
      if (!txt) break;
      broadcast({ t: 'say', i: c.id, n: c.name, m: txt });
      break;
    }
    case 'note': {
      const txt = clean(m.m, 100);
      if (!txt) break;
      if (notes.length >= MAX_NOTES) notes.shift();
      const note = {
        id: ++noteSeq, x: r1(m.x), y: r1(m.y), z: r1(m.z),
        m: txt, n: c.name, t: Date.now()
      };
      notes.push(note);
      dirtyNotes = true;
      broadcast({ t: 'note', o: note });
      break;
    }
    case 'va': {
      const d = String(m.d || '');
      if (d.length < 40 || d.length > 90000) break;
      broadcastNear(c, { t: 'vs', i: c.id, n: c.name, d }, 55);
      break;
    }
    case 'ping':
      c.last = Date.now();
      break;
  }
}

/* 留言落盘（节流） */
let dirtyNotes = false;
setInterval(() => {
  if (!dirtyNotes) return;
  dirtyNotes = false;
  fs.writeFile(NOTES_FILE, JSON.stringify(notes), err => {
    if (err) dirtyNotes = true;
  });
}, 2500);

/* 到访记录落盘（节流） */
setInterval(() => {
  if (!dirtyVisits) return;
  dirtyVisits = false;
  fs.writeFile(VISITS_FILE, JSON.stringify(visits), err => {
    if (err) dirtyVisits = true;
  });
}, 3000);

/* 心跳与超时清理 */
setInterval(() => {
  const now = Date.now();
  for (const c of Array.from(clients.values())) {
    if (now - c.last > 90000) { bye(c); continue; }
    sendRaw(c, Buffer.from([0x89, 0x00]));
  }
}, 25000);

server.listen(PORT, HOST, () => {
  console.log('[ow] listening on ' + HOST + ':' + PORT + ' notes=' + notes.length);
});
