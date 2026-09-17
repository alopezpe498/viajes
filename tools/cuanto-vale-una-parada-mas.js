/**
 * ¿CUÁNTO VALE UNA PARADA MÁS?
 *
 *   node tools/cuanto-vale-una-parada-mas.js <viajeA> <viajeB>
 *
 * LA PREGUNTA QUE NO SE PUEDE CONTESTAR A OJO, Y LA ÚNICA FORMA DE SABERLA.
 *
 * El reparto puntúa con `Σ(noches × peso)`, que dice sin ambigüedad: toda noche
 * sobrante, a la ciudad de más peso. Llevado al extremo, su óptimo para Grecia
 * en siete días es Atenas seis noches y nada más. Lo que mete una tercera ciudad
 * en el plan no es que el motor la valore: es que a la primera no le cabían más
 * noches por su techo declarado. Un accidente haciendo de criterio.
 *
 * Para decidir si eso está bien hay que saber CUÁNTO SE GANA Y CUÁNTO SE PIERDE
 * con una parada más, y eso no se estima: se cuenta sobre dos viajes ya hechos.
 * El 110 y el 112 son el experimento perfecto y salieron solos —mismo destino,
 * mismas fechas, misma ocupación, misma app— porque el mínimo de Atenas cayó de
 * un lado en uno y del otro en el otro.
 *
 * QUÉ SE CUENTA, y todo sale del itinerario de verdad, no de la puntuación:
 *
 *   · SITIOS VISTOS, y de qué nivel. Un viaje que enseña dos intocables más no
 *     es «un 3 % mejor»: es otro viaje.
 *   · LO QUE CUESTA: horas metidas en traslados entre ciudades, que son horas
 *     que no se están viendo nada.
 *   · LO QUE SOBRA: huecos sin llenar, que es la señal de que faltaba sitio
 *     donde ir.
 *   · LOS AVISOS que quedaron sin resolver.
 *
 * SOLO LEE. No toca nada ni llama a nadie.
 */

import { todas, una } from '../db/index.js';

const A = Number(process.argv[2]);
const B = Number(process.argv[3]);

if (!A || !B) {
  console.error('Hacen falta dos viajes: node tools/cuanto-vale-una-parada-mas.js 110 112');
  process.exit(1);
}

function radiografia(viajeId) {
  const viaje = una('SELECT * FROM viajes WHERE id = ?', viajeId);
  const etapas = todas(
    "SELECT * FROM etapas WHERE viaje_id = ? AND estado = 'confirmada' ORDER BY orden, id",
    viajeId
  );

  const filas = todas(
    `SELECT i.*, c.titulo, c.tipo
       FROM itinerario i LEFT JOIN candidatos c ON c.id = i.candidato_id
      WHERE i.viaje_id = ? ORDER BY i.dia, i.hora`,
    viajeId
  );

  // DE QUÉ NIVEL ES CADA COSA COLOCADA.
  //
  // El itinerario guarda el candidato, no el sitio del catálogo, así que se
  // reconcilia por nombre contra `sitios_lugar` de la parada. Es lo mismo que
  // hace el propio motor para saber si un imprescindible se quedó fuera.
  const norm = (t) =>
    String(t ?? '').toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '').trim();

  const porEtapa = new Map(etapas.map((e) => [e.id, e]));
  const catalogo = new Map();
  for (const e of etapas) {
    if (!e.punto_interes_id) continue;
    for (const s of todas(
      "SELECT nombre, bloque, orden FROM sitios_lugar WHERE punto_interes_id = ? AND bloque <> 'busqueda'",
      e.punto_interes_id
    )) {
      catalogo.set(`${e.id}|${norm(s.nombre)}`, s);
    }
  }

  let intocables = 0;
  let imprescindibles = 0;
  let segundoNivel = 0;
  let excursiones = 0;
  let comidas = 0;
  let minutosVisita = 0;

  for (const f of filas) {
    const nombre = f.titulo ?? f.texto_manual ?? '';
    if (/^Comer/i.test(nombre)) {
      comidas += 1;
      continue;
    }
    if (f.tipo === 'actividad') {
      excursiones += 1;
      minutosVisita += Number(f.duracion_min) || 0;
      continue;
    }
    const s = catalogo.get(`${f.etapa_id}|${norm(nombre)}`);
    minutosVisita += Number(f.duracion_min) || 0;
    if (!s) continue;
    if (s.bloque === 'imprescindibles' && s.orden <= 3) intocables += 1;
    else if (s.bloque === 'imprescindibles') imprescindibles += 1;
    else segundoNivel += 1;
  }

  // LO QUE CUESTA MOVERSE ENTRE CIUDADES, que es el precio de una parada más.
  //
  // Se cuentan solo los SALTOS —los tramos entre dos etapas—, no el vuelo de ida
  // ni el de vuelta: esos se pagan igual con dos paradas que con cinco, así que
  // meterlos taparía justo lo que se quiere medir. Y se usa el `total` del
  // bloque, que es puerta a puerta —acceso, antelación, trayecto y salida—, no
  // el trayecto pelado: dos horas de tren con hora y media de estación alrededor
  // son tres horas y media que no se está viendo nada.
  const traslados = todas(
    "SELECT datos_extra FROM transportes WHERE viaje_id = ? AND etapa_origen_id IS NOT NULL AND etapa_destino_id IS NOT NULL",
    viajeId
  ).map((t) => {
    try {
      return JSON.parse(t.datos_extra ?? '{}')?.bloque?.total ?? null;
    } catch {
      return null;
    }
  }).filter((x) => x != null);
  const minutosTraslado = traslados.reduce((a, m) => a + m, 0);

  const avisos = todas('SELECT severidad FROM avisos WHERE viaje_id = ?', viajeId);

  return {
    viajeId,
    destino: viaje.destino,
    ruta: etapas.map((e) => `${e.nombre_ciudad} ${e.noches}n`).join(' → '),
    paradas: etapas.length,
    intocables,
    imprescindibles,
    segundoNivel,
    excursiones,
    comidas,
    horasVisita: minutosVisita / 60,
    horasTraslado: minutosTraslado / 60,
    traslados: traslados.length,
    avisos: avisos.length,
    avisosGraves: avisos.filter((a) => a.severidad === 'alerta').length,
  };
}

const a = radiografia(A);
const b = radiografia(B);

console.log('# ¿CUÁNTO VALE UNA PARADA MÁS?\n');
console.log(`Dos viajes al mismo destino, con las mismas fechas, generados por la misma app.\n`);
console.log(`  viaje ${a.viajeId}: ${a.ruta}`);
console.log(`  viaje ${b.viajeId}: ${b.ruta}\n`);

const linea = (etiqueta, x, y, masEsMejor = true) => {
  const d = y - x;
  const flecha = d === 0 ? '  =' : d > 0 ? (masEsMejor ? ' ▲' : ' ▼') : masEsMejor ? ' ▼' : ' ▲';
  const fmt = (n) => (Number.isInteger(n) ? String(n) : n.toFixed(1));
  console.log(
    `  ${etiqueta.padEnd(30)} ${fmt(x).padStart(6)} ${fmt(y).padStart(8)}   ` +
      `${d > 0 ? '+' : ''}${fmt(d)}${flecha}`
  );
};

console.log(`  ${''.padEnd(30)} ${String(a.viajeId).padStart(6)} ${String(b.viajeId).padStart(8)}`);
console.log(`  ${'-'.repeat(56)}`);
console.log('\n  LO QUE SE VE');
linea('intocables (top 3)', a.intocables, b.intocables);
linea('otros imprescindibles', a.imprescindibles, b.imprescindibles);
linea('sitios de segundo nivel', a.segundoNivel, b.segundoNivel);
linea('excursiones', a.excursiones, b.excursiones);
linea('TOTAL sitios vistos',
  a.intocables + a.imprescindibles + a.segundoNivel + a.excursiones,
  b.intocables + b.imprescindibles + b.segundoNivel + b.excursiones);
linea('horas de visita', a.horasVisita, b.horasVisita);

console.log('\n  LO QUE CUESTA');
linea('traslados entre ciudades', a.traslados, b.traslados, false);
linea('horas en traslados', a.horasTraslado, b.horasTraslado, false);
linea('avisos sin resolver', a.avisos, b.avisos, false);
linea('de ellos graves', a.avisosGraves, b.avisosGraves, false);

console.log('\n  EL SALDO');
const netoA = a.horasVisita - a.horasTraslado;
const netoB = b.horasVisita - b.horasTraslado;
linea('horas de visita − traslado', netoA, netoB);
console.log(
  `\n  Con ${b.paradas > a.paradas ? b.viajeId : a.viajeId} se hacen ${Math.abs(b.paradas - a.paradas)} ` +
    `parada(s) más: cuesta ${Math.abs(b.horasTraslado - a.horasTraslado).toFixed(1)} h de carretera ` +
    `y ${b.intocables + b.imprescindibles - a.intocables - a.imprescindibles > 0 ? 'da' : 'quita'} ` +
    `${Math.abs(b.intocables + b.imprescindibles - a.intocables - a.imprescindibles)} imprescindible(s).`
);
