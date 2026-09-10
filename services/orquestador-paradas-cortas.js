/**
 * services/orquestador-paradas-cortas.js
 * -----------------------------------------------------------------------------
 * ¿DE VERDAD CABE LO QUE SE VA A VER EN ESA PARADA?
 *
 * La regla de las paradas de menos de dos noches admite una excepción: vale si
 * es tránsito obligado Y lo que se va a ver allí cabe en el tiempo útil. La
 * primera condición la puede juzgar la fase 1; la segunda NO, y ahí estaba el
 * fallo: en la fase 1 todavía no hay traslados investigados, así que «se llega
 * la mañana del día 3 con tiempo útil completo» es una suposición, no un dato.
 *
 * En Meteora salió mal exactamente así. La fase 1 aprobó una noche afirmando que
 * cabía; después el traslado real llegó a las 13:00 y la salida del día
 * siguiente fue a las 07:45. Tiempo útil real: una tarde. No se colocó ni un
 * monasterio —solo el casco de Kalambaka y un mirador— y se durmió allí sin ver
 * aquello por lo que se paraba.
 *
 * ASÍ QUE SE COMPRUEBA DESPUÉS Y CON NÚMEROS, cuando los traslados de los dos
 * lados ya están elegidos y las fichas de los sitios ya tienen sus horarios:
 *
 *     tiempo útil = (llegada real + margen) → (salida real − antelación)
 *
 * y contra eso se miden los imprescindibles de la parada, con su tiempo de
 * visita, su hora de cierre y —esto es lo que faltaba en Meteora— el
 * desplazamiento local si no están en el propio pueblo: los monasterios están a
 * 15-20 minutos del centro de Kalambaka, y eso multiplicado por seis visitas es
 * media jornada que nadie contaba.
 *
 * NO DECIDE NADA: avisa. Quitar la parada, darle otra noche o cambiar los
 * horarios son decisiones del viaje, no de una comprobación aritmética.
 */

import { todas, una, ejecutar } from '../db/index.js';
import { parametro } from './orquestador.js';
import { minutosDeVisita, cierraALasMinutos, lienzoDeViaje } from './lienzo.js';

/** "07:45" -> 465. */
function enMinutos(hora) {
  const m = String(hora ?? '').match(/(\d{1,2}):(\d{2})/);
  return m ? Number(m[1]) * 60 + Number(m[2]) : null;
}

/** 465 -> "07:45". */
function comoHora(min) {
  const m = Math.max(0, Math.round(min));
  return `${String(Math.floor(m / 60)).padStart(2, '0')}:${String(m % 60).padStart(2, '0')}`;
}

const comoRato = (min) => {
  const h = Math.floor(Math.max(0, min) / 60);
  const m = Math.round(Math.max(0, min) % 60);
  return h ? `${h}h${m ? ` ${m}min` : ''}` : `${m}min`;
};

/**
 * EL TIEMPO ÚTIL DE VERDAD DE UNA PARADA.
 *
 * Se saca del lienzo, que ya sabe a qué hora se sale del aeropuerto al llegar y
 * a qué hora hay que estar en la estación para irse: son los bloques fijos que
 * pusieron las fases 1 y 2. Aquí no se vuelve a calcular nada, se lee.
 *
 * Devuelve los minutos aprovechables de CADA día de la parada, que es lo que
 * hace falta para saber si una visita larga cabe en alguno.
 */
export function tiempoUtilDeParada(viajeId, etapaId) {
  const lienzo = lienzoDeViaje(viajeId);
  if (!lienzo?.dias?.length) return null;

  const dias = lienzo.dias.filter((d) => d.etapaId === etapaId);
  if (!dias.length) return null;

  // El día real empieza a las nueve, no a medianoche: es el mismo criterio que
  // usa el buscador de huecos del lienzo.
  const inicio = 9 * 60;
  const tope = 22 * 60;
  const margenLlegada = parametro('margen_tras_llegada_min', 60);

  const porDia = dias.map((d) => {
    // TODO lo que ese día ya está ocupado por un viaje: la llegada, el salto a
    // la siguiente parada, el vuelo de vuelta. Cada bloque trae su hora de
    // inicio y su hora de fin, así que el hueco libre se mide, no se supone.
    //
    // Se hace así y no mirando «hay llegada / hay salida» porque un salto puede
    // ser de entrada o de salida según el día, y adivinarlo por el nombre es
    // justo el tipo de suposición que trajo el fallo de Meteora.
    const ocupados = (lienzo.fijos ?? [])
      .filter((f) => f.dia === d.n)
      .map((f) => ({
        desde: enMinutos(f.hora) ?? 0,
        hasta: enMinutos(f.horaFin ?? f.hora) ?? enMinutos(f.hora) ?? 0,
        donde: f.donde,
      }))
      .sort((a, b) => a.desde - b.desde);

    // UNA LLEGADA OCUPA TODO LO ANTERIOR Y UNA SALIDA TODO LO POSTERIOR.
    //
    // Sin esto se contaba como tiempo útil el rato ANTES de aterrizar —cuando
    // todavía no estás en la ciudad— y el rato DESPUÉS de irte. El día 1 de
    // Gdańsk sumaba 680 minutos cuando de verdad eran 410, y el día de la vuelta
    // regalaba la tarde entera después de coger el avión. Medir mal el tiempo
    // útil es exactamente el fallo que este arreglo venía a corregir.
    //
    // Y tras aterrizar no se empieza a la carrera: el margen es el mismo que
    // respeta el validador.
    const conMargen = ocupados.map((o) => {
      if (o.donde === 'ida') return { ...o, desde: 0, hasta: o.hasta + margenLlegada };
      if (o.donde === 'vuelta') return { ...o, hasta: 24 * 60 };
      return o;
    });

    // Los huecos que quedan entre el arranque del día y el tope de la noche.
    const huecos = [];
    let cursor = inicio;
    for (const o of conMargen) {
      if (o.desde > cursor) huecos.push({ desde: cursor, hasta: Math.min(o.desde, tope) });
      cursor = Math.max(cursor, o.hasta);
    }
    if (cursor < tope) huecos.push({ desde: cursor, hasta: tope });

    const utiles = huecos
      .map((h) => ({ ...h, minutos: Math.max(0, h.hasta - h.desde) }))
      .filter((h) => h.minutos > 0);

    // El hueco MÁS LARGO del día es el que decide si cabe una visita: una de
    // tres horas no se parte entre dos ratos de hora y media.
    const mayor = utiles.reduce((a, b) => (b.minutos > (a?.minutos ?? 0) ? b : a), null);

    return {
      dia: d.n,
      minutos: utiles.reduce((s2, h) => s2 + h.minutos, 0),
      hueco: mayor?.minutos ?? 0,
      desdeTexto: mayor ? comoHora(mayor.desde) : '—',
      hastaTexto: mayor ? comoHora(mayor.hasta) : '—',
    };
  });

  return {
    dias: porDia,
    total: porDia.reduce((s, d) => s + d.minutos, 0),
    mejorDia: porDia.reduce((a, b) => (b.hueco > a.hueco ? b : a), porDia[0]),
  };
}

/**
 * LO QUE HAY QUE VER SÍ O SÍ EN ESA PARADA.
 *
 * Los imprescindibles de primer nivel de su ficha, con lo que dura cada visita.
 * No se cuentan los de segundo nivel: la pregunta es si cabe el MOTIVO de parar
 * allí, no si cabe todo lo que hay.
 */
export function imprescindiblesDeParada(etapa) {
  if (!etapa.punto_interes_id) return [];

  return todas(
    `SELECT id, nombre, tiempo_visita, categoria, horarios, cierra_dias
       FROM sitios_lugar
      WHERE punto_interes_id = ? AND bloque = 'imprescindibles' AND cubierto_por IS NULL
      ORDER BY orden, id`,
    etapa.punto_interes_id
  ).map((s) => ({
    id: s.id,
    nombre: s.nombre,
    minutos: minutosDeVisita(s.tiempo_visita) ?? parametro('visita_por_defecto_min', 90),
    cierraA: cierraALasMinutos(s),
  }));
}

/**
 * ¿CABEN LOS IMPRESCINDIBLES EN EL TIEMPO QUE HAY?
 *
 * La cuenta incluye el desplazamiento local entre visitas, que es lo que se
 * comió Meteora: seis monasterios a veinte minutos del pueblo y entre sí no son
 * seis visitas, son seis visitas más dos horas de coche.
 *
 * Se compara contra el MEJOR día de la parada y no contra la suma de todos: una
 * visita de tres horas no se parte en dos tardes de hora y media.
 */
export function cabenLosImprescindibles(viajeId, etapa) {
  const util = tiempoUtilDeParada(viajeId, etapa.id);
  if (!util) return null;

  const imprescindibles = imprescindiblesDeParada(etapa);
  if (!imprescindibles.length) return null;

  const desplazamiento = parametro('desplazamiento_local_min', 20);

  // Lo que ocupa verlos todos: las visitas más un desplazamiento entre cada dos.
  const visitas = imprescindibles.reduce((s, x) => s + x.minutos, 0);
  const saltos = Math.max(0, imprescindibles.length - 1) * desplazamiento;
  const necesario = visitas + saltos;

  return {
    necesario,
    disponible: util.total,
    mejorDia: util.mejorDia,
    dias: util.dias,
    imprescindibles,
    // CABE si el total da Y si el más largo entra en algún día suelto.
    cabe: necesario <= util.total && imprescindibles.every((x) => x.minutos <= util.mejorDia.hueco),
    necesarioTexto: comoRato(necesario),
    disponibleTexto: comoRato(util.total),
  };
}

/**
 * AVISA DE LAS PARADAS DONDE SE DUERME SIN VER EL MOTIVO.
 *
 * Solo mira las paradas cortas —por debajo del mínimo de noches—, que son las
 * que la regla dejó pasar con una promesa. Las de tres noches se sostienen
 * solas.
 *
 * Se rehace entero en cada pasada y en su propia categoría, como el resto.
 */
export function avisarDeParadasQueNoCaben(viaje, di = () => {}) {
  ejecutar("DELETE FROM avisos WHERE viaje_id = ? AND categoria = 'parada-corta'", viaje.id);

  const minimo = parametro('minimo_noches_por_ciudad', 2);
  const cortas = todas(
    `SELECT * FROM etapas
      WHERE viaje_id = ? AND estado = 'confirmada' AND noches < ?
      ORDER BY orden`,
    viaje.id,
    minimo
  );

  let avisadas = 0;

  for (const etapa of cortas) {
    const r = cabenLosImprescindibles(viaje.id, etapa);
    if (!r) continue;

    if (r.cabe) {
      di(
        `   ${etapa.nombre_ciudad} (${etapa.noches} noche): sus imprescindibles piden ` +
          `${r.necesarioTexto} y hay ${r.disponibleTexto} útiles. Cabe.`
      );
      continue;
    }

    const horarios = r.dias
      .map((d) => `día ${d.dia} de ${d.desdeTexto} a ${d.hastaTexto}`)
      .join(', ');

    ejecutar(
      `INSERT INTO avisos (viaje_id, categoria, severidad, titulo, texto)
       VALUES (?, 'parada-corta', 'alerta', ?, ?)`,
      viaje.id,
      `Dormís en ${etapa.nombre_ciudad} pero su motivo principal no cabe`,
      `Con estos horarios de traslado (${horarios}) quedan ${r.disponibleTexto} útiles, y ver ` +
        `${r.imprescindibles.map((x) => x.nombre).join(', ')} pide ${r.necesarioTexto} ` +
        `(incluido el desplazamiento entre sitios). Valora añadir una noche, cambiar los ` +
        'horarios de los traslados, o quitar la parada.'
    );

    di(
      `   AVISO GRAVE · ${etapa.nombre_ciudad}: ${r.disponibleTexto} útiles para ` +
        `${r.necesarioTexto} de imprescindibles. Se duerme allí sin ver el motivo.`
    );
    avisadas += 1;
  }

  return avisadas;
}


/**
 * LA JOYA PERDIDA QUE SÍ ESTÁ EN LA RUTA.
 *
 * El aviso del correctivo anterior mira las candidatas que se caen de la ruta:
 * Meteora peso 4 fuera del viaje, y avisa. Pero en esta ejecución Meteora SÍ
 * entró —una noche— y sus imprescindibles quedaron todos sin colocar. Nadie
 * avisó, porque la parada existía.
 *
 * Un sitio de peso alto cuyos imprescindibles no acaban en ningún día es una
 * joya perdida igual: se ha pagado la noche y no se ha visto aquello por lo que
 * se paraba. La diferencia con el otro aviso es dónde se mira —la ruta contra el
 * lienzo, no las candidatas contra la ruta— y por eso hace falta este.
 */
export function avisarDeParadasSinSusImprescindibles(viaje, di = () => {}) {
  ejecutar("DELETE FROM avisos WHERE viaje_id = ? AND categoria = 'joya-en-ruta'", viaje.id);

  const pesoMinimo = parametro('peso_minimo_aviso_candidata', 4);

  // El peso de cada parada, tal y como lo dejó la fase 1 en las candidatas.
  let pesos = new Map();
  try {
    const g = viaje.ciudades_candidatas ? JSON.parse(viaje.ciudades_candidatas) : null;
    for (const c of [...(g?.elegidas ?? []), ...(g?.todas ?? []), ...(g?.descartadas ?? [])]) {
      if (c?.nombre) pesos.set(String(c.nombre).toLowerCase(), Number(c.peso) || 0);
    }
  } catch {
    pesos = new Map();
  }

  const etapas = todas(
    "SELECT * FROM etapas WHERE viaje_id = ? AND estado = 'confirmada' ORDER BY orden",
    viaje.id
  );

  let avisadas = 0;

  for (const etapa of etapas) {
    const peso = pesos.get(String(etapa.nombre_ciudad).toLowerCase()) ?? 0;
    if (peso < pesoMinimo) continue;

    const suyos = imprescindiblesDeParada(etapa);
    if (!suyos.length) continue;

    // ¿Cuántos de ellos han acabado en el lienzo? Se cruza por la identidad del
    // candidato, que es como se cruza todo lo demás en esta casa.
    const colocados = suyos.filter((x) =>
      una(
        `SELECT 1 FROM itinerario i
           JOIN candidatos c ON c.id = i.candidato_id
          WHERE i.viaje_id = ? AND c.tipo = 'sitio' AND c.datos_extra LIKE ?`,
        viaje.id,
        `%"deId":${x.id}%`
      )
    ).length;

    if (colocados > 0) continue;

    ejecutar(
      `INSERT INTO avisos (viaje_id, categoria, severidad, titulo, texto)
       VALUES (?, 'joya-en-ruta', 'alerta', ?, ?)`,
      viaje.id,
      `${etapa.nombre_ciudad} (peso ${peso}): duermes allí y no ves ninguno de sus imprescindibles`,
      `Ninguno de sus ${suyos.length} imprescindibles ha entrado en el lienzo ` +
        `(${suyos.map((x) => x.nombre).join(', ')}). Se paga la noche y no se ve el motivo ` +
        'de la parada: mira los horarios de los traslados o dale otro día.'
    );

    di(
      `   AVISO GRAVE · ${etapa.nombre_ciudad} (peso ${peso}): 0 de ${suyos.length} ` +
        'imprescindibles colocados.'
    );
    avisadas += 1;
  }

  return avisadas;
}

export default {
  tiempoUtilDeParada,
  avisarDeParadasSinSusImprescindibles,
  imprescindiblesDeParada,
  cabenLosImprescindibles,
  avisarDeParadasQueNoCaben,
};
