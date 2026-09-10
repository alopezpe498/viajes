/**
 * providers/heymondo.js
 * -----------------------------------------------------------------------------
 * SEGUROS DE VIAJE — receta contra heymondo.es
 *
 * POR QUÉ HEYMONDO Y NO OTRO. Se probaron los cuatro habituales antes de
 * escribir una línea:
 *
 *   · mondo.es      no resuelve (la marca española es Heymondo).
 *   · IATI          responde y no tiene antibot, pero el presupuesto vive en un
 *                   diálogo modal sin URL propia y sin identificadores estables.
 *   · Chapka        responde, pero su portada es un formulario de captación de
 *                   correo; el tarificador no se alcanza sin dar datos.
 *   · Heymondo      asistente de cuatro pasos, CON `data-testid` en cada control
 *                   —`btn-step0Next`, `mt-select-step1Destination`,
 *                   `cnt-step2StartDate`…—, sin captcha, sin Cloudflare, sin
 *                   DataDome y sin PerimeterX. Comprobado el 10/09/2026.
 *
 * Los identificadores de prueba son la razón de peso: son los que pone el
 * propio equipo de Heymondo para sus tests, así que no cambian con un retoque de
 * diseño, que es lo que rompe las recetas basadas en clases de CSS.
 *
 * EL ÚNICO PASO INCÓMODO ES EL CALENDARIO. Es un `@vuepic/vue-datepicker` y no
 * acepta fechas tecleadas: escribir «10/10/2026» le deja la de hoy. Hay que
 * navegar por meses con la flecha «Next month» y pulsar la casilla del día,
 * saltándose las de relleno del mes vecino (`dp__cell_offset`), que llevan el
 * mismo número y te mandan a septiembre cuando querías octubre.
 *
 * LO QUE NO SE INVENTA. Si el asistente cambia y algún paso no se puede
 * completar, esto DEVUELVE VACÍO y dice por qué. Nunca un precio aproximado:
 * un seguro mal cotizado se contrata igual, y eso sí hace daño.
 */

import { abrirNavegador, cerrarNavegador, comprobarCaptcha, dormir } from '../lib/browser.js';

/** Desde dónde se viaja. Es lo que decide la repatriación, y siempre es el mismo. */
const RESIDENCIA = 'España';

/** Los pasos son cortos; si uno tarda más que esto, algo ha cambiado. */
const ESPERA = 15_000;

const MESES_CORTOS = ['ene', 'feb', 'mar', 'abr', 'may', 'jun',
  'jul', 'ago', 'sep', 'oct', 'nov', 'dic'];

/** Quita el aviso de cookies eligiendo lo más privado que ofrezca. */
async function fueraCookies(pagina) {
  for (const t of ['Denegar', 'Rechazar', 'Solo las necesarias', 'Rechazar todo']) {
    const b = pagina.locator(`button:has-text("${t}")`).first();
    if ((await b.count()) && (await b.isVisible().catch(() => false))) {
      await b.click().catch(() => {});
      return t;
    }
  }
  return null;
}

/**
 * ELIGE UNA FECHA EN EL CALENDARIO.
 *
 * Se abre, se mira qué mes enseña —lo dice en su cabecera, «Sep 2026»—, se
 * avanza mes a mes hasta el que toca y se pulsa el día.
 *
 * Las dos precauciones que hacen que esto funcione:
 *   1. Un tope de saltos. Sin él, un mes que no llega nunca —porque el widget
 *      no deja pasar de cierta fecha— es un bucle infinito.
 *   2. Saltarse `dp__cell_offset`. El calendario rellena la primera y la última
 *      semana con días del mes vecino: pulsar el «10» equivocado te cotiza un
 *      viaje en septiembre sin que nada falle a la vista.
 */
async function elegirFecha(pagina, testidContenedor, iso) {
  const [ano, mes, dia] = iso.slice(0, 10).split('-').map(Number);

  await pagina.locator(`[data-testid=${testidContenedor}]`).click({ timeout: ESPERA });
  await dormir(1200);

  const menu = pagina.locator('.dp__menu').first();
  if (!(await menu.count())) throw new Error('el calendario no se abrió');

  for (let salto = 0; salto < 36; salto++) {
    const cabecera = (await menu.locator('.dp__month_year_wrap').first().innerText().catch(() => '')) || '';
    const m = cabecera.match(/([a-záéíóú]+)\s*\n?\s*(\d{4})/i);
    if (!m) throw new Error(`no entiendo la cabecera del calendario («${cabecera.trim()}»)`);

    const mesActual = MESES_CORTOS.findIndex((x) => m[1].toLowerCase().startsWith(x)) + 1;
    const anoActual = Number(m[2]);
    if (mesActual === mes && anoActual === ano) break;

    // Hacia delante o hacia atrás, según dónde esté el mes que se busca.
    const haciaDelante = anoActual < ano || (anoActual === ano && mesActual < mes);
    const flecha = menu.locator(
      `button[aria-label="${haciaDelante ? 'Next month' : 'Previous month'}"]`
    ).first();
    if (!(await flecha.count())) throw new Error('el calendario no tiene flechas de mes');
    await flecha.click({ timeout: 5000 });
    await dormir(450);

    if (salto === 35) throw new Error(`el calendario no llega a ${iso}`);
  }

  // La casilla del día, sin las de relleno del mes de al lado.
  const celda = menu
    .locator('.dp__cell_inner')
    .filter({ hasText: new RegExp(`^${dia}$`) })
    .and(menu.locator(':not(.dp__cell_offset)'))
    .first();

  const cuantas = await celda.count();
  if (!cuantas) {
    // Respaldo por si cambia la clase interna: se busca entre todas las celdas
    // la que tenga el número exacto y no esté marcada como de otro mes.
    const alternativa = menu.locator(`.dp__cell_inner:not(.dp__cell_offset):text-is("${dia}")`).first();
    if (!(await alternativa.count())) throw new Error(`no encuentro el día ${dia} en el calendario`);
    await alternativa.click({ timeout: 5000 });
  } else {
    await celda.click({ timeout: 5000 });
  }

  await dormir(900);
}

/**
 * LAS OPCIONES QUE ENSEÑA EL COMPARADOR.
 *
 * Se leen del texto de cada tarjeta y no del DOM: Heymondo cambia la maqueta de
 * las tarjetas con frecuencia —hay pruebas A/B por medio— pero el contenido
 * dice siempre lo mismo. El precio se busca con su símbolo pegado, que es lo
 * único que distingue «139 €» de un número de cobertura.
 */
async function leerOpciones(pagina) {
  return pagina.evaluate(() => {
    const limpio = (t) => String(t || '').replace(/\s+/g, ' ').trim();

    // Una tarjeta es un bloque que tiene a la vez nombre de producto y precio.
    const bloques = [...document.querySelectorAll('[data-testid], article, li, section, div')]
      .filter((e) => {
        if (!e.offsetParent) return false;
        const t = e.innerText || '';
        if (t.length > 1200 || t.length < 30) return false;
        return /\d[\d.,]*\s*€/.test(t) && /heymondo|seguro|top|premium|básico|basico|cap/i.test(t);
      });

    // De los anidados nos quedamos con el más pequeño que cumple: es la tarjeta
    // y no el contenedor que las envuelve a todas.
    const hojas = bloques.filter((e) => !bloques.some((o) => o !== e && e.contains(o)));

    const vistas = new Set();
    const salida = [];

    for (const b of hojas) {
      const texto = limpio(b.innerText);
      const precio = texto.match(/(\d[\d.]*(?:,\d{1,2})?)\s*€/);
      if (!precio) continue;

      // El nombre: la primera línea con letras que no sea el precio.
      const lineas = (b.innerText || '').split('\n').map(limpio).filter(Boolean);
      const nombre = lineas.find((l) => /[a-zA-ZáéíóúñÁÉÍÓÚÑ]/.test(l) && !/^\d[\d.,]*\s*€/.test(l));
      if (!nombre) continue;

      const clave = nombre.toLowerCase() + '|' + precio[1];
      if (vistas.has(clave)) continue;
      vistas.add(clave);

      const enlace = b.querySelector('a[href]')?.href ?? null;

      salida.push({
        nombre: nombre.slice(0, 90),
        precioTexto: precio[0],
        precio: Number(precio[1].replace(/\./g, '').replace(',', '.')),
        // La cobertura, tal cual la escribe la web. No se resume aquí: lo que
        // se guarda es lo que dice la fuente.
        texto: texto.slice(0, 700),
        url: enlace,
      });
    }

    return salida;
  });
}

/**
 * BUSCA SEGUROS DE VIAJE.
 *
 * @param {object} o
 * @param {string[]} o.paises       Países del viaje, en español ("Polonia").
 * @param {string} o.fechaInicio    "YYYY-MM-DD"
 * @param {string} o.fechaFin       "YYYY-MM-DD"
 * @param {number} o.adultos
 * @param {number[]} o.edadesNinos
 */
export async function buscarSegurosHeymondo({
  paises = [],
  fechaInicio,
  fechaFin,
  adultos = 1,
  edadesNinos = [],
}) {
  if (!fechaInicio || !fechaFin) throw new Error('Hacen falta las fechas del viaje.');
  if (!paises.length) throw new Error('Hace falta saber a qué país se viaja.');

  const { contexto, pagina } = await abrirNavegador();

  try {
    await pagina.goto('https://heymondo.es/calcula-tu-seguro-de-viaje/', {
      waitUntil: 'domcontentloaded',
      timeout: 45_000,
    });
    await dormir(5000);
    await fueraCookies(pagina);
    await dormir(2000);
    await comprobarCaptcha(pagina, { paso: 'el presupuesto de Heymondo' });

    // --- 1) Tipo de seguro: el de un viaje concreto -------------------------
    //
    // Sale marcado de entrada, pero el botón de seguir NO se activa hasta que
    // se pulsa de verdad. Es la clase de detalle que solo se descubre probando.
    await pagina.locator('[data-testid=wrp-insuranceType-1]').click({ timeout: ESPERA });
    await dormir(900);
    await pagina.locator('[data-testid=btn-step0Next]').click({ timeout: ESPERA });
    await dormir(3000);

    // --- 2) Residencia y destino -------------------------------------------
    await pagina.locator('[data-testid=drp-step1OriginCountry]').click({ timeout: ESPERA });
    await dormir(1500);
    await pagina.getByText(RESIDENCIA, { exact: true }).first().click({ timeout: 8000 });
    await dormir(1000);

    const elegidos = [];
    await pagina.locator('[data-testid=mt-select-step1Destination]').click({ timeout: ESPERA });
    await dormir(1500);
    for (const pais of paises.slice(0, 5)) {
      const opcion = pagina.getByText(pais, { exact: true }).first();
      if (await opcion.count()) {
        await opcion.click({ timeout: 6000 }).catch(() => {});
        elegidos.push(pais);
        await dormir(700);
      }
    }
    await pagina.keyboard.press('Escape').catch(() => {});
    await dormir(800);

    // NI UN PRESUPUESTO SIN DESTINO. Si ninguno de los países de la ruta está en
    // su lista, lo que salga sería el precio de otro viaje.
    if (!elegidos.length) {
      throw new Error(`Heymondo no reconoce ninguno de estos países: ${paises.join(', ')}`);
    }

    await pagina.locator('[data-testid=btn-step1Next]').click({ timeout: ESPERA });
    await dormir(3000);

    // --- 3) Fechas ----------------------------------------------------------
    await elegirFecha(pagina, 'cnt-step2StartDate', fechaInicio);
    await elegirFecha(pagina, 'cnt-step2EndDate', fechaFin);
    await pagina.keyboard.press('Escape').catch(() => {});
    await dormir(900);
    await pagina.locator('[data-testid=btn-step2Next]').click({ timeout: ESPERA });
    await dormir(3000);

    // --- 4) Viajeros --------------------------------------------------------
    await ponerViajeros(pagina, adultos, edadesNinos);
    await dormir(1000);

    const ultimo = pagina.locator('[data-testid=btn-step3Next]');
    if (await ultimo.count()) {
      await ultimo.click({ timeout: ESPERA }).catch(() => {});
    }

    // El tarificador tarda: se espera a que aparezca algún precio.
    await pagina
      .waitForFunction(() => /\d[\d.,]*\s*€/.test(document.body.innerText), null, { timeout: 30_000 })
      .catch(() => {});
    await dormir(2500);

    const opciones = await leerOpciones(pagina);

    return {
      opciones,
      url: pagina.url(),
      paises: elegidos,
      viajeros: adultos + edadesNinos.length,
    };
  } finally {
    await cerrarNavegador(contexto);
  }
}

/**
 * Pone el número de viajeros y las edades.
 *
 * El paso enseña un contador por tipo de viajero y un campo de edad por cada
 * uno. Como su marcado es el que menos garantías tiene, esto avanza con lo que
 * encuentre y no revienta si no hay nada que tocar: con un solo adulto el paso
 * ya viene relleno de fábrica, que es el caso más común.
 */
async function ponerViajeros(pagina, adultos, edadesNinos) {
  const mas = pagina.locator(
    '[data-testid*=Add], [data-testid*=Plus], [data-testid*=Increment], button[aria-label*="ñad"]'
  );
  const cuantosFaltan = Math.max(0, adultos - 1);

  for (let i = 0; i < cuantosFaltan && (await mas.count()); i++) {
    await mas.first().click({ timeout: 5000 }).catch(() => {});
    await dormir(500);
  }

  // Las edades, si las pide.
  const campos = pagina.locator('[data-testid*=age] input, input[type=number]');
  const n = await campos.count().catch(() => 0);
  const edades = [...Array(adultos).fill(35), ...edadesNinos];
  for (let i = 0; i < Math.min(n, edades.length); i++) {
    await campos.nth(i).fill(String(edades[i])).catch(() => {});
    await dormir(300);
  }
}

export default { buscarSegurosHeymondo };
