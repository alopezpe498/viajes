/**
 * LOS CIERRES QUE EL PROMPT NO LLEGÓ A DECIR.
 *
 *   node tools/cierres-que-faltaron.js <viajeId>
 *
 * El reparto del lienzo le enseña a la IA una línea «CIERRA los …» por sitio,
 * pero solo la puede escribir si `cierra_dias` tiene valor —y ese campo se
 * calcula DESPUÉS de repartir, sobre lo que se colocó—. Resultado: cuando la IA
 * decide, medio catálogo figura sin días de cierre. Y no como «no lo sé», que
 * sería honesto, sino como «no cierra nunca», porque `diasDeCierre(null)`
 * devuelve la lista vacía.
 *
 * Esto no arregla nada ni escribe en la base. Recorre el catálogo de cada
 * parada, lee el horario que YA estaba descargado cuando se repartió, y enseña
 * tres cosas:
 *
 *   1. qué sitios habrían llevado una línea «CIERRA los …» y no la llevaron,
 *   2. cuáles de ellos acabaron colocados justo en un día que cierran,
 *   3. cuántos siguen sin poder saberse ni leyendo el texto.
 *
 * SE MIRA CONTRA EL RELOJ DEL REPARTO, NO CONTRA LA BASE DE HOY.
 *
 * Ésta es la trampa que se llevó la primera versión por delante y por la que
 * casi doy el diagnóstico por refutado: `asegurarCierres` rellena `cierra_dias`
 * al terminar la fase, así que hoy el Museo del Bardo tiene sus lunes puestos
 * —a las 16:30:16, 44 segundos DESPUÉS de que la IA lo colocara—. Preguntarle a
 * la base de hoy qué se sabía entonces contesta que sí y es mentira.
 *
 * El corte es `orquestador_fases.empezado_en` de la fase `lienzo`: lo que se
 * escribió después de ese instante no existía cuando se decidió.
 *
 * SOLO MIRA.
 */

import { todas, una } from '../db/index.js';
import { diasQueCierra } from '../services/horarios.js';
import { lienzoDeViaje } from '../services/lienzo.js';

const DIAS_SEMANA = ['domingo', 'lunes', 'martes', 'miércoles', 'jueves', 'viernes', 'sábado'];

const viajeId = Number(process.argv[2]);
if (!Number.isInteger(viajeId) || viajeId <= 0) {
  console.error('Uso: node tools/cierres-que-faltaron.js <viajeId>');
  process.exit(1);
}

const viaje = una('SELECT id, nombre FROM viajes WHERE id = ?', viajeId);
if (!viaje) {
  console.error(`No existe el viaje ${viajeId}.`);
  process.exit(1);
}

const etapas = todas(
  "SELECT * FROM etapas WHERE viaje_id = ? AND estado = 'confirmada' ORDER BY orden",
  viajeId
);

// EL INSTANTE EN QUE SE DECIDIÓ. Todo `cierra_en` posterior a esto es un dato
// que la IA no tuvo, por mucho que hoy esté en su fila.
const faseLienzo = una(
  "SELECT empezado_en FROM orquestador_fases WHERE viaje_id = ? AND fase = 'lienzo' ORDER BY id DESC",
  viajeId
);
const corte = faseLienzo?.empezado_en ?? null;
if (!corte) {
  console.error(`El viaje ${viajeId} no tiene fase «lienzo» registrada: no sé contra qué reloj mirar.`);
  process.exit(1);
}

/** ¿Estaba este cierre escrito ANTES de repartir? */
const seSabiaAlRepartir = (s) => s.cierra_dias !== null && s.cierra_en !== null && s.cierra_en <= corte;

console.log(`El reparto del viaje ${viajeId} empezó el ${corte}.`);
console.log('Lo escrito después de esa hora no lo tuvo la IA delante.');

// --- DÓNDE ACABÓ CADA SITIO -------------------------------------------------
//
// Por identidad, como en el resto de la casa: el candidato guarda de qué sitio
// del catálogo salió en `datos_extra.deId`.
const lienzo = lienzoDeViaje(viajeId);
const diaDeSitio = new Map();
for (const c of lienzo?.colocados ?? []) {
  if (!c.candidatoId) continue;
  const cand = una('SELECT datos_extra FROM candidatos WHERE id = ?', c.candidatoId);
  if (!cand) continue;
  let extra = null;
  try {
    extra = JSON.parse(cand.datos_extra ?? '{}');
  } catch {
    continue;
  }
  if (extra?.de !== 'sitio' || !extra?.deId) continue;
  const dia = lienzo.dias.find((d) => d.n === c.dia);
  diaDeSitio.set(Number(extra.deId), {
    n: c.dia,
    fecha: dia?.fecha ?? null,
    diaSemana: dia?.fecha ? new Date(`${dia.fecha}T12:00:00`).getDay() : null,
  });
}

const total = { sitios: 0, yaLoDecia: 0, faltaba: 0, ilegible: 0, sinTexto: 0, chocan: 0 };
const vistos = new Set();
const choques = [];

for (const etapa of etapas) {
  if (!etapa.punto_interes_id) continue;

  // El mismo catálogo y el mismo orden que arma `colocablesDeEtapa`.
  const sitios = todas(
    `SELECT * FROM sitios_lugar
      WHERE punto_interes_id = ?
        AND bloque IN ('imprescindibles', 'otros', 'ninos')
        AND cubierto_por IS NULL
      ORDER BY CASE bloque
                 WHEN 'imprescindibles' THEN 1
                 WHEN 'ninos' THEN 2
                 ELSE 3
               END, orden, id`,
    etapa.punto_interes_id
  );

  const lineas = [];
  for (const s of sitios) {
    // Una ciudad repetida (la parada de salida) no se cuenta dos veces.
    if (vistos.has(s.id)) continue;
    vistos.add(s.id);
    total.sitios += 1;

    if (!s.horarios) {
      total.sinTexto += 1;
      lineas.push(`  ·  ${s.nombre} — sin texto de horario: no hay nada que leer.`);
      continue;
    }

    const leidos = diasQueCierra(s.horarios);
    if (leidos === null) {
      total.ilegible += 1;
      lineas.push(`  ?  ${s.nombre} — el texto no deja saberlo; haría falta preguntar.`);
      continue;
    }
    if (!leidos.length) continue; // abre todos los días: no hay línea que escribir

    const texto = leidos.map((d) => DIAS_SEMANA[d]).join(' y ');
    if (seSabiaAlRepartir(s)) {
      total.yaLoDecia += 1;
      continue;
    }

    total.faltaba += 1;
    const donde = diaDeSitio.get(s.id);
    const choca = donde && donde.diaSemana !== null && leidos.includes(donde.diaSemana);
    if (choca) {
      total.chocan += 1;
      choques.push({ nombre: s.nombre, ciudad: etapa.nombre_ciudad, texto, donde });
    }

    lineas.push(
      `  ${choca ? '!!' : '->'} ${s.nombre} [${s.bloque}] — CIERRA los ${texto}` +
        (donde
          ? `   ·  colocado el día ${donde.n} (${DIAS_SEMANA[donde.diaSemana]} ${donde.fecha})` +
            (choca ? '  <<< EN SU DÍA DE CIERRE' : '')
          : '   ·  no se colocó')
    );
  }

  if (lineas.length) {
    console.log(`\n${etapa.nombre_ciudad} (${etapa.noches} noche/s)`);
    for (const l of lineas) console.log(l);
  }
}

console.log(`\n${'='.repeat(70)}`);
console.log(`Viaje ${viaje.id} · ${viaje.nombre ?? ''}`);
console.log(`  sitios de catálogo mirados            : ${total.sitios}`);
console.log(`  ya llevaban su «CIERRA los …»         : ${total.yaLoDecia}`);
console.log(`  LO HABRÍAN LLEVADO Y NO LO LLEVARON   : ${total.faltaba}`);
console.log(`  ... y de esos, colocados en su cierre : ${total.chocan}`);
console.log(`  no se puede leer sin preguntar        : ${total.ilegible}`);
console.log(`  sin texto de horario                  : ${total.sinTexto}`);

if (choques.length) {
  console.log('\nLo que el reparto no pudo saber, y le habría cambiado la decisión:');
  for (const c of choques) {
    console.log(
      `  · ${c.nombre} (${c.ciudad}) cierra los ${c.texto} y quedó puesto ` +
        `el ${DIAS_SEMANA[c.donde.diaSemana]} ${c.donde.fecha}.`
    );
  }
}
