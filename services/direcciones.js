/**
 * services/direcciones.js
 * -----------------------------------------------------------------------------
 * Dónde está cada cosa del viaje.
 *
 * EL USUARIO PIENSA EN DIRECCIONES Y EN NOMBRES, NUNCA EN COORDENADAS. Escribe
 * "Zelenih beretki 12" o "Estación de autobuses", y eso es lo que se guarda y lo
 * único que se le enseña. Las coordenadas se buscan por detrás, se guardan al
 * lado y no aparecen en ninguna pantalla: son el combustible del cálculo, no un
 * dato del viaje.
 *
 * SE GEOCODIFICA EN SEGUNDO PLANO. Guardar una dirección no puede quedarse
 * esperando a que conteste un servicio de fuera: se guarda al instante, se
 * encola el trabajo y la ficha dice "buscando…". Si no se encuentra, se avisa
 * con suavidad y se deja editar; nunca se rechaza lo que ha escrito la persona.
 *
 * DOS FUENTES, EN ESTE ORDEN
 *
 *   1. Google Geocoding, con la clave de servidor.
 *   2. Nominatim, que no pide clave y siempre está.
 *
 * En local Google falla siempre —su clave está restringida a la IP del
 * servidor— y esto es exactamente lo previsto: se desarrolla contra Nominatim.
 * El log dice en cada caso cuál contestó.
 */

import { todas, una, ejecutar, normalizarNombre } from '../db/index.js';
import { encolar, trabajoActivo } from '../jobs/cola.js';
import { geocodificarConGoogle, googleDisponible } from '../lib/google.js';
import { geocodificarDireccion } from './geocodificar.js';

/**
 * De qué puede tener dirección algo, y en qué tabla vive su id.
 *
 * El alcance sale del tipo: 'hotel' es un candidato y por tanto del VIAJE; los
 * demás son filas de catálogo y por tanto valen para todos los viajes. La
 * dirección del Prado no cambia de un año a otro.
 */
export const TIPOS_CON_DIRECCION = {
  hotel: { tabla: 'candidatos', campoNombre: 'titulo', etiqueta: 'Alojamiento', icono: 'ti-bed' },
  punto: { tabla: 'puntos_interes', campoNombre: 'nombre', etiqueta: 'Sitio', icono: 'ti-map-pin' },
  sitio: { tabla: 'sitios_lugar', campoNombre: 'nombre', etiqueta: 'Sitio', icono: 'ti-map-pin' },
  actividad: {
    tabla: 'catalogo_actividades',
    campoNombre: 'titulo',
    etiqueta: 'Excursión',
    icono: 'ti-ticket',
  },
  movilidad: {
    tabla: 'catalogo_movilidad',
    campoNombre: 'nombre',
    etiqueta: 'Transporte',
    icono: 'ti-bus',
  },
  comer: {
    tabla: 'catalogo_comer',
    campoNombre: 'nombre',
    etiqueta: 'Comer',
    icono: 'ti-tools-kitchen-2',
  },
};

const tipoValido = (t) => Object.hasOwn(TIPOS_CON_DIRECCION, t);
const texto = (v) => {
  const t = String(v ?? '').trim();
  return t || null;
};

// =============================================================================
// LEER
// =============================================================================
/** La dirección de un elemento, o null si nunca se le puso ninguna. */
export function direccionDe(tipo, elementoId) {
  if (!tipoValido(tipo)) return null;
  const d = una(
    'SELECT * FROM direcciones WHERE tipo_elemento = ? AND elemento_id = ?',
    tipo,
    Number(elementoId)
  );
  return d ? conCara(d) : null;
}

/**
 * Las direcciones de un montón de elementos del mismo tipo, de una vez.
 *
 * Una consulta por ficha serían veinte consultas para pintar una pestaña, que
 * es el mismo motivo por el que los adjuntos se piden así.
 */
export function direccionesDe(tipo, ids) {
  const lista = [...new Set((ids ?? []).map(Number).filter(Boolean))];
  if (!tipoValido(tipo) || !lista.length) return new Map();

  return new Map(
    todas(
      `SELECT * FROM direcciones
        WHERE tipo_elemento = ? AND elemento_id IN (${lista.map(() => '?').join(',')})`,
      tipo,
      ...lista
    ).map((d) => [d.elemento_id, conCara(d)])
  );
}

/**
 * Lo que la pantalla necesita saber de una dirección, ya masticado.
 *
 * `punto` es lo único que sale de aquí con coordenadas, y es para el cálculo:
 * no se pinta. Lo que se enseña es `direccion` y, como mucho, si se está
 * buscando o si no se encontró.
 */
function conCara(d) {
  return {
    id: d.id,
    tipo: d.tipo_elemento,
    elementoId: d.elemento_id,
    direccion: d.direccion,
    estado: d.estado,
    fuente: d.fuente,
    mensaje: d.mensaje,
    buscando: d.estado === 'buscando' || d.estado === 'pendiente',
    // Solo hay punto cuando de verdad se encontró.
    situada: d.estado === 'ok' && d.lat != null && d.lng != null,
    punto: d.lat != null && d.lng != null ? { lat: d.lat, lng: d.lng } : null,
  };
}

// =============================================================================
// ESCRIBIR
// =============================================================================
/**
 * Guarda (o cambia) la dirección de un elemento y deja el trabajo encolado.
 *
 * Guardar es INSTANTÁNEO: la persona escribe, pulsa y ya está. La búsqueda de
 * las coordenadas va detrás, en la cola, y la ficha lo cuenta mientras tanto.
 *
 * Cambiar el texto vuelve a poner el estado en 'pendiente' y borra el punto
 * viejo: unas coordenadas de la dirección anterior son peores que ninguna,
 * porque el cálculo saldría con toda naturalidad desde el sitio equivocado.
 */
export function guardarDireccion(tipo, elementoId, direccionTexto, { viajeId = null } = {}) {
  if (!tipoValido(tipo)) return null;

  const id = Number(elementoId);
  const nueva = texto(direccionTexto);
  const antes = una(
    'SELECT * FROM direcciones WHERE tipo_elemento = ? AND elemento_id = ?',
    tipo,
    id
  );

  // Vaciar el campo es borrar la dirección, no guardar una vacía.
  if (!nueva) {
    if (antes) ejecutar('DELETE FROM direcciones WHERE id = ?', antes.id);
    return null;
  }

  if (antes && antes.direccion === nueva) return conCara(antes);   // sin cambios

  if (antes) {
    ejecutar(
      `UPDATE direcciones
          SET direccion = ?, lat = NULL, lng = NULL, estado = 'pendiente',
              fuente = NULL, mensaje = NULL, buscada_en = NULL,
              actualizado_en = datetime('now')
        WHERE id = ?`,
      nueva.slice(0, 400),
      antes.id
    );
  } else {
    ejecutar(
      `INSERT INTO direcciones (tipo_elemento, elemento_id, direccion, estado)
       VALUES (?, ?, ?, 'pendiente')`,
      tipo,
      id,
      nueva.slice(0, 400)
    );
  }

  pedirGeocodificar(tipo, id, { viajeId });
  return direccionDe(tipo, id);
}

/** Encola la búsqueda de las coordenadas, si no hay ya una en marcha. */
export function pedirGeocodificar(tipo, elementoId, { viajeId = null } = {}) {
  const d = una(
    'SELECT * FROM direcciones WHERE tipo_elemento = ? AND elemento_id = ?',
    tipo,
    Number(elementoId)
  );
  if (!d) return null;

  // La cola es por viaje. Una dirección de catálogo no tiene viaje propio, así
  // que se cuelga del que la está pidiendo; si no se sabe, del primero que haya.
  const viaje =
    Number(viajeId) || una('SELECT id FROM viajes ORDER BY id LIMIT 1')?.id || null;
  if (!viaje) return null;

  if (trabajoActivo(viaje, 'geocodificar', d.id)) return { encolado: false };
  encolar(viaje, 'geocodificar', d.id);
  return { encolado: true };
}

/**
 * Busca de verdad las coordenadas de una dirección. Lo llama el worker.
 *
 * `cerca` es la ciudad de la parada desde la que se guardó, y es lo que
 * convierte "Calle Mayor 3" en algo buscable.
 */
export async function geocodificarFila(direccionId, { cerca = null } = {}) {
  const d = una('SELECT * FROM direcciones WHERE id = ?', Number(direccionId));
  if (!d) return null;

  ejecutar(
    "UPDATE direcciones SET estado = 'buscando', actualizado_en = datetime('now') WHERE id = ?",
    d.id
  );

  // DOS FORMAS DE LA MISMA DIRECCIÓN, y la segunda solo si la primera falla.
  //
  // Un punto de encuentro de Civitatis viene así: "Plaza de Oriente (junto a la
  // estatua ecuestre de Felipe IV)". El paréntesis es una indicación para la
  // persona —dónde exactamente esperar— y para un geocodificador es ruido que
  // le hace no encontrar nada. Quitándolo queda "Plaza de Oriente", que sí
  // existe.
  //
  // Se prueba entera primero porque a veces el paréntesis es parte del nombre
  // de verdad, y porque lo que la persona escribió merece el primer intento.
  const formas = [d.direccion, sinParentesis(d.direccion), sinLoDeEnMedio(d.direccion)].filter(
    (t, i, todas) => t && todas.indexOf(t) === i
  );

  let hallado = null;
  for (const forma of formas) {
    try {
      hallado = await geocodificarConGoogle(forma, { cerca });
    } catch (err) {
      console.warn('[direcciones] Google falló:', err.message);
    }

    // Plan B. Se intenta SIEMPRE que Google no haya dado nada, tanto si es que
    // no está disponible como si es que no encontró la dirección: son dos
    // buscadores distintos y uno puede saber lo que el otro no.
    if (!hallado) {
      try {
        hallado = await geocodificarDireccion(forma, { cerca });
      } catch (err) {
        console.warn('[direcciones] Nominatim falló:', err.message);
      }
    }

    if (hallado) {
      if (forma !== d.direccion) {
        console.log(`[direcciones] encontrada al simplificar: «${d.direccion}» → «${forma}»`);
      }
      break;
    }
  }

  if (!hallado) {
    ejecutar(
      `UPDATE direcciones
          SET estado = 'sin_resultado', mensaje = ?, buscada_en = datetime('now'),
              actualizado_en = datetime('now')
        WHERE id = ?`,
      'No se ha encontrado esa dirección. Puedes afinarla y volver a guardar.',
      d.id
    );
    console.log(`[direcciones] sin resultado: «${d.direccion}»`);
    return direccionDe(d.tipo_elemento, d.elemento_id);
  }

  ejecutar(
    `UPDATE direcciones
        SET lat = ?, lng = ?, estado = 'ok', fuente = ?, mensaje = NULL,
            buscada_en = datetime('now'), actualizado_en = datetime('now')
      WHERE id = ?`,
    hallado.lat,
    hallado.lng,
    hallado.fuente,
    d.id
  );
  console.log(`[direcciones] situada con ${hallado.fuente}: «${d.direccion}»`);
  return direccionDe(d.tipo_elemento, d.elemento_id);
}

/**
 * "Hotel Tal, Centro de Ámsterdam, Ámsterdam" -> "Hotel Tal, Ámsterdam".
 *
 * El tercer intento, y el que salva los hoteles. Booking da el barrio con la
 * ciudad detrás, así que la dirección volcada queda con tres partes y el
 * buscador no encuentra nada: la de en medio no es una calle, es una zona
 * comercial ("Centro de Ámsterdam") que no está en ningún callejero.
 *
 * Quitándola queda el nombre y la ciudad, y ESO sí lo encuentra: los hoteles
 * están en el mapa por su nombre.
 *
 * Solo se prueba si los dos intentos anteriores han fallado, y solo cuando hay
 * tres partes o más: con dos no hay nada que quitar.
 */
function sinLoDeEnMedio(texto) {
  const partes = String(texto ?? '')
    .split(',')
    .map((t) => t.trim())
    .filter(Boolean);
  if (partes.length < 3) return null;
  return `${partes[0]}, ${partes[partes.length - 1]}`;
}

/**
 * "Plaza de Oriente (junto a la estatua de Felipe IV)." -> "Plaza de Oriente".
 *
 * Se queda con lo de fuera del paréntesis y con la primera frase. Lo que se
 * quita es la indicación de dónde esperar, que le sirve a una persona y le
 * estorba a un buscador de direcciones.
 */
function sinParentesis(texto) {
  const limpio = String(texto ?? '')
    .replace(/\([^)]*\)?/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .replace(/[.,;]+$/, '')
    .trim();
  return limpio || null;
}

// =============================================================================
// DE UN CANDIDATO A SU DIRECCIÓN
// =============================================================================
/**
 * La dirección de algo apuntado en el viaje.
 *
 * Un candidato de tipo 'sitio' o 'actividad' es una COPIA de una fila del
 * catálogo, y `datos_extra` guarda de cuál: `{ de: 'punto'|'sitio'|'actividad',
 * deId }`. La dirección vive con el original, no con la copia, y por eso hay que
 * dar este salto: así el Prado tiene UNA dirección aunque esté apuntado en tres
 * viajes.
 *
 * El hotel es la excepción, y con razón: no sale de ningún catálogo, es una
 * reserva de este viaje. Su dirección va con él.
 */
export function claveDeCandidato(candidato) {
  if (!candidato) return null;
  if (candidato.tipo === 'hotel') return { tipo: 'hotel', id: candidato.id };

  try {
    const extra = candidato.datos_extra ? JSON.parse(candidato.datos_extra) : null;
    if (extra?.de && extra?.deId && tipoValido(extra.de)) {
      return { tipo: extra.de, id: Number(extra.deId) };
    }
  } catch {
    /* datos_extra corrupto: se sigue sin dirección, no se cae la pantalla */
  }
  return null;
}

/**
 * VUELCA LA DIRECCIÓN DE UN HOTEL AL ELEGIRLO.
 *
 * Vivía en routes/viajes.js y solo la llamaba UNA de las dos formas de elegir
 * hotel —la del paso 6—. Desde la pantalla de etapa, que es por donde se elige
 * de verdad, no pasaba nadie: el candidato tenía la dirección de Booking
 * delante y al marcarlo se quedaba sin ella, así que luego había que teclearla
 * a mano para cualquier traslado.
 *
 * Aquí abajo la ven las dos, que es lo suyo.
 *
 * No pisa nada. Si la ficha ya tenía dirección —puesta a mano o de antes— se
 * deja como está: corregir algo y que te lo vuelvan a cambiar es de las cosas
 * que más molestan.
 */
export function volcarDireccionDeHotel(candidato, { nombreCiudad = null } = {}) {
  if (!candidato || candidato.tipo !== 'hotel') return null;
  if (direccionDe('hotel', candidato.id)) return null;

  let extra = {};
  try {
    extra = candidato.datos_extra ? JSON.parse(candidato.datos_extra) ?? {} : {};
  } catch { /* datos_extra corrupto: se sigue con lo que haya */ }

  const ciudad =
    nombreCiudad ??
    una('SELECT nombre_ciudad FROM etapas WHERE id = ?', candidato.etapa_id)?.nombre_ciudad;

  // La calle primero y la zona de reserva: Booking da la calle cuando la tiene
  // y el barrio cuando no. Una zona sitúa peor que una calle, pero sitúa.
  const donde = String(extra.direccion ?? extra.zona ?? '').trim();
  const nombre = String(candidato.titulo ?? '').trim();
  const ciudadTexto = String(ciudad ?? '').trim();

  // La ciudad solo se añade si no está ya dentro. Booking suele dar el barrio
  // CON la ciudad detrás ("Centro de Ámsterdam, Ámsterdam"), y pegándosela otra
  // vez salía "…, Ámsterdam, Ámsterdam, Ámsterdam", que además de feo confunde
  // al geocodificador.
  const yaDiceLaCiudad =
    ciudadTexto && donde.toLowerCase().includes(ciudadTexto.toLowerCase());

  const texto = [nombre, donde, yaDiceLaCiudad ? null : ciudadTexto]
    .map((t) => String(t ?? '').trim())
    .filter(Boolean)
    .join(', ');
  if (!texto) return null;

  guardarDireccion('hotel', candidato.id, texto, { viajeId: candidato.viaje_id });
  console.log(
    `[direcciones] Hotel «${candidato.titulo}»: dirección de Booking → «${texto}»` +
      `${extra.direccion ? '' : ' (de la zona, que es lo que había)'}.`
  );
  return texto;
}

/** La dirección de un candidato, saltando a su fila de catálogo si hace falta. */
export function direccionDeCandidato(candidato) {
  const clave = claveDeCandidato(candidato);
  return clave ? direccionDe(clave.tipo, clave.id) : null;
}

// =============================================================================
// LOS LUGARES DE UNA ETAPA
// =============================================================================
/**
 * Todo lo que hay en esta parada y a lo que se puede ir: el hotel elegido, lo
 * apuntado y las fichas de transporte urbano.
 *
 * Es lo que alimenta el autocompletado de los dos campos del buscador de
 * traslados. Van TODOS, tengan dirección o no: los que no la tienen salen
 * marcados y no se pueden elegir, porque decir "este sitio no lo tienes situado"
 * es más útil que esconderlo y dejar a la persona buscándolo en una lista donde
 * no está.
 */
export function lugaresDeEtapa(etapaId) {
  const etapa = una('SELECT * FROM etapas WHERE id = ?', Number(etapaId));
  if (!etapa) return [];

  const lugares = [];

  // --- El hotel elegido ---------------------------------------------------
  const hotel = una(
    "SELECT * FROM candidatos WHERE etapa_id = ? AND tipo = 'hotel' AND marcado = 1",
    etapa.id
  );
  if (hotel) {
    lugares.push(armar('hotel', hotel.id, hotel.titulo, 'Alojamiento', 'ti-bed'));
  }

  // --- Lo apuntado (sitios y excursiones) ---------------------------------
  // Se salta a su fila de catálogo, que es donde vive la dirección.
  const apuntados = todas(
    "SELECT * FROM candidatos WHERE etapa_id = ? AND tipo IN ('sitio','actividad') ORDER BY tipo, id",
    etapa.id
  );
  for (const c of apuntados) {
    const clave = claveDeCandidato(c);
    if (!clave) continue;
    const def = TIPOS_CON_DIRECCION[clave.tipo];
    lugares.push(armar(clave.tipo, clave.id, c.titulo, def.etiqueta, def.icono));
  }

  // --- Dónde comer --------------------------------------------------------
  // Un restaurante es un sitio al que se va como cualquier otro, así que tiene
  // que poder ser un extremo de un traslado. Van los de la ciudad, no solo los
  // apuntados: para decidir si me lo apunto quiero saber a cuánto está.
  for (const c of todas(
    'SELECT * FROM catalogo_comer WHERE ciudad_norm = ? ORDER BY id',
    normalizarNombre(etapa.nombre_ciudad)
  )) {
    lugares.push(armar('comer', c.id, c.nombre, 'Comer', 'ti-tools-kitchen-2'));
  }

  // --- El transporte urbano de la ciudad ----------------------------------
  // La parada del funicular o la oficina de los taxis son sitios a los que se
  // va, y tienen dirección desde la pestaña "Moverse".
  for (const m of todas(
    'SELECT * FROM catalogo_movilidad WHERE ciudad_norm = ? ORDER BY orden, id',
    normalizarNombre(etapa.nombre_ciudad)
  )) {
    lugares.push(armar('movilidad', m.id, m.nombre, 'Transporte', 'ti-bus'));
  }

  return lugares;
}

function armar(tipo, id, nombre, etiqueta, icono) {
  const d = direccionDe(tipo, id);
  return {
    tipo,
    id,
    nombre,
    etiqueta,
    icono,
    direccion: d?.direccion ?? null,
    situada: Boolean(d?.situada),
    buscando: Boolean(d?.buscando),
    // El punto no sale hacia la vista: lo quita `paraLaVista()`. Aquí está
    // porque el cálculo de un traslado lo necesita.
    punto: d?.punto ?? null,
  };
}

/**
 * La misma lista, pero sin coordenadas. Lo que se le manda al navegador.
 *
 * Es una función aparte y no un `delete` suelto a propósito: que el borrado de
 * las coordenadas esté en UN sitio es lo que hace fácil no olvidárselo.
 */
export function paraLaVista(lugares) {
  return lugares.map(({ punto, ...resto }) => resto);
}

/** Para el aviso de arranque: ¿está Google en juego o vamos con el plan B? */
export function fuenteQueSeUsara() {
  return googleDisponible() ? 'google' : 'nominatim';
}
