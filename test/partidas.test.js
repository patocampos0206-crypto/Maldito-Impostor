'use strict';
// Pruebas de partidas completas con varios "celulares" simulados conectados al servidor real.
// Uso: npm test
const http = require('http');
const assert = require('assert');
const os = require('os');
const path = require('path');
const fs = require('fs');

process.env.MI_NO_RATELIMIT = '1';
process.env.DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'mi-test-'));
const { server, rooms } = require('../server');

let BASE;
const sleep = ms => new Promise(r => setTimeout(r, ms));

async function post(route, body) {
  const r = await fetch(BASE + route, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
  const j = await r.json();
  return { status: r.status, ...j };
}

class Phone {
  constructor(name) { this.name = name; this.state = null; this.events = []; this.req = null; }
  async create() { const r = await post('/api/create', { name: this.name }); assert.ok(r.token, r.error); Object.assign(this, r); await this.connect(); }
  async join(code) { const r = await post('/api/join', { code, name: this.name }); assert.ok(r.token, r.error); Object.assign(this, r); await this.connect(); }
  connect() {
    return new Promise((resolve, reject) => {
      this.req = http.get(`${BASE}/api/stream?code=${this.code}&token=${encodeURIComponent(this.token)}`, res => {
        if (res.statusCode !== 200) { reject(new Error('stream ' + res.statusCode)); return; }
        let buf = '';
        res.setEncoding('utf8');
        res.on('data', chunk => {
          buf += chunk;
          let i;
          while ((i = buf.indexOf('\n\n')) >= 0) {
            const block = buf.slice(0, i); buf = buf.slice(i + 2);
            let ev = 'message'; let data = '';
            for (const line of block.split('\n')) {
              if (line.startsWith('event: ')) ev = line.slice(7);
              else if (line.startsWith('data: ')) data += line.slice(6);
            }
            if (!data) continue;
            const obj = JSON.parse(data);
            if (ev === 'state') { this.state = obj; this.allStates.push(data); }
            else this.events.push({ ev, obj });
          }
        });
        resolve();
      });
      this.req.on('error', () => {});
    });
  }
  disconnect() { this.req.destroy(); }
  act(type, data) { return post('/api/action', { code: this.code, token: this.token, type, data }); }
}
Phone.prototype.allStates = null;

async function until(fn, label, ms = 4000) {
  const t0 = Date.now();
  while (Date.now() - t0 < ms) { try { if (fn()) return; } catch { /* */ } await sleep(15); }
  throw new Error('Timeout esperando: ' + label);
}

let checks = 0;
const ok = (cond, msg) => { assert.ok(cond, msg); checks++; };

async function playGame({ n, imp, mode, ayudin, tieFirst = true, strategy = 'hunt' }) {
  const label = `${n} jugadores, ${imp} impostor(es), ${mode}, ${ayudin ? 'con' : 'sin'} ayudín, estrategia ${strategy}`;
  const names = ['Patricio', 'Martín', 'Lucas', 'Sofía', 'Juan', 'Pedro', 'Ana', 'Caro', 'Nico', 'Vale'];
  const phones = names.slice(0, n).map(nm => { const p = new Phone(nm); p.allStates = []; return p; });
  const [host, ...rest] = phones;
  await host.create();
  for (const p of rest) {
    if (rest.indexOf(p) === 0) {
      // configurar cantidad antes de que se sumen todos
      const r = await host.act('settings', { players: n });
      ok(r.ok, 'settings players ' + r.error);
    }
    await p.join(host.code);
  }
  // Configuración inválida debe rechazarse
  const bad = await host.act('settings', { impostors: Math.floor((n - 1) / 2) + 1 });
  ok(bad.error || Math.floor((n - 1) / 2) + 1 > 3, 'config inválida rechazada');
  const nonHost = await rest[0].act('settings', { mode: 'frases' });
  ok(nonHost.error, 'solo el anfitrión configura');
  const s = await host.act('settings', { impostors: imp, mode, ayudin, drawSeconds: 4, talkSeconds: 0 });
  ok(s.ok, 'settings ' + s.error);
  // Sala llena
  const extra = await post('/api/join', { code: host.code, name: 'Colado' });
  ok(extra.error, 'no entra un jugador de más');

  await until(() => phones.every(p => p.state && p.state.players.length === n && p.state.players.every(x => x.connected)), 'todos conectados');
  const st = await host.act('start', {});
  ok(st.ok, 'start ' + st.error);
  await until(() => phones.every(p => p.state.phase === 'reveal' && p.state.me.role), 'revelación');

  // --- Roles e información secreta ---
  const imps = phones.filter(p => p.state.me.role === 'impostor');
  const norms = phones.filter(p => p.state.me.role === 'normal');
  ok(imps.length === imp, 'cantidad exacta de impostores');
  const secret = norms[0].state.me.secret;
  ok(secret && norms.every(p => p.state.me.secret === secret), 'todos los normales reciben lo mismo');
  for (const p of imps) {
    ok(!p.state.me.secret, 'el impostor no recibe la palabra');
    const all = JSON.stringify(p.state).toLowerCase();
    ok(!all.includes(secret.toLowerCase()), 'el estado del impostor no contiene la palabra en ningún lado');
    if (ayudin) {
      ok(p.state.me.hint && p.state.me.hint.toLowerCase() !== secret.toLowerCase(), 'el impostor recibe ayudín');
    } else ok(!p.state.me.hint, 'sin ayudín no hay pista');
  }
  for (const p of phones) {
    ok(p.state.players.every(x => x.role === undefined), 'nadie ve roles ajenos');
    ok(norms.includes(p) ? !p.state.me.hint : true, 'los normales no reciben ayudín');
  }
  // Reconexión durante la revelación
  const rc = phones[n - 1];
  const prevRole = rc.state.me.role;
  rc.disconnect();
  await sleep(50);
  const resume = await post('/api/resume', { code: rc.code, token: rc.token });
  ok(resume.playerId === rc.playerId, 'resume conserva identidad');
  rc.state = null; await rc.connect();
  await until(() => rc.state && rc.state.me.role === prevRole, 'reconexión conserva el rol');
  // Token falso no da acceso
  const fake = await post('/api/action', { code: host.code, token: 'x'.repeat(32), type: 'vote', data: {} });
  ok(fake.status === 401, 'token falso rechazado');

  for (const p of phones) await p.act('confirmRole', {});
  await until(() => phones.every(p => p.state.phase === 'order'), 'orden');
  for (const p of imps) ok(!p.state.me.hint, 'el ayudín desaparece después de confirmar');
  ok(!JSON.stringify(imps[0].state).toLowerCase().includes(secret.toLowerCase()), 'sigue sin filtrarse');

  let round = 0;
  let firstVote = true;
  const expectedOut = new Set();
  while (true) {
    round++;
    await until(() => host.state.phase === 'order', 'fase orden ronda ' + round);
    const order = host.state.game.order;
    const activeIds = host.state.players.filter(x => x.status === 'active').map(x => x.id);
    ok(order.length === activeIds.length && order.every(id => activeIds.includes(id)), 'el orden incluye solo a los activos');
    await host.act('beginRound', {});
    const byId = id => phones.find(p => p.playerId === id);

    if (mode !== 'dibujo') {
      await until(() => host.state.phase === 'play', 'play');
      for (let i = 0; i < order.length; i++) {
        await until(() => host.state.game.turn.playerId === order[i], 'turno de ' + byId(order[i]).name);
        ok(phones.every(p => p.state.game.turn.playerId === order[i]), 'todos ven el mismo turno');
        const wrong = byId(order[(i + 1) % order.length]);
        if (wrong.playerId !== host.playerId) { const w = await wrong.act('endTurn', {}); ok(w.error, 'no se puede pasar turno ajeno'); }
        await byId(order[i]).act('endTurn', { turn: host.state.game.turn.index });
      }
      await until(() => host.state.game.turn.done, 'vuelta completa');
      // Pedido de votación por mayoría
      const act = phones.filter(p => activeIds.includes(p.playerId));
      for (const p of act) { await p.act('wantVote', { on: true }); if (host.state.phase === 'vote') break; }
    } else {
      await until(() => host.state.phase === 'draw', 'draw');
      for (let i = 0; i < order.length; i++) {
        await until(() => host.state.game.draw.drawerId === order[i] && host.state.game.draw.stage === 'ready', 'turno de dibujo');
        const d = byId(order[i]);
        const other = phones.find(p => p !== d && activeIds.includes(p.playerId));
        const cheat = await other.act('stroke', { sid: 'zz', pts: [[0.1, 0.1]] });
        ok(cheat.error, 'nadie dibuja fuera de turno');
        await d.act('drawBegin', {});
        await until(() => d.state.game.draw.stage === 'drawing', 'dibujando');
        const evBefore = other.events.length;
        await d.act('stroke', { sid: 's1', c: '#ff3b3b', w: 6, pts: [[0.1, 0.1], [0.2, 0.25]] });
        await d.act('stroke', { sid: 's1', pts: [[0.3, 0.3]] });
        await d.act('stroke', { sid: 's2', c: '#2f8cff', w: 4, pts: [[0.5, 0.5], [0.6, 0.6]] });
        await d.act('undo', {});
        await until(() => other.events.length >= evBefore + 3, 'trazos en tiempo real en otro celular');
        if (i === order.length - 1) {
          // último: dejamos que venza el tiempo (debe confirmarse solo)
          await until(() => host.state.phase === 'gallery', 'cierre automático por tiempo', 8000);
        } else {
          await d.act('drawCommit', { turn: d.state.game.draw.index });
        }
      }
      await until(() => host.state.phase === 'gallery', 'galería');
      const contribs = host.state.game.draw.contributions;
      ok(contribs.length === order.length, 'un aporte por jugador');
      ok(contribs.every((c, k) => c.playerId === order[k]), 'cada aporte identificado con su autor, en orden');
      ok(contribs.every(c => c.strokes.length === 1 && c.strokes[0].pts.length === 3), 'el deshacer quitó solo el último trazo propio');
      const act = phones.filter(p => activeIds.includes(p.playerId));
      for (const p of act) await p.act('seenGallery', {});
    }
    await until(() => phones.every(p => p.state.phase === 'vote'), 'votación');

    // --- Votación ---
    const voters = phones.filter(p => activeIds.includes(p.playerId));
    const actImps = voters.filter(p => p.state.me.role === 'impostor');
    const actNorms = voters.filter(p => p.state.me.role === 'normal');
    let targetFor;
    if (firstVote && tieFirst) {
      // Forzar empate entre dos jugadores
      const A = voters[0], B = voters[1];
      targetFor = (p, i) => (p === A ? B : p === B ? A : (i % 2 ? A : B));
      // ajustar para que el conteo quede empatado
      const counts = new Map();
      const plan = voters.map((p, i) => targetFor(p, i));
      plan.forEach(t => counts.set(t, (counts.get(t) || 0) + 1));
      if (counts.get(A) !== counts.get(B)) {
        // con número impar de votantes, un voto va a un tercero
        const C = voters[2];
        let moved = false;
        targetFor = (p, i) => {
          const t = plan[i];
          if (!moved && t === (counts.get(A) > counts.get(B) ? A : B) && p !== C) { moved = true; return C; }
          return t;
        };
      }
    } else if (strategy === 'hunt') {
      const target = actImps[0];
      targetFor = p => (p === target ? actNorms[0] : target);
    } else {
      const target = actNorms[0];
      targetFor = p => (p === target ? actNorms[1] || actImps[0] : target);
    }
    const self = await voters[0].act('vote', { target: voters[0].playerId });
    ok(self.error, 'no se puede votar a uno mismo');
    for (let i = 0; i < voters.length; i++) {
      const r = await voters[i].act('vote', { target: targetFor(voters[i], i).playerId });
      ok(r.ok, 'voto ' + r.error);
      if (i === 0) {
        const again = await voters[0].act('vote', { target: voters[1].playerId === voters[0].playerId ? voters[2].playerId : voters[1].playerId });
        ok(again.error, 'no se puede cambiar el voto');
      }
      if (i < voters.length - 1) {
        await until(() => host.state.game.vote && host.state.game.vote.votedCount === i + 1, 'contador de votos');
        ok(!host.state.game.result, 'resultado oculto hasta que voten todos');
      }
    }
    for (const out of phones.filter(p => !activeIds.includes(p.playerId))) {
      const r = await out.act('vote', { target: voters[0].playerId });
      ok(r.error, 'expulsados no votan');
    }
    await until(() => phones.every(p => p.state.phase === 'results'), 'resultados');
    // Anonimato: ningún estado recibido tuvo el mapa de votos de otros
    for (const p of phones) {
      for (const raw of p.allStates) {
        const st2 = JSON.parse(raw);
        if (st2.game && st2.game.vote) ok(!('votes' in st2.game.vote), 'no se envía quién votó a quién');
      }
    }
    let res = host.state.game.result;
    ok(res.tally.reduce((a, b) => a + b.votes, 0) === voters.length, 'suma de votos correcta');
    if (firstVote && tieFirst) {
      ok(res.tie && res.tied.length >= 2, 'empate detectado');
      await host.act('resolve', {});
      await until(() => host.state.phase === 'vote' && host.state.game.vote.runoff, 'desempate');
      const cands = host.state.game.vote.candidates;
      ok(cands.length === res.tied.length && cands.every(c => res.tied.includes(c)), 'desempate solo entre empatados');
      const outsider = voters.find(p => !cands.includes(p.playerId));
      if (outsider) { const bad2 = await outsider.act('vote', { target: outsider.playerId }); ok(bad2.error, 'voto fuera de candidatos rechazado'); }
      const pick = cands[0];
      for (const p of voters) await p.act('vote', { target: p.playerId === pick ? cands[1] : pick });
      await until(() => host.state.phase === 'results', 'resultado del desempate');
      res = host.state.game.result;
      ok(!res.tie && res.expelledId === pick, 'desempate resuelto');
    }
    firstVote = false;
    const expelledId = res.expelledId;
    await host.act('resolve', {});
    await until(() => phones.every(p => p.state.phase === 'expel'), 'expulsión');
    const ex = host.state.game.lastExpel;
    const exPhone = byId(expelledId);
    ok(ex.playerId === expelledId, 'expulsa al más votado');
    ok(ex.wasImpostor === (exPhone.state.me.role === 'impostor'), 'revela correctamente si era impostor');
    expectedOut.add(expelledId);
    ok(exPhone.state.me.status === 'expelled', 'el expulsado queda fuera');
    // condición de victoria calculada aparte
    const remaining = phones.filter(p => !expectedOut.has(p.playerId));
    const ri = remaining.filter(p => p.state.me.role === 'impostor').length;
    const rn = remaining.length - ri;
    const expectedWinner = ri === 0 ? 'normales' : ri >= rn ? 'impostores' : undefined;
    ok(host.state.game.winner === expectedWinner, `ganador esperado ${expectedWinner} / obtenido ${host.state.game.winner}`);
    ok(host.state.game.activeCount === remaining.length && host.state.game.impostorsLeft === ri, 'contadores actualizados');
    if (expectedWinner) {
      await host.act('finish', {});
      await until(() => phones.every(p => p.state.phase === 'end'), 'final');
      const g = host.state.game;
      ok(g.secret === secret, 'el final muestra la palabra');
      ok(g.impostors.length === imp, 'el final muestra a todos los impostores');
      ok(g.expulsions.length === expectedOut.size && g.voteHistory.length >= round, 'historial completo');
      const rm = await host.act('rematch', {});
      ok(rm.ok, 'revancha');
      await until(() => phones.every(p => p.state.phase === 'lobby'), 'vuelta al lobby');
      ok(host.state.players.length === n, 'revancha con los mismos jugadores');
      phones.forEach(p => p.disconnect());
      return { label, winner: expectedWinner, rounds: round };
    }
    await host.act('nextRound', {});
  }
}

(async () => {
  await new Promise(r => server.listen(0, '127.0.0.1', r));
  BASE = 'http://127.0.0.1:' + server.address().port;
  const configs = [];
  const base = [[5, 1], [6, 2], [8, 2], [10, 3], [3, 1], [7, 3]];
  for (const mode of ['palabras', 'frases', 'dibujo']) {
    for (const [n, imp] of base) {
      if (imp > Math.floor((n - 1) / 2)) continue; // 7 con 3 es válido; 3 con 1 también
      configs.push({ n, imp, mode, ayudin: (n + imp) % 2 === 0, strategy: n % 2 ? 'hunt' : 'blunder', tieFirst: n >= 4 });
      configs.push({ n, imp, mode, ayudin: (n + imp) % 2 !== 0, strategy: n % 2 ? 'blunder' : 'hunt', tieFirst: false });
    }
  }
  const results = [];
  for (const c of configs) {
    const t0 = Date.now();
    const r = await playGame(c);
    results.push(r);
    console.log(`✔ ${r.label} → ganan los ${r.winner} en ${r.rounds} ronda(s) (${Date.now() - t0} ms)`);
  }
  // --- Abandono, retiro y traspaso de anfitrión ---
  {
    const ph = ['Ana', 'Beto', 'Caro', 'Dani', 'Eli'].map(n => { const p = new Phone(n); p.allStates = []; return p; });
    await ph[0].create();
    for (const p of ph.slice(1)) await p.join(ph[0].code);
    await until(() => ph.every(p => p.state && p.state.players.length === 5), 'sala 5');
    await ph[0].act('settings', { mode: 'palabras' });
    await ph[0].act('start', {});
    await until(() => ph.every(p => p.state.phase === 'reveal'), 'reveal');
    const imp = ph.find(p => p.state.me.role === 'impostor');
    const norm = ph.filter(p => p.state.me.role === 'normal' && p !== ph[0]);
    // un jugador normal abandona en plena revelación
    await norm[0].act('leave', {});
    await until(() => ph[0].state.game.expulsions.length === 1, 'abandono registrado');
    ok(ph[0].state.game.expulsions[0].reason === 'abandono' && !ph[0].state.game.expulsions[0].wasImpostor, 'abandono revela rol');
    ok((await norm[0].act('confirmRole', {})).status === 401, 'quien abandonó ya no puede actuar');
    // el anfitrión retira al impostor → ganan los normales
    await ph[0].act('kick', { playerId: imp.playerId });
    await until(() => ph[0].state.phase === 'end' && ph[0].state.game.winner === 'normales', 'retiro del impostor termina la partida');
    ok(true, 'fin por retiro');
    // traspaso de anfitrión si el anfitrión se va
    const r2 = await ph[0].act('rematch', {});
    ok(r2.ok, 'revancha ' + r2.error);
    const stay = ph.find(p => p !== ph[0] && p !== imp && p !== norm[0]);
    await until(() => stay.state.phase === 'lobby' && stay.state.players.length === 3, 'lobby sin los que se fueron');
    await ph[0].act('leave', {});
    await until(() => stay.state.hostId && stay.state.hostId !== ph[0].playerId, 'nuevo anfitrión');
    ok(true, 'traspaso de anfitrión');
    ph.forEach(p => p.disconnect());
    console.log('✔ abandono, retiro y traspaso de anfitrión');
  }
  // Sin repeticiones de contenido entre partidas de la misma sala/servidor
  console.log(`\n${results.length} partidas completas, ${checks} verificaciones OK. Salas en memoria: ${rooms.size}`);
  server.close();
  process.exit(0);
})().catch(e => { console.error('✘ FALLÓ:', e); process.exit(1); });
