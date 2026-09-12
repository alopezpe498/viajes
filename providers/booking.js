/**
 * providers/booking.js
 * -----------------------------------------------------------------------------
 * Proveedor "Booking.com" (hoteles). Mismo contrato de siempre.
 *
 *   buscarHoteles({ destino, fechaEntrada, fechaSalida, adultos, maxResultados })
 *     -> Promise<Array<{
 *          nombre, precioTotal, moneda, valoracion, numOpiniones,
 *          zona, direccion, estrellas, distanciaCentro, url, imagenUrl,
 *          // extras
 *          estrellasAutodeclaradas, esAnuncio, precioTexto, estanciaTexto
 *        }>>
 *
 * De los tres proveedores este es el mas susceptible a la deteccion de bots.
 * La estrategia es sencilla: hacer POCAS cosas y hacerlas despacio.
 *
 * =============================================================================
 * LA RECETA (flujo real observado navegando a mano el 05/09/2026)
 * =============================================================================
 *  1. NO usamos el formulario de la portada. Booking acepta una URL de busqueda
 *     ya rellena, asi que entramos directos a los resultados:
 *       https://www.booking.com/searchresults.es.html
 *         ?ss=<destino>&checkin=YYYY-MM-DD&checkout=YYYY-MM-DD
 *         &group_adults=N&group_children=0&no_rooms=1&selected_currency=EUR
 *     Un paso en vez de cinco: menos clics, menos superficie de deteccion.
 *  2. Banners que estorban (promociones, avisos). No suele haber modal de login
 *     si el perfil ya tiene sesion; aun asi los cerramos si aparecen.
 *  3. Las tarjetas son [data-testid="property-card"]. Booking usa data-testid
 *     por todas partes, que es lo mejor que nos puede pasar:
 *       title / title-link / image / address-link / distance
 *       review-score / price-and-discounted-price / price-for-x-nights
 *       rating-stars (estrellas oficiales) o rating-squares (autodeclaradas)
 *  4. CARGA DIFERIDA de verdad: llegan ~26 tarjetas y el resto entra por scroll,
 *     en tandas de ~25 (26 -> 51 -> 76). IMPORTANTE: bajar de golpe al final
 *     NO dispara la carga; hay que ir bajando poco a poco. Tras ~76 aparece un
 *     boton "Cargar mas resultados" que hay que pulsar (solo tiene clases
 *     ofuscadas, asi que lo buscamos por texto).
 * =============================================================================
 *
 * DOS AVISOS SOBRE LOS DATOS QUE DEVUELVE:
 *
 *  a) El precio es el TOTAL DE LA ESTANCIA para el numero de adultos pedido
 *     (Booking lo etiqueta "3 noches, 2 adultos"), no el precio por noche.
 *  b) Si el perfil persistente tiene la sesion de Booking iniciada, los precios
 *     llevan los descuentos Genius de esa cuenta. Es decir: los resultados son
 *     PERSONALIZADOS, no un precio publico universal. Para un uso personal es
 *     justo lo que quieres, pero conviene saberlo.
 */

import path from 'node:path';
import fs from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { precioDeTexto } from '../services/importes.js';
import {
  abrirNavegador,
  cerrarNavegador,
  comprobarCaptcha,
  dormir,
  pausaHumana,
  scrollHumano,
  TIMEOUT_LARGO,
} from '../lib/browser.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

const BASE = 'https://www.booking.com/searchresults.es.html';

/**
 * =============================================================================
 * FILTROS DE BUSQUEDA (parametro `nflt`)
 * =============================================================================
 * Booking mete TODOS los filtros en un unico parametro `nflt`, con pares
 * clave=valor separados por punto y coma:
 *
 *   nflt=hotelfacility%3D433%3Breview_score%3D80
 *        (una vez decodificado: "hotelfacility=433;review_score=80")
 *
 * Los codigos NO son adivinables: los saque del propio panel de filtros de
 * Booking, que marca cada casilla con un atributo `data-filters-item`, y luego
 * comprobe uno a uno que la URL construida a mano deja los filtros marcados y
 * cambia el numero de resultados.
 *
 * Comprobado el 05/09/2026 en Lisboa (2.896 alojamientos sin filtrar):
 *
 *   review_score=90   Fantastico: 9 o mas
 *   review_score=80   Muy bien: 8 o mas      -> 107 resultados con piscina, nota minima vista 8,0
 *   review_score=70   Bien: 7 o mas
 *   hotelfacility=433 Piscina
 *   hotelfacility=107 WiFi gratis
 *   hotelfacility=2   Parking
 *   price=EUR-60-150-1  Precio POR NOCHE entre 60 y 150 EUR
 *                       (el "-1" del final es el modo "por noche";
 *                        comprobado: los resultados salieron de 61 a 140 EUR/noche)
 *
 * Segunda tanda, comprobada igual sobre Lisboa (3.460 alojamientos sin filtrar):
 *
 *   class=1..5        Estrellas, por valor EXACTO. Booking no tiene "3 o mas":
 *                     hay que mandar una por cada estrella que valga. O sea que
 *                     "4+" se escribe class=4;class=5.
 *                     -> class=4;class=5 + mealplan=1 dio 272 resultados, y en
 *                        las tarjetas solo salieron hoteles de 4 y 5 estrellas.
 *   mealplan=1        Desayuno incluido
 *   fc=2              Cancelacion gratis
 *                     -> fc=2;ht_id=204 dio 332 resultados y las 26 tarjetas
 *                        visibles llevaban todas "Cancelacion gratis".
 *   ht_id=204         Hoteles
 *   ht_id=201         Apartamentos
 *
 * OJO, LO QUE NO EXISTE: Booking NO ofrece "aire acondicionado" ni
 * "calefaccion" como filtro de busqueda. Lo comprobe desplegando la lista
 * entera de filtros en dos destinos distintos (Lisboa en octubre y Sevilla en
 * agosto, donde el aire seria el filtro mas pedido del mundo): hay 14
 * `hotelfacility` y 25 `roomfacility`, y ninguno es el aire ni la calefaccion.
 * Por eso esos dos no estan en el panel: prefiero no poner un interruptor que
 * no hace nada.
 */
export const FILTROS_BOOKING = {
  notaMinima: { 7: 'review_score=70', 8: 'review_score=80', 9: 'review_score=90' },

  // Estrellas: hay que enumerar las que valen, porque Booking filtra por valor
  // exacto y no por "de aqui para arriba".
  estrellas: {
    3: ['class=3', 'class=4', 'class=5'],
    4: ['class=4', 'class=5'],
    5: ['class=5'],
  },

  comodidades: {
    piscina: 'hotelfacility=433',
    wifi: 'hotelfacility=107',
    parking: 'hotelfacility=2',
    desayuno: 'mealplan=1',
  },

  condiciones: {
    cancelacionGratis: 'fc=2',
  },

  tipoAlojamiento: {
    hotel: 'ht_id=204',
    apartamento: 'ht_id=201',
  },

  // Distancia al centro, en los tres escalones que ofrece Booking. El valor va
  // en METROS y solo valen esos tres: no acepta un radio a medida.
  distanciaCentro: {
    1: 'distance=1000',
    3: 'distance=3000',
    5: 'distance=5000',
  },
};

/**
 * Monta el valor del parametro `nflt` a partir de los filtros del viaje.
 * Devuelve null si no hay ningun filtro activo (asi la URL queda limpia).
 */
export function construirNflt(filtros = {}) {
  const trozos = [];

  // Precio POR NOCHE. Booking acepta que falte un extremo, pero es mas fiable
  // mandar siempre los dos: si no pones minimo va 0, y si no pones maximo
  // usamos un tope muy alto que en la practica no recorta nada.
  const min = Number(filtros.precioMin) || 0;
  const max = Number(filtros.precioMax) || 0;
  if (min > 0 || max > 0) {
    trozos.push(`price=EUR-${min}-${max > 0 ? max : 10000}-1`);
  }

  const nota = FILTROS_BOOKING.notaMinima[Number(filtros.notaMinima)];
  if (nota) trozos.push(nota);

  const estrellas = FILTROS_BOOKING.estrellas[Number(filtros.estrellas)];
  if (estrellas) trozos.push(...estrellas);

  for (const [clave, codigo] of Object.entries(FILTROS_BOOKING.comodidades)) {
    if (filtros[clave]) trozos.push(codigo);
  }

  for (const [clave, codigo] of Object.entries(FILTROS_BOOKING.condiciones)) {
    if (filtros[clave]) trozos.push(codigo);
  }

  const tipo = FILTROS_BOOKING.tipoAlojamiento[filtros.tipoAlojamiento];
  if (tipo) trozos.push(tipo);

  // DISTANCIA AL CENTRO. Antes era solo un filtro local sobre las tarjetas ya
  // leidas, y eso estaba mal: Booking devuelve sus "opciones recomendadas", que
  // no vienen ordenadas por distancia, asi que de las 20 primeras podian salir
  // cero centricas aunque la ciudad tuviera cientos. El filtro local descartaba
  // 18 de 20 y el orquestador acababa aflojando el PRECIO para nada.
  // Ahora se le pide a Booking, que si sabe buscar por radio.
  const radio = FILTROS_BOOKING.distanciaCentro[String(filtros.distanciaMax)];
  if (radio) trozos.push(radio);

  return trozos.length ? trozos.join(';') : null;
}

/** Selector raiz de una tarjeta de alojamiento. */
const SEL_TARJETA = '[data-testid="property-card"]';

/** Tope de seguridad para el bucle de scroll. */
const MAX_VUELTAS_SCROLL = 60;

/** Error que lleva dentro el nombre del paso de la receta que ha fallado. */
class ErrorReceta extends Error {
  constructor(paso, causa) {
    super(
      `[booking] Fallo el paso "${paso}". ` +
        'Probablemente el selector ha cambiado: revisa la receta en providers/booking.js.\n' +
        `  Detalle: ${causa?.message ?? causa}`
    );
    this.name = 'ErrorReceta';
    this.paso = paso;
    this.causa = causa;
  }
}

/** Ejecuta un paso de la receta y, si falla, lo envuelve con un mensaje claro. */
async function paso(nombre, fn) {
  console.log(`  . ${nombre}...`);
  try {
    return await fn();
  } catch (err) {
    throw new ErrorReceta(nombre, err);
  }
}

/** Comprueba que una fecha viene como YYYY-MM-DD y que existe en el calendario. */
function validarFecha(valor, nombreCampo) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(valor)) {
    throw new Error(`[booking] ${nombreCampo} debe tener el formato YYYY-MM-DD. Recibido: "${valor}".`);
  }
  const d = new Date(`${valor}T12:00:00`);
  const dos = (n) => String(n).padStart(2, '0');
  const reconstruida = `${d.getFullYear()}-${dos(d.getMonth() + 1)}-${dos(d.getDate())}`;
  if (Number.isNaN(d.getTime()) || reconstruida !== valor) {
    throw new Error(`[booking] ${nombreCampo} no es una fecha que exista: "${valor}".`);
  }
  return d;
}

/** Guarda una captura para poder ver que habia en pantalla cuando algo fallo. */
async function capturaDeFallo(pagina, etiqueta) {
  try {
    const dir = path.join(__dirname, '..', 'capturas');
    await fs.mkdir(dir, { recursive: true });
    const ruta = path.join(dir, `fallo-booking-${etiqueta}-${Date.now()}.png`);
    await pagina.screenshot({ path: ruta, fullPage: false });
    console.error(`  [i] Captura del fallo guardada en: ${ruta}`);
  } catch {
    /* si ni siquiera podemos capturar, seguimos adelante */
  }
}

/**
 * PASO 2: cerrar lo que estorbe.
 *
 * Booking va soltando banners promocionales, avisos de cookies y, si no hay
 * sesion, un modal de "inicia sesion". Ninguno es obligatorio, asi que lo
 * intentamos con espera CORTA y seguimos aunque no aparezca nada.
 *
 * En las cookies elegimos siempre rechazar las no esenciales.
 */
async function cerrarEstorbos(pagina) {
  const candidatos = [
    // Cookies (OneTrust). Primero rechazar; el "aceptar" no lo tocamos.
    { nombre: 'cookies', loc: pagina.locator('#onetrust-reject-all-handler') },
    { nombre: 'cookies', loc: pagina.locator('#onetrust-pc-sdk .ot-pc-refuse-all-handler') },
    // Banner promocional de la propia Booking.
    { nombre: 'banner', loc: pagina.locator('[data-testid="promotional-banner-dismissible-button"]') },
    { nombre: 'banner', loc: pagina.locator('button[aria-label="Cerrar el banner"]') },
    // Modal de registro / inicio de sesion.
    { nombre: 'login', loc: pagina.locator('[data-testid="dismiss-sign-in-info"]') },
    { nombre: 'login', loc: pagina.locator('button[aria-label*="Descartar" i]') },
    { nombre: 'modal', loc: pagina.locator('[role="dialog"] button[aria-label*="Cerrar" i]') },
  ];

  const cerrados = [];
  for (const { nombre, loc } of candidatos) {
    const boton = loc.first();
    // Espera CORTA: son siete candidatos y casi ninguno va a estar. Ya hemos
    // dado un respiro tras cargar la pagina, asi que lo visible ya esta pintado.
    if (await boton.isVisible({ timeout: 500 }).catch(() => false)) {
      await boton.click().catch(() => {}); // si se cierra solo mientras tanto, da igual
      cerrados.push(nombre);
      await pausaHumana(400, 900);
    }
  }

  console.log(cerrados.length ? `    (cerrados: ${[...new Set(cerrados)].join(', ')})` : '    (no habia nada que cerrar)');
  return cerrados;
}

/**
 * PASO 4: bajar poco a poco hasta tener suficientes tarjetas.
 *
 * Ojo con dos cosas aprendidas a base de probar:
 *  - Un window.scrollTo(0, scrollHeight) NO carga mas resultados. Hay que ir
 *    bajando por tramos, que es ademas lo que haria una persona.
 *  - Cuando el contador se estanca no siempre significa "ya no hay mas":
 *    puede que haya aparecido el boton "Cargar mas resultados".
 */
async function cargarHastaTener(pagina, objetivo) {
  let ultimoConteo = 0;
  let vueltasSinCambio = 0;

  for (let vuelta = 0; vuelta < MAX_VUELTAS_SCROLL; vuelta++) {
    const conteo = await pagina.locator(SEL_TARJETA).count();

    if (conteo >= objetivo) return conteo;

    if (conteo === ultimoConteo) {
      vueltasSinCambio++;
    } else {
      vueltasSinCambio = 0;
      ultimoConteo = conteo;
    }

    // Si el contador no se mueve, miramos SIEMPRE si ha salido el boton: Booking
    // hace scroll infinito solo durante las primeras tandas (~76 tarjetas) y a
    // partir de ahi exige pulsar "Cargar mas resultados".
    if (vueltasSinCambio >= 1) {
      const cargarMas = pagina.getByRole('button', { name: /cargar m[aá]s resultados/i }).first();
      if (await cargarMas.isVisible().catch(() => false)) {
        console.log(`    (pulsando "Cargar mas resultados" con ${conteo} tarjetas)`);
        await cargarMas.scrollIntoViewIfNeeded().catch(() => {});
        await pausaHumana(300, 700);
        await cargarMas.click();
        vueltasSinCambio = 0;
        await pausaHumana(1200, 2200); // le damos aire para pintar la tanda
        continue;
      }
    }

    // Paciencia: una tanda tarda un par de segundos en inyectarse. Solo damos
    // el listado por terminado tras varias vueltas sin que entre nada Y sin
    // boton a la vista.
    if (vueltasSinCambio >= 6) {
      console.log(`    (no entran mas alojamientos: nos quedamos con ${conteo})`);
      return conteo;
    }

    const alFinal = await scrollHumano(pagina); // pausa irregular de 500-2000 ms incluida

    // REBOTE. Cuando ya estas abajo del todo, seguir mandando scrollBy hacia
    // abajo no mueve nada y por tanto NO genera evento de scroll: el observador
    // de Booking no se entera y el listado se queda clavado (nos pasaba: 50
    // tarjetas y a callar). Subimos un poco y volvemos a bajar, que genera
    // eventos de verdad y es exactamente lo que hace una persona que llega al
    // final y retrocede un momento.
    if (alFinal && vueltasSinCambio >= 1) {
      await pagina.evaluate(() => window.scrollBy(0, -Math.round(window.innerHeight * 1.5)));
      await pausaHumana(400, 900);
      await pagina.evaluate(() => window.scrollTo(0, document.body.scrollHeight));
      await pausaHumana(900, 1600);
    }
  }

  return pagina.locator(SEL_TARJETA).count();
}

/**
 * PASO 5: leer las tarjetas.
 * Se ejecuta DENTRO del navegador, asi que no puede usar nada del ambito Node.
 */
function extraerHotelesDelDOM() {
  const txt = (el) => (el ? el.innerText.replace(/\s+/g, ' ').trim() : null);

  /** "1.138" -> 1138 · "9,3" -> 9.3 · "a 5,2 km" -> 5.2 */
  const aNumero = (s) => {
    if (!s) return null;
    const m = /(\d[\d.]*(?:,\d+)?)/.exec(s);
    if (!m) return null;
    const n = Number(m[1].replace(/\./g, '').replace(',', '.'));
    return Number.isFinite(n) ? n : null;
  };

  return [...document.querySelectorAll('[data-testid="property-card"]')].map((card) => {
    const enlace = card.querySelector('[data-testid="title-link"]');
    const imagen = card.querySelector('[data-testid="image"]');

    // --- Valoracion -------------------------------------------------------
    // El bloque dice: "Puntuacion: 9,3 9,3 Fantastico 129 comentarios"
    const bloqueReview = txt(card.querySelector('[data-testid="review-score"]'));
    const mValoracion = bloqueReview ? /(\d+(?:[.,]\d+)?)/.exec(bloqueReview) : null;
    const mOpiniones = bloqueReview
      ? /([\d.]+)\s*(?:comentarios|opiniones)/i.exec(bloqueReview)
      : null;

    // --- Estrellas --------------------------------------------------------
    // Hay DOS testids distintos y significan cosas distintas:
    //   rating-stars   -> estrellas oficiales del hotel
    //   rating-squares -> "calidad" que se autodeclara el apartamento
    // Ademas el aria-label NO esta en el propio elemento (que es role="img"),
    // sino en el <button> que lo envuelve: por eso usamos closest().
    const bloqueEstrellas =
      card.querySelector('[data-testid="rating-stars"]') ??
      card.querySelector('[data-testid="rating-squares"]');
    let estrellas = null;
    let autodeclaradas = null;
    if (bloqueEstrellas) {
      autodeclaradas = bloqueEstrellas.getAttribute('data-testid') === 'rating-squares';
      const aria = bloqueEstrellas.closest('[aria-label]')?.getAttribute('aria-label') ?? '';
      const m = /(\d+)\s*de\s*5/i.exec(aria);
      // Si el aria-label cambiara, queda el respaldo de contar los iconos.
      estrellas = m ? Number(m[1]) : bloqueEstrellas.children.length || null;
    }

    // --- Precio -----------------------------------------------------------
    // price-and-discounted-price trae ya SOLO el precio final ("€ 1.138");
    // el tachado del precio original vive en un hermano y no nos estorba.
    const precioTexto = txt(card.querySelector('[data-testid="price-and-discounted-price"]'));
    const mMoneda = precioTexto ? /([€$£])|\b(EUR|USD|GBP)\b/.exec(precioTexto) : null;

    // EL PRECIO SE DEVUELVE EN CRUDO Y SE LEE FUERA.
    //
    // Aqui dentro no se puede importar nada —esto corre en el navegador— y el
    // lector de precios que habia, escrito a mano, daba por hecho el formato
    // europeo: convertia "THB 4,500" en 4,5. Un hotel de cuatro mil quinientos
    // bats pasaba por uno de cuatro euros con cincuenta y nadie mira dos veces
    // un hotel barato.
    //
    // El texto sale tal cual y lo lee `services/importes.js`, que si se puede
    // probar con casos. Una sola verdad sobre como se lee un precio.
    return {
      nombre: txt(card.querySelector('[data-testid="title"]')),
      monedaCruda: mMoneda ? (mMoneda[1] ?? mMoneda[2]) : null,
      precioTexto,
      valoracion: mValoracion ? aNumero(mValoracion[1]) : null,
      numOpiniones: mOpiniones ? aNumero(mOpiniones[1]) : null,
      zona: txt(card.querySelector('[data-testid="address-link"]')),
      // LA DIRECCION, con tres sitios donde mirar.
      //
      // Booking no la pone siempre en el mismo elemento de la tarjeta: a veces
      // hay un `address` con la calle, a veces solo el `address-link` con el
      // barrio ("Centro de Madrid, Madrid"). Se cogen en orden de mas concreto
      // a menos, y lo que salga es un punto de partida EDITABLE: la ficha deja
      // corregirlo a mano si viene mal o viene corto.
      direccion:
        txt(card.querySelector('[data-testid="address"]')) ??
        txt(card.querySelector('[data-testid="location"]')) ??
        txt(card.querySelector('[data-testid="address-link"]')),
      estrellas,
      estrellasAutodeclaradas: autodeclaradas,
      distanciaCentro: txt(card.querySelector('[data-testid="distance"]')),
      url: enlace ? enlace.href.split('?')[0] : null, // sin la coleta de parametros
      imagenUrl: imagen ? imagen.getAttribute('src') : null,
      estanciaTexto: txt(card.querySelector('[data-testid="price-for-x-nights"]')),
      // Booking intercala resultados patrocinados entre los organicos.
      esAnuncio: /^\s*(anuncio|sponsored)\b/i.test(card.innerText ?? ''),
    };
  });
}

/** "€" -> "EUR". Si no reconocemos el simbolo, lo devolvemos tal cual. */
function normalizarMoneda(simbolo) {
  if (!simbolo) return null;
  const mapa = { '€': 'EUR', $: 'USD', '£': 'GBP' };
  return mapa[simbolo] ?? simbolo;
}

/**
 * =============================================================================
 * FUNCION PUBLICA DEL PROVEEDOR
 * =============================================================================
 * @param {object} opciones
 * @param {string} opciones.destino        Ciudad o zona ("Paris", "Oviedo")
 * @param {string} opciones.fechaEntrada   "YYYY-MM-DD"
 * @param {string} opciones.fechaSalida    "YYYY-MM-DD"
 * @param {number} [opciones.adultos]      2 por defecto
 * @param {number[]} [opciones.edadesNinos] Edades de los niños, p.ej. [4, 9].
 *        Booking necesita la EDAD de cada niño, no solo cuántos son: el precio
 *        y la disponibilidad cambian según la edad (cunas, camas supletorias).
 * @param {object} [opciones.filtros] Filtros de busqueda (ver FILTROS_BOOKING)
 * @param {number} [opciones.maxResultados] 20 por defecto
 */
export async function buscarHoteles({
  destino,
  fechaEntrada,
  fechaSalida,
  adultos = 2,
  edadesNinos = [],
  filtros = {},
  maxResultados = 20,
}) {
  if (!destino || !String(destino).trim()) {
    throw new Error('[booking] Falta el destino.');
  }
  const entrada = validarFecha(fechaEntrada, 'fechaEntrada');
  const salida = validarFecha(fechaSalida, 'fechaSalida');
  if (salida <= entrada) {
    throw new Error(
      `[booking] La fechaSalida (${fechaSalida}) debe ser posterior a la fechaEntrada (${fechaEntrada}).`
    );
  }
  if (!Number.isInteger(adultos) || adultos < 1) {
    throw new Error(`[booking] adultos debe ser un entero positivo (recibido: ${adultos}).`);
  }
  if (!Number.isInteger(maxResultados) || maxResultados < 1) {
    throw new Error(`[booking] maxResultados debe ser un entero positivo (recibido: ${maxResultados}).`);
  }

  const edades = (edadesNinos ?? [])
    .map(Number)
    .filter((e) => Number.isInteger(e) && e >= 0 && e <= 17);

  // PASO 1: montamos la URL de resultados ya rellena.
  const params = new URLSearchParams({
    ss: String(destino).trim(),
    checkin: fechaEntrada,
    checkout: fechaSalida,
    group_adults: String(adultos),
    group_children: String(edades.length),
    no_rooms: '1',
    selected_currency: 'EUR',
  });

  // Filtros de busqueda: van todos juntos en el parametro `nflt`.
  const nflt = construirNflt(filtros);
  if (nflt) params.set('nflt', nflt);

  // Booking pide una edad por niño, repitiendo el parámetro "age".
  // OJO: esto NO está probado en vivo todavía (el wizard sigue con hoteles
  // falsos). Cuando se conecte, es lo primero que hay que verificar: que el
  // selector de ocupación de la página muestre los niños y sus edades.
  for (const edad of edades) params.append('age', String(edad));

  const url = `${BASE}?${params.toString()}`;

  const { contexto, pagina } = await abrirNavegador({ de: 'Booking' });

  try {
    await paso(`1. Abrir resultados de "${destino}"`, async () => {
      // Dejamos la URL en el log: asi se comprueba de un vistazo que fechas y
      // viajeros han llegado bien (checkin/checkout, group_adults,
      // group_children y un "age" por cada nino).
      console.log(`    URL: ${url}`);
      await pagina.goto(url, { waitUntil: 'domcontentloaded', timeout: TIMEOUT_LARGO });
      // Un respiro antes de tocar nada, como quien llega y lee la pantalla.
      await pausaHumana(900, 1800);
    });

    // Antes que nada: si nos han puesto un muro, paramos y avisamos.
    await comprobarCaptcha(pagina, { paso: 'resultados de busqueda' });

    // PASO 2: quitar de en medio banners y modales.
    await paso('2. Cerrar banners y modales', () => cerrarEstorbos(pagina));

    // PASO 3: confirmar que el listado esta ahi.
    await paso('3. Esperar el listado de alojamientos', async () => {
      // TRES COSAS DISTINTAS SE PARECEN AQUI, y confundirlas cuesta caro:
      //
      //   1. El challenge antibot. Booking mete una pagina de verificacion antes
      //      del listado y la URL se queda con `chal_t`. Un Chrome con cookies lo
      //      pasa solo; un Chromium de Playwright con perfil recien hecho, no. El
      //      listado no llega nunca y esto se leia como «no hay hoteles».
      //   2. La busqueda valida SIN resultados: la pagina carga entera, con sus
      //      filtros y su «0 alojamientos encontrados». No es un fallo de nadie.
      //   3. El selector cambiado: ni listado, ni mensaje, ni challenge.
      //
      // La reaccion es distinta en cada caso, asi que se distinguen antes.
      const esperarListado = () =>
        pagina.locator(SEL_TARJETA).first().waitFor({ state: 'visible', timeout: TIMEOUT_LARGO });

      const hayChallenge = async () => {
        if (/[?&]chal_t=/.test(pagina.url())) return true;
        return (
          (await pagina
            .locator(
              'iframe[src*="challenge"], iframe[title*="challenge" i], ' +
                '[id*="challenge" i], [class*="challenge" i], ' +
                'text=/verificando que eres|verifying you are|no soy un robot/i'
            )
            .count()
            .catch(() => 0)) > 0
        );
      };

      try {
        await esperarListado();
        return;
      } catch (err) {
        if (!(await hayChallenge())) {
          const sinResultados = await pagina
            .locator('text=/no (hemos encontrado|se han encontrado)|sin resultados/i')
            .count()
            .catch(() => 0);
          if (sinResultados) {
            const vacio = new Error(
              `Booking no devuelve alojamientos para "${destino}" con esos filtros y esas fechas.`
            );
            vacio.sinResultados = true;
            throw vacio;
          }
          throw err;
        }

        // ES EL CHALLENGE: ni se aflojan filtros ni se da por vacia la busqueda.
        //
        // Se espera y se repite LA MISMA busqueda. El primer intento ya ha
        // sembrado la cookie en el perfil persistente, que es exactamente por lo
        // que el segundo intento —el del radio aflojado— «funcionaba»: llegaba
        // segundo, no llegaba mejor. Con esto el merito vuelve a quien lo tiene y
        // el usuario ve los hoteles de su filtro de verdad.
        console.warn('[booking] Challenge antibot detectado. Espero y repito la MISMA busqueda.');
        await dormir(5000);
        await pagina.reload({ waitUntil: 'domcontentloaded' }).catch(() => {});
        await pausaHumana(1500, 2500);

        try {
          await esperarListado();
          console.log('[booking] El challenge ha pasado: sigo con los mismos filtros.');
          return;
        } catch (err2) {
          if (await hayChallenge()) {
            const muro = new Error(
              'Booking sigue pidiendo verificacion tras dos intentos. Con Chrome del sistema ' +
                'y un perfil con cookies esto no deberia pasar: mira RUTA_CHROME en el .env.'
            );
            muro.porChallenge = true;
            throw muro;
          }
          const sinResultados = await pagina
            .locator('text=/no (hemos encontrado|se han encontrado)|sin resultados/i')
            .count()
            .catch(() => 0);
          if (sinResultados) {
            const vacio = new Error(
              `Booking no devuelve alojamientos para "${destino}" con esos filtros y esas fechas.`
            );
            vacio.sinResultados = true;
            throw vacio;
          }
          throw err2;
        }
      }
    });

    // PASO 4: carga diferida.
    // Antes de ponernos a hacer scroll, dejamos que termine de pintar la primera
    // tanda (llegan ~26 de golpe). Si no esperamos, contariamos 5 o 6 tarjetas y
    // nos pondriamos a bajar sin necesidad, cargando el doble de lo que pediste.
    const cargadas = await paso(`4. Cargar hasta ${maxResultados} alojamientos`, async () => {
      await pausaHumana(1200, 2000);
      return cargarHastaTener(pagina, maxResultados);
    });
    console.log(`    (${cargadas} tarjetas en el DOM)`);

    // PASO 5: leer.
    const crudos = await paso('5. Leer las tarjetas', () => pagina.evaluate(extraerHotelesDelDOM));

    if (!crudos.length) {
      // DOS COSAS DISTINTAS QUE SE CONTABAN IGUAL.
      //
      // «El selector ha cambiado: revisa la receta» cuando lo que pasaba era que
      // no hay hoteles libres esas noches. Mandaba a mirar el codigo durante una
      // hora por algo que no tiene nada que ver con el codigo.
      //
      // Se distinguen por lo que HAY en la pagina: si Booking dice que no hay
      // resultados —o si la pagina cargo entera y simplemente no hay tarjetas—
      // la receta funciona perfectamente y la respuesta es «no hay».
      const vacio = await pagina.evaluate(() => {
        const t = document.body?.innerText?.toLowerCase() ?? '';
        return (
          t.includes('no hay disponibilidad') ||
          t.includes('no encontramos') ||
          t.includes('no se han encontrado') ||
          t.includes('sin resultados') ||
          t.includes('no properties found') ||
          t.includes('no results') ||
          // «Gdansk: 0 alojamientos encontrados», que es como lo escribe la
          // cabecera de resultados.
          /\b0\s+(?:alojamientos|properties)\b/.test(t)
        );
        // NO VALE mirar si existe el buscador: existe en TODAS las paginas de
        // resultados, asi que daba «sin resultados» siempre y la rama de «el
        // selector ha cambiado» se volvia inalcanzable. Un detector que nunca
        // dice que no, no detecta nada.
      });

      if (vacio) {
        const err = new Error(
          '[booking] Busqueda correcta, pero no hay alojamientos para esas fechas y esos filtros.'
        );
        err.sinResultados = true;
        throw err;
      }

      throw new ErrorReceta(
        '5. Leer las tarjetas',
        new Error(`La pagina cargo pero no aparece ninguna tarjeta ${SEL_TARJETA} ni el mensaje de "sin resultados"`)
      );
    }

    // Normalizacion al contrato comun, recortando a lo pedido.
    return crudos.slice(0, maxResultados).map((h) => {
      // El texto del precio manda: trae el numero Y la moneda, y las dos cosas
      // se leen con las mismas reglas.
      const precio = precioDeTexto(h.precioTexto);
      return {
      nombre: h.nombre,
      precioTotal: precio?.importe ?? null,
      // `enEuros` viene a null cuando el precio esta en moneda local: no se
      // convierte a ciegas ni se hace pasar por euros, que es lo que hacia
      // reventar el presupuesto del viaje de Asia.
      precioEnEuros: precio?.enEuros ?? null,
      moneda: precio?.moneda ?? normalizarMoneda(h.monedaCruda),
      valoracion: h.valoracion,
      numOpiniones: h.numOpiniones,
      zona: h.zona,
      direccion: h.direccion,
      estrellas: h.estrellas,
      distanciaCentro: h.distanciaCentro,
      url: h.url,
      imagenUrl: h.imagenUrl,
      // extras
      estrellasAutodeclaradas: h.estrellasAutodeclaradas,
      esAnuncio: h.esAnuncio,
      precioTexto: h.precioTexto,
      estanciaTexto: h.estanciaTexto,
      };
    });
  } catch (err) {
    await capturaDeFallo(pagina, err.paso ? err.paso.split('.')[0] : 'error');
    throw err;
  } finally {
    // Una pausa antes de cerrar: nada de abrir y cerrar de golpe.
    await dormir(500);
    await cerrarNavegador(contexto);
  }
}

export default { buscarHoteles };
