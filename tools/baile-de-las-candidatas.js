/**
 * ¿BAILA EL PASO DE LAS CANDIDATAS?
 *
 *   node tools/baile-de-las-candidatas.js [veces] [viajeId]
 *
 * LA MEDICIÓN QUE FALTA, Y CUESTA CIUDADES ENTERAS.
 *
 * El Grecia de control lo destapó sin buscarlo. Mismo destino, mismas fechas,
 * misma app, dos generaciones seguidas:
 *
 *     viaje 110:  Atenas 2n → Nafplio 2n → Tesalónica 2n
 *     viaje 112:  Atenas 4n → Tesalónica 2n
 *
 * Nafplio no se cayó por mérito: se cayó porque en el 110 la IA le dio a Atenas
 * un rango de 2-3 noches y en el 112 le dio 3-4. Con seis noches, eso es la
 * diferencia entre tres ciudades y dos. Nadie eligió perder Nafplio.
 *
 * Y ES EL MISMO AGUJERO QUE YA TENÍA EL `orden` DE LOS SITIOS antes de medirlo:
 * un número que sale de un tirón del modelo, que decide mucho, y del que se
 * suponía el comportamiento en vez de comprobarlo. Allí la medida dijo que era
 * estable y salvó de un cambio malo; aquí no sabemos nada.
 *
 * QUÉ SE MIRA, y solo esto:
 *
 *   · QUÉ CIUDADES salen, y cuáles salen siempre.
 *   · EL RANGO DE NOCHES de cada una, que es lo que de verdad decide cuántas
 *     ciudades caben. Es la medida importante: los pesos pueden bailar un poco
 *     sin consecuencias, pero un mínimo que sube de 2 a 3 borra una parada.
 *   · CUÁNTAS CIUDADES CABEN en las noches del viaje según cada tirada, que es
 *     traducir lo anterior a lo único que se nota en el plan.
 *
 * LA LLAMADA ES LA DE VERDAD, con sus cinco ingredientes: el prompt de la fase
 * partido por `partirPrompt`, los datos de `datosDelPaso1`, los ajustes del
 * texto libre, los multiplicadores del perfil y la temperatura de puntuar. Van
 * los cinco porque replicar una llamada con uno de menos mide otra cosa, y eso
 * ya ha pasado cuatro veces en este proyecto.
 *
 * Y VA DENTRO DE `enFase`, QUE ES EL SEXTO INGREDIENTE Y CASI SE ME ESCAPA.
 * `claseDeLaLlamada` elige el modelo por FASE: fuera de una fase contesta
 * 'rapido'. La primera tirada de esta herramienta fue con Haiku mientras
 * producción usa Sonnet —`modelo_ciudades_y_noches` está en criterio— y midió
 * otra cosa: proponía islas (Rodas, Santorini, Mykonos) y ocho candidatas,
 * cuando las dos corridas reales dan tierra firme y seis. Lo delató el log de
 * modelo por llamada que se puso hoy: «· rapido (heredado de la fase)».
 *
 * SOLO LEE Y COMPARA. No guarda nada ni toca el catálogo.
 */

import { todas, una } from '../db/index.js';
import { hayClaveIA, SIN_CLAVE, consultarJSON, temperaturaAlPuntuar } from '../lib/ia.js';
import { partirPrompt, datosDelPaso1, saneaCandidatas } from '../services/orquestador-ciudades.js';
import { rellenar } from '../services/orquestador-dormir.js';
import { multiplicadoresDe, ajustesDelTextoLibre } from '../services/rubrica-ciudades.js';
import { promptDeFase } from '../services/orquestador.js';
import { enFase } from '../services/fase-actual.js';

const VECES = Number(process.argv[2]) || 5;
const VIAJE_ID = Number(process.argv[3]) || null;

if (!hayClaveIA()) {
  console.error(SIN_CLAVE);
  process.exit(1);
}

const viaje = VIAJE_ID
  ? una('SELECT * FROM viajes WHERE id = ?', VIAJE_ID)
  : una('SELECT * FROM viajes WHERE fecha_inicio IS NOT NULL ORDER BY id DESC LIMIT 1');

if (!viaje) {
  console.error('No hay ningún viaje con fechas del que copiar los datos.');
  process.exit(1);
}

const partes = partirPrompt(promptDeFase('ciudades_y_noches'));
const { datos, auto, maxCiudades, nochesTotales, minimoNoches } = datosDelPaso1(viaje);
const ajustes = await ajustesDelTextoLibre(viaje, auto.intereses, () => {});
const multiplicadores = multiplicadoresDe({ categorias: auto.categorias, ajustes });

console.error(`Midiendo ${VECES} tiradas · ${viaje.destino} · ${nochesTotales} noches…`);

const tiradas = [];
await enFase(viaje.id, 'ciudades_y_noches', async () => {
  for (let n = 1; n <= VECES; n += 1) {
    try {
      const r = await consultarJSON(rellenar(partes.candidatas, datos), {
        maxTokens: 4000,
        paso: `baile de las candidatas · tirada ${n}`,
        temperatura: temperaturaAlPuntuar(),
      });
      tiradas.push(saneaCandidatas(r, maxCiudades, multiplicadores).ciudades);
    } catch (err) {
      console.error(`  tirada ${n}: falló (${err.message})`);
    }
    process.stderr.write(`  tirada ${n} de ${VECES}\n`);
  }
});

if (tiradas.length < 2) {
  console.error('Con menos de dos tiradas no hay nada que comparar.');
  process.exit(1);
}

// =============================================================================
// LA COMPARACIÓN
// =============================================================================
console.log('# ¿BAILA EL PASO DE LAS CANDIDATAS?\n');
console.log(`${tiradas.length} tiradas de la misma pregunta · ${viaje.destino} · ${nochesTotales} noches`);
console.log(`temperatura ${temperaturaAlPuntuar()} · la llamada de producción, con sus cinco ingredientes\n`);

// --- Qué ciudades salen ------------------------------------------------------
const vistas = new Map(); // nombre -> [{peso, min, max, puerta}]
for (const t of tiradas) {
  for (const c of t) {
    if (!vistas.has(c.nombre)) vistas.set(c.nombre, []);
    vistas.get(c.nombre).push({ peso: c.peso, min: c.nochesMin, max: c.nochesMax, puerta: c.puerta });
  }
}

const siempre = [...vistas.entries()].filter(([, v]) => v.length === tiradas.length);
console.log(`## LAS CIUDADES\n`);
console.log(`  ${vistas.size} ciudades distintas nombradas · ${siempre.length} salen en TODAS las tiradas\n`);

for (const t of tiradas.entries()) {
  console.log(`  tirada ${t[0] + 1}: ${t[1].map((c) => `${c.nombre} ${c.nochesMin}-${c.nochesMax}n`).join(' · ')}`);
}

// --- EL RANGO DE NOCHES, que es lo que decide cuántas caben ------------------
console.log(`\n## EL RANGO DE NOCHES — lo que de verdad decide cuántas ciudades caben\n`);
const filas = [...vistas.entries()]
  .map(([nombre, v]) => {
    const mins = v.map((x) => x.min);
    const maxs = v.map((x) => x.max);
    return {
      nombre,
      veces: v.length,
      mins: [...new Set(mins)].sort((a, b) => a - b),
      maxs: [...new Set(maxs)].sort((a, b) => a - b),
      pesoMin: Math.min(...v.map((x) => x.peso)),
      pesoMax: Math.max(...v.map((x) => x.peso)),
      firme: new Set(mins).size === 1 && new Set(maxs).size === 1,
    };
  })
  .sort((a, b) => b.veces - a.veces || b.pesoMax - a.pesoMax);

for (const f of filas) {
  const rango = f.firme
    ? `${f.mins[0]}-${f.maxs[0]}n clavado`
    : `mín ${f.mins.join('/')} · máx ${f.maxs.join('/')}   <- BAILA`;
  console.log(
    `  ${f.nombre.slice(0, 20).padEnd(22)} ${String(f.veces + '/' + tiradas.length).padEnd(5)} ` +
      `peso ${f.pesoMin.toFixed(1)}${f.pesoMax !== f.pesoMin ? `-${f.pesoMax.toFixed(1)}` : ''}`.padEnd(16) +
      rango
  );
}

// --- Y LO ÚNICO QUE SE NOTA EN EL PLAN --------------------------------------
//
// El rango solo importa por esto: cuántas paradas caben en las noches que hay.
// Se cuenta metiendo ciudades por peso —que es el orden en el que el reparto las
// mira— hasta que no quepa otra con su mínimo.
//
// Y ANTES SE TIRAN LAS DE MENOS DE `minimo_noches_por_ciudad`, que es lo que hace
// producción y a mí se me olvidó en la primera versión: decía «caben 4» contando
// a Delfos y Olimpia, que el motor aparta con un «fuera de la ruta por no llegar
// a 2 noches (son excursiones de un día)». Contar las que el reparto ni mira no
// mide el plan, mide otra cosa.
console.log(`\n## CUÁNTAS CIUDADES CABEN EN ${nochesTotales} NOCHES, según cada tirada`);
console.log(`   (solo las de ${minimoNoches}+ noches: las de una noche el motor las aparta como excursión)\n`);
const cabenPorTirada = tiradas.map((t) => {
  const porPeso = [...t].filter((c) => c.nochesMax >= minimoNoches).sort((a, b) => b.peso - a.peso);
  const dentro = [];
  let usadas = 0;
  for (const c of porPeso) {
    if (usadas + Math.max(c.nochesMin, minimoNoches) > nochesTotales) continue;
    dentro.push(c);
    usadas += Math.max(c.nochesMin, minimoNoches);
  }
  return dentro;
});

cabenPorTirada.forEach((d, i) => {
  console.log(
    `  tirada ${i + 1}: ${d.length} ciudad(es) — ${d.map((c) => `${c.nombre} ${Math.max(c.nochesMin, minimoNoches)}n`).join(' + ')}`
  );
});

const cuentas = [...new Set(cabenPorTirada.map((d) => d.length))].sort();
console.log(
  `\n  ${cuentas.length === 1 ? `SIEMPRE caben ${cuentas[0]}. El plan no depende de la tirada.` : `CABEN ENTRE ${cuentas[0]} Y ${cuentas.at(-1)}. El número de paradas lo decide la tirada.`}`
);
