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
 *   1. OSRM (router.project-osrm.org): servidor público y gratuito, sin clave.
 *      Da kilómetros y minutos por carretera de verdad.
 *   2. Haversine, a pelo: la distancia en línea recta sobre la esfera. Es lo que
 *      queda cuando OSRM no encuentra ruta, que es justo lo que pasa entre
 *      islas y a través de océanos — o sea, precisamente cuando el dato en
 *      línea recta es MÁS informativo que el de carretera.
 *
 * Todo esto es decorativo: si las dos fallan, el tramo se pinta igual sin la
 * línea. Nunca lanza.
 */

const URL_OSRM = 'https://router.project-osrm.org/route/v1/driving';

/** Es un servidor de demostración gratuito: no se le aprieta. */
const TIMEOUT_MS = 8_000;
const PAUSA_MS = 400;

const AGENTE = 'CreadorViajes/1.0 (uso personal)';

/** Radio medio de la Tierra, en kilómetros. */
const RADIO_TIERRA_KM = 6371;

/**
 * A partir de aquí, el dato por carretera deja de ser útil.
 *
 * OSRM es más listo de lo que conviene: preguntado por Barcelona → Tokio
 * contesta tan tranquilo "12.513 km, 158 horas" atravesando Eurasia. Es cierto,
 * y no le sirve a nadie. Por encima de este tope el tramo es un vuelo, y lo que
 * hay que enseñar es la línea recta, que es la que lo dice a las claras.
 *
 * 1.500 km está pensado a ojo pero con criterio: por debajo cabe cualquier
 * tren o coche razonable de un día (Madrid-Berlín son 2.300 y ya nadie los
 * hace conduciendo); por encima, no.
 */
const TOPE_CARRETERA_KM = 1500;

let turno = Promise.resolve();
const dormir = (ms) => new Promise((r) => setTimeout(r, ms));

/** Las peticiones a OSRM van de una en una, con un respiro entre ellas. */
function esperarTurno() {
  turno = turno.then(() => dormir(PAUSA_MS));
  return turno;
}

/**
 * Distancia y tiempo por carretera entre dos puntos.
 * Devuelve null si OSRM no responde o no encuentra ruta (islas, océanos).
 */
async function porCarretera(a, b) {
  const url =
    `${URL_OSRM}/${a.lon},${a.lat};${b.lon},${b.lat}?overview=false`;

  await esperarTurno();

  const control = new AbortController();
  const reloj = setTimeout(() => control.abort(), TIMEOUT_MS);
  try {
    const respuesta = await fetch(url, {
      signal: control.signal,
      headers: { 'User-Agent': AGENTE, Accept: 'application/json' },
    });
    if (!respuesta.ok) return null;

    const datos = await respuesta.json();
    // OSRM contesta 200 con code:'NoRoute' cuando no hay carretera que una los
    // dos puntos. No es un error de red: es la respuesta correcta a "¿se puede
    // ir en coche de Barcelona a Tokio?".
    if (datos.code !== 'Ok' || !datos.routes?.length) return null;

    const ruta = datos.routes[0];
    return {
      km: Math.round(ruta.distance / 1000),
      minutos: Math.round(ruta.duration / 60),
      fuente: 'carretera',
    };
  } catch {
    return null;
  } finally {
    clearTimeout(reloj);
  }
}

/**
 * Distancia en línea recta sobre la esfera (fórmula del semiverseno).
 *
 * Se puede calcular aquí mismo, sin pedirle nada a nadie, y para lo que hace
 * falta —saber si son 400 km o 9.000— sobra de largo.
 */
export function enLineaRecta(a, b) {
  const rad = (g) => (g * Math.PI) / 180;
  const dLat = rad(b.lat - a.lat);
  const dLon = rad(b.lon - a.lon);
  const s =
    Math.sin(dLat / 2) ** 2 +
    Math.cos(rad(a.lat)) * Math.cos(rad(b.lat)) * Math.sin(dLon / 2) ** 2;
  return Math.round(RADIO_TIERRA_KM * 2 * Math.asin(Math.sqrt(s)));
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
