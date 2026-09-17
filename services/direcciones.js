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
 *   2. (Ya no hay segunda: el respaldo tapaba las averías en vez de contarlas.)
 *
 * En local Google falla siempre —su clave está restringida a la IP del
 * servidor— y en local no se podrá situar nada. La pantalla lo dice y ya está.
 * El log dice en cada caso cuál contestó.
 */

import { todas, una, ejecutar, normalizarNombre } from '../db/index.js';
import { encolar, trabajoActivo } from '../jobs/cola.js';
import {
  geocodificarConGoogle,
  googleDisponible,
  contadorDeAverias,
  situarLugarConGoogle,
  pareceUnSitio,
} from '../lib/google.js';
import { distanciaKm } from './distancias.js';
import { parametro } from './orquestador.js';

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
    // AVERÍA, que no es lo mismo que "no existe". Si Google no contestó, no hay
    // nada que afinar en la dirección y decir "sin localizar" manda a corregir
    // algo que está bien.
    fallo: d.estado === 'error',
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
 *
 * `encolar: false` es para quien YA TIENE la respuesta y solo viene a dejar el
 * texto. Places devuelve dirección y coordenadas de una vez; si aun así se
 * encolara la búsqueda, el worker llegaría minutos después, preguntaría por esa
 * dirección pegándole el nombre de la ciudad y escribiría el centroide encima
 * del acierto. Eso es lo que juntó a Epidauro, Micenas, Bourtzi y la mezquita
 * de Voivode en un solo pin en mitad de Nauplia: no falló la búsqueda, falló
 * que se buscara algo que no hacía falta buscar.
 */
export function guardarDireccion(
  tipo,
  elementoId,
  direccionTexto,
  { viajeId = null, encolar: pedirla = true } = {}
) {
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

  if (pedirla) pedirGeocodificar(tipo, id, { viajeId });
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

  // SOLO GOOGLE. Aquí había un plan B con Nominatim y se ha ido con él el
  // problema que traía: cuando Google no estaba, esto seguía situando cosas con
  // otro buscador y nadie se enteraba de que la clave llevaba semanas sin
  // funcionar. El respaldo tapaba la avería en vez de contarla.
  let hallado = null;
  // El contador de averías de Google, antes de empezar. Si crece durante la
  // búsqueda es que no se ha podido preguntar, y eso no es lo mismo que haber
  // preguntado y que no exista.
  const averiasAntes = contadorDeAverias();

  // UNA CIUDAD SOLO ES LA RESPUESTA CUANDO SE PREGUNTA POR UNA CIUDAD.
  //
  // `punto` es una parada del viaje —una fila de puntos_interes—, y ahí que
  // Google conteste con la localidad entera es justo lo que se le pedía. Para
  // todo lo demás (un sitio, un hotel, un restaurante, una excursión) recibir
  // la ciudad entera significa que no ha encontrado lo que se buscaba.
  const buscabaUnaCiudad = d.tipo_elemento === 'punto';

  // Lo que el guardián aparta, para poder contarlo en el mensaje. Rechazar en
  // silencio dejaría el mismo "no se ha encontrado" de siempre, y esto no es
  // eso: Google contestó, y contestó otra cosa.
  let devolvioLaCiudad = null;

  for (const forma of formas) {
    try {
      hallado = await geocodificarConGoogle(forma, { cerca });
    } catch (err) {
      console.warn('[direcciones] Google falló:', err.message);
    }

    // EL GUARDIÁN. `geocodificarConGoogle` viene devolviendo `tipos` y `parcial`
    // desde que se arreglaron los kilómetros inflados del viaje de Asia, y aquí
    // se tiraban los dos. Son exactamente la señal que distingue «el Teatro de
    // Epidauro» de «Nauplia», que es como cuatro sitios de Nafplio acabaron
    // compartiendo un pin en el centro de la ciudad.
    //
    // Se mira SOLO el tipo, no `parcial`. Google marca coincidencia parcial muy
    // a la ligera: la Iglesia Ortodoxa de Santa María Magdalena de Varsovia
    // vuelve con `parcial: true` y con la dirección correcta. Rechazar por ahí
    // tiraría aciertos. `parcial` se cuenta en el log y no decide.
    if (hallado && !buscabaUnaCiudad && !pareceUnSitio(hallado)) {
      devolvioLaCiudad = hallado;
      hallado = null;
      console.warn(
        `[direcciones] «${forma}» resolvió a «${devolvioLaCiudad.direccion}» ` +
          `(${(devolvioLaCiudad.tipos ?? []).join(', ')}` +
          `${devolvioLaCiudad.parcial ? ', coincidencia parcial' : ''}): ` +
          'eso es la ciudad entera, no el sitio. No lo doy por bueno.'
      );
    }

    if (hallado) {
      if (forma !== d.direccion) {
        console.log(`[direcciones] encontrada al simplificar: «${d.direccion}» → «${forma}»`);
      }
      break;
    }
  }

  if (!hallado) {
    // DOS FRACASOS DISTINTOS, Y DOS MENSAJES.
    //
    // "No existe esa dirección" se arregla escribiéndola mejor; "no he podido
    // preguntar" no se arregla tocando nada y hay que decirlo tal cual. Antes
    // los dos caían en el mismo saco y el mensaje mandaba a afinar una
    // dirección que estaba perfecta.
    //
    // Lo que NO puede pasar, pase lo que pase, es quedarse en 'buscando': eso
    // es la ruedecita eterna.
    // Y UN TERCERO, desde que hay guardián: Google sí encontró algo, pero lo
    // que encontró era la ciudad entera. Eso no se arregla escribiendo mejor la
    // dirección ni es una avería, así que merece su propio mensaje. Lo que no
    // merece, y es el motivo de todo esto, es quedarse guardado como un punto
    // bueno: un hueco honesto vale más que un pin que miente.
    const noSePudo = contadorDeAverias() > averiasAntes || !googleDisponible();
    const mensaje = devolvioLaCiudad
      ? `Google devuelve «${devolvioLaCiudad.direccion}», que es la ciudad entera y no este sitio. ` +
        'Lo dejo sin situar antes que ponerlo en el centro del pueblo.'
      : noSePudo
        ? 'No he podido situar esta dirección: Google no ha contestado.'
        : 'No se ha encontrado esa dirección. Puedes afinarla y volver a guardar.';

    // El punto viejo se borra SOLO cuando ha hablado el guardián. Si lo que ha
    // pasado es que Google no contestó, las coordenadas que ya hubiera son tan
    // buenas como esta mañana y tirarlas sería castigar una avería de red. Pero
    // si lo que hay guardado es un centroide, dejarlo ahí es dejar la mentira:
    // `estado` deja de ser 'ok', pero `punto` sigue saliendo y los traslados se
    // calculan igual desde el centro del pueblo.
    ejecutar(
      devolvioLaCiudad
        ? `UPDATE direcciones
              SET estado = 'sin_resultado', mensaje = ?, lat = NULL, lng = NULL, fuente = NULL,
                  buscada_en = datetime('now'), actualizado_en = datetime('now')
            WHERE id = ?`
        : `UPDATE direcciones
              SET estado = ?, mensaje = ?, buscada_en = datetime('now'),
                  actualizado_en = datetime('now')
            WHERE id = ?`,
      ...(devolvioLaCiudad
        ? [mensaje, d.id]
        : [noSePudo ? 'error' : 'sin_resultado', mensaje, d.id])
    );
    console.log(
      `[direcciones] ${devolvioLaCiudad ? 'era la ciudad' : noSePudo ? 'avería' : 'sin resultado'}: ` +
        `«${d.direccion}»`
    );
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
  return googleDisponible() ? 'google' : 'ninguna';
}

/**
 * SITÚA CON PLACES LOS SITIOS DE UNA CIUDAD RECIÉN INVESTIGADA.
 *
 * Una llamada a Places por sitio, y solo por los que no tengan ya dirección:
 * reinvestigar una ciudad no vuelve a pagar por lo que ya se sabía.
 *
 * Lo que se guarda es doble y las dos cosas hacen falta:
 *   · La DIRECCIÓN, en la tabla `direcciones`, que es de donde tira el buscador
 *     de traslados y el mapa de la parada.
 *   · Las COORDENADAS, en la propia fila del sitio, porque las de la IA son
 *     aproximadas y las de Places son las buenas.
 *
 * Si Google no contesta no pasa nada grave: el sitio se queda sin dirección y
 * se puede escribir a mano. Lo que no se hace es dejarlo a medias en silencio.
 */
export async function situarLosSitios(punto, di = () => {}) {
  const sitios = todas(
    `SELECT s.id, s.nombre, s.lat, s.lon
       FROM sitios_lugar s
      WHERE s.punto_interes_id = ?
        AND NOT EXISTS (
          SELECT 1 FROM direcciones d
           WHERE d.tipo_elemento = 'sitio' AND d.elemento_id = s.id
        )
      ORDER BY s.orden, s.id`,
    punto.id
  );
  if (!sitios.length) return { situados: 0, total: 0 };

  const ciudad = punto.ciudad_base || punto.nombre;

  // EL PAÍS VA EN LA CONSULTA, Y NO IBA.
  //
  // Se le preguntaba a Google por «Susa» a secas. «Susa» es Sousse en Túnez y
  // también un pueblo del Piamonte, así que el Anfiteatro de Susa acabó en
  // Italia. Y con el país delante ni «Mirador de la Torre del Reloj» se va a
  // Cartagena de Indias ni «Restaurante Dar Hizem» a Miami, que es donde
  // acabaron los dos.
  const pais = una(
    'SELECT COALESCE(d.pais, d.nombre) AS pais FROM destinos d WHERE d.id = ?',
    punto.destino_id
  )?.pais ?? null;

  // LA CONSULTA SE COMPONE AQUÍ, ENTERA, Y SE PASA SIN `cerca`.
  //
  // `componerConsulta` no repite la ciudad si el nombre ya la lleva, que para
  // una dirección escrita a mano es lo correcto. Para un sitio es justo lo peor
  // que puede hacer: «Parque del Olivar de Susa» contiene «Susa», así que se
  // preguntaba SIN contexto —y Google contestó El Olivar, de Lima—. El
  // topónimo dentro del nombre no es motivo para quitar el contexto: es la
  // señal de que hace falta.
  const donde = [ciudad, pais && pais !== ciudad ? pais : null].filter(Boolean).join(', ');
  const consultaDe = (nombre) => (donde ? `${nombre}, ${donde}` : nombre);

  let situados = 0;
  let avisados = 0;
  let descartados = 0;
  let amontonados = 0;

  for (const s of sitios) {
    const enPlaces = await situarLugarConGoogle(consultaDe(s.nombre), null);
    if (!enPlaces?.direccion) continue;

    // SIN ENCOLAR. La dirección ya viene con su punto, así que preguntar otra
    // vez no es solo pagar dos veces por lo mismo: la segunda respuesta es
    // PEOR. El worker busca el texto con el nombre de la ciudad pegado detrás
    // —«Epidavros 210 52, Grecia, Nafplio»— y Google, que no sabe qué hacer con
    // eso, devuelve el centroide de Nauplia. Y lo escribe encima.
    //
    // Aquí ponía «se marca situada sin pasar por la cola de geocodificación».
    // Era la intención correcta desde el principio; lo que faltaba era que
    // fuese verdad. Si Places trae la dirección pero no el punto, entonces sí
    // se encola: ahí no hay nada que pisar.
    const tienePunto = enPlaces.lat != null && enPlaces.lng != null;

    // --- ¿CAE DONDE DEBE? -------------------------------------------------
    //
    // Las ciudades tienen esta guarda desde hace tiempo (`caeDondeDebe`, 20 km)
    // y las excursiones también (300 km). Los sitios no tenían NINGUNA: se
    // guardaba lo que Google contestara, así que un parque de Lima entraba en un
    // viaje a Túnez sin que nadie chistara.
    //
    // DOS UMBRALES, PORQUE HAY DOS COSAS DISTINTAS. Un sitio a 174 km puede ser
    // perfectamente real —El Jem lo está, y Dougga a 110— y tirarlo sería
    // cargarse una excursión de día legítima. Un sitio a 8.000 km no es un
    // matiz: es otro continente. Así que por encima del primero se AVISA y se
    // deja puesto, y solo por encima del segundo se descarta la coordenada.
    //
    // Se descarta la COORDENADA, no el sitio: la dirección se guarda igual y el
    // sitio sigue en la ficha. Lo que no se hace es pintar un pin en Perú.
    const lejos = tienePunto ? kmDesdeLaCiudad(punto, enPlaces) : null;
    const avisaDesde = parametro('km_sitio_lejos_aviso', 80);
    const tiraDesde = parametro('km_sitio_lejos_descarte', 300);
    const disparate = lejos != null && lejos > tiraDesde;

    // --- ¿ES SU PUNTO, O EL DE OTRO? --------------------------------------
    //
    // ESTA GUARDA YA EXISTÍA, Y SOLO PARA LAS EXCURSIONES. Está escrita cuarenta
    // líneas más abajo: si Google devuelve un ÁREA —`locality`, `route`,
    // `neighborhood`— su coordenada es un centroide, y clavar ahí un pin es
    // «la coordenada del centro para disimular». Los sitios no la tenían.
    //
    // LO QUE PASA CUANDO NO ESTÁ, medido sobre los 156 sitios del catálogo: 27
    // (el 17 %) comparten coordenada EXACTA con otro. No son duplicados, son
    // sitios distintos amontonados en el centroide de la zona que Google supo
    // devolver:
    //
    //     Kairuan     5 sitios en un punto: la Gran Mezquita, el Parque, la
    //                 Mezquita de Sidi el-Ghariani, el Barrio de los Tintoreros
    //                 y las Murallas.
    //     Tesalónica  3: las Murallas Bizantinas, la Torre Blanca y el Paseo
    //                 Marítimo. Están a más de un kilómetro unas de otras.
    //     Túnez       2: el Bardo —que está a 4 km— y el Museo de la Ciudad.
    //
    // Y ES PEOR QUE NO TENER EL DATO, que es lo que decide hacer esto. El lienzo
    // calcula con las coordenadas si da tiempo a ir de un sitio a otro: con dos
    // sitios en el mismo punto le salen CERO minutos y da por bueno un salto que
    // en Tesalónica es de kilómetro y medio. Sin coordenada, `trayectoOSuelo`
    // devuelve `null` y no afirma nada. Un hueco honesto contra un cero falso.
    //
    // NO SE MIRA EL TIPO, SE MIRA LA COLISIÓN, y es a propósito: hay sitios que
    // SON un área de verdad —la Medina de Kairuan, el Casco Antiguo, un paseo
    // marítimo— y tirar su centroide sería perder la posición buena de un sitio
    // legítimo. Dos sitios de nombre distinto en el MISMO punto a cinco
    // decimales —un metro— no pasa en la realidad: es la firma del centroide.
    //
    // Y SE QUEDA EL PRIMERO. El bucle va `ORDER BY s.orden, s.id`, así que
    // conserva el punto el más importante de los dos: en Kairuan la Gran
    // Mezquita (#1) y no el Parque (#10).
    const ocupado = tienePunto
      ? una(
          `SELECT nombre FROM sitios_lugar
            WHERE punto_interes_id = ? AND id <> ? AND lat IS NOT NULL
              AND ROUND(lat, 5) = ROUND(?, 5) AND ROUND(lon, 5) = ROUND(?, 5)
            LIMIT 1`,
          punto.id,
          s.id,
          enPlaces.lat,
          enPlaces.lng
        )?.nombre ?? null
      : null;

    if (disparate) {
      descartados += 1;
      di(
        `   ✘ «${s.nombre}»: Google lo sitúa a ${Math.round(lejos)} km de ${ciudad} ` +
          `(«${enPlaces.direccion}»). Eso no está en ${ciudad}: me quedo sin sus coordenadas.`
      );
      console.warn(
        `[direcciones] «${s.nombre}» a ${Math.round(lejos)} km de ${ciudad}: descarto el punto.`
      );
    } else if (ocupado) {
      amontonados += 1;
      di(
        `   ✘ «${s.nombre}»: Google devuelve el MISMO punto que «${ocupado}»` +
          `${(enPlaces.tipos ?? []).length ? ` (${enPlaces.tipos.join(', ')})` : ''}. ` +
          'Eso es el centroide de la zona, no su sitio: me quedo sin sus coordenadas antes ' +
          'que decir que están pegados.'
      );
      console.warn(
        `[direcciones] «${s.nombre}» cae en el punto de «${ocupado}»: descarto la coordenada.`
      );
    } else if (lejos != null && lejos > avisaDesde) {
      avisados += 1;
      di(
        `   OJO: «${s.nombre}» queda a ${Math.round(lejos)} km de ${ciudad} ` +
          `(«${enPlaces.direccion}»). Lo dejo puesto —puede ser una excursión de día— ` +
          'pero míralo.'
      );
    }

    // LA DIRECCIÓN SE GUARDA IGUAL, como en el caso del disparate: el sitio
    // sigue en la ficha con su calle, lo único que no se escribe es el pin.
    guardarDireccion('sitio', s.id, enPlaces.direccion, {
      encolar: !tienePunto && !disparate && !ocupado,
    });

    if (tienePunto && !disparate && !ocupado) {
      ejecutar(
        `UPDATE direcciones
            SET lat = ?, lng = ?, estado = 'ok', fuente = 'places',
                buscada_en = datetime('now'), actualizado_en = datetime('now')
          WHERE tipo_elemento = 'sitio' AND elemento_id = ?`,
        enPlaces.lat,
        enPlaces.lng,
        s.id
      );
      ejecutar('UPDATE sitios_lugar SET lat = ?, lon = ? WHERE id = ?', enPlaces.lat, enPlaces.lng, s.id);
    }
    situados += 1;
  }

  console.log(`[direcciones] ${situados} de ${sitios.length} sitios de ${ciudad} situados con Places.`);
  if (avisados || descartados || amontonados) {
    di(
      `   ${ciudad}: ${descartados} sitio(s) sin coordenadas por caer demasiado lejos` +
        `${amontonados ? `, ${amontonados} por caer en el punto de otro` : ''}` +
        `${avisados ? ` y ${avisados} avisado(s) por quedar a más de ${parametro('km_sitio_lejos_aviso', 80)} km` : ''}.`
    );
  }
  return { situados, total: sitios.length, avisados, descartados, amontonados };
}

/**
 * Los kilómetros en línea recta entre un sitio y el centro de su ciudad.
 *
 * Null cuando la ciudad todavía no tiene punto: sin dato no se acusa a nadie, la
 * misma regla que usa `caeDondeDebe` con las ciudades.
 */
function kmDesdeLaCiudad(punto, hallado) {
  if (punto?.lat == null || punto?.lon == null) return null;
  if (hallado?.lat == null || hallado?.lng == null) return null;
  const R = 6371;
  const rad = (g) => (g * Math.PI) / 180;
  const dLat = rad(hallado.lat - punto.lat);
  const dLon = rad(hallado.lng - punto.lon);
  const h =
    Math.sin(dLat / 2) ** 2 +
    Math.cos(rad(punto.lat)) * Math.cos(rad(hallado.lat)) * Math.sin(dLon / 2) ** 2;
  return 2 * R * Math.asin(Math.sqrt(h));
}

// =============================================================================
// SITUAR UNA EXCURSIÓN
// =============================================================================
/**
 * LOS TIPOS QUE SON UN SITIO Y LOS QUE SON UNA ZONA.
 *
 * Google devuelve con cada resultado qué clase de cosa es, y ahí está la línea
 * entre pintar un pin honrado y pintar uno a ojo:
 *
 *   · `tourist_attraction`, `museum`, `church`, `park`, `establishment`… son
 *     PUNTOS. Tienen una puerta por la que se entra y su coordenada significa
 *     algo.
 *   · `locality`, `neighborhood`, `sublocality`, `route`, `postal_code`… son
 *     ÁREAS. Su coordenada es un centroide, y clavar ahí un pin es exactamente
 *     la «coordenada del centro para disimular» que no se quiere.
 *
 * Si lo único que Google sabe devolver es un área, la excursión se queda sin
 * ubicar. Es lo mismo que ya se hace con una comida que solo tiene zona.
 */
const TIPOS_DE_AREA = new Set([
  'locality', 'sublocality', 'sublocality_level_1', 'neighborhood', 'political',
  'administrative_area_level_1', 'administrative_area_level_2',
  'administrative_area_level_3', 'country', 'postal_code', 'route', 'street_address',
]);

/** Hasta dónde puede estar razonablemente la excursión de un día de su ciudad. */
const KM_MAXIMOS_DE_EXCURSION = 300;

/**
 * SITÚA UNA EXCURSIÓN POR SU NOMBRE, UNA VEZ EN LA VIDA.
 *
 * EL AGUJERO QUE TAPA. Civitatis no da coordenadas —ni dirección: la ficha del
 * catálogo trae título, precio, duración y poco más, con `punto_encuentro` vacío—
 * así que TODAS las excursiones salían del mapa con «sin ubicar». Cinco de
 * veinticinco elementos del viaje 41, incluida Auschwitz, que es el motivo por el
 * que medio mundo va a Cracovia.
 *
 * NO SE GEOCODIFICA UNA DIRECCIÓN: SE BUSCA UN SITIO. Son dos APIs distintas y
 * la diferencia importa. El geocodificador quiere una calle y un número y con
 * «Excursión a Auschwitz-Birkenau con guía» no sabe qué hacer. Places busca
 * LUGARES por su nombre, y a eso contesta «Campo de concentración de Auschwitz,
 * Oświęcim», que es la respuesta correcta.
 *
 * LOS DOS GUARDIANES, Y POR QUÉ NO SON LOS DE SIEMPRE:
 *
 *   1. El resultado tiene que ser un SITIO y no un ÁREA (ver arriba).
 *   2. Y tiene que caer a una distancia de día de excursión de su ciudad.
 *
 * El segundo NO es el «¿está en la misma ciudad?» que usan los sitios, y es a
 * propósito: una excursión que sale de la ciudad es lo normal —Auschwitz está a
 * 70 km de Cracovia— y ese guardián habría tirado justo el caso que se quería
 * arreglar. Lo que se descarta aquí es el homónimo grosero: el «Wawel» de
 * Wisconsin, no el viaje de un día.
 *
 * LO QUE NO CASA NO SE INVENTA: se guarda `sin_resultado` con su motivo, la
 * excursión se queda con su etiqueta de «sin ubicar en el mapa», y no se vuelve a
 * preguntar. Un hueco declarado y barato.
 *
 * Devuelve true solo si acabó situada.
 */
export async function situarActividadConPlaces(actividadId, { cerca = null } = {}) {
  const ficha = una('SELECT id, titulo, ciudad FROM catalogo_actividades WHERE id = ?', actividadId);
  if (!ficha) return false;

  // UNA VEZ EN LA VIDA. Si ya hay fila —situada o fallida— no se vuelve a
  // preguntar: la segunda apertura del mapa no puede costar otra llamada.
  const previa = direccionDe('actividad', actividadId);
  if (previa) return Boolean(previa.situada);

  const hallado = await situarLugarConGoogle(ficha.titulo, ficha.ciudad);

  const guardarFallo = (motivo) => {
    ejecutar(
      `INSERT INTO direcciones (tipo_elemento, elemento_id, direccion, estado, fuente, mensaje, buscada_en)
       VALUES ('actividad', ?, ?, 'sin_resultado', 'google-places', ?, datetime('now'))
       ON CONFLICT (tipo_elemento, elemento_id) DO UPDATE SET
         estado = 'sin_resultado', mensaje = excluded.mensaje, buscada_en = excluded.buscada_en`,
      actividadId,
      ficha.titulo,
      motivo
    );
    console.log(`[direcciones] excursión «${ficha.titulo}»: sin ubicar (${motivo}).`);
    return false;
  };

  if (!hallado?.lat) return guardarFallo('Google no encontró ningún sitio con ese nombre');

  const tipos = hallado.tipos ?? [];
  const esSitio = tipos.some((t) => !TIPOS_DE_AREA.has(t));
  if (!esSitio) {
    return guardarFallo(`lo único que devolvió es una zona (${tipos.join(', ')}), no un sitio`);
  }

  if (cerca?.lat != null) {
    const km = distanciaKm({ lat: cerca.lat, lon: cerca.lon }, { lat: hallado.lat, lon: hallado.lng });
    if (km > KM_MAXIMOS_DE_EXCURSION) {
      return guardarFallo(`el resultado cae a ${Math.round(km)} km de ${ficha.ciudad}: no es esto`);
    }
  }

  ejecutar(
    `INSERT INTO direcciones (tipo_elemento, elemento_id, direccion, lat, lng, estado, fuente, mensaje, buscada_en)
     VALUES ('actividad', ?, ?, ?, ?, 'ok', 'google-places', ?, datetime('now'))
     ON CONFLICT (tipo_elemento, elemento_id) DO UPDATE SET
       direccion = excluded.direccion, lat = excluded.lat, lng = excluded.lng,
       estado = 'ok', fuente = excluded.fuente, mensaje = excluded.mensaje,
       buscada_en = excluded.buscada_en`,
    actividadId,
    hallado.direccion ?? ficha.titulo,
    hallado.lat,
    hallado.lng,
    // QUÉ SE HA DADO POR BUENO, guardado y enseñado. «Excursión a
    // Auschwitz-Birkenau con guía» se pinta en el Campo de concentración de
    // Auschwitz, y quien mire el mapa tiene derecho a saber que es eso lo que se
    // ha casado y no otra cosa.
    `Situada como «${hallado.nombre}»`
  );
  console.log(`[direcciones] excursión «${ficha.titulo}» → ${hallado.nombre} (${hallado.direccion}).`);
  return true;
}

// =============================================================================
// EL DETECTOR BARATO: DOS SITIOS DISTINTOS EN EL MISMO PUNTO
// =============================================================================
/**
 * DOS COSAS DISTINTAS NO PUEDEN ESTAR EN EL MISMO SITIO.
 *
 * Cero metros entre dos nombres diferentes es siempre un error, y es la
 * comprobación más barata que hay: no pregunta nada a nadie, solo agrupa lo que
 * ya está guardado. Encontró en un segundo lo que llevaba meses en la base —el
 * Teatro de Epidauro, el yacimiento de Micenas, la mezquita de Voivode y la
 * isla de Bourtzi compartiendo el centro de Nauplia—, y encontró otros nueve
 * grupos que nadie había mirado.
 *
 * SOLO DETECTA. No recoloca nada, y es a propósito: la causa de cada grupo es
 * distinta —a veces es el geocodificador, a veces son dos filas del catálogo
 * que son el mismo sitio con dos nombres, y a veces es un sitio metido en la
 * ciudad equivocada— y arreglarlas todas igual sería cambiar un error por otro.
 * Aquí se señala; quien decida, decide mirando.
 *
 * Se agrupa por parada, no por viaje: un sitio del catálogo pertenece a su
 * punto de interés y puede estar apuntado en varios viajes a la vez. La
 * coincidencia se mira TAL CUAL está guardada, sin redondear: Google devuelve
 * siete decimales, así que dos filas idénticas al último decimal no son dos
 * medidas parecidas, son la misma respuesta repetida.
 *
 * `puntoId` acota a una sola parada; sin él, barre el catálogo entero.
 */
export function sitiosConLaMismaCoordenada({ puntoId = null } = {}) {
  const filas = todas(
    `SELECT s.id, s.nombre, p.id AS punto_id, p.nombre AS ciudad,
            d.lat, d.lng, d.fuente, d.direccion
       FROM direcciones d
       JOIN sitios_lugar s ON s.id = d.elemento_id AND d.tipo_elemento = 'sitio'
       JOIN puntos_interes p ON p.id = s.punto_interes_id
      WHERE d.estado = 'ok' AND d.lat IS NOT NULL AND d.lng IS NOT NULL
        ${puntoId ? 'AND p.id = ?' : ''}
      ORDER BY p.nombre, s.nombre`,
    ...(puntoId ? [Number(puntoId)] : [])
  );

  const porCoordenada = new Map();
  for (const f of filas) {
    const clave = `${f.punto_id}|${f.lat}|${f.lng}`;
    if (!porCoordenada.has(clave)) porCoordenada.set(clave, []);
    porCoordenada.get(clave).push(f);
  }

  return [...porCoordenada.values()]
    .filter((grupo) => grupo.length > 1)
    .map((grupo) => ({
      puntoId: grupo[0].punto_id,
      ciudad: grupo[0].ciudad,
      lat: grupo[0].lat,
      lng: grupo[0].lng,
      sitios: grupo.map((f) => ({
        id: f.id,
        nombre: f.nombre,
        fuente: f.fuente,
        direccion: f.direccion,
      })),
    }))
    .sort((a, b) => b.sitios.length - a.sitios.length || a.ciudad.localeCompare(b.ciudad));
}

/** Los mismos grupos, en una línea por sitio, para leerlos por consola. */
export function contarSitiosConLaMismaCoordenada({ puntoId = null } = {}) {
  const grupos = sitiosConLaMismaCoordenada({ puntoId });
  const sitios = grupos.reduce((n, g) => n + g.sitios.length, 0);
  return { grupos, cuantosGrupos: grupos.length, cuantosSitios: sitios };
}
