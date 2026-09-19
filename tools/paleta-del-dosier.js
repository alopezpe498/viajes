/**
 * ¿LA PALETA DEL DOSIER SIGUE SIENDO LA DE LA APLICACIÓN?
 *
 *   node tools/paleta-del-dosier.js
 *
 * POR QUÉ HACE FALTA. El dosier es un HTML que se descarga y se abre sin
 * conexión, así que no puede enlazar `public/css/estilo.css`: lleva su propio
 * `:root` con los colores copiados y con nombres cortos. Una copia que nadie
 * vigila se separa sola: el día que se cambie un color en la aplicación, el
 * dosier seguirá con el viejo y nadie lo verá hasta abrir uno en el móvil.
 *
 * QUÉ HACE, y nada más: lee los dos `:root`, resuelve los `var()` de la app
 * (hay tokens definidos en función de otros) y compara cada variable del
 * dosier con su equivalente. Sale con 1 si alguna no coincide.
 *
 * SOLO LEE.
 */
import { readFileSync } from 'node:fs';

// Nombre en el dosier → nombre en la aplicación.
const EQUIVALE = {
  '--acento': '--acento',
  '--acento-osc': '--acento-hover',
  '--tinte': '--tinte',
  '--tinte-tx': '--tinte-texto',
  '--fondo': '--fondo',
  '--sup': '--superficie',
  '--borde': '--borde',
  '--borde-f': '--borde-fuerte',
  '--tx': '--texto',
  '--tx2': '--texto-2',
  '--tx3': '--texto-3',
  '--verde-bg': '--verde-bg',
  '--verde-tx': '--verde-tx',
  '--amba-bg': '--prec-bg',
  '--amba-tx': '--prec-tx',
  '--radio': '--radio',
};

function raiz(css) {
  const m = css.match(/:root\s*\{([\s\S]*?)\n?\}/);
  if (!m) throw new Error('No encuentro el :root');
  const vars = {};
  for (const d of m[1].replace(/\/\*[\s\S]*?\*\//g, '').matchAll(/(--[a-z0-9-]+)\s*:\s*([^;]+);/gi)) {
    vars[d[1]] = d[2].trim();
  }
  return vars;
}

function resuelve(vars, nombre, vistos = new Set()) {
  const v = vars[nombre];
  if (v == null || vistos.has(nombre)) return v;
  const m = v.match(/^var\((--[a-z0-9-]+)\)$/i);
  return m ? resuelve(vars, m[1], new Set([...vistos, nombre])) : v;
}

const app = raiz(readFileSync('public/css/estilo.css', 'utf8'));
const dosierHtml = readFileSync('views/dosier.ejs', 'utf8');
const dosier = raiz(dosierHtml.slice(dosierHtml.indexOf('<style>')));

let fallos = 0;
for (const [d, a] of Object.entries(EQUIVALE)) {
  const vd = dosier[d]?.toUpperCase();
  const va = resuelve(app, a)?.toUpperCase();
  const ok = vd && va && vd === va;
  if (!ok) fallos++;
  console.log(`  ${ok ? '✓' : '✗'} ${d.padEnd(12)} ${String(vd).padEnd(9)} ${a.padEnd(16)} ${va}`);
}
// Una variable nueva en el dosier sin equivalente también es una copia sin vigilar.
for (const d of Object.keys(dosier)) {
  if (!(d in EQUIVALE)) {
    fallos++;
    console.log(`  ✗ ${d} está en el dosier y no tiene equivalente declarado aquí`);
  }
}

console.log(fallos ? `\n${fallos} diferencia(s): el dosier no pinta como la aplicación.` : '\nLa paleta del dosier es la de la aplicación.');
process.exit(fallos ? 1 : 0);
