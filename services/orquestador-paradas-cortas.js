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
import {
  minutosDeVisita,
  cierraALasMinutos,
  lienzoDeViaje,
  horaLibreEn,
  seLlegaAlHueco,
  FRANJAS,
} from './lienzo.js';
import { abreEl } from './horarios.js';
import { esParaguasDeZona } from './contenidos.js';

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

/** "1 noche" / "3 noches". Desde que se miran todas las paradas, el plural importa. */
const noches = (etapa) => `${etapa.noches} noche${etapa.noches === 1 ? '' : 's'}`;

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

  // Los hermanos son TODO el catálogo de la ciudad, no solo los imprescindibles:
  // para saber si algo hace de paraguas hay que mirar todo lo que tiene debajo.
  const hermanos = todas(
    `SELECT id, nombre, tiempo_visita, lat, lon FROM sitios_lugar
      WHERE punto_interes_id = ? AND cubierto_por IS NULL AND bloque <> 'busqueda'`,
    etapa.punto_interes_id
  );

  return todas(
    `SELECT id, nombre, tiempo_visita, categoria, horarios, cierra_dias, lat, lon
       FROM sitios_lugar
      WHERE punto_interes_id = ? AND bloque = 'imprescindibles' AND cubierto_por IS NULL
      ORDER BY orden, id`,
    etapa.punto_interes_id
  )
    // LA ZONA NO CUENTA COMO IMPRESCINDIBLE PENDIENTE.
    //
    // No se coloca como bloque —el reparto ya no la ofrece— así que contarla
    // aquí la dejaría eternamente «sin colocar»: un AVISO GRAVE de imprescindible
    // perdido por algo que no se ha perdido, porque estás dentro todo el día. Y
    // sus 480 minutos inflaban la cuenta de si la parada da de sí: Rodas pedía
    // «21h de imprescindibles» con ocho horas que son el envoltorio de las otras.
    .filter((s) => !esParaguasDeZona(s, hermanos))
    .map((s) => ({
    id: s.id,
    nombre: s.nombre,
    // DÓNDE ESTÁ, para poder preguntar si al hueco se LLEGA y no solo si está
    // libre. Sin coordenada va null y la pregunta no se hace.
    punto: Number.isFinite(Number(s.lat)) ? { lat: Number(s.lat), lon: Number(s.lon) } : null,
    minutos: minutosDeVisita(s.tiempo_visita) ?? parametro('visita_por_defecto_min', 90),
    cierraA: cierraALasMinutos(s),
    // El TEXTO del horario, no `cierra_dias`. Es la misma fuente que usan los
    // avisos del lienzo y por la misma razón: una lista guardada se queda vieja
    // y el texto no. Aquí sirve para saber qué días de la semana cierra.
    horarios: s.horarios ?? null,
  }));
}

/**
 * Los días de la semana que este sitio NO abre, leídos de su texto.
 *
 * Sin texto no se devuelve nada, que es distinto de devolver «ninguno»: un sitio
 * del que no se sabe el horario no puede hacer que una ciudad salga mal juzgada.
 */
const DIAS_SEMANA = ['domingo', 'lunes', 'martes', 'miércoles', 'jueves', 'viernes', 'sábado'];

/** «los lunes», «los sábados». Solo sábado y domingo cambian en plural. */
function enPlural(dias) {
  return dias
    .map((n) => (n === 0 || n === 6 ? `${DIAS_SEMANA[n]}s` : DIAS_SEMANA[n]))
    .join(' y ');
}

function diasQueNoAbre(sitio) {
  if (!sitio.horarios) return [];
  return [0, 1, 2, 3, 4, 5, 6].filter((d) => abreEl(sitio.horarios, d) === false);
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
 * ANTES SOLO MIRABA LAS PARADAS CORTAS —por debajo del mínimo de noches—, con el
 * argumento de que las de tres noches se sostienen solas. No es verdad, y lo
 * enseñó Grecia: Santorini y Atenas tuvieron las MISMAS tres noches y una tuvo
 * 1.700 minutos útiles y la otra 2.520. Ochocientos veinte minutos de diferencia
 * —casi catorce horas— según dónde caigan los traslados. Una parada de tres
 * noches con un día de llegada a las ocho de la tarde y una salida a mediodía
 * puede quedarse más corta que una de dos noches bien puestas.
 *
 * Así que se miran TODAS las confirmadas. No hace falta ninguna otra puerta: la
 * cuenta se autolimita sola —sin imprescindibles no hay nada que comparar, y
 * solo se escribe cuando NO cabe—.
 *
 * Se rehace entero en cada pasada y en su propia categoría, como el resto.
 */
export function avisarDeParadasQueNoCaben(viaje, di = () => {}) {
  ejecutar("DELETE FROM avisos WHERE viaje_id = ? AND categoria = 'parada-corta'", viaje.id);

  // EN UNA PARADA DE PASO NO SE DUERME, ASÍ QUE ESTA PLANTILLA NO LE APLICA.
  //
  // Todo lo que escribe esta función habla de dormir —«se duerme allí sin ver el
  // motivo»— y de tiempo útil para visitar. Una parada de cero noches no es ni
  // una cosa ni la otra: es volver a la ciudad del aeropuerto a coger el avión.
  // Salía con «0 min útiles para 8h de imprescindibles», que es verdad y no
  // significa nada.
  //
  // Es el mismo despiste que en la fase de dormir, y por el mismo motivo: estas
  // consultas se escribieron cuando toda parada confirmada tenía al menos una
  // noche, y las rutas en bucle estrenaron la parada de salida.
  const cortas = todas(
    `SELECT * FROM etapas
      WHERE viaje_id = ? AND estado = 'confirmada' AND noches > 0
      ORDER BY orden`,
    viaje.id
  );

  let avisadas = 0;

  for (const etapa of cortas) {
    const r = cabenLosImprescindibles(viaje.id, etapa);
    if (!r) continue;

    if (r.cabe) {
      di(
        `   ${etapa.nombre_ciudad} (${noches(etapa)}): sus imprescindibles piden ` +
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

  // LA PUERTA DEL PESO SE HA QUITADO, y no por ampliar: porque dejaba la función
  // MUERTA en medio viaje.
  //
  // El peso solo existe si lo escribió la fase 1 en `ciudades_candidatas`. Un
  // viaje montado a mano no tiene ninguno, así que todas las paradas valían 0,
  // ninguna llegaba al mínimo de 4 y esta comprobación no miraba nada en
  // absoluto. Y aun dentro de un viaje orquestado, «peso bajo» no significa
  // «da igual no ver nada de esa ciudad»: significa que no era el motivo del
  // viaje. Se paga la noche igual.
  //
  // El peso se sigue leyendo, pero solo para CONTARLO en el aviso cuando lo hay.

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
    // Solo se enseña el peso si la fase 1 lo puso: un «(peso 0)» escrito a fuego
    // en un viaje hecho a mano no informa de nada, confunde.
    const conPeso = peso ? ` (peso ${peso})` : '';

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

    // ANTES BASTABA CON QUE HUBIERA UNO COLOCADO, y eso dejó pasar los dos
    // casos de libro: Varsovia con Majdanek y Atenas con Delfos. En los dos
    // quedó algún imprescindible suelto —el del día de llegada— así que el aviso
    // calló mientras el motivo de la parada se iba entero por el desagüe.
    //
    // Lo que se mira ahora es si falta alguno de los PRIMEROS PUESTOS, que son
    // los que justifican dormir allí, y si hay un día comido por una excursión
    // de jornada completa: ese día no cuenta como día útil de esta ciudad,
    // porque esa ciudad no se pisa.
    const primeros = suyos.slice(0, parametro('puestos_intocables_del_sitio', 3));
    const faltan = primeros.filter(
      (x) =>
        !una(
          `SELECT 1 FROM itinerario i
             JOIN candidatos c ON c.id = i.candidato_id
            WHERE i.viaje_id = ? AND c.tipo = 'sitio' AND c.datos_extra LIKE ?`,
          viaje.id,
          `%"deId":${x.id}%`
        )
    );

    const diasComidos = todas(
      `SELECT i.dia, c.titulo, i.duracion_min
         FROM itinerario i JOIN candidatos c ON c.id = i.candidato_id
        WHERE i.viaje_id = ? AND i.etapa_id = ? AND c.tipo = 'actividad'
          AND i.duracion_min >= ?`,
      viaje.id,
      etapa.id,
      parametro('excursion_dia_completo_min', 480)
    );

    if (colocados > 0 && !(faltan.length && diasComidos.length)) continue;

    ejecutar(
      `INSERT INTO avisos (viaje_id, categoria, severidad, titulo, texto)
       VALUES (?, 'joya-en-ruta', 'alerta', ?, ?)`,
      viaje.id,
      colocados === 0
        ? `${etapa.nombre_ciudad}${conPeso}: duermes allí y no ves ninguno de sus imprescindibles`
        : `${etapa.nombre_ciudad}${conPeso}: una excursión se lleva el día y te deja sin lo esencial`,
      colocados === 0
        ? `Ninguno de sus ${suyos.length} imprescindibles ha entrado en el lienzo ` +
          `(${suyos.map((x) => x.nombre).join(', ')}). Se paga la noche y no se ve el motivo ` +
          'de la parada: mira los horarios de los traslados o dale otro día.'
        : `${diasComidos.map((x) => `«${x.titulo}»`).join(' y ')} ocupa(n) un día entero de la ` +
          `parada, y eso deja fuera ${faltan.map((x) => x.nombre).join(', ')}. Ese día no se pisa ` +
          `${etapa.nombre_ciudad}: o la excursión va a la mochila, o esta parada necesita otro día.`
    );

    // EL NÚMERO, NO UN CERO ESCRITO A FUEGO.
    //
    // Valía mientras el aviso solo saltaba con cero colocados. Ahora también
    // salta cuando falta alguno de los primeros puestos, y un log que dice «0
    // de 3» habiendo uno puesto es justo el tipo de número que hace que nadie se
    // fíe del resto de la línea.
    di(
      `   AVISO GRAVE · ${etapa.nombre_ciudad}${conPeso}: ${colocados} de ${suyos.length} ` +
        `imprescindibles colocados` +
        (faltan.length ? `; falta(n) ${faltan.map((x) => x.nombre).join(', ')}` : '') +
        (diasComidos.length
          ? ` y ${diasComidos.map((x) => `«${x.titulo}»`).join(' y ')} se lleva(n) un día entero.`
          : '.')
    );
    avisadas += 1;
  }

  return avisadas;
}

// =============================================================================
// LA REVISIÓN FINAL DEL REPARTO
// =============================================================================
/**
 * ¿TUVO SENTIDO EL REPARTO DE NOCHES? SE PREGUNTA AL FINAL, QUE ES CUANDO SE SABE.
 *
 * La fase 1 reparte las noches ANTES de saber qué hay en cada ciudad —los sitios
 * se buscan tres fases más tarde— y antes de saber a qué hora se llega y se sale
 * —eso lo deciden los traslados—. O sea que reparte a ciegas, y no puede hacer
 * otra cosa. Al terminar el viaje ya no hay nada que adivinar: el lienzo ha
 * colocado lo que cupo y ha apartado lo que no.
 *
 * ESTO SOLO MIRA Y AVISA. No mueve noches, no regenera nada, no toca el lienzo.
 *
 * ───────────────────────────────────────────────────────────────────────────
 * POR QUÉ NO SE MIDE EN PORCENTAJE DE OCUPACIÓN. Esto es lo importante de aquí.
 *
 * La tentación es «minutos ocupados / minutos útiles» y está MAL. Medido en
 * Grecia: Atenas acabó al 73 % con 690 minutos libres, y aun así el Museo
 * Arqueológico Nacional se quedó fuera. Por la regla del porcentaje el informe
 * habría dicho «a Atenas le sobra una noche», y es falso: esos 690 minutos
 * estaban en trozos de 135, 240, 90 y 225, y el museo pide 180 seguidos en un
 * sitio donde además cierre después. Preguntado hueco a hueco, en los cuatro
 * días de Atenas solo cabía a las 17:00 del día que ya se come entero la
 * excursión a Delfos.
 *
 * La media miente porque suma trozos que no se pueden usar juntos. Así que la
 * pregunta no es CUÁNTO queda libre, sino, por cada imprescindible que no llegó,
 * si existía UN HUECO DE VERDAD donde habría cabido. Eso lo contesta
 * `horaLibreEn`, que ya sabe de bloques fijos, de la hora a la que se aterriza,
 * del tope de la noche y de la hora de cierre del sitio.
 *
 * LO QUE `horaLibreEn` NO MIRA ES EL DÍA DE LA SEMANA. Respeta la hora de cierre
 * (`cierraA`) pero no `cierra_dias`: un sitio que cerraba justo ese lunes puede
 * dar «sí había hueco» y hacer que la ciudad caiga en «ajustada» en vez de en
 * «corta». Es a propósito, y es el error prudente: se deja de gritar en algún
 * caso, que es mucho mejor que gritar «esta ciudad se quedó corta» sin que sea
 * verdad. Un aviso en el que no se puede confiar no sirve para nada.
 * ───────────────────────────────────────────────────────────────────────────
 */

/** ¿Acabó este sitio en algún día del lienzo? Por identidad, como todo aquí. */
function estaColocado(viajeId, sitioId) {
  return Boolean(
    una(
      `SELECT 1 FROM itinerario i
         JOIN candidatos c ON c.id = i.candidato_id
        WHERE i.viaje_id = ? AND c.tipo = 'sitio' AND c.datos_extra LIKE ?`,
      viajeId,
      `%"deId":${sitioId}%`
    )
  );
}

/**
 * ¿HAY UN HUECO DE VERDAD PARA ALGO QUE DURA `duracion` EN ESTOS DÍAS?
 *
 * Prueba día por día y franja por franja, y en cuanto encuentra uno para. No
 * devuelve un sí/no: devuelve DÓNDE, porque un aviso que dice «cabría el día 5
 * por la tarde» se puede comprobar y uno que dice «cabría» no.
 */
function huecoDeVerdad(
  lienzo,
  dias,
  duracion,
  cierraA = null,
  franjas = FRANJAS,
  cierraDias = null,
  punto = null
) {
  for (const dia of dias) {
    // UN DÍA EN QUE EL SITIO CIERRA NO ES UN HUECO, por libre que esté.
    if (cierraDias?.length) {
      const fecha = lienzo.dias.find((d) => d.n === dia)?.fecha;
      const queDia = fecha ? new Date(`${fecha}T12:00:00`).getDay() : null;
      if (queDia !== null && cierraDias.includes(queDia)) continue;
    }
    for (const f of franjas) {
      const hora = horaLibreEn(lienzo, { dia, franja: f.clave, duracion, cierraA });
      if (!hora) continue;

      // NI UN HUECO AL QUE NO SE LLEGA, que es lo que esta función acabó
      // diciendo en cuanto el reparto empezó a mirar el mapa.
      //
      // EL CASO, del viaje 103. El Zoco de las Alfombras de Kairuan está
      // geocodificado a 20 km del centro, así que la guarda del lienzo le negó
      // todas las horas y acabó expulsado. Y luego esta revisión escribía:
      //
      //     · Zoco de las Alfombras tenía hueco libre (día 3, mañana, 12:00)
      //       y aun así no se colocó: eso no es cosa del reparto.
      //
      // Verdad sobre el reloj y mentira sobre el mapa, y encima con la etiqueta
      // más inocente de las cuatro —«el lienzo eligió otra cosa»—, que es la que
      // hace que nadie mire. Dos partes del programa midiendo con reglas
      // distintas es peor que cualquiera de las dos sola: la que juzga acusa a
      // la que decide de un capricho que no ha tenido.
      //
      // Sin coordenada del sitio, `punto` va null y esto no se pregunta: se
      // vuelve a comportar exactamente como antes.
      if (punto && seLlegaAlHueco(lienzo, { dia, hora, duracion, punto })) continue;

      return { dia, franja: f.clave, etiqueta: f.etiqueta, hora };
    }
  }
  return null;
}

/**
 * PARA DECIR «AQUÍ CABRÍA ALGO MÁS», LA NOCHE NO CUENTA.
 *
 * Un hueco libre a las ocho y media de la tarde es una cena sin reservar, no
 * capacidad de sobra: a esa hora los museos, los yacimientos y las bodegas están
 * cerrados, y decir que a una ciudad le sobra una noche porque tiene la velada
 * libre es justo el consejo que esta revisión no puede dar. Para juzgar si
 * FALTABA sitio sí se miran las cuatro, porque ahí la pregunta es la contraria:
 * si no cabía ni de noche, desde luego no cabía.
 */
const FRANJAS_DE_VISITA = FRANJAS.filter((f) => f.clave !== 'noche');

/**
 * El veredicto de cada ciudad, y los avisos de las que no salen «ajustadas».
 *
 * Devuelve la lista de veredictos para poder probarla sin arrancar un viaje.
 */
export function revisarElReparto(viaje, di = () => {}) {
  ejecutar("DELETE FROM avisos WHERE viaje_id = ? AND categoria = 'reparto'", viaje.id);

  const lienzo = lienzoDeViaje(viaje.id);
  if (!lienzo?.dias?.length) {
    di('El viaje no tiene días montados: no hay reparto que juzgar.');
    return [];
  }

  const etapas = todas(
    "SELECT * FROM etapas WHERE viaje_id = ? AND estado = 'confirmada' ORDER BY orden",
    viaje.id
  );

  // Lo que tiene que caber para decir que «aún cabría algo más»: una visita
  // normal, no cinco minutos. El mismo número que usa el lienzo cuando no sabe
  // cuánto dura algo.
  const tipica = parametro('visita_por_defecto_min', 90);

  // EL RITMO ENTRA EN EL VEREDICTO (§1.6 del repaso). Con un hueco para una
  // visita más, la parada salía «holgada», y el aviso proponía quitarle una
  // noche. En un viaje tranquilo ese hueco no sobra: es el que el ritmo deja
  // a propósito, y llamarlo holgura es juzgar un viaje tranquilo con las horas
  // de uno intenso. Así que en tranquilo, para decir que sobra, tiene que
  // caber más de una visita. Solo cambia el juicio y sus avisos; el reparto y
  // el día útil de 9:00 a 22:00 no se tocan, que eso está congelado hasta tener
  // viajes largos con que medirlo.
  const vecesParaSobrar =
    (viaje.ritmo || 'normal') === 'tranquilo' ? parametro('holgada_tranquilo_veces', 2) : 1;

  const veredictos = [];

  for (const etapa of etapas) {
    // LOS DÍAS SE SACAN DEL LIENZO, NO DE `itinerario.etapa_id`.
    //
    // Esa columna puede venir vacía —en Grecia, las dos cosas del último día la
    // tenían a null— y fiarse de ella daba «0 minutos ocupados» en un día que
    // estaba lleno. El lienzo sabe de qué ciudad es cada día y eso nunca falta.
    const dias = lienzo.dias.filter((d) => d.etapaId === etapa.id).map((d) => d.n);
    const suyos = imprescindiblesDeParada(etapa);

    // Sin ficha de sitios o sin días no hay juicio posible, y decir «ajustada»
    // sería inventárselo. Se cuenta como lo que es: no se sabe.
    if (!dias.length || !suyos.length) {
      di(`   ${etapa.nombre_ciudad}: sin datos para juzgar el reparto (no la cuento).`);
      veredictos.push({ etapa, que: 'sin-datos', dias, suyos: [], noLlegaron: [] });
      continue;
    }

    // CADA UNO DE LOS QUE FALTAN SE PREGUNTA DOS VECES, Y LAS DOS HACEN FALTA.
    //
    // 1) ¿Cabía tal cual, con su hora de cierre? Si sí, el reparto de noches no
    //    tiene nada que ver: el lienzo eligió otra cosa. No es cosa de aquí.
    //
    // 2) Si no cabía, ¿cabría suponiendo el sitio abierto todo el día? Esta
    //    segunda es la que separa las dos razones de no caber, y sin ella el
    //    aviso miente. El caso real: el Museo Arqueológico de Atenas pide tres
    //    horas y `cierraALasMinutos` le da las 15:30 —el cierre más temprano de
    //    todos sus tramos, que es la respuesta prudente—. Con ese tope no cabe
    //    en ningún día; ignorándolo, cabe de sobra el día 6 a las 17:00. O sea
    //    que a Atenas NO le falta tiempo: le falta mañana. Decirle a alguien
    //    «dale otra noche a Atenas» por un horario de cierre es exactamente el
    //    consejo falso que esta revisión existe para no dar.
    //
    // CORTA es, entonces, «hay algo que no cabe NI CON EL SITIO ABIERTO TODO EL
    // DÍA». Eso ya solo lo puede arreglar más tiempo.
    const noLlegaron = suyos
      .filter((x) => !estaColocado(viaje.id, x.id))
      .map((x) => {
        // Y UNA CUARTA PREGUNTA, QUE ANTES NO SE HACÍA.
        //
        // `horaLibreEn` respeta la hora de cierre pero no el día de la semana, y
        // eso estaba escrito arriba como «el error prudente»: se deja de gritar
        // en algún caso. El caso resultó no ser raro. Un imprescindible que se
        // cayó porque cerraba justo esos días encontraba «hueco» en el día que
        // cerraba y salía clasificado como «el lienzo eligió otra cosa», que es
        // la etiqueta más inocente de las cuatro y la que hace que nadie mire.
        //
        // Ahora los días de cierre se saben ANTES de repartir, así que esta
        // pregunta ya se puede hacer sin inventarse nada.
        const cierraDias = diasQueNoAbre(x);
        const donde = huecoDeVerdad(lienzo, dias, x.minutos, x.cierraA, FRANJAS, cierraDias, x.punto);

        // Y UNA QUINTA PREGUNTA: ¿Y SI EL MAPA NO CONTARA?
        //
        // Va la primera de las que descartan porque es la que AÍSLA una causa.
        // Si ignorando dónde está el sitio aparece un hueco que con el mapa no
        // aparecía, lo único que ha cambiado entre las dos preguntas es la
        // distancia: esa ES la razón, y no hay que seguir buscando.
        //
        // Sin ella el Zoco de las Alfombras de Kairuan salía clasificado como
        // «no entró por su horario», que es verdad a medias y engaña entera: lo
        // que le pasa es que está geocodificado a 20 km del centro y no se llega
        // a él desde ningún bloque del día. Decir «horario» manda a mirar la
        // ficha de apertura; decir «lo lejos que está» manda a mirar la
        // coordenada, que es donde está el fallo.
        const sinElMapa =
          donde || !x.punto
            ? null
            : huecoDeVerdad(lienzo, dias, x.minutos, x.cierraA, FRANJAS, cierraDias, null);

        const sinElDia =
          donde || sinElMapa
            ? null
            : huecoDeVerdad(lienzo, dias, x.minutos, x.cierraA, FRANJAS, null, x.punto);
        const sinSuHorario =
          donde || sinElMapa || sinElDia
            ? null
            : huecoDeVerdad(lienzo, dias, x.minutos, null, FRANJAS, null, x.punto);
        return {
          ...x,
          donde,
          cierraDias,
          // Dónde SÍ habría cabido de no cerrar ese día. Es lo que convierte el
          // aviso en algo comprobable.
          cabriaEn: sinElDia,
          // Y dónde habría cabido si estuviera donde dice estar.
          cabriaSinElMapa: sinElMapa,
          // Las cinco razones posibles de que no esté, y son distintas:
          por: donde
            ? 'el lienzo eligió otra cosa'
            : sinElMapa
              ? 'lo lejos que está'
              : sinElDia
                ? 'su día de cierre'
                : sinSuHorario
                  ? 'su horario'
                  : 'falta de tiempo',
        };
      });

    const porTiempo = noLlegaron.filter((x) => x.por === 'falta de tiempo');
    const porDistancia = noLlegaron.filter((x) => x.por === 'lo lejos que está');
    const porHorario = noLlegaron.filter((x) => x.por === 'su horario');
    const porDiaDeCierre = noLlegaron.filter((x) => x.por === 'su día de cierre');
    const conHueco = noLlegaron.filter((x) => x.donde);

    // Y al revés: ¿queda sitio para una visita más? Solo importa si no falta
    // nada, porque una ciudad a la que le sobra tiempo Y le faltan cosas es una
    // contradicción que significa otra cosa (ver arriba).
    const sobra = noLlegaron.length
      ? null
      : huecoDeVerdad(lienzo, dias, Math.round(tipica * vecesParaSobrar), null, FRANJAS_DE_VISITA);

    const que = porTiempo.length ? 'corta' : !noLlegaron.length && sobra ? 'holgada' : 'ajustada';

    veredictos.push({
      etapa,
      que,
      dias,
      suyos,
      noLlegaron,
      porTiempo,
      porHorario,
      porDiaDeCierre,
      porDistancia,
      conHueco,
      sobra,
    });
  }

  // --- El registro se lleva TODAS, salgan como salgan --------------------
  //
  // Los avisos son para lo que hay que mirar; el registro es la foto completa.
  // Una ciudad «ajustada» no merece un aviso, pero sí merece que quede escrito
  // que se miró y salió bien.
  const juzgadas = veredictos.filter((v) => v.que !== 'sin-datos');
  const NOMBRE = { corta: 'se quedó CORTA', holgada: 'iba HOLGADA', ajustada: 'ajustada' };

  for (const v of juzgadas) {
    di(
      `   ${v.etapa.nombre_ciudad} (${noches(v.etapa)}, ${v.dias.length} día(s)): ${NOMBRE[v.que]} — ` +
        `${v.suyos.length - v.noLlegaron.length} de ${v.suyos.length} imprescindibles colocados` +
        (v.que === 'corta'
          ? `. No cabe${v.porTiempo.length === 1 ? '' : 'n'} en ningún hueco, ni con el sitio abierto ` +
            `todo el día: ${v.porTiempo.map((x) => `${x.nombre} (${x.minutos} min)`).join(', ')}.`
          : v.que === 'holgada'
            ? `, y aún cabría otra visita de ${tipica} min (día ${v.sobra.dia}, ${v.sobra.etiqueta.toLowerCase()}).`
            : '.')
    );

    // Y lo que falta POR OTRAS RAZONES se dice igual, aunque no cambie el
    // veredicto: es la diferencia entre «no cabía» y «no lo pusieron».
    //
    // CON TOPE, porque si no el registro se vuelve ilegible justo cuando más
    // hay que mirarlo: una ciudad cuyo lienzo se quedó vacío tiene las veinte
    // fichas sin colocar y las veinte con hueco, y veinte líneas seguidas
    // diciendo lo mismo no se lee ninguna. Se enseñan tres y se cuenta el resto.
    const TOPE = 3;
    const conRecorte = (lista, linea) => {
      for (const x of lista.slice(0, TOPE)) di(linea(x));
      if (lista.length > TOPE) di(`      · …y ${lista.length - TOPE} más.`);
    };

    conRecorte(
      v.porHorario,
      (x) => `      · ${x.nombre} no entró por su horario (cierra pronto), no por falta de tiempo.`
    );
    conRecorte(
      v.porDiaDeCierre,
      (x) =>
        `      · ${x.nombre} no entró porque cierra los ${enPlural(x.cierraDias)} y esta parada ` +
        `no pisa ningún otro día. Habría cabido el día ${x.cabriaEn.dia} ` +
        `(${x.cabriaEn.etiqueta.toLowerCase()}, ${x.cabriaEn.hora}) si abriera.`
    );
    conRecorte(
      v.porDistancia,
      (x) =>
        `      · ${x.nombre} no entró por lo lejos que está: no se llega a él desde el resto ` +
        `del día. Habría cabido el día ${x.cabriaSinElMapa.dia} ` +
        `(${x.cabriaSinElMapa.etiqueta.toLowerCase()}, ${x.cabriaSinElMapa.hora}) si estuviera ` +
        'donde dice estar: comprueba su coordenada.'
    );
    conRecorte(
      v.conHueco,
      (x) =>
        `      · ${x.nombre} tenía hueco libre (día ${x.donde.dia}, ${x.donde.etiqueta.toLowerCase()}, ` +
        `${x.donde.hora}) y aun así no se colocó: eso no es cosa del reparto.`
    );
  }

  // --- Y los avisos, solo de lo que no es «ajustada» ---------------------
  const cortas = juzgadas.filter((v) => v.que === 'corta');
  const holgadas = juzgadas.filter((v) => v.que === 'holgada');

  const meter = (severidad, titulo, texto) =>
    ejecutar(
      `INSERT INTO avisos (viaje_id, categoria, severidad, titulo, texto)
       VALUES (?, 'reparto', ?, ?, ?)`,
      viaje.id,
      severidad,
      titulo,
      texto
    );

  for (const v of cortas) {
    const faltan = v.porTiempo.map((x) => `${x.nombre} (${x.minutos} min)`).join(', ');
    // DE DÓNDE SALDRÍA LA NOCHE. Es la frase que convierte un diagnóstico en algo
    // que se puede hacer. Y no se hace: se dice.
    const deDonde = holgadas.length
      ? ` En cambio ${holgadas.map((h) => h.etapa.nombre_ciudad).join(' y ')} ` +
        `${holgadas.length === 1 ? 'iba holgada' : 'iban holgadas'}: si mueves una noche de ` +
        `${holgadas[0].etapa.nombre_ciudad} a ${v.etapa.nombre_ciudad}, es probable que quepa.`
      : ' Ninguna otra parada va holgada, así que la noche tendría que salir de alargar el viaje.';

    meter(
      'alerta',
      `${v.etapa.nombre_ciudad} (${noches(v.etapa)}): se quedó corta`,
      `No ha entrado ${v.porTiempo.length === 1 ? 'un imprescindible' : `${v.porTiempo.length} imprescindibles`} ` +
        `de esta parada y no es cuestión de horarios: ${faltan} no cabe${v.porTiempo.length === 1 ? '' : 'n'} ` +
        `en NINGÚN hueco de los ${v.dias.length} día(s) que tuvo, ni suponiendo el sitio abierto de la ` +
        `mañana a la noche. Eso solo lo arregla más tiempo.${deDonde} ` +
        'Esto solo avisa: no se ha cambiado nada del viaje.'
    );
  }

  // --- LO QUE SE CAYÓ PORQUE CERRABA ESE DÍA ------------------------------
  //
  // Esto no cambia el veredicto de la parada y no tiene por qué: no le falta
  // tiempo, le falta OTRO DÍA DE LA SEMANA. Es un aviso aparte porque la
  // decisión también es de otro tipo —mover o añadir una noche, o resignarse— y
  // la toma quien viaja, no esto.
  //
  // LO QUE SE AFIRMA AQUÍ ESTÁ CALCULADO; LO QUE NO, SE DICE COMO SOSPECHA. Que
  // el sitio habría cabido el día tal está comprobado hueco a hueco. Que una
  // noche más lo salvaría se sabe seguro solo para la noche añadida AL FINAL de
  // la parada, que es la única cuyo día de la semana se puede nombrar sin
  // simular el calendario entero: mover una noche desde otra ciudad desplaza las
  // fechas de todo lo que viene detrás, y eso todavía no se sabe calcular.
  for (const v of juzgadas) {
    if (!v.porDiaDeCierre.length) continue;

    const dias = v.dias.slice().sort((a, b) => a - b);
    const ultimo = lienzo.dias.find((d) => d.n === dias[dias.length - 1]);
    const finDeParada = ultimo?.fecha ? new Date(`${ultimo.fecha}T12:00:00`).getDay() : null;
    const unaMas = finDeParada === null ? null : (finDeParada + 1) % 7;

    for (const x of v.porDiaDeCierre) {
      const abriria = unaMas !== null && !x.cierraDias.includes(unaMas);
      const conUnaNoche = abriria
        ? ` Una noche más en ${v.etapa.nombre_ciudad} añadiría un ${DIAS_SEMANA[unaMas]}, y ese día SÍ abre; ` +
          'ojo a que eso corre las fechas de todo lo que viene detrás, y a que puede salirse del ' +
          'rango de noches que se le puso a esta ciudad.'
        : unaMas !== null
          ? ` Una noche más añadiría un ${DIAS_SEMANA[unaMas]}, que también cierra: por ahí no se arregla.`
          : '';

      const moviendo = holgadas.length
        ? ` ${holgadas.map((h) => h.etapa.nombre_ciudad).join(' y ')} ` +
          `${holgadas.length === 1 ? 'va holgada' : 'van holgadas'}: de ahí podría salir esa noche, ` +
          'aunque al mover fechas cambian los días de la semana de toda la ruta y habría que volver a mirarlo.'
        : '';

      meter(
        'alerta',
        `${v.etapa.nombre_ciudad}: ${x.nombre} se cae porque cierra los ${enPlural(x.cierraDias)}`,
        `${x.nombre} es un imprescindible de ${v.etapa.nombre_ciudad} y no ha entrado en el plan. ` +
          `No es falta de tiempo: habría cabido el día ${x.cabriaEn.dia} ` +
          `(${x.cabriaEn.etiqueta.toLowerCase()}, a partir de las ${x.cabriaEn.hora}), pero cierra ` +
          `los ${enPlural(x.cierraDias)} y esta parada no pisa ningún día en que abra.` +
          conUnaNoche +
          moviendo +
          ' Esto solo avisa: no se ha cambiado nada del viaje.'
      );
    }
  }

  for (const v of holgadas) {
    meter(
      'info',
      `${v.etapa.nombre_ciudad} (${noches(v.etapa)}): iba holgada`,
      `Sus ${v.suyos.length} imprescindibles han entrado todos y todavía queda un hueco real para ` +
        `otra visita de ${tipica} minutos (día ${v.sobra.dia}, ${v.sobra.etiqueta.toLowerCase()}, ` +
        `a partir de las ${v.sobra.hora}).` +
        (cortas.length
          ? ` Y ${cortas.map((c) => c.etapa.nombre_ciudad).join(' y ')} se quedó corta: la noche que ` +
            'sobra aquí es la que allí falta.'
          : ' Puedes añadir algo de la mochila, o dedicar ese rato a no hacer nada, que también cuenta.')
    );
  }

  const resumen = juzgadas.length
    ? `Revisión del reparto: ${cortas.length} parada(s) corta(s), ${holgadas.length} holgada(s), ` +
      `${juzgadas.length - cortas.length - holgadas.length} ajustada(s).`
    : 'Revisión del reparto: no había ninguna parada con datos suficientes para juzgarla.';
  di(resumen);

  di(densidadDelViaje(viaje.id));

  return veredictos;
}

/**
 * CUÁNTAS HORAS DE VER COSAS TE LLEVAS POR CADA NOCHE QUE PAGAS.
 *
 * NO DECIDE NADA. Es una línea en el registro, y está aquí porque es el número
 * que separó cuatro viajes de un vistazo cuando nada más lo hacía.
 *
 * DE DÓNDE SALE. Al medir qué cuesta una parada de más —contando el itinerario
 * de verdad, no la puntuación— apareció esto en tres destinos distintos:
 *
 *     112  Grecia   2 paradas   7,3 h/noche    3,4 h de traslado
 *      98  Polonia  2 paradas   6,7 h/noche    3,7 h
 *     110  Grecia   3 paradas   4,4 h/noche   10,6 h
 *     103  Túnez    3 paradas   4,4 h/noche    5,0 h
 *
 * Los dos de tres paradas dan 4,4 clavado; los dos de dos, casi el doble. Una
 * parada más se come un tercio del tiempo que pasas viendo algo, y eso no se ve
 * en ninguna otra parte del registro: el reparto puntúa con `Σ(noches × peso)`,
 * que premia concentrar, pero nunca dice cuánto.
 *
 * POR QUÉ SOLO SE ESCRIBE Y NO SE USA. Cuatro viajes no son una regla, y los
 * cuatro son de seis o siete noches. En uno de catorce, cuatro días en Atenas
 * probablemente empiecen a rendir menos y la tercera ciudad pase a compensar;
 * una regla calibrada solo con viajes cortos se rompería justo ahí. Así que se
 * escribe el número y cada viaje que se genere suma evidencia solo, que es lo
 * que hoy no pasaba: el dato había que sacarlo a mano del itinerario.
 *
 * Los traslados se cuentan puerta a puerta y solo los SALTOS entre paradas: los
 * vuelos de ida y vuelta se pagan igual con dos paradas que con cinco, y meterlos
 * taparía justo lo que se quiere ver.
 */
export function densidadDelViaje(viajeId) {
  const noches = todas(
    "SELECT COALESCE(SUM(noches), 0) AS n FROM etapas WHERE viaje_id = ? AND estado = 'confirmada'",
    viajeId
  )[0].n;
  if (!noches) return 'Densidad del viaje: sin noches confirmadas, no hay nada que dividir.';

  const paradas = todas(
    "SELECT COUNT(*) AS n FROM etapas WHERE viaje_id = ? AND estado = 'confirmada'",
    viajeId
  )[0].n;

  // Las comidas no son visita: son el hueco entre dos visitas.
  const minutosVisita = todas(
    `SELECT COALESCE(SUM(i.duracion_min), 0) AS m
       FROM itinerario i LEFT JOIN candidatos c ON c.id = i.candidato_id
      WHERE i.viaje_id = ?
        AND COALESCE(c.titulo, i.texto_manual, '') NOT LIKE 'Comer%'`,
    viajeId
  )[0].m;

  const minutosTraslado = todas(
    `SELECT datos_extra FROM transportes
      WHERE viaje_id = ? AND etapa_origen_id IS NOT NULL AND etapa_destino_id IS NOT NULL`,
    viajeId
  ).reduce((a, t) => {
    try {
      return a + (JSON.parse(t.datos_extra ?? '{}')?.bloque?.total ?? 0);
    } catch {
      return a;
    }
  }, 0);

  const porNoche = minutosVisita / 60 / noches;

  return (
    `Densidad del viaje: ${porNoche.toFixed(1)} h de visita por noche ` +
    `(${(minutosVisita / 60).toFixed(1)} h en ${noches} noches y ${paradas} parada(s), ` +
    `más ${(minutosTraslado / 60).toFixed(1)} h de traslado entre ellas). ` +
    'Medido sobre otros viajes: con dos paradas salen 6,7-7,3 y con tres, 4,4. Solo es un dato.'
  );
}

export default {
  tiempoUtilDeParada,
  avisarDeParadasSinSusImprescindibles,
  imprescindiblesDeParada,
  cabenLosImprescindibles,
  avisarDeParadasQueNoCaben,
  revisarElReparto,
};
