/**
 * services/geocodificar.js
 * -----------------------------------------------------------------------------
 * Nominatim (el buscador de OpenStreetMap) para la pantalla del mapamundi:
 * de unas coordenadas a un sitio con nombre, y de un nombre a unas coordenadas.
 *
 * SE LLAMA DESDE EL SERVIDOR, NUNCA DESDE EL NAVEGADOR. Tres razones, y las
 * tres importan:
 *
 *  1. Nominatim EXIGE un User-Agent que identifique a la aplicación. Sin él
 *     banea, y desde el navegador no se puede poner: el navegador manda el suyo.
 *  2. Su política es de UNA petición por segundo. Desde el navegador, un usuario
 *     nervioso clicando el mapa manda diez en dos segundos. Desde aquí se pueden
 *     poner en fila.
 *  3. La caché en memoria sirve para todos: si clicas dos veces en el mismo
 *     sitio, la segunda no sale del servidor.
 *
 * Es un servicio público y gratuito que mantiene gente con recursos limitados.
 * Portarse bien no es cortesía, es la condición para poder usarlo.
 */

/** Quiénes somos. Nominatim lo pide y con razón. */
const AGENTE = 'CreadorViajes/1.0 (uso personal)';

/** Su política: como mucho una petición por segundo. */
const MINIMO_ENTRE_PETICIONES_MS = 1000;

/** Si tarda más que esto, es que algo va mal. */
const TIMEOUT_MS = 10_000;

const BASE = 'https://nominatim.openstreetmap.org';

/**
 * Cuándo se hizo la última petición. Un simple número basta: el servidor es
 * un solo proceso y los trabajos van de uno en uno.
 */
let ultimaPeticion = 0;

/**
 * La cola del acelerador. Cada petición encadena su espera a la anterior, así
 * que tres clics seguidos salen a 0 s, 1 s y 2 s en vez de los tres a la vez.
 */
let turno = Promise.resolve();

const dormir = (ms) => new Promise((r) => setTimeout(r, ms));

/**
 * Pide el turno y espera lo que haga falta para no pasarse del límite.
 * Devuelve una promesa que se resuelve cuando toca disparar.
 */
function esperarTurno() {
  turno = turno.then(async () => {
    const desde = Date.now() - ultimaPeticion;
    if (desde < MINIMO_ENTRE_PETICIONES_MS) {
      await dormir(MINIMO_ENTRE_PETICIONES_MS - desde);
    }
    ultimaPeticion = Date.now();
  });
  return turno;
}

/**
 * Caché en memoria. Se pierde al reiniciar el servidor y no pasa nada: esto no
 * es un dato del viaje, es el nombre de un sitio, que se vuelve a pedir y ya.
 * Por eso no va a SQLite.
 */
const cache = new Map();
const CACHE_MAX = 500;

function deCache(clave) {
  return cache.has(clave) ? cache.get(clave) : undefined;
}

function aCache(clave, valor) {
  // Un tope tonto pero suficiente: si se llena, fuera la más vieja.
  if (cache.size >= CACHE_MAX) cache.delete(cache.keys().next().value);
  cache.set(clave, valor);
  return valor;
}

/** Una llamada a Nominatim, con turno, cabecera y timeout. */
async function pedir(ruta, parametros) {
  const url = new URL(BASE + ruta);
  for (const [k, v] of Object.entries(parametros)) url.searchParams.set(k, String(v));
  url.searchParams.set('format', 'json');
  url.searchParams.set('accept-language', 'es');

  await esperarTurno();

  const control = new AbortController();
  const reloj = setTimeout(() => control.abort(), TIMEOUT_MS);
  try {
    const respuesta = await fetch(url, {
      signal: control.signal,
      headers: { 'User-Agent': AGENTE, Accept: 'application/json' },
    });
    if (!respuesta.ok) throw new Error(`Nominatim respondió ${respuesta.status}`);
    return await respuesta.json();
  } catch (err) {
    if (err.name === 'AbortError') throw new Error('Nominatim tardó demasiado en responder.');
    throw err;
  } finally {
    clearTimeout(reloj);
  }
}

// =============================================================================
// DE COORDENADAS A SITIO
// =============================================================================
/**
 * El `zoom` de Nominatim decide con cuánto detalle contesta: con 3 te dice el
 * país y con 12 el pueblo. Lo sacamos del zoom del mapa, que es lo que dice qué
 * está mirando la persona: si ve el mundo entero, quiere un país; si ve una
 * provincia, quiere una ciudad.
 */
export function zoomNominatim(zoomMapa) {
  const z = Number(zoomMapa) || 2;
  if (z <= 4) return 3;   // país
  if (z <= 7) return 8;   // región o ciudad grande
  return 12;              // ciudad o pueblo
}

/**
 * Qué hay en unas coordenadas.
 *
 * Devuelve siempre un objeto con la misma forma, incluso cuando no hay nada:
 *
 *   { hay: false }                                  -> mar abierto, o nada útil
 *   { hay: true, nombre, tipo, pais, lat, lon }     -> un sitio de verdad
 */
export async function sitioEnCoordenadas(lat, lon, zoomMapa) {
  const zoom = zoomNominatim(zoomMapa);
  // Redondeamos a dos decimales (~1 km) para la clave: dos clics a un dedo de
  // distancia son el mismo sitio y no merecen dos llamadas.
  const clave = `r|${Number(lat).toFixed(2)}|${Number(lon).toFixed(2)}|${zoom}`;

  const guardado = deCache(clave);
  if (guardado !== undefined) return guardado;

  const datos = await pedir('/reverse', { lat, lon, zoom });
  return aCache(clave, interpretar(datos, zoom, lat, lon));
}

// =============================================================================
// DE TEXTO A SITIO
// =============================================================================
/**
 * Busca un sitio por su nombre. Devuelve lo mismo que la inversa, más el zoom
 * al que conviene volar: un país se ve entero desde el 5 y una ciudad desde
 * el 10.
 */
export async function sitioPorTexto(texto) {
  const consulta = String(texto ?? '').trim();
  if (!consulta) return { hay: false };

  const clave = `t|${consulta.toLowerCase()}`;
  const guardado = deCache(clave);
  if (guardado !== undefined) return guardado;

  const datos = await pedir('/search', { q: consulta, limit: 1, addressdetails: 1 });
  const primero = Array.isArray(datos) ? datos[0] : null;
  if (!primero) return aCache(clave, { hay: false });

  const lat = Number(primero.lat);
  const lon = Number(primero.lon);

  // addresstype es lo más fiable para saber qué te ha devuelto; type queda de
  // respaldo para respuestas antiguas.
  const que = primero.addresstype || primero.type || '';
  const esPais = que === 'country';

  const sitio = interpretar(primero, esPais ? 3 : 12, lat, lon);
  return aCache(clave, {
    ...sitio,
    // A un país se le mira entero; a una ciudad se le entra.
    zoomVuelo: esPais ? 5 : 10,
  });
}

// =============================================================================
// INTERPRETAR LO QUE CONTESTA NOMINATIM
// =============================================================================
/**
 * Nominatim devuelve un `address` con veinte campos posibles y ninguno
 * garantizado. Esto se queda con lo único que nos importa: cómo se llama esto
 * y si es un país o una ciudad.
 *
 * La ciudad puede venir con cuatro nombres distintos según el sitio: `city` en
 * una capital, `town` en un pueblo grande, `village` en uno pequeño y, cuando
 * no hay ninguno, `state` (que en un desierto o una isla es lo más concreto
 * que hay). Se cogen en ese orden, de más preciso a menos.
 */
function interpretar(datos, zoom, lat, lon) {
  const direccion = datos?.address;
  if (!direccion) return { hay: false };

  const pais = direccion.country ?? null;
  const ciudad =
    direccion.city ?? direccion.town ?? direccion.village ?? direccion.state ?? null;

  // Con zoom de país no preguntamos por la ciudad aunque venga: quien mira el
  // mundo entero y toca España quiere España, no el pueblo que haya debajo.
  const esPais = zoom <= 4 || !ciudad;

  const nombre = esPais ? pais : ciudad;
  if (!nombre) return { hay: false };   // mar abierto, o algo sin nombre útil

  return {
    hay: true,
    nombre,
    tipo: esPais ? 'pais' : 'ciudad',
    // El país solo se enseña como subtítulo cuando el destino es una ciudad:
    // "Kioto · Japón" tiene sentido, "Japón · Japón" no.
    pais: esPais ? null : pais,
    lat: Number(lat),
    lon: Number(lon),
  };
}
