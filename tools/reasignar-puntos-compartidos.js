/**
 * LOS SITIOS QUE SE QUEDARON SIN PUNTO, PREGUNTADOS OTRA VEZ.
 *
 *   node tools/reasignar-puntos-compartidos.js [--de-verdad]
 *
 * POR QUÉ HACE FALTA. La migración `migracionSitiosAmontonados` deshizo los
 * racimos de coordenadas compartidas con la regla que había entonces —se queda
 * el primero por `orden`— y esa regla falla en Tesalónica: el punto compartido
 * es el de la TORRE BLANCA y se lo quedaron las Murallas Bizantinas, que iban
 * antes en la lista. La Torre Blanca, que es el #7 de la ciudad, se quedó sin
 * pin para que otro llevase uno falso.
 *
 * La regla nueva desempata con el nombre que Google devuelve, pero vive dentro
 * de `situarLosSitios` y solo actúa cuando se pregunta. Los sitios ya rotos no
 * se vuelven a preguntar nunca: tienen su fila en `direcciones` y el `NOT
 * EXISTS` de esa consulta los salta para siempre.
 *
 * NO REIMPLEMENTA NADA, Y ESA ES LA GRACIA. Borra la fila de `direcciones` de
 * los sitios sin coordenada y llama a `situarLosSitios`, que es el código de
 * producción con su guarda nueva dentro. Si mañana la guarda cambia, esto
 * cambia solo. Un tirador que se reimplementa a sí mismo mide otra cosa, y eso
 * ya nos ha pasado cuatro veces.
 *
 * EN SECO POR DEFECTO. Sin `--de-verdad` enseña a quién preguntaría y no toca
 * nada ni gasta una llamada.
 */

import { todas, una, ejecutar } from '../db/index.js';
import { situarLosSitios } from '../services/direcciones.js';
import { googleDisponible } from '../lib/google.js';

const DE_VERDAD = process.argv.includes('--de-verdad');

const huerfanos = todas(
  `SELECT s.id, s.nombre, s.orden, s.punto_interes_id, p.nombre AS ciudad
     FROM sitios_lugar s JOIN puntos_interes p ON p.id = s.punto_interes_id
    WHERE s.lat IS NULL AND s.bloque <> 'busqueda'
    ORDER BY p.nombre, s.orden`
);

if (!huerfanos.length) {
  console.log('No hay ningún sitio sin coordenada. Nada que reasignar.');
  process.exit(0);
}

console.log(`${huerfanos.length} sitio(s) sin coordenada:\n`);
for (const h of huerfanos) {
  console.log(`  ${h.ciudad.padEnd(12)} #${String(h.orden).padEnd(3)} ${h.nombre}`);
}

if (!DE_VERDAD) {
  console.log('\nEn seco. Para preguntar de verdad: node tools/reasignar-puntos-compartidos.js --de-verdad');
  process.exit(0);
}

if (!googleDisponible()) {
  console.error('\nGoogle no está disponible: sin clave de servidor no hay a quién preguntar.');
  process.exit(1);
}

// LA FILA DE `direcciones` SE BORRA PARA QUE VUELVAN A ENTRAR EN LA CONSULTA.
// Es lo único que esta herramienta hace por su cuenta; lo demás lo decide la
// guarda de producción.
const puntos = [...new Set(huerfanos.map((h) => h.punto_interes_id))];
for (const h of huerfanos) {
  ejecutar("DELETE FROM direcciones WHERE tipo_elemento = 'sitio' AND elemento_id = ?", h.id);
}

console.log(`\nPreguntando por ${puntos.length} ciudad(es)…\n`);
for (const pid of puntos) {
  const punto = una('SELECT * FROM puntos_interes WHERE id = ?', pid);
  const r = await situarLosSitios(punto, (t) => console.log(t));
  console.log(
    `  ${punto.nombre}: ${r.situados} de ${r.total} resueltos` +
      `${r.amontonados ? `, ${r.amontonados} en el punto de otro` : ''}.`
  );
}

// =============================================================================
// CÓMO HA QUEDADO
// =============================================================================
console.log('\n## DESPUÉS\n');
const sinPunto = todas(
  `SELECT s.nombre, s.orden, p.nombre AS ciudad FROM sitios_lugar s
     JOIN puntos_interes p ON p.id = s.punto_interes_id
    WHERE s.lat IS NULL AND s.bloque <> 'busqueda' ORDER BY p.nombre, s.orden`
);
console.log(`  siguen sin coordenada: ${sinPunto.length}`);
for (const x of sinPunto) console.log(`     ${x.ciudad.padEnd(12)} #${String(x.orden).padEnd(3)} ${x.nombre}`);

// La comprobación que importa: que no haya vuelto a quedar ningún racimo.
const con = todas(
  'SELECT lat, lon, punto_interes_id FROM sitios_lugar WHERE lat IS NOT NULL AND bloque <> \'busqueda\''
);
const racimos = new Map();
for (const x of con) {
  const k = `${x.punto_interes_id}|${x.lat.toFixed(5)},${x.lon.toFixed(5)}`;
  racimos.set(k, (racimos.get(k) ?? 0) + 1);
}
const quedan = [...racimos.values()].filter((n) => n > 1).length;
console.log(`\n  coordenadas compartidas que quedan: ${quedan}`);
