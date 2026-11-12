#!/usr/bin/env node
'use strict';
// Revisa el banco de frases y palabras: repetidos, errores, ayudines que revelan la respuesta, contenido inapropiado.
// Uso: npm run validar
const { ContentBank } = require('../lib/content');

const bank = new ContentBank();
const r = bank.report;
console.log('\nMALDITO IMPOSTOR — Validación del banco de contenidos\n');
console.log(`Frases válidas:   ${bank.frases.length}`);
console.log(`Palabras válidas: ${bank.palabras.length}`);
console.log(`Para dibujo:      ${bank.poolFor('dibujo').length}`);
console.log(`Categorías:       ${Object.keys(bank.categories).length}\n`);
for (const c of bank.categoryList()) console.log(`  · ${c.name.padEnd(24)} ${String(c.frases).padStart(4)} frases  ${String(c.palabras).padStart(4)} palabras`);

if (r.duplicates.length) {
  console.log(`\nRepetidos descartados (${r.duplicates.length}):`);
  for (const d of r.duplicates) console.log(`  - "${d.item.text}" (${d.item.file}:${d.item.line}) ya estaba en ${d.first.file}:${d.first.line}`);
}
if (r.invalid.length) {
  console.log(`\nDescartados por calidad (${r.invalid.length}):`);
  for (const d of r.invalid) console.log(`  - "${d.item.text}" ; "${d.item.hint}" (${d.item.file}:${d.item.line}): ${d.problems.join(', ')}`);
}
if (r.problems.length) {
  console.log(`\nProblemas de formato (${r.problems.length}):`);
  for (const p of r.problems) console.log(`  - ${p.file}:${p.line} ${p.msg}`);
}
console.log('');
process.exitCode = r.problems.length ? 1 : 0;
