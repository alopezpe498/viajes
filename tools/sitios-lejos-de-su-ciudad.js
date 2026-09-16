/**
 * SITIOS QUE CAEN LEJOS DE LA CIUDAD A LA QUE PERTENECEN.
 *
 *   node tools/sitios-lejos-de-su-ciudad.js [km]
 *
 * El catálogo guarda cada sitio colgando de su ciudad, y su coordenada la pone
 * Google Places. Cuando el nombre es ambiguo, Places contesta otra cosa: en el
 * viaje a Túnez el «Parque del Olivar de Susa» acabó en Lima, el «Mirador de la
 * Torre del Reloj» en Cartagena de Indias y el «Restaurante Dar Hizem» en Miami
 * —«Susa» es Sousse y también un pueblo del Piamonte—.
 *
 * Esto lo enseña sin esperar a verlo en un mapa. Tres tramos:
 *
 *   · hasta el umbral de aviso  · normal, no se lista
 *   · entre aviso y descarte    · puede ser una excursión de día de verdad
 *                                 (El Jem está a 174 km de Túnez) o un error
 *   · por encima del descarte   · otro continente; el motor ya no guarda esas
 *                                 coordenadas, pero las viejas siguen ahí
 *
 * SOLO MIRA. Lo que encuentre se arregla borrando su dirección y volviendo a
 * situar la ciudad, que es lo que hace la fase «Qué ver».
 */

import { todas } from '../db/index.js';
import { parametro } from '../services/orquestador.js';

const AVISO = Number(process.argv[2]) || parametro('km_sitio_lejos_aviso', 80);
const DESCARTE = parametro('km_sitio_lejos_descarte', 300);

const R = 6371;
const rad = (g) => (g * Math.PI) / 180;
function km(a, b) {
  const dLat = rad(b.lat - a.lat);
  const dLon = rad(b.lon - a.lon);
  const h =
    Math.sin(dLat / 2) ** 2 +
    Math.cos(rad(a.lat)) * Math.cos(rad(b.lat)) * Math.sin(dLon / 2) ** 2;
  return 2 * R * Math.asin(Math.sqrt(h));
}

const filas = todas(
  `SELECT s.id, s.nombre, s.lat, s.lon,
          p.id AS puntoId, p.nombre AS ciudad, p.lat AS plat, p.lon AS plon,
          d.nombre AS destino
     FROM sitios_lugar s
     JOIN puntos_interes p ON p.id = s.punto_interes_id
     JOIN destinos d       ON d.id = p.destino_id
    WHERE s.lat IS NOT NULL AND p.lat IS NOT NULL`
);

const lejos = filas
  .map((f) => ({ ...f, d: km({ lat: f.lat, lon: f.lon }, { lat: f.plat, lon: f.plon }) }))
  .filter((f) => f.d > AVISO)
  .sort((a, b) => b.d - a.d);

console.log(
  `${filas.length} sitios con coordenadas · ${lejos.length} a más de ${AVISO} km del centro de su ciudad\n`
);

if (!lejos.length) {
  console.log('Ninguno. Todos caen donde deben.');
  process.exit(0);
}

const porDestino = {};
for (const l of lejos) porDestino[l.destino] = (porDestino[l.destino] ?? 0) + 1;
console.log('Por destino: ' + Object.entries(porDestino).map(([k, v]) => `${k} ${v}`).join(' · '));
console.log();

for (const l of lejos) {
  const grave = l.d > DESCARTE;
  console.log(
    `  ${grave ? 'DISPARATE' : 'mirar    '} ${String(Math.round(l.d)).padStart(6)} km  ` +
      `${l.ciudad.padEnd(12)} ${l.nombre.slice(0, 44).padEnd(46)} ` +
      `${l.lat.toFixed(3)}, ${l.lon.toFixed(3)}  (sitio #${l.id})`
  );
}

console.log(
  `\nPor encima de ${DESCARTE} km el motor ya no guarda la coordenada. Los de arriba\n` +
    'son de antes de esa guarda, o de una ciudad cuyo punto se movió después.'
);
