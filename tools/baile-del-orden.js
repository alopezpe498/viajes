/**
 * ¿BAILA EL ORDEN DE LOS IMPRESCINDIBLES?
 *
 *   node tools/baile-del-orden.js [veces] [ciudad...]
 *
 * LA MEDICIÓN QUE FALTABA, Y ESTÁ EN LA BASE DE TODO.
 *
 * Toda la rúbrica de sitios arranca de una premisa que se escribió como un
 * hecho y nunca se comprobó: «el orden lo escribe el modelo de un tirón, sin
 * evidencia y sin criterios, así que baila». Se midió cinco veces el baile de la
 * RÚBRICA. El de `orden`, ninguna.
 *
 * Y no es un detalle: de ese orden sale HOY la jerarquía entera del reparto
 * —los tres primeros son intocables, los siete siguientes imprescindibles— y en
 * la simulación de las tres vías se vio que acierta justo donde la rúbrica
 * falla (la Torre Blanca, Ano Poli, la Acrópolis de Nafplio).
 *
 * QUÉ SE MIRA, y solo esto:
 *
 *   · si el TOP-3 es el mismo conjunto entre tiradas — es lo que decide quién es
 *     intocable, y lo único que de verdad cambia lo que hace el motor;
 *   · si además sale en el mismo orden;
 *   · cuánto se mueve cada sitio de posición.
 *
 * SOLO LEE Y COMPARA. No guarda nada ni toca el catálogo.
 */

import { todas, una } from '../db/index.js';
import { hayClaveIA, SIN_CLAVE, consultarJSON, temperaturaAlPuntuar } from '../lib/ia.js';
import { promptDeCiudad } from '../services/descubrir.js';

const VECES = Number(process.argv[2]) || 5;
const CIUDADES = process.argv.slice(3).length ? process.argv.slice(3) : ['Atenas', 'Nafplio'];

if (!hayClaveIA()) {
  console.error(SIN_CLAVE);
  process.exit(1);
}

const norm = (t) =>
  String(t ?? '').toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '').trim();

console.log(`# ¿BAILA EL ORDEN DE LOS IMPRESCINDIBLES?\n`);
console.log(`${VECES} tiradas de la misma pregunta · temperatura ${temperaturaAlPuntuar()}\n`);

for (const ciudad of CIUDADES) {
  const punto = una(
    'SELECT * FROM puntos_interes WHERE nombre = ? ORDER BY id DESC LIMIT 1',
    ciudad
  );
  if (!punto) {
    console.error(`No existe «${ciudad}» en el catálogo.`);
    continue;
  }
  const destino = punto.destino_id
    ? una('SELECT nombre FROM destinos WHERE id = ?', punto.destino_id)
    : null;

  const listas = [];
  for (let n = 1; n <= VECES; n += 1) {
    try {
      const r = await consultarJSON(
        promptDeCiudad(punto, destino?.nombre ?? ciudad, 'imprescindibles'),
        {
          maxTokens: 6000,
          paso: `baile del orden · ${ciudad} · tirada ${n}`,
          temperatura: temperaturaAlPuntuar(),
        }
      );
      const nombres = (Array.isArray(r?.sitios) ? r.sitios : []).map((s) => String(s?.nombre ?? ''));
      listas.push(nombres.filter(Boolean));
    } catch (err) {
      console.error(`  ${ciudad} tirada ${n}: falló (${err.message})`);
    }
    process.stderr.write(`  ${ciudad}: tirada ${n} de ${VECES}\n`);
  }

  if (listas.length < 2) continue;

  console.log(`\n## ${ciudad}\n`);
  listas.forEach((l, i) => {
    console.log(`  tirada ${i + 1}: ${l.slice(0, 3).join(' · ')}`);
  });

  // EL TOP-3, que es lo único que cambia lo que hace el motor.
  const tops = listas.map((l) => new Set(l.slice(0, 3).map(norm)));
  const mismoConjunto = tops.every(
    (t) => t.size === tops[0].size && [...t].every((x) => tops[0].has(x))
  );
  const mismoOrden = listas.every(
    (l) => l.slice(0, 3).map(norm).join('|') === listas[0].slice(0, 3).map(norm).join('|')
  );
  console.log(`\n  TOP-3 mismo conjunto: ${mismoConjunto ? 'SÍ' : 'NO'} · mismo orden: ${mismoOrden ? 'SÍ' : 'NO'}`);

  // Cuánto se mueve cada sitio de posición entre tiradas.
  const posiciones = new Map();
  listas.forEach((l) => {
    l.forEach((nom, i) => {
      const k = norm(nom);
      if (!posiciones.has(k)) posiciones.set(k, { nombre: nom, pos: [] });
      posiciones.get(k).pos.push(i + 1);
    });
  });

  const enTodas = [...posiciones.values()].filter((p) => p.pos.length === listas.length);
  const clavados = enTodas.filter((p) => new Set(p.pos).size === 1);
  console.log(
    `  ${posiciones.size} sitios distintos nombrados · ${enTodas.length} salen en las ${listas.length} tiradas · ` +
      `${clavados.length} en la MISMA posición siempre`
  );

  const movidos = enTodas
    .map((p) => ({ ...p, salto: Math.max(...p.pos) - Math.min(...p.pos) }))
    .filter((p) => p.salto > 0)
    .sort((a, b) => b.salto - a.salto);

  if (movidos.length) {
    console.log('\n  Los que se mueven de sitio:');
    for (const m of movidos.slice(0, 10)) {
      console.log(`    ${m.nombre.slice(0, 40).padEnd(42)} posiciones ${m.pos.join('/')}  (salto ${m.salto})`);
    }
  }

  const soloAveces = [...posiciones.values()].filter((p) => p.pos.length < listas.length);
  if (soloAveces.length) {
    console.log(`\n  Nombrados solo en algunas tiradas (${soloAveces.length}):`);
    for (const s of soloAveces.slice(0, 8)) {
      console.log(`    ${s.nombre.slice(0, 40).padEnd(42)} ${s.pos.length} de ${listas.length} veces`);
    }
  }
}
