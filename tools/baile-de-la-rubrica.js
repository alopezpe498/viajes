/**
 * ¿CUÁNTO BAILA LA RÚBRICA DE SITIOS?
 *
 *   node tools/baile-de-la-rubrica.js [veces] [ciudad...]
 *
 * Hace la MISMA pregunta varias veces sobre las MISMAS ciudades y compara
 * casilla por casilla. Nada más.
 *
 * POR QUÉ ESTO Y NO OTRA TIRADA MÁS. Llevamos cuatro tiradas cambiando el
 * encargo —apretar una casilla, ensanchar otra, partir una en dos— y en cada una
 * se arreglaba algo y se rompía algo. Ninguna de las cuatro contestó a la
 * pregunta previa: ¿la misma pregunta da la misma respuesta?
 *
 * Es exactamente lo que fundó `rubrica-ciudades.js`, y está escrito en su
 * cabecera: «medido con diez tiradas de la misma pregunta sobre el mismo
 * destino: Kairouan 4 o 5, El Jem 3 o 4». Ese dato es el que justificó dejar de
 * pedirle el número al modelo. Aquí no se había medido ni una vez.
 *
 * QUÉ DECIDE EL RESULTADO, acordado ANTES de mirarlo para no moverlo después:
 *
 *   · Si BAILA  → es varianza de quien marca. La cura es CÓMO se pregunta
 *                 —sitio a sitio en vez de veinte de golpe, o menos
 *                 temperatura—. Las definiciones no se tocan.
 *   · Si es ESTABLE pero está MAL → el encargo es firme y lo que falla es la
 *                 instrucción de esas casillas. Ahí sí se reescribe.
 *
 * SOLO LEE Y COMPARA. No guarda nada.
 */

import { todas, una } from '../db/index.js';
import { consultarJSON, hayClaveIA, SIN_CLAVE, temperaturaAlPuntuar } from '../lib/ia.js';
import {
  encargoDeEvidencia,
  puntosDeSitio,
  sanearEvidencia,
  bandaDeSitio,
  NOMBRE_DE_BANDA,
} from '../services/rubrica-sitios.js';

const VECES = Number(process.argv[2]) || 2;
const CIUDADES = process.argv.slice(3).length ? process.argv.slice(3) : ['Atenas', 'Kairuan'];

if (!hayClaveIA()) {
  console.error(SIN_CLAVE);
  process.exit(1);
}


const resultados = new Map(); // id -> { nombre, ciudad, tiradas: [ {casillas:Set, puntos} ] }

for (const ciudad of CIUDADES) {
  const p = una(
    'SELECT id FROM puntos_interes WHERE nombre = ? ORDER BY id DESC LIMIT 1',
    ciudad
  );
  if (!p) {
    console.error(`No hay ninguna ciudad llamada «${ciudad}» en el catálogo.`);
    continue;
  }

  const sitios = todas(
    `SELECT id, nombre, categoria FROM sitios_lugar
      WHERE punto_interes_id = ? AND bloque <> 'busqueda'
      ORDER BY orden, id`,
    p.id
  );

  for (let n = 1; n <= VECES; n += 1) {
    let r;
    try {
      r = await consultarJSON(encargoDeEvidencia(ciudad, sitios), {
        maxTokens: 4000,
        paso: `baile de la rúbrica · ${ciudad} · tirada ${n}`,
        temperatura: temperaturaAlPuntuar(),
      });
    } catch (err) {
      console.error(`  ${ciudad} tirada ${n}: falló (${err.message})`);
      continue;
    }

    const porId = new Map((Array.isArray(r?.sitios) ? r.sitios : []).map((x) => [Number(x?.id), x]));

    for (const s of sitios) {
      if (!resultados.has(s.id)) {
        resultados.set(s.id, { nombre: s.nombre, ciudad, tiradas: [] });
      }
      const buenas = sanearEvidencia(porId.get(s.id)?.casillas);
      resultados.get(s.id).tiradas.push({
        casillas: new Set(buenas.map((c) => c.casilla)),
        puntos: puntosDeSitio(porId.get(s.id)?.casillas).puntos,
      });
    }
    process.stderr.write(`  ${ciudad}: tirada ${n} de ${VECES}\n`);
  }
}

// =============================================================================
// LA COMPARACIÓN
// =============================================================================
console.log(`# ¿BAILA LA RÚBRICA?\n`);
console.log(`${VECES} tiradas de la misma pregunta · ciudades: ${CIUDADES.join(', ')}`);
console.log(`temperatura: ${temperaturaAlPuntuar()}\n`);

const filas = [...resultados.values()].filter((x) => x.tiradas.length === VECES);

let iguales = 0;
const bailan = [];

for (const f of filas) {
  const firmas = f.tiradas.map((t) => [...t.casillas].sort().join('+') || '(ninguna)');
  const mismo = firmas.every((x) => x === firmas[0]);
  if (mismo) iguales += 1;
  else bailan.push({ ...f, firmas });
}

console.log(`${filas.length} sitios · ${iguales} salen IGUAL las ${VECES} veces · ${bailan.length} BAILAN`);
console.log(`estabilidad: ${Math.round((100 * iguales) / filas.length)} %\n`);

// Los puntos, que es lo que de verdad decide
const rango = filas.map((f) => {
  const p = f.tiradas.map((t) => t.puntos);
  return { ...f, min: Math.min(...p), max: Math.max(...p), p };
});
const conSalto = rango.filter((f) => f.max !== f.min);
console.log(`En PUNTOS: ${filas.length - conSalto.length} clavados · ${conSalto.length} cambian de nota`);
const salto2 = conSalto.filter((f) => f.max - f.min >= 2);
console.log(`De esos, ${salto2.length} cambian 2 puntos o más\n`);

// LA MEDIDA QUE DE VERDAD IMPORTA: LA BANDA.
//
// «Idéntico en las N tiradas» es una vara mala y engaña en los dos sentidos:
// cuantas más tiradas, más difícil es que TODAS coincidan, así que el número
// baja solo por medir mejor —con 3 tiradas dio 92 % y con 5 da 49 %, con el
// mismo encargo—. Y sobre todo, mide algo que al motor le da igual: que un
// sitio saque 5 o 6 puntos no cambia ninguna decisión.
//
// Lo que decide es la BANDA. Un sitio que oscila entre 5 y 6 está clavado para
// lo que importa; uno que oscila entre 3 y 4 cruza la raya de «imprescindible»
// y cambia lo que el reparto hace con él. Esta es la vara buena.
const porBanda = filas.map((f) => {
  const b = f.tiradas.map((t) => bandaDeSitio(t.puntos));
  return { ...f, bandas: b, firme: b.every((x) => x === b[0]) };
});
const cruzan = porBanda.filter((f) => !f.firme);
console.log(
  `EN BANDA: ${filas.length - cruzan.length} de ${filas.length} no se mueven ` +
    `(${Math.round((100 * (filas.length - cruzan.length)) / filas.length)} %)`
);
if (cruzan.length) {
  console.log('\nLos que CRUZAN DE BANDA — los únicos que cambian lo que hace el motor:');
  for (const f of cruzan) {
    console.log(
      `  ${f.ciudad.padEnd(10)} ${f.nombre.slice(0, 42).padEnd(44)} ` +
        `${f.tiradas.map((t) => t.puntos).join('/')}  ->  ` +
        `${[...new Set(f.bandas)].map((b) => NOMBRE_DE_BANDA[b]).join(' / ')}`
    );
  }
}
console.log('');

// CUÁNTAS VECES SE MARCA CADA CASILLA, sumando las tiradas.
//
// Faltaba, y se notó: al ensanchar `es_el_motivo` no había forma de contestar a
// «¿se ha pasado de frenada?» sin volver a tirar. Una casilla que se marca en la
// mitad de los sitios ha dejado de discriminar, y eso hay que verlo en el mismo
// sitio donde se mira el baile.
const cuenta = {};
for (const f of filas) {
  for (const t of f.tiradas) for (const c of t.casillas) cuenta[c] = (cuenta[c] ?? 0) + 1;
}
const posibles = filas.length * VECES;
console.log(`\n## CUÁNTO SE USA CADA CASILLA  (de ${posibles} oportunidades: ${filas.length} sitios × ${VECES} tiradas)\n`);
for (const [c, n] of Object.entries(cuenta).sort((a, b) => b[1] - a[1])) {
  console.log(`  ${String(n).padStart(3)}  ${String(Math.round((100 * n) / posibles)).padStart(3)} %  ${c}`);
}

console.log(`\n## LOS CUATRO QUE NOS IMPORTAN\n`);
const CLAVE = ['Museo de la Acrópolis', 'Museo Arqueológico Nacional', 'Odeón', 'Medina de Kairuan'];
for (const f of rango) {
  if (!CLAVE.some((c) => f.nombre.includes(c))) continue;
  console.log(`### ${f.nombre} (${f.ciudad})`);
  f.tiradas.forEach((t, i) => {
    console.log(`  tirada ${i + 1}: ${t.puntos} pts · ${[...t.casillas].sort().join(', ') || '(ninguna casilla)'}`);
  });
  console.log('');
}

if (bailan.length) {
  console.log(`\n## TODOS LOS QUE BAILAN\n`);
  for (const f of bailan.sort((a, b) => a.ciudad.localeCompare(b.ciudad))) {
    const p = f.tiradas.map((t) => t.puntos).join(' / ');
    console.log(`  ${f.ciudad.padEnd(10)} ${f.nombre.slice(0, 44).padEnd(46)} ${p.padEnd(10)} ${f.firmas.join('   ≠   ')}`);
  }
}
