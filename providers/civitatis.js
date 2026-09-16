/**
 * providers/civitatis.js
 * -----------------------------------------------------------------------------
 * Proveedor "Civitatis" (actividades y excursiones). Mismo contrato de siempre:
 * una funcion que recibe un objeto y devuelve una promesa con un array de
 * objetos ya normalizados.
 *
 *   buscarActividades({ destino, maxResultados = 30 })
 *     -> Promise<Array<{
 *          titulo, precio, moneda, duracion,
 *          valoracion, numOpiniones, url, imagenUrl,
 *          precioTexto   // extra: conserva el literal ("desde 25 €", "¡Gratis!")
 *        }>>
 *
 * Los campos que no existan en una tarjeta se devuelven como null: hay muchas
 * actividades sin valoracion (recien publicadas) o sin duracion (entradas).
 *
 * =============================================================================
 * LA RECETA (flujo real observado navegando a mano el 05/09/2026)
 * =============================================================================
 *  1. La URL de un destino es directa: https://www.civitatis.com/es/<slug>/
 *     El slug es el nombre de la ciudad en minusculas, sin acentos y con
 *     guiones ("berlin", "nueva-york"). Si el slug no existe, Civitatis
 *     REDIRIGE A LA PORTADA (/es/) en vez de dar un 404: lo detectamos.
 *  2. Banner de cookies: usan Didomi -> #didomi-notice-disagree-button
 *     ("Rechazar todo").
 *  3. El listado vive en #activities-container y cada actividad es un
 *     .o-search-list__item que contiene un <article class="comfort-card">:
 *       - .comfort-card__title              -> titulo
 *       - .comfort-card__price-wrapper      -> precio (ver nota abajo)
 *       - .comfort-card__feature._duration  -> duracion ("5h - 6h 30m")
 *       - .m-rating--text                   -> valoracion ("9,4 / 10")
 *       - .text--rating-total               -> nº de opiniones ("15.778 opiniones")
 *       - a[href]                           -> url de la actividad
 *       - img                               -> imagen (carga diferida con bLazy)
 *  4. OJO, ESTO NO ES LAZY LOAD: el listado NO carga mas actividades al hacer
 *     scroll. Son 20 por pagina con PAGINACION CLASICA; el enlace "siguiente"
 *     es <a class="next-element"> y apunta a /es/<slug>/2/, /3/...
 *     En la ultima pagina ese enlace sencillamente no existe.
 *     Aun asi hacemos scroll progresivo en cada pagina, porque las imagenes SI
 *     son diferidas y porque asi el recorrido se parece mas al de una persona.
 * =============================================================================
 *
 * Nota sobre el precio: en la tarjeta conviven DOS bloques de precio (Civitatis
 * esta probando un diseño nuevo, el contenedor lleva la clase "_testA") y solo
 * uno esta visible. Por eso leemos innerText del wrapper y no textContent:
 * innerText respeta el CSS y devuelve unicamente el que se ve.
 *   textContent -> "desde25€ desde 25 €"   (los dos, inservible)
 *   innerText   -> "desde 25 €"            (solo el visible)
 */

import path from 'node:path';
import fs from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import {
  abrirNavegador,
  cerrarNavegador,
  comprobarCaptcha,
  dormir,
  pausaHumana,
  TIMEOUT_LARGO,
} from '../lib/browser.js';
// La cache de slugs vive en la base: un descubrimiento por ciudad y para siempre.
import { una, ejecutar } from '../db/index.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

const BASE = 'https://www.civitatis.com/es';

/** Tope de seguridad: nunca recorremos mas paginas que esto. */
const MAX_PAGINAS = 10;

/** Error que lleva dentro el nombre del paso de la receta que ha fallado. */
class ErrorReceta extends Error {
  constructor(paso, causa) {
    super(
      `[civitatis] Fallo el paso "${paso}". ` +
        'Probablemente el selector ha cambiado: revisa la receta en providers/civitatis.js.\n' +
        `  Detalle: ${causa?.message ?? causa}`
    );
    this.name = 'ErrorReceta';
    this.paso = paso;
    this.causa = causa;
  }
}

/**
 * Error de ENTRADA, no de receta: el destino que has pedido no existe.
 * Se distingue del ErrorReceta porque aqui no hay nada que arreglar en el
 * codigo, solo escribir bien la ciudad.
 */
class ErrorDestino extends Error {
  constructor(mensaje) {
    super(mensaje);
    this.name = 'ErrorDestino';
  }
}

/** Ejecuta un paso de la receta y, si falla, lo envuelve con un mensaje claro. */
async function paso(nombre, fn) {
  console.log(`  . ${nombre}...`);
  try {
    return await fn();
  } catch (err) {
    // Un destino inexistente no es un selector roto: se propaga tal cual.
    if (err instanceof ErrorDestino) throw err;
    throw new ErrorReceta(nombre, err);
  }
}

/**
 * Convierte el nombre de una ciudad en el slug que usa Civitatis en su URL:
 * minusculas, sin acentos, espacios a guiones.
 *   "Nueva York" -> "nueva-york" · "Berlín" -> "berlin" · "Estambul" -> "estambul"
 * Si ya te viene un slug hecho ("nueva-york"), lo deja igual.
 *
 * Se exporta con este nombre para que la use tambien jobs/worker.js.
 */
export function destinoASlug(destino) {
  return String(destino)
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '') // fuera acentos (marcas diacriticas)
    .toLowerCase()
    .trim()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
}

/**
 * EL SLUG NO SE DEDUCE: SE DESCUBRE.
 *
 * Fabricarlo desde el nombre en espanol funciona para Roma y falla para todo lo
 * que se translitera: "Tesalonica" es "salonica" en Civitatis, y "Meteora" ni
 * siquiera tiene pagina propia —sus excursiones estan en "kalambaka"—. En el
 * viaje a Grecia esas dos paradas se quedaron sin una sola excursion, y el log
 * decia "no existe en Civitatis", que era verdad a medias: no existia ESE slug.
 *
 * El indice de destinos de cada pais —https://www.civitatis.com/es/grecia/— trae
 * los destinos con su nombre y su URL. Ahi se busca, comparando nombres
 * normalizados y permitiendo que uno contenga al otro ("tesalonica" contiene
 * "salonica"). Lo que se encuentre se guarda para no volver a mirarlo.
 *
 * @param {string} nombre    La ciudad tal y como la llamamos nosotros.
 * @param {object} opciones
 * @param {string} opciones.pais        Para saber en que indice buscar.
 * @param {string[]} opciones.tambien   Otros nombres que valen (la ciudad base).
 * @returns {Promise<string|null>} el slug real, o null si no esta en Civitatis.
 */
export async function descubrirSlug(nombre, { pais = null, tambien = [], sesion = null } = {}) {
  const candidatos = [nombre, ...tambien].filter(Boolean);

  /**
   * LA CLAVE DE CACHE, QUE NO PUEDE QUEDARSE VACIA.
   *
   * Esto tira todo lo que no sea [a-z0-9] para que \u00abHeracli\u00f3n\u00bb y \u00abHeraclion\u00bb
   * sean la misma fila. Pero de un nombre escrito en griego, cirilico o japones
   * no sobrevive ni un caracter, y los tres acababan bajo la MISMA clave vacia:
   * \u00ab\u0397\u03c1\u03ac\u03ba\u03bb\u03b5\u03b9\u03bf\u00bb, \u00ab\u041c\u043e\u0441\u043a\u0432\u0430\u00bb y \u00ab\u6771\u4eac\u00bb eran la misma fila de la tabla. La primera que
   * se guardara contestaria por todas las demas.
   *
   * Cuando no queda nada, la clave es el nombre original en minusculas. Pierde
   * la tolerancia a las tildes \u2014que en esos alfabetos no aplica\u2014 y a cambio cada
   * ciudad tiene la suya.
   */
  const normal = (t) => {
    const limpio = String(t ?? '')
      .normalize('NFD')
      .replace(/[\u0300-\u036f]/g, '')
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, '')
      .trim();
    return limpio || String(t ?? '').trim().toLowerCase();
  };

  // 1) LO QUE YA SE SEPA. Y un SI de cualquiera vale para todas.
  for (const c of candidatos) {
    const fila = una('SELECT slug FROM civitatis_destinos WHERE nombre_norm = ?', normal(c));
    if (fila?.slug) return fila.slug;
  }

  // UN «NO EXISTE» CACHEADO SOLO CUENTA SI LO SON TODOS.
  //
  // EL FALLO QUE ORIGINA ESTO, y se comio una isla entera. El bucle de arriba
  // devolvia en el PRIMER candidato con fila, «aunque lo que se sepa sea que no
  // esta». El primer candidato es siempre el nombre completo —«Creta
  // (Heraclion)»—, que estaba cacheado como inexistente de un intento anterior,
  // asi que se devolvia null sin mirar ni una de las variantes. Daba igual
  // cuantas se añadieran detras: no se llegaba a probarlas NUNCA.
  //
  // Es una cache envenenada: el dia que se añade una variante nueva —«Creta»,
  // que es justo la que funciona— las ciudades que ya fallaron una vez siguen
  // fallando para siempre, y sin decir por que.
  //
  // Ahora, si alguna variante no se ha probado jamas, se va a probarla. Solo se
  // da por perdida cuando todas tienen su «no existe» apuntado.
  const sinProbar = candidatos.filter(
    (c) => !una('SELECT 1 AS hay FROM civitatis_destinos WHERE nombre_norm = ?', normal(c))
  );
  if (!sinProbar.length) return null;

  const guardar = (queNombre, slug) =>
    ejecutar(
      `INSERT INTO civitatis_destinos (nombre_norm, nombre, slug, pais)
       VALUES (?, ?, ?, ?)
       ON CONFLICT (nombre_norm) DO UPDATE SET slug = excluded.slug, visto_en = datetime('now')`,
      normal(queNombre),
      String(queNombre),
      slug,
      pais
    );

  // Prestada o propia. Solo se cierra la propia: ver `conSesionDeCivitatis`.
  const mia = sesion ? null : await abrirNavegador({ de: 'Civitatis' });
  const { contexto, pagina } = sesion ?? mia;
  try {
    // 2) El slug directo, que acierta la mayoria de las veces.
    for (const c of candidatos) {
      const slug = destinoASlug(c);

      // UN SLUG VACIO NO ES UN CANDIDATO, y es la raiz de lo de Heraclion.
      //
      // `destinoASlug` se queda con lo que sea [a-z0-9], asi que de un nombre en
      // griego, cirilico o japones no sobrevive ni un caracter: «Ηράκλειο» sale
      // como "". Con eso la URL era `/es//`, que NO es la portada —Civitatis
      // contesta 404— y por tanto pasaba por el guardian de abajo como si el
      // destino existiera. Se guardaba slug "" y, como "" es falso, arriba se
      // reportaba «no tiene destino en Civitatis».
      //
      // Lo caro no era el fallo, era que devolvia AQUI: «Heraklion», que iba
      // justo detras en la lista y funciona, no se probaba nunca. Heraclion se
      // quedo sin sus 17 excursiones por una variante que ni siquiera era una
      // URL.
      if (!slug) {
        console.log(`[civitatis] "${c}" no deja nada al convertirlo a URL; lo salto.`);
        continue;
      }

      const respuesta = await pagina.goto(`${BASE}/${slug}/`, {
        waitUntil: 'domcontentloaded',
        timeout: TIMEOUT_LARGO,
      });
      await pausaHumana(400, 900);

      // DOS FORMAS DE NO EXISTIR, y hasta ahora solo se miraba una: que te
      // manden a la portada. La otra es un 404 a secas.
      if (laPaginaNoExiste(respuesta)) {
        console.log(`[civitatis] "${c}" (slug "${slug}"): ${respuesta.status()}, ahi no hay destino.`);
        continue;
      }
      if (esLaPortada(pagina.url())) continue;

      console.log(`[civitatis] "${c}" existe tal cual: ${slug}`);
      guardar(nombre, slug);
      return slug;
    }

    // 3) El indice del pais, que es donde estan los nombres de verdad.
    if (!pais) {
      guardar(nombre, null);
      return null;
    }

    const slugPais = await slugDelPais(pagina, pais);
    if (!slugPais) {
      console.log(`[civitatis] no encuentro el indice de "${pais}".`);
      guardar(nombre, null);
      return null;
    }

    await pagina.goto(`${BASE}/${slugPais}/`, { waitUntil: 'domcontentloaded', timeout: TIMEOUT_LARGO });
    await pausaHumana(600, 1200);

    const destinos = await pagina.evaluate(() =>
      [...document.querySelectorAll('a[href^="/es/"]')]
        .map((a) => ({
          slug: (a.getAttribute('href') || '').replace(/^\/es\//, '').replace(/\/$/, ''),
          texto: (a.textContent || '').replace(/\s+/g, ' ').trim(),
        }))
        .filter((x) => /^[a-z0-9-]+$/.test(x.slug))
    );

    // El texto del enlace trae el nombre y luego los contadores ("Salonica 14
    // actividades..."): interesa lo de delante del primer numero.
    const soloNombre = (t) => String(t).split(/\s\d/)[0].trim();

    for (const c of candidatos) {
      const buscado = normal(c);
      const encaja = destinos.find((d) => {
        const suyo = normal(soloNombre(d.texto));
        if (!suyo || !buscado) return false;
        return suyo === buscado || buscado.includes(suyo) || suyo.includes(buscado);
      });

      if (encaja) {
        console.log(`[civitatis] "${c}" en el indice de ${pais}: ${encaja.slug}`);
        guardar(nombre, encaja.slug);
        return encaja.slug;
      }
    }

    console.log(`[civitatis] "${nombre}" no esta en el indice de ${pais}.`);
    guardar(nombre, null);
    return null;
  } finally {
    // SOLO SE CIERRA LA PROPIA. Si la sesion venia prestada, la cierra quien la
    // abrio: cerrarla aqui dejaria al que sigue con un navegador muerto.
    //
    // POR `cerrarNavegador`, Y NO POR `contexto.close()`.
    //
    // Cerrar el navegador a pelo apaga el Chrome pero NO suelta la plaza del
    // dominio: eso vive dentro de `cerrarNavegador` (`plazaDe.get(contexto)?.()`),
    // que es lo que ya usaban `buscarActividades` y `buscarFichaActividad`.
    //
    // Esta función tardaba tres segundos y dejaba la plaza tomada TRES MINUTOS,
    // hasta que el vigilante la liberaba. Con cinco descubrimientos en el viaje a
    // Túnez —dos de Sousse, dos de Kairouan y uno de la capital— eran quince
    // minutos de una fase que trabajó menos de dos: cinco muertes del vigilante,
    // una por llamada, y ninguna por un cuelgue de verdad.
    //
    // Y arrastraba el cronómetro con ella: `pararReloj` está en ese mismo
    // camino, así que el tiempo de scraping seguía corriendo hasta el corte. Los
    // «15m 32s de scraping» y los «39m 25s esperando cola» eran la misma fuga
    // contada dos veces.
    if (mia) await cerrarNavegador(mia.contexto);
  }
}

/**
 * ¿ESTA URL ES UNA PORTADA, O ES UN DESTINO DE VERDAD?
 *
 * Civitatis no da 404 con un destino que no existe: te manda a la portada. Pero
 * la comprobacion miraba SOLO `/es/`, y la cadena real de `/es/heraclion/`
 * termina en `https://www.civitatis.com/en/` —te cambia de idioma por el camino—,
 * que no encajaba con el patron. Un destino inexistente se daba por bueno.
 *
 * Asi que vale cualquier portada: la raiz y la de cualquier idioma.
 */
export function esLaPortada(url) {
  let ruta;
  try {
    ruta = new URL(url).pathname;
  } catch {
    return true; // si ni siquiera es una URL, desde luego no es un destino
  }
  return /^\/(?:[a-z]{2})?\/?$/.test(ruta);
}

/**
 * ¿La respuesta dice que ahi no hay nada?
 *
 * El otro agujero del guardian: solo sabia reconocer la redireccion a la
 * portada, y un 404 le pasaba por delante. `/es//` contesta 404 y se daba por
 * un destino que existe.
 *
 * `respuesta` puede ser null: Playwright no devuelve una para una navegacion
 * servida desde cache o para un `about:blank`. Sin dato no se acusa a nadie, y
 * ya esta el resto del guardian para eso.
 */
function laPaginaNoExiste(respuesta) {
  const estado = respuesta?.status?.();
  return typeof estado === 'number' && estado >= 400;
}

/**
 * EL ÍNDICE DE UN PAÍS NO SIEMPRE SE LLAMA COMO EL PAÍS.
 *
 * Cuando el nombre del país choca con el de una de sus ciudades, Civitatis
 * desambigua con el sufijo `-pais`. Y la ciudad se queda con el nombre pelado,
 * no al revés:
 *
 *     /es/tunez/        la CIUDAD de Túnez
 *     /es/tunez-pais/   el PAÍS
 *
 * Aquí se hacía `destinoASlug(pais)` y punto, así que al buscar el índice de
 * Tunisia se abría la página de la capital. Comprobado con Playwright, que es lo
 * que corre en producción: del índice del país salen ocho destinos tunecinos
 * —tunez, djerba, hammamet, tozeur, susa, monastir, douz, nabeul— y de la
 * ciudad sale UNO, `tunez-pais`. De ahí la huella invertida que quedó en la
 * base: «Túnez ciudad» apuntando a la página del país.
 *
 * SE PRUEBA `-pais` PRIMERO, y no al revés. El pelado existe SIEMPRE —para un
 * país sin choque es el índice, y para uno con choque es la ciudad—, así que
 * probarlo primero no distingue nada. El sufijo, en cambio, solo existe cuando
 * hay choque: si contesta, es el país sin lugar a dudas. Comprobado contra
 * Civitatis: solo lo tienen Túnez, Luxemburgo y Singapur; Grecia, Polonia,
 * Italia, Marruecos, Egipto, México, Panamá y Guatemala van pelados.
 *
 * Cuesta una comprobación de más, y solo cuando hay que ir al índice.
 */
async function slugDelPais(pagina, pais) {
  const pelado = destinoASlug(pais);
  if (!pelado) return null;

  for (const candidato of [`${pelado}-pais`, pelado]) {
    const respuesta = await pagina.goto(`${BASE}/${candidato}/`, {
      waitUntil: 'domcontentloaded',
      timeout: TIMEOUT_LARGO,
    });
    if (laPaginaNoExiste(respuesta) || esLaPortada(pagina.url())) continue;
    if (candidato !== pelado) {
      console.log(`[civitatis] el indice de "${pais}" lleva sufijo: ${candidato}`);
    }
    return candidato;
  }

  return null;
}

/**
 * UNA SOLA SESION PARA TODO LO QUE SE LE PREGUNTE A CIVITATIS DE UNA CIUDAD.
 *
 * Descubrir el slug, buscar sus actividades y traerse la ficha de las elegidas
 * son tres preguntas al mismo sitio, y abrian tres navegadores seguidos: tres
 * arranques de Chromium y tres turnos en la cola de la plaza, que es una sola
 * por dominio. Con el reintento por alias, cuatro.
 *
 * Aqui se abre uno y se presta. Las tres funciones aceptan una `sesion`
 * opcional: si la reciben la usan, y si no, abren la suya como siempre —la ruta
 * de «Ver detalles» y el worker siguen funcionando sin tocar nada—.
 *
 * QUIEN ABRE, CIERRA, y nadie mas. Ese es el contrato que evita repetir la fuga
 * del 15/09: `descubrirSlug` cerraba con `contexto.close()`, que apaga el Chrome
 * pero no suelta la plaza del dominio, y cada descubrimiento se quedaba con ella
 * tres minutos hasta que el vigilante la liberaba. El cierre vive en UN `finally`
 * y llama a `cerrarNavegador`, que es quien suelta la plaza.
 *
 * OJO AL VIGILANTE. El tope de tres minutos es POR SESION, asi que al juntar
 * varias preguntas en una comparten presupuesto. Medido: descubrir tarda ~3 s y
 * buscar entre 20 y 40 s, asi que sobra; pero el margen ya no es el de antes y
 * conviene recordarlo si algun dia se mete algo mas aqui dentro.
 */
export async function conSesionDeCivitatis(loQueSea) {
  const sesion = await abrirNavegador({ de: 'Civitatis' });
  try {
    return await loQueSea(sesion);
  } finally {
    await cerrarNavegador(sesion.contexto);
  }
}

/** Guarda una captura para poder ver que habia en pantalla cuando algo fallo. */
async function capturaDeFallo(pagina, etiqueta) {
  try {
    const dir = path.join(__dirname, '..', 'capturas');
    await fs.mkdir(dir, { recursive: true });
    const ruta = path.join(dir, `fallo-civitatis-${etiqueta}-${Date.now()}.png`);
    await pagina.screenshot({ path: ruta, fullPage: true });
    console.error(`  [i] Captura del fallo guardada en: ${ruta}`);
  } catch {
    /* si ni siquiera podemos capturar, seguimos adelante */
  }
}

/**
 * PASO 2: banner de cookies (Didomi).
 * Elegimos siempre "Rechazar todo". Si no aparece -porque el perfil persistente
 * ya guardo la decision de una ejecucion anterior- seguimos sin mas.
 */
async function gestionarCookies(pagina) {
  const candidatos = [
    pagina.locator('#didomi-notice-disagree-button'),
    pagina.locator('#didomi-notice button').filter({ hasText: /rechazar/i }),
  ];

  const limite = Date.now() + 8_000;
  while (Date.now() < limite) {
    for (const candidato of candidatos) {
      const boton = candidato.first();
      if (await boton.isVisible().catch(() => false)) {
        await boton.click();
        await pagina
          .locator('#didomi-notice')
          .waitFor({ state: 'hidden', timeout: 8_000 })
          .catch(() => {});
        await pausaHumana();
        console.log('    (banner de cookies: rechazadas las no esenciales)');
        return true;
      }
    }
    await dormir(400);
  }
  console.log('    (no hay banner de cookies; el perfil ya guardaba la decision)');
  return false;
}

/**
 * Scroll progresivo hasta el final de la pagina.
 *
 * Sirve para dos cosas:
 *  - disparar la carga diferida de las imagenes (bLazy), que si no se quedan
 *    con la miniatura en data-src;
 *  - dejar la puerta abierta por si algun dia Civitatis SI mete lazy load:
 *    paramos cuando el numero de tarjetas deja de crecer, no cuando se acaba
 *    la altura.
 */
async function scrollProgresivo(pagina, selectorItem) {
  let anteriores = -1;
  for (let vuelta = 0; vuelta < 25; vuelta++) {
    const actuales = await pagina.locator(selectorItem).count();

    // Bajamos "una pantalla" cada vez, como haria una persona leyendo.
    const alFinal = await pagina.evaluate(() => {
      window.scrollBy(0, Math.round(window.innerHeight * 0.85));
      return window.scrollY + window.innerHeight >= document.body.scrollHeight - 50;
    });

    await dormir(250 + Math.random() * 350);

    if (alFinal) {
      // Ya abajo del todo: damos una ultima oportunidad a que carguen mas.
      await pausaHumana(700, 1200);
      const trasEsperar = await pagina.locator(selectorItem).count();
      if (trasEsperar === actuales && actuales === anteriores) return actuales;
      anteriores = trasEsperar;
      if (trasEsperar === actuales) return actuales;
    }
  }
  return pagina.locator(selectorItem).count();
}

/**
 * PASO 3: leer las tarjetas de la pagina actual.
 * Se ejecuta DENTRO del navegador, asi que no puede usar nada del ambito Node.
 */
function extraerActividadesDelDOM() {
  const limpia = (s) => (s ? s.replace(/\s+/g, ' ').trim() : null);

  /** "15.778 opiniones" -> 15778 · "9,4 / 10" -> 9.4 · "28,84 €" -> 28.84 */
  const aNumero = (s) => {
    if (!s) return null;
    const m = /(\d[\d.]*(?:,\d+)?)/.exec(s);
    if (!m) return null;
    const n = Number(m[1].replace(/\./g, '').replace(',', '.'));
    return Number.isFinite(n) ? n : null;
  };

  const items = document.querySelectorAll('#activities-container .o-search-list__item');

  return [...items].map((item) => {
    const card = item.querySelector('article') ?? item;

    // OJO: NO vale card.querySelector('a[href]'). El primer <a> de la tarjeta es
    // el corazoncito de "guardar en favoritos", que apunta a "#" y por tanto es
    // IDENTICO en las 20 tarjetas de la pagina. Si lo usas como url, el
    // deduplicado se come 19 de cada 20 actividades.
    // El enlace bueno lleva la clase _activity-link; como respaldo, el primer
    // ancla con un href de verdad.
    const enlace =
      card.querySelector('a._activity-link') ??
      [...card.querySelectorAll('a[href]')].find((a) => {
        const h = a.getAttribute('href') ?? '';
        return h && !h.startsWith('#') && !h.startsWith('javascript:');
      }) ??
      null;

    const img = card.querySelector('img');

    // innerText, no textContent: la tarjeta lleva dos bloques de precio y solo
    // uno esta visible (ver nota en la cabecera del fichero).
    const precioTexto = limpia(card.querySelector('.comfort-card__price-wrapper')?.innerText);
    const mp = precioTexto ? /(\d[\d.,]*)\s*(€|\$|£|EUR|USD|GBP)/.exec(precioTexto) : null;

    // Los free tours ponen "¡Gratis!" en vez de un importe.
    const esGratis = !mp && /gratis|free/i.test(precioTexto ?? '');

    return {
      titulo: limpia(card.querySelector('.comfort-card__title')?.textContent),
      precio: mp ? aNumero(mp[1]) : esGratis ? 0 : null,
      monedaCruda: mp ? mp[2] : null,
      precioTexto,
      duracion: limpia(card.querySelector('.comfort-card__feature._duration')?.innerText),
      valoracion: aNumero(limpia(card.querySelector('.m-rating--text')?.textContent)),
      numOpiniones: aNumero(limpia(card.querySelector('.text--rating-total')?.textContent)),
      url: enlace ? enlace.href : null,
      // Las imagenes son diferidas: antes de cargarse el src real vive en data-src.
      imagenUrl: img ? (img.getAttribute('src') || img.getAttribute('data-src') || null) : null,
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
 * @param {string} opciones.destino          Ciudad ("Berlin", "berlin", "Nueva York")
 * @param {number} [opciones.maxResultados]  Cuantas actividades como maximo (30)
 */
export async function buscarActividades({ destino, maxResultados = 30, slug: slugDado = null, sesion = null }) {
  if (!destino || !String(destino).trim()) {
    throw new Error('[civitatis] Falta el destino.');
  }
  if (!Number.isInteger(maxResultados) || maxResultados < 1) {
    throw new Error(`[civitatis] maxResultados debe ser un entero positivo (recibido: ${maxResultados}).`);
  }

  // El slug ya descubierto manda sobre el fabricado: "Tesalonica" no existe en
  // Civitatis, pero "salonica" si, y quien llama ya lo ha averiguado.
  const slug = slugDado || destinoASlug(destino);
  const mia = sesion ? null : await abrirNavegador({ de: 'Civitatis' });
  const { contexto, pagina } = sesion ?? mia;

  try {
    // ---- PASO 1: abrir la pagina del destino -----------------------------
    await paso(`1. Abrir el destino "${slug}"`, async () => {
      const respuesta = await pagina.goto(`${BASE}/${slug}/`, {
        waitUntil: 'domcontentloaded',
        timeout: TIMEOUT_LARGO,
      });

      // EL MISMO GUARDIAN QUE EN EL DESCUBRIMIENTO, y por el mismo motivo: aqui
      // tambien se miraba solo `/es/`, y ni el 404 ni la portada en otro idioma
      // encajaban. Con el slug vacio esto llegaba hasta el paso 3 y moria mucho
      // mas adelante, con un mensaje sobre selectores rotos que no era verdad.
      if (laPaginaNoExiste(respuesta)) {
        throw new ErrorDestino(
          `El destino "${destino}" (slug "${slug}") no existe en Civitatis: ` +
            `la web contesta ${respuesta.status()}.`
        );
      }
      if (esLaPortada(pagina.url())) {
        throw new ErrorDestino(
          `El destino "${destino}" (slug "${slug}") no existe en Civitatis: ` +
            'la web ha redirigido a la portada. Comprueba como se llama la ciudad ' +
            'en su URL (por ejemplo "nueva-york", "san-sebastian").'
        );
      }
    });

    await comprobarCaptcha(pagina, { paso: 'listado' });

    // ---- PASO 2: cookies -------------------------------------------------
    await paso('2. Banner de cookies', () => gestionarCookies(pagina));

    // ---- PASO 3: recorrer paginas y recolectar ---------------------------
    const actividades = [];
    const vistas = new Set(); // para no repetir si una actividad sale dos veces
    let numPagina = 1;

    while (actividades.length < maxResultados && numPagina <= MAX_PAGINAS) {
      const enEstaPagina = await paso(`3.${numPagina} Leer la pagina ${numPagina}`, async () => {
        // Esperamos a que exista el listado con al menos una tarjeta.
        await pagina
          .locator('#activities-container .o-search-list__item')
          .first()
          .waitFor({ state: 'visible', timeout: TIMEOUT_LARGO });

        // Scroll progresivo: carga las imagenes diferidas.
        await scrollProgresivo(pagina, '#activities-container .o-search-list__item');

        return pagina.evaluate(extraerActividadesDelDOM);
      });

      if (!enEstaPagina.length) {
        throw new ErrorReceta(
          `3.${numPagina} Leer la pagina ${numPagina}`,
          new Error('El listado cargo pero no encontre ninguna tarjeta .o-search-list__item')
        );
      }

      let descartadas = 0;
      for (const act of enEstaPagina) {
        if (actividades.length >= maxResultados) break;
        const clave = act.url ?? act.titulo;
        if (!clave || vistas.has(clave)) {
          descartadas++;
          continue;
        }
        vistas.add(clave);
        actividades.push({
          titulo: act.titulo,
          precio: act.precio,
          moneda: normalizarMoneda(act.monedaCruda),
          duracion: act.duracion,
          valoracion: act.valoracion,
          numOpiniones: act.numOpiniones,
          url: act.url,
          imagenUrl: act.imagenUrl,
          precioTexto: act.precioTexto,
        });
      }

      // Si se descartan muchas, algo va mal con la url (ver nota del enlace).
      const aviso = descartadas ? ` · ${descartadas} descartadas (repetidas o sin url)` : '';
      console.log(
        `    (pagina ${numPagina}: ${enEstaPagina.length} tarjetas${aviso} · acumulado ${actividades.length}/${maxResultados})`
      );

      if (actividades.length >= maxResultados) break;

      // ---- Paginacion: seguimos el enlace "siguiente" si existe ----------
      const siguiente = pagina.locator('a.next-element').first();
      const haySiguiente = await siguiente.count();
      if (!haySiguiente) {
        console.log('    (no hay mas paginas: era la ultima)');
        break;
      }

      const href = await siguiente.getAttribute('href');
      await pausaHumana(); // una pausa antes de pedir la siguiente pagina
      await paso(`3.${numPagina} Ir a la pagina ${numPagina + 1}`, () =>
        pagina.goto(new URL(href, pagina.url()).href, {
          waitUntil: 'domcontentloaded',
          timeout: TIMEOUT_LARGO,
        })
      );
      numPagina++;
    }

    if (!actividades.length) {
      throw new ErrorReceta('3. Recolectar actividades', new Error('No se recolecto ninguna actividad'));
    }

    return actividades;
  } catch (err) {
    // Si solo has escrito mal la ciudad no hace falta captura: no hay nada que ver.
    if (!(err instanceof ErrorDestino)) {
      await capturaDeFallo(pagina, err.paso ? err.paso.split(' ')[0].replace(/\./g, '_') : 'error');
    }
    throw err;
  } finally {
    // Solo la propia: si venia prestada, cierra quien la abrio.
    if (mia) await cerrarNavegador(mia.contexto);
  }
}

/**
 * =============================================================================
 * LA FICHA DE UNA EXCURSION
 * =============================================================================
 * El listado da el titulo, el precio y la nota. Lo demas -que incluye, donde se
 * queda uno, cuanto dura de verdad, que pasa si cancelas- solo esta en la
 * pagina de la propia actividad, y hay que ir a buscarlo alli.
 *
 * SE LEE POR TEXTO, NO POR CLASES. Y no es pereza: Civitatis sirve la misma
 * ficha con DOS maquetas (una de movil y otra de escritorio, con los ids
 * repetidos), y ademas cambia de forma segun el tipo de actividad: un free tour
 * tiene punto de encuentro y una entrada a un acuario no. Recorriendo el DOM, la
 * receta que funcionaba en el free tour de Lisboa se traia la seccion entera en
 * la entrada al Oceanario. Leyendo las ETIQUETAS del texto ("Duración",
 * "Incluido", "No incluido"...) funciona igual en las dos, que es lo que se le
 * pide a una receta.
 *
 * Lo unico estable del marcado son los ids de seccion: #descripcion, #detalles,
 * #cancelaciones y #punto-encuentro. De cada uno hay dos copias en la pagina
 * (movil y escritorio) y nos quedamos con la que mas texto tenga.
 *
 * LO QUE NO ESTA, NO ESTA. Una entrada de museo no tiene punto de encuentro, y
 * casi ninguna ficha publica los horarios de salida: Civitatis los enseña en el
 * calendario de reserva, despues de elegir un dia, y eso ya no es informacion
 * estable del catalogo. En esos casos el campo se queda vacio y ya esta; no es
 * un fallo de la receta.
 */

/** Las filas de "Detalles" que sabemos leer, tal y como las escribe Civitatis. */
const ETIQUETAS_DETALLE = [
  'Duración', 'Idioma', 'Idiomas', 'Horario', 'Horarios',
  'Incluido', 'No incluido', 'Cuándo reservar',
  'Justificante', 'Tipo de bono', 'Accesibilidad',
  'Sostenibilidad', 'Condiciones de Sostenibilidad', 'Mascotas',
];

/** Donde se corta el bloque de detalles: lo de despues ya no es de la ficha. */
const CORTES_DETALLE = [
  'Preguntas frecuentes',
  'Opiniones de nuestros clientes',
  'También te puede interesar',
  'Otras actividades en',
];

/**
 * Se ejecuta DENTRO del navegador: no puede usar nada del ambito de Node, por
 * eso las etiquetas le llegan como argumento.
 */
function extraerFichaDelDOM({ etiquetas, cortes }) {
  const limpio = (t) =>
    String(t || '').replace(/\r/g, '').replace(/[ \t]+/g, ' ').replace(/\n{3,}/g, '\n\n').trim();
  const textoDe = (el) => (el ? limpio(el.innerText) : '');

  // Civitatis repite la maqueta (movil y escritorio) con los MISMOS ids. Nos
  // quedamos con la copia que tenga mas texto: la otra suele venir recortada.
  const masLargo = (selector) =>
    [...document.querySelectorAll(selector)].sort((a, b) => textoDe(b).length - textoDe(a).length)[0] || null;

  /** El contenedor del encabezado que se llame exactamente asi. */
  const porTitulo = (titulo) =>
    [...document.querySelectorAll('h2,h3')]
      .filter((x) => new RegExp('^' + titulo + '$', 'i').test(x.innerText.trim()))
      .map((x) => x.parentElement)
      .sort((a, b) => textoDe(b).length - textoDe(a).length)[0] || null;

  const quitarTitulo = (t, titulo) =>
    limpio(String(t || '').replace(new RegExp('^' + titulo + '\\s*', 'i'), ''));

  // --- Descripcion ---------------------------------------------------------
  // En unas fichas la larga esta en #descripcion; en otras (el free tour) esa
  // seccion trae solo el resumen y la buena vive en el acordeon. Se cogen las
  // dos y gana la mas larga.
  const descripcion =
    [textoDe(masLargo('#descripcion')), quitarTitulo(textoDe(porTitulo('Descripción')), 'Descripción')]
      .sort((a, b) => b.length - a.length)[0] || null;

  // --- Detalles: cada etiqueta y lo que va debajo, hasta la siguiente --------
  let texto = textoDe(masLargo('#detalles')) || textoDe(porTitulo('Detalles'));
  for (const c of cortes) {
    const i = texto.indexOf(c);
    if (i > 0) texto = texto.slice(0, i);
  }

  const detalles = {};
  let actual = null;
  for (const linea of texto.split('\n').map((l) => l.trim()).filter(Boolean)) {
    const etiqueta = etiquetas.find((e) => e.toLowerCase() === linea.toLowerCase());
    if (etiqueta) {
      actual = etiqueta;
      detalles[actual] = detalles[actual] || [];
      continue;
    }
    if (actual) detalles[actual].push(linea);
  }
  for (const k of Object.keys(detalles)) {
    const v = detalles[k].join('\n').trim();
    if (v) detalles[k] = v;
    else delete detalles[k];
  }

  return {
    descripcion: descripcion || null,
    detalles,
    cancelacion:
      quitarTitulo(textoDe(masLargo('#cancelaciones')) || textoDe(porTitulo('Cancelaciones')), 'Cancelaciones') || null,
    puntoEncuentro: quitarTitulo(textoDe(masLargo('#punto-encuentro')), 'Punto de encuentro') || null,
  };
}

/**
 * Trae la ficha completa de UNA excursion.
 *
 * Una sola pagina, una sola visita. Esto NO se llama en masa: se pide excursion
 * a excursion, cuando alguien quiere ver los detalles de esa.
 *
 * @param {object} opciones
 * @param {string} opciones.url  La url de la actividad en Civitatis
 * @returns {Promise<object>} { descripcion, duracion, idiomas, horarios,
 *                              incluye, noIncluye, puntoEncuentro,
 *                              cancelacion, extra }
 */
export async function buscarFichaActividad({ url, sesion = null }) {
  if (!url || !/^https?:\/\/(www\.)?civitatis\.com\//i.test(String(url))) {
    throw new Error(`[civitatis] La url de la actividad no parece de Civitatis: ${url}`);
  }

  const mia = sesion ? null : await abrirNavegador({ de: 'Civitatis' });
  const { contexto, pagina } = sesion ?? mia;

  try {
    await paso('1. Abrir la ficha de la actividad', async () => {
      console.log(`    URL: ${url}`);
      await pagina.goto(url, { waitUntil: 'domcontentloaded', timeout: TIMEOUT_LARGO });
      await pausaHumana(1000, 1800);
    });

    await comprobarCaptcha(pagina, { paso: 'ficha de la actividad' });

    await paso('2. Banner de cookies', () => gestionarCookies(pagina));

    // La descripcion viene plegada tras un "Ver la descripción completa". Sin
    // pulsarlo solo se lee el resumen de dos lineas.
    await paso('3. Desplegar la descripción completa', async () => {
      const boton = pagina.getByRole('button', { name: /descripci[oó]n completa/i }).first();
      if (await boton.isVisible({ timeout: 1500 }).catch(() => false)) {
        await boton.click().catch(() => {});
        await pausaHumana(600, 1100);
      }
    });

    const cruda = await paso('4. Leer la ficha', () =>
      pagina.evaluate(extraerFichaDelDOM, { etiquetas: ETIQUETAS_DETALLE, cortes: CORTES_DETALLE })
    );

    // Las filas conocidas salen a su propio campo; las demas se guardan juntas
    // para no perderlas, pero sin inventarles una columna.
    const d = cruda.detalles ?? {};
    const tomar = (...nombres) => nombres.map((n) => d[n]).find(Boolean) ?? null;

    const conocidas = new Set([
      'Duración', 'Idioma', 'Idiomas', 'Horario', 'Horarios', 'Incluido', 'No incluido',
    ]);
    const extra = Object.fromEntries(Object.entries(d).filter(([k]) => !conocidas.has(k)));

    const ficha = {
      descripcion: cruda.descripcion,
      duracion: tomar('Duración'),
      idiomas: tomar('Idioma', 'Idiomas'),
      horarios: tomar('Horario', 'Horarios'),
      incluye: tomar('Incluido'),
      noIncluye: tomar('No incluido'),
      puntoEncuentro: cruda.puntoEncuentro,
      cancelacion: cruda.cancelacion,
      extra: Object.keys(extra).length ? extra : null,
    };

    const traidos = Object.entries(ficha).filter(([, v]) => v).map(([k]) => k);
    console.log(`    (leídos: ${traidos.length ? traidos.join(', ') : 'nada'})`);

    // Una ficha sin NADA es que la receta se ha roto. Que le falten campos, en
    // cambio, es lo normal y no se protesta por ello.
    if (!traidos.length) {
      throw new ErrorReceta(
        '4. Leer la ficha',
        new Error('La página cargó pero no traía ninguna sección conocida')
      );
    }

    return ficha;
  } catch (err) {
    await capturaDeFallo(pagina, err.paso ? err.paso.split(' ')[0].replace(/\./g, '_') : 'ficha');
    throw err;
  } finally {
    // Solo la propia: si venia prestada, cierra quien la abrio.
    if (mia) await cerrarNavegador(mia.contexto);
  }
}

export default { buscarActividades, destinoASlug, buscarFichaActividad };

/** Alias historico: antes esta funcion se llamaba asi. */
export { destinoASlug as aSlug };
