'use strict';
// Banco de contenidos: carga, normalización, validación y sorteo sin repeticiones.
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const CONTENT_DIR = path.join(__dirname, '..', 'content');

// Palabras que nunca deben aparecer (se puede ampliar en content/bloqueadas.txt)
const DEFAULT_BLOCKED = ['puta', 'puto', 'mierda', 'pija', 'concha', 'forro', 'boludo', 'pelotudo', 'droga', 'cocaína', 'porro', 'sexo', 'nazi', 'matar', 'suicidio', 'violación'];

function normalize(s) {
  return String(s || '')
    .toLowerCase()
    .normalize('NFD').replace(/[̀-ͯ]/g, '')
    .replace(/[^a-z0-9ñ ]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function cleanText(s) {
  let t = String(s || '').replace(/\s+/g, ' ').trim().replace(/[.]+$/, '');
  if (t) t = t.charAt(0).toLocaleUpperCase('es') + t.slice(1);
  return t;
}

function loadBlocked() {
  const f = path.join(CONTENT_DIR, 'bloqueadas.txt');
  let extra = [];
  if (fs.existsSync(f)) {
    extra = fs.readFileSync(f, 'utf8').split(/\r?\n/).map(l => l.trim()).filter(l => l && !l.startsWith('#'));
  }
  return [...DEFAULT_BLOCKED, ...extra].map(normalize).filter(Boolean);
}

// Parsea un archivo del banco. Devuelve { categories, items, problems }
function parseFile(file, kind) {
  const text = fs.readFileSync(file, 'utf8');
  const lines = text.split(/\r?\n/);
  const categories = {};
  const items = [];
  const problems = [];
  let cat = null;
  lines.forEach((raw, i) => {
    const line = raw.trim();
    if (!line || (line.startsWith('#') && !line.startsWith('##'))) return;
    if (line.startsWith('##')) {
      const parts = line.slice(2).split('|').map(p => p.trim());
      cat = {
        id: parts[0],
        name: parts[1] || parts[0],
        drawHint: parts[2] || '',
        drawable: (parts[3] || 'no').toLowerCase().startsWith('s'),
      };
      categories[cat.id] = cat;
      return;
    }
    if (!cat) { problems.push({ file, line: i + 1, msg: 'Línea fuera de una categoría' }); return; }
    const [a, b] = line.split(';');
    const textv = cleanText(a);
    const hint = cleanText(b);
    items.push({ kind, text: textv, hint, category: cat.id, line: i + 1, file: path.basename(file) });
  });
  return { categories, items, problems };
}

// Reglas de calidad. Devuelve lista de problemas por ítem.
function checkItem(it, blocked) {
  const p = [];
  const n = normalize(it.text);
  const h = normalize(it.hint);
  if (!it.text) p.push('Texto vacío');
  if (!it.hint) p.push('Falta el ayudín');
  if (/[^A-Za-zÁÉÍÓÚÜÑáéíóúüñ0-9 ,¿?¡!'\-]/.test(it.text)) p.push('Caracteres extraños');
  if (/(.)\1\1/.test(n.replace(/ /g, ''))) p.push('Letras repetidas (posible error de tipeo)');
  if (it.kind === 'palabra' && n.split(' ').length > 4) p.push('Demasiado larga para una palabra');
  if (it.kind === 'frase' && n.split(' ').length < 3) p.push('Demasiado corta para una frase');
  if (it.kind === 'frase' && n.split(' ').length > 12) p.push('Frase demasiado larga (dificultad excesiva)');
  if (it.text.length > 70) p.push('Texto demasiado largo');
  // el ayudín no puede revelar la respuesta
  const stop = new Set(['de', 'la', 'el', 'en', 'un', 'una', 'los', 'las', 'con', 'por', 'a', 'al', 'del', 'y', 'que', 'se', 'su', 'para', 'sin']);
  const tw = n.split(' ').filter(w => w.length > 3 && !stop.has(w));
  const hw = h.split(' ').filter(w => w.length > 3 && !stop.has(w));
  if (h && (h === n || hw.some(w => tw.some(t => t === w || (t.length > 4 && w.length > 4 && (t.startsWith(w.slice(0, 5)) || w.startsWith(t.slice(0, 5)))))))) {
    p.push('El ayudín repite parte de la respuesta');
  }
  const all = ` ${n} ${h} `;
  if (blocked.some(b => all.includes(` ${b} `))) p.push('Contenido inapropiado');
  return p;
}

class ContentBank {
  constructor() { this.reload(); }

  reload() {
    const blocked = loadBlocked();
    const sources = [
      ['frases.txt', 'frase'],
      ['palabras.txt', 'palabra'],
    ];
    this.categories = {};
    this.frases = [];
    this.palabras = [];
    this.report = { duplicates: [], invalid: [], problems: [] };
    const seen = new Map();
    for (const [fname, kind] of sources) {
      const extraDir = path.join(CONTENT_DIR, 'extra');
      const files = [path.join(CONTENT_DIR, fname)];
      // Archivos adicionales: content/extra/frases-*.txt, content/extra/palabras-*.txt
      if (fs.existsSync(extraDir)) {
        for (const f of fs.readdirSync(extraDir).sort()) {
          if (f.startsWith(kind === 'frase' ? 'frases' : 'palabras') && f.endsWith('.txt')) files.push(path.join(extraDir, f));
        }
      }
      for (const file of files) {
        if (!fs.existsSync(file)) continue;
        const parsed = parseFile(file, kind);
        for (const [id, c] of Object.entries(parsed.categories)) {
          const prev = this.categories[id];
          const merged = { ...(prev || {}), ...c };
          if (prev && prev.drawHint && !c.drawHint) { merged.drawHint = prev.drawHint; merged.drawable = prev.drawable; }
          this.categories[id] = merged;
        }
        this.report.problems.push(...parsed.problems);
        for (const it of parsed.items) {
          const key = kind + ':' + normalize(it.text);
          if (seen.has(key)) { this.report.duplicates.push({ item: it, first: seen.get(key) }); continue; }
          const probs = checkItem(it, blocked);
          if (probs.length) { this.report.invalid.push({ item: it, problems: probs }); continue; }
          seen.set(key, it);
          it.id = (kind === 'frase' ? 'f' : 'p') + '-' + crypto.createHash('sha1').update(normalize(it.text)).digest('hex').slice(0, 10);
          (kind === 'frase' ? this.frases : this.palabras).push(it);
        }
      }
    }
  }

  poolFor(mode, categoryFilter) {
    let pool;
    if (mode === 'frases') pool = this.frases;
    else if (mode === 'dibujo') pool = this.palabras.filter(i => this.categories[i.category] && this.categories[i.category].drawable);
    else pool = this.palabras;
    if (Array.isArray(categoryFilter) && categoryFilter.length) {
      const f = pool.filter(i => categoryFilter.includes(i.category));
      if (f.length) pool = f;
    }
    return pool;
  }

  categoryList() {
    return Object.values(this.categories).map(c => ({
      id: c.id, name: c.name,
      frases: this.frases.filter(i => i.category === c.id).length,
      palabras: this.palabras.filter(i => i.category === c.id).length,
    }));
  }

  // Elige un contenido evitando los ya usados en la sala y, si se puede, en partidas recientes.
  pick(mode, categoryFilter, usedInRoom, recentGlobal) {
    const pool = this.poolFor(mode, categoryFilter);
    if (!pool.length) throw new Error('No hay contenidos disponibles');
    const room = new Set(usedInRoom || []);
    const glob = new Set(recentGlobal || []);
    let candidates = pool.filter(i => !room.has(i.id) && !glob.has(i.id));
    if (!candidates.length) candidates = pool.filter(i => !room.has(i.id));
    if (!candidates.length) candidates = pool;
    const it = candidates[crypto.randomInt(candidates.length)];
    const cat = this.categories[it.category] || {};
    return {
      id: it.id,
      kind: it.kind,
      text: it.text,
      hint: it.hint,
      drawHint: cat.drawHint || 'Pensá en algo cotidiano',
      category: cat.name || it.category,
    };
  }
}

module.exports = { ContentBank, normalize, checkItem, parseFile, loadBlocked, CONTENT_DIR };
