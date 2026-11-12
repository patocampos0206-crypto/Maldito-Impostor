#!/usr/bin/env node
'use strict';
// Amplía el banco usando IA (Claude) SIN depender de ella durante las partidas.
// Genera contenidos nuevos, los valida (repetidos, errores, inapropiados, ayudín que revela)
// y los guarda en content/extra/, que el servidor carga al arrancar.
//
// Uso:
//   ANTHROPIC_API_KEY=sk-... node scripts/generar-ia.js --tipo frases --categoria comida --cantidad 40
//   ANTHROPIC_API_KEY=sk-... node scripts/generar-ia.js --tipo palabras --todas --cantidad 30
//
// Opcional: ANTHROPIC_MODEL (por defecto claude-sonnet-5-5)
const fs = require('fs');
const path = require('path');
const { ContentBank, normalize, checkItem, loadBlocked, CONTENT_DIR } = require('../lib/content');

function arg(name, def) {
  const i = process.argv.indexOf('--' + name);
  if (i === -1) return def;
  const v = process.argv[i + 1];
  return v && !v.startsWith('--') ? v : true;
}

const tipo = arg('tipo', 'palabras') === 'frases' ? 'frases' : 'palabras';
const cantidad = Math.min(100, parseInt(arg('cantidad', '30'), 10) || 30);
const key = process.env.ANTHROPIC_API_KEY;
const model = process.env.ANTHROPIC_MODEL || 'claude-sonnet-5-5';

if (!key) {
  console.error('Falta ANTHROPIC_API_KEY. Conseguila en https://console.anthropic.com y volvé a correr el script.');
  process.exit(1);
}

const bank = new ContentBank();
const blocked = loadBlocked();
const cats = arg('todas') ? Object.keys(bank.categories) : [arg('categoria', 'vida-cotidiana')];

async function generate(catId) {
  const cat = bank.categories[catId];
  if (!cat) throw new Error('Categoría desconocida: ' + catId + '. Opciones: ' + Object.keys(bank.categories).join(', '));
  const existing = (tipo === 'frases' ? bank.frases : bank.palabras).filter(i => i.category === catId).map(i => i.text);
  const prompt = `Estás ampliando el banco de contenidos del juego de fiesta "MALDITO IMPOSTOR" (estilo "el impostor").
Categoría: "${cat.name}".
Generá ${cantidad} ${tipo === 'frases' ? 'FRASES cortas de situaciones de la vida cotidiana (entre 3 y 10 palabras, sin punto final, empezando con verbo en infinitivo o sustantivo)' : 'PALABRAS o expresiones muy cortas (1 a 3 palabras), concretas y fáciles de reconocer' + (cat.drawable ? ', que se puedan dibujar' : '')}.
Para cada una, un "ayudín": UNA palabra relacionada que ayude un poco a quien no conoce la respuesta, sin revelarla ni repetir ninguna de sus palabras.
Reglas: español natural rioplatense (Argentina), sin marcas comerciales, sin contenido sexual, violento, político, religioso u ofensivo, apto para familias, sin faltas de ortografía, nada rebuscado.
No repitas ninguna de estas ya existentes: ${existing.join(' | ')}
Respondé SOLO con líneas con el formato:  texto ; ayudín`;

  const res = await fetch('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-api-key': key, 'anthropic-version': '2023-06-01' },
    body: JSON.stringify({ model, max_tokens: 4000, messages: [{ role: 'user', content: prompt }] }),
  });
  if (!res.ok) throw new Error('Error de la API: ' + res.status + ' ' + (await res.text()));
  const data = await res.json();
  const out = (data.content || []).map(c => c.text || '').join('\n');

  const known = new Set((tipo === 'frases' ? bank.frases : bank.palabras).map(i => normalize(i.text)));
  const ok = [];
  const rejected = [];
  for (const line of out.split(/\r?\n/)) {
    if (!line.includes(';')) continue;
    const [a, b] = line.replace(/^[-*\d.)\s]+/, '').split(';');
    const it = { kind: tipo === 'frases' ? 'frase' : 'palabra', text: (a || '').trim().replace(/[.]+$/, ''), hint: (b || '').trim().replace(/[.]+$/, '') };
    if (!it.text) continue;
    it.text = it.text.charAt(0).toLocaleUpperCase('es') + it.text.slice(1);
    it.hint = it.hint.charAt(0).toLocaleUpperCase('es') + it.hint.slice(1);
    const n = normalize(it.text);
    const probs = checkItem(it, blocked);
    if (known.has(n)) probs.push('Repetido');
    if (probs.length) { rejected.push(`${it.text} ; ${it.hint}  →  ${probs.join(', ')}`); continue; }
    known.add(n);
    ok.push(`${it.text} ; ${it.hint}`);
  }
  return { cat, ok, rejected };
}

(async () => {
  const dir = path.join(CONTENT_DIR, 'extra');
  fs.mkdirSync(dir, { recursive: true });
  const stamp = new Date().toISOString().slice(0, 19).replace(/[:T]/g, '-');
  const file = path.join(dir, `${tipo}-ia-${stamp}.txt`);
  let body = `# Generado con IA el ${new Date().toLocaleString('es-AR')} — revisá antes de jugar si querés\n`;
  let total = 0;
  for (const c of cats) {
    try {
      const { cat, ok, rejected } = await generate(c);
      console.log(`${cat.name}: ${ok.length} aceptados, ${rejected.length} descartados`);
      rejected.forEach(r => console.log('   ✗ ' + r));
      if (ok.length) {
        body += `\n## ${cat.id} | ${cat.name}${tipo === 'palabras' ? ` | ${cat.drawHint} | ${cat.drawable ? 'si' : 'no'}` : ''}\n` + ok.join('\n') + '\n';
        total += ok.length;
      }
    } catch (e) { console.error(c + ': ' + e.message); }
  }
  if (total) {
    fs.writeFileSync(file, body);
    console.log(`\nGuardado ${total} contenidos nuevos en ${path.relative(process.cwd(), file)}. Reiniciá el servidor para usarlos.`);
  } else console.log('\nNo se agregó nada.');
})();
