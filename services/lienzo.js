/**
 * services/lienzo.js
 * -----------------------------------------------------------------------------
 * El lienzo: los días del viaje y lo que hay puesto en cada uno.
 *
 * TODO se calcula en una sola pasada. La pantalla puede tener quince días con
 * cuatro franjas cada uno, y hacer una consulta por franja serían sesenta viajes
 * a la base para pintar algo que cabe en cinco `SELECT`. Así que: cinco
 * consultas, y el reparto por días se hace en memoria.
 *
 * DE DÓNDE SALEN LOS DÍAS
 * De las etapas confirmadas, no de una tabla de días. El día 1 es la fecha de
 * inicio del viaje y hay tantos días como NOCHES: la última noche se duerme en
 * el último día, y ese día es cuando se vuelve. Cada día cae dentro del rango
 * de una etapa (`fecha_inicio <= dia < fecha_fin`), y como las etapas van
 * encadenadas sin huecos, cada día pertenece a una y solo una.
 */

import { todas, una, ejecutar, nochesEntre } from '../db/index.js';
import { direccionDe, claveDeCandidato } from './direcciones.js';
import {
  distanciaKm,
  minutosMinimosEnLlegar,
  minutosQueSePerdonan,
} from './distancias.js';
import { abreEl, abiertoA, horarioPorDias } from './horarios.js';
import { ciudadDeCasa } from './proveedores.js';
import { parametro, parametroTexto } from './orquestador.js';

/** Las cuatro franjas, con sus horas orientativas. */
export const FRANJAS = [
  { clave: 'manana', etiqueta: 'Mañana', horas: 'hasta 13h', desde: 0, hasta: 13 },
  { clave: 'mediodia', etiqueta: 'Mediodía', horas: '13–16h', desde: 13, hasta: 16 },
  { clave: 'tarde', etiqueta: 'Tarde', horas: '16–20h', desde: 16, hasta: 20 },
  { clave: 'noche', etiqueta: 'Noche', horas: 'desde 20h', desde: 20, hasta: 24 },
];

const CLAVES_FRANJA = FRANJAS.map((f) => f.clave);

/** Colores de los chips de ciudad. Rotan por orden de etapa. */
const COLORES_CIUDAD = [
  { fondo: '#D3E8F0', texto: '#12507A' },
  { fondo: '#E1F2E7', texto: '#1E6B3C' },
  { fondo: '#FBEED6', texto: '#8A5A16' },
];

/** Los tipos que pueden estar en la mochila, con su chip. */
export const TIPOS_MOCHILA = [
  { clave: 'sitio', etiqueta: 'Sitios', icono: 'ti-map-pin' },
  { clave: 'actividad', etiqueta: 'Excursiones', icono: 'ti-ticket' },
  { clave: 'comer', etiqueta: 'Comer', icono: 'ti-tools-kitchen-2' },
];

/** "18:30" -> 'tarde'. La franja a la que pertenece una hora por sí sola. */
export function franjaNatural(hora) {
  if (!hora) return null;
  const h = Number(String(hora).split(':')[0]);
  if (!Number.isFinite(h)) return null;
  return FRANJAS.find((f) => h >= f.desde && h < f.hasta)?.clave ?? 'noche';
}

const etiquetaFranja = (clave) =>
  FRANJAS.find((f) => f.clave === clave)?.etiqueta.toLowerCase() ?? clave;

/** "2026-11-10" + 3 -> "2026-11-13". Al mediodía, para no pelearse con el huso. */
function sumarDias(iso, dias) {
  const d = new Date(`${iso}T12:00:00`);
  d.setDate(d.getDate() + Number(dias || 0));
  return d.toISOString().slice(0, 10);
}

const MESES = ['ene','feb','mar','abr','may','jun','jul','ago','sep','oct','nov','dic'];
const comoDia = (iso) => {
  const [, m, d] = iso.split('-').map(Number);
  return `${d} ${MESES[m - 1]}`;
};

// =============================================================================
// EL LIENZO ENTERO
// =============================================================================
/**
 * Todo lo que necesita la pantalla. Es también lo que devuelve la API después
 * de cada cambio, para repintar sin recargar.
 *
 * `etapaId` filtra la vista a una sola parada (los días de esa etapa y su parte
 * de mochila). Sin él, el viaje entero.
 */
export function lienzoDeViaje(viajeId, { etapaId = null } = {}) {
  const viaje = una('SELECT * FROM viajes WHERE id = ?', viajeId);
  if (!viaje) return null;

  // --- 1) Las etapas y sus días ------------------------------------------
  const etapas = todas(
    `SELECT * FROM etapas
      WHERE viaje_id = ? AND estado = 'confirmada' AND fecha_inicio IS NOT NULL
      ORDER BY orden, id`,
    viajeId
  );

  // DIAS, NO NOCHES. Un viaje del 25 al 27 son DOS noches pero TRES dias: el 25,
  // el 26 y el 27. El dia de la vuelta tambien se viaja y tiene sus horas —el
  // vuelo sale por la tarde, así que hay una mañana entera que repartir—, y sin
  // el, el vuelo de vuelta acababa cayendo en el dia anterior y el viaje entero
  // salia descuadrado.
  //
  // `nochesEntre` esta bien y se usa bien en todas partes menos aqui: lo que
  // devuelve son noches, y esta pantalla necesitaba dias.
  const totalDias = nochesEntre(viaje.fecha_inicio, viaje.fecha_fin) + 1;
  const dias = [];

  // Con fecha de ida pero sin fecha de vuelta, `nochesEntre` da 0 y esto daria
  // un dia suelto. Es correcto: un viaje de un dia es un dia.
  if (viaje.fecha_inicio && viaje.fecha_fin && etapas.length) {
    const colorDe = new Map(etapas.map((e, i) => [e.id, COLORES_CIUDAD[i % COLORES_CIUDAD.length]]));

    for (let n = 1; n <= totalDias; n++) {
      const fecha = sumarDias(viaje.fecha_inicio, n - 1);
      // La etapa del dia: aquella cuyo rango lo contiene. El fin es EXCLUSIVO
      // porque ese dia ya se duerme en la siguiente ciudad... salvo en la
      // ultima, que no tiene siguiente: ahi el dia de la vuelta es suyo.
      const etapa =
        etapas.find((e) => fecha >= e.fecha_inicio && fecha < e.fecha_fin) ??
        (fecha >= etapas.at(-1).fecha_inicio ? etapas.at(-1) : etapas[0]);
      dias.push({
        n,
        fecha,
        fechaCorta: comoDia(fecha),
        etapaId: etapa.id,
        ciudad: etapa.nombre_ciudad,
        color: colorDe.get(etapa.id),
        primeroDeEtapa: fecha === etapa.fecha_inicio,
      });
    }
  }

  const diasDeEtapa = new Map();
  for (const d of dias) {
    if (!diasDeEtapa.has(d.etapaId)) diasDeEtapa.set(d.etapaId, []);
    diasDeEtapa.get(d.etapaId).push(d.n);
  }

  // --- 2) Lo colocado -----------------------------------------------------
  const colocadas = todas(
    `SELECT i.*, c.tipo AS c_tipo, c.titulo AS c_titulo, c.precio, c.moneda,
            c.duracion, c.url, e.nombre_ciudad,
            m.tipo AS m_tipo, m.nombre AS m_nombre, m.telefono AS m_telefono,
            t.origen_texto AS t_origen, t.destino_texto AS t_destino
       FROM itinerario i
       LEFT JOIN candidatos c ON c.id = i.candidato_id
       LEFT JOIN catalogo_movilidad m ON m.id = i.movilidad_id
       LEFT JOIN traslados t ON t.id = i.traslado_id
       LEFT JOIN etapas e ON e.id = i.etapa_id
      WHERE i.viaje_id = ?
      ORDER BY i.dia, i.orden, i.id`,
    viajeId
  );

  // Si las fechas del viaje se movieron en la ruta, puede haber filas apuntando
  // a un día que ya no existe. No se borran: se avisa y vuelven a la mochila.
  const fueraDeRango = colocadas.filter((f) => f.dia < 1 || f.dia > totalDias);
  const dentro = colocadas.filter((f) => f.dia >= 1 && f.dia <= totalDias);

  const colocados = dentro.map((f) => ({
    id: f.id,
    dia: f.dia,
    franja: f.franja,
    hora: f.hora,
    orden: f.orden,
    etapaId: f.etapa_id,
    ciudad: f.nombre_ciudad,
    candidatoId: f.candidato_id,
    manual: f.candidato_id == null,
    // UN TRASLADO NO ES UNA ACTIVIDAD. Guarda su nombre en texto_manual —el
    // CHECK de la tabla no admite otra cosa— pero lleva movilidad_id, y por eso
    // se le puede dar su propio tipo en vez de pasar por "manual" a secas.
    tipo: esTraslado(f) ? 'traslado' : f.candidato_id == null ? 'manual' : f.c_tipo,
    nombre: f.candidato_id == null ? f.texto_manual : f.c_titulo,
    precio: f.precio,
    moneda: f.moneda,
    // LA HORA Y LA DURACIÓN SON DEL PLAN, NO DE LA FICHA.
    //
    // La misma catedral puede verse a las diez un martes y a las seis un
    // viernes: eso no es un dato de la catedral, es un dato de ESTE día. Por
    // eso viven en `itinerario` y no en el catálogo, y por eso cualquier
    // tarjeta puede llevarlas, no solo las escritas a mano.
    //
    // Lo tecleado manda sobre lo que diga el catálogo: si alguien pone que su
    // visita al Prado son 90 minutos, son 90, aunque la ficha diga "2 horas".
    duracion: minutosLargos(f.duracion_min),
    // La del catálogo se sigue enseñando cuando no hay una tecleada: es una
    // orientación útil ("2 horas", "7 horas") y no estorba.
    duracionCatalogo: f.duracion,
    // LA DURACIÓN NUNCA ES NULA SI SE PUEDE SABER.
    //
    // Lo tecleado manda; y cuando no hay nada tecleado —las colocaciones de
    // antes de este arreglo, que entraron con NULL— se saca de la ficha o del
    // catálogo AL LEER. Sin esto, una excursión colocada hace tres semanas
    // seguiría ocupando cero y se le podría poner un museo encima, que es
    // exactamente el fallo que se está arreglando.
    duracionMin:
      f.duracion_min ?? (f.candidato_id ? duracionDeLoColocado(f.candidato_id).minutos : null),
    movilidadId: f.movilidad_id ?? null,
    trasladoId: f.traslado_id ?? null,
    // Dos orígenes para el medio, y no se pisan: una ficha de "Moverse" trae su
    // tipo (metro, taxi), y un traslado consultado trae el suyo (andando,
    // coche, público). La columna `medio` es la del segundo.
    medio: f.medio ?? f.m_tipo ?? null,
    telefono: f.m_telefono ?? null,
    url: f.url,
  }));

  // --- 3) La mochila ------------------------------------------------------
  // Lo apuntado en una etapa que todavía no está en ningún día. El NOT EXISTS
  // es lo que hace que una cosa colocada desaparezca de aquí.
  const enMochila = todas(
    `SELECT c.*, e.nombre_ciudad, e.orden AS etapa_orden
       FROM candidatos c
       JOIN etapas e ON e.id = c.etapa_id
      WHERE c.viaje_id = ?
        AND c.tipo IN ('sitio', 'actividad', 'comer')
        AND NOT EXISTS (SELECT 1 FROM itinerario i WHERE i.candidato_id = c.id)
      ORDER BY e.orden, c.tipo, c.id`,
    viajeId
  ).map((c) => ({
    id: c.id,
    tipo: c.tipo,
    nombre: c.titulo,
    precio: c.precio,
    moneda: c.moneda,
    duracion: c.duracion,
    etapaId: c.etapa_id,
    ciudad: c.nombre_ciudad,
  }));

  // Y los que se salieron de rango: vuelven a la mochila aunque tengan fila.
  for (const f of fueraDeRango) {
    if (f.candidato_id == null) continue;   // los manuales no tienen a dónde volver
    enMochila.push({
      id: f.candidato_id,
      tipo: f.c_tipo,
      nombre: f.c_titulo,
      precio: f.precio,
      moneda: f.moneda,
      duracion: f.duracion,
      etapaId: f.etapa_id,
      ciudad: f.nombre_ciudad,
      recolocar: true,
    });
  }

  // --- 4) Los bloques fijos de transporte ---------------------------------
  const fijos = bloquesDeTransporte(viajeId, etapas, dias, diasDeEtapa);

  // --- 4b) DE QUIÉN ES EL DÍA DEL CAMBIO DE CIUDAD -------------------------
  //
  // EL FALLO QUE ORIGINA ESTO. En Grecia el día 4 era el salto de Creta a
  // Atenas con un vuelo a las 23:05, y salió ENTERO en blanco: «llegada
  // nocturna, solo traslado, nada que planificar». Y mientras, Creta expulsaba
  // Rethymno y Spinalonga «por falta de días» teniendo esa jornada completa
  // delante.
  //
  // El motivo es de una línea, y está arriba: el día se le da a la etapa cuyo
  // rango lo contiene, y el fin es EXCLUSIVO, así que el día del cambio es
  // siempre del DESTINO. Con un vuelo de mañana eso es correcto. Con uno de las
  // once de la noche es justo al revés: ese día se vive entero en la ciudad que
  // se abandona y en el destino solo se llega a dormir.
  //
  // La cuenta es la misma que ya se hace con el día de llegada, del otro lado
  // del espejo: el día de llegada empieza cuando sales del aeropuerto; el día de
  // salto ACABA cuando arrancas hacia él. Si delante de ese arranque queda una
  // jornada de verdad, el día es de la ciudad de origen.
  //
  // Se hace aquí y no arriba porque la hora a la que hay que salir la calcula
  // `bloquesDeTransporte` con sus márgenes, y duplicar esa cuenta sería tener
  // dos sitios donde se decide lo mismo.
  reasignarDiasDeTransito(dias, fijos, etapas);
  diasDeEtapa.clear();
  for (const d of dias) {
    if (!diasDeEtapa.has(d.etapaId)) diasDeEtapa.set(d.etapaId, []);
    diasDeEtapa.get(d.etapaId).push(d.n);
  }

  // --- 4c) LO QUE SE QUEDÓ EN UN DÍA DE OTRA CIUDAD ------------------------
  //
  // EL FALLO QUE ORIGINA ESTO, y llevaba ahí desde siempre.
  //
  // Las fechas de las etapas son DERIVADAS: se recalculan en cascada cada vez
  // que se cambian las noches de una parada, y de esas fechas sale de quién es
  // cada día. Pero `itinerario` no guarda la fecha: guarda el NÚMERO de día. Así
  // que al darle una noche más a la primera ciudad, el día 3 deja de ser de
  // Nafplio y pasa a ser de Heraclión —y las tres tarjetas de Nafplio se quedan
  // puestas en el día 3—. Medido en Grecia: siete tarjetas en la ciudad
  // equivocada, el castillo de Nafplio en un día de Creta.
  //
  // Y NO SALTABA NADA. El rescate de más arriba solo mira si el día se sale del
  // viaje (`dia < 1 || dia > totalDias`), y mover una noche de una ciudad a otra
  // no cambia el total de días. El viaje quedaba con buena pinta y mal, que es
  // la peor forma de estar roto.
  //
  // VA AQUÍ Y NO ARRIBA, junto al otro rescate, por una razón concreta: el mapa
  // día→ciudad todavía no era el bueno. `reasignarDiasDeTransito`, cuatro líneas
  // más arriba, le devuelve a la ciudad de ORIGEN el día de un salto nocturno.
  // Comparando antes de eso, un día de tránsito bien montado saldría marcado
  // como descolocado entero.
  //
  // SE TRATAN COMO LAS DE FUERA DE RANGO, que es el caso gemelo: no se borra
  // nada. La fila sigue ahí, la tarjeta sale del día y aparece en la mochila
  // para que se recoloque a mano. Reasignarla sola al día «que le toca» sería
  // adivinar: la etapa puede tener ahora menos días, el hueco puede estar
  // ocupado, la hora se eligió para otro día y el sitio puede cerrar justo ese.
  // Ante la duda, a la mochila, como siempre en esta casa.
  const etapaDelDia = new Map(dias.map((d) => [d.n, d.etapaId]));
  const enCiudadAjena = (c) =>
    c.etapaId != null && etapaDelDia.has(c.dia) && etapaDelDia.get(c.dia) !== c.etapaId;

  const descolocados = colocados.filter(enCiudadAjena);
  for (const c of descolocados) colocados.splice(colocados.indexOf(c), 1);

  for (const c of descolocados) {
    if (c.candidatoId == null) continue; // los manuales no tienen a dónde volver
    enMochila.push({
      id: c.candidatoId,
      tipo: c.tipo,
      nombre: c.nombre,
      precio: c.precio,
      moneda: c.moneda,
      duracion: c.duracionCatalogo,
      etapaId: c.etapaId,
      ciudad: c.ciudad,
      recolocar: true,
    });
  }

  // --- 5) Los avisos ------------------------------------------------------
  ordenarPorHora(colocados);

  const avisos = calcularAvisos(dias, colocados, fijos, viajeId);

  // --- Filtro por etapa ---------------------------------------------------
  const filtrar = (lista) => (etapaId ? lista.filter((x) => x.etapaId === etapaId) : lista);
  const diasVisibles = etapaId ? dias.filter((d) => d.etapaId === etapaId) : dias;
  const visibles = new Set(diasVisibles.map((d) => d.n));

  return {
    viaje: {
      id: viaje.id,
      nombre: viaje.nombre,
      fechaInicio: viaje.fecha_inicio,
      fechaFin: viaje.fecha_fin,
    },
    etapas: etapas.map((e, i) => ({
      id: e.id,
      nombre: e.nombre_ciudad,
      orden: e.orden,
      color: COLORES_CIUDAD[i % COLORES_CIUDAD.length],
      dias: diasDeEtapa.get(e.id) ?? [],
    })),
    etapaId,
    dias: diasVisibles,
    totalDias,
    colocados: colocados.filter((c) => visibles.has(c.dia)),
    mochila: filtrar(enMochila),
    fijos: fijos.filter((f) => visibles.has(f.dia)),
    avisos: avisos.filter((a) => visibles.has(a.dia)),
    porRecolocar: fueraDeRango.length + descolocados.length,
    // LAS QUE SE QUEDARON EN UN DÍA DE OTRA CIUDAD, SIN FILTRAR POR ETAPA.
    //
    // Van enteras y no por la vista porque quien las quiere no es la pantalla
    // —ahí ya se ven, en la mochila— sino `recalcularRuta`, que escribe la línea
    // del registro justo después de mover las noches y necesita nombrarlas todas.
    descolocados,
    // Solo se enseñan los chips de tipo que de verdad hay algo.
    tiposPresentes: TIPOS_MOCHILA.filter((t) => enMochila.some((m) => m.tipo === t.clave)),
    franjas: FRANJAS,
  };
}

// =============================================================================
// LOS BLOQUES FIJOS
// =============================================================================
/**
 * Los tramos resueltos, colocados en el día y la franja que les toca.
 *
 * Los pendientes no pintan nada: un bloque ámbar que dice "aún no sé cómo vas"
 * ocuparía sitio en el día sin aportar. Para eso está la pantalla de ruta.
 */
/** "sobre las 09:30" -> "09:30". La hora, venga como venga escrita. */
function horaSuelta(texto) {
  const m = String(texto ?? '').match(/(\d{1,2}):(\d{2})/);
  if (!m) return null;
  const h = Number(m[1]);
  const min = Number(m[2]);
  if (h > 23 || min > 59) return null;
  return `${String(h).padStart(2, '0')}:${m[2]}`;
}

/** "11:00" + 375 min -> "17:15". Si se pasa de medianoche, se queda en 23:59. */
function sumarMinutos(hora, minutos) {
  const base = horaSuelta(hora);
  const m = Number(minutos);
  // Acepta minutos negativos: se usa para ir HACIA ATRÁS desde la hora de un
  // vuelo hasta la hora a la que hay que salir de casa.
  if (!base || !Number.isFinite(m) || m === 0) return null;
  const [h, mm] = base.split(':').map(Number);
  const total = Math.max(0, Math.min(h * 60 + mm + Math.round(m), 23 * 60 + 59));
  return `${String(Math.floor(total / 60)).padStart(2, '0')}:${String(total % 60).padStart(2, '0')}`;
}

/**
 * LO QUE OCUPA UN SALTO, de puerta a puerta.
 *
 * La fase 2 guarda las dos piezas: la hora que eligió (en `transporte_datos`) y
 * el desglose puerta a puerta (en `transportes.datos_extra.bloque`). Aquí se
 * juntan, porque un traslado no es un instante: el Pendolino de las 11:00 con
 * seis horas por delante deja el día libre a las 17:15, no a las 11:00.
 *
 * Sin esto, el bloque del salto entraba en el lienzo como un punto en la mañana
 * y la IA de la fase 6 concluía «llegada por la mañana» y llenaba la tarde de
 * una ciudad por la que todavía se iba en tren.
 */
/**
 * LO QUE OCUPA UN VUELO O UN TRASLADO, ANTELACIÓN INCLUIDA.
 *
 * Un vuelo de las 19:30 no empieza a las 19:30: empieza cuando hay que salir
 * hacia el aeropuerto. En Grecia se colocó Plaka de 16:00 a 19:00 con vuelo a
 * las 19:30 y el validador no dijo nada, porque el bloque empezaba al despegar y
 * no se solapaba. A las 19:30 hay que llevar dos horas facturado.
 *
 * Así que el bloque se estira hacia atrás: hora de salida menos la presentación
 * —150 minutos en un aeropuerto, 30 en una estación— menos lo que se tarda en
 * llegar hasta allí. Y hacia delante en la llegada: el día no empieza al
 * aterrizar, empieza al salir con las maletas.
 */
function margenesDelBloque() {
  return {
    presentacionVuelo: parametro('presentacion_vuelo_min', 150),
    presentacionTren: parametro('presentacion_tren_min', 30),
    acceso: parametro('acceso_por_defecto_min', 45),
    salidaAeropuerto: parametro('salida_del_aeropuerto_min', 40),
  };
}

/** Cuánto antes hay que salir de casa para coger eso. */
function antelacionDe(tipo, m) {
  const esVuelo = tipo === 'vuelo' || tipo === 'avion';
  return (esVuelo ? m.presentacionVuelo : m.presentacionTren) + m.acceso;
}

function ocupacionDelSalto(t) {
  const datos = t.ficha_transporte_id
    ? una(
        'SELECT horario FROM transporte_datos WHERE transporte_id = ? AND ficha_id = ?',
        t.id,
        t.ficha_transporte_id
      )
    : null;

  // La hora sale de lo elegido; si no la hay, de las notas escritas a mano.
  const hora = horaSuelta(datos?.horario) ?? horaSuelta(t.notas);

  let bloque = null;
  try {
    bloque = t.datos_extra ? JSON.parse(t.datos_extra)?.bloque ?? null : null;
  } catch {
    /* datos_extra corrupto: el bloque se queda sin desglose */
  }

  const total = Number(bloque?.total);
  const minutos = Number.isFinite(total) && total > 0 ? Math.round(total) : null;

  // LA FRANJA SE ABRE CON LOS MÁRGENES DEL PROPIO BLOQUE.
  //
  // Esto hacía dos cuentas que no casaban entre sí. Para el principio restaba un
  // margen GENÉRICO —30 de presentación + 45 de acceso, 75 para todo— y para el
  // final sumaba `total` ENTERO a la hora del billete. Pero `total` ya lleva
  // dentro el acceso y la antelación, que pasan ANTES de subirse: sumarlos hacia
  // delante los cuenta dos veces y estira la llegada.
  //
  // El coche de Heraclión salía «sales a las 08:45» con la franja «10:00 →
  // 13:45»: leído entero son cinco horas para un bloque que dice 3h45, y ninguna
  // de las dos cuentas usaba los 120 minutos de margen que el propio bloque
  // llevaba escritos.
  //
  // Ahora: empieza en la hora del billete menos lo que hay que hacer antes
  // (acceso + antelación) y acaba en la hora del billete más lo que queda por
  // delante (trayecto + salida). Sin bloque no hay desglose y se recurre al
  // margen genérico, que es lo que había.
  const m = margenesDelBloque();
  const antes = bloque
    ? (Number(bloque.acceso) || 0) + (Number(bloque.antelacion) || 0)
    : antelacionDe(t.tipo, m);
  const despues = bloque
    ? (Number(bloque.trayecto) || 0) + (Number(bloque.salida) || 0)
    : minutos;

  return {
    hora: hora ? sumarMinutos(hora, -antes) : null,
    salidaReal: hora,
    minutos,
    fin: sumarMinutos(hora, despues),
    // Lo que se va MONTADO, aparte del total. Es lo único comparable con la
    // referencia por carretera, y sale de aquí para no volver a parsear
    // `datos_extra` en quien lo necesite.
    trayecto: Number.isFinite(Number(bloque?.trayecto)) && Number(bloque.trayecto) > 0
      ? Number(bloque.trayecto)
      : null,
  };
}

/**
 * EL DÍA DEL SALTO SE LO QUEDA QUIEN SE QUEDA LA JORNADA.
 *
 * Mira, para cada día que tiene un salto entre dos etapas, cuánto queda de día
 * ÚTIL por delante del traslado. Si esa franja da para una jornada —el mismo
 * umbral que usa `esDiaDeViaje`, para que las dos digan lo mismo— el día pasa a
 * ser de la ciudad de origen, que es donde se va a pasar.
 *
 * No toca nada más: los bloques fijos se quedan donde estaban —el vuelo sigue
 * siendo del día 4— y lo único que cambia es a qué parada pertenece ese día. Es
 * lo que decide qué sitios se pueden colocar ahí y a quién se le cuentan los
 * días útiles al repartir.
 */
function reasignarDiasDeTransito(dias, fijos, etapas) {
  const minimo = parametro('minutos_utiles_dia_de_viaje', 240);
  const INICIO = 9 * 60;

  for (const d of dias) {
    const salto = fijos.find((f) => f.dia === d.n && f.donde === 'salto');
    if (!salto) continue;

    // El bloque del salto viene con `etapaId` del DESTINO. Si el día ya no es
    // suyo, alguien lo movió antes y aquí no hay nada que hacer.
    if (d.etapaId !== salto.etapaId) continue;

    const arranca = enMinutos(salto.hora);
    if (arranca == null) continue;

    // Lo que queda de día en la ciudad que se abandona, antes de salir hacia el
    // aeropuerto o la estación.
    if (arranca - INICIO < minimo) continue;

    const origen = etapas.find((e) => e.id !== salto.etapaId && e.fecha_fin === d.fecha);
    if (!origen) continue;

    d.etapaId = origen.id;
    d.ciudad = origen.nombre_ciudad;
    d.primeroDeEtapa = false;
  }
}

function bloquesDeTransporte(viajeId, etapas, dias, diasDeEtapa) {
  if (!dias.length) return [];

  const casa = ciudadDeCasa(viajeId);
  const tramos = todas(
    `SELECT t.*, c.titulo AS vuelo_titulo, c.datos_extra AS vuelo_extra
       FROM transportes t
       LEFT JOIN candidatos c ON c.id = t.candidato_id
      WHERE t.viaje_id = ?`,
    viajeId
  );

  const porEtapa = new Map(etapas.map((e) => [e.id, e]));
  const ultimoDia = dias.at(-1).n;
  const bloques = [];
  const margenes = margenesDelBloque();

  /**
   * El dia que le toca a una fecha.
   *
   * Se busca POR FECHA y no por posicion: el vuelo de vuelta del 27 tiene que
   * caer en el dia 27, no en "el ultimo dia que haya", que es lo que lo dejaba
   * en el 26 cuando faltaba un dia por generar.
   */
  const diaDeLaFecha = (fecha) => (fecha ? dias.find((d) => d.fecha === fecha)?.n ?? null : null);

  for (const t of tramos) {
    // UN TRAMO RESUELTO SE PINTA, LO RESUELVA QUIEN LO RESUELVA.
    //
    // Aquí se miraban dos de las tres formas de tenerlo decidido: el vuelo
    // (`candidato_id`) y lo escrito a mano (`notas`). Faltaba la tercera, que es
    // elegir un medio por tierra —el botón de "Cómo llegar"—, que deja
    // `ficha_transporte_id`. Resultado: elegías el tren de Cracovia a Varsovia,
    // Mi ruta lo daba por resuelto, y en el lienzo ese día no aparecía nada: el
    // día del cambio quedaba libre y se podían colocar cosas encima del viaje.
    if (!t.candidato_id && !t.notas && !t.ficha_transporte_id) continue;

    const origen = t.etapa_origen_id ? porEtapa.get(t.etapa_origen_id) : null;
    const destino = t.etapa_destino_id ? porEtapa.get(t.etapa_destino_id) : null;
    if (t.etapa_origen_id && !origen) continue;
    if (t.etapa_destino_id && !destino) continue;

    const donde = !origen ? 'ida' : !destino ? 'vuelta' : 'salto';
    const horas = horasDelVuelo(t.vuelo_extra);

    let dia;
    let hora;
    let franjaPorDefecto;
    let texto;
    let icono;
    // Un salto ocupa un rato; un vuelo de ida o de vuelta se pinta como el punto
    // en que se llega o se sale, que es como se lee.
    let duracionMin = null;
    let horaFin = null;
    // La hora del billete, que es distinta de cuándo empieza a ocupar el día.
    let salidaReal = null;
    // Lo que ha costado llegar, solo en el bloque de ida.
    let esfuerzo = null;
    // Lo que se va MONTADO, solo en un salto. Se declara aquí porque el `push`
    // de abajo está fuera del if y `ocupa` vive dentro de su rama.
    let trayectoMin = null;
    // A qué hora hay que ESTAR en el aeropuerto, solo en el bloque de vuelta.
    // Es el límite de verdad de ese día: llegar cuando el avión ya embarca no es
    // llegar. Se guarda porque el aviso de «el traslado de salida no llega» lo
    // necesita, y hasta ahora solo existía dentro del texto que se pinta.
    let horaEnPuerta = null;
    // El aeropuerto REAL del vuelo, que no tiene por que ser el de la ciudad.
    let aeropuerto = null;

    if (donde === 'ida') {
      // Se llega el dia en que empieza la primera parada.
      dia = diaDeLaFecha(destino.fecha_inicio) ?? 1;
      esfuerzo = esfuerzoDelVuelo(t.vuelo_extra);
      hora = horas.llegada;
      // EL DÍA NO EMPIEZA AL ATERRIZAR: empieza al salir con las maletas.
      horaFin = sumarMinutos(hora, margenes.salidaAeropuerto);
      franjaPorDefecto = 'manana';
      icono = 'ti-plane-arrival';
      aeropuerto = horas.hasta ?? null;
      texto =
        `Llegada a ${destino.nombre_ciudad}${aeropuerto ? ` (${aeropuerto})` : ''}` +
        (hora ? ` ${hora}` : '') +
        (horaFin ? ` · fuera del aeropuerto ${horaFin}` : '');
    } else if (donde === 'vuelta') {
      // Se vuelve el dia en que acaba la ultima parada, que es la fecha de
      // vuelta del viaje.
      dia = diaDeLaFecha(origen.fecha_fin) ?? ultimoDia;

      // EL BLOQUE EMPIEZA CUANDO HAY QUE SALIR HACIA EL AEROPUERTO. Con el
      // despegue como inicio, una visita que acababa a las 19:00 no chocaba con
      // un vuelo de las 19:30, y sí choca: a esa hora ya hay que estar dentro.
      const despegue = horas.salida;
      const enElAeropuerto = sumarMinutos(despegue, -margenes.presentacionVuelo);
      horaEnPuerta = enElAeropuerto;
      hora = sumarMinutos(despegue, -antelacionDe('vuelo', margenes)) ?? despegue;
      horaFin = null; // desde que se sale, el día ya no es de esta ciudad
      franjaPorDefecto = 'tarde';
      icono = 'ti-plane-departure';
      salidaReal = despegue;
      aeropuerto = horas.desde ?? null;
      texto =
        `Vuelo ${origen.nombre_ciudad}${aeropuerto ? ` (${aeropuerto})` : ''} → ${casa}` +
        (despegue ? ` ${despegue}` : '') +
        (enElAeropuerto ? ` · en el aeropuerto ${enElAeropuerto}` : '');
    } else {
      // Un salto se hace el dia en que empieza la etapa a la que se llega.
      dia = diaDeLaFecha(destino.fecha_inicio) ?? (diasDeEtapa.get(destino.id) ?? [])[0] ?? null;
      const ocupa = ocupacionDelSalto(t);
      trayectoMin = ocupa.trayecto;
      hora = ocupa.hora;
      duracionMin = ocupa.minutos;
      horaFin = ocupa.fin;
      salidaReal = ocupa.salidaReal;
      franjaPorDefecto = 'manana';
      icono = ICONO_TIPO[t.tipo] ?? 'ti-arrow-right';
      // Se enseña la hora del billete —que es la que hay que coger— y entre
      // paréntesis desde cuándo ocupa el día, que es lo que manda para colocar.
      texto =
        resumenDeSalto(t, origen, destino) +
        (ocupa.salidaReal && ocupa.fin ? ` · ${ocupa.salidaReal} → ${ocupa.fin}` : '') +
        (ocupa.hora && ocupa.salidaReal && ocupa.hora !== ocupa.salidaReal
          ? ` (sales a las ${ocupa.hora})`
          : '');
    }

    if (!dia) continue;

    bloques.push({
      id: t.id,
      dia,
      franja: franjaNatural(hora) ?? franjaPorDefecto,
      hora,
      // La del billete. La de arriba es cuándo hay que salir de casa, que es lo
      // que ocupa el día; esta es la que se dice en voz alta.
      salidaReal: salidaReal ?? hora,
      // Solo en la vuelta: la hora de estar dentro del aeropuerto.
      horaEnPuerta,
      // El codigo IATA del aeropuerto de verdad, en ida y en vuelta.
      aeropuerto,
      // Hasta cuándo dura y cuándo queda el día libre. Lo usan los avisos —para
      // ver qué se ha puesto encima del viaje— y la fase 6, que necesita saber a
      // qué hora empieza de verdad el día.
      duracionMin,
      horaFin,
      donde,
      icono,
      texto,
      // LAS TRES DURACIONES, PARA PODER COMPARARLAS.
      //
      // `referenciaMin` es la ruta por carretera que mide Google entre las dos
      // ciudades. `trayectoMin` es lo que se va montado según el medio elegido, y
      // es la que se compara con ella: las dos son tiempo de camino. `puertaMin`
      // es el total con acceso, antelación y salida, y sirve para pintar, no para
      // comparar — sumarle los márgenes a un lado de una división falsea el
      // cociente.
      referenciaMin: t.fuente_distancia === 'carretera' ? t.duracion_min ?? null : null,
      trayectoMin,
      puertaMin: t.duracion_puerta_min ?? null,
      ciudades: origen && destino ? `${origen.nombre_ciudad} → ${destino.nombre_ciudad}` : null,
      // Solo en el bloque de ida: cuánto se ha volado y cuántos husos se han
      // cruzado. Es lo que convierte el día de llegada en un día de
      // aclimatación en vez de en un día normal con menos horas.
      esfuerzo,
      etapaId: dias.find((d) => d.n === dia)?.etapaId ?? null,
    });
  }

  return bloques;
}

const ICONO_TIPO = {
  tren: 'ti-train', bus: 'ti-bus', coche: 'ti-car', ferry: 'ti-ship', vuelo: 'ti-plane',
};

const ETIQUETA_TIPO = {
  tren: 'Tren', bus: 'Autobús', coche: 'Coche', ferry: 'Ferry', vuelo: 'Vuelo',
};

/** "Shinkansen Tokio → Kioto · 2h15", con lo que se sepa del tramo. */
function resumenDeSalto(t, origen, destino) {
  const trozos = [];

  // El medio elegido por tierra manda sobre la etiqueta genérica: "Shinkansen"
  // dice más que "Tren", y es lo que se eligió.
  const ficha = t.ficha_transporte_id
    ? una('SELECT nombre, duracion FROM catalogo_transporte_tramo WHERE id = ?', t.ficha_transporte_id)
    : null;

  // El nombre del medio elegido MANDA sobre las notas. Las notas llevan además
  // la hora ("BlaBlaCar · sale 10:30"), se pasan del ancho del chip y acababan
  // cayendo a la etiqueta genérica: el día decía "Coche" para un BlaBlaCar.
  if (ficha?.nombre) {
    trozos.push(String(ficha.nombre).slice(0, 34));
  } else if (t.notas) {
    // De las notas, lo primero: el bloque del día es estrecho.
    const corto = String(t.notas).replace(/\s+/g, ' ').split(/[,.;]/)[0].trim();
    trozos.push(corto.length > 3 && corto.length < 34 ? corto : ETIQUETA_TIPO[t.tipo] ?? t.tipo);
  } else {
    trozos.push(t.vuelo_titulo || ETIQUETA_TIPO[t.tipo] || t.tipo);
  }
  trozos.push(`${origen.nombre_ciudad} → ${destino.nombre_ciudad}`);

  // CADA DURACIÓN CON SU NOMBRE.
  //
  // Aquí se soltaba una cifra desnuda —«Coche · Heraclión → Nafplio · 10h34»— y
  // el lector no tenía cómo saber de qué hablaba. En Nafplio → Atenas el chip
  // decía «2h01» y la franja de al lado «3h20», y las dos eran ciertas: una es
  // el trayecto y la otra el puerta a puerta con su acceso y su antelación. Sin
  // etiqueta, parecían contradecirse.
  //
  // El trayecto solo se enseña cuando la referencia habla del mismo camino que
  // el medio elegido: por carretera o por vía. La referencia de un ferry es un
  // rodeo por tierra que nadie va a hacer. Los trenes entran ahora —antes se
  // quedaban fuera y el salto Cracovia → Varsovia no enseñaba duración ninguna—,
  // porque una vía y una carretera van por el mismo sitio a efectos de esto.
  const porTierra = t.tipo === 'coche' || t.tipo === 'bus' || t.tipo === 'tren';
  if (t.duracion_min && t.fuente_distancia === 'carretera' && porTierra) {
    trozos.push(`${comoRatoCorto(t.duracion_min)} de trayecto`);
  }
  if (t.duracion_puerta_min) {
    trozos.push(`${comoRatoCorto(t.duracion_puerta_min)} puerta a puerta`);
  }
  return trozos.join(' · ');
}

/**
 * 634 -> "10h34" · 200 -> "3h20" · 45 -> "45 min".
 *
 * Sin espacios, que es el formato del chip del día: ahí el sitio se cuenta en
 * píxeles. Más abajo hay un `comoRato` que escribe "10 h 34" para los textos
 * que se leen en una línea entera; son dos formatos a propósito.
 */
function comoRatoCorto(minutos) {
  const n = Math.round(Number(minutos) || 0);
  const h = Math.floor(n / 60);
  const m = n % 60;
  if (!h) return `${m} min`;
  return m ? `${h}h${String(m).padStart(2, '0')}` : `${h}h`;
}

/**
 * Horas de llegada y de salida de un vuelo elegido.
 *
 * Una tarjeta de Kayak trae los dos trayectos en `datos_extra.tramos`: el
 * primero es la ida y el segundo la vuelta. De la ida interesa cuándo se
 * ATERRIZA (es lo que marca a qué hora empieza el viaje de verdad) y de la
 * vuelta cuándo se DESPEGA.
 */
/**
 * CUÁNTO DURA UN VUELO Y CUÁNTOS HUSOS CRUZA.
 *
 * EL FALLO QUE ORIGINA ESTO. Tras un vuelo nocturno intercontinental de más de
 * doce horas y con un salto horario grande, el día de llegada se montó con
 * actividades desde primera hora y carga completa, igual que una llegada
 * europea de dos horas. El lienzo no distinguía: una llegada era una hora en el
 * reloj y nada más.
 *
 * LOS HUSOS NO SE INVENTAN NI SE BUSCAN: se restan. La tarjeta del vuelo trae la
 * hora de salida, la de llegada, si cae al día siguiente y la duración REAL del
 * trayecto. La diferencia entre lo que marca el reloj y lo que de verdad se ha
 * volado ES el cambio horario, exactamente y sin preguntarle a nadie:
 *
 *     Barcelona 12:00 → Bangkok 06:00 (+1), 13 h de vuelo
 *     reloj: 18 h · vuelo: 13 h · husos: 5
 *
 * Devuelve null cuando falta alguno de los dos datos: sin duración no hay resta
 * que hacer, y suponerla sería justo lo contrario de lo que se busca aquí.
 */
function esfuerzoDelVuelo(datosExtra) {
  if (!datosExtra) return null;
  let tramo = null;
  try {
    const extra = JSON.parse(datosExtra);
    const tramos = extra.tramos ?? [];
    tramo = tramos.find((x) => x.tramo === 'ida') ?? tramos[0] ?? null;
  } catch {
    return null;
  }
  if (!tramo) return null;

  // "13h 05m", "2h 30m", "45m"
  const d = /(?:(\d+)\s*h)?\s*(?:(\d+)\s*m)?/.exec(String(tramo.duracion ?? ''));
  const minutosDeVuelo = d ? Number(d[1] ?? 0) * 60 + Number(d[2] ?? 0) : 0;
  if (!minutosDeVuelo) return null;

  const salida = enMinutos(normalizarHora(tramo.horaSalida));
  const llegada = enMinutos(normalizarHora(tramo.horaLlegada));
  if (salida == null || llegada == null) {
    return { horas: minutosDeVuelo / 60, husos: null };
  }

  const dias = Number(tramo.diasDespues) || 0;
  const enElReloj = llegada + dias * 24 * 60 - salida;

  // El cambio horario, en husos. Se redondea porque hay husos de media hora y
  // aquí lo que importa es el orden de magnitud, no la geografía.
  const husos = Math.round((enElReloj - minutosDeVuelo) / 60);

  return { horas: minutosDeVuelo / 60, husos };
}

/**
 * Y DE PASO, EL AEROPUERTO DE VERDAD.
 *
 * El candidato se titula con el codigo IATA de la CIUDAD que resolvio la fase 1
 * —«Wizz Air · vuelta (WAW)»— y el vuelo elegido salia de WMI, que es Modlin, a
 * cuarenta kilometros del centro de Varsovia. El dato bueno estaba guardado un
 * nivel mas abajo, en el tramo, y no lo leia nadie.
 *
 * No es cosmetico: el acceso al aeropuerto se calcula con un numero generico de
 * 45 minutos que vale para Chopin y no para Modlin.
 */
function horasDelVuelo(datosExtra) {
  if (!datosExtra) return { llegada: null, salida: null, desde: null, hasta: null };
  try {
    const extra = JSON.parse(datosExtra);
    const tramos = extra.tramos ?? [];

    // UN SOLO TRAYECTO = búsqueda de solo ida, que es como se buscan ahora los
    // tramos de la ruta. Ese trayecto ES el de este tramo, así que sus dos
    // horas valen: el bloque de ida usa la de llegada y el de vuelta la de
    // salida. Buscando un trayecto llamado "vuelta" —que en una tarjeta de solo
    // ida no existe— el vuelo de vuelta se quedaba sin hora y sin franja.
    if (tramos.length === 1) {
      return {
        llegada: normalizarHora(tramos[0].horaLlegada),
        salida: normalizarHora(tramos[0].horaSalida),
        desde: tramos[0].aeropuertoOrigen ?? null,
        hasta: tramos[0].aeropuertoDestino ?? null,
      };
    }

    // DOS TRAYECTOS = una tarjeta de ida y vuelta, de la búsqueda del viaje
    // entero. Cada hora sale del suyo.
    const ida = tramos.find((x) => x.tramo === 'ida') ?? tramos[0];
    const vuelta = tramos.find((x) => x.tramo === 'vuelta') ?? tramos[1];
    return {
      llegada: normalizarHora(ida?.horaLlegada),
      salida: normalizarHora(vuelta?.horaSalida),
      desde: vuelta?.aeropuertoOrigen ?? null,
      hasta: ida?.aeropuertoDestino ?? null,
    };
  } catch {
    return { llegada: null, salida: null, desde: null, hasta: null };
  }
}

/** Kayak escribe "7:30"; aquí se guarda "07:30" para que ordene bien. */
function normalizarHora(h) {
  if (!h) return null;
  const m = /^(\d{1,2}):(\d{2})/.exec(String(h).trim());
  return m ? `${m[1].padStart(2, '0')}:${m[2]}` : null;
}

// =============================================================================
// LOS AVISOS
// =============================================================================
/**
 * Incoherencias del reparto. Se calculan al pintar y NO bloquean nada: son
 * para que uno se dé cuenta, no para impedirle hacer lo que quiera. Igual has
 * puesto ahí el museo a propósito porque piensas cambiar el vuelo.
 */
function calcularAvisos(dias, colocados, fijos, viajeId) {
  const avisos = [];
  const indice = (clave) => CLAVES_FRANJA.indexOf(clave);

  // A QUÉ HORA DEJA DE EMPEZARSE NADA, y cuánto se respeta tras aterrizar.
  //
  // Estos dos números existían desde el correctivo del Peloponeso, pero solo los
  // miraba `horaLibreEn`, que es el buscador de huecos de la REVISIÓN. El camino
  // normal —la fase colocando lo que dijo la IA— no pasaba por ahí, así que en
  // Tesalónica se colocó Ladadika a las 23:15 el día que se aterrizaba a las
  // 22:25 y nadie protestó. Un número que solo se comprueba en un camino no es
  // una regla: es una casualidad. Aquí lo ve el validador, en todos los días y
  // venga de donde venga lo colocado.
  const topeDelDia = enMinutos(parametroTexto('hora_maxima_inicio', '22:00')) ?? 22 * 60;
  const margenTrasLlegar = parametro('margen_tras_llegada_min', 60);

  for (const d of dias) {
    const delDia = colocados.filter((c) => c.dia === d.n);

    // --- Nada que empiece a partir del tope, en ningún día ------------------
    const tardias = delDia.filter((c) => {
      const h = enMinutos(c.hora);
      return h != null && h >= topeDelDia;
    });
    if (tardias.length) {
      avisos.push({
        dia: d.n,
        tipo: 'muy-tarde',
        idsAfectados: tardias.map((c) => c.id),
        texto:
          `${tardias.map((c) => c.nombre).join(', ')}: a partir de las ` +
          `${comoHora(topeDelDia)} ya no se empieza nada`,
      });
    }

    // --- Ni pegado a una llegada de noche -----------------------------------
    //
    // El día de la llegada no empieza al aterrizar: empieza al salir del
    // aeropuerto con las maletas, y todavía hay que llegar al hotel. Aterrizar a
    // las 22:25 y tener algo a las 23:15 no es un plan apretado: es un plan que
    // no existe.
    const llegadaDelDia = fijos.find((f) => f.dia === d.n && f.donde === 'ida');
    const finDeLlegada = llegadaDelDia
      ? enMinutos(llegadaDelDia.horaFin) ?? enMinutos(llegadaDelDia.hora)
      : null;
    if (finDeLlegada != null) {
      const pronto = delDia.filter((c) => {
        const h = enMinutos(c.hora);
        return h != null && h < finDeLlegada + margenTrasLlegar && !tardias.includes(c);
      });
      if (pronto.length) {
        avisos.push({
          dia: d.n,
          tipo: 'recien-llegado',
          idsAfectados: pronto.map((c) => c.id),
          libreDesde: comoHora(finDeLlegada + margenTrasLlegar),
          texto:
            `Sales del aeropuerto a las ${comoHora(finDeLlegada)} — ` +
            `${pronto.map((c) => c.nombre).join(', ')} no cabe hasta las ` +
            `${comoHora(finDeLlegada + margenTrasLlegar)}`,
        });
      }
    }

    // 1) Cosas puestas ANTES de llegar.
    const llegada = fijos.find((f) => f.dia === d.n && f.donde === 'ida');
    if (llegada) {
      const antes = delDia.filter((c) => indice(c.franja) < indice(llegada.franja));
      if (antes.length) {
        avisos.push({
          dia: d.n,
          tipo: 'antes-de-llegar',
          idsAfectados: antes.map((c) => c.id),
          texto:
            `Llegas${llegada.hora ? ` a las ${llegada.hora}` : ''} — ` +
            `tienes ${antes.length} ${antes.length === 1 ? 'cosa' : 'cosas'} antes de llegar`,
        });
      }
    }

    // 2) Y cosas puestas DESPUÉS de irse, que es el mismo error al revés.
    const salida = fijos.find((f) => f.dia === d.n && f.donde === 'vuelta');
    if (salida) {
      const despues = delDia.filter((c) => indice(c.franja) > indice(salida.franja));
      if (despues.length) {
        avisos.push({
          dia: d.n,
          tipo: 'despues-de-irse',
          idsAfectados: despues.map((c) => c.id),
          texto:
            `Te vas${salida.hora ? ` a las ${salida.hora}` : ''} — ` +
            `tienes ${despues.length} ${despues.length === 1 ? 'cosa' : 'cosas'} después de irte`,
        });
      }
    }

    // 3) Una hora que no cuadra con la franja donde está.
    for (const c of delDia) {
      const natural = franjaNatural(c.hora);
      if (natural && natural !== c.franja) {
        avisos.push({
          dia: d.n,
          tipo: 'hora-franja',
          idsAfectados: [c.id],
          texto: `${c.nombre} empieza a las ${c.hora} (${etiquetaFranja(natural)})`,
        });
      }
    }
  }

  // 4) Y si entre dos cosas seguidas no cabe el trayecto.
  avisos.push(...avisosDeTiempo(dias, colocados));

  // 5) Y si un sitio cierra justo el día en que lo has puesto.
  avisos.push(...avisosDeCierre(dias, colocados, viajeId));

  // 6) Y si has puesto algo mientras vas dentro del tren.
  avisos.push(...avisosDeTraslado(dias, colocados, fijos));

  // 6a) Y si la duración del traslado elegido no se cree.
  avisos.push(...avisosDeTrasladoIncompleto(fijos));
  avisos.push(...avisosDeLaSalidaQueNoLlega(fijos));

  // 6b) Y si algo pisa el vuelo de llegada o el de salida, a la hora exacta.
  avisos.push(...avisosContraFijos(dias, colocados, fijos));

  // 7) Y si un día se ha quedado sin comer.
  avisos.push(...avisosDeComida(dias, colocados, fijos));

  return avisos;
}

// =============================================================================
// ¿ESTÁ ABIERTO ESE DÍA?
// -----------------------------------------------------------------------------
// Muchos museos cierran los lunes y muchos palacios los martes, y eso no se ve
// mirando un lienzo: la tarjeta cae igual de bien en cualquier columna. Se
// descubre en la puerta.
//
// LOS HORARIOS SALEN DE LA BÚSQUEDA, no de Places ni de la IA: es la columna
// `horarios` de `sitios_lugar`, que rellena services/datos-sitios.js con lo que
// devolvió Google.
//
// Y SE INTERPRETAN EN LA FASE «QUÉ VER», no aquí y no al pintar. Un horario es
// una frase en cristiano —"cerrado los lunes", "martes a domingo de 9 a 18"— y
// traducirla a días de la semana lo hace `interpretarHorariosDelCatalogo` en
// cuanto el texto está descargado, con el catálogo entero de la ciudad por
// delante.
//
// ANTES SE ENCOLABA DESDE AQUÍ, Y ERA TARDE. Este módulo pinta un lienzo que ya
// está repartido: pedir los días de cierre en este punto es pedirlos después de
// que alguien haya decidido qué va cada día. En Túnez el Museo del Bardo supo
// que cerraba los lunes 44 segundos después de que lo colocaran.
//
// Lo de aquí abajo no lee `cierra_dias`: lee el texto del horario, que es la
// única fuente que no se queda vieja. `cierra_dias` existe para el prompt del
// reparto, que es quien decide y quien necesitaba saberlo antes.
// =============================================================================

const DIAS_SEMANA = ['domingo', 'lunes', 'martes', 'miércoles', 'jueves', 'viernes', 'sábado'];

/**
 * "los lunes", "los jueves", "los sábados".
 *
 * En castellano los días acabados en -s no cambian en plural, y añadirles una
 * ese daba "los juevess". Solo sábado y domingo la llevan.
 */
const enPlural = (n) => (n === 0 || n === 6 ? `${DIAS_SEMANA[n]}s` : DIAS_SEMANA[n]);

/** "2026-10-14" -> 0..6, con el domingo en el 0, como `getDay`. */
function diaDeLaSemana(iso) {
  const [a, m, d] = String(iso ?? '').slice(0, 10).split('-').map(Number);
  if (!a || !m || !d) return null;
  return new Date(Date.UTC(a, m - 1, d)).getUTCDay();
}

/**
 * Los sitios con horario, y lo que se haya interpretado de él.
 *
 * Se piden todos de una vez: una consulta por tarjeta serían quince consultas
 * para pintar un lienzo.
 */
function cierresDeLosSitios(ids) {
  const lista = [...new Set(ids.filter(Boolean))];
  if (!lista.length) return new Map();

  const filas = todas(
    `SELECT id, nombre, horarios, cierra_dias FROM sitios_lugar
      WHERE id IN (${lista.map(() => '?').join(',')}) AND horarios IS NOT NULL`,
    ...lista
  );

  return new Map(
    filas.map((f) => {
      let dias = null;
      try {
        dias = f.cierra_dias ? JSON.parse(f.cierra_dias) : null;
      } catch { dias = null; }
      return [f.id, { ...f, dias: Array.isArray(dias) ? dias : null }];
    })
  );
}

/**
 * Avisos de "ese día está cerrado", y de paso encola lo que falte interpretar.
 */
function avisosDeCierre(dias, colocados, viajeId) {
  const avisos = [];

  // De cada tarjeta a su fila de catálogo, que es la que tiene el horario.
  const claves = new Map();
  for (const c of colocados) {
    if (!c.candidatoId) continue;
    const cand = una('SELECT * FROM candidatos WHERE id = ?', c.candidatoId);
    const clave = cand ? claveDeCandidato(cand) : null;
    if (clave?.tipo === 'sitio') claves.set(c.id, clave.id);
  }
  if (!claves.size) return avisos;

  const cierres = cierresDeLosSitios([...claves.values()]);

  for (const d of dias) {
    const queDia = diaDeLaSemana(d.fecha);
    if (queDia == null) continue;

    for (const c of colocados.filter((x) => x.dia === d.n)) {
      const sitioId = claves.get(c.id);
      if (!sitioId) continue;

      const info = cierres.get(sitioId);
      if (!info) continue;                       // sin horario: nada que decir

      // EL VEREDICTO SE CALCULA AQUÍ, CONTRA EL TEXTO DEL HORARIO.
      //
      // Antes se leía de `cierra_dias`, una lista guardada que en su día escribió
      // la IA o un lector que se equivocaba. En Polonia salió «el Museo de la
      // Segunda Guerra Mundial cierra los domingos» citando un horario que dice
      // «Mié-Dom: 10:00-18:00»: el aviso se contradecía a sí mismo en la misma
      // frase, y aun así los dos museos de Gdansk se fueron del plan.
      //
      // Ahora el único que dicta es el horario publicado, leído en código. Sin
      // caché que se quede vieja y sin nadie afirmando cierres de memoria.
      //
      // EL DÍA SALE DE LA FECHA, no de cómo lo llame nadie. En el registro de
      // Grecia se habló de un «mercadillo dominical» colocado el sábado 26:
      // `queDia` lo calcula `diaDeLaSemana(d.fecha)` y esa es la única fuente.
      // EL MES DEL DÍA PLANIFICADO, que es lo que decide si rige el horario de
      // verano o el de invierno. Sin él, «Verano: 08:00-20:00 | Invierno:
      // 08:30-15:30» se leía quedándose con el último, y Palamidio se fue del
      // plan «por cerrar a las 16:00» un 24 de septiembre.
      const mes = d.fecha ? Number(String(d.fecha).slice(5, 7)) : null;
      const abre = abreEl(info.horarios, queDia, mes);

      if (abre === true) {
        // ABRE ESE DÍA, ¿PERO A ESA HORA?
        //
        // El Museo Etnográfico de Cracovia acabó colocado de 19:00 a 20:30 con
        // un horario que cierra a las 18:00. El día era correcto; la hora, no.
        // Se comprobaba lo primero y se daba por bueno lo segundo.
        //
        // Se miran las DOS puntas: a la que empieza y a la que acaba. Una visita
        // que entra diez minutos antes de cerrar tampoco existe.
        const empieza = enMinutos(c.hora);
        const dura = Number(c.duracionMin) || 0;
        const dentro = empieza == null ? null : abiertoA(info.horarios, queDia, empieza, mes);
        const acabaDentro =
          empieza == null || !dura ? null : abiertoA(info.horarios, queDia, empieza + dura - 1, mes);

        if (dentro === false || acabaDentro === false) {
          avisos.push({
            dia: d.n,
            tipo: 'fuera-de-horario',
            idsAfectados: [c.id],
            libreDesde: null,
            texto:
              `${c.nombre} está puesto a las ${c.hora}` +
              (dura ? ` y dura ${dura} min` : '') +
              `, y a esa hora está cerrado. Su horario dice: «${info.horarios}»`,
          });
        }
        continue;                                // abierto ese día: lo demás, arriba
      }

      // TEMPORADA QUE NO SE PUEDE RESOLVER: se usa el horario más amplio —eso lo
      // hace el lector— y se avisa flojito, nunca se expulsa.
      if (abre === true && horarioPorDias(info.horarios, mes).temporadaDudosa) {
        avisos.push({
          dia: d.n,
          tipo: 'horario-sin-verificar',
          idsAfectados: [c.id],
          texto:
            `${c.nombre} tiene horarios distintos por temporada y no he sabido cuál toca en ` +
            `${d.fechaCorta}: he supuesto el más amplio. Compruébalo. Dice: «${info.horarios}»`,
        });
      }

      if (abre === null) {
        // NI ABIERTO NI CERRADO: EL HORARIO NO LO DICE.
        //
        // Y una duda no puede costar una expulsión, que era lo que pasaba. El
        // sitio se queda donde está y se avisa flojito para que alguien lo mire.
        avisos.push({
          dia: d.n,
          tipo: 'horario-sin-verificar',
          idsAfectados: [c.id],
          texto:
            `${c.nombre}: no he podido leer su horario con seguridad, así que lo dejo ` +
            `puesto en ${d.fechaCorta}. Compruébalo antes de ir. Dice: «${info.horarios}»`,
        });
        continue;
      }

      avisos.push({
        dia: d.n,
        tipo: 'sitio-cerrado',
        idsAfectados: [c.id],
        texto:
          `${c.nombre} cierra los ${enPlural(queDia)} y lo has puesto en ` +
          `${d.fechaCorta}. Su horario dice: «${info.horarios}»`,
      });
    }
  }

  return avisos;
}

/** Los minutos del día que ocupa una franja, para comparar con un traslado. */
function bordesDeFranja(clave) {
  const f = FRANJAS.find((x) => x.clave === clave);
  return f ? { desde: f.desde * 60, hasta: f.hasta * 60 } : null;
}

/**
 * LO QUE SE HA PUESTO MIENTRAS SE VA DENTRO DEL TRANSPORTE.
 *
 * El salto ya no es un punto en el día: ocupa de su hora de salida a su hora de
 * llegada. Todo lo que caiga dentro de esa ventana es un plan imposible, y hasta
 * ahora no lo veía nadie: en el viaje de Polonia el Castillo de Wawel y una
 * comida quedaron colocados mientras los viajeros iban en un tren que llegaba a
 * las 17:15.
 *
 * Se avisa de lo que cae dentro de la ventana: lo que tiene hora, por su hora;
 * lo que no la tiene, cuando su franja entera queda comida por el viaje.
 */
/**
 * CUANDO EL TRASLADO ELEGIDO NO SE CREE A SÍ MISMO.
 *
 * Un tramo tiene dos medidas del mismo camino: la ruta que mide Google entre las
 * dos ciudades y el trayecto del medio elegido. Difieren siempre un poco —un tren
 * no va por la carretera— y eso está bien. Lo que no puede ser es que la
 * referencia DOBLE al trayecto: entonces al trayecto le falta contar algo.
 *
 * SE COMPARA CONTRA EL TRAYECTO, NO CONTRA EL PUERTA A PUERTA, igual que hace su
 * hermano `avisarDeSaltosQueNoCuadran`. Los dos números tienen que medir lo mismo
 * para que su cociente signifique algo, y la referencia de Google es tiempo de
 * CONDUCCIÓN: el puerta a puerta lleva además el acceso, la antelación y la
 * salida, que no son camino.
 *
 * Aquí eso no producía avisos falsos —al sumar márgenes, el puerta a puerta solo
 * puede hacer el cociente más pequeño, y este aviso mira hacia el otro lado—,
 * pero sí podía CALLAR uno de verdad: un ferry sin contar con una antelación
 * grande se acercaba al umbral desde abajo y se escapaba.
 *
 * EL CASO QUE ORIGINA ESTO. Heraclión → Nafplio: Google dice 10h34 y el coche
 * elegido 3h45 puerta a puerta. La ficha del coche lo confiesa en su propia
 * nota: «Conducción desde El Pireo a Nafplio… Se puede embarcar coche en el
 * ferry desde Heraclión». Esa 1h45 de trayecto es solo el último tramo; las
 * nueve horas de barco entre Creta y el continente no las cuenta nadie. El
 * lienzo prometía llegar a Nafplio a las 11:45 cuando se llega pasadas las
 * ocho de la tarde.
 *
 * NO SE CORRIGE, SE DICE. No hay forma de saber desde aquí cuánto dura de verdad
 * —habría que preguntárselo a alguien, y un número inventado es justo lo que ha
 * causado esto—. Un hueco honesto en el día vale más que una hora de llegada que
 * miente.
 *
 * Solo se mira hacia un lado: que la referencia sea mucho mayor. Al revés —un
 * puerta a puerta más largo que la carretera— es lo normal y no dice nada: son
 * los accesos, la antelación y que el medio elegido no va en línea recta.
 */
function avisosDeTrasladoIncompleto(fijos) {
  // EL UMBRAL, PARA PODER MOVERLO. Con 2 se caza el ferry de Creta (2,8 veces) y
  // no salta ni el bus de Nafplio ni el tren de Cracovia, que se quedan muy por
  // debajo. Bajarlo de 1,6 empezaría a acusar a trenes rápidos, que legítimamente
  // tardan la mitad que la carretera.
  const factor = Math.max(1.6, parametro('factor_traslado_incompleto', 2));
  const avisos = [];

  for (const f of fijos) {
    if (f.donde !== 'salto' || !f.referenciaMin || !f.trayectoMin) continue;

    const veces = f.referenciaMin / f.trayectoMin;
    if (veces < factor) continue;

    avisos.push({
      dia: f.dia,
      tipo: 'traslado-incompleto',
      idsAfectados: [],
      texto:
        `${f.ciudades ?? 'Este traslado'}: el medio elegido dice ` +
        `${comoRatoCorto(f.trayectoMin)} de trayecto, pero la ruta real entre las dos ` +
        `ciudades son ${comoRatoCorto(f.referenciaMin)} (${veces.toFixed(1)} veces más). ` +
        'Al trayecto le falta contar algún tramo —un ferry, un enlace—, así que la hora ' +
        'de llegada de aquí arriba no es de fiar. Compruébalo antes de montar el día.',
    });
  }

  return avisos;
}

/**
 * EL TRASLADO DE SALIDA QUE NO LLEGA AL VUELO.
 *
 * EL CASO QUE ORIGINA ESTO. Polonia, día 7: el tren de Cracovia a Varsovia sale
 * a las 08:35 y llega a las 12:10, y el vuelo de vuelta despega a las 11:40. El
 * avión se va media hora antes de que el tren entre en la estación. El viaje no
 * se puede coger, y el lienzo lo entregaba con CERO avisos.
 *
 * Y NO ES QUE FALTARA EL DATO: los dos están en `fijos`, el mismo día, a tres
 * líneas uno de otro. El validador comprobaba que las VISITAS no se pasaran de
 * la hora de salir —de ahí el aviso que echó el Palacio de la Cultura— pero
 * trataba el salto como una ocupación más del día, no como algo que tiene que
 * LLEGAR a tiempo. Dos datos que existen y que nadie restaba.
 *
 * SE MIDE CONTRA LA HORA DE ESTAR EN EL AEROPUERTO, no contra la del despegue:
 * llegar cuando el avión ya está embarcando no es llegar. Esa hora es la que el
 * propio bloque de la vuelta ya trae calculada con su antelación.
 *
 * NO SE ARREGLA, SE DICE. Arreglarlo de verdad es que la conexión de salida sea
 * condición para que un reparto de noches sea legal, y eso vive tres fases más
 * arriba. Aquí lo que se puede hacer —y hasta hoy no se hacía— es no entregar un
 * viaje imposible en silencio.
 */
function avisosDeLaSalidaQueNoLlega(fijos) {
  const avisos = [];

  const vueltas = fijos.filter((f) => f.donde === 'vuelta');
  for (const vuelta of vueltas) {
    // El salto del MISMO día: es el único que puede chocar con este vuelo.
    const salto = fijos.find((f) => f.donde === 'salto' && f.dia === vuelta.dia);
    if (!salto) continue;

    const llega = enMinutos(salto.horaFin);
    // `vuelta.hora` es la hora de salir hacia el aeropuerto; la de estar allí la
    // trae el bloque. Se compara contra ésa, que es el límite de verdad.
    const enElAeropuerto = enMinutos(vuelta.horaEnPuerta ?? null) ?? enMinutos(vuelta.hora);
    if (llega == null || enElAeropuerto == null) continue;
    if (llega <= enElAeropuerto) continue;

    const tarde = llega - enElAeropuerto;
    avisos.push({
      dia: vuelta.dia,
      tipo: 'salida-que-no-llega',
      idsAfectados: [],
      texto:
        `${salto.ciudades ?? 'El traslado de salida'} llega a las ${salto.horaFin} y para ` +
        `este vuelo hay que estar en ` +
        `${vuelta.aeropuerto ? `${vuelta.aeropuerto}` : 'el aeropuerto'} a las ` +
        `${comoHoraDelDiaLocal(enElAeropuerto)}: llegas ${comoRatoCorto(tarde)} tarde. ` +
        'Tal y como está, el vuelo no se coge. O sales antes, o la última noche tiene ' +
        'que dormirse en la ciudad del aeropuerto.',
    });
  }

  return avisos;
}

/** Minutos del día a «08:25». Local, para no arrastrar el de traslados. */
function comoHoraDelDiaLocal(min) {
  const m = Math.max(0, Math.round(min));
  return `${String(Math.floor(m / 60)).padStart(2, '0')}:${String(m % 60).padStart(2, '0')}`;
}

function avisosDeTraslado(dias, colocados, fijos) {
  const avisos = [];

  for (const d of dias) {
    const salto = fijos.find((f) => f.dia === d.n && f.donde === 'salto' && f.hora && f.horaFin);
    if (!salto) continue;

    const desde = enMinutos(salto.hora);
    const hasta = enMinutos(salto.horaFin);
    if (desde == null || hasta == null || hasta <= desde) continue;

    const dentro = colocados.filter((c) => {
      if (c.dia !== d.n) return false;
      const suya = enMinutos(c.hora);
      if (suya != null) {
        // Empieza dentro del viaje, o acaba después de que el viaje arranque:
        // las dos cosas son estar en dos sitios a la vez.
        const acaba = suya + (Number(c.duracionMin) || 0);
        return (suya >= desde && suya < hasta) || (suya < desde && acaba > desde);
      }
      const borde = bordesDeFranja(c.franja);
      return borde ? borde.desde >= desde && borde.hasta <= hasta : false;
    });

    if (!dentro.length) continue;

    avisos.push({
      dia: d.n,
      tipo: 'durante-el-traslado',
      idsAfectados: dentro.map((c) => c.id),
      libreDesde: salto.horaFin,
      texto:
        `El viaje ocupa de ${salto.hora} a ${salto.horaFin} — ` +
        `tienes ${dentro.length} ${dentro.length === 1 ? 'cosa puesta' : 'cosas puestas'} ` +
        'mientras vas de camino',
    });
  }

  return avisos;
}

/**
 * LO QUE PISA UN BLOQUE FIJO, MEDIDO EN HORAS.
 *
 * Los avisos de «antes de llegar» y «después de irte» comparaban FRANJAS, y una
 * franja es de cuatro horas: el museo de 9:00 a 11:00 y el vuelo de las 9:40
 * están los dos en «mañana», así que no había nada que avisar. En Polonia eso
 * dejó a alguien en un museo mientras su avión despegaba.
 *
 * Aquí se compara con la hora en la mano, que es como se viaja:
 *
 *   · Nada puede empezar después de que arranque el bloque de salida del día,
 *     ni acabar más tarde de esa hora.
 *   · Nada puede empezar antes de que termine el bloque de llegada.
 *
 * Solo mira lo que tiene hora: sin hora no hay nada que comparar, y de eso ya
 * avisan las comprobaciones por franja de más arriba.
 */
function avisosContraFijos(dias, colocados, fijos) {
  const avisos = [];

  for (const d of dias) {
    const delDia = colocados.filter((c) => c.dia === d.n && enMinutos(c.hora) != null);
    if (!delDia.length) continue;

    const salida = fijos.find((f) => f.dia === d.n && f.donde === 'vuelta' && f.hora);

    // LLEGAR ES LLEGAR, VENGA DE UN AVIÓN O DE UN TREN.
    //
    // Esto solo miraba la `ida` —el vuelo del primer día— y dejaba fuera el
    // SALTO a la parada siguiente, que es exactamente la misma situación: hasta
    // que no termina, no se está en esa ciudad. En el viaje 108 el Mercado
    // Central de Atenas quedó puesto a las 09:00 del día 3 con el tren desde
    // Tesalónica saliendo a las 12:50, y no saltó ningún aviso.
    //
    // La hora de llegada no es la misma en los dos: la `ida` la marca con `hora`
    // —aterrizar— y el salto con `horaFin`, porque su `hora` es cuando SALE.
    const llegada = fijos.find(
      (f) => f.dia === d.n && (f.donde === 'ida' || f.donde === 'salto') && f.hora
    );
    const horaDeLlegar =
      llegada && llegada.donde === 'salto' ? (llegada.horaFin ?? llegada.hora) : llegada?.hora;

    if (salida) {
      const arranca = enMinutos(salida.hora);
      const pisan = delDia.filter((c) => {
        const empieza = enMinutos(c.hora);
        const acaba = empieza + (Number(c.duracionMin) || 0);
        return empieza >= arranca || acaba > arranca;
      });

      if (pisan.length) {
        avisos.push({
          dia: d.n,
          tipo: 'pisa-la-salida',
          idsAfectados: pisan.map((c) => c.id),
          libreHasta: salida.hora,
          texto:
            `El viaje de vuelta sale a las ${salida.salidaReal ?? salida.hora}` +
            (salida.salidaReal && salida.salidaReal !== salida.hora
              ? ` y hay que salir a las ${salida.hora}`
              : '') +
            `: ${pisan.length === 1 ? 'hay algo que sigue' : `hay ${pisan.length} cosas que siguen`} ` +
            'a esa hora',
        });
      }
    }

    if (llegada && horaDeLlegar) {
      const termina = enMinutos(horaDeLlegar);
      const antes = delDia.filter((c) => enMinutos(c.hora) < termina);
      if (antes.length) {
        avisos.push({
          dia: d.n,
          tipo: 'pisa-la-llegada',
          idsAfectados: antes.map((c) => c.id),
          libreDesde: horaDeLlegar,
          texto:
            (llegada.donde === 'salto'
              ? `Se llega de la parada anterior a las ${horaDeLlegar} y `
              : `Se llega a las ${horaDeLlegar} y `) +
            `${antes.length === 1 ? 'hay algo puesto' : `hay ${antes.length} cosas puestas`} ` +
            'antes de esa hora',
        });
      }
    }
  }

  return avisos;
}

/**
 * EL DÍA QUE SE QUEDA SIN COMER.
 *
 * Comer es diario. Un día con plan y sin bloque de comida es un descuido, no una
 * decisión: en Polonia el día 3 se quedó sin comida y nadie dijo nada.
 *
 * NO se avisa cuando el día no da para comer allí: se llega a las 20:00, se vuela
 * a las 12:00 o el viaje ocupa toda la franja del mediodía. En esos días la
 * comida cae en un aeropuerto o en un tren, y pedirla en el lienzo sería pedir
 * algo que no existe.
 */
function avisosDeComida(dias, colocados, fijos) {
  const avisos = [];
  const MEDIODIA = { desde: 13 * 60, hasta: 15 * 60 };

  for (const d of dias) {
    const delDia = colocados.filter((c) => c.dia === d.n);
    if (!delDia.length) continue;                       // día vacío: nada que decir

    const hayComida = delDia.some(
      (c) => /^comer\b/i.test(String(c.nombre ?? '')) || c.tipo === 'comer'
    );
    if (hayComida) continue;

    // ¿Cabe comer ese día en la ciudad? Se mira la ventana libre.
    const llegada = fijos.find((f) => f.dia === d.n && f.donde === 'ida');
    const salida = fijos.find((f) => f.dia === d.n && f.donde === 'vuelta');
    const salto = fijos.find((f) => f.dia === d.n && f.donde === 'salto');

    const empieza = Math.max(
      enMinutos(llegada?.hora) ?? 0,
      (salto?.horaFin ? enMinutos(salto.horaFin) : null) ?? 0
    );
    // El salto se pinta en el día en que se LLEGA, así que acota por dónde
    // empieza el día, no por dónde acaba: la tarde de ese día sí es de esta
    // ciudad. Contarlo como final dejaba el día 3 de Polonia sin comida y sin
    // aviso, que es justo el caso que esto viene a cazar.
    const acaba = enMinutos(salida?.hora) ?? 24 * 60;

    // Si la ventana libre no toca la hora de comer, no se pide comida.
    if (empieza >= MEDIODIA.hasta || acaba <= MEDIODIA.desde) continue;

    avisos.push({
      dia: d.n,
      tipo: 'sin-comida',
      idsAfectados: [],
      texto: 'Este día tiene plan pero no tiene dónde comer',
    });
  }

  return avisos;
}

// =============================================================================
// ¿DA TIEMPO A LLEGAR?
// -----------------------------------------------------------------------------
// La regla es de perogrullo y por eso duele tanto cuando falla: si sales de un
// sitio a las 15:00 y el trayecto son dos horas, a las 15:30 no estás en el
// siguiente. Sobre el papel del lienzo eso no se ve —dos tarjetas seguidas
// parecen igual de seguidas midan lo que midan— y solo se descubre andando.
//
// SE USA LO YA CALCULADO, no se pide nada. Los tiempos salen de los traslados
// que se consultaron desde "Moverse" o desde las fichas, que ahora vienen de
// Google Routes. Si entre dos cosas no hay traslado calculado, no hay aviso:
// inventarse un tiempo para poder avisar sería peor que callarse.
//
// Y AVISA, NO PROHÍBE. Igual que el resto de la capa: no recoloca nada, no
// impide guardar y no cambia ninguna hora. Solo lo dice.
// =============================================================================

/** "15:30" -> 930 minutos desde medianoche. Null si no hay hora. */
export function enMinutos(hora) {
  const m = /^(\d{1,2}):(\d{2})$/.exec(String(hora ?? '').trim());
  if (!m) return null;
  return Number(m[1]) * 60 + Number(m[2]);
}

/** 930 -> "15:30". */
export function comoHora(minutos) {
  const h = Math.floor(minutos / 60) % 24;
  const m = minutos % 60;
  return `${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}`;
}

/** 150 -> "2 h 30". Para el texto del aviso. */
function comoRato(minutos) {
  const h = Math.floor(minutos / 60);
  const m = minutos % 60;
  if (!h) return `${m} min`;
  return m ? `${h} h ${m}` : `${h} h`;
}

/**
 * La identidad de catálogo de una tarjeta, que es como se guardan los extremos
 * de un traslado.
 *
 * Un traslado apunta a la fila del CATÁLOGO (el restaurante, el monumento), no
 * al candidato: el candidato es "esto lo quiero en este viaje" y el catálogo es
 * "esto es". Sin esta traducción no cuadraría ningún extremo.
 */
function claveDeTarjeta(c) {
  if (!c.candidatoId) return null;
  const cand = una('SELECT * FROM candidatos WHERE id = ?', c.candidatoId);
  return cand ? claveDeCandidato(cand) : null;
}

/**
 * Minutos de trayecto entre dos tarjetas, de lo que ya esté calculado.
 *
 * Se prefiere andando y luego público: en una ciudad son los medios con los que
 * se encadena un día. Si solo hay coche, vale el coche.
 */
const MEDIOS_PARA_ENCADENAR = ['andando', 'publico', 'coche', 'taxi'];

function trayectoEntre(a, b) {
  const ca = claveDeTarjeta(a);
  const cb = claveDeTarjeta(b);
  if (!ca || !cb) return null;

  const t = una(
    `SELECT * FROM traslados
      WHERE estado = 'ok'
        AND ((origen_tipo = ? AND origen_id = ? AND destino_tipo = ? AND destino_id = ?)
          OR (origen_tipo = ? AND origen_id = ? AND destino_tipo = ? AND destino_id = ?))
      ORDER BY id DESC
      LIMIT 1`,
    ca.tipo, ca.id, cb.tipo, cb.id,
    cb.tipo, cb.id, ca.tipo, ca.id
  );
  if (!t) return null;

  let resultados = [];
  try {
    resultados = t.resultados ? (JSON.parse(t.resultados) ?? []) : [];
  } catch { return null; }

  const mejor =
    MEDIOS_PARA_ENCADENAR.map((m) => resultados.find((r) => r.modo === m)).find(Boolean) ??
    resultados[0];

  return mejor?.minutos != null
    ? { minutos: mejor.minutos, modo: mejor.modo }
    : null;
}

/**
 * DÓNDE ESTÁ UNA TARJETA DEL LIENZO.
 *
 * Un sitio de Google trae lat/lon de serie; una excursión las tiene en
 * `direcciones` desde que el mapa la sitúa. Una comida que solo es una zona, un
 * traslado o algo sin situar devuelven null, y entonces no se mide.
 */
export function puntoDeTarjeta(c) {
  const clave = claveDeTarjeta(c);
  if (!clave?.id) return null;

  if (clave.tipo === 'sitio' || clave.tipo === 'punto') {
    const tabla = clave.tipo === 'punto' ? 'puntos_interes' : 'sitios_lugar';
    const f = una(`SELECT lat, lon FROM ${tabla} WHERE id = ?`, clave.id);
    if (Number.isFinite(Number(f?.lat))) return { lat: Number(f.lat), lon: Number(f.lon) };
  }

  const d = direccionDe(clave.tipo, clave.id);
  return d?.situada ? { lat: Number(d.punto.lat), lon: Number(d.punto.lng) } : null;
}

/**
 * EL TRAYECTO, Y SI NO LO HAY, EL SUELO EN LÍNEA RECTA.
 *
 * LA OTRA MITAD DEL AVISO MUERTO. Aunque la rama de «no llegas» se ejecutara,
 * `trayectoEntre` solo sabe leer la tabla `traslados`, que guarda lo que alguien
 * calculó a propósito entre dos tarjetas concretas. Entre dos visitas
 * cualesquiera de un día no hay nada ahí, así que devolvía null y el aviso se
 * callaba igual. Dos motivos para no salir nunca, y por eso ninguno se notaba.
 *
 * Cuando no hay trayecto calculado pero sí hay coordenadas, se usa el mínimo en
 * línea recta —`minutosMinimosEnLlegar`, la misma cuenta que usa la guarda del
 * reparto— y se dice de dónde sale: `modo: 'recta'`, para que el texto del aviso
 * no invente un medio de transporte que nadie ha mirado. Sin coordenadas sigue
 * devolviendo null y sigue sin decirse nada, que es lo correcto: mejor un aviso
 * de menos que uno inventado.
 */
function trayectoOSuelo(a, b) {
  const calculado = trayectoEntre(a, b);
  if (calculado) return calculado;

  const pa = puntoDeTarjeta(a);
  const pb = puntoDeTarjeta(b);
  if (!pa || !pb) return null;

  const km = distanciaKm(pa, pb);
  const minutos = minutosMinimosEnLlegar(km);
  return minutos > 0 ? { minutos, modo: 'recta', km: Math.round(km) } : null;
}

/**
 * ¿SE LLEGA A ESE HUECO, Y SE SALE DE ÉL?
 *
 * EL FALLO QUE ORIGINA ESTO, y es el día 6 del viaje a Túnez:
 *
 *     08:00  Excursión a Dougga y Bulla Regia   480 min   (110 km al oeste)
 *     16:00  Free tour por Cartago              120 min   (20 km al noreste)
 *
 * Lo montó la propia revisión. El reloj cuadra al minuto —no hay solape— y por
 * eso no saltó nada: `horaLibreEn` contesta a «¿está libre esa hora?», que es la
 * pregunta de una AGENDA. La de un VIAJE es otra: «¿se llega?».
 *
 * VIVE AQUÍ, y no en el orquestador donde nació, porque la usan DOS módulos que
 * no se pueden importar entre sí: `orquestador-lienzo` ya importa de
 * `orquestador-paradas-cortas`, así que al revés sería un círculo. `lienzo.js`
 * es de quien los dos tiran.
 *
 * Y LA USAN PARA DOS PREGUNTAS DISTINTAS, de ahí que acepte las dos formas:
 *
 *   colocado · una tarjeta que ya está en el lienzo. Su punto se saca de ella y
 *              se excluye a sí misma del día al mirar los vecinos.
 *   punto    · unas coordenadas sueltas, para preguntar por algo que TODAVÍA no
 *              está puesto. Es lo que necesita la revisión del reparto para no
 *              decir «tenía hueco libre y aun así no se colocó» de un sitio al
 *              que a esa hora no se llega — una frase que era verdad sobre el
 *              reloj y mentira sobre el mapa.
 *
 * SIN COORDENADAS NO SE DICE NADA. Una comida que solo es una zona, un traslado
 * o un sitio sin situar devuelven null en `puntoDeTarjeta`, y entonces esto se
 * calla: inventarse dónde cae algo para prohibir un hueco sería peor que el
 * hueco.
 *
 * Devuelve null si el hueco vale, o el motivo si no. Cuando el problema es lo de
 * ANTES viene además `desdeMinuto`: la primera hora a la que sí se llegaría, que
 * es lo que deja a quien llama volver a probar más tarde en vez de rendirse.
 */
export function seLlegaAlHueco(tablero, { dia, hora, duracion, colocado = null, punto = null }) {
  const miPunto = punto ?? (colocado ? puntoDeTarjeta(colocado) : null);
  const empieza = enMinutos(hora);
  if (!miPunto || empieza == null) return null;
  const acaba = empieza + (Number(duracion) || 0);
  const yoMismo = colocado?.id ?? null;

  const delDia = (tablero.colocados ?? [])
    .filter((c) => c.dia === dia && c.id !== yoMismo && enMinutos(c.hora) != null)
    .sort((a, b) => enMinutos(a.hora) - enMinutos(b.hora));

  // LO QUE ACABA MÁS TARDE SIN PASARSE **Y SE SABE DÓNDE ESTÁ**.
  //
  // EL PUNTO CIEGO QUE ESTO TAPA, y lo enseñó el día 4 del viaje 105:
  //
  //     09:00  Yacimiento de Micenas        180 min
  //     13:30  Comer · Nafplio, zona centro  90 min
  //     15:30  Fortaleza de Palamidi        120 min   ← a 19,3 km de Micenas
  //
  // De Micenas a Palamidi hay 19 km y entre los dos quedan 30 minutos, que no
  // dan. Y la guarda se callaba: buscaba «lo que acaba justo antes», encontraba
  // la COMIDA —que es una zona y no tiene coordenada—, y al no poder medir se
  // callaba. Un bloque sin punto no es que no estorbe: es que no se sabe, y
  // dejaba ciega la comprobación de todo lo que hubiera detrás.
  //
  // Ahora se salta lo que no se puede medir y se sigue hacia atrás hasta
  // encontrar algo situado. Es más prudente y no menos: la comida se hace EN uno
  // de los dos sitios, así que el trayecto sigue siendo el mismo con comida en
  // medio o sin ella. Lo que no se puede es no mirarlo.
  let antes = null;
  for (const c of delDia) {
    const fin = enMinutos(c.hora) + (Number(c.duracionMin) || 0);
    if (fin > empieza) continue;
    if (!puntoDeTarjeta(c)) continue;
    if (antes == null || fin > antes.fin) antes = { c, fin };
  }

  if (antes) {
    const suyo = puntoDeTarjeta(antes.c);
    if (suyo) {
      const km = distanciaKm(suyo, miPunto);
      const falta = minutosMinimosEnLlegar(km);
      if (antes.fin + falta > empieza + minutosQueSePerdonan()) {
        return {
          motivo:
            `de «${antes.c.nombre}» a aquí hay ${Math.round(km)} km ` +
            `y solo quedan ${empieza - antes.fin} min`,
          desdeMinuto: antes.fin + falta,
        };
      }
    }
  }

  // Y LO DE DESPUÉS, por el mismo motivo y en el otro sentido. Meter algo en un
  // hueco de dos horas a cien kilómetros deja tirado a lo que venía detrás, y
  // ese no es problema de lo que venía detrás.
  // Y por el mismo motivo, el primero de después QUE SE PUEDA MEDIR.
  const despues = delDia.find((c) => enMinutos(c.hora) >= acaba && puntoDeTarjeta(c));
  if (despues) {
    const suyo = puntoDeTarjeta(despues);
    if (suyo) {
      const km = distanciaKm(miPunto, suyo);
      const falta = minutosMinimosEnLlegar(km);
      const hueco = enMinutos(despues.hora) - acaba;
      if (falta > hueco + minutosQueSePerdonan()) {
        // Retrasar no arregla esto: cuanto más tarde empiece, menos hueco queda.
        return {
          motivo: `de aquí a «${despues.nombre}» hay ${Math.round(km)} km y solo quedan ${hueco} min`,
          desdeMinuto: null,
        };
      }
    }
  }

  return null;
}

const COMO_SE_VA = {
  andando: 'andando',
  coche: 'en coche',
  publico: 'en transporte público',
  taxi: 'en taxi',
};

/**
 * Los avisos de "no llegas", uno por pareja que no cuadre.
 *
 * Solo entre tarjetas CONSECUTIVAS del mismo día y con hora las dos: sin hora
 * no hay nada que comparar, y comparar la primera con la tercera sería avisar
 * de un salto que nadie va a dar.
 */
/**
 * ¿Esto es una comida?
 *
 * Las colocadas por el orquestador son texto manual («Comer · Lublin»); las
 * apuntadas desde la pestaña son candidatos de tipo `comer`. Las dos cuentan.
 */
function esComer(c) {
  return c?.tipo === 'comer' || /^comer\b/i.test(String(c?.nombre ?? ''));
}

function avisosDeTiempo(dias, colocados) {
  const avisos = [];
  const orden = (clave) => CLAVES_FRANJA.indexOf(clave);

  for (const d of dias) {
    // El mismo orden en el que se ven: por franja, y dentro de la franja por
    // hora y por el orden manual.
    // POR HORA, Y SOLO POR HORA.
    //
    // Antes se ordenaba por franja y DESPUÉS por hora, que no es el orden en que
    // ocurren las cosas: un bloque de las 13:00 metido en la franja «mañana» se
    // colocaba antes que uno de las 12:00 en «mediodía». Para comparar si dos
    // cosas se pisan, lo único que manda es el reloj.
    const delDia = colocados
      .filter((c) => c.dia === d.n)
      .sort(
        (x, y) =>
          (enMinutos(x.hora) ?? 9999) - (enMinutos(y.hora) ?? 9999) ||
          orden(x.franja) - orden(y.franja) ||
          (x.orden ?? 0) - (y.orden ?? 0)
      );

    // TODOS LOS PARES QUE SE PISAN, NO SOLO LOS VECINOS.
    //
    // Aquí estaba el solape que «ni se señaló». Se comparaba `delDia[i]` con
    // `delDia[i+1]` y nada más, así que en el día 6 de Gdansk —Casco Viejo
    // 11:30-13:30, Grúa 11:45, Comer 13:00— se miraba Casco↔Grúa y Grúa↔Comer,
    // pero NUNCA Casco↔Comer, que también se pisaban.
    //
    // Y el efecto era peor que un aviso de menos: ese solape solo aparecía
    // cuando la revisión movía la Grúa y los dos quedaban contiguos, o sea en la
    // pasada siguiente — y las pasadas se acaban. De ahí venían los «se solapan»
    // que quedaban sin resolver siendo perfectamente resolubles: no fallaba la
    // cadena, es que se enteraba tarde.
    //
    // Se compara cada bloque con todos los que empiezan antes de que él termine.
    // Son unas pocas tarjetas por día: el coste es irrelevante y la ceguera no.
    for (let i = 0; i < delDia.length - 1; i++) {
      const a = delDia[i];
      const finDeA = (enMinutos(a.hora) ?? 0) + (Number(a.duracionMin) || 0);

      for (let k = i + 1; k < delDia.length; k++) {
        const b = delDia[k];
        // En cuanto uno empieza después de que A acabe, los siguientes también.
        if ((enMinutos(b.hora) ?? 9999) >= finDeA) break;

      const empiezaA = enMinutos(a.hora);
      const empiezaB = enMinutos(b.hora);
      if (empiezaA == null || empiezaB == null) continue;

      // Un traslado ya ES el trayecto: avisar de que no da tiempo a hacer el
      // trayecto para llegar al trayecto no tiene sentido.
      if (a.tipo === 'traslado' || b.tipo === 'traslado') continue;

      // Fin de lo primero: su hora más lo que dure. Sin duración tecleada se
      // toma la hora de inicio, que es lo más prudente.
      const acabaA = empiezaA + (Number(a.duracionMin) || 0);

      // COMER DURANTE UNA EXCURSIÓN DE JORNADA NO ES UN SOLAPE… SI SE COME
      // DENTRO.
      //
      // En una excursión de nueve horas se come: la propia IA la coloca y
      // escribe «Comer · Lublin (incluida en excursión)». Con las excursiones
      // ocupando ya su bloque de verdad, eso empezó a salir como conflicto, y
      // no lo es: es lo que pasa en una excursión larga.
      //
      // PERO LA EXENCIÓN SE APLICABA SIN MIRAR LA HORA, y ahí estaba el fallo.
      // Peor: se decidía ANTES de calcular `acabaA`, así que ni siquiera existía
      // el dato de cuándo termina la excursión. Con Auschwitz —7h30, de 08:00 a
      // 15:30— y la comida a las 15:00, la comida se sale por una hora entera
      // del final de la jornada y no salía ni un aviso.
      //
      // Ahora se perdona solo lo que de verdad cae DENTRO:
      //
      //     08:00 ─────── excursión ─────── 16:00
      //                13:30 comida 15:00              dentro  → se calla
      //     08:00 ─── excursión ─── 15:30
      //                       15:00 comida 16:30       se sale → avisa
      //
      // NO SE MIRA EL NOMBRE, y es a propósito. Un «incluida en la excursión»
      // es una declaración, y cuando una declaración contradice al reloj manda
      // el reloj: si el bloque dice que va dentro y sobresale una hora, el plan
      // se contradice a sí mismo y eso merece el aviso, no el perdón. Fiarse de
      // la etiqueta seria reabrir este mismo agujero con una palabra que el
      // modelo escribe libremente.
      //
      // Y no puede generar avisos falsos por falta de datos: una excursión sin
      // duración da `acabaA = empiezaA`, y como el día va ordenado por hora eso
      // nunca llega a `acabaA > empiezaB`. Sin solape no hay nada que perdonar.
      //
      // La excepción sigue siendo SOLO en ese sentido. Un museo dentro del
      // bloque del crucero sigue siendo imposible, y una comida sigue ocupando
      // frente a cualquier visita.
      if (esComer(a) !== esComer(b) && (a.tipo === 'actividad' || b.tipo === 'actividad')) {
        const comida = esComer(a) ? a : b;
        const excursion = esComer(a) ? b : a;

        const empiezaExc = enMinutos(excursion.hora);
        const acabaExc = (empiezaExc ?? 0) + (Number(excursion.duracionMin) || 0);
        const empiezaCom = enMinutos(comida.hora);
        const acabaCom = (empiezaCom ?? 0) + (Number(comida.duracionMin) || 0);

        const seComeDentro =
          empiezaExc != null &&
          empiezaCom != null &&
          empiezaCom >= empiezaExc &&
          acabaCom <= acabaExc;

        if (seComeDentro) continue;
      }

      // EL SOLAPE, ANTES QUE EL TRAYECTO.
      //
      // Lo de «no llegas» necesita saber cuánto se tarda de una cosa a otra, y
      // sin direcciones no lo sabe: se rendía ahí. Pero dos visitas que se pisan
      // se pisan aunque estén en el mismo edificio —el Castillo de Wawel de
      // 09:00 a 12:00 y la catedral a las 11:15, que están dentro del mismo
      // recinto—, y eso no hace falta medirlo para verlo.
      if (acabaA > empiezaB) {
        avisos.push({
          dia: d.n,
          tipo: 'solape',
          idsAfectados: [b.id],
          // LOS DOS DE LA PAREJA, EN ORDEN.
          //
          // `idsAfectados` nombra al segundo porque es el que llega tarde, y
          // durante mucho tiempo fue el único que la revisión veía: por eso
          // expulsaba siempre al segundo, aunque fuese la Plaza del Mercado y
          // el primero una comida. Para poder decidir cuál se queda hay que
          // tener delante a los dos.
          idsEnConflicto: [a.id, b.id],
          // A qué hora queda libre lo anterior. Va en el aviso para que quien lo
          // corrija no tenga que sacarlo del texto: el texto es para leerlo.
          libreDesde: comoHora(acabaA),
          texto:
            `${a.nombre} acaba a las ${comoHora(acabaA)} y ${b.nombre} empieza a las ` +
            `${comoHora(empiezaB)}: se solapan`,
        });
        continue;
      }
      }
    }

    // =========================================================================
    // Y AHORA «NO LLEGAS», QUE ES LA PAREJA QUE **NO** SE PISA.
    //
    // AQUÍ ESTABA EL AVISO MUERTO. El bucle de arriba se cambió para cazar todos
    // los solapes y no solo los vecinos, y para eso corta en cuanto encuentra
    // uno que empieza después de que A termine:
    //
    //     if (enMinutos(b.hora) >= finDeA) break;
    //
    // Con ese corte, TODA pareja que llegaba al «no llegas» cumplía
    // `empiezaB < acabaA`… que es exactamente la condición del solape de arriba,
    // que hace `continue`. O sea: la rama de «no llegas» no se ejecutó nunca
    // desde ese cambio. Se vio en el viaje 101, con dos parejas que ningún aviso
    // señaló:
    //
    //     día 3  Medina de Kairouan 14:30-17:30  →  Café Halfaouine 18:00   93 km
    //     día 4  Gran Mezquita 09:00-11:00       →  Museo de Kairouan 11:00  11 km
    //
    // Son las dos cosas contrarias y por eso van en bucles distintos: el solape
    // es que B empieza ANTES de que A acabe; no llegar es que empieza DESPUÉS,
    // pero no lo bastante después. Una pareja no puede ser las dos.
    // =========================================================================
    for (let i = 0; i < delDia.length - 1; i++) {
      const a = delDia[i];
      const empiezaA = enMinutos(a.hora);
      if (empiezaA == null) continue;
      const acabaA = empiezaA + (Number(a.duracionMin) || 0);

      // EL SIGUIENTE DE VERDAD: el primero que empieza cuando A ya ha acabado.
      // Los que se pisan con A ya los ha contado el bucle de arriba.
      const b = delDia.slice(i + 1).find((x) => (enMinutos(x.hora) ?? -1) >= acabaA);
      if (!b) continue;
      const empiezaB = enMinutos(b.hora);

      // Un traslado ya ES el trayecto. Misma exención que arriba.
      if (a.tipo === 'traslado' || b.tipo === 'traslado') continue;

      const trayecto = trayectoOSuelo(a, b);
      if (!trayecto) continue;

      const llegaria = acabaA + trayecto.minutos;
      // EL MISMO MARGEN QUE USA LA GUARDA DEL REPARTO, y no por comodidad: si el
      // aviso señalara lo que la guarda deja pasar, la revisión se pasaría las
      // pasadas persiguiendo un aviso que ella misma no sabe quitar.
      if (llegaria <= empiezaB + minutosQueSePerdonan()) continue;

      avisos.push({
        dia: d.n,
        tipo: 'no-llegas',
        idsAfectados: [b.id],
        idsEnConflicto: [a.id, b.id],
        libreDesde: comoHora(llegaria),
        texto:
          trayecto.modo === 'recta'
            ? `Sales de ${a.nombre} a las ${comoHora(acabaA)} y hay ${trayecto.km} km hasta ` +
              `${b.nombre}: no se hacen en menos de ${comoRato(trayecto.minutos)}, ` +
              `y lo tienes puesto a las ${comoHora(empiezaB)}`
            : `Sales de ${a.nombre} a las ${comoHora(acabaA)} y el trayecto son ` +
              `${comoRato(trayecto.minutos)} ${COMO_SE_VA[trayecto.modo] ?? ''}`.trimEnd() +
              `: no llegas a ${b.nombre} a las ${comoHora(empiezaB)}` +
              ` (llegarías a las ${comoHora(llegaria)})`,
      });
    }
  }

  return avisos;
}

// =============================================================================
// COLOCAR, MOVER Y QUITAR
// =============================================================================
/** La etapa a la que pertenece un día del viaje. */
function etapaDelDia(viajeId, dia) {
  const viaje = una('SELECT fecha_inicio FROM viajes WHERE id = ?', viajeId);
  if (!viaje?.fecha_inicio) return null;

  const fecha = sumarDias(viaje.fecha_inicio, dia - 1);
  return una(
    `SELECT * FROM etapas
      WHERE viaje_id = ? AND estado = 'confirmada'
        AND fecha_inicio <= ? AND fecha_fin > ?
      ORDER BY orden LIMIT 1`,
    viajeId,
    fecha,
    fecha
  );
}

/** Pone algo en un día y una franja. Devuelve la fila creada, o null. */
export function colocar(
  viajeId,
  {
    candidatoId = null,
    textoManual = null,
    dia,
    franja,
    hora = null,
    movilidadId = null,
    trasladoId = null,
    medio = null,
    duracionMin = null,
    orden = null,
  }
) {
  if (!CLAVES_FRANJA.includes(franja)) return null;
  const n = Number(dia);
  if (!Number.isInteger(n) || n < 1) return null;

  // Una cosa o la otra, nunca las dos: lo mismo que exige el CHECK de la tabla.
  const texto = String(textoManual ?? '').trim();
  if ((candidatoId && texto) || (!candidatoId && !texto)) return null;

  const etapa = etapaDelDia(viajeId, n);

  if (candidatoId) {
    const candidato = una(
      'SELECT * FROM candidatos WHERE id = ? AND viaje_id = ?',
      candidatoId,
      viajeId
    );
    if (!candidato) return null;

    // Ya colocado: esto es un movimiento, no un duplicado.
    const yaEsta = una('SELECT * FROM itinerario WHERE candidato_id = ?', candidatoId);
    if (yaEsta) return mover(yaEsta.id, { dia: n, franja });
  }

  // Con `orden` se mete EN MEDIO, no al final: un traslado entre dos tarjetas
  // solo significa algo si queda entre esas dos. Se hace sitio empujando lo que
  // hay de ahí en adelante.
  const posicion = Number.isFinite(Number(orden))
    ? hacerSitio(viajeId, n, franja, Number(orden))
    : siguienteOrden(viajeId, n, franja);

  // LA DURACIÓN SE PONE SOLA SI NADIE LA DA.
  //
  // Vale para los dos caminos —el orquestador y el botón de la pantalla—, porque
  // los dos pasan por aquí. Lo que se coloca sin duración es invisible para el
  // validador de solapes, y un día con cuatro visitas de duración nula parece
  // perfectamente vacío.
  const duracionFinal =
    Number(duracionMin) || (candidatoId ? duracionDeLoColocado(candidatoId).minutos : null);

  const r = ejecutar(
    `INSERT INTO itinerario
       (viaje_id, etapa_id, dia, franja, candidato_id, texto_manual, hora, orden,
        movilidad_id, duracion_min, traslado_id, medio)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    viajeId,
    etapa?.id ?? null,
    n,
    franja,
    candidatoId || null,
    candidatoId ? null : texto.slice(0, 300),
    normalizarHora(hora),
    posicion,
    Number(movilidadId) || null,
    Number(duracionFinal) || null,
    Number(trasladoId) || null,
    medio || null
  );
  return una('SELECT * FROM itinerario WHERE id = ?', Number(r.lastInsertRowid));
}

/**
 * "2-3 horas" -> 180. "45 min" -> 45. "1h 30min" -> 90.
 *
 * SE COGE EL TECHO DEL RANGO, siempre. Es el mismo principio que los márgenes de
 * los traslados: si la ficha dice que se tardan de dos a tres horas y se reserva
 * hora y media, el día cuadra en el papel y no en la calle. Mejor que sobre.
 *
 * Devuelve null si no hay nada que entender, que es distinto de cero: cero
 * significaría que la visita no ocupa, y entonces todo cabe en todas partes.
 */
/**
 * CUÁNTO DURA UN DÍA DE VISITAS, para poder leer «1 día completo».
 *
 * NO ES UN NÚMERO NUEVO: es `excursion_dia_completo_min`, que ya existe en la
 * tabla desde antes y cuya descripción es literalmente «lo que ocupa una
 * excursión que dice "día completo" sin dar hora». Es la misma frase dicha por
 * otra fuente —allí la ficha de Civitatis, aquí la de un sitio— y tiene que
 * valer lo mismo.
 *
 * La primera versión de esto escribió un 480 a mano al lado del parámetro que ya
 * lo decía. Un número de criterio duplicado se desincroniza el día que alguien
 * toca uno de los dos, y entonces la misma frase vale dos cosas distintas según
 * quién la diga.
 */
const minutosDeUnaJornada = () => parametro('excursion_dia_completo_min', 480);

/**
 * LO QUE DURA EL PASEO MÁS CORTO QUE MERECE LLAMARSE VISITA.
 *
 * La red de seguridad del parser, y viene de un fallo concreto. «Ciudad Medieval
 * de Rodas · 1 día completo» acabó colocada como un bloque de **1 minuto**: el
 * lector cogía el 1, no reconocía «día» como unidad y —esta es la raíz— daba por
 * hecho que un número sin unidad son minutos.
 *
 * Que un imprescindible se visite en un minuto no lo cree nadie, así que en vez
 * de arreglar solo «día» se pone también el suelo: lo que salga por debajo de
 * esto no es una duración, es una lectura fallida, y una lectura fallida se dice
 * que no se sabe. Así el próximo formato raro —«1 turno», «1 mañana»— cae en un
 * hueco honesto y no en un bloque de un minuto que nadie mira.
 */
const LO_MINIMO_QUE_ES_UNA_VISITA = 5;

export function minutosDeVisita(texto) {
  const t = String(texto ?? '').toLowerCase().replace(',', '.');
  if (!t.trim()) return null;

  // EL DÍA COMO UNIDAD, ANTES QUE NADA.
  //
  // Va primero porque «1 día completo» lleva un número que el lector de abajo
  // se comería como minutos. Y se lee, en vez de devolver «no lo sé», porque es
  // una frase perfectamente legible: negarse a entenderla para no tener que
  // decidir sería tirar un dato que la ficha da.
  const medio = /\bmedi[oa]\s+(?:d[ií]a|jornada)\b/.test(t);
  if (medio) return Math.round(minutosDeUnaJornada() / 2);

  const dias = t.match(/(\d+(?:\.\d+)?)?\s*\b(?:d[ií]as?|jornadas?)\b/);
  if (dias) {
    const cuantos = Number(dias[1] ?? 1);
    if (!Number.isFinite(cuantos) || cuantos <= 0) return null;
    // Más de un día no es una visita: es un viaje dentro del viaje, y el lienzo
    // no sabe colocar eso. Se dice que no se sabe antes que partirlo a ojo.
    return cuantos > 1 ? null : minutosDeUnaJornada();
  }

  // "1h 30", "1 h 30 min", "2 h 15": las dos piezas de la misma medida. El
  // "min" del final es opcional porque casi nunca viene: "2 h 15" se leia por
  // el camino de abajo como dos medidas sueltas y salian 15 horas.
  const compuesto = t.match(
    /(\d+(?:\.\d+)?)\s*h(?:oras?)?\s*(?:y\s*)?([0-5]?\d)\s*(?:m\w*)?(?![\d:])/
  );
  if (compuesto) return Math.round(Number(compuesto[1]) * 60 + Number(compuesto[2]));

  // Todos los números que haya, con su unidad. Del rango se coge el mayor.
  const trozos = [...t.matchAll(/(\d+(?:\.\d+)?)\s*(h|hora|horas|min|minutos?)?/g)]
    .map((m) => {
      const n = Number(m[1]);
      if (!Number.isFinite(n) || n <= 0) return null;
      const unidad = m[2] ?? '';
      // Sin unidad se hereda la del final: "2-3 horas" son horas las dos.
      if (unidad.startsWith('h')) return Math.round(n * 60);
      if (unidad.startsWith('m')) return Math.round(n);
      return { crudo: n };
    })
    .filter(Boolean);

  if (!trozos.length) return null;

  const enHoras = /h(ora)?/.test(t) && !/min/.test(t.split(/h(ora)?/)[0] ?? '');
  const minutos = trozos.map((x) =>
    typeof x === 'number' ? x : Math.round(x.crudo * (enHoras ? 60 : 1))
  );

  const techo = Math.max(...minutos);
  if (techo > 24 * 60) return null;
  // Y EL SUELO. Por debajo de esto no se ha leído una duración, se ha leído mal.
  return techo >= LO_MINIMO_QUE_ES_UNA_VISITA ? techo : null;
}

/**
 * DE DÓNDE SALE UN CANDIDATO Y CUÁNTO DURA LO SUYO.
 *
 * Antes esto solo sabía de sitios: cualquier otra cosa devolvía null, y null
 * acaba siendo duración cero. Con eso, una excursión de diez horas colocada a
 * las 8:00 era INVISIBLE para el validador de solapes —ocupaba el mismo hueco
 * que nada—, y la revisión podía mandarle un museo encima a las 9:00 y declarar
 * después que el lienzo quedaba limpio. Pasó en Atenas con el crucero y el
 * Museo de la Acrópolis.
 *
 * Ahora se distinguen los tres orígenes que existen, porque los tres ocupan:
 *
 *   sitio     · lo que diga su ficha (`tiempo_visita`), que viene de la búsqueda.
 *   actividad · la duración del catálogo de excursiones («8h 30m - 9h»), que es
 *               el dato más fiable de los tres: lo publica quien la vende.
 *   comer     · una comida también ocupa. No dura lo que dure el restaurante:
 *               dura lo que se está sentado, y eso ya es un parámetro.
 */
function origenDelCandidato(candidatoId) {
  const c = una('SELECT * FROM candidatos WHERE id = ?', Number(candidatoId));
  if (!c) return null;

  let e = null;
  try {
    e = c.datos_extra ? JSON.parse(c.datos_extra) : null;
  } catch {
    e = null;
  }

  if (e?.de === 'sitio' && e.deId != null) {
    const s = una(
      'SELECT id, nombre, tiempo_visita, categoria FROM sitios_lugar WHERE id = ?',
      Number(e.deId)
    );
    return s ? { clase: 'sitio', ...s } : null;
  }

  // La excursión: primero lo que se guardó con el candidato y, si ahí no está,
  // la fila del catálogo. Se mira el candidato antes porque es lo que se eligió.
  if (c.tipo === 'actividad') {
    const delCatalogo =
      e?.deId != null
        ? una('SELECT duracion FROM catalogo_actividades WHERE id = ?', Number(e.deId))
        : null;
    return {
      clase: 'actividad',
      id: c.id,
      nombre: c.titulo,
      duracion: c.duracion ?? delCatalogo?.duracion ?? null,
      categoria: null,
    };
  }

  if (c.tipo === 'comer') return { clase: 'comer', id: c.id, nombre: c.titulo };

  return null;
}

/** El sitio de catálogo del que sale un candidato, si sale de uno. */
function sitioDelCandidato(candidatoId) {
  const o = origenDelCandidato(candidatoId);
  return o?.clase === 'sitio' ? o : null;
}

/** De la categoría del sitio al parámetro que dice cuánto se le reserva. */
const PARAMETRO_DE_CATEGORIA = {
  museos: 'visita_museos_min',
  monumentos: 'visita_monumentos_min',
  naturaleza: 'visita_naturaleza_min',
  miradores: 'visita_miradores_min',
  'barrios y paseos': 'visita_barrios_min',
  'gastronomía': 'visita_gastronomia_min',
  'ocio y parques': 'visita_ocio_min',
  'compras y mercados': 'visita_compras_min',
};

/**
 * CUÁNTO OCUPA LO QUE SE ESTÁ COLOCANDO.
 *
 * Primero lo que diga su ficha, que viene de la búsqueda. Si no lo dice, el
 * valor de su categoría, que es una suposición nuestra y se anuncia como tal a
 * quien llame. Sin esto, todo se colocaba con duración nula y el validador no
 * podía ver un solape: en el viaje de Polonia el día 6 tenía cuatro cosas y
 * ningún aviso, porque todas duraban cero.
 */
export function duracionDeLoColocado(candidatoId) {
  const o = origenDelCandidato(candidatoId);
  if (!o) return { minutos: null, supuesta: false, nombre: null };

  // UNA EXCURSIÓN DURA LO QUE DICE QUIEN LA VENDE. Y cuando lo que dice es
  // «día completo» sin número, se le da la jornada entera: es exactamente lo
  // que significa, y dejarlo en null la volvería invisible otra vez.
  if (o.clase === 'actividad') {
    const delDato = minutosDeVisita(o.duracion);
    if (delDato) return { minutos: delDato, supuesta: false, nombre: o.nombre };

    const esDiaCompleto = /d[ií]a completo|jornada completa|todo el d[ií]a/i.test(
      String(o.duracion ?? '')
    );
    return {
      minutos: esDiaCompleto ? parametro('excursion_dia_completo_min', 480) : parametro('excursion_por_defecto_min', 180),
      supuesta: true,
      nombre: o.nombre,
    };
  }

  // Una comida ocupa lo que se está sentado, no lo que abre el restaurante.
  if (o.clase === 'comer') {
    return { minutos: parametro('duracion_comida_min', 75), supuesta: true, nombre: o.nombre };
  }

  const delDato = minutosDeVisita(o.tiempo_visita);
  if (delDato) return { minutos: delDato, supuesta: false, nombre: o.nombre };

  const clave = PARAMETRO_DE_CATEGORIA[o.categoria] ?? 'visita_por_defecto_min';
  return { minutos: parametro(clave, 90), supuesta: true, nombre: o.nombre };
}

/**
 * HASTA QUÉ HORA SE PUEDE EMPEZAR ALGO, SEGÚN LO QUE SEA.
 *
 * Cuando la ficha trae horario se saca de ahí la hora de cierre MÁS TEMPRANA de
 * las que aparezcan: "Lu: 10:00-15:00, Ma-Do: 10:00-20:00" se lee como que a las
 * 15:00 puede estar cerrado. Es el mismo criterio prudente que con las
 * duraciones —mejor que sobre— y evita mandar a alguien a un museo que cierra.
 *
 * Sin horario legible se cae a la categoría: un mirador aguanta hasta tarde, un
 * museo no. No es una lista de precisión, es un tope de sentido común para que
 * la revisión no resuelva un solape mandando la catedral a las once de la noche.
 */
const CIERRE_POR_CATEGORIA = {
  museos: 17 * 60,
  monumentos: 18 * 60,
  naturaleza: 19 * 60,
  miradores: 21 * 60,
  'barrios y paseos': 22 * 60,
  'gastronomía': 23 * 60,
  'ocio y parques': 20 * 60,
  'compras y mercados': 20 * 60,
};

export function cierraALasMinutos(sitio) {
  // PRIMERO SE LE PREGUNTA AL LECTOR DE HORARIOS, QUE ES QUIEN SABE.
  //
  // EL FALLO QUE ORIGINA ESTO. La «Taverna tradicional en Anafiotika» abre
  // «Generalmente 12:00 a 00:00» y esto contestaba que cierra a las 12:00: coge
  // todas las horas del texto, tira las anteriores a mediodía —el 00:00 de la
  // medianoche entre ellas— y se queda con la menor de las que sobran, que
  // resultaba ser la de APERTURA. De ahí salió una comida a las 14:00 marcada
  // como imposible en un sitio que a esa hora lleva dos horas abierto.
  //
  // El apaño de abajo es de cuando `horarios.js` no sabía leer rangos. Ahora sí
  // —y desde hoy también los que cruzan la medianoche— así que se le pregunta a
  // él y esto se queda solo para lo que él no sepa leer.
  //
  // Se coge el cierre MÁS TEMPRANO de la semana, que es la respuesta prudente
  // para «¿me cabe esta visita?» sin saber de qué día se habla; y se topa en la
  // medianoche, porque un cierre a las 02:00 no alarga el día de hoy.
  // OJO CON LOS SITIOS DE VARIOS TURNOS. Esto devuelve el cierre MÁS TEMPRANO de
  // todos los tramos, que es la respuesta prudente para «¿me cabe la visita?»
  // sin saber de qué día se habla. Pero en un sitio con dos servicios el mismo
  // día —«Almuerzo y cena»: 13:00-16:00 y 20:00-23:30— eso devuelve las 16:00, y
  // leerlo como «cierra a las cuatro» dejaría fuera una cena perfectamente
  // posible. Para esa pregunta hay que usar `abiertoA`, que mira tramo a tramo;
  // aquí se contesta otra cosa, más gruesa y a propósito.
  const finales = horarioPorDias(sitio?.horarios).porDia
    .flatMap((d) => d.rangos)
    .map(([, fin]) => Math.min(fin, 24 * 60));
  if (finales.length) return Math.min(...finales);

  // Lo de siempre para los textos sin rangos legibles: horas sueltas del texto.
  const horas = [...String(sitio?.horarios ?? '').matchAll(/(\d{1,2}):(\d{2})/g)]
    .map((m) => Number(m[1]) * 60 + Number(m[2]))
    // Una hora de cierre no es de madrugada: lo que salga antes de las 12 es la
    // hora de apertura, y compararse con ella dejaría todo fuera.
    .filter((m) => m >= 12 * 60);

  if (horas.length) return Math.min(...horas);
  // Sin horario NI categoría, las ocho de la tarde: mandar una visita a las
  // nueve de la noche «porque cabía» es resolver un aviso creando un plan falso.
  return CIERRE_POR_CATEGORIA[sitio?.categoria] ?? 20 * 60;
}

/**
 * UNA HORA LIBRE DE VERDAD DENTRO DE UNA FRANJA.
 *
 * Devuelve la primera hora a la que cabe algo de `duracion` minutos en esa
 * franja de ese día: sin pisar lo que ya hay, sin pisar los bloques fijos y sin
 * pasarse de la hora a la que cierra el sitio. Null si no cabe.
 *
 * Existe porque la revisión movía las cosas de franja SIN hora, y un bloque sin
 * hora no se solapa con nada: el aviso desaparecía y el problema se quedaba.
 * Esconder no es resolver.
 */
/**
 * ¿HAY QUE ACLIMATARSE EN ESTE VIAJE, Y DESDE QUÉ DÍA?
 *
 * Devuelve el día de llegada y por qué, o null si el vuelo de ida fue uno
 * normal. Los dos umbrales son parámetros porque «largo» y «mucho cambio
 * horario» son cuestión de cuerpo, no de física.
 *
 * Basta con pasarse en UNO de los dos: un vuelo de catorce horas a la misma hora
 * de Europa cansa igual, y cuatro husos en un vuelo de seis horas descolocan
 * igual.
 */
export function diaDeAclimatacion(lienzo) {
  const llegada = (lienzo?.fijos ?? []).find((f) => f.donde === 'ida' && f.esfuerzo);
  if (!llegada) return null;

  const { horas, husos } = llegada.esfuerzo;
  const topeHoras = parametro('horas_vuelo_largo', 8);
  const topeHusos = parametro('husos_jetlag', 4);

  const esLargo = Number.isFinite(horas) && horas > topeHoras;
  const hayJetlag = Number.isFinite(husos) && Math.abs(husos) > topeHusos;

  // Y EL TERCERO: LA HORA A LA QUE SE LLEGA.
  //
  // Los dos de arriba miden el vuelo; éste mide la noche. Madrid-Túnez son 2h15
  // y cero husos —no es largo y no hay jet lag— y se sale del aeropuerto a las
  // 23:59, o sea que al hotel se llega ya del día siguiente. El plan abría la
  // mañana de después con una excursión de ocho horas a las 07:30 y ninguna de
  // las dos reglas tenía nada que decir, porque ninguna estaba mirando esto.
  //
  // Se mide con `horaFin`, que es cuando se sale del aeropuerto, y no con la
  // hora de aterrizar: entre una y otra hay una maleta y una cola.
  const topeHora = enMinutos(parametroTexto('hora_llegada_nocturna', '22:00'));
  const fuera = enMinutos(llegada.horaFin ?? llegada.hora);
  const deNoche = topeHora != null && fuera != null && fuera >= topeHora;

  if (!esLargo && !hayJetlag && !deNoche) return null;

  const motivos = [];
  if (esLargo) motivos.push(`${Math.round(horas)} h de vuelo`);
  if (hayJetlag) motivos.push(`${Math.abs(husos)} husos de diferencia`);
  if (deNoche) motivos.push(`se sale del aeropuerto a las ${llegada.horaFin ?? llegada.hora}`);

  return {
    dia: llegada.dia,
    horas,
    husos,
    deNoche,
    // La hora a la que de verdad se está en la ciudad, para poder decirla.
    horaLlegada: llegada.horaFin ?? llegada.hora ?? null,
    porQue:
      (deNoche && !esLargo && !hayJetlag ? 'llegada de noche: ' : 'llegada tras vuelo largo: ') +
      motivos.join(' y ') +
      ' — día de aclimatación',
  };
}

export function horaLibreEn(lienzo, { dia, franja, duracion = 60, noAntesDe = null, cierraA = null }) {
  const bordes = bordesDeFranja(franja);
  if (!bordes) return null;

  const ocupado = [];
  for (const c of lienzo.colocados.filter((x) => x.dia === dia)) {
    const inicio = enMinutos(c.hora);
    if (inicio == null) continue;
    ocupado.push([inicio, inicio + (Number(c.duracionMin) || 0)]);
  }
  for (const f of lienzo.fijos.filter((x) => x.dia === dia)) {
    const inicio = enMinutos(f.hora);
    if (inicio == null) continue;
    const fin = enMinutos(f.horaFin) ?? inicio;

    // CADA BLOQUE FIJO OCUPA LO QUE DE VERDAD OCUPA:
    //
    //  · la llegada, todo el día HASTA su hora (antes no se está en la ciudad);
    //  · EL SALTO A LA PARADA SIGUIENTE, igual: ese día es ya de la ciudad de
    //    destino, y hasta que el salto termina no se está en ella;
    //  · la salida, desde su hora hasta el final del día;
    //  · cualquier otro traslado, de su salida a su llegada.
    //
    // Sin lo primero, el buscador de huecos daba por libre la mañana del día de
    // llegada y la revisión mandaba museos a las 09:00 de un día en el que el
    // avión aterriza a las 13:30.
    //
    // Y EL SALTO ESTABA EN EL «CUALQUIER OTRO», que es lo que se arregla aquí.
    // Ocupaba solo el viaje —12:50 a 16:15— y dejaba la mañana por libre, así que
    // en el viaje 108 la revisión mandó el Mercado Central de ATENAS a las 09:00
    // de un día en el que a esa hora se estaba en TESALÓNICA, con el tren saliendo
    // tres horas después. El reloj estaba libre; el viajero no.
    //
    // El día de un salto es siempre de la ciudad de destino —comprobado en los
    // cuatro viajes de la base—, así que lo de antes del salto no es un hueco de
    // esa ciudad: es el rato de hacer la maleta en la anterior.
    if (f.donde === 'ida' || f.donde === 'salto') ocupado.push([0, Math.max(inicio, fin)]);
    else if (f.donde === 'vuelta') ocupado.push([inicio, 24 * 60]);
    else ocupado.push([inicio, Math.max(fin, inicio)]);
  }
  ocupado.sort((a, b) => a[0] - b[0]);

  // La mañana empieza a las 0:00 en la definición de la franja, pero nadie
  // empieza una visita a medianoche: el día real arranca a las 9.
  const INICIO_DEL_DIA = 9 * 60;

  // Y NADA DESPUÉS DE LA HORA TOPE, ni recién bajado del avión.
  //
  // En Grecia se colocó una cafetería de desayunos a las 23:00 el día que se
  // aterrizaba a las 22:25. Dos errores en la misma tarjeta: a esa hora ya no se
  // empieza nada, y menos aún media hora después de recoger las maletas.
  const topeDelDia = enMinutos(parametroTexto('hora_maxima_inicio', '22:00')) ?? 22 * 60;
  // Y EL MARGEN DE DESPUÉS DE LLEGAR, que vale igual para el avión del primer
  // día que para el tren de tres horas del salto: bajarse y ponerse a visitar
  // algo en el mismo minuto no lo hace nadie.
  const trasLlegar = (() => {
    const llegada = lienzo.fijos.find(
      (f) => f.dia === dia && (f.donde === 'ida' || f.donde === 'salto')
    );
    if (!llegada) return 0;
    const fin = enMinutos(llegada.horaFin) ?? enMinutos(llegada.hora);
    return fin == null ? 0 : fin + parametro('margen_tras_llegada_min', 60);
  })();

  // --- EL DÍA DE ACLIMATACIÓN Y EL DE DESPUÉS -----------------------------
  //
  // Tras doce horas de avión y cinco husos, el día de llegada se montaba con
  // carga completa desde primera hora, igual que una llegada de Ámsterdam. No es
  // un día normal con menos horas: es medio día y suave.
  //
  //   · El día de llegada acaba a MEDIO CAMINO entre salir del aeropuerto y el
  //     final del día. Es la definición más honesta de «medio día» que se puede
  //     escribir con los datos que hay, y se ajusta sola: quien aterriza a las
  //     seis de la mañana tiene hasta las dos, y quien aterriza a las ocho de la
  //     tarde no tiene nada, que es justo lo que debe pasar.
  //   · El día siguiente no empieza antes de la hora del parámetro.
  const aclimatacion = diaDeAclimatacion(lienzo);
  let inicio = INICIO_DEL_DIA;
  let finDelDia = topeDelDia;

  if (aclimatacion && dia === aclimatacion.dia) {
    finDelDia = Math.min(finDelDia, Math.round((Math.max(trasLlegar, INICIO_DEL_DIA) + topeDelDia) / 2));
  }
  if (aclimatacion && dia === aclimatacion.dia + 1) {
    inicio = Math.max(inicio, enMinutos(parametroTexto('hora_inicio_tras_jetlag', '10:00')) ?? inicio);
  }

  const minimo = Math.max(bordes.desde, inicio, trasLlegar, enMinutos(noAntesDe) ?? 0);

  // El tope de cierre acota cuándo tiene que haber TERMINADO; el del día, cuándo
  // puede EMPEZAR. Son dos cosas distintas: una cena que empieza a las 21:30 y
  // acaba a las 23:00 está bien; una visita que empieza a las 22:30, no.
  //
  // En el día de aclimatación son la misma: lo que se ponga tiene que haber
  // acabado dentro del medio día, no empezar dentro y acabar de noche.
  const tope = Math.min(bordes.hasta, cierraA ?? 24 * 60, finDelDia);

  let candidata = minimo;
  for (const [ini, fin] of ocupado) {
    if (candidata + duracion <= ini) break;      // cabe antes de esta ocupación
    if (fin > candidata) candidata = fin;        // se empuja detrás
  }

  if (candidata + duracion > tope) return null;
  if (candidata >= bordes.hasta) return null;    // ya no es esta franja
  if (candidata >= finDelDia) return null;       // a esa hora ya no se empieza nada
  return comoHora(candidata);
}

/** Cambia de día o de franja. La etapa se recalcula: el día manda. */
export function mover(id, { dia, franja }) {
  const fila = una('SELECT * FROM itinerario WHERE id = ?', id);
  if (!fila) return null;
  if (!CLAVES_FRANJA.includes(franja)) return null;

  const n = Number(dia);
  if (!Number.isInteger(n) || n < 1) return null;

  const etapa = etapaDelDia(fila.viaje_id, n);
  ejecutar(
    'UPDATE itinerario SET dia = ?, franja = ?, etapa_id = ?, orden = ? WHERE id = ?',
    n,
    franja,
    etapa?.id ?? null,
    siguienteOrden(fila.viaje_id, n, franja),
    id
  );
  return una('SELECT * FROM itinerario WHERE id = ?', id);
}

/**
 * Cambia la hora o la duración de algo ya colocado, sin moverlo de sitio.
 *
 * Los traslados la necesitan de verdad —"el bus sale a las 9:15 y son 2 h 30"—
 * pero no se restringe a ellos: cualquier fila puede llevar hora, y una vez
 * hay dónde teclearla no tiene sentido que unas se dejen y otras no.
 */
export function retocar(id, { hora, duracionMin }) {
  const fila = una('SELECT * FROM itinerario WHERE id = ?', id);
  if (!fila) return null;

  // undefined es "no lo toques"; null o cadena vacía es "bórralo".
  if (hora !== undefined) {
    ejecutar('UPDATE itinerario SET hora = ? WHERE id = ?', normalizarHora(hora), id);
  }
  if (duracionMin !== undefined) {
    const m = Number(duracionMin);
    ejecutar(
      'UPDATE itinerario SET duracion_min = ? WHERE id = ?',
      Number.isFinite(m) && m > 0 ? Math.min(Math.round(m), 24 * 60) : null,
      id
    );
  }
  return una('SELECT * FROM itinerario WHERE id = ?', id);
}

/** 95 → "1 h 35". Lo que uno diría en voz alta, no "95 min". */
function minutosLargos(min) {
  const n = Number(min);
  if (!Number.isFinite(n) || n <= 0) return null;
  const h = Math.floor(n / 60);
  const m = n % 60;
  if (!h) return `${m} min`;
  return m ? `${h} h ${m}` : `${h} h`;
}

/**
 * Sube o baja una tarjeta dentro de su franja.
 *
 * Hasta ahora lo único que se podía hacer era soltar una tarjeta en una franja,
 * y caía al final. No había forma de meter una comida entre dos visitas sin
 * borrarlo todo y volver a colocarlo en orden.
 *
 * Intercambia el `orden` con la vecina, que es lo que hace que el movimiento se
 * vea de uno en uno y se entienda. Solo se mueve entre las que NO tienen hora:
 * las que la tienen ya están ordenadas por ella y empujarlas no cambiaría nada,
 * así que la pantalla ni siquiera les ofrece los botones.
 */
export function moverEnFranja(id, direccion) {
  const fila = una('SELECT * FROM itinerario WHERE id = ?', id);
  if (!fila) return null;

  const hermanas = todas(
    `SELECT * FROM itinerario
      WHERE viaje_id = ? AND dia = ? AND franja = ? AND hora IS NULL
      ORDER BY orden, id`,
    fila.viaje_id,
    fila.dia,
    fila.franja
  );

  const i = hermanas.findIndex((h) => h.id === fila.id);
  const j = direccion === 'arriba' ? i - 1 : i + 1;
  if (i < 0 || j < 0 || j >= hermanas.length) return fila;   // ya está en el borde

  // Se intercambian los dos órdenes. Si empataran —puede pasar con datos
  // viejos—, se reparten dos números seguidos para que el cambio se note.
  const a = hermanas[i];
  const b = hermanas[j];
  const ordenA = a.orden === b.orden ? (direccion === 'arriba' ? b.orden + 1 : b.orden - 1) : a.orden;

  ejecutar('UPDATE itinerario SET orden = ? WHERE id = ?', b.orden, a.id);
  ejecutar('UPDATE itinerario SET orden = ? WHERE id = ?', ordenA, b.id);

  return una('SELECT * FROM itinerario WHERE id = ?', id);
}

/** Lo saca del lienzo. Si era un candidato, vuelve solo a la mochila. */
export function quitar(id) {
  const fila = una('SELECT * FROM itinerario WHERE id = ?', id);
  if (!fila) return null;
  ejecutar('DELETE FROM itinerario WHERE id = ?', id);
  return fila;
}

/**
 * Ordena cada franja: primero las que tienen hora, por hora; después el resto.
 *
 * LA HORA MANDA CUANDO LA HAY. Si he apuntado que el free tour es a las 10:00 y
 * la comida a las 14:30, el orden del día ya está dicho y arrastrarlas para
 * ponerlas "bien" es trabajo que no debería hacer nadie.
 *
 * Y las que NO tienen hora conservan su orden manual, detrás. No se mezclan con
 * las otras a ojo: una tarjeta sin hora no tiene un sitio natural entre las
 * 10:00 y las 14:30, y colocarla ahí sería inventárselo. Van después, donde el
 * usuario las suba o las baje.
 *
 * Se ordena aquí y no en el SQL porque `hora` puede ser NULL y la regla es de
 * dos tramos; en una consulta quedaría ilegible.
 */
function ordenarPorHora(colocados) {
  // UN ORDEN TOTAL, sin atajos. El primer intento devolvía 0 para dos tarjetas
  // de franjas distintas —"que las agrupe la vista"— y eso rompe el comparador:
  // deja de ser transitivo y `sort` puede colocarlas como le dé la gana. El
  // resultado era que poner una hora no movía nada.
  const posicionFranja = (f) => {
    const i = CLAVES_FRANJA.indexOf(f);
    return i === -1 ? 99 : i;
  };

  colocados.sort(
    (a, b) =>
      a.dia - b.dia ||
      posicionFranja(a.franja) - posicionFranja(b.franja) ||
      // Con hora van delante, ordenadas entre ellas. Sin hora, detrás y en su
      // orden manual, que es donde el usuario las haya subido o bajado.
      (a.hora ? 0 : 1) - (b.hora ? 0 : 1) ||
      (a.hora && b.hora ? a.hora.localeCompare(b.hora) : 0) ||
      (a.orden ?? 0) - (b.orden ?? 0) ||
      a.id - b.id
  );
}

/** Una fila del itinerario es un traslado si viene de una ficha o de una consulta. */
function esTraslado(f) {
  return Boolean(f.movilidad_id || f.traslado_id);
}

/**
 * Abre un hueco en `posicion` empujando hacia abajo lo que hay de ahí en
 * adelante, y devuelve el orden que le toca al recién llegado.
 */
function hacerSitio(viajeId, dia, franja, posicion) {
  ejecutar(
    `UPDATE itinerario SET orden = orden + 1
      WHERE viaje_id = ? AND dia = ? AND franja = ? AND orden >= ?`,
    viajeId,
    dia,
    franja,
    posicion
  );
  return posicion;
}

/**
 * Qué hay justo antes y justo después de un hueco del lienzo.
 *
 * Es lo que contesta el "+" que sale entre dos tarjetas. Vive en el servidor y
 * no en el navegador porque los vecinos NO siempre están en la misma franja:
 *
 *  - En medio de una franja son las tarjetas de al lado, sin más.
 *  - Al principio de la tarde, el de antes es la última tarjeta de la mañana.
 *  - En los bordes del día no hay tarjeta: es EL HOTEL. Se sale de dormir y se
 *    vuelve a dormir, y ese es justo el traslado que uno quiere calcular.
 *
 * Las tarjetas que YA SON un traslado se saltan: enlazar un traslado con otro
 * no dice nada, y saltándolo se llega a los dos sitios de verdad.
 */
export function vecinosDeHueco(viajeId, { dia, franja, indice }) {
  const n = Number(dia);
  if (!Number.isInteger(n) || !CLAVES_FRANJA.includes(franja)) return null;

  const etapa = etapaDelDia(viajeId, n);

  const delDia = todas(
    `SELECT * FROM itinerario
      WHERE viaje_id = ? AND dia = ?
      ORDER BY orden, id`,
    viajeId,
    n
  );

  const deLaFranja = delDia.filter((f) => f.franja === franja);
  const i = Math.max(0, Math.min(Number(indice) || 0, deLaFranja.length));

  // El orden que le tocará a la tarjeta nueva: el de la que está ahora en esa
  // posición, o el siguiente libre si el hueco es el final.
  const orden = i < deLaFranja.length ? deLaFranja[i].orden : siguienteOrden(viajeId, n, franja);

  // Las franjas van en un orden fijo, y "antes" y "después" del día se miden
  // con él: la mañana va antes que la tarde aunque las filas digan otra cosa.
  const posicionFranja = (f) => CLAVES_FRANJA.indexOf(f);
  const aplanado = [...delDia].sort(
    (a, b) => posicionFranja(a.franja) - posicionFranja(b.franja) || a.orden - b.orden || a.id - b.id
  );

  // Dónde cae el hueco dentro del día entero.
  const corte =
    i < deLaFranja.length
      ? aplanado.findIndex((x) => x.id === deLaFranja[i].id)
      : (() => {
          const ultima = deLaFranja[deLaFranja.length - 1];
          if (ultima) return aplanado.findIndex((x) => x.id === ultima.id) + 1;
          // Franja vacía: el corte va detrás de todo lo de las franjas anteriores.
          return aplanado.filter((x) => posicionFranja(x.franja) < posicionFranja(franja)).length;
        })();

  const antes = [...aplanado.slice(0, corte)].reverse().find((x) => !esTraslado(x)) ?? null;
  const despues = aplanado.slice(corte).find((x) => !esTraslado(x)) ?? null;

  const hotel = etapa ? lugarDelHotel(etapa.id) : null;

  return {
    viajeId,
    dia: n,
    franja,
    indice: i,
    orden,
    etapaId: etapa?.id ?? null,
    ciudad: etapa?.nombre_ciudad ?? null,
    // Sin vecino de un lado se usa el hotel: es de donde se sale por la mañana
    // y a donde se vuelve por la noche.
    origen: antes ? lugarDeFila(antes) : hotel,
    destino: despues ? lugarDeFila(despues) : hotel,
    hayHotel: Boolean(hotel),
  };
}

/**
 * Una tarjeta del lienzo, traducida a "un sitio al que se puede ir".
 *
 * La dirección no vive en la tarjeta: vive con el elemento del catálogo del que
 * la tarjeta es copia. `direccionDeCandidato` es quien sabe dar ese salto.
 */
function lugarDeFila(fila) {
  if (fila.movilidad_id) {
    const m = una('SELECT * FROM catalogo_movilidad WHERE id = ?', fila.movilidad_id);
    if (!m) return null;
    const d = direccionDe('movilidad', m.id);
    return {
      tipo: 'movilidad',
      id: m.id,
      nombre: m.nombre,
      texto: m.nombre,
      direccion: d?.direccion ?? null,
      situada: Boolean(d?.situada),
    };
  }

  if (fila.candidato_id) {
    const c = una('SELECT * FROM candidatos WHERE id = ?', fila.candidato_id);
    if (!c) return null;
    const clave = claveDeCandidato(c);
    const d = clave ? direccionDe(clave.tipo, clave.id) : null;
    return {
      tipo: clave?.tipo ?? null,
      id: clave?.id ?? null,
      nombre: c.titulo,
      texto: c.titulo,
      direccion: d?.direccion ?? null,
      situada: Boolean(d?.situada),
    };
  }

  // Una tarjeta escrita a mano no tiene dónde guardar una dirección: se ofrece
  // como texto libre y el geocodificador hará lo que pueda con ella.
  return {
    tipo: null,
    id: null,
    nombre: fila.texto_manual,
    texto: fila.texto_manual,
    direccion: null,
    // Se da por situable: el texto libre se busca al calcular.
    situada: true,
    libre: true,
  };
}

/** El hotel elegido de una parada, como sitio al que se va. */
function lugarDelHotel(etapaId) {
  const h = una(
    "SELECT * FROM candidatos WHERE etapa_id = ? AND tipo = 'hotel' AND marcado = 1",
    etapaId
  );
  if (!h) return null;

  const d = direccionDe('hotel', h.id);
  return {
    tipo: 'hotel',
    id: h.id,
    nombre: h.titulo,
    texto: h.titulo,
    direccion: d?.direccion ?? null,
    situada: Boolean(d?.situada),
    esHotel: true,
  };
}

/** Al final de su franja, que es donde uno espera que aparezca lo que suelta. */
function siguienteOrden(viajeId, dia, franja) {
  const ultimo = una(
    'SELECT MAX(orden) AS n FROM itinerario WHERE viaje_id = ? AND dia = ? AND franja = ?',
    viajeId,
    dia,
    franja
  );
  return (ultimo?.n ?? 0) + 1;
}

/**
 * Dónde está colocada cada cosa apuntada de una etapa. Lo usa la pantalla de
 * etapa para decir "Día 5 · tarde" al lado de lo ya repartido.
 */
export function colocacionesDeEtapa(etapaId) {
  const filas = todas(
    `SELECT i.id, i.candidato_id, i.dia, i.franja
       FROM itinerario i
      WHERE i.etapa_id = ? AND i.candidato_id IS NOT NULL`,
    etapaId
  );
  return new Map(
    filas.map((f) => [
      f.candidato_id,
      { id: f.id, dia: f.dia, franja: f.franja, etiqueta: `Día ${f.dia} · ${etiquetaFranja(f.franja)}` },
    ])
  );
}

/** Los días que le tocan a una etapa, para el mini-selector de su pantalla. */
export function diasDeEtapa(viajeId, etapaId) {
  const lienzo = lienzoDeViaje(viajeId, { etapaId });
  return lienzo?.dias ?? [];
}
