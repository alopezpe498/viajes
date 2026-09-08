/**
 * services/etapa.js
 * -----------------------------------------------------------------------------
 * El subproyecto de una parada: qué ver, dónde dormir y cómo llegar.
 *
 * Aquí NO se reinventa nada. El catálogo de Civitatis, el panel de Booking y el
 * de Kayak ya existen y funcionan; lo que hace este módulo es conectarlos al
 * contexto de UNA etapa en vez de al del viaje entero:
 *
 *   viaje entero          ->  etapa
 *   viaje.destino         ->  etapa.nombre_ciudad
 *   viaje.fecha_inicio    ->  etapa.fecha_inicio
 *   candidatos.viaje_id   ->  candidatos.etapa_id
 *
 * El truco para reutilizar los trabajos de la cola sin romper los usos de
 * antes es `trabajos.referencia_id`: un trabajo de hoteles CON referencia es de
 * una etapa; sin ella, del viaje, como toda la vida.
 */

import { todas, una, ejecutar, db } from '../db/index.js';
import { encolar, trabajoActivo, ultimoTrabajo } from '../jobs/cola.js';
import { actividadesDeCiudad, fichaDeFila, estadoCacheCiudad } from './catalogo.js';
import {
  notaPonderada,
  filtrosHotelesDe,
  aplicarFiltrosLocales,
  ordenarHoteles,
  ciudadDeCasa,
  normalizarFiltrosVuelos,
  aplicarFiltrosLocalesVuelos,
  resumenFiltrosVuelos,
} from './proveedores.js';
import { referenciaDeTramo, comoTexto, comoDuracion } from './distancias.js';
import { borrarAdjuntosDe, adjuntosDe } from './adjuntos.js';
import { sincronizarEtapaUnica } from './etapas.js';
import { medioElegidoDeTramo } from './movilidad.js';
import { direccionesDe, direccionDe, volcarDireccionDeHotel } from './direcciones.js';

/** Los tipos de transporte que se pueden apuntar a mano. */
export const TIPOS_TRANSPORTE = [
  { valor: 'tren', etiqueta: 'Tren', icono: 'ti-train' },
  { valor: 'bus', etiqueta: 'Autobús', icono: 'ti-bus' },
  { valor: 'coche', etiqueta: 'Coche', icono: 'ti-car' },
  { valor: 'ferry', etiqueta: 'Ferry', icono: 'ti-ship' },
  { valor: 'vuelo', etiqueta: 'Vuelo', icono: 'ti-plane' },
];

// =============================================================================
// LA ETAPA
// =============================================================================
/** La etapa con lo que hace falta alrededor: su viaje y su punto del catálogo. */
export function cargarEtapa(etapaId) {
  const etapa = una('SELECT * FROM etapas WHERE id = ?', etapaId);
  if (!etapa) return null;

  const viaje = una('SELECT * FROM viajes WHERE id = ?', etapa.viaje_id);
  const punto = etapa.punto_interes_id
    ? una('SELECT * FROM puntos_interes WHERE id = ?', etapa.punto_interes_id)
    : null;

  // El destino del catálogo al que pertenece esta parada. Hay dos formas de
  // llegar a él y las dos valen:
  //   - directa: la etapa nació de un destino de nivel ciudad (Madrid).
  //   - indirecta: la etapa es un punto de un destino de nivel país (Kioto,
  //     dentro de Japón); ahí el destino es el país, y lo que sabemos de Kioto
  //     está en la ficha profunda del punto.
  const destino = etapa.destino_id
    ? una('SELECT * FROM destinos WHERE id = ?', etapa.destino_id)
    : null;

  const hermanas = todas(
    "SELECT id, nombre_ciudad, orden FROM etapas WHERE viaje_id = ? AND estado = 'confirmada' ORDER BY orden, id",
    etapa.viaje_id
  );
  const i = hermanas.findIndex((e) => e.id === etapa.id);

  return {
    etapa,
    viaje,
    punto,
    destino,
    confirmada: etapa.estado === 'confirmada',
    // Para la navegación del pie. Una etapa sin confirmar no está en la lista,
    // así que no tiene ni anterior ni siguiente: es correcto.
    anterior: i > 0 ? hermanas[i - 1] : null,
    siguiente: i >= 0 && i < hermanas.length - 1 ? hermanas[i + 1] : null,
    posicion: i >= 0 ? i + 1 : null,
    total: hermanas.length,
  };
}

/** Coordenadas de una etapa, si su punto del catálogo las tiene. */
function coordenadasDeEtapa(etapaId) {
  const fila = una(
    `SELECT p.lat, p.lon FROM etapas e
       JOIN puntos_interes p ON p.id = e.punto_interes_id
      WHERE e.id = ?`,
    etapaId
  );
  return fila?.lat != null && fila?.lon != null ? { lat: fila.lat, lon: fila.lon } : null;
}

/** Coordenadas de casa: las del destino del catálogo que haga de origen. */
function coordenadasDeCasa() {
  // El wizard todavía no pregunta el origen, así que se usa el de siempre.
  // Barcelona, que es lo que significa ORIGEN_POR_DEFECTO.
  return { lat: 41.3874, lon: 2.1686 };
}

// =============================================================================
// 1) QUÉ VER
// =============================================================================
/**
 * Los sitios de la ciudad y las excursiones, cada uno sabiendo si ya está
 * apuntado en ESTA etapa.
 *
 * Lo apuntado son `candidatos` con `etapa_id`: los mismos que ya usaba el
 * catálogo del viaje, solo que colgando de la parada.
 */
export function queVerDeEtapa(contexto) {
  const { etapa, punto, destino, viaje } = contexto;

  // DOS FUENTES, según de dónde venga la parada:
  //
  //  a) De un destino de nivel CIUDAD (Madrid): lo que hay que ver son sus
  //     `puntos_interes` — el Prado, el Retiro, el Palacio Real.
  //  b) De un punto de un destino de nivel PAÍS (Kioto, dentro de Japón): lo
  //     que hay que ver es la ficha profunda de ese punto, en `sitios_lugar`.
  //
  // Una parada puede tener las dos si un día se investiga a fondo, así que se
  // suman en vez de elegir. Se normalizan a la misma forma para que la pantalla
  // no tenga que saber de dónde salió cada una.
  // EL DETALLE GENERADO NO SE PIERDE.
  //
  // Ampliar la ficha del Coliseo escribe tres cosas en el CATALOGO: el párrafo
  // del "por qué", el "cómo moverse" (los dos en `puntos_interes.datos_extra`) y
  // los lugares de dentro (`sitios_lugar`). Esta consulta se traía solo el
  // nombre, la foto y la descripción corta, así que al llegar aquí ese detalle
  // parecía haberse esfumado: seguía guardado, pero nadie lo leía.
  //
  // Los hijos se piden de una vez y se agrupan en memoria: una consulta por
  // sitio serían quince consultas para pintar una pestaña.
  const puntosDelDestino =
    destino && destino.tipo === 'ciudad'
      ? todas('SELECT * FROM puntos_interes WHERE destino_id = ? ORDER BY orden, id', destino.id)
      : [];

  const hijosPorPunto = new Map();
  if (puntosDelDestino.length) {
    for (const h of todas(
      `SELECT * FROM sitios_lugar
        WHERE punto_interes_id IN (${puntosDelDestino.map(() => '?').join(',')})
        ORDER BY orden, id`,
      ...puntosDelDestino.map((p) => p.id)
    )) {
      if (!hijosPorPunto.has(h.punto_interes_id)) hijosPorPunto.set(h.punto_interes_id, []);
      hijosPorPunto.get(h.punto_interes_id).push(h);
    }
  }

  /** `datos_extra` viejo o corrupto no puede tumbar la pantalla. */
  const extraDe = (texto) => {
    try {
      return texto ? (JSON.parse(texto) ?? {}) : {};
    } catch {
      return {};
    }
  };

  const delDestino = puntosDelDestino.map((p) => {
    const extra = extraDe(p.datos_extra);
    return {
      id: p.id,
      origen: 'punto',
      nombre: p.nombre,
      descripcion: p.descripcion_corta ?? p.por_que,
      imagen_url: p.imagen_url,
      wikipedia_url: p.wikipedia_url,
      lat: p.lat,
      lon: p.lon,
      // Lo que salió de ampliar la ficha. Si nunca se amplió, van vacíos y la
      // tarjeta ofrece ampliarla.
      porQue: extra.parrafoPorQue ?? null,
      comoMoverse: extra.comoMoverse ?? null,
      dentro: hijosPorPunto.get(p.id) ?? [],
      ampliada: Boolean(p.investigado_en),
      ampliando: Boolean(trabajoActivo(viaje.id, 'investigar_ciudad', p.id)),
    };
  });

  const delPunto = punto
    ? todas(
        'SELECT * FROM sitios_lugar WHERE punto_interes_id = ? ORDER BY orden, id',
        punto.id
      ).map((s) => ({
        id: s.id,
        origen: 'sitio',
        nombre: s.nombre,
        descripcion: s.descripcion,
        imagen_url: s.imagen_url,
        wikipedia_url: s.wikipedia_url,
        lat: s.lat,
        lon: s.lon,
        // Un lugar de dentro de una ficha no tiene ficha propia: su descripción
        // ES su detalle. Los campos van igualmente para que la plantilla no
        // tenga que preguntar de dónde salió cada tarjeta.
        porQue: null,
        comoMoverse: null,
        dentro: [],
        ampliada: true,
        ampliando: false,
      }))
    : [];

  const sitios = [...delDestino, ...delPunto];

  // Las excursiones van por nombre de ciudad, que es como se guardan en el
  // catálogo: no necesitan el enlace.
  const excursiones = actividadesDeCiudad(etapa.nombre_ciudad);

  // Qué hay apuntado ya. La clave es la url cuando la hay y el título si no,
  // que es el mismo criterio con el que el worker evita duplicados.
  const apuntados = todas(
    "SELECT * FROM candidatos WHERE etapa_id = ? AND tipo IN ('sitio', 'actividad')",
    etapa.id
  );
  const claveDe = (url, titulo) => url || `titulo:${titulo}`;
  const porClave = new Map(apuntados.map((c) => [claveDe(c.url, c.titulo), c]));

  const conEstado = (lista, url, titulo) => {
    const c = porClave.get(claveDe(url, titulo));
    return { apuntado: Boolean(c), candidatoId: c?.id ?? null };
  };

  // Las direcciones, de una tacada y por tabla de origen. Una consulta por
  // ficha serían veinte para pintar una pestaña, que es el mismo motivo por el
  // que los adjuntos ya se piden así.
  const dirPuntos = direccionesDe('punto', delDestino.map((x) => x.id));
  const dirSitios = direccionesDe('sitio', delPunto.map((x) => x.id));
  const dirActividades = direccionesDe('actividad', excursiones.map((x) => x.id));

  return {
    // Hay ficha que enseñar si la parada trae sitios de cualquiera de las dos
    // fuentes; que el punto esté "investigado" ya no es la única vía.
    investigada: Boolean(punto?.investigado_en) || delDestino.length > 0,
    sitios: sitios.map((s) => ({
      ...s,
      // La dirección vive con la fila del CATÁLOGO de la que sale la tarjeta, y
      // `origen` dice de cuál de las dos tablas es.
      direccion: (s.origen === 'punto' ? dirPuntos : dirSitios).get(s.id) ?? null,
      ...conEstado(sitios, s.wikipedia_url, s.nombre),
    })),
    excursiones: excursiones.map((a) => {
      // La ficha completa, si alguien la pidió alguna vez. Es del CATÁLOGO, así
      // que puede venir de otro viaje: se buscó una vez y vale para siempre.
      const trabajando = Boolean(trabajoActivo(viaje.id, 'ficha_actividad', a.id));
      const ultima = ultimoTrabajo(viaje.id, 'ficha_actividad', a.id);

      const estado = conEstado(excursiones, a.url, a.titulo);

      return {
        ...a,
        // El punto de encuentro es la dirección de una excursión. Muchas lo
        // traen ya de Civitatis: la migración lo volcó y aquí se lee como una
        // dirección más, editable como todas.
        direccion: dirActividades.get(a.id) ?? null,
        // La nota bayesiana es la que ya usa el catálogo: no se cambia el
        // criterio solo porque la caja esté en otra pantalla.
        notaPonderada: notaPonderada(a.valoracion, a.num_opiniones),
        // Los papeles (bonos, entradas) cuelgan del CANDIDATO, no de la fila del
        // catálogo: son de esta excursión en ESTE viaje. Una excursión que no
        // está apuntada todavía no tiene dónde guardarlos.
        adjuntos: estado.candidatoId ? adjuntosDe('excursion', estado.candidatoId) : [],
        ficha: fichaDeFila(a),
        buscandoFicha: trabajando,
        errorFicha: !trabajando && !a.detalles_en && ultima?.estado === 'error'
          ? ultima.mensaje_error
          : null,
        ...estado,
      };
    }),
    apuntados: apuntados.length,
  };
}

/**
 * Apunta o desapunta algo. Es un interruptor: si ya estaba, lo quita.
 *
 * `que` dice de QUÉ TABLA sale, y hay que decirlo porque tres tablas distintas
 * tienen ids que se solapan: el id 42 es el Museo del Prado en `puntos_interes`
 * y otra cosa completamente distinta en `sitios_lugar`.
 *
 *   'punto'     -> puntos_interes  (lo que ver en un destino de nivel ciudad)
 *   'sitio'     -> sitios_lugar    (la ficha profunda de un punto)
 *   'actividad' -> catalogo_actividades (las excursiones de Civitatis)
 *   'comer'     -> catalogo_comer  (bares y restaurantes)
 *
 * Los dos primeros acaban siendo un candidato de tipo 'sitio': para el viaje
 * son lo mismo, una cosa que ver en esa parada. Comer es su propio tipo porque
 * en el lienzo se comporta distinto —tiene su hora y su franja natural— y
 * porque en la mochila conviene poder filtrarlo aparte.
 */
export function alternarApuntado(etapaId, que, id) {
  const etapa = una('SELECT * FROM etapas WHERE id = ?', etapaId);
  if (!etapa) return null;

  const origen =
    que === 'sitio'
      ? una('SELECT * FROM sitios_lugar WHERE id = ?', id)
      : que === 'punto'
        ? una('SELECT * FROM puntos_interes WHERE id = ?', id)
        : que === 'comer'
          ? una('SELECT * FROM catalogo_comer WHERE id = ?', id)
          : una('SELECT * FROM catalogo_actividades WHERE id = ?', id);
  if (!origen) return null;

  const tipo = que === 'actividad' ? 'actividad' : que === 'comer' ? 'comer' : 'sitio';

  const url = origen.url ?? origen.web ?? origen.wikipedia_url ?? null;
  const titulo = origen.nombre ?? origen.titulo;

  // CON URL SE BUSCA POR URL; SIN ELLA, POR TÍTULO. Y no las dos cosas a la vez.
  //
  // Antes esto era un solo SELECT con `url IS ? OR (url IS NULL AND titulo = ?)`,
  // y con la url a NULL la primera mitad se convierte en `url IS NULL`, que casa
  // con CUALQUIER fila sin url de esa parada. Con sitios y excursiones no se
  // notaba —casi todas traen enlace—, pero los restaurantes que encuentra la IA
  // no tienen ninguno: apuntar el segundo desapuntaba el primero.
  const yaEsta = url
    ? una(
        'SELECT * FROM candidatos WHERE etapa_id = ? AND tipo = ? AND url = ?',
        etapaId,
        tipo,
        url
      )
    : una(
        'SELECT * FROM candidatos WHERE etapa_id = ? AND tipo = ? AND url IS NULL AND titulo = ?',
        etapaId,
        tipo,
        titulo
      );

  if (yaEsta) {
    // Desapuntar borra el candidato, así que sus adjuntos se quedarían sueltos:
    // el bono de una excursión que ya no está en el viaje no es de nadie.
    borrarAdjuntosDe('excursion', yaEsta.id).catch((err) =>
      console.error('[etapa] no se pudieron borrar los adjuntos:', err)
    );
    ejecutar('DELETE FROM candidatos WHERE id = ?', yaEsta.id);
    return { apuntado: false, viajeId: etapa.viaje_id };
  }

  ejecutar(
    `INSERT INTO candidatos
       (viaje_id, etapa_id, tipo, titulo, precio, moneda, duracion, valoracion,
        num_opiniones, url, imagen_url, origen_datos, marcado, datos_extra)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 1, ?)`,
    etapa.viaje_id,
    etapaId,
    tipo,
    titulo,
    origen.precio ?? null,
    origen.moneda ?? null,
    origen.duracion ?? null,
    origen.valoracion ?? null,
    origen.num_opiniones ?? null,
    url,
    origen.imagen_url ?? null,
    tipo === 'comer' ? (origen.origen ?? 'comer') : tipo === 'sitio' ? 'catalogo' : 'civitatis',
    JSON.stringify({ de: que, deId: origen.id })
  );

  return { apuntado: true, viajeId: etapa.viaje_id };
}

// =============================================================================
// 2) DÓNDE DORMIR
// =============================================================================
/**
 * Los hoteles de esta etapa, con el mismo patrón de estados de siempre.
 *
 * La diferencia con `obtenerHoteles(viaje)` es de contexto, no de forma: se
 * busca con la ciudad y las fechas de LA ETAPA, y los candidatos cuelgan de
 * ella. El trabajo de la cola es el mismo 'hoteles', con la etapa como
 * referencia.
 */
export function hotelesDeEtapa(contexto, { orden = 'recomendados' } = {}) {
  const { etapa, viaje } = contexto;

  if (!etapa.fecha_inicio || !etapa.fecha_fin) {
    return { estado: 'sin_fechas', hoteles: [], elegido: null, trabajo: null };
  }

  const guardados = todas(
    `SELECT * FROM candidatos
      WHERE etapa_id = ? AND tipo = 'hotel' AND origen_datos = 'booking'
      ORDER BY (valoracion IS NULL), valoracion DESC, id ASC`,
    etapa.id
  ).map((c) => ({
    ...c,
    marcado: Boolean(c.marcado),
    extra: c.datos_extra ? JSON.parse(c.datos_extra) : {},
  }));

  const elegido = guardados.find((h) => h.marcado) ?? null;
  // El hotel es la excepción de las direcciones: no sale de ningún catálogo, es
  // una reserva de ESTE viaje, así que su dirección va con el candidato.
  if (elegido) elegido.direccion = direccionDe('hotel', elegido.id);

  if (guardados.length) {
    const filtros = filtrosHotelesDe(viaje);
    const visibles = aplicarFiltrosLocales(guardados, filtros);
    return {
      estado: 'hecho',
      hoteles: ordenarHoteles(visibles, orden),
      ocultosPorDistancia: guardados.length - visibles.length,
      elegido,
      trabajo: null,
    };
  }

  const activo = trabajoActivo(viaje.id, 'hoteles', etapa.id);
  if (activo) return { estado: 'buscando', hoteles: [], elegido: null, trabajo: activo };

  const ultimo = ultimoTrabajo(viaje.id, 'hoteles', etapa.id);
  if (ultimo?.estado === 'error') {
    return { estado: 'error', hoteles: [], elegido: null, trabajo: ultimo };
  }

  // Como en el resto de la app: los hoteles NO se buscan solos al entrar.
  // Booking abre un navegador y tarda; que lo pida quien quiera pedirlo.
  return { estado: 'sin_datos', hoteles: [], elegido: null, trabajo: null };
}

/** Lanza (o relanza) la búsqueda de hoteles de una etapa. */
export function buscarHotelesDeEtapa(etapaId) {
  const etapa = una('SELECT * FROM etapas WHERE id = ?', etapaId);
  if (!etapa) return null;

  // Fuera lo que no esté elegido, que es lo que hay que refrescar.
  const r = ejecutar(
    `DELETE FROM candidatos
      WHERE etapa_id = ? AND tipo = 'hotel' AND origen_datos = 'booking' AND marcado = 0`,
    etapaId
  );
  const trabajo = encolar(etapa.viaje_id, 'hoteles', etapaId);
  return { borrados: r.changes, trabajo };
}

/**
 * Elige un hotel para la etapa. Solo puede haber uno: elegir otro suelta el
 * anterior, que es lo que uno espera al cambiar de idea.
 */
export function elegirHotel(etapaId, candidatoId) {
  const candidato = una(
    "SELECT * FROM candidatos WHERE id = ? AND etapa_id = ? AND tipo = 'hotel'",
    candidatoId,
    etapaId
  );
  if (!candidato) return null;

  const seElige = !candidato.marcado;

  db.exec('BEGIN');
  try {
    ejecutar("UPDATE candidatos SET marcado = 0 WHERE etapa_id = ? AND tipo = 'hotel'", etapaId);
    // Volver a pulsar el que ya estaba elegido lo suelta: sirve de "ninguno".
    if (seElige) ejecutar('UPDATE candidatos SET marcado = 1 WHERE id = ?', candidatoId);
    db.exec('COMMIT');
  } catch (err) {
    db.exec('ROLLBACK');
    throw err;
  }

  // LA DIRECCIÓN SE VIENE CON ÉL.
  //
  // Esto faltaba justo aquí. La otra forma de elegir hotel —la del paso 6— sí
  // la volcaba, pero por esta pantalla, que es por donde se elige de verdad,
  // no pasaba nadie: el candidato enseñaba su dirección de Booking y al
  // marcarlo el hotel del viaje se quedaba sin ella. Luego, para cualquier
  // traslado desde el hotel, había que teclearla a mano.
  //
  // Fuera de la transacción a propósito: encola una geocodificación, y eso no
  // tiene por qué ir dentro del BEGIN de un UPDATE de dos líneas.
  if (seElige) volcarDireccionDeHotel(candidato);

  return { elegido: seElige };
}

/** Estado del trabajo de hoteles de una etapa, para el sondeo. */
export function estadoHotelesDeEtapa(etapaId) {
  const etapa = una('SELECT * FROM etapas WHERE id = ?', etapaId);
  if (!etapa) return { estado: 'sin_datos', total: 0, mensaje_error: null };

  const cuantos = una(
    "SELECT COUNT(*) AS n FROM candidatos WHERE etapa_id = ? AND tipo = 'hotel'",
    etapaId
  ).n;

  const activo = trabajoActivo(etapa.viaje_id, 'hoteles', etapaId);
  if (activo) return { estado: 'buscando', total: cuantos, mensaje_error: null };
  if (cuantos > 0) return { estado: 'hecho', total: cuantos, mensaje_error: null };

  const ultimo = ultimoTrabajo(etapa.viaje_id, 'hoteles', etapaId);
  if (ultimo?.estado === 'error') {
    return { estado: 'error', total: 0, mensaje_error: ultimo.mensaje_error };
  }
  return { estado: 'sin_datos', total: 0, mensaje_error: null };
}

// =============================================================================
// 3) CÓMO LLEGAR
// =============================================================================
/**
 * Los tramos que le tocan a esta etapa: por dónde se sale de ella y, si es la
 * primera, también cómo se llega desde casa.
 */
export function tramosDeEtapa(contexto) {
  const { etapa, viaje } = contexto;

  const filas = todas(
    `SELECT * FROM transportes
      WHERE viaje_id = ? AND (etapa_origen_id = ? OR (etapa_destino_id = ? AND etapa_origen_id IS NULL))
      ORDER BY (etapa_origen_id IS NULL) DESC, id`,
    viaje.id,
    etapa.id,
    etapa.id
  );

  return filas.map((t) => describirTramo(t));
}

/** Un tramo con todo lo que hace falta para pintarlo. */
export function describirTramo(t) {
  const casa = ciudadDeCasa();
  const origen = t.etapa_origen_id ? una('SELECT * FROM etapas WHERE id = ?', t.etapa_origen_id) : null;
  const destino = t.etapa_destino_id ? una('SELECT * FROM etapas WHERE id = ?', t.etapa_destino_id) : null;

  const donde = !origen ? 'ida' : !destino ? 'vuelta' : 'salto';
  const nombreOrigen = origen?.nombre_ciudad ?? casa;
  const nombreDestino = destino?.nombre_ciudad ?? casa;

  const vuelo = t.candidato_id
    ? una('SELECT * FROM candidatos WHERE id = ?', t.candidato_id)
    : null;

  // El medio elegido en "Cómo llegar". Un tramo también se resuelve así: elegir
  // el bus de las 9:15 es tan resolutivo como elegir un vuelo, y hasta ahora la
  // tarjeta seguía diciendo "¿Cómo vas de Sarajevo a Mostar?" con el billete ya
  // comprado.
  const medio = medioElegidoDeTramo(t.id);

  // La fecha del tramo: se sale el día en que acaba la etapa de origen, o el
  // día en que empieza la de destino cuando se viene de casa.
  const fecha = origen?.fecha_fin ?? destino?.fecha_inicio ?? null;

  const referencia = t.distancia_km
    ? comoTexto({ km: t.distancia_km, minutos: t.duracion_min, fuente: t.fuente_distancia })
    : null;

  // La etiqueta de fecha de la tarjeta rica. Ahora cada tramo se busca solo
  // ida, asi que el trayecto lleva LA FECHA DEL TRAMO. `fechaVuelta` se queda
  // como respaldo para las tarjetas de ida y vuelta que se guardaran antes de
  // que la busqueda pasara a ser por tramo: sin ella se quedarian sin etiqueta.
  const viaje = una('SELECT fecha_inicio, fecha_fin FROM viajes WHERE id = ?', t.viaje_id);

  return {
    id: t.id,
    donde,
    tipo: t.tipo,
    nombreOrigen,
    nombreDestino,
    etapaOrigenId: t.etapa_origen_id,
    etapaDestinoId: t.etapa_destino_id,
    fecha,
    // Un tramo está resuelto si se eligió un vuelo, un medio, o se apuntó a mano.
    resuelto: Boolean(t.candidato_id || t.notas || medio),
    medio,
    vuelo: vuelo ? { id: vuelo.id, titulo: vuelo.titulo, precio: vuelo.precio, moneda: vuelo.moneda } : null,
    notas: t.notas,
    precioEstimado: t.precio_estimado,
    distanciaKm: t.distancia_km,
    duracionMin: t.duracion_min,
    fuenteDistancia: t.fuente_distancia,
    referencia,
    fechaIda: fecha ?? viaje?.fecha_inicio ?? null,
    fechaVuelta: viaje?.fecha_fin ?? null,
    // Para el chip de la pantalla de ruta.
    resumen: resumenDeTramo(t, nombreOrigen, nombreDestino, donde, vuelo, casa, medio),
  };
}

/** El texto del chip: lo que se lee de un vistazo en la pantalla de ruta. */
export function resumenDeTramo(t, nombreOrigen, nombreDestino, donde, vuelo, casa, medio = null) {
  // El medio elegido manda: es lo más concreto que hay, y lo tecleado debajo
  // —"sale 9:15"— es justo lo que uno quiere leer de un vistazo.
  if (medio) {
    return [medio.etiquetaMedio, medio.horario || medio.duracion, medio.precioReal || medio.precio]
      .filter(Boolean)
      .join(' · ');
  }

  if (!t.candidato_id && !t.notas) {
    return donde === 'ida'
      ? `Vuelo ${casa} → ${nombreDestino} · pendiente`
      : donde === 'vuelta'
        ? `Vuelo ${nombreOrigen} → ${casa} · pendiente`
        : `¿Cómo vas de ${nombreOrigen} a ${nombreDestino}?`;
  }

  if (vuelo) return vuelo.titulo;

  // Resuelto a mano: tipo, lo que se haya apuntado y, si la hay, la distancia.
  const etiqueta = TIPOS_TRANSPORTE.find((x) => x.valor === t.tipo)?.etiqueta ?? t.tipo;
  const trozos = [etiqueta];
  if (t.notas) trozos.push(primeraParte(t.notas));
  if (t.distancia_km) trozos.push(`≈ ${Number(t.distancia_km).toLocaleString('es-ES')} km`);
  return trozos.join(' · ');
}

/** El chip no es un párrafo: de las notas se queda con lo primero. */
function primeraParte(notas) {
  const limpio = String(notas).replace(/\s+/g, ' ').trim();
  const corte = limpio.split(/[,.;]/)[0];
  return corte.length > 3 && corte.length < 40 ? corte : limpio.slice(0, 38);
}

/**
 * =============================================================================
 * LOS FILTROS DE UN TRAMO
 * =============================================================================
 * Antes los filtros de vuelo eran del VIAJE entero, y eso obligaba a querer lo
 * mismo a la ida que a la vuelta. Pero no es asi: puedo querer salir directo y
 * por la mañana para llegar con el dia por delante, y darme igual como vuelvo
 * con tal de que sea barato.
 *
 * Asi que cada tramo guarda LOS SUYOS. Mientras no los tenga, hereda los del
 * viaje: lo que ya estaba buscado sigue viendose igual, y el primer panel que
 * se abre en un tramo aparece con lo que ya habia puesto en vez de en blanco.
 */
export function filtrosVuelosDeTramo(tramo) {
  if (!tramo) return normalizarFiltrosVuelos(null);

  // Los suyos, si los tiene.
  if (tramo.filtros_vuelos) return normalizarFiltrosVuelos(tramo.filtros_vuelos);

  // Si no, los del viaje: es lo que estaba usando hasta ahora.
  const viaje = una('SELECT filtros_vuelos FROM viajes WHERE id = ?', tramo.viaje_id);
  return normalizarFiltrosVuelos(viaje?.filtros_vuelos);
}

/** Guarda los filtros de ESTE tramo. No tocan a los del viaje ni a los de al lado. */
export function guardarFiltrosVuelosTramo(tramoId, filtros) {
  const limpios = normalizarFiltrosVuelos(filtros);
  ejecutar(
    'UPDATE transportes SET filtros_vuelos = ? WHERE id = ?',
    JSON.stringify(limpios),
    Number(tramoId)
  );
  return limpios;
}

/**
 * Los vuelos encontrados para un tramo, listos para la tarjeta rica.
 *
 * `datos_extra` viene desempaquetado porque la tarjeta lo necesita entero: los
 * horarios de cada trayecto, los aeropuertos, las escalas. Eso es lo que se
 * estaba perdiendo al pintar la lista desde el JS: el dato SIEMPRE estuvo ahí,
 * solo que la lista pelada no lo enseñaba.
 */
export function vuelosDeTramo(tramoId, { orden = 'precio' } = {}) {
  const tramo = una('SELECT * FROM transportes WHERE id = ?', tramoId);
  if (!tramo) return { estado: 'sin_datos', vuelos: [], mensaje_error: null };

  const vuelos = todas(
    `SELECT * FROM candidatos
      WHERE transporte_id = ? AND tipo = 'vuelo' AND origen_datos = 'kayak'`,
    tramoId
  ).map((c) => ({
    ...c,
    marcado: Boolean(c.marcado),
    extra: c.datos_extra ? JSON.parse(c.datos_extra) : {},
  }));

  // Los filtros de ESTE tramo (que mientras no tenga propios son los del
  // viaje). Unos viajan a Kayak en la URL cuando se busca —escalas, duración—
  // y otros se aplican aquí, sobre lo ya guardado: el precio por persona y la
  // franja horaria de salida. Se notan al momento, sin volver a buscar.
  const viaje = una('SELECT * FROM viajes WHERE id = ?', tramo.viaje_id);
  const filtros = filtrosVuelosDeTramo(tramo);
  const visibles = aplicarFiltrosLocalesVuelos(vuelos, filtros, viaje);
  const ocultosPorFiltros = vuelos.length - visibles.length;

  // Mismo criterio de orden que el paso 5: por precio o por lo que dura el
  // viaje entero. Los que no tienen el dato van al final, no arriba del todo.
  const ordenadas = [...visibles].sort((a, b) =>
    orden === 'duracion'
      ? (a.extra.minutosTotales ?? Infinity) - (b.extra.minutosTotales ?? Infinity)
      : (a.precio ?? Infinity) - (b.precio ?? Infinity)
  );

  const activo = trabajoActivo(tramo.viaje_id, 'vuelos', tramoId);
  const ultimo = ultimoTrabajo(tramo.viaje_id, 'vuelos', tramoId);

  return {
    // Ojo: "hecho" mira los guardados, no los visibles. Si hay resultados pero
    // los filtros los esconden todos, eso NO es "no hay nada buscado": es un
    // filtro demasiado apretado, y hay que decirlo con esas palabras.
    estado: activo ? 'buscando'
      : vuelos.length ? 'hecho'
      : ultimo?.estado === 'error' ? 'error'
      : 'sin_datos',
    ocultosPorFiltros,
    resumenFiltros: resumenFiltrosVuelos(filtros),
    mensaje_error: !activo && ultimo?.estado === 'error' ? ultimo.mensaje_error : null,
    vuelos: ordenadas,
    // Insignias, con el mismo criterio del paso 5.
    idBarata: idDeMenor(ordenadas, (v) => v.precio),
    idRapida: idDeMenor(ordenadas, (v) => v.extra.minutosTotales),
  };
}

/** El id del que tenga el valor más bajo, ignorando los que no lo tengan. */
function idDeMenor(lista, sacar) {
  const con = lista.filter((x) => sacar(x) != null);
  if (!con.length) return null;
  return con.reduce((a, b) => (sacar(b) < sacar(a) ? b : a)).id;
}

/**
 * Calcula (y guarda) la distancia de un tramo si todavía no la tiene.
 *
 * Se cachea en la propia fila. Solo se recalcula si el tramo cambia de puntas,
 * y eso ya lo detecta `recalcularRuta()`: al reordenar borra las filas que
 * dejan de existir, y las nuevas nacen sin distancia.
 */
export async function asegurarDistancia(tramoId) {
  const t = una('SELECT * FROM transportes WHERE id = ?', tramoId);
  if (!t) return null;
  if (t.distancia_km != null) return t;   // ya la teníamos

  const a = t.etapa_origen_id ? coordenadasDeEtapa(t.etapa_origen_id) : coordenadasDeCasa();
  const b = t.etapa_destino_id ? coordenadasDeEtapa(t.etapa_destino_id) : coordenadasDeCasa();
  if (!a || !b) return t;   // sin coordenadas no hay nada que calcular

  const ref = await referenciaDeTramo(a, b);
  if (!ref) return t;

  ejecutar(
    'UPDATE transportes SET distancia_km = ?, duracion_min = ?, fuente_distancia = ? WHERE id = ?',
    ref.km,
    ref.minutos,
    ref.fuente,
    tramoId
  );
  return una('SELECT * FROM transportes WHERE id = ?', tramoId);
}

/** Resuelve un tramo a mano: tipo, notas y, si se sabe, cuánto cuesta. */
export function guardarTransporteManual(tramoId, { tipo, notas, precio }) {
  const t = una('SELECT * FROM transportes WHERE id = ?', tramoId);
  if (!t) return null;

  const tipoLimpio = TIPOS_TRANSPORTE.some((x) => x.valor === tipo) ? tipo : t.tipo;
  const notasLimpias = String(notas ?? '').trim().slice(0, 500) || null;
  const precioLimpio = Number.isFinite(Number(precio)) && Number(precio) > 0 ? Number(precio) : null;

  ejecutar(
    'UPDATE transportes SET tipo = ?, notas = ?, precio_estimado = ? WHERE id = ?',
    tipoLimpio,
    notasLimpias,
    precioLimpio,
    tramoId
  );
  return una('SELECT * FROM transportes WHERE id = ?', tramoId);
}

/** Deshace lo apuntado a mano y deja el tramo otra vez pendiente. */
export function olvidarTransporteManual(tramoId) {
  ejecutar('UPDATE transportes SET notas = NULL, precio_estimado = NULL WHERE id = ?', tramoId);
  return una('SELECT * FROM transportes WHERE id = ?', tramoId);
}

// =============================================================================
// NOTAS DE LA ETAPA
// =============================================================================
/** Guarda las notas. Se llama desde el autoguardado, así que no devuelve nada. */
export function guardarNotas(etapaId, notas) {
  ejecutar(
    'UPDATE etapas SET notas = ? WHERE id = ?',
    String(notas ?? '').slice(0, 4000) || null,
    etapaId
  );
}

export { comoDuracion };

// =============================================================================
// PREPARAR UNA PARADA
// -----------------------------------------------------------------------------
// Una etapa no se abre vacía esperando a que alguien pulse algo. Al entrar en
// Sevilla lo que se quiere es Sevilla: sus sitios y sus excursiones, ya puestos.
//
// Las dos búsquedas van en UN trabajo ('preparar_etapa') y no en dos, porque lo
// que se pregunta es una sola cosa —"¿puedo entrar ya?"— y con dos habría que
// sondear dos estados y decidir en la pantalla cuándo están los dos.
// =============================================================================

/**
 * La parada de un destino de nivel CIUDAD, creándola si no está.
 *
 * Un viaje a Sevilla tiene UNA parada, que es Sevilla. `sincronizarEtapaUnica`
 * ya la crea y la mantiene al día con el destino del viaje; lo que le faltaba
 * es el enlace al catálogo (`destino_id`), que es lo que hace que la pestaña
 * "Qué ver" sepa de dónde sacar los sitios.
 */
export function asegurarEtapaDeCiudad(viajeId, destino) {
  // ¿Ya hay parada(s) de este destino? Puede haber MÁS DE UNA: clonar una etapa
  // repite la ciudad a propósito (Sarajevo → Mostar → Sarajevo). Se devuelven
  // todas para que quien llame decida; aquí no se elige por nadie.
  const suyas = todas(
    'SELECT * FROM etapas WHERE viaje_id = ? AND destino_id = ? ORDER BY orden, id',
    viajeId,
    destino.id
  );
  if (suyas.length) return { etapa: suyas[0], cuantas: suyas.length, nueva: false };

  const existentes = todas('SELECT id FROM etapas WHERE viaje_id = ?', viajeId);

  // Viaje sin ruta todavía: su parada única ES esta ciudad.
  if (!existentes.length) {
    const etapa = sincronizarEtapaUnica(viajeId);
    if (!etapa) return null;
    ejecutar('UPDATE etapas SET destino_id = ? WHERE id = ?', destino.id, etapa.id);
    return { etapa: una('SELECT * FROM etapas WHERE id = ?', etapa.id), cuantas: 1, nueva: true };
  }

  // LA PARADA SIN ENGANCHAR QUE ACABA DE NACER.
  //
  // `sincronizarEtapaUnica` crea una parada con el nombre del destino del viaje
  // y sin `destino_id` —todavía no sabe a qué fila del catálogo apunta—, y se
  // ejecuta justo antes que esto. Si no se adoptara aquí, el viaje acabaría con
  // dos "Sarajevo" desde el primer clic: la de ella y la que crearíamos abajo.
  const suelta = una(
    'SELECT * FROM etapas WHERE viaje_id = ? AND destino_id IS NULL AND nombre_ciudad = ? ORDER BY orden, id LIMIT 1',
    viajeId,
    destino.nombre
  );
  if (suelta) {
    ejecutar('UPDATE etapas SET destino_id = ? WHERE id = ?', destino.id, suelta.id);
    return { etapa: una('SELECT * FROM etapas WHERE id = ?', suelta.id), cuantas: 1, nueva: false };
  }

  // El viaje YA tiene ruta y esta ciudad no está en ella: se añade al final.
  //
  // Antes esto reapuntaba la primera parada al destino nuevo, que es de las
  // cosas que peor sientan: entras al mapa a añadir una ciudad y te cambia la
  // que ya tenías. Ahora la ruta que hay no se toca.
  const ultimo = una(
    "SELECT MAX(orden) AS n FROM etapas WHERE viaje_id = ? AND estado = 'confirmada'",
    viajeId
  );
  const r = ejecutar(
    `INSERT INTO etapas (viaje_id, destino_id, nombre_ciudad, orden, noches, estado)
     VALUES (?, ?, ?, ?, 1, 'confirmada')`,
    viajeId,
    destino.id,
    destino.nombre,
    (ultimo?.n ?? 0) + 1
  );
  // El recálculo de la ruta (fechas y tramos) lo hace quien llama: importarlo
  // aquí cerraría un ciclo entre este servicio y el de la ruta, que ya usa
  // `resumenDeTramo` de aquí.
  return { etapa: una('SELECT * FROM etapas WHERE id = ?', Number(r.lastInsertRowid)), cuantas: 1, nueva: true };
}

/**
 * Qué sabe ya el catálogo de esta parada.
 *
 * Se cuenta lo que hay, no lo que se pidió: es la única forma de saber si una
 * etapa está lista mire quien la mire, porque el catálogo lo puede haber
 * llenado otro viaje.
 */
export function loQueSabemosDe(etapa) {
  const destino = etapa.destino_id
    ? una('SELECT * FROM destinos WHERE id = ?', etapa.destino_id)
    : null;
  const punto = etapa.punto_interes_id
    ? una('SELECT * FROM puntos_interes WHERE id = ?', etapa.punto_interes_id)
    : null;

  // Los sitios salen de una de las dos fuentes, según de dónde venga la parada.
  const sitios =
    (destino?.tipo === 'ciudad'
      ? una('SELECT COUNT(*) AS n FROM puntos_interes WHERE destino_id = ?', destino.id)?.n
      : 0) +
    (punto
      ? una('SELECT COUNT(*) AS n FROM sitios_lugar WHERE punto_interes_id = ?', punto.id)?.n
      : 0);

  const excursiones = estadoCacheCiudad(etapa.nombre_ciudad).total;

  return { destino, punto, sitios, excursiones };
}

/**
 * Estado de la preparación de una parada, para el sondeo.
 *
 * Las fases se deducen de lo que hay en la base, no de un campo en el trabajo:
 * primero aparecen los sitios y después las excursiones, que es el orden en que
 * los busca el worker.
 */
export function estadoPreparacionEtapa(etapaId) {
  const etapa = una('SELECT * FROM etapas WHERE id = ?', etapaId);
  if (!etapa) return null;

  const { sitios, excursiones } = loQueSabemosDe(etapa);
  const activo = trabajoActivo(etapa.viaje_id, 'preparar_etapa', etapaId);
  const ultimo = ultimoTrabajo(etapa.viaje_id, 'preparar_etapa', etapaId);

  return {
    etapaId: etapa.id,
    ciudad: etapa.nombre_ciudad,
    sitios,
    excursiones,
    trabajando: Boolean(activo),
    // Qué se está haciendo AHORA, para poder decirlo con palabras.
    fase: !activo ? null : sitios ? 'excursiones' : 'sitios',
    mensaje: !activo
      ? null
      : sitios
        ? `Buscando excursiones en ${etapa.nombre_ciudad}…`
        : `Buscando los sitios más bonitos de ${etapa.nombre_ciudad}…`,
    // "Lista" es que hay ALGO que enseñar, o que ya se intentó y no hay más que
    // rascar. Una ciudad sin excursiones en Civitatis es una ciudad lista.
    listo: !activo && (sitios > 0 || excursiones > 0 || Boolean(ultimo)),
    mensaje_error: !activo && ultimo?.estado === 'error' ? ultimo.mensaje_error : null,
  };
}

/**
 * Pide la preparación de una parada si hace falta.
 *
 * NO se reintenta sola después de un fallo. Sin esa condición, una ciudad que
 * falla (por ejemplo, sin clave de IA en el .env) se vuelve a encolar en CADA
 * visita: un bucle silencioso de trabajos condenados. Para reintentar está el
 * botón.
 */
export function prepararEtapa(etapaId, { forzar = false } = {}) {
  const etapa = una('SELECT * FROM etapas WHERE id = ?', etapaId);
  if (!etapa) return null;

  const { sitios, excursiones } = loQueSabemosDe(etapa);
  const activo = trabajoActivo(etapa.viaje_id, 'preparar_etapa', etapaId);
  const ultimo = ultimoTrabajo(etapa.viaje_id, 'preparar_etapa', etapaId);

  const yaEsta = sitios > 0 && excursiones > 0;
  const hayQuePedirla = forzar || (!activo && !yaEsta && (!ultimo || forzar));

  if (hayQuePedirla && !activo) {
    encolar(etapa.viaje_id, 'preparar_etapa', etapaId);
    console.log(`[etapa] «${etapa.nombre_ciudad}» a la cola: sitios ${sitios}, excursiones ${excursiones}.`);
  }

  return estadoPreparacionEtapa(etapaId);
}
