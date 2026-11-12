/* MALDITO IMPOSTOR — cliente (PWA). Creado por Patricio.
   El cliente solo muestra lo que el servidor le envía a ESTE jugador. */
(() => {
  'use strict';

  // ---------------------------------------------------------------- utilidades
  const $app = document.getElementById('app');
  const $sheetRoot = document.getElementById('sheet-root');
  const $toast = document.getElementById('toast');
  const $net = document.getElementById('net');
  const LS_SESSION = 'mi_session_v1';
  const LS_NAME = 'mi_name';

  const S = {
    session: readJSON(LS_SESSION),
    state: null,
    es: null,
    offset: 0,
    key: '',
    ui: { home: 'home', revealOpen: {}, expelAt: {}, voteSel: null, color: '#111111', width: 6, highlight: null, cats: false },
    board: null,
    lastTurnMine: '',
  };

  function readJSON(k) { try { return JSON.parse(localStorage.getItem(k) || 'null'); } catch { return null; } }
  function writeJSON(k, v) { try { if (v == null) localStorage.removeItem(k); else localStorage.setItem(k, JSON.stringify(v)); } catch { /* */ } }
  const now = () => Date.now() + S.offset;

  function h(tag, attrs, ...kids) {
    const el = document.createElement(tag);
    if (attrs) {
      for (const [k, v] of Object.entries(attrs)) {
        if (v == null || v === false) continue;
        if (k === 'class') el.className = v;
        else if (k === 'style' && typeof v === 'object') Object.assign(el.style, v);
        else if (k.startsWith('on')) el.addEventListener(k.slice(2), v);
        else if (k === 'text') el.textContent = v;
        else el.setAttribute(k, v === true ? '' : v);
      }
    }
    for (const c of kids.flat(Infinity)) {
      if (c == null || c === false) continue;
      el.append(c instanceof Node ? c : document.createTextNode(String(c)));
    }
    return el;
  }
  let toastT;
  function toast(msg, ms = 2600) {
    $toast.textContent = msg; $toast.classList.add('show');
    clearTimeout(toastT); toastT = setTimeout(() => $toast.classList.remove('show'), ms);
  }
  function vibrate(p) { try { navigator.vibrate && navigator.vibrate(p); } catch { /* */ } }
  const initials = n => (n || '?').trim().charAt(0).toLocaleUpperCase('es');
  const avatar = (p, cls = 'av') => h('div', { class: cls, style: { background: p ? p.color : '#888' } }, initials(p && p.name));
  const plural = (n, s, p) => `${n} ${n === 1 ? s : (p || s + 's')}`;

  async function api(path, body) {
    const r = await fetch(path, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body || {}) });
    let j = {};
    try { j = await r.json(); } catch { /* */ }
    if (!r.ok) { const e = new Error(j.error || 'Error de conexión'); e.code = j.code; e.status = r.status; throw e; }
    return j;
  }
  let actBusy = false;
  async function act(type, data, { quiet = false } = {}) {
    if (!S.session) return false;
    try {
      await api('/api/action', { code: S.session.code, token: S.session.token, type, data: data || {} });
      return true;
    } catch (e) {
      if (e.code === 'gone') { leaveLocal('Tu sesión en esa sala terminó'); return false; }
      if (!quiet) toast(e.message);
      return false;
    }
  }
  async function guarded(btn, fn) {
    if (actBusy) return;
    actBusy = true; if (btn) btn.disabled = true;
    try { await fn(); } finally { actBusy = false; if (btn && btn.isConnected) btn.disabled = false; }
  }

  // ---------------------------------------------------------------- conexión
  function connect() {
    if (S.es) S.es.close();
    const { code, token } = S.session;
    const es = new EventSource(`/api/stream?code=${encodeURIComponent(code)}&token=${encodeURIComponent(token)}`);
    S.es = es;
    let opened = false;
    es.addEventListener('open', () => { opened = true; $net.classList.add('hidden'); });
    es.addEventListener('state', ev => {
      const st = JSON.parse(ev.data);
      S.offset = st.now - Date.now();
      S.state = st;
      $net.classList.add('hidden');
      render();
    });
    es.addEventListener('stroke', ev => { if (S.board) S.board.remote(JSON.parse(ev.data)); });
    es.addEventListener('kicked', ev => { const d = JSON.parse(ev.data); es.close(); leaveLocal(d.reason); });
    es.addEventListener('error', () => {
      if (S.es !== es) return;
      $net.classList.remove('hidden');
      if (es.readyState === 2) {
        // El navegador no reintenta (p. ej. 404): verificamos si la sesión sigue existiendo
        api('/api/resume', S.session).then(() => setTimeout(() => S.session && connect(), 1200))
          .catch(e => { if (e.code === 'gone') leaveLocal('La sala ya no existe'); else setTimeout(() => S.session && connect(), 2500); });
      }
      if (!opened) { /* reintento automático del navegador */ }
    });
  }
  function enterRoom(session) {
    S.session = session;
    writeJSON(LS_SESSION, session);
    history.replaceState(null, '', '/' + session.code);
    connect();
    requestWakeLock();
  }
  function leaveLocal(msg) {
    if (S.es) S.es.close();
    S.es = null; S.state = null; S.session = null; S.board = null; S.key = '';
    writeJSON(LS_SESSION, null);
    history.replaceState(null, '', '/');
    S.ui.home = 'home';
    closeSheet();
    $net.classList.add('hidden');
    render();
    if (msg) toast(msg);
  }

  // Mantener la pantalla encendida durante la partida
  let wakeLock = null;
  async function requestWakeLock() {
    try { if ('wakeLock' in navigator && !wakeLock && document.visibilityState === 'visible') { wakeLock = await navigator.wakeLock.request('screen'); wakeLock.addEventListener('release', () => { wakeLock = null; }); } } catch { /* */ }
  }
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'visible' && S.session) {
      requestWakeLock();
      if (!S.es || S.es.readyState === 2) connect();
    }
  });

  // ---------------------------------------------------------------- render
  function screenKey(st) {
    const g = st.game || {};
    const parts = [st.phase, g.number, g.round];
    if (st.phase === 'play') parts.push(g.turn && g.turn.lap, g.turn && g.turn.index);
    if (st.phase === 'draw') parts.push(g.draw && g.draw.index, g.draw && g.draw.stage);
    if (st.phase === 'vote') parts.push(g.vote && g.vote.runoff, g.vote && g.vote.candidates.join(','));
    if (st.phase === 'results') parts.push(g.result && g.result.tally.map(t => t.votes).join(','));
    if (st.phase === 'expel') parts.push(g.lastExpel && g.lastExpel.playerId);
    return parts.join('|');
  }

  function render() {
    const st = S.state;
    let el;
    var same = false;
    if (!S.session || !st) {
      S.key = '';
      el = S.session ? loadingScreen() : homeScreen();
    } else {
      const key = screenKey(st);
      var same = key === S.key;
      if (key !== S.key) { S.ui.voteSel = null; onScreenChange(st, key); }
      S.key = key;
      el = ({
        lobby: lobbyScreen, reveal: revealScreen, order: orderScreen, play: playScreen,
        draw: drawScreen, gallery: galleryScreen, vote: voteScreen, results: resultsScreen,
        expel: expelScreen, end: endScreen,
      }[st.phase] || loadingScreen)(st);
    }
    const y = window.scrollY;
    if (same) el.classList.add('static-screen');
    $app.replaceChildren(el);
    window.scrollTo(0, same ? y : 0);
    tick();
  }

  function onScreenChange(st, key) {
    const me = st.me || {};
    const g = st.game || {};
    let mine = false;
    if (st.phase === 'play' && g.turn && g.turn.playerId === me.id) mine = true;
    if (st.phase === 'draw' && g.draw && g.draw.drawerId === me.id && g.draw.stage === 'ready') mine = true;
    if (mine && S.lastTurnMine !== key) { S.lastTurnMine = key; vibrate([120, 60, 120]); }
    if (st.phase === 'vote') vibrate(60);
  }

  function loadingScreen() {
    return h('section', { class: 'screen' }, h('div', { class: 'spacer' }), h('p', { class: 'center muted' }, 'Conectando con la sala…'), h('div', { class: 'spacer' }));
  }

  function topbar(st, extra) {
    return h('div', { class: 'topbar' },
      h('div', { class: 'brand-mini' }, 'Maldito ', h('b', null, 'Impostor')),
      extra || null,
      st && st.game && st.me && st.me.role && st.phase !== 'end' ? h('button', { class: 'icon-btn role-btn', 'aria-label': 'Ver mi rol', onclick: myRoleSheet }, '👁 Rol') : null,
      st ? h('button', { class: 'icon-btn', 'aria-label': 'Menú', onclick: () => menuSheet() }, '⋯') : null);
  }
  const playerById = (st, id) => st.players.find(p => p.id === id);
  const isHost = st => st.me && st.me.isHost;
  const isActive = st => st.me && st.me.status === 'active';

  // ---------------------------------------------------------------- inicio
  function logo() {
    return h('div', { class: 'logo' },
      eyeSvg(),
      h('span', { class: 'l1' }, 'Maldito'),
      h('span', { class: 'l2', 'data-t': 'Impostor' }, 'Impostor'));
  }
  function eyeSvg() {
    const ns = 'http://www.w3.org/2000/svg';
    const svg = document.createElementNS(ns, 'svg');
    svg.setAttribute('viewBox', '0 0 100 100'); svg.setAttribute('class', 'eye'); svg.setAttribute('aria-hidden', 'true');
    svg.innerHTML = '<path d="M6 50 Q50 8 94 50 Q50 92 6 50Z" fill="#1a0610" stroke="#ff2d55" stroke-width="5"/><circle cx="50" cy="50" r="17" fill="#ff2d55"/><circle cx="50" cy="50" r="7" fill="#0a0710"/><circle cx="56" cy="44" r="3.5" fill="#fff"/>';
    return svg;
  }

  function homeScreen() {
    const v = S.ui.home;
    const savedName = localStorage.getItem(LS_NAME) || '';
    const urlCode = (location.pathname.match(/^\/([A-Za-z]{4})$/) || [])[1];
    if (urlCode && v === 'home' && !S.ui.urlHandled) { S.ui.urlHandled = true; S.ui.home = 'join'; S.ui.joinCode = urlCode.toUpperCase(); return homeScreen(); }

    if (v === 'home') {
      return h('section', { class: 'screen' },
        h('div', { class: 'spacer' }),
        logo(),
        h('p', { class: 'tagline' }, '¿Quién está ', h('em', null, 'mintiendo'), '?'),
        h('p', { class: 'author' }, 'Creado por Patricio'),
        h('div', { class: 'spacer' }),
        h('div', { class: 'stack' },
          h('button', { class: 'btn primary', onclick: () => { S.ui.home = 'create'; render(); } }, 'Crear partida'),
          h('button', { class: 'btn', onclick: () => { S.ui.home = 'join'; render(); } }, 'Unirse a partida'),
          h('button', { class: 'link', onclick: howToSheet }, '¿Cómo se juega?')));
    }
    const isJoin = v === 'join';
    const name = h('input', { class: 'input', maxlength: 16, placeholder: 'Tu nombre o apodo', autocomplete: 'nickname', value: savedName, enterkeyhint: isJoin ? 'next' : 'go' });
    const code = isJoin ? h('input', { class: 'input code', maxlength: 4, placeholder: 'ABCD', autocapitalize: 'characters', autocomplete: 'off', inputmode: 'text', value: S.ui.joinCode || '', enterkeyhint: 'go' }) : null;
    if (code) code.addEventListener('input', () => { code.value = code.value.toUpperCase().replace(/[^A-Z]/g, '').slice(0, 4); });
    const go = h('button', { class: 'btn primary' }, isJoin ? 'Entrar a la sala' : 'Crear sala');
    const submit = () => guarded(go, async () => {
      const nm = name.value.trim();
      if (!nm) { toast('Escribí tu nombre'); name.focus(); return; }
      localStorage.setItem(LS_NAME, nm);
      try {
        const r = isJoin ? await api('/api/join', { code: code.value, name: nm }) : await api('/api/create', { name: nm });
        enterRoom({ code: r.code, token: r.token, playerId: r.playerId });
        render();
      } catch (e) { toast(e.message); }
    });
    go.addEventListener('click', submit);
    [name, code].forEach(i => i && i.addEventListener('keydown', e => { if (e.key === 'Enter') { if (i === name && code && !code.value) code.focus(); else submit(); } }));
    setTimeout(() => (isJoin && savedName && !code.value ? code : name).focus(), 60);
    return h('section', { class: 'screen' },
      h('div', { class: 'topbar' }, h('button', { class: 'icon-btn', 'aria-label': 'Volver', onclick: () => { S.ui.home = 'home'; render(); } }, '←'), h('div', { class: 'brand-mini' }, 'Maldito ', h('b', null, 'Impostor')), h('div', { style: { width: '42px' } })),
      h('h1', { class: 'title' }, isJoin ? 'Unirse a una ' : 'Crear una ', h('b', null, 'partida')),
      h('p', { class: 'note' }, isJoin ? 'Pedile el código de 4 letras a quien creó la sala.' : 'Vas a ser el anfitrión: configurás la partida y compartís el código con el grupo.'),
      h('div', { class: 'field' }, h('label', { class: 'label' }, 'Tu nombre'), name),
      code ? h('div', { class: 'field' }, h('label', { class: 'label' }, 'Código de sala'), code) : null,
      h('div', { class: 'spacer' }),
      go);
  }

  function howToSheet() {
    openSheet(h('div', { class: 'stack' },
      h('h2', null, '¿Cómo se juega?'),
      h('p', { class: 'note' }, 'Se juega en persona, cada uno con su celular. La app reparte en secreto una frase o palabra a todos… menos a los impostores.'),
      h('p', { class: 'note' }, h('b', null, '💬 Frases y 🔤 Palabras: '), 'por turnos, cada uno dice en voz alta una palabra relacionada. Los impostores escuchan e improvisan para no ser descubiertos.'),
      h('p', { class: 'note' }, h('b', null, '🎨 Dibujo colectivo: '), 'entre todos hacen un único dibujo. Cada uno agrega una pequeña parte en pocos segundos. El impostor también dibuja… sin saber qué.'),
      h('p', { class: 'note' }, h('b', null, '🗳️ Votación secreta: '), 'cada uno vota desde su celular. El más votado queda expulsado y se revela si era impostor.'),
      h('p', { class: 'note' }, 'Ganan los jugadores si expulsan a todos los impostores. Ganan los impostores si llegan a ser tantos como los jugadores normales.'),
      h('button', { class: 'btn', onclick: closeSheet }, 'Entendido')));
  }

  // ---------------------------------------------------------------- sala de espera + configuración
  const MODES = {
    frases: { ic: '💬', name: 'Frases', desc: 'Una situación de la vida cotidiana' },
    palabras: { ic: '🔤', name: 'Palabras', desc: 'El clásico: una palabra secreta' },
    dibujo: { ic: '🎨', name: 'Dibujo colectivo', desc: 'Un dibujo entre todos, de a poquito' },
  };

  function shareRoom(code) {
    const url = `${location.origin}/${code}`;
    const text = `¡Vení a jugar a MALDITO IMPOSTOR! Código de sala: ${code}`;
    if (navigator.share) navigator.share({ title: 'MALDITO IMPOSTOR', text, url }).catch(() => {});
    else if (navigator.clipboard) navigator.clipboard.writeText(`${text} — ${url}`).then(() => toast('Link copiado'), () => toast(url, 5000));
    else toast(url, 6000);
  }

  function lobbyScreen(st) {
    const host = isHost(st);
    const s = st.settings;
    const present = st.players.filter(p => p.status !== 'left');
    const missing = s.players - present.length;
    const list = h('div', { class: 'players' }, present.map(p => h('div', { class: 'pl' + (p.id === st.me.id ? ' me' : '') },
      avatar(p), h('div', { class: 'nm' }, p.name, p.id === st.me.id ? h('span', { class: 'tag' }, '  (vos)') : null),
      p.isHost ? h('span', { class: 'tag' }, '👑 Anfitrión') : null,
      h('span', { class: 'dot' + (p.connected ? ' on' : ''), title: p.connected ? 'Conectado' : 'Desconectado' }),
      host && p.id !== st.me.id ? h('button', { class: 'x', 'aria-label': 'Sacar a ' + p.name, onclick: () => { if (confirm(`¿Sacar a ${p.name} de la sala?`)) act('kick', { playerId: p.id }); } }, '✕') : null)));
    for (let i = 0; i < Math.max(0, missing); i++) list.append(h('div', { class: 'pl out', style: { borderStyle: 'dashed' } }, h('div', { class: 'av', style: { background: '#2a2233', color: '#776' } }, '?'), h('div', { class: 'nm muted', style: { textDecoration: 'none' } }, 'Esperando jugador…')));

    let startBtn = null;
    if (host) {
      const disconnected = present.filter(p => !p.connected).length;
      const reason = missing > 0 ? `Faltan ${plural(missing, 'jugador', 'jugadores')}` : null;
      startBtn = h('button', { class: 'btn primary', disabled: !!reason, onclick: e => guarded(e.currentTarget, () => act('start')) },
        h('span', null, reason ? reason : '¡Empezar partida!', reason ? null : h('span', { class: 'sub' }, `${MODES[s.mode].name} · ${plural(s.impostors, 'impostor', 'impostores')}${disconnected ? ` · ⚠ ${disconnected} desconectado${disconnected > 1 ? 's' : ''}` : ''}`)));
    }
    return h('section', { class: 'screen' },
      topbar(st),
      h('div', { class: 'roomcode', onclick: () => shareRoom(st.code), role: 'button' },
        h('div', { class: 'label' }, 'Código de sala'),
        h('div', { class: 'c' }, st.code),
        h('div', { class: 'note' }, 'Tocá para compartir el link')),
      h('div', { class: 'card' }, h('h3', null, `Jugadores ${present.length}/${s.players}`), list),
      host ? configCard(st) : summaryCard(st),
      host ? startBtn : h('p', { class: 'center muted' }, missing > 0 ? `Esperando ${plural(missing, 'jugador más', 'jugadores más')}…` : 'Esperando a que el anfitrión empiece la partida…'));
  }

  function summaryCard(st) {
    const s = st.settings;
    return h('div', { class: 'card' }, h('h3', null, 'Configuración'),
      h('div', { class: 'summary' },
        h('div', null, h('span', null, 'Modalidad'), h('b', null, `${MODES[s.mode].ic} ${MODES[s.mode].name}`)),
        h('div', null, h('span', null, 'Impostores'), h('b', null, s.impostors)),
        h('div', null, h('span', null, 'Ayudín'), h('b', null, s.ayudin ? 'Con ayudín' : 'Sin ayudín')),
        h('div', null, h('span', null, 'Tiempo'), h('b', null, s.mode === 'dibujo' ? `${s.drawSeconds} s por trazo` : (s.talkSeconds ? `${s.talkSeconds} s por turno` : 'Sin límite')))));
  }

  function configCard(st) {
    const s = st.settings;
    const L = st.limits;
    const set = d => act('settings', d);
    const present = st.players.filter(p => p.status !== 'left').length;
    const stepper = (val, min, max, on, fmt) => h('div', { class: 'stepper' },
      h('button', { 'aria-label': 'Menos', disabled: val <= min, onclick: () => on(val - 1) }, '−'),
      h('div', { class: 'v' }, fmt ? fmt(val) : val),
      h('button', { 'aria-label': 'Más', disabled: val >= max, onclick: () => on(val + 1) }, '+'));
    const seg = (opts, val, on) => h('div', { class: 'seg' }, opts.map(o => h('button', { class: o.v === val ? 'on' : '', disabled: o.disabled, onclick: () => on(o.v) }, o.t)));
    const allCats = !s.categories.length;
    return h('div', { class: 'card cfg' },
      h('h3', null, 'Configurar partida'),
      h('div', { class: 'cfg-row' }, h('div', { class: 'label' }, 'Cantidad de jugadores'),
        stepper(s.players, Math.max(3, present), L.maxPlayers, v => set({ players: v }))),
      h('div', { class: 'cfg-row' }, h('div', { class: 'label' }, 'Impostores ', h('small', null, `(máx. ${L.maxImpostors} con ${s.players} jugadores)`)),
        seg([1, 2, 3].map(n => ({ v: n, t: String(n), disabled: n > L.maxImpostors })), s.impostors, v => set({ impostors: v }))),
      h('div', { class: 'cfg-row' }, h('div', { class: 'label' }, 'Modalidad'),
        h('div', { class: 'modes' }, Object.entries(MODES).map(([k, m]) => h('button', { class: 'mode' + (s.mode === k ? ' on' : ''), onclick: () => set({ mode: k }) },
          h('div', { class: 'ic' }, m.ic), h('div', null, h('b', null, m.name), h('span', null, m.desc)))))),
      h('div', { class: 'cfg-row' }, h('div', { class: 'label' }, 'Ayudín para impostores'),
        seg([{ v: true, t: 'Con ayudín' }, { v: false, t: 'Sin ayudín' }], s.ayudin, v => set({ ayudin: v })),
        h('div', { class: 'note' }, s.ayudin ? (s.mode === 'dibujo' ? 'El impostor ve una pista muy general, una sola vez.' : 'El impostor ve una palabra relacionada, una sola vez.') : 'Los impostores no reciben ninguna pista.')),
      s.mode === 'dibujo'
        ? h('div', { class: 'cfg-row' }, h('div', { class: 'label' }, 'Tiempo por intervención'), stepper(s.drawSeconds, L.drawMin, L.drawMax, v => set({ drawSeconds: v }), v => v + ' s'))
        : h('div', { class: 'cfg-row' }, h('div', { class: 'label' }, 'Tiempo por turno'),
          seg([{ v: 0, t: 'Libre' }, { v: 15, t: '15 s' }, { v: 30, t: '30 s' }, { v: 60, t: '60 s' }], s.talkSeconds, v => set({ talkSeconds: v }))),
      h('div', { class: 'cfg-row' },
        h('div', { class: 'label' }, 'Categorías ', h('small', null, allCats ? '(todas)' : `(${s.categories.length})`)),
        S.ui.cats || !allCats
          ? h('div', { class: 'chips' },
            h('button', { class: 'chip' + (allCats ? ' on' : ''), onclick: () => set({ categories: [] }) }, 'Todas'),
            (st.categories || []).map(c => h('button', {
              class: 'chip' + (s.categories.includes(c.id) ? ' on' : ''),
              onclick: () => set({ categories: s.categories.includes(c.id) ? s.categories.filter(x => x !== c.id) : [...s.categories, c.id] }),
            }, c.name)))
          : h('button', { class: 'btn small ghost', onclick: () => { S.ui.cats = true; render(); } }, 'Elegir categorías')));
  }

  // ---------------------------------------------------------------- revelación
  function roleFace(st, { withHint }) {
    const me = st.me; const g = st.game;
    const imp = me.role === 'impostor';
    const what = g.mode === 'frases' ? 'frase' : 'palabra';
    if (!imp) {
      return [h('div', { class: 'role-name' }, 'Sos jugador'), h('div', { class: 'label' }, `La ${what} secreta es`),
        h('div', { class: 'secret' }, me.secret),
        h('div', { class: 'note' }, g.mode === 'dibujo' ? 'Cuando sea tu turno, dibujá una pequeña parte. Sin letras.' : 'Cuando sea tu turno, decí una palabra relacionada… ¡sin regalarla!')];
    }
    return [h('div', { class: 'role-name', style: { color: '#ffb3c1' } }, 'Tu rol'),
      h('div', { class: 'imp-title' }, 'Sos el', h('br'), 'impostor'),
      h('div', { class: 'note', style: { color: '#ffd5dd' } }, `No conocés la ${what}. Escuchá, deducí y disimulá.`),
      g.impostorCount > 1 ? h('div', { class: 'note', style: { color: '#ffd5dd' } }, `Hay ${g.impostorCount} impostores en esta partida.`) : null,
      withHint && me.hint ? h('div', { class: 'hint-box' }, h('div', { class: 'label' }, '🔑 Ayudín'), h('div', { class: 'hv' }, me.hint), h('div', { class: 'warn', style: { marginTop: '6px' } }, 'Solo lo vas a ver esta vez')) : null];
  }

  function revealScreen(st) {
    const me = st.me; const g = st.game;
    const act2 = st.players.filter(p => p.status === 'active');
    const seen = act2.filter(p => p.seenRole).length;
    if (me.seenRole || me.status !== 'active') {
      return h('section', { class: 'screen' },
        topbar(st),
        h('h1', { class: 'title' }, 'Esperando a ', h('b', null, 'todos')),
        h('p', { class: 'note' }, 'Cada jugador está viendo su rol en su celular. No mires pantallas ajenas.'),
        h('div', { class: 'progress' }, h('i', { style: { width: (100 * seen / act2.length) + '%' } })),
        h('div', { class: 'players' }, act2.map(p => h('div', { class: 'pl' }, avatar(p), h('div', { class: 'nm' }, p.name), h('span', { class: 'tag' }, p.seenRole ? '✅ Listo' : '👀 Mirando…')))),
        h('div', { class: 'spacer' }),
        isHost(st) ? h('button', { class: 'btn small ghost', onclick: () => { if (confirm('¿Continuar aunque falte gente? Podrán ver su rol desde el menú.')) act('forceReveal'); } }, 'Continuar sin esperar') : null);
    }
    const open = !!S.ui.revealOpen[g.number];
    const card = h('div', { class: 'reveal-card' + (open ? ' open' : ''), role: 'button', 'aria-label': 'Revelar mi rol' },
      h('div', { class: 'reveal-inner' },
        h('div', { class: 'face front' }, h('div', { class: 'q keep-anim' }, '?'), h('div', { class: 'big' }, 'Tocá para ver tu rol'), h('div', { class: 'note' }, 'Asegurate de que nadie esté mirando tu pantalla')),
        h('div', { class: 'face back' + (me.role === 'impostor' ? ' imp' : '') }, roleFace(st, { withHint: true }))));
    card.addEventListener('click', () => {
      if (S.ui.revealOpen[g.number]) return;
      S.ui.revealOpen[g.number] = true; card.classList.add('open'); vibrate(me.role === 'impostor' ? [80, 50, 200] : 40);
      setTimeout(() => { btn.disabled = false; }, 900);
    });
    const btn = h('button', { class: 'btn primary', disabled: !open, onclick: e => guarded(e.currentTarget, () => act('confirmRole')) }, me.hint ? 'Ya memoricé mi ayudín' : 'Listo, ya lo vi');
    return h('section', { class: 'screen' },
      topbar(st, h('span', { class: 'pill' }, `Partida ${g.number}`)),
      card, btn);
  }

  function myRoleSheet() {
    const st = S.state;
    if (!st || !st.game || !st.me.role) return;
    const imp = st.me.role === 'impostor';
    openSheet(h('div', { class: 'stack center' },
      h('div', { class: 'card', style: imp ? { background: 'radial-gradient(circle at 50% 30%, #5a0016, #1a0008 80%)', borderColor: 'rgba(255,45,85,.6)' } : null },
        h('div', { class: 'stack' }, roleFace(st, { withHint: false }))),
      imp && st.me.ayudin ? h('p', { class: 'note' }, 'El ayudín ya no se puede volver a consultar.') : null,
      h('button', { class: 'btn', onclick: closeSheet }, 'Ocultar')));
  }
  const myRoleBtn = () => null; // el acceso a "Mi rol" está en la barra superior

  // ---------------------------------------------------------------- orden
  function orderList(st, order, { cur = -1, doneUpTo = -1 } = {}) {
    return h('div', { class: 'order' }, order.map((id, i) => {
      const p = playerById(st, id);
      const out = !p || p.status !== 'active';
      const cls = 'pl' + (i === cur ? ' cur' : '') + (i <= doneUpTo && i !== cur ? ' done' : '') + (out ? ' out' : '') + (p && p.id === st.me.id ? ' me' : '');
      return h('div', { class: cls },
        h('div', { class: 'num' }, i <= doneUpTo && i !== cur ? '✓' : i + 1),
        avatar(p), h('div', { class: 'nm' }, p ? p.name : '—', p && p.id === st.me.id ? h('span', { class: 'tag' }, '  (vos)') : null),
        i === cur ? h('span', { class: 'tag', style: { color: '#fff' } }, 'AHORA') : null);
    }));
  }

  function orderScreen(st) {
    const g = st.game;
    const first = playerById(st, g.order[0]);
    return h('section', { class: 'screen' },
      topbar(st, h('span', { class: 'pill red' }, `Ronda ${g.round}`)),
      h('h1', { class: 'title' }, 'Orden de ', h('b', null, 'participación')),
      h('div', { class: 'turn-hero' + (first && first.id === st.me.id ? ' mine' : '') },
        h('div', { class: 'label' }, 'Empieza'), h('div', { class: 'who' }, first && first.id === st.me.id ? '¡Vos!' : first ? first.name : '—')),
      orderList(st, g.order),
      statusLine(st),
      h('div', { class: 'spacer' }),
      isHost(st) ? h('button', { class: 'btn primary', onclick: e => guarded(e.currentTarget, () => act('beginRound')) }, g.mode === 'dibujo' ? 'Empezar a dibujar' : 'Empezar la ronda')
        : h('p', { class: 'center muted' }, 'Esperando al anfitrión…'),
      
      myRoleBtn(st));
  }

  function statusLine(st) {
    const g = st.game;
    return h('div', { class: 'row', style: { flexWrap: 'wrap' } },
      h('span', { class: 'pill' }, `👥 ${g.activeCount} activos`),
      h('span', { class: 'pill red' }, `🎭 ${plural(g.impostorsLeft, 'impostor', 'impostores')} sin descubrir`));
  }

  // ---------------------------------------------------------------- frases / palabras
  function timerEls(endsAt, total) {
    if (!endsAt) return null;
    return h('div', { class: 'stack', style: { gap: '6px' } },
      h('div', { class: 'timer center', 'data-ends': endsAt }, ''),
      h('div', { class: 'timerbar' }, h('i', { 'data-ends': endsAt, 'data-total': total * 1000 })));
  }

  function playScreen(st) {
    const g = st.game; const t = g.turn; const me = st.me;
    const cur = t.playerId ? playerById(st, t.playerId) : null;
    const mine = cur && cur.id === me.id;
    const what = g.mode === 'frases' ? 'la frase' : 'la palabra';
    const hero = t.done
      ? h('div', { class: 'turn-hero' }, h('div', { class: 'label' }, `Vuelta ${t.lap}`), h('div', { class: 'who' }, '¡Vuelta completa!'), h('div', { class: 'note' }, '¿Ya tienen sospechosos? Pueden votar o hacer otra vuelta.'))
      : h('div', { class: 'turn-hero' + (mine ? ' mine' : '') },
        h('div', { class: 'label' }, mine ? 'Atención' : 'Es el turno de'),
        h('div', { class: 'who' }, mine ? '¡Es tu turno!' : cur.name),
        h('div', { class: 'note' }, mine ? `Decí en voz alta UNA palabra relacionada con ${what}.` : `${cur.name} dice una palabra en voz alta.`),
        timerEls(t.endsAt, g.talkSeconds));
    const wv = g.wantVote;
    const actions = [];
    if (!t.done && (mine || isHost(st))) {
      actions.push(h('button', { class: 'btn ' + (mine ? 'gold' : 'small ghost'), onclick: e => guarded(e.currentTarget, () => act('endTurn', { turn: t.index })) }, mine ? 'Listo, ya dije mi palabra' : `Pasar el turno de ${cur.name}`));
    }
    if (t.done && isHost(st)) {
      actions.push(h('button', { class: 'btn primary', onclick: e => guarded(e.currentTarget, () => act('startVote')) }, '🗳️ Ir a la votación'));
      actions.push(h('button', { class: 'btn', onclick: e => guarded(e.currentTarget, () => act('nextLap')) }, '🔁 Otra vuelta de palabras'));
    }
    if (isActive(st)) {
      const meWants = (st.players.find(p => p.id === me.id) || {}).wantVote;
      actions.push(h('button', { class: 'btn small' + (meWants ? ' green' : ''), onclick: () => act('wantVote', { on: !meWants }) },
        `${meWants ? '✅ Pediste votar' : '✋ Quiero votar ya'} (${wv.count}/${wv.needed})`));
    }
    return h('section', { class: 'screen' },
      topbar(st, h('span', { class: 'pill red' }, `R${g.round} · Vuelta ${t.lap}`)),
      hero,
      h('div', { class: 'stack' }, actions),
      h('div', { class: 'card' }, h('h3', null, 'Orden'), orderList(st, g.order, { cur: t.done ? -1 : t.index, doneUpTo: t.done ? g.order.length : t.index - 1 })),
      statusLine(st),
      
      myRoleBtn(st));
  }

  // ---------------------------------------------------------------- pizarra
  const ASPECT = 4 / 3; // alto / ancho
  function strokePath(ctx, s, W, upto) {
    const pts = s.pts; const n = upto == null ? pts.length : Math.min(upto, pts.length);
    if (!n) return;
    ctx.strokeStyle = s.c; ctx.fillStyle = s.c;
    ctx.lineWidth = Math.max(1, s.w * W / 360);
    ctx.lineCap = 'round'; ctx.lineJoin = 'round';
    const H = W * ASPECT;
    if (n === 1) { ctx.beginPath(); ctx.arc(pts[0][0] * W, pts[0][1] * H, ctx.lineWidth / 2, 0, Math.PI * 2); ctx.fill(); return; }
    ctx.beginPath(); ctx.moveTo(pts[0][0] * W, pts[0][1] * H);
    for (let i = 1; i < n - 1; i++) {
      const mx = (pts[i][0] + pts[i + 1][0]) / 2; const my = (pts[i][1] + pts[i + 1][1]) / 2;
      ctx.quadraticCurveTo(pts[i][0] * W, pts[i][1] * H, mx * W, my * H);
    }
    ctx.lineTo(pts[n - 1][0] * W, pts[n - 1][1] * H);
    ctx.stroke();
  }
  function paint(canvas, contributions, live, { highlight = null, width } = {}) {
    const dpr = Math.min(3, window.devicePixelRatio || 1);
    const W = width || canvas.clientWidth || 300; const H = W * ASPECT;
    if (canvas.width !== Math.round(W * dpr)) { canvas.width = Math.round(W * dpr); canvas.height = Math.round(H * dpr); }
    canvas.style.height = H + 'px';
    const ctx = canvas.getContext('2d');
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.fillStyle = '#f7f3ea'; ctx.fillRect(0, 0, W, H);
    (contributions || []).forEach((c, i) => {
      ctx.globalAlpha = highlight == null || highlight === i ? 1 : 0.13;
      c.strokes.forEach(s => strokePath(ctx, s, W));
    });
    ctx.globalAlpha = 1;
    (live || []).forEach(s => strokePath(ctx, s, W));
  }

  class Board {
    constructor() {
      this.wrap = h('div', { class: 'board-wrap' });
      this.cv = h('canvas', { 'aria-label': 'Lienzo compartido' });
      this.wrap.append(this.cv);
      this.contribs = []; this.live = []; this.local = []; this.turn = null; this.highlight = null;
      this.input = null; this.queue = Promise.resolve(); this.pending = null; this.flushT = null;
      this.ro = new ResizeObserver(() => this.redraw());
      this.ro.observe(this.wrap);
      this.cv.addEventListener('pointerdown', e => this.down(e));
      this.cv.addEventListener('pointermove', e => this.move(e));
      window.addEventListener('pointerup', e => this.up(e));
      window.addEventListener('pointercancel', e => this.up(e));
    }
    set(contribs, live, turn, mine) {
      if (turn !== this.turn) { this.turn = turn; this.local = []; this.cur = null; }
      this.contribs = contribs || [];
      this.mine = mine;
      if (!mine) this.live = (live || []).map(s => ({ ...s, pts: s.pts.slice() }));
      this.redraw();
    }
    redraw() {
      if (this.replayRaf) return;
      paint(this.cv, this.contribs, this.mine ? this.local : this.live, { highlight: this.highlight, width: this.wrap.clientWidth });
    }
    remote(ev) {
      if (this.mine || ev.turn !== this.turn) return;
      let s = this.live.find(x => x.sid === ev.sid);
      if (!s) { s = { sid: ev.sid, c: ev.c, w: ev.w, pts: [] }; this.live.push(s); }
      s.pts.push(...ev.pts);
      this.redraw();
    }
    // entrada táctil
    pt(e) { const r = this.cv.getBoundingClientRect(); return [Math.round(((e.clientX - r.left) / r.width) * 1000) / 1000, Math.round(((e.clientY - r.top) / r.height) * 1000) / 1000]; }
    down(e) {
      if (!this.input || !this.input.can()) return;
      if (this.cur) return;
      e.preventDefault();
      try { this.cv.setPointerCapture(e.pointerId); } catch { /* */ }
      if (this.local.length >= 24) { toast('Llegaste al máximo de trazos'); return; }
      const sid = Math.random().toString(36).slice(2, 10);
      this.cur = { sid, c: this.input.color(), w: this.input.width(), pts: [this.pt(e)], pid: e.pointerId };
      this.local.push(this.cur);
      this.pending = { sid, c: this.cur.c, w: this.cur.w, pts: [this.cur.pts[0]] };
      this.schedule();
      this.redraw();
    }
    move(e) {
      if (!this.cur || e.pointerId !== this.cur.pid) return;
      if (!this.input.can()) { this.up(e); return; }
      e.preventDefault();
      const evs = e.getCoalescedEvents ? e.getCoalescedEvents() : [e];
      for (const ce of evs) {
        const p = this.pt(ce); const last = this.cur.pts[this.cur.pts.length - 1];
        if (Math.abs(p[0] - last[0]) + Math.abs(p[1] - last[1]) < 0.004) continue;
        if (this.cur.pts.length >= 600) break;
        this.cur.pts.push(p);
        if (!this.pending) this.pending = { sid: this.cur.sid, pts: [] };
        this.pending.pts.push(p);
      }
      this.schedule();
      this.redraw();
    }
    up(e) {
      if (!this.cur || (e && e.pointerId !== this.cur.pid)) return;
      this.cur = null; this.flush();
    }
    schedule() { if (!this.flushT) this.flushT = setTimeout(() => this.flush(), 60); }
    flush() {
      clearTimeout(this.flushT); this.flushT = null;
      const p = this.pending; this.pending = null;
      if (!p || !p.pts.length) return this.queue;
      this.queue = this.queue.then(() => act('stroke', p, { quiet: true }));
      return this.queue;
    }
    undo() {
      if (this.cur) return;
      this.flush();
      if (!this.local.length) return;
      this.local.pop(); this.redraw();
      this.queue = this.queue.then(() => act('undo', {}, { quiet: true }));
    }
    async commit(turn) { this.cur = null; await this.flush(); await this.queue; return act('drawCommit', { turn }); }
    replay(done) {
      const all = []; this.contribs.forEach(c => c.strokes.forEach(s => all.push(s)));
      const total = all.reduce((a, s) => a + s.pts.length, 0);
      if (!total) { if (done) done(); return; }
      const dur = Math.min(7000, 1200 + total * 6); const t0 = performance.now();
      const step = t => {
        const k = Math.min(1, (t - t0) / dur); let budget = Math.floor(total * k);
        const partial = [];
        for (const s of all) { if (budget <= 0) break; const n = Math.min(s.pts.length, budget); partial.push({ ...s, pts: s.pts.slice(0, n) }); budget -= n; }
        paint(this.cv, [], partial, { width: this.wrap.clientWidth });
        if (k < 1) this.replayRaf = requestAnimationFrame(step);
        else { this.replayRaf = null; this.redraw(); if (done) done(); }
      };
      this.replayRaf = requestAnimationFrame(step);
    }
  }
  function getBoard() { if (!S.board) S.board = new Board(); return S.board; }

  function legend(st, contribs, { interactive = true } = {}) {
    const b = getBoard();
    return h('div', { class: 'legend' }, contribs.map((c, i) => {
      const p = playerById(st, c.playerId);
      return h('button', {
        class: b.highlight === i ? 'on' : '',
        onclick: interactive ? () => { b.highlight = b.highlight === i ? null : i; render(); } : null,
      }, h('span', { class: 'n', style: { background: p ? p.color : '#999' } }, i + 1), p ? p.name : '—', c.empty ? ' (nada)' : '');
    }));
  }

  function drawScreen(st) {
    const g = st.game; const d = g.draw; const me = st.me;
    const drawer = d.drawerId ? playerById(st, d.drawerId) : null;
    const mine = drawer && drawer.id === me.id;
    const b = getBoard();
    b.highlight = null;
    b.set(d.contributions, d.live, d.index, mine && d.stage === 'drawing');
    const can = () => mine && S.state.phase === 'draw' && S.state.game.draw.stage === 'drawing' && S.state.game.draw.index === d.index && now() < d.endsAt;
    b.input = mine ? { can, color: () => S.ui.color, width: () => S.ui.width } : null;
    b.wrap.style.width = `min(100%, calc((100dvh - ${mine ? 330 : 250}px) * 0.75))`;
    b.wrap.style.margin = '0 auto';

    let over = b.wrap.querySelector('.board-over');
    if (over) over.remove();
    if (mine && d.stage === 'ready') {
      over = h('div', { class: 'board-over' },
        h('div', { class: 'huge', style: { color: '#ffcc33' } }, '¡Te toca!'),
        h('div', { class: 'note', style: { color: '#fff', fontSize: '16px' } }, me.role === 'impostor'
          ? 'Sos el impostor: mirá lo que dibujaron e improvisá algo que encaje.'
          : `Agregá una pequeña parte de «${me.secret}». Sin letras ni números.`),
        h('div', { class: 'note', style: { color: '#fff' } }, `Tenés ${g.drawSeconds} segundos desde que tocás el botón.`),
        h('button', { class: 'btn gold', style: { maxWidth: '260px' }, onclick: e => guarded(e.currentTarget, () => act('drawBegin')) }, '¡Empezar!'),
        h('div', { class: 'note', style: { color: '#ccc' }, 'data-ends': d.readyUntil, 'data-prefix': 'Arranca solo en ' }, ''));
      b.wrap.append(over);
    }

    const banner = h('div', { class: 'drawing-banner' },
      drawer ? avatar(drawer) : null,
      h('div', { class: 'who' }, d.stage === 'ready' ? (mine ? 'Preparate…' : `Le toca a ${drawer ? drawer.name : '—'}`) : (mine ? '¡Dibujá!' : `Dibuja ${drawer ? drawer.name : '—'}`)),
      d.stage === 'drawing' ? h('span', { class: 'timer', 'data-ends': d.endsAt }, '') : h('span', { class: 'pill' }, `${d.index + 1}/${g.order.length}`));

    let tools = null;
    if (mine && d.stage === 'drawing') {
      tools = h('div', { class: 'tools' },
        h('div', { class: 'palette' }, st.ink.map(c => h('button', { class: 'sw' + (S.ui.color === c ? ' on' : ''), style: { background: c }, 'aria-label': 'Color ' + c, onclick: () => { S.ui.color = c; render(); } }))),
        h('div', { class: 'row' },
          h('div', { class: 'widths', style: { flex: '1.4' } }, [3, 6, 12].map(w => h('button', { class: S.ui.width === w ? 'on' : '', 'aria-label': 'Grosor ' + w, onclick: () => { S.ui.width = w; render(); } }, h('i', { style: { width: w + 4 + 'px', height: w + 4 + 'px' } })))),
          h('button', { class: 'btn small', style: { flex: '.8' }, onclick: () => b.undo() }, '↶ Deshacer')),
        h('button', { class: 'btn green', onclick: e => guarded(e.currentTarget, () => b.commit(d.index)) }, '✔ Confirmar mi aporte'));
    }
    const mineInfo = mine ? null : h('p', { class: 'note center' }, d.stage === 'drawing' ? 'Mirá en vivo cómo dibuja…' : `Esperando que ${drawer ? drawer.name : ''} empiece.`);
    return h('section', { class: 'screen', style: { gap: '10px' } },
      topbar(st, h('span', { class: 'pill red' }, `Ronda ${g.round}`)),
      banner,
      d.stage === 'drawing' ? h('div', { class: 'timerbar' }, h('i', { 'data-ends': d.endsAt, 'data-total': g.drawSeconds * 1000 })) : null,
      b.wrap,
      tools,
      mineInfo,
      d.contributions.length ? legend(st, d.contributions, { interactive: false }) : null,
      isHost(st) && !mine ? h('button', { class: 'link', onclick: () => { if (confirm(`¿Saltear el turno de ${drawer ? drawer.name : ''}?`)) act('skipTurn'); } }, 'Saltear turno') : null,
      mine ? null : h('div', { style: { height: '56px' } }),
      mine ? null : myRoleBtn(st));
  }

  function galleryScreen(st) {
    const g = st.game; const d = g.draw; const me = st.me;
    const b = getBoard();
    b.input = null;
    b.set(d.contributions, [], 'gallery-' + g.round, false);
    b.wrap.style.width = 'min(100%, calc((100dvh - 330px) * 0.75))';
    b.wrap.style.margin = '0 auto';
    const over = b.wrap.querySelector('.board-over'); if (over) over.remove();
    const act2 = st.players.filter(p => p.status === 'active');
    const seen = act2.filter(p => p.seenGallery).length;
    const meSeen = (st.players.find(p => p.id === me.id) || {}).seenGallery;
    return h('section', { class: 'screen', style: { gap: '10px' } },
      topbar(st, h('span', { class: 'pill red' }, `Ronda ${g.round}`)),
      h('h1', { class: 'title' }, '¡Dibujo ', h('b', null, 'terminado!')),
      b.wrap,
      h('div', { class: 'note center' }, 'Tocá un nombre para ver solo su aporte.'),
      legend(st, d.contributions),
      h('button', { class: 'btn small', onclick: () => b.replay() }, '▶ Ver cómo se dibujó'),
      isActive(st) && !meSeen ? h('button', { class: 'btn primary', onclick: e => guarded(e.currentTarget, () => act('seenGallery')) }, `🗳️ Ya lo vi, ¡a votar! (${seen}/${act2.length})`)
        : h('p', { class: 'center muted' }, `Esperando que todos lo vean (${seen}/${act2.length})`),
      isHost(st) ? h('button', { class: 'link', onclick: () => act('startVote') }, 'Pasar a la votación ahora') : null,
      h('div', { style: { height: '56px' } }),
      myRoleBtn(st));
  }

  // ---------------------------------------------------------------- votación
  function voteScreen(st) {
    const g = st.game; const v = g.vote; const me = st.me;
    const head = h('div', null,
      h('div', { class: 'label', style: { color: v.runoff ? '#ffcc33' : '#ff8aa0' } }, v.runoff ? 'Desempate' : `Ronda ${g.round}`),
      h('h1', { class: 'title', style: { marginTop: '2px' } }, 'Votación ', h('b', null, 'secreta')));
    const prog = h('div', { class: 'stack', style: { gap: '6px' } },
      h('div', { class: 'progress' }, h('i', { style: { width: (100 * v.votedCount / v.total) + '%' } })),
      h('div', { class: 'note center' }, `${v.votedCount} de ${v.total} ya votaron`));
    let drawing = null;
    if (g.mode === 'dibujo' && g.drawing) {
      const b = getBoard(); b.input = null; b.highlight = null;
      b.set(g.drawing.contributions, [], 'vote-' + g.round, false);
      b.wrap.style.width = v.runoff ? '42%' : '52%'; b.wrap.style.margin = '0 auto';
      const ov = b.wrap.querySelector('.board-over'); if (ov) ov.remove();
      drawing = h('div', { class: 'stack', style: { gap: '6px' } }, b.wrap, legend(st, b.contribs, { interactive: false }));
      requestAnimationFrame(() => b.redraw());
    }
    if (!isActive(st)) {
      return h('section', { class: 'screen' }, topbar(st), head, drawing,
        h('div', { class: 'card center' }, h('div', { class: 'seal' }, '👻'), h('p', { class: 'big' }, 'Estás fuera de juego'), h('p', { class: 'note' }, 'Los expulsados no votan. Mirá cómo sigue la partida.')), prog);
    }
    if (v.myVote) {
      const t = playerById(st, v.myVote);
      return h('section', { class: 'screen' }, topbar(st), head, drawing,
        h('div', { class: 'card vote-done' }, h('div', { class: 'seal' }, '🗳️'), h('p', { class: 'big' }, 'Voto registrado'), h('p', { class: 'note' }, `Votaste a ${t ? t.name : '—'}. Nadie más puede verlo.`)), prog,
        myRoleBtn(st));
    }
    const sel = S.ui.voteSel;
    const list = h('div', { class: 'vote-list' }, v.candidates.map(id => {
      const p = playerById(st, id);
      const self = id === me.id;
      return h('button', { class: 'vote-opt' + (sel === id ? ' sel' : ''), disabled: self, onclick: () => { S.ui.voteSel = id; render(); } },
        avatar(p), h('span', { style: { flex: 1 } }, p ? p.name : '—'), self ? h('span', { class: 'tag muted' }, 'vos') : sel === id ? '🎯' : null);
    }));
    const selP = sel && playerById(st, sel);
    return h('section', { class: 'screen' }, topbar(st), head,
      h('p', { class: 'note' }, v.runoff ? 'Hubo empate. Votá solo entre los empatados.' : '¿Quién es el impostor? Tu voto es secreto y no se puede cambiar.'),
      drawing, list,
      h('button', { class: 'btn primary', disabled: !selP, onclick: e => guarded(e.currentTarget, async () => { await act('vote', { target: sel }); vibrate(80); }) }, selP ? `Confirmar voto a ${selP.name}` : 'Elegí a un jugador'),
      prog, myRoleBtn(st));
  }

  function resultsScreen(st) {
    const g = st.game; const r = g.result;
    const max = Math.max(1, ...r.tally.map(t => t.votes));
    const bars = h('div', { class: 'bars' }, r.tally.map(t => {
      const p = playerById(st, t.playerId);
      const top = t.votes === max && t.votes > 0;
      return h('div', { class: 'bar' + (top ? ' top' : '') }, h('i', { style: { width: (100 * t.votes / max) + '%' } }), avatar(p), h('span', { class: 'nm' }, p ? p.name : t.name), h('span', { class: 'vv' }, plural(t.votes, 'voto')));
    }));
    const host = isHost(st);
    const tiedNames = r.tied.map(id => (playerById(st, id) || {}).name).join(' y ');
    return h('section', { class: 'screen' },
      topbar(st, h('span', { class: 'pill red' }, `Ronda ${g.round}`)),
      h('h1', { class: 'title' }, 'Resultados ', h('b', null, r.runoff ? 'del desempate' : 'de la votación')),
      r.tie ? h('div', { class: 'tie' }, h('div', { class: 'huge' }, '¡Empate!'), h('p', { class: 'note' }, `${tiedNames} empataron con ${plural(max, 'voto')}. Se vota de nuevo solo entre ellos.`)) : null,
      bars,
      h('p', { class: 'note center' }, 'Solo se muestra el total: nadie sabe quién votó a quién.'),
      h('div', { class: 'spacer' }),
      host ? (r.tie
        ? h('div', { class: 'stack' },
          h('button', { class: 'btn gold', onclick: e => guarded(e.currentTarget, () => act('resolve')) }, '⚖️ Votar el desempate'),
          r.canRandom ? h('button', { class: 'btn small', onclick: () => { if (confirm('¿Sortear al expulsado entre los empatados?')) act('randomTiebreak'); } }, '🎲 Sortear entre los empatados') : null)
        : h('button', { class: 'btn primary', onclick: e => guarded(e.currentTarget, () => act('resolve')) }, 'Revelar al expulsado'))
        : h('p', { class: 'center muted' }, 'Esperando al anfitrión…'));
  }

  // ---------------------------------------------------------------- expulsión
  function expelScreen(st) {
    const g = st.game; const ex = g.lastExpel;
    const key = S.key;
    if (!S.ui.expelAt[key]) S.ui.expelAt[key] = Date.now();
    const t = Date.now() - S.ui.expelAt[key];
    const stage = t < 1800 ? 0 : t < 3600 ? 1 : 2;
    if (stage < 2) setTimeout(() => { if (S.key === key) render(); }, (stage === 0 ? 1800 : 3600) - t + 20);
    if (!S.ui.expelFx) S.ui.expelFx = {};
    const fresh = stage === 2 && !S.ui.expelFx[key];
    if (fresh) { S.ui.expelFx[key] = true; fx(ex.wasImpostor); }
    const p = playerById(st, ex.playerId);
    const host = isHost(st);
    return h('section', { class: 'screen' },
      topbar(st, h('span', { class: 'pill red' }, `Ronda ${g.round}`)),
      h('div', { class: 'expel' },
        p ? avatar(p, 'av') : null,
        h('div', { class: 'name' }, ex.name),
        h('div', { class: 'sub' }, ex.reason === 'sorteo' ? 'fue expulsado por sorteo' : 'ha sido expulsado'),
        stage === 1 ? h('div', { class: 'suspense keep-anim' }, '• • •') : null,
        stage === 2 ? h('div', { class: 'verdict ' + (ex.wasImpostor ? 'yes' : 'no') + (fresh ? ' fresh' : '') }, ex.wasImpostor ? '¡Era el impostor!' : '¡No era el impostor!') : null,
        stage === 2 && !g.winner ? h('p', { class: 'note' }, g.impostorsLeft > 0 ? `Todavía ${g.impostorsLeft === 1 ? 'queda 1 impostor' : `quedan ${g.impostorsLeft} impostores`} entre ustedes…` : '') : null,
        stage === 2 && g.winner ? h('p', { class: 'big', style: { color: g.winner === 'normales' ? '#2ee6a6' : '#ff2d55' } }, g.winner === 'normales' ? '¡Descubrieron a todos los impostores!' : 'Los impostores tomaron el control…') : null),
      stage === 2 ? (host
        ? (g.winner ? h('button', { class: 'btn primary', onclick: e => guarded(e.currentTarget, () => act('finish')) }, 'Ver resultado final')
          : h('button', { class: 'btn primary', onclick: e => guarded(e.currentTarget, () => act('nextRound')) }, `Siguiente ronda (${g.round + 1})`))
        : h('p', { class: 'center muted' }, 'Esperando al anfitrión…')) : null,
      stage === 2 && !g.winner ? statusLine(st) : null);
  }
  function fx(good) {
    document.body.append(h('div', { class: 'flash ' + (good ? 'green' : 'red') }));
    setTimeout(() => document.querySelectorAll('.flash').forEach(e => e.remove()), 1000);
    vibrate(good ? [60, 40, 60, 40, 200] : [300]);
    if (good) confetti();
  }
  function confetti() {
    const box = h('div', { class: 'confetti' });
    const cols = ['#ff2d55', '#ffcc33', '#2ee6a6', '#38b6ff', '#b36bff', '#fff'];
    for (let i = 0; i < 70; i++) {
      box.append(h('i', { style: { left: Math.random() * 100 + 'vw', background: cols[i % cols.length], animationDuration: 1.8 + Math.random() * 1.8 + 's', animationDelay: Math.random() * 0.5 + 's', transform: `rotate(${Math.random() * 360}deg)` } }));
    }
    document.body.append(box);
    setTimeout(() => box.remove(), 4500);
  }

  // ---------------------------------------------------------------- final
  function endScreen(st) {
    const g = st.game;
    const key = 'end-' + g.number;
    if (!S.ui.expelFx) S.ui.expelFx = {};
    if (!S.ui.expelFx[key]) { S.ui.expelFx[key] = true; const meWon = (st.me.role === 'impostor') === (g.winner === 'impostores'); if (meWon) confetti(); }
    const what = g.mode === 'frases' ? 'La frase' : 'La palabra';
    const host = isHost(st);
    const thumbs = (g.drawings || []).length ? h('div', { class: 'card' }, h('h3', null, 'Los dibujos'), h('div', { class: 'thumbs' }, g.drawings.map(dr => {
      const c = h('canvas');
      requestAnimationFrame(() => paint(c, dr.contributions, [], { width: c.clientWidth || 150 }));
      return h('div', null, c, h('div', { class: 'note center' }, `Ronda ${dr.round}`));
    }))) : null;
    return h('section', { class: 'screen' },
      topbar(st, h('span', { class: 'pill' }, `Partida ${g.number}`)),
      h('div', { class: 'winner ' + g.winner },
        h('div', { class: 'label' }, 'Fin de la partida'),
        h('div', { class: 'huge', style: { color: g.winner === 'normales' ? '#2ee6a6' : '#ff2d55' } }, g.winner === 'normales' ? '¡Ganaron los jugadores!' : '¡Ganaron los impostores!'),
        h('p', { class: 'note' }, (st.me.role === 'impostor') === (g.winner === 'impostores') ? '🏆 ¡Tu equipo ganó!' : '😈 Esta vez perdiste…')),
      h('div', { class: 'card center' }, h('h3', null, `${what} secreta era`), h('div', { class: 'secret' }, g.secret), g.category ? h('div', { class: 'note' }, `Categoría: ${g.category}`) : null),
      h('div', { class: 'card' }, h('h3', null, g.impostors.length > 1 ? 'Los impostores' : 'El impostor'),
        h('div', { class: 'players' }, g.impostors.map(i => { const p = playerById(st, i.id); return h('div', { class: 'pl' }, avatar(p), h('div', { class: 'nm' }, i.name), h('span', { class: 'badge ' + (i.status === 'active' ? 'imp' : 'gray') }, i.status === 'active' ? 'Sobrevivió' : i.status === 'left' ? 'Se fue' : 'Descubierto')); }))),
      h('div', { class: 'summary' },
        h('div', null, h('span', null, 'Jugadores'), h('b', null, g.initialPlayers)),
        h('div', null, h('span', null, 'Impostores'), h('b', null, g.impostorCount)),
        h('div', null, h('span', null, 'Rondas'), h('b', null, g.rounds)),
        h('div', null, h('span', null, 'Modalidad'), h('b', null, MODES[g.mode].name))),
      h('div', { class: 'card' }, h('h3', null, 'Historial de expulsiones'),
        g.expulsions.length ? h('div', { class: 'hist' }, g.expulsions.map(e => h('div', { class: 'it' },
          h('span', { class: 'muted' }, `R${e.round}`), h('b', null, e.name),
          h('span', { class: 'muted', style: { fontSize: '13px' } }, e.reason === 'votos' ? plural(e.votes || 0, 'voto') : e.reason === 'sorteo' ? 'sorteo' : e.reason === 'abandono' ? 'abandonó' : 'retirado'),
          h('span', { class: 'badge ' + (e.wasImpostor ? 'imp' : 'ok') }, e.wasImpostor ? 'Impostor' : 'Inocente')))) : h('p', { class: 'note' }, 'Nadie fue expulsado.')),
      h('div', { class: 'card' }, h('h3', null, 'Resultados de las votaciones'),
        h('div', { class: 'stack' }, (g.voteHistory || []).map((vh, i) => h('div', { class: 'vh' },
          h('b', { style: { color: '#fff' } }, `Ronda ${vh.round}${vh.runoff ? ' · desempate' : ''}${vh.tie ? ' · empate' : ''}: `),
          vh.tally.map(t => `${t.name} ${t.votes}`).join(' · '))))),
      thumbs,
      host ? h('button', { class: 'btn primary', onclick: e => guarded(e.currentTarget, () => act('rematch')) }, '🔁 Jugar otra vez con los mismos') : h('p', { class: 'center muted' }, 'El anfitrión puede iniciar la revancha.'),
      h('button', { class: 'btn', onclick: () => { if (confirm('¿Salir de esta sala?')) { act('leave', {}, { quiet: true }); leaveLocal(); S.ui.home = 'create'; render(); } } }, 'Crear una sala nueva'));
  }

  // ---------------------------------------------------------------- menú
  function openSheet(content) {
    closeSheet();
    const bg = h('div', { class: 'sheet-bg', onclick: e => { if (e.target === bg) closeSheet(); } }, h('div', { class: 'sheet' }, h('div', { class: 'grab' }), content));
    $sheetRoot.append(bg);
  }
  function closeSheet() { $sheetRoot.replaceChildren(); }

  function menuSheet() {
    const st = S.state; if (!st) return;
    const host = isHost(st);
    const inGame = st.phase !== 'lobby';
    const items = [];
    if (inGame && st.me.role && st.phase !== 'end') items.push(h('button', { class: 'btn', onclick: myRoleSheet }, '👁 Ver mi rol'));
    items.push(h('button', { class: 'btn', onclick: () => shareRoom(st.code) }, `🔗 Compartir sala ${st.code}`));
    items.push(h('button', { class: 'btn', onclick: () => { closeSheet(); howToSheet(); } }, '❓ Cómo se juega'));
    if (host) {
      const others = st.players.filter(p => p.id !== st.me.id && p.status !== 'left');
      if (others.length) {
        items.push(h('div', { class: 'label', style: { marginTop: '6px' } }, 'Jugadores'));
        items.push(h('div', { class: 'players' }, others.map(p => h('div', { class: 'pl' + (p.status === 'expelled' ? ' out' : '') }, avatar(p), h('div', { class: 'nm' }, p.name), h('span', { class: 'dot' + (p.connected ? ' on' : '') }),
          h('button', { class: 'x', title: 'Pasar anfitrión', onclick: () => { if (confirm(`¿Pasarle el rol de anfitrión a ${p.name}?`)) { act('makeHost', { playerId: p.id }); closeSheet(); } } }, '👑'),
          h('button', { class: 'x', title: 'Retirar', onclick: () => { if (confirm(inGame ? `¿Retirar a ${p.name} de la partida? Se revelará si era impostor.` : `¿Sacar a ${p.name}?`)) { act('kick', { playerId: p.id }); closeSheet(); } } }, '✕')))));
      }
      if (inGame) items.push(h('button', { class: 'btn small ghost', onclick: () => { if (confirm('¿Terminar la partida y volver a la sala de espera?')) { act('abort'); closeSheet(); } } }, '⏹ Terminar partida'));
    }
    items.push(h('button', { class: 'btn small ghost', style: { color: '#ff8aa0' }, onclick: () => { if (confirm(inGame && st.phase !== 'end' ? '¿Abandonar la partida? No vas a poder volver a entrar.' : '¿Salir de la sala?')) { act('leave', {}, { quiet: true }); leaveLocal(); } } }, '🚪 Salir de la sala'));
    items.push(h('button', { class: 'btn small', onclick: closeSheet }, 'Cerrar'));
    openSheet(h('div', { class: 'stack' }, h('h2', null, 'Sala ', st.code), items));
  }

  // ---------------------------------------------------------------- reloj de pantalla
  function tick() {
    const t = now();
    document.querySelectorAll('[data-ends]').forEach(el => {
      const ends = Number(el.getAttribute('data-ends'));
      if (!ends) return;
      const left = Math.max(0, ends - t);
      const total = Number(el.getAttribute('data-total'));
      if (total) el.style.transform = `scaleX(${Math.max(0, Math.min(1, left / total))})`;
      else el.textContent = (el.getAttribute('data-prefix') || '') + Math.ceil(left / 1000) + ' s';
    });
  }
  setInterval(tick, 100);

  // ---------------------------------------------------------------- arranque
  async function boot() {
    if ('serviceWorker' in navigator) navigator.serviceWorker.register('/sw.js').catch(() => {});
    const urlCode = (location.pathname.match(/^\/([A-Za-z]{4})$/) || [])[1];
    if (S.session && (!urlCode || urlCode.toUpperCase() === S.session.code)) {
      render();
      try { await api('/api/resume', S.session); enterRoom(S.session); }
      catch (e) { if (e.code === 'gone') { leaveLocal(); } else { enterRoom(S.session); } }
    } else {
      render();
    }
  }
  window.addEventListener('resize', () => { if (S.board) S.board.redraw(); });
  boot();
})();
