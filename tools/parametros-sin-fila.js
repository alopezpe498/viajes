/**
 * PARÁMETROS QUE EL CÓDIGO LEE Y QUE NO ESTÁN EN LA TABLA.
 *
 *   node tools/parametros-sin-fila.js
 *
 * `parametro()` y `parametroTexto()` devuelven su respaldo cuando no encuentran
 * la clave, así que un parámetro sin fila NO rompe nada: el número sigue siendo
 * el que el código lleva escrito. Lo que pasa es otra cosa, y es peor de ver que
 * de arreglar —un número que no se puede tocar desde la pantalla de parámetros
 * aunque su comentario prometa que sí, y una línea de aviso en el log en CADA
 * lectura, que es como se descubrió el primero—.
 *
 * Pasa por dos vías: un parámetro nuevo al que se le olvida su migración, y una
 * fila que se escribió y se perdió después. La segunda existe: la migración
 * «2026-09-tope-por-trabajo-scraping» figuraba como aplicada con su fila
 * ausente, y en el código no hay un solo DELETE contra esa tabla. Una marca en
 * `migraciones` dice que algo se ejecutó, no que su efecto siga ahí.
 *
 * Las claves se sacan leyendo el código, así que solo ve las literales. Las que
 * se arman por plantilla —`modelo_${fase}`, o la tabla de categorías de
 * `visita_*_min`— no se pueden encontrar así y no se cuentan en ningún lado:
 * este detector no dice nada de ellas, ni para bien ni para mal.
 *
 * SOLO MIRA.
 */

import { readFileSync, readdirSync, statSync } from 'node:fs';
import { dirname, join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import { todas } from '../db/index.js';

const RAIZ = dirname(dirname(fileURLToPath(import.meta.url)));
const LEE = /parametro(?:Texto)?\(\s*'([a-z0-9_]+)'\s*,\s*([^)]*)\)/g;

const donde = new Map();

function recorrer(carpeta) {
  for (const nombre of readdirSync(carpeta)) {
    if (nombre === 'node_modules' || nombre.startsWith('.')) continue;
    const ruta = join(carpeta, nombre);
    if (statSync(ruta).isDirectory()) {
      recorrer(ruta);
      continue;
    }
    if (!nombre.endsWith('.js')) continue;

    const texto = readFileSync(ruta, 'utf8');
    for (const m of texto.matchAll(LEE)) {
      if (!donde.has(m[1])) donde.set(m[1], { sitios: new Set(), respaldo: m[2].trim() });
      donde.get(m[1]).sitios.add(relative(RAIZ, ruta));
    }
  }
}

recorrer(RAIZ);

const hay = new Set(todas('SELECT clave FROM parametros_orquestador').map((r) => r.clave));
const faltan = [...donde.keys()].filter((k) => !hay.has(k)).sort();

if (!faltan.length) {
  console.log(
    `Los ${donde.size} parámetros que el código nombra a las claras tienen su fila. Nada que hacer.`
  );
  process.exit(0);
}

console.log(`${faltan.length} parámetro(s) que el código lee y que no están en la tabla:\n`);
for (const clave of faltan) {
  const { sitios, respaldo } = donde.get(clave);
  console.log(`  ${clave}`);
  console.log(`      respaldo que se usa: ${respaldo}`);
  console.log(`      lo lee: ${[...sitios].join(', ')}`);
}
console.log(
  '\nNo está roto: cada uno usa su respaldo. Pero no se pueden tocar desde la\n' +
    'pantalla de parámetros, y cada lectura deja una línea en el log.'
);
