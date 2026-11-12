'use strict';
// Lógica autoritativa de MALDITO IMPOSTOR. Todo el estado secreto vive acá, en el servidor.
// Cada jugador recibe una "vista" personalizada (viewFor) que solo incluye lo que puede ver.
const crypto = require('crypto');

const LIMITS = {
  minPlayers: 3, maxPlayers: 10, maxImpostors: 3, nameMax: 16,
  drawMin: 4, drawMax: 30, talkOptions: [0, 15, 20, 30, 45, 60, 90, 120],
  maxStrokesPerTurn: 24, maxPointsPerStroke: 600, readyTimeout: 25, gallerySeconds: 0,
};
const MODES = ['frases', 'palabras', 'dibujo'];
const PLAYER_COLORS = ['#ff3b5c', '#ffb020', '#2ee6a6', '#38b6ff', '#b36bff', '#ff7ad9', '#f5f05a', '#7cff6b', '#ff8a3d', '#5ef2ff'];
const INK = ['#ffffff', '#111111', '#ff3b3b', '#ff9f1a', '#ffe14d', '#3ddc84', '#2f8cff', '#9b5cff', '#ff6ec7', '#8b5a2b', '#9aa0a6', '#00d1c1'];

class GameError extends Error { constructor(msg, code) { super(msg); this.code = code || 'invalid'; } }

const rid = (n = 6) => crypto.randomBytes(n).toString('hex');
const newToken = () => crypto.randomBytes(24).toString('base64url');
function shuffle(a) {
  const arr = a.slice();
  for (let i = arr.length - 1; i > 0; i--) { const j = crypto.randomInt(i + 1); [arr[i], arr[j]] = [arr[j], arr[i]]; }
  return arr;
}
function cleanName(n) {
  return String(n || '').replace(/[\u0000-\u001f<>]/g, '').replace(/\s+/g, ' ').trim().slice(0, LIMITS.nameMax);
}
function maxImpostorsFor(players) {
  // Debe haber siempre más jugadores normales que impostores para que la partida tenga sentido.
  return Math.max(1, Math.min(LIMITS.maxImpostors, Math.floor((players - 1) / 2)));
}

class Room {
  constructor(code, deps) {
    this.code = code;
    this.deps = deps; // { bank, recentGlobal(), addRecent(id) }
    this.createdAt = Date.now();
    this.updatedAt = Date.now();
    this.hostId = null;
    this.players = [];
    this.phase = 'lobby';
    this.settings = { players: 5, impostors: 1, mode: 'palabras', ayudin: true, talkSeconds: 0, drawSeconds: 8, categories: [] };
    this.game = null;
    this.usedContent = [];
    this.gamesPlayed = 0;
    this.hostAwaySince = null;
  }

  // ---------- Persistencia ----------
  toJSON() {
    const { deps, ...rest } = this; // eslint-disable-line no-unused-vars
    return { ...rest, players: this.players.map(p => ({ ...p, connected: 0 })) };
  }
  static fromJSON(obj, deps) {
    const r = new Room(obj.code, deps);
    Object.assign(r, obj);
    r.deps = deps;
    r.players.forEach(p => { p.connected = 0; });
    return r;
  }

  touch() { this.updatedAt = Date.now(); }

  // ---------- Jugadores ----------
  player(id) { return this.players.find(p => p.id === id); }
  byToken(tok) {
    if (typeof tok !== 'string' || tok.length < 20) return null;
    return this.players.find(p => p.token && p.token === tok) || null;
  }
  active() { return this.players.filter(p => p.status === 'active'); }
  present() { return this.players.filter(p => p.status !== 'left'); }
  isHost(p) { return p && p.id === this.hostId; }

  addPlayer(rawName) {
    const name = cleanName(rawName);
    if (name.length < 1) throw new GameError('Escribí tu nombre o apodo');
    if (this.phase !== 'lobby') throw new GameError('La partida ya empezó. Esperá a que termine para sumarte.', 'started');
    const present = this.present();
    if (present.length >= LIMITS.maxPlayers) throw new GameError('La sala está llena (máximo 10 jugadores)', 'full');
    if (this.hostId && present.length >= this.settings.players) {
      throw new GameError(`La sala está completa (${present.length}/${this.settings.players}). Pedile al anfitrión que aumente la cantidad de jugadores.`, 'full');
    }
    if (present.some(p => p.name.toLocaleLowerCase('es') === name.toLocaleLowerCase('es'))) throw new GameError('Ya hay alguien con ese nombre en la sala. Probá con otro.', 'name');
    const used = new Set(present.map(p => p.color));
    const color = PLAYER_COLORS.find(c => !used.has(c)) || PLAYER_COLORS[present.length % PLAYER_COLORS.length];
    const p = {
      id: rid(), token: newToken(), name, color, joinedAt: Date.now(),
      status: 'lobby', role: null, seenRole: false, hintSeen: false, wantVote: false, seenGallery: false,
      connected: 0, lastSeen: Date.now(),
    };
    this.players.push(p);
    if (!this.hostId) { this.hostId = p.id; this.settings.players = Math.max(3, this.settings.players); }
    this.touch();
    return p;
  }

  setConnected(p, delta) {
    p.connected = Math.max(0, (p.connected || 0) + delta);
    p.lastSeen = Date.now();
  }

  transferHost() {
    const cands = this.present().filter(p => p.id !== this.hostId);
    const next = cands.find(p => p.connected > 0 && p.status === 'active') || cands.find(p => p.connected > 0) || cands[0];
    if (next) this.hostId = next.id;
  }

  // ---------- Acciones ----------
  // Devuelve { state: true } si hay que reenviar el estado, o { event } para eventos livianos (trazos).
  act(p, type, d = {}) {
    if (!p || p.status === 'left') throw new GameError('No estás en esta sala', 'auth');
    const host = this.isHost(p);
    const needHost = () => { if (!host) throw new GameError('Solo el anfitrión puede hacer esto', 'host'); };
    const needPhase = (...ph) => { if (!ph.includes(this.phase)) throw new GameError('Esa acción no corresponde en este momento', 'phase'); };
    const needActive = () => { if (p.status !== 'active') throw new GameError('Fuiste expulsado: ya no podés participar de esta partida', 'inactive'); };
    this.touch();

    switch (type) {
      case 'settings': needHost(); needPhase('lobby'); this.updateSettings(d); return { state: true };
      case 'kick': {
        needHost();
        const t = this.player(d.playerId);
        if (!t || t.id === p.id) throw new GameError('Jugador inválido');
        this.removePlayer(t, 'kick');
        return { state: true, kicked: t };
      }
      case 'leave': this.removePlayer(p, 'leave'); return { state: true };
      case 'makeHost': {
        needHost();
        const t = this.player(d.playerId);
        if (!t || t.status === 'left') throw new GameError('Jugador inválido');
        this.hostId = t.id; return { state: true };
      }
      case 'start': needHost(); needPhase('lobby'); this.start(); return { state: true };

      case 'confirmRole': needPhase('reveal', 'order', 'play', 'draw', 'gallery', 'vote', 'results', 'expel');
        p.seenRole = true; p.hintSeen = true;
        if (this.phase === 'reveal' && this.active().every(x => x.seenRole)) this.toOrder();
        return { state: true };
      case 'forceReveal': needHost(); needPhase('reveal'); this.toOrder(); return { state: true };

      case 'beginRound': needHost(); needPhase('order'); this.beginRound(); return { state: true };

      // --- Frases / Palabras ---
      case 'endTurn': {
        needPhase('play');
        const cur = this.currentTalker();
        if (!cur) throw new GameError('La vuelta ya terminó');
        if (cur.id !== p.id && !host) throw new GameError('No es tu turno');
        if (typeof d.turn === 'number' && d.turn !== this.game.turn.index) return { state: true }; // doble toque
        this.advanceTalk(); return { state: true };
      }
      case 'nextLap': needHost(); needPhase('play'); this.startLap(); return { state: true };
      case 'wantVote': needPhase('play'); needActive();
        p.wantVote = !!d.on;
        if (this.wantVoteCount() >= this.wantVoteNeeded()) this.startVote();
        return { state: true };
      case 'startVote': needHost(); needPhase('play', 'gallery'); this.startVote(); return { state: true };

      // --- Dibujo ---
      case 'drawBegin': {
        needPhase('draw'); needActive();
        const dr = this.game.draw;
        if (this.currentDrawer()?.id !== p.id) throw new GameError('No es tu turno');
        if (dr.stage !== 'ready') return { state: true };
        this.beginDrawing(); return { state: true };
      }
      case 'stroke': return this.addStroke(p, d);
      case 'undo': {
        needPhase('draw');
        const dr = this.game.draw;
        if (this.currentDrawer()?.id !== p.id || dr.stage !== 'drawing') throw new GameError('No es tu turno');
        dr.live.pop(); return { state: true };
      }
      case 'drawCommit': {
        needPhase('draw');
        if (this.currentDrawer()?.id !== p.id) throw new GameError('No es tu turno');
        if (typeof d.turn === 'number' && d.turn !== this.game.draw.index) return { state: true };
        this.commitDrawing(); return { state: true };
      }
      case 'skipTurn': needHost(); needPhase('draw'); this.commitDrawing(); return { state: true };
      case 'seenGallery': needPhase('gallery');
        p.seenGallery = true;
        if (this.active().every(x => x.seenGallery)) this.startVote();
        return { state: true };

      // --- Votación ---
      case 'vote': needPhase('vote'); needActive(); this.castVote(p, d.target); return { state: true };
      case 'resolve': needHost(); needPhase('results'); this.resolveResults(); return { state: true };
      case 'randomTiebreak': {
        needHost(); needPhase('results');
        const r = this.game.result;
        if (!r.tie || this.game.tieRounds < 2) throw new GameError('El sorteo solo se habilita después de dos empates seguidos');
        this.expel(r.tied[crypto.randomInt(r.tied.length)], 'sorteo'); return { state: true };
      }
      case 'nextRound': needHost(); needPhase('expel');
        if (this.game.winner) throw new GameError('La partida terminó');
        this.game.round += 1; this.toOrder(); return { state: true };
      case 'finish': needHost(); needPhase('expel'); if (!this.game.winner) throw new GameError('La partida sigue'); this.phase = 'end'; return { state: true };
      case 'rematch': needHost(); needPhase('end'); this.toLobby(); return { state: true };
      case 'abort': needHost(); if (this.phase === 'lobby') return { state: true }; this.toLobby(); return { state: true };
      default: throw new GameError('Acción desconocida');
    }
  }

  updateSettings(d) {
    const s = { ...this.settings };
    const count = this.present().length;
    if (d.players !== undefined) {
      const n = parseInt(d.players, 10);
      if (!(n >= LIMITS.minPlayers && n <= LIMITS.maxPlayers)) throw new GameError('La cantidad de jugadores debe ser entre 3 y 10');
      if (n < count) throw new GameError(`Ya hay ${count} jugadores en la sala`);
      s.players = n;
      if (s.impostors > maxImpostorsFor(n)) s.impostors = maxImpostorsFor(n);
    }
    if (d.impostors !== undefined) {
      const n = parseInt(d.impostors, 10);
      if (!(n >= 1 && n <= LIMITS.maxImpostors)) throw new GameError('Podés elegir entre 1 y 3 impostores');
      if (n > maxImpostorsFor(s.players)) throw new GameError(`Con ${s.players} jugadores podés tener hasta ${maxImpostorsFor(s.players)} impostor${maxImpostorsFor(s.players) > 1 ? 'es' : ''}: tiene que haber más jugadores normales que impostores`);
      s.impostors = n;
    }
    if (d.mode !== undefined) { if (!MODES.includes(d.mode)) throw new GameError('Modalidad inválida'); s.mode = d.mode; }
    if (d.ayudin !== undefined) s.ayudin = !!d.ayudin;
    if (d.talkSeconds !== undefined) {
      const n = parseInt(d.talkSeconds, 10);
      if (!LIMITS.talkOptions.includes(n)) throw new GameError('Tiempo inválido');
      s.talkSeconds = n;
    }
    if (d.drawSeconds !== undefined) {
      const n = parseInt(d.drawSeconds, 10);
      if (!(n >= LIMITS.drawMin && n <= LIMITS.drawMax)) throw new GameError(`El tiempo de dibujo debe ser entre ${LIMITS.drawMin} y ${LIMITS.drawMax} segundos`);
      s.drawSeconds = n;
    }
    if (d.categories !== undefined) {
      if (!Array.isArray(d.categories)) throw new GameError('Categorías inválidas');
      const valid = Object.keys(this.deps.bank.categories);
      s.categories = [...new Set(d.categories.filter(c => valid.includes(c)))];
    }
    this.settings = s;
  }

  removePlayer(t, reason) {
    if (this.phase === 'lobby') {
      this.players = this.players.filter(x => x.id !== t.id);
    } else {
      const wasActive = t.status === 'active';
      t.status = 'left';
      t.token = null;
      if (wasActive && this.game) {
        this.game.expulsions.push({ playerId: t.id, name: t.name, round: this.game.round, wasImpostor: t.role === 'impostor', reason: reason === 'kick' ? 'retirado' : 'abandono', votes: null });
        this.afterRosterChange();
      }
    }
    t.token = null;
    if (this.hostId === t.id) this.transferHost();
    if (!this.present().length) this.hostId = null;
  }

  // Ajusta turnos/votación si alguien se va en medio de la partida
  afterRosterChange() {
    const g = this.game;
    if (this.checkWinner()) { this.phase = 'end'; return; }
    if (this.phase === 'reveal' && this.active().every(x => x.seenRole)) this.toOrder();
    else if (this.phase === 'play') { const cur = this.currentTalker(); if (!cur) this.skipInactiveTalk(); }
    else if (this.phase === 'draw') { if (!this.currentDrawer()) this.commitDrawing(); }
    else if (this.phase === 'gallery') { if (this.active().every(x => x.seenGallery)) this.startVote(); }
    else if (this.phase === 'vote') {
      const ids = new Set(this.active().map(x => x.id));
      for (const [v, t] of Object.entries(g.vote.votes)) if (!ids.has(v) || !ids.has(t)) delete g.vote.votes[v];
      g.vote.candidates = g.vote.candidates.filter(c => ids.has(c));
      if (g.vote.candidates.length < 2) this.startVote(null);
      else this.maybeCloseVote();
    }
  }

  start() {
    const players = this.present();
    const n = players.length;
    if (n < LIMITS.minPlayers) throw new GameError('Se necesitan al menos 3 jugadores');
    if (n !== this.settings.players) throw new GameError(`Configuraste ${this.settings.players} jugadores y hay ${n} en la sala`);
    const imp = this.settings.impostors;
    if (imp > maxImpostorsFor(n)) throw new GameError(`Con ${n} jugadores podés tener hasta ${maxImpostorsFor(n)} impostores`);
    const secret = this.deps.bank.pick(this.settings.mode, this.settings.categories, this.usedContent, this.deps.recentGlobal());
    this.usedContent.push(secret.id);
    this.deps.addRecent(secret.id);
    const ids = shuffle(players.map(p => p.id));
    const impostorIds = new Set(ids.slice(0, imp));
    players.forEach(p => {
      p.status = 'active'; p.role = impostorIds.has(p.id) ? 'impostor' : 'normal';
      p.seenRole = false; p.hintSeen = false; p.wantVote = false; p.seenGallery = false;
    });
    this.gamesPlayed += 1;
    this.game = {
      number: this.gamesPlayed,
      mode: this.settings.mode,
      ayudin: this.settings.ayudin,
      talkSeconds: this.settings.talkSeconds,
      drawSeconds: this.settings.drawSeconds,
      secret,
      initialPlayers: n,
      impostorCount: imp,
      round: 1,
      order: shuffle(players.map(p => p.id)),
      turn: null,
      draw: null,
      drawings: [],
      vote: null,
      result: null,
      tieRounds: 0,
      voteHistory: [],
      expulsions: [],
      lastExpel: null,
      winner: null,
      startedAt: Date.now(),
    };
    this.phase = 'reveal';
  }

  toOrder() {
    const g = this.game;
    if (this.phase !== 'reveal') g.order = shuffle(this.active().map(p => p.id));
    else g.order = g.order.filter(id => this.player(id)?.status === 'active');
    this.active().forEach(p => { p.wantVote = false; p.seenGallery = false; });
    g.turn = null; g.draw = null; g.vote = null; g.result = null; g.tieRounds = 0; g.lastExpel = null;
    this.phase = 'order';
  }

  beginRound() {
    const g = this.game;
    if (g.mode === 'dibujo') {
      g.draw = { index: -1, stage: 'ready', endsAt: null, readyUntil: null, live: [], contributions: [] };
      this.phase = 'draw';
      this.nextDrawer();
    } else {
      this.phase = 'play';
      g.turn = { index: -1, lap: 0, endsAt: null };
      this.startLap();
    }
  }

  // ----- Turnos de palabras -----
  currentTalker() {
    const t = this.game?.turn;
    if (!t || t.index < 0 || t.index >= this.game.order.length) return null;
    const p = this.player(this.game.order[t.index]);
    return p && p.status === 'active' ? p : null;
  }
  startLap() { const t = this.game.turn; t.lap += 1; t.index = -1; this.advanceTalk(); }
  advanceTalk() {
    const g = this.game; const t = g.turn;
    do { t.index += 1; } while (t.index < g.order.length && this.player(g.order[t.index])?.status !== 'active');
    t.endsAt = (t.index < g.order.length && g.talkSeconds > 0) ? Date.now() + g.talkSeconds * 1000 : null;
  }
  skipInactiveTalk() { const t = this.game.turn; if (t.index < this.game.order.length) { t.index -= 1; this.advanceTalk(); } }
  wantVoteCount() { return this.active().filter(p => p.wantVote).length; }
  wantVoteNeeded() { return Math.floor(this.active().length / 2) + 1; }

  // ----- Dibujo -----
  currentDrawer() {
    const d = this.game?.draw;
    if (!d || d.index < 0 || d.index >= this.game.order.length) return null;
    const p = this.player(this.game.order[d.index]);
    return p && p.status === 'active' ? p : null;
  }
  nextDrawer() {
    const g = this.game; const d = g.draw;
    do { d.index += 1; } while (d.index < g.order.length && this.player(g.order[d.index])?.status !== 'active');
    d.live = []; d.stage = 'ready'; d.endsAt = null;
    if (d.index >= g.order.length) {
      g.drawings.push({ round: g.round, contributions: d.contributions });
      this.phase = 'gallery';
      this.active().forEach(p => { p.seenGallery = false; });
    } else {
      d.readyUntil = Date.now() + LIMITS.readyTimeout * 1000;
    }
  }
  beginDrawing() {
    const d = this.game.draw;
    d.stage = 'drawing'; d.live = []; d.endsAt = Date.now() + this.game.drawSeconds * 1000; d.readyUntil = null;
  }
  addStroke(p, data) {
    if (this.phase !== 'draw') throw new GameError('No se está dibujando', 'phase');
    const d = this.game.draw;
    if (this.currentDrawer()?.id !== p.id) throw new GameError('No es tu turno');
    if (d.stage !== 'drawing') throw new GameError('Tu turno todavía no empezó');
    if (Date.now() > d.endsAt + 700) throw new GameError('Se terminó el tiempo', 'time');
    const sid = String(data.sid || '').slice(0, 16);
    if (!sid) throw new GameError('Trazo inválido');
    let s = d.live.find(x => x.sid === sid);
    if (!s) {
      if (d.live.length >= LIMITS.maxStrokesPerTurn) throw new GameError('Llegaste al máximo de trazos');
      const color = INK.includes(data.c) ? data.c : INK[0];
      const w = Math.max(2, Math.min(28, Number(data.w) || 6));
      s = { sid, c: color, w, pts: [] };
      d.live.push(s);
    }
    const pts = Array.isArray(data.pts) ? data.pts : [];
    const clean = [];
    for (const pt of pts) {
      if (!Array.isArray(pt) || pt.length < 2) continue;
      const x = Number(pt[0]); const y = Number(pt[1]);
      if (!Number.isFinite(x) || !Number.isFinite(y)) continue;
      clean.push([Math.round(Math.max(0, Math.min(1, x)) * 1000) / 1000, Math.round(Math.max(0, Math.min(1, y)) * 1000) / 1000]);
      if (s.pts.length + clean.length >= LIMITS.maxPointsPerStroke) break;
    }
    s.pts.push(...clean);
    return { event: { type: 'stroke', turn: d.index, playerId: p.id, sid, c: s.c, w: s.w, pts: clean }, except: p.id };
  }
  commitDrawing() {
    const d = this.game.draw;
    const drawerId = this.game.order[d.index];
    if (drawerId && d.index < this.game.order.length) {
      const strokes = d.live.filter(s => s.pts.length > 0);
      d.contributions.push({ playerId: drawerId, strokes, empty: strokes.length === 0 });
    }
    this.nextDrawer();
  }

  // ----- Votación -----
  startVote(candidates) {
    const g = this.game;
    const activeIds = this.active().map(p => p.id);
    g.vote = { candidates: candidates && candidates.length >= 2 ? candidates : activeIds, votes: {}, runoff: !!(candidates && candidates.length >= 2) };
    if (!g.vote.runoff) g.tieRounds = 0;
    g.result = null;
    this.phase = 'vote';
  }
  castVote(p, target) {
    const v = this.game.vote;
    if (v.votes[p.id]) throw new GameError('Ya votaste. El voto no se puede cambiar.', 'voted');
    if (target === p.id) throw new GameError('No podés votarte a vos mismo');
    if (!v.candidates.includes(target)) throw new GameError('Ese jugador no se puede votar');
    if (this.player(target)?.status !== 'active') throw new GameError('Ese jugador ya no está activo');
    v.votes[p.id] = target;
    this.maybeCloseVote();
  }
  maybeCloseVote() {
    const g = this.game; const v = g.vote;
    const voters = this.active();
    if (!voters.every(x => v.votes[x.id])) return;
    const tally = {};
    v.candidates.forEach(c => { tally[c] = 0; });
    Object.values(v.votes).forEach(t => { if (t in tally) tally[t] += 1; });
    const max = Math.max(...Object.values(tally));
    const tied = Object.keys(tally).filter(k => tally[k] === max);
    const rows = Object.entries(tally).map(([id, votes]) => ({ playerId: id, name: this.player(id)?.name, votes })).sort((a, b) => b.votes - a.votes);
    const tie = tied.length > 1;
    if (tie) g.tieRounds += 1;
    g.result = { tally: rows, tie, tied: tie ? tied : [], expelledId: tie ? null : tied[0], runoff: v.runoff, totalVotes: Object.keys(v.votes).length };
    g.voteHistory.push({ round: g.round, runoff: v.runoff, tie, tally: rows.map(r => ({ name: r.name, votes: r.votes })) });
    // Los votos individuales se descartan: solo queda el conteo.
    g.vote = { candidates: v.candidates, votes: {}, closed: true, runoff: v.runoff };
    this.phase = 'results';
  }
  resolveResults() {
    const r = this.game.result;
    if (r.tie) {
      const still = r.tied.filter(id => this.player(id)?.status === 'active');
      this.startVote(still.length >= 2 ? still : null); return;
    }
    if (this.player(r.expelledId)?.status !== 'active') { this.startVote(null); return; }
    this.expel(r.expelledId, 'votos');
  }
  expel(id, how) {
    const g = this.game; const p = this.player(id);
    if (!p) throw new GameError('Jugador inválido');
    p.status = 'expelled';
    const votes = g.result?.tally.find(r => r.playerId === id)?.votes ?? null;
    const rec = { playerId: id, name: p.name, round: g.round, wasImpostor: p.role === 'impostor', reason: how, votes };
    g.expulsions.push(rec);
    g.lastExpel = rec;
    this.checkWinner();
    this.phase = 'expel';
  }
  checkWinner() {
    const g = this.game; if (!g) return null;
    const act = this.active();
    const imp = act.filter(p => p.role === 'impostor').length;
    const norm = act.length - imp;
    if (imp === 0) g.winner = 'normales';
    else if (imp >= norm) g.winner = 'impostores';
    else g.winner = null;
    if (g.winner && !g.endedAt) g.endedAt = Date.now();
    return g.winner;
  }

  toLobby() {
    this.players = this.players.filter(p => p.status !== 'left');
    this.players.forEach(p => { p.status = 'lobby'; p.role = null; p.seenRole = false; p.hintSeen = false; p.wantVote = false; p.seenGallery = false; });
    this.settings.players = Math.max(LIMITS.minPlayers, this.players.length);
    if (this.settings.impostors > maxImpostorsFor(this.settings.players)) this.settings.impostors = maxImpostorsFor(this.settings.players);
    this.game = null;
    this.phase = 'lobby';
  }

  // ----- Reloj del servidor -----
  tick(now = Date.now()) {
    let changed = false;
    const host = this.player(this.hostId);
    if (host && host.connected === 0 && this.present().some(p => p.id !== host.id && p.connected > 0)) {
      if (!this.hostAwaySince) this.hostAwaySince = now;
      else if (now - this.hostAwaySince > 30000) { this.transferHost(); this.hostAwaySince = null; changed = true; }
    } else this.hostAwaySince = null;
    const g = this.game;
    if (!g) return changed;
    if (this.phase === 'play' && g.turn?.endsAt && now >= g.turn.endsAt) { this.advanceTalk(); changed = true; }
    if (this.phase === 'draw' && g.draw) {
      const d = g.draw;
      if (d.stage === 'drawing' && now >= d.endsAt + 700) { this.commitDrawing(); changed = true; }
      else if (d.stage === 'ready' && d.readyUntil && now >= d.readyUntil) { this.beginDrawing(); changed = true; }
    }
    if (changed) this.touch();
    return changed;
  }

  // ---------- Vista personalizada ----------
  viewFor(viewerId) {
    const me = this.player(viewerId);
    const g = this.game;
    const ended = this.phase === 'end';
    const v = {
      code: this.code,
      phase: this.phase,
      now: Date.now(),
      hostId: this.hostId,
      settings: this.settings,
      limits: { ...LIMITS, maxImpostors: maxImpostorsFor(this.settings.players) },
      ink: INK,
      players: this.players.filter(p => p.status !== 'left' || (g && g.order.includes(p.id))).map(p => ({
        id: p.id, name: p.name, color: p.color, status: p.status, connected: p.connected > 0,
        isHost: p.id === this.hostId,
        seenRole: this.phase === 'reveal' ? p.seenRole : undefined,
        voted: this.phase === 'vote' ? !!g.vote.votes[p.id] : undefined,
        wantVote: this.phase === 'play' ? p.wantVote : undefined,
        seenGallery: this.phase === 'gallery' ? p.seenGallery : undefined,
        role: ended ? p.role : undefined,
      })),
      me: null,
      game: null,
    };
    if (this.phase === 'lobby') v.categories = this.deps.bank.categoryList().map(c => ({ id: c.id, name: c.name }));
    if (me) {
      v.me = { id: me.id, name: me.name, color: me.color, status: me.status, isHost: me.id === this.hostId, seenRole: me.seenRole };
      if (g && me.role) {
        v.me.role = me.role;
        if (me.role === 'normal') {
          v.me.secret = g.secret.text;
        } else if (g.ayudin && !me.hintSeen) {
          v.me.hint = g.mode === 'dibujo' ? g.secret.drawHint : g.secret.hint;
        }
        v.me.ayudin = g.ayudin;
        v.me.hintSeen = me.hintSeen;
      }
    }
    if (g) {
      const act = this.active();
      const impLeft = act.filter(p => p.role === 'impostor').length;
      v.game = {
        number: g.number, mode: g.mode, round: g.round, order: g.order,
        talkSeconds: g.talkSeconds, drawSeconds: g.drawSeconds,
        initialPlayers: g.initialPlayers, impostorCount: g.impostorCount,
        activeCount: act.length, impostorsLeft: impLeft,
        expulsions: g.expulsions,
        category: g.secret.category, // la categoría es pública solo al final (ver abajo)
      };
      if (!ended) delete v.game.category;
      if (this.phase === 'play' && g.turn) {
        const cur = this.currentTalker();
        v.game.turn = { index: g.turn.index, lap: g.turn.lap, endsAt: g.turn.endsAt, playerId: cur ? cur.id : null, done: !cur };
        v.game.wantVote = { count: this.wantVoteCount(), needed: this.wantVoteNeeded() };
      }
      if ((this.phase === 'draw' || this.phase === 'gallery') && g.draw) {
        const d = g.draw; const cur = this.currentDrawer();
        v.game.draw = {
          index: d.index, stage: d.stage, endsAt: d.endsAt, readyUntil: d.readyUntil,
          drawerId: cur ? cur.id : null, live: d.live, contributions: d.contributions,
        };
      }
      if (this.phase === 'vote') {
        const vt = g.vote;
        v.game.vote = {
          candidates: vt.candidates, runoff: vt.runoff,
          votedCount: Object.keys(vt.votes).length, total: act.length,
          myVote: me ? vt.votes[me.id] || null : null, // solo tu propio voto
        };
      }
      if (g.mode === 'dibujo' && (this.phase === 'vote' || this.phase === 'results')) {
        const last = g.drawings[g.drawings.length - 1];
        if (last && last.round === g.round) v.game.drawing = last;
      }
      if (this.phase === 'results') v.game.result = { ...g.result, canRandom: g.result.tie && g.tieRounds >= 2, tieRounds: g.tieRounds };
      if (this.phase === 'expel' || ended) v.game.lastExpel = g.lastExpel;
      if (g.winner && (this.phase === 'expel' || ended)) v.game.winner = g.winner;
      if (ended) {
        v.game.winner = g.winner;
        v.game.secret = g.secret.text;
        v.game.hint = g.secret.hint;
        v.game.impostors = this.players.filter(p => p.role === 'impostor').map(p => ({ id: p.id, name: p.name, status: p.status }));
        v.game.voteHistory = g.voteHistory;
        v.game.drawings = g.drawings;
        v.game.rounds = g.round;
      }
    }
    return v;
  }
}

module.exports = { Room, GameError, LIMITS, MODES, maxImpostorsFor, cleanName, shuffle };
