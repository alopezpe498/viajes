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
export async function descubrirSlug(nombre, { pais = null, tambien = [] } = {}) {
  const candidatos = [nombre, ...tambien].filter(Boolean);
  const normal = (t) =>
    String(t ?? '')
      .normalize('NFD')
      .replace(/[\u0300-\u036f]/g, '')
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, '')
      .trim();

  // 1) Lo que ya se sepa de esta ciudad, aunque lo que se sepa sea que no esta.
  for (const c of candidatos) {
    const fila = una('SELECT slug FROM civitatis_destinos WHERE nombre_norm = ?', normal(c));
    if (fila) return fila.slug ?? null;
  }

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

  const { contexto, pagina } = await abrirNavegador();
  try {
    // 2) El slug directo, que acierta la mayoria de las veces.
    for (const c of candidatos) {
      const slug = destinoASlug(c);
      await pagina.goto(`${BASE}/${slug}/`, { waitUntil: 'domcontentloaded', timeout: TIMEOUT_LARGO });
      await pausaHumana(400, 900);
      if (!/^\/es\/?$/.test(new URL(pagina.url()).pathname)) {
        console.log(`[civitatis] "${c}" existe tal cual: ${slug}`);
        guardar(nombre, slug);
        return slug;
      }
    }

    // 3) El indice del pais, que es donde estan los nombres de verdad.
    if (!pais) {
      guardar(nombre, null);
      return null;
    }

    const slugPais = destinoASlug(pais);
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
    await contexto.close().catch(() => {});
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
export async function buscarActividades({ destino, maxResultados = 30, slug: slugDado = null }) {
  if (!destino || !String(destino).trim()) {
    throw new Error('[civitatis] Falta el destino.');
  }
  if (!Number.isInteger(maxResultados) || maxResultados < 1) {
    throw new Error(`[civitatis] maxResultados debe ser un entero positivo (recibido: ${maxResultados}).`);
  }

  // El slug ya descubierto manda sobre el fabricado: "Tesalonica" no existe en
  // Civitatis, pero "salonica" si, y quien llama ya lo ha averiguado.
  const slug = slugDado || destinoASlug(destino);
  const { contexto, pagina } = await abrirNavegador();

  try {
    // ---- PASO 1: abrir la pagina del destino -----------------------------
    await paso(`1. Abrir el destino "${slug}"`, async () => {
      await pagina.goto(`${BASE}/${slug}/`, {
        waitUntil: 'domcontentloaded',
        timeout: TIMEOUT_LARGO,
      });

      // Civitatis no da 404 con un destino inexistente: te manda a la portada.
      const ruta = new URL(pagina.url()).pathname;
      if (/^\/es\/?$/.test(ruta)) {
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
    await cerrarNavegador(contexto);
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
export async function buscarFichaActividad({ url }) {
  if (!url || !/^https?:\/\/(www\.)?civitatis\.com\//i.test(String(url))) {
    throw new Error(`[civitatis] La url de la actividad no parece de Civitatis: ${url}`);
  }

  const { contexto, pagina } = await abrirNavegador();

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
    await cerrarNavegador(contexto);
  }
}

export default { buscarActividades, destinoASlug, buscarFichaActividad };

/** Alias historico: antes esta funcion se llamaba asi. */
export { destinoASlug as aSlug };
