/**
 * services/geocodificar.js
 * -----------------------------------------------------------------------------
 * DE UN NOMBRE A UN SITIO, Y DE UN PUNTO A UN NOMBRE. Todo con Google.
 *
 * Antes esto era Nominatim, el buscador de OpenStreetMap. Funcionaba y era
 * gratis, pero se le atragantaban justo las consultas que más se hacen aquí:
 * las zonas difusas. "Cascais y Costa de Estoril" o "Valle del Tejo" no son un
 * municipio ni un punto, y Nominatim contestaba que no existen. Google devuelve
 * un punto representativo de la zona, que es exactamente lo que hace falta para
 * situar un destino en el mapa.
 *
 * NO HAY PLAN B, y es a propósito. Antes había respaldo y eso escondía los
 * fallos: cuando Google no contestaba, la aplicación seguía con datos peores sin
 * decirlo. Ahora, si Google no resuelve algo, se devuelve un `null` con motivo y
 * la pantalla lo dice. Vale más un "no he podido situar este destino" que un
 * "calculando…" que no termina nunca.
 *
 * LA CACHÉ SE QUEDA. Cada llamada cuesta dinero y dos clics a un dedo de
 * distancia son el mismo sitio.
 */
import { geocodificarConGoogle, hayClaveGoogle, googleDisponible } from '../lib/google.js';

const URL_GEOCODING = 'https://maps.googleapis.com/maps/api/geocode/json';
const TIMEOUT_MS = 12_000;

// =============================================================================
// CACHÉ EN MEMORIA
// =============================================================================
/**
 * Se guarda hasta el "no lo encuentro": preguntar dos veces por algo que no
 * existe cuesta lo mismo que preguntar por algo que sí.
 */
const cache = new Map();
const MAX_CACHE = 500;

const deCache = (clave) => cache.get(clave);

function aCache(clave, valor) {
  if (cache.size >= MAX_CACHE) cache.delete(cache.keys().next().value);
  cache.set(clave, valor);
  return valor;
}

/** Para las pruebas y para cuando cambia la clave. */
export function vaciarCache() {
  cache.clear();
}

// =============================================================================
// LA LLAMADA
// =============================================================================
/**
 * Geocoding de Google, directo o inverso según los parámetros.
 *
 * Devuelve la lista de resultados, o `null` si Google no contestó. Distinguir
 * "no hay resultados" de "no he podido preguntar" importa: lo primero es una
 * respuesta y lo segundo es una avería.
 */
async function pedirAGoogle(params) {
  if (!hayClaveGoogle()) {
    console.warn('[geocodificar] no hay GOOGLE_MAPS_SERVER_KEY: no se puede situar nada.');
    return null;
  }

  const url = new URL(URL_GEOCODING);
  for (const [k, v] of Object.entries(params)) url.searchParams.set(k, String(v));
  url.searchParams.set('language', 'es');
  url.searchParams.set('key', process.env.GOOGLE_MAPS_SERVER_KEY);

  const control = new AbortController();
  const reloj = setTimeout(() => control.abort(), TIMEOUT_MS);

  try {
    const r = await fetch(url, { signal: control.signal, headers: { Accept: 'application/json' } });
    const cuerpo = await r.json().catch(() => null);

    if (cuerpo?.status === 'ZERO_RESULTS') return [];
    if (cuerpo?.status !== 'OK') {
      console.warn(
        `[geocodificar] Google dijo ${cuerpo?.status ?? r.status}` +
          (cuerpo?.error_message ? `: ${cuerpo.error_message}` : '')
      );
      return null;
    }
    return cuerpo.results ?? [];
  } catch (err) {
    const motivo = err.name === 'AbortError' ? `tardó más de ${TIMEOUT_MS / 1000} s` : err.message;
    console.warn(`[geocodificar] Google no contestó: ${motivo}`);
    return null;
  } finally {
    clearTimeout(reloj);
  }
}

// =============================================================================
// INTERPRETAR LO QUE CONTESTA GOOGLE
// =============================================================================
/**
 * Los `address_components` de Google vienen etiquetados por tipo, que es mucho
 * más fiable que los veinte campos sin garantizar de Nominatim.
 *
 * `locality` es la ciudad. Cuando no la hay —una zona difusa, un parque
 * natural, una isla— se baja a la comarca y luego a la provincia o región, que
 * es lo más concreto que existe ahí. Esa cadena es justo lo que hace que
 * "Valle del Tejo" tenga respuesta en vez de no tener ninguna.
 */
const trozo = (componentes, tipo) =>
  componentes?.find((c) => (c.types ?? []).includes(tipo))?.long_name ?? null;

function interpretar(resultado, { comoPais = false } = {}) {
  if (!resultado) return { hay: false };

  const comp = resultado.address_components ?? [];
  const tipos = resultado.types ?? [];

  const pais = trozo(comp, 'country');
  const ciudad =
    trozo(comp, 'locality') ??
    trozo(comp, 'postal_town') ??
    trozo(comp, 'administrative_area_level_2') ??
    trozo(comp, 'administrative_area_level_1');

  // Es un país cuando lo dice Google, cuando se pide mirando el mundo entero, o
  // cuando no hay nada más concreto debajo.
  const esPais = comoPais || tipos.includes('country') || !ciudad;

  const nombre = esPais ? pais : ciudad;
  if (!nombre) return { hay: false };   // mar abierto, o algo sin nombre útil

  const punto = resultado.geometry?.location;

  return {
    hay: true,
    nombre,
    tipo: esPais ? 'pais' : 'ciudad',
    // El país solo se enseña como subtítulo cuando el destino es una ciudad:
    // "Kioto · Japón" tiene sentido, "Japón · Japón" no.
    pais: esPais ? null : pais,
    lat: Number(punto?.lat),
    lon: Number(punto?.lng),
  };
}

// =============================================================================
// DE COORDENADAS A SITIO
// =============================================================================
/**
 * A qué nivel contestar según lo que se esté mirando.
 *
 * Quien ve el mundo entero y toca España quiere España, no el pueblo que haya
 * debajo del dedo. Quien ve una provincia quiere la ciudad.
 */
export function nivelSegunZoom(zoomMapa) {
  return (Number(zoomMapa) || 2) <= 4 ? 'pais' : 'ciudad';
}

/**
 * Qué hay en unas coordenadas.
 *
 *   { hay: false }                                -> mar abierto, o nada útil
 *   { hay: true, nombre, tipo, pais, lat, lon }   -> un sitio de verdad
 */
export async function sitioEnCoordenadas(lat, lon, zoomMapa) {
  const nivel = nivelSegunZoom(zoomMapa);
  // Dos decimales (~1 km) para la clave: dos clics a un dedo de distancia son
  // el mismo sitio y no merecen dos llamadas.
  const clave = `r|${Number(lat).toFixed(2)}|${Number(lon).toFixed(2)}|${nivel}`;

  const guardado = deCache(clave);
  if (guardado !== undefined) return guardado;

  const resultados = await pedirAGoogle({ latlng: `${lat},${lon}` });
  if (resultados === null) return { hay: false };   // avería: no se cachea
  if (!resultados.length) return aCache(clave, { hay: false });

  // Google ordena de lo más concreto a lo más amplio. Para el nivel de país se
  // busca el resultado que ES el país; para ciudad vale el primero.
  const elegido =
    nivel === 'pais'
      ? (resultados.find((r) => (r.types ?? []).includes('country')) ?? resultados[0])
      : resultados[0];

  const sitio = interpretar(elegido, { comoPais: nivel === 'pais' });
  // La coordenada buena es donde se tocó, no el centroide del país.
  return aCache(clave, sitio.hay ? { ...sitio, lat: Number(lat), lon: Number(lon) } : sitio);
}

// =============================================================================
// DE TEXTO A SITIO
// =============================================================================
/**
 * Busca un sitio por su nombre.
 *
 * Devuelve lo mismo que la inversa más el zoom al que conviene volar: un país
 * se ve entero desde el 5 y una ciudad desde el 10.
 *
 * AQUÍ ES DONDE SE NOTA EL CAMBIO. "Cascais y Costa de Estoril" o "Valle del
 * Tejo" no son un municipio, y antes no tenían respuesta. Google devuelve un
 * punto representativo de la zona y el destino se puede situar.
 */
export async function sitioPorTexto(texto) {
  const consulta = String(texto ?? '').trim();
  if (!consulta) return { hay: false };

  const clave = `t|${consulta.toLowerCase()}`;
  const guardado = deCache(clave);
  if (guardado !== undefined) return guardado;

  const resultados = await pedirAGoogle({ address: consulta });
  if (resultados === null) return { hay: false, motivo: 'no se pudo consultar' };
  if (!resultados.length) {
    console.log(`[geocodificar] sin resultados para «${consulta}»`);
    return aCache(clave, { hay: false });
  }

  const primero = resultados[0];
  const esPais = (primero.types ?? []).includes('country');
  const sitio = interpretar(primero);

  console.log(
    `[geocodificar] «${consulta}» → ${primero.formatted_address}` +
      ` (${(primero.types ?? []).slice(0, 2).join(', ') || 'sin tipo'})`
  );

  return aCache(clave, {
    ...sitio,
    // A un país se le mira entero; a una ciudad se le entra.
    zoomVuelo: esPais ? 5 : 10,
  });
}

// =============================================================================
// DE UNA DIRECCIÓN A UN PUNTO
// =============================================================================
/**
 * Una DIRECCIÓN, no una ciudad: "Zelenih beretki 12, Sarajevo".
 *
 * `sitioPorTexto()` no vale para esto: aquel resume a ciudad o país porque lo
 * usa el mapamundi, donde lo que se elige es un destino. Aquí hace falta el
 * portal exacto.
 *
 * Es un envoltorio fino sobre `geocodificarConGoogle`, que ya sabe pegar la
 * ciudad al final cuando la dirección no la lleva.
 *
 * Devuelve `{ direccion, lat, lng, fuente: 'google' }` o `null`.
 */
export async function geocodificarDireccion(texto, { cerca = null } = {}) {
  if (!googleDisponible()) return null;
  return geocodificarConGoogle(texto, { cerca });
}

export default {
  sitioEnCoordenadas,
  sitioPorTexto,
  geocodificarDireccion,
  nivelSegunZoom,
  vaciarCache,
};
