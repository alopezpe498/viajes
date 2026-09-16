/**
 * QUÉ EXCURSIONES DEL CATÁLOGO TOCA LA TABLA DE TEMPORADAS.
 *
 *   node tools/excursiones-por-temporada.js [mes]
 *
 * La tabla de `services/temporadas.js` es una heurística: unas palabras y unos
 * meses escritos a mano. Sirve para sospechar que una moto de nieve en
 * septiembre no existe. Lo que no puede es borrar una visita a Auschwitz del
 * viaje, y eso es exactamente lo que hizo: «belen» casaba dentro de «Ana Belén,
 * Alicante» —una reseñista cuyo comentario acabó en la descripción— y «ski»
 * dentro de «Zakaski u Ani», un bar de Cracovia.
 *
 * Esto lista lo que la tabla toca HOY, para poder mirarlo antes de que pase en
 * un viaje y no después. Enseña tres cosas por cada coincidencia:
 *
 *   · si la palabra está en el TÍTULO —que es lo único que se mira ya— o solo
 *     aparecía en la descripción larga, que es como entraban los falsos;
 *   · si la temporada sale de la FICHA del proveedor (dato real, descarta) o de
 *     la tabla (sospecha, solo avisa);
 *   · con qué mes se está comparando.
 *
 * SOLO MIRA. No toca el catálogo ni ningún viaje.
 */

import { todas } from '../db/index.js';
import { TEMPORADAS, fueraDeTemporada, mesesDeTexto } from '../services/temporadas.js';

const MESES = ['ene', 'feb', 'mar', 'abr', 'may', 'jun', 'jul', 'ago', 'sep', 'oct', 'nov', 'dic'];

const mes = Number(process.argv[2]) || new Date().getMonth() + 1;
if (mes < 1 || mes > 12) {
  console.error('Uso: node tools/excursiones-por-temporada.js [mes 1-12]');
  process.exit(1);
}

const normalizar = (t) =>
  String(t ?? '').toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '');

/** La misma comparación que usa el motor: palabra entera, no subcadena. */
function diceLaPalabra(texto, palabra) {
  const p = normalizar(palabra);
  if (!p) return false;
  let desde = 0;
  for (;;) {
    const i = texto.indexOf(p, desde);
    if (i < 0) return false;
    const antes = i === 0 ? '' : texto[i - 1];
    const despues = texto[i + p.length] ?? '';
    if (!/[a-z0-9]/.test(antes) && !/[a-z0-9]/.test(despues)) return true;
    desde = i + 1;
  }
}

const actividades = todas(
  'SELECT id, ciudad, titulo, descripcion_larga, detalles_extra, horarios FROM catalogo_actividades ORDER BY ciudad, titulo'
);

console.log(`Catálogo: ${actividades.length} excursiones · comparando contra ${MESES[mes - 1]}\n`);

const tocadas = [];
const soloEnLaDescripcion = [];

for (const a of actividades) {
  const titulo = normalizar(a.titulo);
  const desc = normalizar(a.descripcion_larga ?? '');

  for (const temp of TEMPORADAS) {
    const enTitulo = temp.palabras.find((p) => diceLaPalabra(titulo, p));
    const enDesc = temp.palabras.find((p) => diceLaPalabra(desc, p));

    if (enTitulo) {
      const v = fueraDeTemporada({
        titulo: a.titulo,
        fechasPropias: a.detalles_extra ?? a.horarios ?? '',
        meses: [mes],
      });
      tocadas.push({ a, temp, palabra: enTitulo, veredicto: v });
      break;
    }
    // Lo que SOLO aparece en la descripción ya no cuenta, y por eso se enseña:
    // es la lista de lo que se estaba descartando por el ruido de la página.
    if (enDesc) {
      soloEnLaDescripcion.push({ a, temp, palabra: enDesc });
      break;
    }
  }
}

if (tocadas.length) {
  console.log('LA PALABRA ESTÁ EN EL TÍTULO — esto sí lo mira el motor:\n');
  for (const t of tocadas) {
    const v = t.veredicto;
    const que = !v
      ? 'en temporada, no dice nada'
      : v.duro
        ? `DESCARTA (${v.meses.map((m) => MESES[m - 1]).join(', ')}, de la ficha)`
        : `avisa (${v.que}: ${v.porQue}; la tabla dice ${v.meses.map((m) => MESES[m - 1]).join(', ')})`;
    console.log(`  ${t.a.ciudad.padEnd(12)} ${t.a.titulo.slice(0, 52).padEnd(54)} «${t.palabra}» → ${que}`);
  }
} else {
  console.log('Ninguna excursión lleva en el título una palabra de la tabla.');
}

if (soloEnLaDescripcion.length) {
  console.log(`\nSOLO EN LA DESCRIPCIÓN — ya NO cuenta, y esto es lo que antes se descartaba:\n`);
  for (const t of soloEnLaDescripcion) {
    console.log(
      `  ${t.a.ciudad.padEnd(12)} ${t.a.titulo.slice(0, 52).padEnd(54)} «${t.palabra}»/${t.temp.que}`
    );
  }
}

// Y las que SÍ traen temporada publicada por el proveedor, que es el único dato
// que descarta. Si esta lista está vacía, es que `duro` no se activa nunca hoy.
const conFicha = actividades.filter((a) => mesesDeTexto(a.detalles_extra ?? a.horarios ?? '')?.length);
console.log(
  `\nCon temporada publicada en la ficha (el único dato que descarta): ${conFicha.length} de ${actividades.length}`
);
for (const a of conFicha.slice(0, 10)) {
  const m = mesesDeTexto(a.detalles_extra ?? a.horarios ?? '');
  console.log(`  ${a.ciudad.padEnd(12)} ${a.titulo.slice(0, 52).padEnd(54)} ${m.map((x) => MESES[x - 1]).join(', ')}`);
}
