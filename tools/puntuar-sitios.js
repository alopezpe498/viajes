/**
 * PUNTUAR CON LA RÚBRICA LOS SITIOS QUE YA ESTÁN EN EL CATÁLOGO.
 *
 *   node tools/puntuar-sitios.js [ciudad]
 *
 * Es el paso 1 de la rúbrica de sitios: calcular y ENSEÑAR, sin enchufar nada.
 * `importanciaDe` sigue leyendo `orden` y este programa no lo toca; tampoco
 * escribe una sola fila. Sirve para mirar la tabla y decidir si los pesos
 * aguantan ANTES de que muevan un viaje.
 *
 * LA EVIDENCIA SE PIDE AQUÍ, una llamada por ciudad. Cuando esto se enchufe de
 * verdad, la pregunta irá dentro de la investigación de la ciudad —donde la IA
 * ya está escribiendo la descripción de cada sitio— y no costará una llamada
 * aparte. Aquí va suelta porque el catálogo ya existe y no se va a reinvestigar
 * solo para verlo.
 *
 * NO GUARDA NADA. Ni columnas nuevas ni `cierra_en` ni avisos: se imprime y se
 * acaba. Si el resultado convence, entonces se construye lo demás.
 */

import { todas, una } from '../db/index.js';
import { consultarJSON, hayClaveIA, SIN_CLAVE, temperaturaAlPuntuar } from '../lib/ia.js';
import {
  encargoDeEvidencia,
  CASILLAS,
  puntosDeSitio,
  bandaDeSitio,
  NOMBRE_DE_BANDA,
  comoSeLeeLaCuenta,
  puntosMaximos,
} from '../services/rubrica-sitios.js';

const soloEsta = process.argv[2] ?? null;

if (!hayClaveIA()) {
  console.error(SIN_CLAVE);
  process.exit(1);
}


const ciudades = todas(
  `SELECT p.id, p.nombre AS ciudad, d.nombre AS destino
     FROM puntos_interes p JOIN destinos d ON d.id = p.destino_id
    WHERE EXISTS (SELECT 1 FROM sitios_lugar s WHERE s.punto_interes_id = p.id)
    ${soloEsta ? 'AND p.nombre = ?' : ''}
    ORDER BY d.nombre, p.nombre`,
  ...(soloEsta ? [soloEsta] : [])
);

if (!ciudades.length) {
  console.error(soloEsta ? `No hay sitios de «${soloEsta}».` : 'No hay sitios en el catálogo.');
  process.exit(1);
}

const todo = [];
let llamadas = 0;

for (const c of ciudades) {
  const sitios = todas(
    // SIN EL FILTRO DE `cubierto_por`, y es a proposito. Que un sitio este
    // tapado por una excursion es un hecho de UN viaje —«la visita guiada
    // incluye la Acropolis y el Agora»— no una propiedad del sitio. Con el
    // filtro puesto, la primera tirada de esta tabla salio sin la Acropolis de
    // Atenas ni el Agora Antigua, que son justo los dos que hay que mirar.
    `SELECT id, nombre, categoria, bloque, orden
       FROM sitios_lugar
      WHERE punto_interes_id = ? AND bloque <> 'busqueda'
      ORDER BY CASE bloque WHEN 'imprescindibles' THEN 0 ELSE 1 END, orden, id`,
    c.id
  );
  if (!sitios.length) continue;

  let r;
  try {
    r = await consultarJSON(encargoDeEvidencia(c.ciudad, sitios), {
      maxTokens: 4000,
      paso: `rúbrica de sitios · ${c.ciudad}`,
      temperatura: temperaturaAlPuntuar(),
    });
    llamadas += 1;
  } catch (err) {
    console.error(`  ${c.ciudad}: no pude puntuar (${err.message})`);
    continue;
  }

  const porId = new Map((Array.isArray(r?.sitios) ? r.sitios : []).map((x) => [Number(x?.id), x]));

  for (const s of sitios) {
    const cuenta = puntosDeSitio(porId.get(s.id)?.casillas);
    todo.push({
      ...s,
      ciudad: c.ciudad,
      destino: c.destino,
      ...cuenta,
      banda: bandaDeSitio(cuenta.puntos),
    });
  }
  process.stderr.write(`  ${c.ciudad}: ${sitios.length} sitios puntuados\n`);
}

// =============================================================================
// LA TABLA
// =============================================================================
const MAX = puntosMaximos();
console.log(`# LA RÚBRICA DE SITIOS SOBRE EL CATÁLOGO QUE YA EXISTE\n`);
console.log(`${todo.length} sitios de ${ciudades.length} ciudades · ${llamadas} llamada(s) a la IA`);
console.log(`Máximo posible: ${MAX} puntos\n`);

const porCiudad = {};
for (const s of todo) (porCiudad[s.ciudad] ??= []).push(s);

for (const [ciudad, lista] of Object.entries(porCiudad)) {
  lista.sort((a, b) => b.puntos - a.puntos || a.orden - b.orden);
  console.log(`\n## ${ciudad}\n`);
  console.log('| pts | banda | sitio | antes | la cuenta |');
  console.log('|---:|---|---|---|---|');
  for (const s of lista) {
    const antes =
      s.bloque === 'imprescindibles'
        ? s.orden <= 3
          ? `intocable #${s.orden}`
          : `imprescindible #${s.orden}`
        : 'segundo nivel';
    console.log(
      `| ${s.puntos} | ${NOMBRE_DE_BANDA[s.banda]} | ${s.nombre} | ${antes} | ${comoSeLeeLaCuenta(s.desglose)} |`
    );
  }
}

// --- Lo que cambia de sitio -------------------------------------------------
const nivelAntes = (s) =>
  s.bloque === 'imprescindibles' ? (s.orden <= 3 ? 3 : 2) : 1;

const suben = todo.filter((s) => s.banda > nivelAntes(s));
const bajan = todo.filter((s) => s.banda < nivelAntes(s));

console.log(`\n\n# QUÉ CAMBIA DE SITIO\n`);
console.log(`${suben.length} suben · ${bajan.length} bajan · ${todo.length - suben.length - bajan.length} se quedan donde estaban\n`);

const linea = (s) =>
  `  ${String(s.puntos).padStart(2)} pts  ${s.ciudad.padEnd(12)} ${s.nombre.slice(0, 40).padEnd(42)} ` +
  `${NOMBRE_DE_BANDA[nivelAntes(s)].padEnd(15)} -> ${NOMBRE_DE_BANDA[s.banda]}`;

if (suben.length) {
  console.log('SUBEN:');
  for (const s of suben.sort((a, b) => b.puntos - a.puntos)) console.log(linea(s));
}
if (bajan.length) {
  console.log('\nBAJAN:');
  for (const s of bajan.sort((a, b) => a.puntos - b.puntos)) console.log(linea(s));
}

const sinEvidencia = todo.filter((s) => !s.desglose.length);
if (sinEvidencia.length) {
  console.log(`\n\nSIN NINGUNA CASILLA (${sinEvidencia.length}) — la IA no supo nombrar nada de ellos:`);
  for (const s of sinEvidencia) console.log(`  ${s.ciudad.padEnd(12)} ${s.nombre}`);
}
