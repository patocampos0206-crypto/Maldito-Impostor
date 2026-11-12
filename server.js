'use strict';
// MALDITO IMPOSTOR — servidor multijugador (Node.js, sin dependencias externas)
// · HTTP + Server-Sent Events para sincronización en tiempo real
// · Toda la información secreta (roles, palabras, votos) vive solo en el servidor
const http = require('http');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { Room, GameError } = require('./lib/game');
const { ContentBank } = require('./lib/content');

const PORT = parseInt(process.env.PORT || '3000', 10);
const HOST = process.env.HOST || '0.0.0.0';
const DATA_DIR = process.env.DATA_DIR || path.join(__dirname, 'data');
const PUBLIC_DIR = path.join(__dirname, 'public');
const ROOM_TTL_MS = 12 * 60 * 60 * 1000;
const RECENT_MAX = 400;

fs.mkdirSync(DATA_DIR, { recursive: true });
const bank = new ContentBank();
console.log(`[banco] ${bank.frases.length} frases, ${bank.palabras.length} palabras, ${Object.keys(bank.categories).length} categorías`);

// ---------- Estado global ----------
const rooms = new Map();          // code -> Room
const streams = new Map();        // code -> Set<{res, playerId}>
let recent = [];                  // ids de contenidos usados recientemente (entre partidas)

const deps = {
  bank,
  recentGlobal: () => recent,
  addRecent: id => { recent.push(id); if (recent.length > RECENT_MAX) recent = recent.slice(-RECENT_MAX); },
};

// ---------- Persistencia ----------
const ROOMS_FILE = path.join(DATA_DIR, 'rooms.json');
const RECENT_FILE = path.join(DATA_DIR, 'recent.json');
function loadState() {
  try {
    if (fs.existsSync(ROOMS_FILE)) {
      const arr = JSON.parse(fs.readFileSync(ROOMS_FILE, 'utf8'));
      for (const o of arr) if (Date.now() - o.updatedAt < ROOM_TTL_MS) rooms.set(o.code, Room.fromJSON(o, deps));
    }
    if (fs.existsSync(RECENT_FILE)) recent = JSON.parse(fs.readFileSync(RECENT_FILE, 'utf8'));
    console.log(`[estado] ${rooms.size} salas recuperadas`);
  } catch (e) { console.error('[estado] no se pudo leer:', e.message); }
}
let saveTimer = null;
function scheduleSave() {
  if (saveTimer) return;
  saveTimer = setTimeout(() => {
    saveTimer = null;
    try {
      const tmp = ROOMS_FILE + '.tmp';
      fs.writeFileSync(tmp, JSON.stringify([...rooms.values()].map(r => r.toJSON())));
      fs.renameSync(tmp, ROOMS_FILE);
      fs.writeFileSync(RECENT_FILE, JSON.stringify(recent));
    } catch (e) { console.error('[estado] no se pudo guardar:', e.message); }
  }, 1000);
}
loadState();

// ---------- Utilidades ----------
const CODE_ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ';
function newCode() {
  for (let i = 0; i < 1000; i++) {
    let c = '';
    for (let j = 0; j < 4; j++) c += CODE_ALPHABET[crypto.randomInt(CODE_ALPHABET.length)];
    if (!rooms.has(c)) return c;
  }
  throw new Error('No hay códigos disponibles');
}
function normCode(c) { return String(c || '').toUpperCase().replace(/[^A-Z]/g, '').slice(0, 4); }

const SEC_HEADERS = {
  'X-Content-Type-Options': 'nosniff',
  'Referrer-Policy': 'no-referrer',
  'X-Frame-Options': 'DENY',
  'Permissions-Policy': 'camera=(), microphone=(), geolocation=()',
  'Content-Security-Policy': "default-src 'self'; img-src 'self' data: blob:; style-src 'self' 'unsafe-inline'; script-src 'self'; connect-src 'self'; manifest-src 'self'; worker-src 'self'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'",
};
function sendJSON(res, status, obj) {
  res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store', ...SEC_HEADERS });
  res.end(JSON.stringify(obj));
}
function readBody(req, limit = 64 * 1024) {
  return new Promise((resolve, reject) => {
    let size = 0; const chunks = [];
    req.on('data', c => { size += c.length; if (size > limit) { reject(new GameError('Solicitud demasiado grande')); req.destroy(); } else chunks.push(c); });
    req.on('end', () => { try { resolve(chunks.length ? JSON.parse(Buffer.concat(chunks).toString('utf8')) : {}); } catch { reject(new GameError('JSON inválido')); } });
    req.on('error', reject);
  });
}

// Limitador simple por clave (IP o token)
const buckets = new Map();
const NO_LIMIT = process.env.MI_NO_RATELIMIT === '1';
function allow(key, perSec, burst) {
  if (NO_LIMIT) return true;
  const now = Date.now();
  let b = buckets.get(key);
  if (!b) { b = { t: burst, at: now }; buckets.set(key, b); }
  b.t = Math.min(burst, b.t + ((now - b.at) / 1000) * perSec); b.at = now;
  if (b.t < 1) return false;
  b.t -= 1; return true;
}
setInterval(() => { const now = Date.now(); for (const [k, b] of buckets) if (now - b.at > 60000) buckets.delete(k); }, 60000).unref();
function ipOf(req) { return (req.headers['x-forwarded-for'] || '').split(',')[0].trim() || req.socket.remoteAddress || '?'; }

// ---------- Tiempo real ----------
function sse(res, event, data) { try { res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`); } catch { /* conexión caída */ } }
function broadcast(room) {
  const set = streams.get(room.code);
  if (set) for (const s of set) sse(s.res, 'state', room.viewFor(s.playerId));
  scheduleSave();
}
function emitEvent(room, ev, exceptId) {
  const set = streams.get(room.code);
  if (set) for (const s of set) if (s.playerId !== exceptId) sse(s.res, ev.type, ev);
}
function closeStreamsOf(room, playerId, reason) {
  const set = streams.get(room.code);
  if (!set) return;
  for (const s of [...set]) if (s.playerId === playerId) { sse(s.res, 'kicked', { reason }); s.res.end(); set.delete(s); }
}

function openStream(req, res, url) {
  const code = normCode(url.searchParams.get('code'));
  const room = rooms.get(code);
  const p = room && room.byToken(url.searchParams.get('token') || '');
  if (!room || !p) { sendJSON(res, 404, { error: 'Sala o jugador no encontrado', code: 'gone' }); return; }
  res.writeHead(200, {
    'Content-Type': 'text/event-stream; charset=utf-8', 'Cache-Control': 'no-store, no-transform',
    Connection: 'keep-alive', 'X-Accel-Buffering': 'no', ...SEC_HEADERS,
  });
  res.write('retry: 1500\n\n');
  const entry = { res, playerId: p.id };
  if (!streams.has(code)) streams.set(code, new Set());
  streams.get(code).add(entry);
  room.setConnected(p, +1);
  broadcast(room);
  const hb = setInterval(() => { try { res.write(': ping\n\n'); } catch { /* */ } }, 15000);
  req.on('close', () => {
    clearInterval(hb);
    streams.get(code)?.delete(entry);
    const pl = room.player(p.id);
    if (pl) room.setConnected(pl, -1);
    if (rooms.has(code)) broadcast(room);
  });
}

// ---------- API ----------
async function api(req, res, url) {
  const route = url.pathname;
  if (route === '/api/stream' && req.method === 'GET') return openStream(req, res, url);
  if (route === '/api/info' && req.method === 'GET') {
    return sendJSON(res, 200, { frases: bank.frases.length, palabras: bank.palabras.length, categorias: bank.categoryList() });
  }
  if (route === '/api/health') return sendJSON(res, 200, { ok: true, rooms: rooms.size });
  if (req.method !== 'POST') return sendJSON(res, 405, { error: 'Método no permitido' });

  const body = await readBody(req);
  const ip = ipOf(req);

  if (route === '/api/create') {
    if (!allow('create:' + ip, 0.2, 10)) return sendJSON(res, 429, { error: 'Demasiados intentos. Esperá un momento.' });
    const room = new Room(newCode(), deps);
    const p = room.addPlayer(body.name);
    rooms.set(room.code, room);
    scheduleSave();
    return sendJSON(res, 200, { code: room.code, token: p.token, playerId: p.id });
  }
  if (route === '/api/join') {
    if (!allow('join:' + ip, 1, 20)) return sendJSON(res, 429, { error: 'Demasiados intentos. Esperá un momento.' });
    const room = rooms.get(normCode(body.code));
    if (!room) return sendJSON(res, 404, { error: 'No existe una sala con ese código', code: 'noroom' });
    const p = room.addPlayer(body.name);
    broadcast(room);
    return sendJSON(res, 200, { code: room.code, token: p.token, playerId: p.id });
  }
  if (route === '/api/resume') {
    const room = rooms.get(normCode(body.code));
    const p = room && room.byToken(body.token);
    if (!p) return sendJSON(res, 404, { error: 'La sesión anterior ya no existe', code: 'gone' });
    return sendJSON(res, 200, { code: room.code, playerId: p.id, name: p.name });
  }
  if (route === '/api/action') {
    const room = rooms.get(normCode(body.code));
    const p = room && room.byToken(body.token);
    if (!p) return sendJSON(res, 401, { error: 'Tu sesión en esta sala ya no es válida', code: 'gone' });
    const isStroke = body.type === 'stroke';
    if (!allow('act:' + p.id, isStroke ? 60 : 10, isStroke ? 150 : 30)) return sendJSON(res, 429, { error: 'Más despacio' });
    const out = room.act(p, String(body.type || ''), body.data || {});
    if (out.event) emitEvent(room, out.event, out.except);
    if (out.state) broadcast(room);
    if (out.kicked) closeStreamsOf(room, out.kicked.id, 'El anfitrión te sacó de la sala');
    if (body.type === 'leave') closeStreamsOf(room, p.id, 'Saliste de la sala');
    if (!room.present().length) { rooms.delete(room.code); streams.delete(room.code); scheduleSave(); }
    return sendJSON(res, 200, { ok: true });
  }
  return sendJSON(res, 404, { error: 'No encontrado' });
}

// ---------- Archivos estáticos ----------
const MIME = {
  '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8',
  '.json': 'application/json', '.webmanifest': 'application/manifest+json', '.svg': 'image/svg+xml',
  '.png': 'image/png', '.ico': 'image/x-icon', '.woff2': 'font/woff2', '.txt': 'text/plain; charset=utf-8',
};
function serveStatic(req, res, url) {
  let p = decodeURIComponent(url.pathname);
  if (p === '/' || /^\/[A-Za-z]{4}$/.test(p)) p = '/index.html'; // /ABCD abre la app con el código
  const file = path.normalize(path.join(PUBLIC_DIR, p));
  if (!file.startsWith(PUBLIC_DIR)) { res.writeHead(403); return res.end(); }
  fs.stat(file, (err, st) => {
    if (err || !st.isFile()) { res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8', ...SEC_HEADERS }); return res.end('No encontrado'); }
    const ext = path.extname(file);
    const noCache = ext === '.html' || p === '/sw.js' || ext === '.webmanifest';
    res.writeHead(200, { 'Content-Type': MIME[ext] || 'application/octet-stream', 'Cache-Control': noCache ? 'no-cache' : 'public, max-age=3600', ...SEC_HEADERS });
    fs.createReadStream(file).pipe(res);
  });
}

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, 'http://x');
  try {
    if (url.pathname.startsWith('/api/')) await api(req, res, url);
    else serveStatic(req, res, url);
  } catch (e) {
    if (e instanceof GameError) sendJSON(res, 400, { error: e.message, code: e.code });
    else { console.error(e); if (!res.headersSent) sendJSON(res, 500, { error: 'Error interno' }); }
  }
});
server.keepAliveTimeout = 65000;

// Reloj: turnos con tiempo, fin de trazos, traspaso de anfitrión
setInterval(() => {
  const now = Date.now();
  for (const room of rooms.values()) {
    try { if (room.tick(now)) broadcast(room); } catch (e) { console.error('[tick]', e); }
  }
}, 250).unref();
// Limpieza de salas viejas
setInterval(() => {
  const now = Date.now();
  for (const [code, room] of rooms) {
    const live = streams.get(code)?.size || 0;
    if ((!live && now - room.updatedAt > ROOM_TTL_MS) || (!room.present().length)) { rooms.delete(code); streams.delete(code); }
  }
  scheduleSave();
}, 5 * 60 * 1000).unref();

if (require.main === module) {
  server.listen(PORT, HOST, () => console.log(`MALDITO IMPOSTOR escuchando en http://localhost:${PORT}`));
}
module.exports = { server, rooms };
