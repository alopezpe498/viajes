/**
 * LA FICHA CONTRA SUS PROPIOS DATOS, POR CONSOLA.
 *
 * Lista los sitios cuya tarjeta no dice lo mismo que sus datos prácticos:
 * un «Gratis» arriba teniendo el precio delante, o una descripción que aconseja
 * una duración que no es la que encontró la búsqueda.
 *
 *   node tools/fichas-que-se-contradicen.js          # todo el catálogo
 *   node tools/fichas-que-se-contradicen.js 550      # solo esa parada
 *
 * SOLO MIRA. No corrige nada.
 */

import { fichasQueSeContradicen } from '../services/datos-sitios.js';

const puntoId = process.argv[2] ? Number(process.argv[2]) : null;
const { precio, duracion, revisadas } = fichasQueSeContradicen({ puntoId });

console.log(`Fichas con datos prácticos revisadas: ${revisadas}\n`);

console.log('=== EL TITULAR DICE «GRATIS» Y HAY UN PRECIO DELANTE ===');
if (!precio.length) console.log('  (ninguna)');
for (const s of precio) {
  console.log(`  [${s.bloque}] ${s.ciudad} · ${s.nombre}`);
  console.log(`      titular «${s.resumido}»  <-  «${s.precio}»`);
}
console.log(`  -> ${precio.length}\n`);

console.log('=== LA DESCRIPCIÓN ACONSEJA UNA DURACIÓN QUE NO ES LA MEDIDA ===');
if (!duracion.length) console.log('  (ninguna)');
for (const s of duracion) {
  console.log(`  [${s.bloque}] ${s.ciudad} · ${s.nombre}`);
  console.log(
    `      datos: «${s.tiempo_visita}» (${s.medida.min}-${s.medida.max} min)` +
      `  ·  descripción: ${s.dicha.min}-${s.dicha.max} min  ·  x${s.proporcion.toFixed(2)}`
  );
}
console.log(`  -> ${duracion.length}`);
