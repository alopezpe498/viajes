/**
 * ¿QUÉ SITIOS ENTRAN EN EL CATÁLOGO DE UNA CIUDAD, Y CUÁNTO CAMBIA ESO?
 *
 *   node tools/baile-de-la-seleccion.js [veces] [viajeId] [ciudad]
 *
 * LA PREGUNTA BUENA, Y LA MEDICIÓN QUE HAY QUE HACER BIEN.
 *
 * El catálogo de una ciudad es UNA tirada de un proceso que puede devolver
 * cosas distintas cada vez. Lo que importa saber es QUÉ baila:
 *
 *   · si lo que cambia es el relleno del puesto 7 al 20, da igual: esos no
 *     deciden nada y el reparto los trata a todos como segundo nivel;
 *   · si baila algo de PRIMER ORDEN —un top-3, o sea un intocable— entonces el
 *     viaje que te toque depende de la tirada, y eso sí importa.
 *
 * Y SE MIDE LA LLAMADA DE VERDAD, que es donde me equivoqué tres veces seguidas
 * midiendo variantes mías. `investigarCiudadConIA` con el `sesgo` real del viaje
 * y sus dos bloques —imprescindibles y otros—, exactamente como la fase.
 *
 * NO GUARDA NADA: `guardarFichaProfunda` no se llama. Solo compara y escribe en
 * pantalla.
 */

import { todas, una } from '../db/index.js';
import { hayClaveIA, SIN_CLAVE } from '../lib/ia.js';
import { investigarCiudadConIA } from '../services/descubrir.js';
import { sesgoDeIntereses } from '../services/orquestador-sitios.js';
import { configAuto, promptDeFase } from '../services/orquestador.js';
import { ocupacionDe } from '../services/proveedores.js';

const VECES = Number(process.argv[2]) || 3;
const VIAJE = Number(process.argv[3]) || null;
const CIUDAD = process.argv[4] || 'Nafplio';

if (!hayClaveIA()) {
  console.error(SIN_CLAVE);
  process.exit(1);
}

const viaje = VIAJE
  ? una('SELECT * FROM viajes WHERE id = ?', VIAJE)
  : una('SELECT * FROM viajes ORDER BY id DESC LIMIT 1');
if (!viaje) {
  console.error('No hay ningún viaje del que sacar el sesgo.');
  process.exit(1);
}

const punto = una('SELECT * FROM puntos_interes WHERE nombre = ? ORDER BY id DESC LIMIT 1', CIUDAD);
if (!punto) {
  console.error(`No existe «${CIUDAD}» en el catálogo.`);
  process.exit(1);
}
const destino = punto.destino_id
  ? una('SELECT nombre FROM destinos WHERE id = ?', punto.destino_id)
  : null;

const auto = configAuto(viaje);
const { edadesNinos } = ocupacionDe(viaje);
// El prompt de la fase, que es de donde  saca la redacción.
// Pasarle null —como hice en el primer intento— revienta, y es otra forma de
// medir una pregunta que la aplicación no hace.
const sesgo = sesgoDeIntereses(promptDeFase('sitios'), auto);

const norm = (t) =>
  String(t ?? '').toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '')
    .replace(/[^a-z0-9 ]/g, '').replace(/\s+/g, ' ').trim();

console.log(`# ¿BAILA LA SELECCIÓN DE SITIOS?\n`);
console.log(`${VECES} tiradas de \`investigarCiudadConIA\` · ${CIUDAD} · viaje ${viaje.id}`);
console.log(`sesgo: ${sesgo ? `${auto.intereses || '—'} · ${(auto.categorias ?? []).join(', ')}` : 'ninguno'}\n`);

const tiradas = [];
for (let n = 1; n <= VECES; n += 1) {
  try {
    const ficha = await investigarCiudadConIA(punto, destino?.nombre ?? CIUDAD, {
      edadesNinos,
      sesgo,
    });
    const imp = ficha.sitios.filter((s) => (s.bloque ?? 'imprescindibles') === 'imprescindibles');
    tiradas.push(imp.map((s) => s.nombre));
  } catch (err) {
    console.error(`  tirada ${n}: falló (${err.message})`);
  }
  process.stderr.write(`  tirada ${n} de ${VECES}\n`);
}

if (tiradas.length < 2) {
  console.error('No hay suficientes tiradas para comparar.');
  process.exit(1);
}

// --- EL TOP-3, que es lo que decide los intocables --------------------------
console.log('## EL TOP-3 DE CADA TIRADA — los que serían INTOCABLES\n');
tiradas.forEach((t, i) => console.log(`  ${i + 1}: ${t.slice(0, 3).join(' · ')}`));

const tops = tiradas.map((t) => new Set(t.slice(0, 3).map(norm)));
const nucleo = [...tops[0]].filter((x) => tops.every((s) => s.has(x)));
console.log(`\n  ${nucleo.length} de 3 salen en TODAS las tiradas.`);

// --- QUÉ APARECE SIEMPRE Y QUÉ A VECES, por tramo --------------------------
const vistos = new Map();
tiradas.forEach((t) => {
  t.forEach((nom, i) => {
    const k = norm(nom);
    if (!vistos.has(k)) vistos.set(k, { nombre: nom, veces: 0, pos: [] });
    const v = vistos.get(k);
    v.veces += 1;
    v.pos.push(i + 1);
  });
});

const todosLos = [...vistos.values()];
const siempre = todosLos.filter((v) => v.veces === tiradas.length);
const aVeces = todosLos.filter((v) => v.veces < tiradas.length);

console.log(`\n## CUÁNTO BAILA, Y DÓNDE\n`);
console.log(`  ${todosLos.length} sitios distintos nombrados en ${tiradas.length} tiradas`);
console.log(`  ${siempre.length} salen SIEMPRE · ${aVeces.length} salen solo a veces\n`);

// LO QUE DE VERDAD IMPORTA: ¿el que baila, baila arriba o abajo?
const mejorPos = (v) => Math.min(...v.pos);
const arriba = aVeces.filter((v) => mejorPos(v) <= 3);
const medio = aVeces.filter((v) => mejorPos(v) > 3 && mejorPos(v) <= 6);
const abajo = aVeces.filter((v) => mejorPos(v) > 6);

console.log(`  De los que bailan:`);
console.log(`    ${arriba.length} han llegado alguna vez al TOP-3  (serían intocables)`);
console.log(`    ${medio.length} entre el 4 y el 6`);
console.log(`    ${abajo.length} del 7 en adelante  (relleno: el reparto los trata igual)`);

if (arriba.length) {
  console.log(`\n  LOS QUE BAILAN ARRIBA — estos sí cambian el viaje:`);
  for (const v of arriba) {
    console.log(`    ${v.nombre.slice(0, 42).padEnd(44)} ${v.veces}/${tiradas.length} veces · posiciones ${v.pos.join(',')}`);
  }
}

console.log(`\n  Los que salen siempre:`);
for (const v of siempre.sort((a, b) => mejorPos(a) - mejorPos(b))) {
  console.log(`    ${v.nombre.slice(0, 42).padEnd(44)} posiciones ${v.pos.join(',')}`);
}
