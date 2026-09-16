/**
 * CUÁNTO BAILA LA PUNTUACIÓN ENTRE TIRADAS.
 *
 *   node tools/dispersion-de-la-puntuacion.js <viajeId> [tiradas] [--sin-temperatura]
 *
 * Le hace al modelo la MISMA pregunta N veces —el paso 1 de la fase de ciudades,
 * el que asigna `peso` y el rango de noches a cada candidata— y cuenta cuánto
 * cambia la respuesta sin que haya cambiado nada en la pregunta.
 *
 * POR QUÉ ESTO Y NO MIRAR TRES VIAJES. Porque tres viajes seguidos son tres
 * anécdotas: sirven para sospechar, no para decidir. Y lo que hay que decidir es
 * si la rúbrica que viene detrás merece la pena y cuánto queda por ganar después
 * de arreglar lo barato. Sin un número antes y un número después, eso se discute
 * por intuición.
 *
 * QUÉ SE MIDE Y POR QUÉ ESOS CAMPOS:
 *
 *   · `peso` es el que más daño hace. No es decorativo: el peso MÁXIMO de la
 *     lista decide qué repartos de noches son legales —`repartosLegales` descarta
 *     entero cualquier reparto que no incluya a esa ciudad—, así que una ciudad
 *     que baila de 3 a 2 entre tiradas puede cambiar quién manda y con ello la
 *     ruta completa. Por eso se mide aparte «cuántas veces cambió quién es el
 *     peso máximo»: es la métrica que de verdad duele.
 *   · el RANGO DE NOCHES sale de la misma llamada y el prompt no tiene ni una
 *     regla que explique cómo calcularlo. Se mide para saber de dónde se parte.
 *   · la PRESENCIA de cada ciudad: que una candidata aparezca en 5 de 5 tiradas o
 *     en 2 de 5 es otra forma de inestabilidad, y no se ve mirando solo los pesos
 *     de las que salieron.
 *
 * NO ESCRIBE NADA. Ni en el viaje, ni en el registro, ni en el catálogo. Usa el
 * viaje solo como juego de datos de entrada: destino, fechas, viajeros, ritmo,
 * intereses.
 *
 * SE PREGUNTA CON EL PROMPT DE VERDAD, no con una copia: el armado sale de
 * `datosDelPaso1()`, que es la misma función que usa el orquestador, y la
 * plantilla de `prompts_orquestador`. Si mañana alguien cambia el prompt, esto
 * mide el prompt nuevo.
 *
 * `--sin-temperatura` omite `temperature` en la petición, que es como se ha
 * llamado a la API toda la vida de este programa. Es la forma de medir el ANTES
 * sin tener que revertir el código.
 */

import { una, normalizarNombre } from '../db/index.js';
import { consultarJSON, temperaturaAlPuntuar, hayClaveIA, SIN_CLAVE } from '../lib/ia.js';
import { promptDeFase } from '../services/orquestador.js';
import { mismoPeso } from '../services/rubrica-ciudades.js';
import {
  partirPrompt,
  rellenar,
  datosDelPaso1,
  saneaCandidatas,
} from '../services/orquestador-ciudades.js';

const viajeId = Number(process.argv[2]);
const tiradas = Number(process.argv[3]) || 5;
const sinTemperatura = process.argv.includes('--sin-temperatura');

if (!Number.isInteger(viajeId) || viajeId <= 0) {
  console.error('Uso: node tools/dispersion-de-la-puntuacion.js <viajeId> [tiradas] [--sin-temperatura]');
  process.exit(1);
}
if (!hayClaveIA()) {
  console.error(SIN_CLAVE);
  process.exit(1);
}

const viaje = una('SELECT * FROM viajes WHERE id = ?', viajeId);
if (!viaje) {
  console.error(`No existe el viaje ${viajeId}.`);
  process.exit(1);
}

const partes = partirPrompt(promptDeFase('ciudades_y_noches'));
const { datos, maxCiudades } = datosDelPaso1(viaje);
const prompt = rellenar(partes.candidatas, datos);

const temperatura = sinTemperatura ? null : temperaturaAlPuntuar();

console.log(`Viaje ${viaje.id} · ${viaje.destino} · ${datos.DIAS} días, ${datos.NOCHES} noches`);
console.log(`Ritmo: ${datos.RITMO} · Intereses: ${datos.INTERESES}`);
console.log(
  `${tiradas} tirada(s), modelo «criterio», temperatura: ` +
    (temperatura === null ? 'NO SE MANDA (como siempre ha ido)' : temperatura)
);
console.log(`Prompt: ${prompt.length} caracteres.\n`);

// --- AGRUPAR POR CIUDAD, NO POR NOMBRE --------------------------------------
//
// La primera versión de esto contaba nombres y salía un disparate: «quién manda»
// daba 5 respuestas distintas en 5 tiradas… porque la capital volvía como «Túnez
// capital», «Túnez (capital)», «Túnez (ciudad)» y «Túnez». Contar eso como
// cuatro ciudades distintas convierte una medición en un adorno.
//
// Y NO ES UN PROBLEMA DE LA MEDICIÓN, ES UNO DE VERDAD. `saneaCandidatas` se
// queda el nombre tal cual, y aguas abajo `puntos_interes` es único por
// `(destino_id, nombre_norm)`: dos nombres del mismo sitio son dos fichas de
// catálogo, dos investigaciones y dos juegos de sitios. Así que aquí se agrupa
// para poder medir lo que se quería medir, y aparte se ENSEÑAN las variantes,
// que es el hallazgo.
//
// El agrupado es deliberadamente tonto —quitar paréntesis y un par de palabras
// genéricas— porque una heurística lista escondería justo lo que hay que ver.
const GENERICAS = /\b(capital|ciudad|centro|casco antiguo)\b/g;
const claveDeCiudad = (n) =>
  normalizarNombre(
    String(n)
      .replace(/\([^)]*\)/g, ' ')
      .toLowerCase()
      .replace(GENERICAS, ' ')
  ).replace(/[^a-z0-9]/g, '');

// DESDE LA RÚBRICA, LO QUE HAY QUE MEDIR SON LAS CASILLAS.
//
// El peso ya no lo dice el modelo: lo calcula el código a partir de la evidencia,
// así que medir su estabilidad sería medir mi propia aritmética y saldría
// perfecto sin significar nada. Lo único que puede bailar ahora es QUÉ CASILLAS
// marca, y eso es lo que se cuenta aquí. El peso se sigue enseñando, pero como
// consecuencia, no como medida.
const porCiudad = new Map(); // clave -> { nombres:Set, pesos:[], min:[], max:[], casillas:Map }
const maximos = []; // quién fue la ciudad de peso máximo en cada tirada
const fallos = [];

for (let i = 1; i <= tiradas; i++) {
  process.stdout.write(`  tirada ${i}/${tiradas}… `);
  let ciudades;
  try {
    const r = await consultarJSON(prompt, {
      maxTokens: 4000,
      paso: `medir candidatas de ${datos.DESTINO}`,
      // Fuera de una fase, `claseDeLaLlamada` devolvería «rapido». La producción
      // llama a esto dentro de la fase, con modelo_ciudades_y_noches = criterio.
      modelo: 'criterio',
      ...(temperatura === null ? {} : { temperatura }),
    });
    ({ ciudades } = saneaCandidatas(r, maxCiudades));
  } catch (err) {
    console.log(`falló (${err.message})`);
    fallos.push(err.message);
    continue;
  }

  for (const c of ciudades) {
    const k = claveDeCiudad(c.nombre);
    if (!porCiudad.has(k)) {
      porCiudad.set(k, { nombres: new Set(), pesos: [], min: [], max: [], casillas: new Map() });
    }
    const v = porCiudad.get(k);
    v.nombres.add(c.nombre);
    v.pesos.push(c.peso);
    v.min.push(c.nochesMin);
    v.max.push(c.nochesMax);
    for (const casilla of Object.keys(c.evidencia ?? {})) {
      v.casillas.set(casilla, (v.casillas.get(casilla) ?? 0) + 1);
    }
  }

  // «Quién manda» se decide con la MISMA holgura que usa la producción: con
  // puntuación continua, la igualdad exacta convertiría cada empate real en un
  // ganador único y el numero dejaria de significar lo mismo que dentro del motor.
  const tope = Math.max(...ciudades.map((c) => c.peso));
  const mandan = [
    ...new Set(
      ciudades.filter((c) => mismoPeso(c.peso, tope)).map((c) => claveDeCiudad(c.nombre))
    ),
  ].sort();
  maximos.push(mandan.join(' + '));

  const corto = (x) => (Number.isInteger(x) ? x : x.toFixed(1));
  console.log(
    `${ciudades.length} ciudades · manda ${mandan.join(' + ')} (${corto(tope)} pts) · ` +
      ciudades.map((c) => `${c.nombre} ${corto(c.peso)}`).join(', ')
  );
}

const buenas = tiradas - fallos.length;
if (buenas < 2) {
  console.error(`\nSolo ${buenas} tirada(s) buena(s): no hay con qué comparar.`);
  process.exit(1);
}

// --- EL RECUENTO ------------------------------------------------------------
const moda = (a) => {
  const n = new Map();
  for (const x of a) n.set(x, (n.get(x) ?? 0) + 1);
  return [...n.entries()].sort((p, q) => q[1] - p[1])[0];
};

console.log(`\n${'='.repeat(78)}`);
console.log(`DISPERSIÓN SOBRE ${buenas} TIRADA(S) BUENAS\n`);
console.log('ciudad                      sale en   peso            rango de noches');
console.log('-'.repeat(78));

const filas = [...porCiudad.entries()].sort((a, b) => b[1].pesos.length - a[1].pesos.length);
let pesosQueBailan = 0;
let rangosQueBailan = 0;
let casillasQueBailan = 0;
let casillasEnTotal = 0;

for (const [, v] of filas) {
  const nombre = [...v.nombres][0];
  const pmin = Math.min(...v.pesos);
  const pmax = Math.max(...v.pesos);
  const [pmoda, veces] = moda(v.pesos);
  const baila = pmax > pmin;
  if (baila) pesosQueBailan += 1;

  const rangos = v.min.map((m, i) => `${m}-${v.max[i]}`);
  const rangoBaila = new Set(rangos).size > 1;
  if (rangoBaila) rangosQueBailan += 1;

  const redondo = (x) => (Number.isInteger(x) ? String(x) : x.toFixed(1));
  console.log(
    nombre.slice(0, 26).padEnd(28) +
      `${String(v.pesos.length).padStart(2)}/${buenas}`.padEnd(10) +
      (baila ? `${redondo(pmin)}–${redondo(pmax)}` : `${redondo(pmoda)} siempre`).padEnd(16) +
      (rangoBaila ? [...new Set(rangos)].join(' / ') : `${rangos[0]} siempre`)
  );

  // LAS CASILLAS, QUE SON LO QUE DE VERDAD SE MIDE. Una que sale en todas las
  // tiradas es evidencia firme; una que sale en la mitad es justo el sitio por
  // donde la rubrica sigue temblando.
  const firmes = [...v.casillas.entries()].sort((a, b) => b[1] - a[1]);
  if (firmes.length) {
    console.log(
      '      ' +
        firmes
          .map(([c, n]) => `${c.replace(/_/g, ' ')} ${n}/${v.pesos.length}${n === v.pesos.length ? '' : ' (!)'}`)
          .join(' · ')
    );
    const inestables = firmes.filter(([, n]) => n < v.pesos.length).length;
    if (inestables) casillasQueBailan += inestables;
    casillasEnTotal += firmes.length;
  }
}

const [modaMax, vecesMax] = moda(maximos);
const distintos = new Set(maximos).size;

console.log(`\n${'-'.repeat(78)}`);
console.log(`Ciudades propuestas alguna vez : ${filas.length}`);
console.log(`  siempre presentes            : ${filas.filter(([, v]) => v.pesos.length === buenas).length}`);
console.log(`  a veces sí y a veces no      : ${filas.filter(([, v]) => v.pesos.length < buenas).length}`);
console.log(
  `CASILLAS que bailan            : ${casillasQueBailan} de ${casillasEnTotal}` +
    '   <- ESTA es la medida de la rubrica'
);
console.log(`Pesos que bailan (consecuencia): ${pesosQueBailan} de ${filas.length}`);
console.log(`Rangos de noches que bailan    : ${rangosQueBailan} de ${filas.length}`);
console.log(
  `QUIÉN MANDA (peso máximo)      : ${distintos} respuesta(s) distinta(s) en ${buenas} tiradas` +
    ` — la más repetida, «${modaMax}», ${vecesMax} vez/veces`
);
if (distintos > 1) {
  console.log(
    '\n  OJO: ésta es la que decide la ruta. `repartosLegales` descarta entero\n' +
      '  cualquier reparto que no incluya a la ciudad de peso máximo, así que\n' +
      '  cambiar de mandamás entre tiradas no mueve las noches: mueve el viaje.'
  );
}

// --- LA MISMA CIUDAD CON VARIOS NOMBRES -------------------------------------
//
// Aguas abajo esto no es cosmético: `puntos_interes` es único por
// `(destino_id, nombre_norm)`, así que cada variante es una ficha de catálogo
// distinta, con su investigación y sus sitios.
const conVariantes = filas.filter(([, v]) => v.nombres.size > 1);
if (conVariantes.length) {
  console.log('\nLA MISMA CIUDAD, DEVUELTA CON VARIOS NOMBRES:');
  for (const [, v] of conVariantes) {
    console.log(`  · ${[...v.nombres].join('  ·  ')}`);
  }
  console.log(
    '  Agrupadas aquí para poder medir. El motor NO las agrupa: cada nombre\n' +
      '  distinto es otra fila de puntos_interes y otra investigación de la ciudad.'
  );
}

// Y las que se PARECEN mucho pero el agrupado no ha juntado: casi siempre son la
// misma también, y se dicen sin juntarlas para no fingir una certeza que no hay.
const claves = filas.map(([k]) => k);
const parecidas = [];
for (let i = 0; i < claves.length; i++) {
  for (let j = i + 1; j < claves.length; j++) {
    const a = claves[i];
    const b = claves[j];
    if (Math.abs(a.length - b.length) > 2) continue;
    const corto = a.length < b.length ? a : b;
    const largo = a.length < b.length ? b : a;
    if (!largo.includes(corto) && distancia(a, b) > 2) continue;
    parecidas.push([filas[i][1], filas[j][1]]);
  }
}
if (parecidas.length) {
  console.log('\nNOMBRES QUE SE PARECEN Y NO SE HAN JUNTADO (míralos tú):');
  for (const [a, b] of parecidas) {
    console.log(`  · «${[...a.nombres].join('/')}»  vs  «${[...b.nombres].join('/')}»`);
  }
}

function distancia(a, b) {
  const d = Array.from({ length: a.length + 1 }, (_, i) => [i, ...Array(b.length).fill(0)]);
  for (let j = 0; j <= b.length; j++) d[0][j] = j;
  for (let i = 1; i <= a.length; i++) {
    for (let j = 1; j <= b.length; j++) {
      d[i][j] = Math.min(
        d[i - 1][j] + 1,
        d[i][j - 1] + 1,
        d[i - 1][j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1)
      );
    }
  }
  return d[a.length][b.length];
}

if (fallos.length) console.log(`\n${fallos.length} tirada(s) fallaron: ${fallos.join(' · ')}`);
