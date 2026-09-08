/**
 * services/distancias.js
 * -----------------------------------------------------------------------------
 * Cuánto hay de una parada a la siguiente.
 *
 * No es para calcular la ruta de nadie: es para que, al mirar el tramo, se vea
 * de un vistazo de qué estamos hablando. "≈ 460 km · 5 h 30 en coche" dice
 * "esto es un tren"; "≈ 9.700 km en línea recta" dice "esto es un avión, ni te
 * molestes en mirar trenes".
 *
 * DOS FUENTES, EN ESTE ORDEN
 *
 *   1. Google Routes, con la clave de servidor.
 *      Da kilómetros y minutos por carretera de verdad.
 *   2. Haversine, a pelo: la distancia en línea recta sobre la esfera. Es lo que
 *      queda cuando no hay ruta por tierra, que es justo lo que pasa entre
 *      islas y a través de océanos — o sea, precisamente cuando el dato en
 *      línea recta es MÁS informativo que el de carretera.
 *
 * Todo esto es decorativo: si las dos fallan, el tramo se pinta igual sin la
 * línea. Nunca lanza.
 */

import { rutasConGoogle } from '../lib/google.js';

/** Radio medio de la Tierra, en kilómetros. */
const RADIO_TIERRA_KM = 6371;

/**
 * A partir de aquí, el dato por carretera deja de ser útil.
 *
 * Un router es más listo de lo que conviene: preguntado por Barcelona → Tokio
 * contesta tan tranquilo "12.513 km, 158 horas" atravesando Eurasia. Es cierto,
 * y no le sirve a nadie. Por encima de este tope el tramo es un vuelo, y lo que
 * hay que enseñar es la línea recta, que es la que lo dice a las claras.
 *
 * 1.500 km está pensado a ojo pero con criterio: por debajo cabe cualquier
 * tren o coche razonable de un día (Madrid-Berlín son 2.300 y ya nadie los
 * hace conduciendo); por encima, no.
 */
const TOPE_CARRETERA_KM = 1500;

/**
 * Distancia y tiempo por carretera entre dos puntos, con Google Routes.
 *
 * Antes esto era OSRM, un servidor público de demostración que había que tratar
 * con guantes: una petición cada 400 ms y sin apretar. Google no necesita esa
 * ceremonia y, sobre todo, contesta de verdad donde OSRM se rendía.
 *
 * Devuelve null cuando Google no contesta o no hay ruta por tierra (islas,
 * océanos). Ese null no es un error que haya que enseñar: quien llama se queda
 * con la línea recta, que para "¿son 400 km o 9.000?" sobra.
 */
async function porCarretera(a, b) {
  // `rutasConGoogle` habla en lat/lng y aquí se maneja lat/lon. Es la misma
  // coordenada con otro nombre, y confundirlas manda el viaje al otro
  // hemisferio.
  const rutas = await rutasConGoogle(
    { lat: Number(a.lat), lng: Number(a.lon) },
    { lat: Number(b.lat), lng: Number(b.lon) },
    ['coche']
  );
  const enCoche = rutas?.find((r) => r.modo === 'coche');
  if (!enCoche) return null;

  return {
    km: Math.round(enCoche.km ?? 0),
    minutos: enCoche.minutos,
    fuente: 'carretera',
  };
}

/**
 * Distancia en línea recta sobre la esfera (fórmula del semiverseno).
 *
 * Se puede calcular aquí mismo, sin pedirle nada a nadie, y para lo que hace
 * falta —saber si son 400 km o 9.000— sobra de largo.
 */
export function enLineaRecta(a, b) {
  return Math.round(distanciaKm(a, b));
}

/**
 * Lo mismo, SIN REDONDEAR.
 *
 * `enLineaRecta` devuelve kilómetros enteros porque nació para tramos entre
 * ciudades, donde "460 km" y "460,3 km" son lo mismo. Dentro de una ciudad eso
 * es un desastre: del hotel al restaurante hay 328 metros, que redondeados son
 * CERO kilómetros, y de ahí salía "1 min andando" para un paseo de seis.
 *
 * Quien mide distancias urbanas —los traslados y el desvío de un sitio para
 * comer— usa esta.
 */
export function distanciaKm(a, b) {
  const rad = (g) => (g * Math.PI) / 180;
  const dLat = rad(b.lat - a.lat);
  const dLon = rad(b.lon - a.lon);
  const s =
    Math.sin(dLat / 2) ** 2 +
    Math.cos(rad(a.lat)) * Math.cos(rad(b.lat)) * Math.sin(dLon / 2) ** 2;
  return RADIO_TIERRA_KM * 2 * Math.asin(Math.sqrt(s));
}

/**
 * La referencia de un tramo: carretera si la hay, línea recta si no.
 * Devuelve null solo si faltan coordenadas.
 */
export async function referenciaDeTramo(a, b) {
  if (!coordenadasValidas(a) || !coordenadasValidas(b)) return null;

  const carretera = await porCarretera(a, b);
  if (carretera && carretera.km <= TOPE_CARRETERA_KM) return carretera;

  // Sin ruta por carretera (islas, océanos) o con una tan larga que solo puede
  // hacerse volando: la línea recta es lo que informa.
  return { km: enLineaRecta(a, b), minutos: null, fuente: 'recta' };
}

function coordenadasValidas(p) {
  return p && Number.isFinite(Number(p.lat)) && Number.isFinite(Number(p.lon));
}

// =============================================================================
// CÓMO SE ESCRIBE
// =============================================================================
/** 460 -> "460", 9700 -> "9.700". Los miles con punto, como se leen en español. */
const conMiles = (n) => Number(n).toLocaleString('es-ES');

/** 330 -> "5 h 30". 45 -> "45 min". */
export function comoDuracion(minutos) {
  if (minutos == null) return null;
  const h = Math.floor(minutos / 60);
  const m = minutos % 60;
  if (!h) return `${m} min`;
  return m ? `${h} h ${String(m).padStart(2, '0')}` : `${h} h`;
}

/**
 * La línea informativa del tramo, ya escrita.
 *
 * La de línea recta NO lleva tiempo a propósito: decir "9.700 km · 120 h en
 * coche" sería una tontería, y decir solo los kilómetros en línea recta ya
 * cuenta lo que hay que contar.
 */
export function comoTexto(ref) {
  if (!ref?.km) return null;
  if (ref.fuente === 'recta') return `≈ ${conMiles(ref.km)} km en línea recta`;

  const tiempo = comoDuracion(ref.minutos);
  return `≈ ${conMiles(ref.km)} km` + (tiempo ? ` · ${tiempo} en coche` : '');
}
