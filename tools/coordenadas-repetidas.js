/**
 * EL DETECTOR BARATO, POR CONSOLA.
 *
 * Lista los sitios del catálogo que comparten coordenada exacta dentro de una
 * misma parada. Dos nombres distintos a cero metros es siempre un error.
 *
 *   node tools/coordenadas-repetidas.js          # todo el catálogo
 *   node tools/coordenadas-repetidas.js 546      # solo esa parada
 *
 * SOLO MIRA. No cambia nada: para eso están las manos de quien lo lea.
 */

import { contarSitiosConLaMismaCoordenada } from '../services/direcciones.js';

const puntoId = process.argv[2] ? Number(process.argv[2]) : null;
const { grupos, cuantosGrupos, cuantosSitios } = contarSitiosConLaMismaCoordenada({ puntoId });

if (!cuantosGrupos) {
  console.log(
    puntoId
      ? `No hay coordenadas repetidas en la parada ${puntoId}.`
      : 'No hay coordenadas repetidas en el catálogo.'
  );
  process.exit(0);
}

for (const g of grupos) {
  console.log(`\n${g.ciudad} · ${g.lat}, ${g.lng} · ${g.sitios.length} sitios`);
  for (const s of g.sitios) {
    console.log(`   [${String(s.id).padStart(5)}] ${s.nombre}`);
    console.log(`           ${s.direccion ?? '(sin dirección)'}  ·  fuente: ${s.fuente ?? '—'}`);
  }
}

console.log(
  `\n${cuantosGrupos} grupo${cuantosGrupos === 1 ? '' : 's'} ` +
    `con ${cuantosSitios} sitios en total.`
);
