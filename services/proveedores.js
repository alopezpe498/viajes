/**
 * services/proveedores.js
 * -----------------------------------------------------------------------------
 * EL ENCHUFE. Esta es la unica puerta por la que las pantallas piden datos.
 *
 * ESTADO ACTUAL DE LA CONEXION:
 *   - obtenerActividades  -> CONECTADO a providers/civitatis.js (datos REALES),
 *                            a traves de la cola de trabajos (jobs/).
 *   - obtenerHoteles      -> CONECTADO a providers/booking.js (datos REALES),
 *                            tambien por la cola de trabajos.
 *   - obtenerVuelos       -> CONECTADO a providers/kayak.js (datos REALES),
 *                            tambien por la cola de trabajos.
 *   - obtenerAvisos       -> CONECTADO a services/avisos.js (Open-Meteo,
 *                            Exteriores y Nager.Date). Sin navegador.
 *
 * La regla que hace posible ir conectando de uno en uno sin romper nada:
 *   NINGUNA ruta ni plantilla lee datos directamente de la BD ni de un provider.
 *   TODAS pasan por aqui.
 */

import { todas, una, ejecutar } from '../db/index.js';
import { encolar, trabajoActivo, ultimoTrabajo } from '../jobs/cola.js';

/**
 * =============================================================================
 * DE DONDE SALES SIEMPRE
 * =============================================================================
 * Este generador es personal y siempre se sale del mismo sitio, asi que el
 * origen no se pregunta en el wizard: se fija aqui.
 *
 * Es un codigo IATA de CIUDAD (BCN = Barcelona-El Prat). Si algun dia te mudas
 * YA SE PUEDE ELEGIR POR VIAJE: `viajes.ciudad_origen`, que se rellena en la
 * pantalla de configuracion. Esto es solo el valor por defecto, para los viajes
 * que no lo digan.
 */
export const ORIGEN_POR_DEFECTO = 'Barcelona';

/**
 * De dónde se sale, para un viaje concreto.
 *
 * Se pregunta en la pantalla de configuración y se guarda en el viaje. Sin
 * viaje —o si está vacío— vale Barcelona, que es de donde se salía siempre.
 */
export function ciudadDeCasa(viaje = null) {
  if (viaje && typeof viaje === 'object') {
    return String(viaje.ciudad_origen ?? '').trim() || ORIGEN_POR_DEFECTO;
  }
  // También admite el id, que es como lo tienen a mano algunos sitios.
  if (viaje != null) {
    const v = una('SELECT ciudad_origen FROM viajes WHERE id = ?', Number(viaje));
    return String(v?.ciudad_origen ?? '').trim() || ORIGEN_POR_DEFECTO;
  }
  return ORIGEN_POR_DEFECTO;
}

/**
 * Lee los candidatos de un tipo para un viaje.
 * Ordenados por valoracion descendente, que es como se quieren ver.
 */
/**
 * Los candidatos de un tipo, en el ambito del VIAJE.
 *
 * Se excluye lo que cuelga de un TRAMO de la ruta, y hay que hacerlo desde que
 * cada tramo se busca por separado: la ida y la vuelta son dos busquedas de
 * solo ida, y el paso 5 las listaba juntas y revueltas como si fueran opciones
 * de ida y vuelta del viaje. Cada tramo tiene su lista en su tarjeta.
 *
 * Con `etapa_id` NO se hace lo mismo, y a proposito: un hotel se duerme EN una
 * ciudad, asi que SIEMPRE cuelga de una etapa —hasta cuando lo busca el paso 6,
 * que lo guarda en la unica del viaje—. Excluirlos aqui dejaria el paso 6
 * eternamente vacio, buscando una y otra vez algo que ya tiene.
 */
function candidatosDe(viajeId, tipo) {
  return todas(
    `SELECT * FROM candidatos
      WHERE viaje_id = ? AND tipo = ? AND transporte_id IS NULL
      ORDER BY (valoracion IS NULL), valoracion DESC, id ASC`,
    viajeId,
    tipo
  ).map((c) => ({
    ...c,
    marcado: Boolean(c.marcado),
    // datos_extra viaja como texto JSON; lo devolvemos ya convertido.
    extra: c.datos_extra ? JSON.parse(c.datos_extra) : {},
  }));
}

/**
 * =============================================================================
 * ACTIVIDADES — CONECTADO A CIVITATIS
 * =============================================================================
 * A diferencia del resto, esto NO devuelve un array sino un objeto con estado,
 * porque los datos pueden no estar todavia:
 *
 *   { estado: 'hecho'|'buscando'|'error'|'sin_destino', actividades, trabajo }
 *
 * La logica es la de una cache que se llena sola:
 *   a) ¿ya hay actividades de civitatis para este viaje? -> devolverlas
 *      (un destino se scrapea UNA vez; para repetir, "Actualizar datos")
 *   b) ¿hay un trabajo pendiente o en curso? -> "buscando"
 *   c) ¿el ultimo trabajo fallo? -> "error", con su mensaje
 *   d) ¿no hay nada de nada? -> encolar y "buscando"
 */
export async function obtenerActividades(viaje) {
  // Sin destino no hay nada que buscar (puede pasar si se salta el paso 2).
  if (!viaje.destino) {
    return { estado: 'sin_destino', actividades: [], trabajo: null };
  }

  const guardadas = candidatosDe(viaje.id, 'actividad').filter(
    (c) => c.origen_datos === 'civitatis'
  );

  // (a) Cache llena: fuera.
  if (guardadas.length) {
    return { estado: 'hecho', actividades: guardadas, trabajo: null };
  }

  // (b) Ya hay alguien buscando: no encolamos otro.
  const activo = trabajoActivo(viaje.id, 'actividades');
  if (activo) {
    return { estado: 'buscando', actividades: [], trabajo: activo };
  }

  // (c) El ultimo intento fallo: mostramos el error y ofrecemos reintentar.
  //     No reencolamos solos, que si el destino no existe entrariamos en bucle.
  const ultimo = ultimoTrabajo(viaje.id, 'actividades');
  if (ultimo?.estado === 'error') {
    return { estado: 'error', actividades: [], trabajo: ultimo };
  }

  // (d) Primera vez: a la cola.
  const nuevo = encolar(viaje.id, 'actividades');
  return { estado: 'buscando', actividades: [], trabajo: nuevo };
}

/**
 * Fuerza una busqueda nueva: borra las actividades de civitatis que NO estan
 * marcadas y encola otro trabajo.
 *
 * Lo marcado no se toca NUNCA: si has elegido el Louvre, sigue elegido aunque
 * refresques el catalogo.
 */
export async function refrescarActividades(viajeId) {
  const r = ejecutar(
    `DELETE FROM candidatos
      WHERE viaje_id = ? AND tipo = 'actividad' AND origen_datos = 'civitatis' AND marcado = 0`,
    viajeId
  );
  const trabajo = encolar(viajeId, 'actividades');
  return { borradas: r.changes, trabajo };
}

/**
 * Estado del trabajo de actividades, para el sondeo (polling) de la pantalla.
 * Devuelve algo pequeñito: la pantalla solo necesita saber si ya puede recargar.
 */
export function estadoActividades(viajeId) {
  const conCivitatis = todas(
    `SELECT COUNT(*) AS n FROM candidatos
      WHERE viaje_id = ? AND tipo = 'actividad' AND origen_datos = 'civitatis'`,
    viajeId
  )[0].n;

  const activo = trabajoActivo(viajeId, 'actividades');
  if (activo) return { estado: 'buscando', total: conCivitatis, mensaje_error: null };

  if (conCivitatis > 0) return { estado: 'hecho', total: conCivitatis, mensaje_error: null };

  const ultimo = ultimoTrabajo(viajeId, 'actividades');
  if (ultimo?.estado === 'error') {
    return { estado: 'error', total: 0, mensaje_error: ultimo.mensaje_error };
  }

  return { estado: 'sin_datos', total: 0, mensaje_error: null };
}

/**
 * Filtros de hoteles de un viaje, ya normalizados y con sus valores por defecto.
 * Se guardan como JSON en la columna `filtros_hoteles`.
 */
export function filtrosHotelesDe(viaje) {
  let guardados = {};
  try {
    guardados = viaje.filtros_hoteles ? JSON.parse(viaje.filtros_hoteles) : {};
  } catch {
    guardados = {}; // JSON corrupto: seguimos sin filtros en vez de reventar
  }
  return {
    // --- Precio y calidad ---
    precioMin: Number(guardados.precioMin) || null,
    precioMax: Number(guardados.precioMax) || null,
    notaMinima: [7, 8, 9].includes(Number(guardados.notaMinima)) ? Number(guardados.notaMinima) : null,
    estrellas: [3, 4, 5].includes(Number(guardados.estrellas)) ? Number(guardados.estrellas) : null,
    // --- Comodidades ---
    piscina: Boolean(guardados.piscina),
    wifi: Boolean(guardados.wifi),
    parking: Boolean(guardados.parking),
    desayuno: Boolean(guardados.desayuno),
    // --- Condiciones ---
    cancelacionGratis: Boolean(guardados.cancelacionGratis),
    tipoAlojamiento: ['hotel', 'apartamento'].includes(guardados.tipoAlojamiento)
      ? guardados.tipoAlojamiento
      : null,
    // Viaja a Booking (nflt=distance) y ademas se comprueba aqui sobre lo leido.
    distanciaMax: [1, 3].includes(Number(guardados.distanciaMax)) ? Number(guardados.distanciaMax) : null,
  };
}

/**
 * "a 1,2 km del centro" -> 1.2 · "a 500 m del centro" -> 0.5
 * Devuelve null si no hay dato o no se entiende.
 */
export function kmDelCentro(texto) {
  if (!texto) return null;
  const m = /([\d.,]+)\s*(km|m)\b/i.exec(texto);
  if (!m) return null;

  // OJO CON EL PUNTO. Booking en espanol escribe "1,2 km" (coma decimal) y
  // en ingles "1.2 km" (punto decimal). Antes se borraban TODOS los puntos
  // por si eran separador de miles, y eso convertia 1.2 km en 12 km: un
  // hotel del centro quedaba descartado por estar "a 12 km". El punto solo
  // separa miles cuando le siguen tres digitos ("1.200 m").
  let crudo = m[1];
  if (crudo.includes(',')) {
    crudo = crudo.replace(/\./g, '').replace(',', '.');
  } else {
    crudo = crudo.replace(/\.(?=\d{3}(?:\D|$))/g, '');
  }

  const valor = Number(crudo);
  if (!Number.isFinite(valor)) return null;
  return m[2].toLowerCase() === 'm' ? valor / 1000 : valor;
}

/**
 * Filtros que NO sabe hacer Booking por URL y aplicamos nosotros sobre los
 * resultados ya guardados. Ahora mismo solo la distancia al centro.
 *
 * Al ser local, cambiarlo no obliga a volver a scrapear: se nota al momento.
 * Los que no traen distancia NO se descartan: preferimos enseñar de mas a
 * esconder un hotel que a lo mejor te vale solo porque Booking no dijo a
 * cuanto esta.
 */
export function aplicarFiltrosLocales(hoteles, filtros) {
  if (!filtros?.distanciaMax) return hoteles;

  return hoteles.filter((h) => {
    const km = kmDelCentro(h.extra?.distanciaCentro);
    if (km == null) return true; // sin dato, no se descarta
    return km <= filtros.distanciaMax;
  });
}

/** Guarda los filtros de hoteles de un viaje. */
export function guardarFiltrosHoteles(viajeId, filtros) {
  ejecutar('UPDATE viajes SET filtros_hoteles = ? WHERE id = ?', JSON.stringify(filtros), viajeId);
  return filtros;
}

/**
 * Resumen en texto de los filtros activos, para poder poner bajo el titulo
 * "qué estoy viendo exactamente". Ej: "8+ · piscina · wifi · hasta 150 €/noche"
 */
export function resumenFiltros(filtros) {
  const trozos = [];
  if (filtros.notaMinima) trozos.push(`${filtros.notaMinima}+`);
  if (filtros.estrellas) trozos.push(filtros.estrellas === 5 ? '5 estrellas' : `${filtros.estrellas}+ estrellas`);
  if (filtros.piscina) trozos.push('piscina');
  if (filtros.wifi) trozos.push('wifi');
  if (filtros.parking) trozos.push('parking');
  if (filtros.desayuno) trozos.push('desayuno');
  if (filtros.cancelacionGratis) trozos.push('cancelación gratis');
  if (filtros.tipoAlojamiento === 'hotel') trozos.push('solo hoteles');
  if (filtros.tipoAlojamiento === 'apartamento') trozos.push('solo apartamentos');
  if (filtros.distanciaMax) trozos.push(`a menos de ${filtros.distanciaMax} km del centro`);

  if (filtros.precioMin && filtros.precioMax) {
    trozos.push(`${filtros.precioMin}–${filtros.precioMax} €/noche`);
  } else if (filtros.precioMax) {
    trozos.push(`hasta ${filtros.precioMax} €/noche`);
  } else if (filtros.precioMin) {
    trozos.push(`desde ${filtros.precioMin} €/noche`);
  }

  return trozos.length ? trozos.join(' · ') : 'sin filtros';
}

/**
 * Ocupacion del viaje en el formato que esperan los providers.
 *
 * Se calcula aqui, en un solo sitio, para que kayak.js y booking.js reciban
 * exactamente lo mismo y no haya dos interpretaciones de "cuantos van".
 */
export function ocupacionDe(viaje) {
  const edades = viaje.edades_ninos
    ? JSON.parse(viaje.edades_ninos)
    : (viaje.edadesNinos ?? []);
  return {
    adultos: Math.max(Number(viaje.adultos) || 1, 1),
    edadesNinos: edades.map(Number).filter((e) => Number.isInteger(e) && e >= 0 && e <= 17),
  };
}

/**
 * Olvida los vuelos y hoteles que NO estan marcados, y vuelve a buscarlos.
 *
 * Se llama cuando cambian los viajeros o las fechas: unos vuelos buscados para
 * 2 adultos no valen para 2 adultos + 1 nino (ni el precio ni la
 * disponibilidad). Lo marcado se respeta, como en el resto de la app.
 *
 * Y REENCOLA, que es la parte importante. Si solo borrasemos, al entrar en la
 * pantalla te encontrarias unicamente con la opcion que tenias marcada (con su
 * precio ya caducado) y la app diria tan tranquila que ya ha terminado de
 * buscar. Reencolamos SOLO lo que ya se habia buscado alguna vez: si nunca
 * miraste los hoteles, no vamos a ponernos a scrapear Booking por tu cuenta.
 */
export async function olvidarTransporteYAlojamiento(viajeId) {
  let borrados = 0;
  const reencolados = [];

  for (const [tipoCandidato, tipoTrabajo] of [['vuelo', 'vuelos'], ['hotel', 'hoteles']]) {
    // ¿Habia algo buscado de este tipo? (marcado o no)
    const habia = todas(
      `SELECT COUNT(*) AS n FROM candidatos WHERE viaje_id = ? AND tipo = ?`,
      viajeId,
      tipoCandidato
    )[0].n;

    const r = ejecutar(
      `DELETE FROM candidatos WHERE viaje_id = ? AND tipo = ? AND marcado = 0`,
      viajeId,
      tipoCandidato
    );
    borrados += r.changes;

    if (habia > 0) {
      encolar(viajeId, tipoTrabajo);
      reencolados.push(tipoTrabajo);
    }
  }

  return { borrados, reencolados };
}

/**
 * =============================================================================
 * FILTROS DE VUELOS
 * =============================================================================
 * Dos familias, y la diferencia importa:
 *
 *  - Los que sabe hacer Kayak (escalas y duracion maxima) viajan en la URL.
 *    Ventaja: las 15 opciones que trae ya son buenas. Inconveniente: cambiarlos
 *    obliga a buscar otra vez.
 *  - Los que Kayak ignora (franja horaria y precio) los aplicamos aqui sobre lo
 *    ya leido. Ventaja: se notan al momento. Se marcan en el panel como
 *    instantaneos, igual que la distancia en hoteles.
 *
 * El porque de cada decision, con lo que comprobe en su web, esta en la
 * cabecera de providers/kayak.js.
 */
export function filtrosVuelosDe(viaje) {
  return normalizarFiltrosVuelos(viaje?.filtros_vuelos);
}

/**
 * Deja unos filtros de vuelo en su forma buena, vengan de donde vengan.
 *
 * Se saco de `filtrosVuelosDe` cuando los filtros dejaron de ser solo del
 * viaje: ahora cada TRAMO guarda los suyos en su propia columna, y los dos
 * sitios tienen que entender exactamente lo mismo por "directos" o por
 * "menos de 4 h". Un unico saneado, un unico criterio.
 *
 * Acepta el JSON tal cual sale de la base de datos o un objeto ya parseado.
 */
export function normalizarFiltrosVuelos(origen) {
  let g = {};
  try {
    g = typeof origen === 'string' ? JSON.parse(origen || '{}') : (origen ?? {});
  } catch {
    g = {}; // JSON corrupto: se sigue sin filtros en vez de reventar
  }
  const franja = (v) => (['manana', 'tarde', 'noche'].includes(v) ? v : null);
  return {
    // --- Van en la URL de Kayak ---
    escalas: ['directos', 'max1'].includes(g.escalas) ? g.escalas : null,
    duracionMax: [4, 8, 12].includes(Number(g.duracionMax)) ? Number(g.duracionMax) : null,
    // --- Locales (instantaneos) ---
    salidaIda: franja(g.salidaIda),
    salidaVuelta: franja(g.salidaVuelta),
    precioMaxPersona: Number(g.precioMaxPersona) || null,
  };
}

/** Guarda los filtros de vuelos de un viaje. */
export function guardarFiltrosVuelos(viajeId, filtros) {
  ejecutar('UPDATE viajes SET filtros_vuelos = ? WHERE id = ?', JSON.stringify(filtros), viajeId);
  return filtros;
}

/** Franjas horarias, tal y como se explican en el panel. */
const FRANJAS = {
  manana: { etiqueta: 'sale por la mañana', desde: 0, hasta: 12 },
  tarde: { etiqueta: 'sale por la tarde', desde: 12, hasta: 19 },
  noche: { etiqueta: 'sale por la noche', desde: 19, hasta: 24 },
};

/** "7:20" -> 7 · null si no se entiende. */
export function horaDe(texto) {
  const m = /^(\d{1,2}):(\d{2})/.exec(String(texto ?? '').trim());
  return m ? Number(m[1]) : null;
}

/** ¿Esa hora de salida cae en la franja pedida? Sin hora, no descarta. */
function encajaEnFranja(horaSalida, franja) {
  if (!franja) return true;
  const h = horaDe(horaSalida);
  if (h == null) return true;
  const { desde, hasta } = FRANJAS[franja];
  return h >= desde && h < hasta;
}

/**
 * Cuantas personas pagan billete. Los precios de Kayak son del paquete entero,
 * asi que para el "maximo por persona" hay que repartirlo.
 * (No manejamos bebes en regazo, que serian la excepcion.)
 */
export function viajerosDePago(viaje) {
  return Math.max((Number(viaje.adultos) || 1) + (Number(viaje.ninos) || 0), 1);
}

/**
 * Filtros que aplicamos NOSOTROS sobre las opciones ya guardadas: franja
 * horaria de ida, franja de vuelta y precio maximo por persona.
 * Lo que no trae dato no se descarta.
 */
export function aplicarFiltrosLocalesVuelos(vuelos, filtros, viaje) {
  const pax = viajerosDePago(viaje);

  return vuelos.filter((v) => {
    const tramos = v.extra?.tramos ?? [];
    const ida = tramos.find((t) => t.tramo === 'ida');
    const vuelta = tramos.find((t) => t.tramo === 'vuelta');

    if (!encajaEnFranja(ida?.horaSalida, filtros.salidaIda)) return false;
    if (!encajaEnFranja(vuelta?.horaSalida, filtros.salidaVuelta)) return false;

    if (filtros.precioMaxPersona && v.precio != null) {
      if (v.precio / pax > filtros.precioMaxPersona) return false;
    }
    return true;
  });
}

/** Resumen en texto de los filtros de vuelo activos. */
export function resumenFiltrosVuelos(filtros) {
  const trozos = [];
  if (filtros.escalas === 'directos') trozos.push('solo directos');
  if (filtros.escalas === 'max1') trozos.push('máx. 1 escala');
  if (filtros.duracionMax) trozos.push(`trayectos de menos de ${filtros.duracionMax} h`);
  if (filtros.salidaIda) trozos.push(`ida ${FRANJAS[filtros.salidaIda].etiqueta}`);
  if (filtros.salidaVuelta) trozos.push(`vuelta ${FRANJAS[filtros.salidaVuelta].etiqueta}`);
  if (filtros.precioMaxPersona) trozos.push(`hasta ${filtros.precioMaxPersona} €/persona`);
  return trozos.length ? trozos.join(' · ') : 'sin filtros';
}

/**
 * =============================================================================
 * VUELOS — CONECTADO A KAYAK
 * =============================================================================
 * Mismo patron que actividades y hoteles: devuelve estado, no un array pelado.
 *
 *   { estado: 'hecho'|'buscando'|'error'|'sin_datos_viaje', vuelos, trabajo }
 *
 * OJO CON EL MODELO: cada elemento de `vuelos` NO es un vuelo suelto, es una
 * OPCION de ida y vuelta con un unico precio. Los dos tramos van dentro de
 * extra.tramos. Por eso la pantalla pinta una sola lista y no dos.
 */
export async function obtenerVuelos(viaje, { orden = 'precio' } = {}) {
  if (!viaje.destino || !viaje.fecha_inicio || !viaje.fecha_fin) {
    return { estado: 'sin_datos_viaje', vuelos: [], trabajo: null };
  }

  const guardados = candidatosDe(viaje.id, 'vuelo').filter((c) => c.origen_datos === 'kayak');

  if (guardados.length) {
    const filtros = filtrosVuelosDe(viaje);
    const visibles = aplicarFiltrosLocalesVuelos(guardados, filtros, viaje);
    return {
      estado: 'hecho',
      vuelos: ordenarVuelos(visibles, orden),
      // Para poder distinguir "no hay vuelos" de "los filtros no dejan pasar
      // ninguno", que es un mensaje muy distinto.
      totalSinFiltrosLocales: guardados.length,
      ocultosPorFiltros: guardados.length - visibles.length,
      trabajo: null,
    };
  }

  const activo = trabajoActivo(viaje.id, 'vuelos');
  if (activo) return { estado: 'buscando', vuelos: [], trabajo: activo };

  const ultimo = ultimoTrabajo(viaje.id, 'vuelos');
  if (ultimo?.estado === 'error') return { estado: 'error', vuelos: [], trabajo: ultimo };

  // NUNCA se busca sola al entrar. Kayak abre un Chrome y tarda; que eso pase
  // solo por pasar por la pantalla es agresivo y ademas te impide elegir los
  // filtros ANTES de gastar la busqueda. Asi que aqui nos quedamos quietos y
  // la pantalla ensena el panel abierto con el boton de buscar.
  return { estado: 'sin_buscar', vuelos: [], trabajo: null };
}

/**
 * Ordena las opciones de vuelo. Por defecto por precio, que es lo que se mira
 * primero; 'duracion' usa los minutos totales de ida + vuelta.
 */
export function ordenarVuelos(vuelos, orden = 'precio') {
  const alFinalSiEsNulo = (v) => (v == null ? Number.POSITIVE_INFINITY : v);

  if (orden === 'duracion') {
    return [...vuelos].sort(
      (a, b) => alFinalSiEsNulo(a.extra.minutosTotales) - alFinalSiEsNulo(b.extra.minutosTotales)
    );
  }
  return [...vuelos].sort((a, b) => alFinalSiEsNulo(a.precio) - alFinalSiEsNulo(b.precio));
}

/** Fuerza una busqueda nueva de vuelos, conservando lo marcado. */
export async function refrescarVuelos(viajeId) {
  // Se borran los del VIAJE y se deja en paz lo que cuelga de un tramo de la
  // ruta.
  //
  // La razón es que el trabajo que se encola aquí es de ámbito viaje: busca del
  // origen al destino general. Si de paso se llevara por delante los vuelos de
  // los tramos, esos tramos se quedarían vacíos y sin nada que los repueble,
  // porque el trabajo que va a correr no es el suyo. Cada tramo se refresca
  // desde su propia pantalla, con su botón.
  const r = ejecutar(
    `DELETE FROM candidatos
      WHERE viaje_id = ? AND tipo = 'vuelo' AND origen_datos = 'kayak'
        AND marcado = 0 AND transporte_id IS NULL`,
    viajeId
  );
  const trabajo = encolar(viajeId, 'vuelos');
  return { borrados: r.changes, trabajo };
}

/** Estado del trabajo de vuelos, para el sondeo de la pantalla. */
export function estadoVuelos(viajeId) {
  const cuantos = todas(
    `SELECT COUNT(*) AS n FROM candidatos
      WHERE viaje_id = ? AND tipo = 'vuelo' AND origen_datos = 'kayak'`,
    viajeId
  )[0].n;

  const activo = trabajoActivo(viajeId, 'vuelos');
  if (activo) return { estado: 'buscando', total: cuantos, mensaje_error: null };
  if (cuantos > 0) return { estado: 'hecho', total: cuantos, mensaje_error: null };

  const ultimo = ultimoTrabajo(viajeId, 'vuelos');
  if (ultimo?.estado === 'error') return { estado: 'error', total: 0, mensaje_error: ultimo.mensaje_error };

  return { estado: 'sin_datos', total: 0, mensaje_error: null };
}

/**
 * =============================================================================
 * HOTELES — CONECTADO A BOOKING
 * =============================================================================
 * Mismo patron que las actividades: devuelve estado, no un array pelado.
 *
 *   { estado: 'hecho'|'buscando'|'error'|'sin_datos_viaje', hoteles, trabajo }
 */
export async function obtenerHoteles(viaje, { orden = 'recomendados' } = {}) {
  // Sin destino o sin fechas no se puede buscar: Booking necesita las tres cosas.
  if (!viaje.destino || !viaje.fecha_inicio || !viaje.fecha_fin) {
    return { estado: 'sin_datos_viaje', hoteles: [], trabajo: null };
  }

  const guardados = candidatosDe(viaje.id, 'hotel').filter((c) => c.origen_datos === 'booking');

  if (guardados.length) {
    // El filtro local (distancia) se aplica aqui, sobre lo ya guardado.
    const filtros = filtrosHotelesDe(viaje);
    const visibles = aplicarFiltrosLocales(guardados, filtros);
    return {
      estado: 'hecho',
      hoteles: ordenarHoteles(visibles, orden),
      ocultosPorDistancia: guardados.length - visibles.length,
      trabajo: null,
    };
  }

  const activo = trabajoActivo(viaje.id, 'hoteles');
  if (activo) return { estado: 'buscando', hoteles: [], trabajo: activo };

  const ultimo = ultimoTrabajo(viaje.id, 'hoteles');
  if (ultimo?.estado === 'error') return { estado: 'error', hoteles: [], trabajo: ultimo };

  const nuevo = encolar(viaje.id, 'hoteles');
  return { estado: 'buscando', hoteles: [], trabajo: nuevo };
}

/**
 * NOTA PONDERADA (media bayesiana). Sirve para que un 10 con 5 opiniones no le
 * gane a un 9,1 con 1.096 opiniones.
 *
 *   ponderada = (nota * n  +  NOTA_BASE * PESO_BASE) / (n + PESO_BASE)
 *
 * La idea, en cristiano: a cada hotel le regalamos PESO_BASE opiniones
 * imaginarias con una nota mediocre (NOTA_BASE). Si el hotel tiene muchas
 * opiniones propias, esas 50 imaginarias apenas pesan y la nota ponderada se
 * parece a la real. Si tiene cuatro, las imaginarias mandan y lo arrastran
 * hacia el 7,5. O sea: hay que ganarse la nota alta con volumen.
 *
 *   10,0 con     5 opiniones -> (10*5   + 7.5*50) / 55   = 7,73
 *    9,1 con 1.096 opiniones -> (9.1*1096 + 7.5*50) / 1146 = 9,03  <- gana, y bien
 */
const NOTA_BASE = 7.5;   // nota "del montón" hacia la que tiramos
const PESO_BASE = 50;    // cuántas opiniones imaginarias regalamos

export function notaPonderada(valoracion, numOpiniones) {
  if (valoracion == null) return null;
  const n = Number(numOpiniones) || 0;
  return (valoracion * n + NOTA_BASE * PESO_BASE) / (n + PESO_BASE);
}

/** Ordena los hoteles segun lo que haya pedido la pantalla. */
export function ordenarHoteles(hoteles, orden = 'recomendados') {
  const conNota = hoteles.map((h) => ({ ...h, ponderada: notaPonderada(h.valoracion, h.num_opiniones) }));

  const alFinalSiEsNulo = (valor) => (valor == null ? Number.POSITIVE_INFINITY : valor);

  if (orden === 'precio') {
    return conNota.sort((a, b) => alFinalSiEsNulo(a.precio) - alFinalSiEsNulo(b.precio));
  }
  if (orden === 'nota') {
    return conNota.sort((a, b) => (b.valoracion ?? -1) - (a.valoracion ?? -1));
  }
  // recomendados: la ponderada
  return conNota.sort((a, b) => (b.ponderada ?? -1) - (a.ponderada ?? -1));
}

/**
 * Fuerza una busqueda nueva de hoteles, conservando lo marcado.
 * Es lo que hacen tanto "Actualizar datos" como "Buscar con estos filtros".
 */
export async function refrescarHoteles(viajeId) {
  // Igual que con los vuelos: los hoteles que cuelgan de una ETAPA no se tocan
  // desde aquí. Este trabajo busca en el destino general del viaje y no sabría
  // reponer los de cada parada; cada etapa tiene su propio botón.
  const r = ejecutar(
    `DELETE FROM candidatos
      WHERE viaje_id = ? AND tipo = 'hotel' AND origen_datos = 'booking'
        AND marcado = 0 AND etapa_id IS NULL`,
    viajeId
  );
  const trabajo = encolar(viajeId, 'hoteles');
  return { borrados: r.changes, trabajo };
}

/** Estado del trabajo de hoteles, para el sondeo de la pantalla. */
export function estadoHoteles(viajeId) {
  const cuantos = todas(
    `SELECT COUNT(*) AS n FROM candidatos
      WHERE viaje_id = ? AND tipo = 'hotel' AND origen_datos = 'booking'`,
    viajeId
  )[0].n;

  const activo = trabajoActivo(viajeId, 'hoteles');
  if (activo) return { estado: 'buscando', total: cuantos, mensaje_error: null };
  if (cuantos > 0) return { estado: 'hecho', total: cuantos, mensaje_error: null };

  const ultimo = ultimoTrabajo(viajeId, 'hoteles');
  if (ultimo?.estado === 'error') return { estado: 'error', total: 0, mensaje_error: ultimo.mensaje_error };

  return { estado: 'sin_datos', total: 0, mensaje_error: null };
}

/**
 * =============================================================================
 * AVISOS — CONECTADO (clima, seguridad y festivos)
 * =============================================================================
 * Mismo patron de estados que el resto. La diferencia: este trabajo SI se
 * encola solo, al confirmar el destino, porque no hay filtros que elegir antes
 * y ademas no abre navegador (son tres peticiones y ya).
 *
 *   { estado: 'hecho'|'buscando'|'error'|'sin_datos_viaje', avisos, trabajo }
 */
export async function obtenerAvisos(viaje) {
  if (!viaje.destino || !viaje.fecha_inicio || !viaje.fecha_fin) {
    return { estado: 'sin_datos_viaje', avisos: [], trabajo: null };
  }

  const guardados = todas(
    `SELECT * FROM avisos WHERE viaje_id = ? ORDER BY
       CASE categoria WHEN 'clima' THEN 1 WHEN 'seguridad' THEN 2 ELSE 3 END,
       CASE severidad WHEN 'alerta' THEN 1 WHEN 'precaucion' THEN 2 ELSE 3 END,
       id`,
    viaje.id
  );

  if (guardados.length) return { estado: 'hecho', avisos: guardados, trabajo: null };

  const activo = trabajoActivo(viaje.id, 'avisos');
  if (activo) return { estado: 'buscando', avisos: [], trabajo: activo };

  const ultimo = ultimoTrabajo(viaje.id, 'avisos');
  if (ultimo?.estado === 'error') return { estado: 'error', avisos: [], trabajo: ultimo };

  // Aqui SI encolamos solos: llegar a la pantalla 3 es justo el momento de
  // tener los avisos, y no hay nada que configurar antes.
  const nuevo = encolar(viaje.id, 'avisos');
  return { estado: 'buscando', avisos: [], trabajo: nuevo };
}

/** Vuelve a consultar las tres fuentes. Los avisos no se marcan: se rehacen. */
export async function refrescarAvisos(viajeId) {
  const r = ejecutar('DELETE FROM avisos WHERE viaje_id = ?', viajeId);
  const trabajo = encolar(viajeId, 'avisos');
  return { borrados: r.changes, trabajo };
}

/** Estado del trabajo de avisos, para el sondeo de la pantalla. */
export function estadoAvisos(viajeId) {
  const cuantos = todas('SELECT COUNT(*) AS n FROM avisos WHERE viaje_id = ?', viajeId)[0].n;

  const activo = trabajoActivo(viajeId, 'avisos');
  if (activo) return { estado: 'buscando', total: cuantos, mensaje_error: null };
  if (cuantos > 0) return { estado: 'hecho', total: cuantos, mensaje_error: null };

  const ultimo = ultimoTrabajo(viajeId, 'avisos');
  if (ultimo?.estado === 'error') return { estado: 'error', total: 0, mensaje_error: ultimo.mensaje_error };

  return { estado: 'sin_datos', total: 0, mensaje_error: null };
}

/**
 * Olvida los avisos de un viaje y vuelve a pedirlos.
 * Se llama cuando cambian el destino o las fechas: unos avisos de Lisboa en
 * octubre no valen para Oporto en marzo.
 */
export async function olvidarAvisos(viajeId, { reencolar = true } = {}) {
  const r = ejecutar('DELETE FROM avisos WHERE viaje_id = ?', viajeId);
  ejecutar("DELETE FROM trabajos WHERE viaje_id = ? AND tipo = 'avisos' AND estado IN ('hecho','error')", viajeId);
  if (reencolar) encolar(viajeId, 'avisos');
  return { borrados: r.changes };
}

/**
 * Todo lo que el usuario ha marcado, agrupado por tipo.
 * Lo usan el panel lateral y la pantalla 8 (resumen).
 */
export async function obtenerSeleccion(viajeId) {
  const marcados = todas(
    `SELECT * FROM candidatos WHERE viaje_id = ? AND marcado = 1 ORDER BY tipo, id`,
    viajeId
  ).map((c) => ({ ...c, marcado: true, extra: c.datos_extra ? JSON.parse(c.datos_extra) : {} }));

  const porTipo = { actividad: [], vuelo: [], hotel: [], sitio: [] };
  for (const c of marcados) (porTipo[c.tipo] ??= []).push(c);

  const costeTotal = marcados.reduce((suma, c) => suma + (c.precio ?? 0), 0);

  return { marcados, porTipo, total: marcados.length, costeTotal };
}
