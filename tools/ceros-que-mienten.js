/**
 * EL CERO QUE MIENTE, POR CONSOLA.
 *
 * Lista las filas de la caché de distancias que dicen «cero minutos» entre dos
 * puntos distintos. Eso no es un tiempo: es un «no hay ruta» que se guardó como
 * número.
 *
 *   node tools/ceros-que-mienten.js
 *
 * SOLO MIRA. No borra nada.
 */

import { cerosQueMienten } from '../services/cache-distancias.js';

const filas = cerosQueMienten();

if (!filas.length) {
  console.log('No hay ceros que mientan en la caché de distancias.');
  process.exit(0);
}

// Cuánto hay de verdad entre los dos puntos, en línea recta. No es la distancia
// por carretera, pero basta para ver el disparate de un vistazo.
const R = 6371;
const rad = (g) => (g * Math.PI) / 180;
const km = (a, b) => {
  const dLat = rad(b.lat - a.lat);
  const dLon = rad(b.lon - a.lon);
  const h =
    Math.sin(dLat / 2) ** 2 +
    Math.cos(rad(a.lat)) * Math.cos(rad(b.lat)) * Math.sin(dLon / 2) ** 2;
  return 2 * R * Math.asin(Math.sqrt(h));
};

for (const f of filas) {
  const recta = km({ lat: f.a_lat, lon: f.a_lon }, { lat: f.b_lat, lon: f.b_lon });
  console.log(
    `  [${f.id}] ${f.a_lat},${f.a_lon} → ${f.b_lat},${f.b_lon}  ${f.modo}: ` +
      `0 min · ${f.km} km   (en línea recta hay ${recta.toFixed(1)} km)   ${f.calculado_en}`
  );
}

console.log(`\n${filas.length} fila${filas.length === 1 ? '' : 's'} que dicen cero y no lo son.`);
