/**
 * providers/google-busqueda.js
 * -----------------------------------------------------------------------------
 * UNA BÚSQUEDA EN GOOGLE, CON NAVEGADOR DE VERDAD, PARA SACAR DATOS DUROS.
 *
 * Se le pide a Google una tabla con el precio, el horario, la duración, la web y
 * el teléfono de TODOS los sitios de una ciudad de golpe. Una sola búsqueda por
 * etapa: quince búsquedas sueltas serían quince oportunidades de que salte un
 * captcha, y quince veces más lento.
 *
 * QUÉ SE TRAE DE AQUÍ Y QUÉ NO. Este archivo solo trae TEXTO: lo que Google
 * haya respondido, en crudo. No interpreta nada, no rellena huecos y no sabe
 * qué es un precio. De convertir ese texto en campos se encarga la IA, en
 * services/datos-sitios.js, y con la orden expresa de no inventarse lo que no
 * esté escrito.
 *
 * ESTO ES FRÁGIL Y CONVIENE SABERLO. El bloque de respuesta con IA de Google no
 * tiene un selector estable ni documentado, y cambia cada pocos meses. Por eso
 * se buscan varios contenedores conocidos y, si ninguno aparece, se cae al
 * texto de los resultados normales. Cuando Google cambie la maqueta, esto
 * devolverá menos datos —no datos falsos—, y las fichas se quedarán con huecos,
 * que es el fallo bueno.
 *
 * EL CAPTCHA NO SE ESPERA. `comprobarCaptcha` de lib/browser.js se queda
 * esperando a que alguien lo resuelva y pulse Enter, y eso aquí colgaría la cola
 * de trabajos para siempre. Aquí se detecta y se aborta: la etapa sigue su
 * camino y las fichas se quedan sin datos duros, con su aviso en la cola.
 */
import {
  abrirNavegador,
  cerrarNavegador,
  dormir,
  pausaHumana,
  TIMEOUT_LARGO,
} from '../lib/browser.js';

const BASE = 'https://www.google.com';

/** Un captcha aquí no se resuelve: se cuenta y se sale. */
export class ErrorCaptcha extends Error {
  constructor(mensaje) {
    super(mensaje);
    this.name = 'ErrorCaptcha';
  }
}

/** Las mismas señales que usa lib/browser.js, pero sin quedarse esperando. */
const SEÑALES_CAPTCHA = [
  'iframe[src*="recaptcha"]',
  'iframe[src*="hcaptcha"]',
  'form#captcha-form',
  '#recaptcha',
  'text=/nuestros sistemas han detectado tráfico/i',
  'text=/unusual traffic/i',
  'text=/no soy un robot/i',
];

async function hayCaptcha(pagina) {
  for (const señal of SEÑALES_CAPTCHA) {
    const n = await pagina.locator(señal).count().catch(() => 0);
    if (n > 0) return true;
  }
  return false;
}

/** El banner de cookies de Google, que tapa la página entera si no se cierra. */
async function aceptarCookies(pagina) {
  const botones = [
    'button:has-text("Aceptar todo")',
    'button:has-text("Aceptar todas")',
    'button:has-text("Accept all")',
    '#L2AGLb',
  ];
  for (const sel of botones) {
    const b = pagina.locator(sel).first();
    if (await b.count().catch(() => 0)) {
      await b.click({ timeout: 4000 }).catch(() => {});
      await dormir(700);
      return true;
    }
  }
  return false;
}

/**
 * La pregunta, escrita como se le preguntaría a una persona.
 *
 * Google responde mejor a una frase natural que a una ristra de palabras
 * clave, y lo que interesa es justo que dispare su respuesta con IA, que es la
 * que devuelve tablas.
 */
export function componerPregunta(ciudad, sitios) {
  const lista = sitios.join(', ');
  return (
    'Dame una tabla con el precio de la entrada, los horarios de apertura, ' +
    `el tiempo estimado de visita, la web oficial y el teléfono de: ${lista}, en ${ciudad}`
  );
}

/**
 * Los contenedores donde Google ha ido metiendo su respuesta con IA.
 *
 * Van de más específico a más general. Ninguno está documentado y todos son
 * susceptibles de desaparecer, así que se prueban en orden y se usa el primero
 * que traiga texto suficiente.
 */
const BLOQUES_IA = [
  '[data-attrid="AIOverview"]',
  '[data-subtree="aio"]',
  '#m-x-content',
  'div[aria-label*="IA" i]',
  'div[aria-label*="AI Overview" i]',
];

/** Lo que se considera "ha contestado algo": menos que esto no vale la pena. */
const MINIMO_UTIL = 200;

/**
 * Pregunta a Google y devuelve el texto de la respuesta.
 *
 * @returns {Promise<{texto: string, fuente: string, url: string}>}
 */
export async function buscarTablaDeSitios({ ciudad, sitios, headless = false }) {
  const limpios = (sitios ?? []).map((s) => String(s ?? '').trim()).filter(Boolean);
  if (!ciudad || !limpios.length) {
    throw new Error('[google-busqueda] Hace falta la ciudad y al menos un sitio.');
  }

  const pregunta = componerPregunta(ciudad, limpios);
  console.log(`[google-busqueda] ${limpios.length} sitios de ${ciudad}, en una sola consulta.`);

  const { contexto, pagina } = await abrirNavegador({ headless });

  try {
    await pagina.goto(BASE, { waitUntil: 'domcontentloaded', timeout: TIMEOUT_LARGO });
    await aceptarCookies(pagina);

    if (await hayCaptcha(pagina)) {
      throw new ErrorCaptcha('Google pidió verificación nada más entrar.');
    }

    // Se escribe con pausas, no de golpe: un `fill` instantáneo de trescientos
    // caracteres es de las cosas que disparan la verificación.
    const caja = pagina.locator('textarea[name="q"], input[name="q"]').first();
    await caja.waitFor({ state: 'visible', timeout: TIMEOUT_LARGO });
    await caja.click();
    await caja.type(pregunta, { delay: 12 });
    await pausaHumana(400, 900);
    await caja.press('Enter');

    await pagina.waitForLoadState('domcontentloaded', { timeout: TIMEOUT_LARGO });

    if (await hayCaptcha(pagina)) {
      throw new ErrorCaptcha('Google pidió verificación después de buscar.');
    }

    // La respuesta con IA tarda en montarse: aparece después de los resultados
    // normales y se va rellenando sola. No hay evento que avisar, así que se le
    // dan unos segundos y se mira qué hay.
    await dormir(6000);

    for (const sel of BLOQUES_IA) {
      const bloque = pagina.locator(sel).first();
      if (!(await bloque.count().catch(() => 0))) continue;

      const texto = (await bloque.innerText().catch(() => '')).trim();
      if (texto.length >= MINIMO_UTIL) {
        console.log(`[google-busqueda] respuesta con IA (${sel}): ${texto.length} caracteres.`);
        return { texto, fuente: 'google-ia', url: pagina.url() };
      }
    }

    // SIN BLOQUE DE IA, LOS RESULTADOS NORMALES. Traen menos y peor —fragmentos
    // sueltos de cada web— pero de ahí también salen horarios y precios, y es
    // mejor que volver con las manos vacías.
    const resultados = pagina.locator('#search, #rso').first();
    const texto = (await resultados.innerText().catch(() => '')).trim();

    if (texto.length >= MINIMO_UTIL) {
      console.log(`[google-busqueda] sin bloque de IA; uso los resultados: ${texto.length} caracteres.`);
      return { texto, fuente: 'google-resultados', url: pagina.url() };
    }

    throw new Error('Google no devolvió nada aprovechable.');
  } finally {
    await cerrarNavegador(contexto);
  }
}

export default { buscarTablaDeSitios, componerPregunta, ErrorCaptcha };
