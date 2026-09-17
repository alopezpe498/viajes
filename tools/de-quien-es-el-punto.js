/**
 * ¿DE QUIÉN ES EL PUNTO QUE GOOGLE DEVUELVE?
 *
 *   node tools/de-quien-es-el-punto.js [cuantos-de-control]
 *
 * LA PREGUNTA QUE HAY QUE CONTESTAR ANTES DE TOCAR NADA. La guarda de la
 * coordenada compartida ya impide el amontonamiento, pero decide quién se queda
 * el punto por `orden`, y eso acierta en 7 de 8 racimos y falla en Tesalónica:
 * ese punto es el de la TORRE BLANCA y se lo quedaron las Murallas Bizantinas.
 *
 * La idea a medir: cuando Google no encuentra lo que le preguntas, contesta con
 * el monumento importante de al lado —y lo dice, porque devuelve el NOMBRE de lo
 * que ha encontrado—. Si preguntas «Murallas Bizantinas de Tesalónica» y
 * contesta «Torre Blanca», la respuesta no es de quien pregunta.
 *
 * PERO ESO HAY QUE MEDIRLO, NO SUPONERLO. Un nombre que no casa puede ser
 * también la forma normal de contestar: Google llama «Museo de la Acrópolis» a
 * lo que nosotros pedimos como «Museo de la Acrópolis de Atenas», y eso NO es un
 * error. Si los nombres no casan casi nunca, la señal no vale para nada.
 *
 * Así que se pregunta por dos grupos y se comparan:
 *
 *   · LOS DE RACIMO — los 27 que compartían coordenada. Sabemos que ahí hay
 *     respuestas que no son de quien pregunta.
 *   · EL CONTROL — sitios que nunca compartieron punto. Aquí la respuesta
 *     debería ser suya casi siempre.
 *
 * Si el parecido separa los dos grupos, hay regla. Si no, no la hay y se dice.
 *
 * SOLO LEE Y PREGUNTA. No escribe nada en el catálogo.
 */

import { todas, una } from '../db/index.js';
import { situarLugarConGoogle, googleDisponible } from '../lib/google.js';

const CONTROL = Number(process.argv[2]) || 40;

if (!googleDisponible()) {
  console.error('Google no está disponible: sin clave de servidor no hay nada que medir.');
  process.exit(1);
}

// =============================================================================
// CUÁNTO SE PARECEN DOS NOMBRES
// =============================================================================
/**
 * Las palabras que llevan la información, sin el andamiaje.
 *
 * Se quitan los acentos, las mayúsculas, las preposiciones y los artículos, y
 * también el nombre de la ciudad: «Museo Arqueológico de Nafplio» y «Museo
 * Arqueológico» son el mismo sitio, y dejar «nafplio» dentro haría que casi todo
 * casara al 50 % solo por compartir el topónimo.
 */
const VACIAS = new Set([
  'de', 'del', 'la', 'el', 'los', 'las', 'y', 'e', 'en', 'a', 'al', 'un', 'una', 'da', 'do',
]);

function palabras(texto, ciudad) {
  const fuera = new Set(
    String(ciudad ?? '')
      .toLowerCase()
      .normalize('NFD')
      .replace(/[̀-ͯ]/g, '')
      .split(/[^a-z0-9]+/)
      .filter(Boolean)
  );
  return new Set(
    String(texto ?? '')
      .toLowerCase()
      .normalize('NFD')
      .replace(/[̀-ͯ]/g, '')
      .split(/[^a-z0-9]+/)
      .filter((p) => p.length > 2 && !VACIAS.has(p) && !fuera.has(p))
  );
}

/**
 * Qué parte de lo que se PREGUNTA aparece en lo que se CONTESTA.
 *
 * No es simétrico a propósito, y es la diferencia entre medir bien y medir mal.
 * «Museo de la Acrópolis» contestando a «Museo de la Acrópolis de Atenas» es
 * correcto aunque la respuesta sea más corta; lo que no puede pasar es que las
 * palabras de la PREGUNTA no estén en la RESPUESTA. Un Jaccard normal castigaría
 * el primer caso, que es el bueno.
 */
function parecido(preguntado, contestado, ciudad) {
  const a = palabras(preguntado, ciudad);
  const b = palabras(contestado, ciudad);
  if (!a.size) return 1;
  let dentro = 0;
  for (const p of a) if (b.has(p)) dentro += 1;
  return dentro / a.size;
}

// =============================================================================
// LOS DOS GRUPOS
// =============================================================================
// Los de racimo son los que hoy están sin coordenada por la migración: la
// migración los dejó sin punto precisamente por compartirlo.
const deRacimo = todas(
  `SELECT s.id, s.nombre, p.nombre AS ciudad, p.destino_id, 'racimo' AS grupo
     FROM sitios_lugar s JOIN puntos_interes p ON p.id = s.punto_interes_id
    WHERE s.lat IS NULL AND s.bloque <> 'busqueda'
    ORDER BY p.nombre, s.orden`
);

const control = todas(
  `SELECT s.id, s.nombre, p.nombre AS ciudad, p.destino_id, 'control' AS grupo
     FROM sitios_lugar s JOIN puntos_interes p ON p.id = s.punto_interes_id
    WHERE s.lat IS NOT NULL AND s.bloque <> 'busqueda'
    ORDER BY RANDOM() LIMIT ?`,
  CONTROL
);

const todosLosSitios = [...deRacimo, ...control];
console.error(`Preguntando por ${todosLosSitios.length} sitios (${deRacimo.length} de racimo, ${control.length} de control)…`);

const filas = [];
for (const s of todosLosSitios) {
  const pais =
    una('SELECT COALESCE(d.pais, d.nombre) AS pais FROM destinos d WHERE d.id = ?', s.destino_id)
      ?.pais ?? null;
  const donde = [s.ciudad, pais && pais !== s.ciudad ? pais : null].filter(Boolean).join(', ');
  const r = await situarLugarConGoogle(donde ? `${s.nombre}, ${donde}` : s.nombre, null);
  filas.push({
    ...s,
    devuelto: r?.nombre ?? null,
    tipos: r?.tipos ?? [],
    placeId: r?.placeId ?? null,
    parecido: r?.nombre ? parecido(s.nombre, r.nombre, s.ciudad) : null,
  });
  process.stderr.write('.');
}
process.stderr.write('\n');

// =============================================================================
// LA COMPARACIÓN
// =============================================================================
console.log('# ¿DE QUIÉN ES EL PUNTO QUE GOOGLE DEVUELVE?\n');
console.log(`${filas.length} preguntas a Places · languageCode 'es'\n`);

const conRespuesta = filas.filter((f) => f.parecido != null);

for (const grupo of ['control', 'racimo']) {
  const g = conRespuesta.filter((f) => f.grupo === grupo);
  if (!g.length) continue;
  const media = g.reduce((n, f) => n + f.parecido, 0) / g.length;
  const casan = g.filter((f) => f.parecido >= 0.5).length;
  console.log(
    `## ${grupo.toUpperCase()}  ${g.length} sitios · parecido medio ${media.toFixed(2)} · ` +
      `${casan} casan al 50 % o más (${Math.round((100 * casan) / g.length)} %)`
  );
}

console.log('\n## DÓNDE CAE CADA UNO\n');
const TRAMOS = [
  [1.0, 1.01, 'todas las palabras'],
  [0.5, 1.0, 'la mitad o más'],
  [0.01, 0.5, 'alguna palabra'],
  [0, 0.01, 'NINGUNA palabra'],
];
console.log('  parecido               control   racimo');
for (const [min, max, etiqueta] of TRAMOS) {
  const c = conRespuesta.filter((f) => f.grupo === 'control' && f.parecido >= min && f.parecido < max).length;
  const r = conRespuesta.filter((f) => f.grupo === 'racimo' && f.parecido >= min && f.parecido < max).length;
  console.log(`  ${etiqueta.padEnd(22)} ${String(c).padStart(5)}    ${String(r).padStart(5)}`);
}

console.log('\n## LOS QUE NO CASAN — ¿es la respuesta de otro sitio?\n');
for (const f of conRespuesta.filter((x) => x.parecido < 0.5).sort((a, b) => a.parecido - b.parecido)) {
  console.log(
    `  [${f.grupo}] ${f.ciudad.padEnd(12)} «${f.nombre}»\n` +
      `        -> «${f.devuelto}»  (parecido ${f.parecido.toFixed(2)}; ${f.tipos.join(', ') || 'sin tipos'})`
  );
}

const sinRespuesta = filas.filter((f) => f.parecido == null);
if (sinRespuesta.length) {
  console.log(`\n## SIN RESPUESTA DE GOOGLE (${sinRespuesta.length})\n`);
  for (const f of sinRespuesta) console.log(`  [${f.grupo}] ${f.ciudad} · ${f.nombre}`);
}
