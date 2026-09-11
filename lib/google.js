/**
 * lib/google.js
 * -----------------------------------------------------------------------------
 * La única puerta a las APIs de Google Maps. Igual que `lib/ia.js` es la única
 * puerta a Anthropic: si algún día cambia la forma de pedir, se cambia aquí.
 *
 * DOS CLAVES Y NO SE MEZCLAN
 *
 *   GOOGLE_MAPS_SERVER_KEY   Geocoding, Routes y Places. Restringida por IP del
 *                            servidor. ES LA ÚNICA QUE USA ESTE MÓDULO.
 *   GOOGLE_MAPS_BROWSER_KEY  Maps JavaScript API, para pintar mapas en el
 *                            navegador. NO se toca desde aquí y NO debe acabar
 *                            en ninguna vista de este módulo.
 *
 * LA CLAVE DE SERVIDOR NO FUNCIONA DESDE CASA, Y ESO ESTÁ BIEN
 *
 * Está restringida a la IP del servidor, así que desarrollando en local Google
 * contesta REQUEST_DENIED con toda la razón. No es un fallo que haya que
 * arreglar: es la restricción haciendo su trabajo.
 *
 * Por eso este módulo NUNCA lanza por un fallo de Google: devuelve `null` y deja
 * que quien llama lo diga en pantalla: ya no hay plan B, y es a propósito. En
 * local se desarrolla contra el plan B; en el servidor entra Google y se nota
 * porque aparece el transporte público, que ningún router libre sabe dar.
 *
 * SIEMPRE DICE QUÉ FUENTE SE USÓ. Cada llamada deja una línea en el log con el
 * resultado y, cuando falla, el motivo exacto de Google. Sin eso, mirando la
 * pantalla no hay forma de saber si el "12 min en coche" lo dijo Google o lo
 * estimó OSRM.
 */

import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

// Igual que en lib/ia.js: se carga una vez al importar. Si no hay .env, puede
// que las variables vengan del entorno del sistema.
try {
  process.loadEnvFile(path.join(__dirname, '..', '.env'));
} catch {
  /* sin .env; miramos igualmente process.env */
}

const URL_GEOCODING = 'https://maps.googleapis.com/maps/api/geocode/json';
const URL_ROUTES = 'https://routes.googleapis.com/directions/v2:computeRoutes';
const URL_PLACES_BUSCAR = 'https://places.googleapis.com/v1/places:searchText';
const URL_PLACES_FICHA = 'https://places.googleapis.com/v1/places';

/** Si tarda más que esto, no merece la pena esperar: el plan B es instantáneo. */
const TIMEOUT_MS = 8_000;

/**
 * Cuántas veces seguidas ha dicho Google que no antes de dejar de preguntar.
 *
 * En local la clave está restringida por IP, así que TODAS las llamadas van a
 * fallar. Preguntar igualmente en cada traslado son ocho segundos de espera por
 * nada delante de una persona que está planificando. A los tres noes seguidos
 * se apaga sola y se va directa al plan B.
 *
 * No es permanente: `reactivarGoogle()` la vuelve a encender, y el servidor al
 * arrancar empieza siempre encendida.
 */
const NOES_SEGUIDOS_PARA_RENDIRSE = 3;
let noesSeguidos = 0;
let apagadaPorFallos = false;

/** ¿Tenemos clave de servidor? Sin ella no se intenta nada. */
export function hayClaveGoogle() {
  return Boolean(process.env.GOOGLE_MAPS_SERVER_KEY);
}

/** ¿Vale la pena preguntarle a Google ahora mismo? */
export function googleDisponible() {
  return hayClaveGoogle() && !apagadaPorFallos;
}

/** Vuelve a intentarlo con Google aunque se hubiera rendido. */
export function reactivarGoogle() {
  noesSeguidos = 0;
  apagadaPorFallos = false;
}

/** Para la pantalla de configuración y el log de arranque. */
export function estadoGoogle() {
  return {
    hayClave: hayClaveGoogle(),
    disponible: googleDisponible(),
    apagadaPorFallos,
    noesSeguidos,
  };
}

/**
 * CUÁNTAS AVERÍAS LLEVAMOS, en total y desde siempre.
 *
 * Hace falta para distinguir dos cosas que devuelven lo mismo —`null`— y no se
 * parecen en nada:
 *
 *   · "He preguntado y esa dirección no existe."  → se arregla escribiéndola mejor.
 *   · "No he podido preguntar."                   → no se arregla tocando nada.
 *
 * Quien llama apunta el contador antes, mira después y sabe cuál de las dos
 * fue. Sin esto, la pantalla mandaba a corregir direcciones que estaban
 * perfectas mientras la clave llevaba semanas caída.
 */
let averias = 0;

export function contadorDeAverias() {
  return averias;
}

function apuntarFallo(donde, motivo) {
  noesSeguidos += 1;
  averias += 1;
  console.warn(`[google] ${donde}: ${motivo}`);
  if (noesSeguidos >= NOES_SEGUIDOS_PARA_RENDIRSE && !apagadaPorFallos) {
    apagadaPorFallos = true;
    console.warn(
      `[google] ${noesSeguidos} fallos seguidos: dejo de preguntar por un rato. ` +
        'Ya no hay respaldo: lo que dependa de esto lo dirá en pantalla. ' +
        'En local es lo normal, porque la clave está restringida a la IP del servidor.'
    );
  }
  return null;
}

function apuntarAcierto() {
  noesSeguidos = 0;
}

/** Un fetch con timeout que no lanza: devuelve `null` y ya. */
async function pedir(url, opciones, donde) {
  const control = new AbortController();
  const reloj = setTimeout(() => control.abort(), TIMEOUT_MS);
  try {
    const r = await fetch(url, { ...opciones, signal: control.signal });
    const cuerpo = await r.json().catch(() => null);

    if (!r.ok) {
      // El error de las APIs nuevas (Routes) viene en `error.message`, y ahí es
      // donde dice si el problema es la restricción de IP.
      const motivo = cuerpo?.error?.message || `HTTP ${r.status}`;
      return { fallo: apuntarFallo(donde, motivo) };
    }
    return { cuerpo };
  } catch (err) {
    const motivo = err.name === 'AbortError' ? `tardó más de ${TIMEOUT_MS / 1000} s` : err.message;
    return { fallo: apuntarFallo(donde, motivo) };
  } finally {
    clearTimeout(reloj);
  }
}

// =============================================================================
// GEOCODING: de una dirección a un punto
// =============================================================================
/**
 * Busca una dirección con Google.
 *
 * `cerca` es el nombre de la ciudad de la parada, y se pega al final cuando la
 * dirección tecleada no la lleva. "Calle Mayor 3" sin ciudad puede estar en
 * media España; "Calle Mayor 3, Madrid" no.
 *
 * Devuelve `{ direccion, lat, lng, fuente: 'google' }` o `null`.
 */
export async function geocodificarConGoogle(texto, { cerca = null } = {}) {
  if (!googleDisponible()) return null;

  const consulta = componerConsulta(texto, cerca);
  if (!consulta) return null;

  const url = new URL(URL_GEOCODING);
  url.searchParams.set('address', consulta);
  url.searchParams.set('language', 'es');
  url.searchParams.set('key', process.env.GOOGLE_MAPS_SERVER_KEY);

  const { cuerpo, fallo } = await pedir(url, { headers: { Accept: 'application/json' } }, 'geocoding');
  if (fallo !== undefined) return null;

  // Geocoding es de las APIs viejas: contesta 200 con un `status` de texto.
  // REQUEST_DENIED con la clave restringida por IP es exactamente lo que pasa
  // en local, y hay que contarlo como fallo para que la desactivación funcione.
  if (cuerpo?.status !== 'OK') {
    if (cuerpo?.status === 'ZERO_RESULTS') {
      apuntarAcierto();   // Google contestó bien: es que no existe esa dirección
      console.log(`[google] geocoding: sin resultados para «${consulta}»`);
      return null;
    }
    return apuntarFallo('geocoding', cuerpo?.error_message || cuerpo?.status || 'respuesta rara');
  }

  const primero = cuerpo.results?.[0];
  const sitio = primero?.geometry?.location;
  if (!sitio) return apuntarFallo('geocoding', 'respuesta sin coordenadas');

  apuntarAcierto();
  console.log(`[google] geocoding OK: «${consulta}» → ${primero.formatted_address}`);
  return {
    direccion: primero.formatted_address ?? consulta,
    lat: Number(sitio.lat),
    lng: Number(sitio.lng),
    fuente: 'google',
    // QUÉ CLASE DE SITIO ES Y SI GOOGLE DUDÓ.
    //
    // Google ya mandaba las dos cosas y aquí se tiraban. Son justo las que
    // distinguen «la ciudad de X» de «la provincia de X»: una `locality` es un
    // punto de una ciudad y un `administrative_area_level_1` es el centroide de
    // una región entera, que puede caer a cien kilómetros. Con el centroide
    // metido en la cuenta, dos saltos por carretera salieron al doble de los
    // kilómetros reales.
    //
    // `partial_match` es la otra mitad: Google lo pone cuando ha encontrado algo
    // parecido pero no lo que se le pidió, que es como se cuelan los homónimos.
    tipos: Array.isArray(primero.types) ? primero.types : [],
    parcial: primero.partial_match === true,
  };
}

/**
 * ¿ES ESTE PUNTO EL DE UNA CIUDAD, O EL DE UNA REGIÓN ENTERA?
 *
 * Se usa para decidir si un resultado de geocodificación vale para medir un
 * salto entre ciudades. Lo que vale es una `locality` (o su equivalente en los
 * países que usan `postal_town`); lo que NO vale es una división administrativa
 * ni un país, porque su punto es el centroide y no el sitio al que se viaja.
 */
export function pareceUnaCiudad(hallado) {
  if (!hallado) return false;
  const tipos = hallado.tipos ?? [];
  if (!tipos.length) return true; // sin dato no se acusa a nadie

  const DE_CIUDAD = ['locality', 'postal_town', 'sublocality', 'neighborhood', 'point_of_interest', 'establishment'];
  const DE_REGION = ['country', 'administrative_area_level_1', 'administrative_area_level_2', 'colloquial_area'];

  if (tipos.some((t) => DE_CIUDAD.includes(t))) return true;
  return !tipos.some((t) => DE_REGION.includes(t));
}

/** "Calle Mayor 3" + "Madrid" -> "Calle Mayor 3, Madrid". Sin repetir la ciudad. */
export function componerConsulta(texto, cerca) {
  const t = String(texto ?? '').trim();
  if (!t) return null;
  const c = String(cerca ?? '').trim();
  if (!c) return t;
  return t.toLowerCase().includes(c.toLowerCase()) ? t : `${t}, ${c}`;
}

// =============================================================================
// ROUTES: cuánto se tarda de aquí a allá
// =============================================================================
/**
 * Los tres modos que interesan al planificar un día, con el nombre que se ve en
 * pantalla. El transporte público es el que justifica pagar por Google: nadie
 * sabe de líneas de metro ni de horarios de autobús.
 */
export const MODOS = {
  andando: { etiqueta: 'andando', google: 'WALK', icono: 'ti-walk' },
  coche: { etiqueta: 'coche', google: 'DRIVE', icono: 'ti-car' },
  publico: { etiqueta: 'público', google: 'TRANSIT', icono: 'ti-bus' },
};

/**
 * Cuánto hay de `a` a `b`, en los modos que se pidan.
 *
 * Devuelve un array de `{ modo, minutos, km, fuente: 'google' }` con SOLO los
 * modos que Google supo contestar, o `null` si Google no está disponible. Un
 * array vacío también es una respuesta: significa "Google contestó, pero no hay
 * forma de ir así" —que es lo que pasa con el transporte público en un pueblo—.
 */
export async function rutasConGoogle(a, b, modos = Object.keys(MODOS)) {
  if (!googleDisponible()) return null;
  if (!punto(a) || !punto(b)) return null;

  const salidas = [];
  let algunaRespondio = false;

  for (const modo of modos) {
    const def = MODOS[modo];
    if (!def) continue;

    const cuerpoPeticion = {
      origin: { location: { latLng: { latitude: a.lat, longitude: a.lng } } },
      destination: { location: { latLng: { latitude: b.lat, longitude: b.lng } } },
      travelMode: def.google,
      languageCode: 'es',
      units: 'METRIC',
      // El modo coche admite pedir el tráfico de ahora; los otros no lo aceptan
      // y contestan 400 si se les manda.
      ...(def.google === 'DRIVE' ? { routingPreference: 'TRAFFIC_AWARE' } : {}),
    };

    const { cuerpo, fallo } = await pedir(
      URL_ROUTES,
      {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'X-Goog-Api-Key': process.env.GOOGLE_MAPS_SERVER_KEY,
          'X-Goog-FieldMask': 'routes.duration,routes.distanceMeters',
        },
        body: JSON.stringify(cuerpoPeticion),
      },
      `routes(${modo})`
    );
    if (fallo !== undefined) {
      // Si el primer modo ya falla por la clave, los otros dos van a fallar
      // igual: no se insiste tres veces para el mismo traslado.
      if (!googleDisponible()) return null;
      continue;
    }

    algunaRespondio = true;
    const ruta = cuerpo?.routes?.[0];
    if (!ruta) continue;   // sin ruta en ese modo: normal en TRANSIT fuera de ciudad

    salidas.push({
      modo,
      minutos: Math.max(1, Math.round(Number(String(ruta.duration).replace('s', '')) / 60)),
      km: ruta.distanceMeters != null ? Number(ruta.distanceMeters) / 1000 : null,
      fuente: 'google',
    });
  }

  if (!algunaRespondio) return null;

  apuntarAcierto();
  console.log(
    `[google] routes OK: ${salidas.map((s) => `${s.modo} ${s.minutos} min`).join(' · ') || 'sin rutas'}`
  );
  return salidas;
}

// =============================================================================
// PLACES: dónde comer
// =============================================================================
/**
 * PLACES ES LA API CARA, y todo lo de aquí abajo está escrito con eso en mente.
 *
 * Las otras dos que usamos son baratas o gratis; esta se paga por llamada y por
 * campo. Así que:
 *
 *   - La búsqueda pide LA MÁSCARA MÍNIMA. Cada campo de más sube el tramo de
 *     precio de toda la petición, no solo el de ese campo.
 *   - El teléfono, la web y los horarios NO se piden al buscar. Se piden al
 *     abrir una ficha concreta, una sola vez, y se guardan para siempre. De
 *     veinte restaurantes que salen en una búsqueda se abren dos.
 *   - Nada se pide dos veces: quien llama mira antes el catálogo.
 *
 * Es exactamente la misma disciplina que con las fichas de Civitatis, y por el
 * mismo motivo: pedir en masa lo que se lee de uno en uno es tirar el dinero.
 */

/**
 * Los campos de la BÚSQUEDA. Lo justo para pintar una ficha y poder elegir.
 *
 * `id` es imprescindible: es la llave para pedir los detalles después sin
 * volver a buscar. `location` también, porque con ella el restaurante no
 * necesita geocodificarse y nos ahorramos otra llamada distinta.
 */
const CAMPOS_BUSQUEDA = [
  'places.id',
  'places.displayName',
  'places.formattedAddress',
  'places.location',
  'places.rating',
  'places.userRatingCount',
  'places.priceLevel',
  'places.primaryTypeDisplayName',
].join(',');

/** Los campos del DETALLE. Solo lo que no vino ya en la búsqueda. */
const CAMPOS_FICHA = [
  'nationalPhoneNumber',
  'internationalPhoneNumber',
  'websiteUri',
  'googleMapsUri',
  'regularOpeningHours',
].join(',');

/** Los niveles de precio de Google, traducidos a lo que se lee. */
const PRECIO = {
  PRICE_LEVEL_FREE: 0,
  PRICE_LEVEL_INEXPENSIVE: 1,
  PRICE_LEVEL_MODERATE: 2,
  PRICE_LEVEL_EXPENSIVE: 3,
  PRICE_LEVEL_VERY_EXPENSIVE: 4,
};

/**
 * Busca sitios donde comer.
 *
 * `texto` es la consulta tal cual la escribe la persona ("cenar tranquilo cerca
 * del hotel"): Places entiende lenguaje natural y es justo lo que hace útil el
 * campo libre.
 *
 * `centro` y `radio` sesgan la búsqueda hacia una zona. No la limitan: es un
 * `locationBias`, así que si lo mejor está un poco más allá sale igualmente.
 * Es lo que hace falta para buscar "entre estos dos puntos".
 *
 * Devuelve un array (puede estar vacío: eso es una respuesta) o `null` si
 * Google no está disponible y hay que irse al plan B.
 */
export async function buscarSitiosConGoogle(
  texto,
  { centro = null, radio = null, cuantos = 12 } = {}
) {
  if (!googleDisponible()) return null;
  const consulta = String(texto ?? '').trim();
  if (!consulta) return null;

  const cuerpo = {
    textQuery: consulta,
    languageCode: 'es',
    maxResultCount: Math.min(Math.max(Number(cuantos) || 12, 1), 20),
    // SOLO COMIDA, y no es negociable.
    //
    // `includedType` por sí solo es una preferencia: Places lo tiene en cuenta
    // pero deja colarse otras cosas si el texto tira hacia ellas, y "sitios
    // cerca del hotel" tira hacia hoteles con todas sus fuerzas.
    // `strictTypeFiltering` lo convierte en un filtro de verdad: lo que no sea
    // restaurante, no sale.
    //
    // El matiz que escribe la persona REFINA —la cocina, el ambiente, la
    // zona—; no puede ampliar a otra clase de negocio.
    includedType: 'restaurant',
    strictTypeFiltering: true,
    ...(punto(centro) && radio
      ? {
          locationBias: {
            circle: {
              center: { latitude: centro.lat, longitude: centro.lng },
              // Places acepta entre 0 y 50 km.
              radius: Math.min(Math.max(Number(radio), 100), 50_000),
            },
          },
        }
      : {}),
  };

  const { cuerpo: datos, fallo } = await pedir(
    URL_PLACES_BUSCAR,
    {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-Goog-Api-Key': process.env.GOOGLE_MAPS_SERVER_KEY,
        'X-Goog-FieldMask': CAMPOS_BUSQUEDA,
      },
      body: JSON.stringify(cuerpo),
    },
    'places:buscar'
  );
  if (fallo !== undefined) return null;

  apuntarAcierto();
  const sitios = (datos?.places ?? []).map(comoFicha);
  console.log(`[google] places OK: ${sitios.length} sitio/s para «${consulta}»`);
  return sitios;
}

/**
 * SITUAR UN LUGAR QUE NO ES UN RESTAURANTE: un museo, una plaza, un mirador.
 *
 * `buscarSitiosConGoogle` no vale para esto: lleva `includedType: 'restaurant'`
 * con `strictTypeFiltering`, y preguntarle por el Museo del Prado devuelve
 * cero. Esta es la misma llamada sin ese filtro y pidiendo UN solo resultado.
 *
 * La máscara es la mínima que sirve: id, nombre, dirección y punto. Cada campo
 * de más sube el tramo de precio de toda la petición, no solo el suyo.
 *
 * Devuelve `{ nombre, direccion, lat, lng, placeId }`, `null` si Google no está
 * disponible, y `undefined`... no: nunca undefined. Un array vacío de Google se
 * traduce a `null` también, y quien llama distingue por el contador de averías.
 */
export async function situarLugarConGoogle(nombre, ciudad = null) {
  if (!googleDisponible()) return null;

  const consulta = componerConsulta(nombre, ciudad);
  if (!consulta) return null;

  const { cuerpo, fallo } = await pedir(
    URL_PLACES_BUSCAR,
    {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-Goog-Api-Key': process.env.GOOGLE_MAPS_SERVER_KEY,
        'X-Goog-FieldMask':
          'places.id,places.displayName,places.formattedAddress,places.location',
      },
      body: JSON.stringify({
        textQuery: consulta,
        languageCode: 'es',
        maxResultCount: 1,
      }),
    },
    'places:situar'
  );
  if (fallo !== undefined) return null;

  apuntarAcierto();
  const sitio = cuerpo?.places?.[0];
  if (!sitio) {
    console.log(`[google] places: sin resultado para «${consulta}»`);
    return null;
  }

  console.log(`[google] places situar OK: «${consulta}» → ${sitio.formattedAddress}`);
  return {
    nombre: sitio.displayName?.text ?? nombre,
    direccion: sitio.formattedAddress ?? null,
    lat: sitio.location?.latitude ?? null,
    lng: sitio.location?.longitude ?? null,
    placeId: sitio.id ?? null,
  };
}

/**
 * El detalle de UN sitio: teléfono, web, horarios.
 *
 * Se llama al abrir su ficha, nunca en masa. Devuelve `null` si Google no está.
 */
export async function detallesDeSitioConGoogle(placeId) {
  if (!googleDisponible()) return null;
  const id = String(placeId ?? '').trim();
  if (!id) return null;

  const url = new URL(`${URL_PLACES_FICHA}/${encodeURIComponent(id)}`);
  url.searchParams.set('languageCode', 'es');

  const { cuerpo, fallo } = await pedir(
    url,
    {
      headers: {
        'X-Goog-Api-Key': process.env.GOOGLE_MAPS_SERVER_KEY,
        'X-Goog-FieldMask': CAMPOS_FICHA,
        Accept: 'application/json',
      },
    },
    'places:ficha'
  );
  if (fallo !== undefined) return null;

  apuntarAcierto();
  console.log(`[google] places ficha OK: ${id}`);
  return {
    telefono: cuerpo?.nationalPhoneNumber ?? cuerpo?.internationalPhoneNumber ?? null,
    web: cuerpo?.websiteUri ?? null,
    urlMapa: cuerpo?.googleMapsUri ?? null,
    horarios: (cuerpo?.regularOpeningHours?.weekdayDescriptions ?? []).join(' · ') || null,
    fuente: 'places',
  };
}

/** Un `place` de Google, traducido a la forma que guarda el catálogo. */
function comoFicha(p) {
  return {
    claveUnica: p.id,
    nombre: p.displayName?.text ?? '(sin nombre)',
    cocina: p.primaryTypeDisplayName?.text ?? null,
    direccion: p.formattedAddress ?? null,
    valoracion: p.rating ?? null,
    numOpiniones: p.userRatingCount ?? null,
    precioNivel: PRECIO[p.priceLevel] ?? null,
    lat: p.location?.latitude ?? null,
    lng: p.location?.longitude ?? null,
    origen: 'places',
  };
}

const punto = (p) => p && Number.isFinite(Number(p.lat)) && Number.isFinite(Number(p.lng));
