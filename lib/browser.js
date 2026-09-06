/**
 * lib/browser.js
 * -----------------------------------------------------------------------------
 * Helper compartido por TODOS los proveedores (vueling, booking, civitatis...).
 * Su única responsabilidad es arrancar y cerrar un navegador "normal", y ofrecer
 * utilidades de comportamiento humano (pausas aleatorias, pausa por captcha).
 *
 * Decisiones de diseño:
 *  - CONTEXTO PERSISTENTE: usamos launchPersistentContext con userDataDir en
 *    ./browser-profile. Así el navegador conserva cookies, localStorage y sesión
 *    entre ejecuciones: si un día resuelves un captcha o te logueas, se recuerda.
 *  - VENTANA VISIBLE (headless: false): queremos ver qué hace el script.
 *  - NADA DE TRUCOS: no falseamos el user agent ni parcheamos navigator.webdriver.
 *    Usamos el Chrome real del sistema si está instalado, con su UA de fábrica.
 */

import { chromium } from 'playwright';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import readline from 'node:readline';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

/** Carpeta donde se guarda el perfil persistente del navegador. */
export const DIR_PERFIL = path.join(__dirname, '..', 'browser-profile');

/** Timeout generoso: Vueling puede tardar bastante en pintar resultados. */
export const TIMEOUT_LARGO = 30_000;

/** Espera pasiva de N milisegundos. */
export const dormir = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * Pausa "humana": un intervalo aleatorio entre acciones para no comportarnos
 * como un robot que hace 20 clics en 100 ms.
 */
export function pausaHumana(min = 500, max = 1500) {
  const ms = Math.floor(min + Math.random() * (max - min));
  return dormir(ms);
}

/**
 * Arranca el navegador con perfil persistente y devuelve { contexto, pagina }.
 *
 * Intentamos usar el Chrome instalado en el sistema (channel: 'chrome') porque
 * es indistinguible de tu navegador habitual. Si no está, caemos al Chromium
 * que trae Playwright.
 */
export async function abrirNavegador({ headless = false } = {}) {
  const opcionesBase = {
    headless,
    viewport: { width: 1440, height: 900 }, // resolución de portátil corriente
    locale: 'es-ES',
    timezoneId: 'Europe/Madrid',
    // Playwright ya trae un User-Agent real del navegador que lanza; no lo tocamos.
    args: [
      // Chrome, cuando lo arranca una herramienta de automatización, activa la
      // "AutomationControlled" y eso pone navigator.webdriver = true, que es la
      // señal MÁS obvia y la primera que mira cualquier antibot.
      // Esta bandera evita que se active de entrada. Es lo único que tocamos:
      // no falseamos user agent, ni plugins, ni canvas, ni nada por el estilo.
      '--disable-blink-features=AutomationControlled',

      // La ventana se abre FUERA DE PANTALLA, a la izquierda del todo.
      //
      // Sigue siendo una ventana real, con su renderizado, su tamaño y su
      // comportamiento: NADA de headless. Los cuatro scrapers están validados
      // con ventana de verdad, y en headless los antibots de Booking y Kayak
      // los cazarían en el primer intento. Lo único que cambia es dónde
      // aparece: así deja de saltar al primer plano cada vez que se busca algo.
      //
      // Si algún día hace falta ver qué está haciendo, se quita esta línea y la
      // ventana vuelve al centro.
      '--window-position=-2400,0',
    ],
  };

  // Timeout explícito al arrancar. Si el perfil de ./browser-profile ya lo tiene
  // abierto otro proceso, Chrome delega en la instancia existente y se cierra,
  // y Playwright se queda esperando un navegador que nunca responde. Sin este
  // tope, el worker se colgaba ahí para siempre.
  opcionesBase.timeout = 45_000;

  let contexto;
  try {
    // Opción preferida: Chrome de escritorio real.
    contexto = await chromium.launchPersistentContext(DIR_PERFIL, {
      ...opcionesBase,
      channel: 'chrome',
    });
  } catch {
    // Fallback: Chromium empaquetado con Playwright.
    console.warn('[browser] No se encontró Chrome del sistema; uso el Chromium de Playwright.');
    contexto = await chromium.launchPersistentContext(DIR_PERFIL, opcionesBase);
  }

  // Cinturón y tirantes: si aun así quedara definida, la dejamos en undefined,
  // que es lo que devuelve un Chrome normal. Se ejecuta antes que el JS de la
  // página, en cada documento nuevo.
  await contexto.addInitScript(() => {
    if (navigator.webdriver !== undefined) {
      Object.defineProperty(navigator, 'webdriver', { get: () => undefined });
    }
  });

  // Timeout por defecto para TODAS las esperas de este contexto.
  contexto.setDefaultTimeout(TIMEOUT_LARGO);
  contexto.setDefaultNavigationTimeout(TIMEOUT_LARGO);

  // El contexto persistente ya nace con una pestaña abierta; la reutilizamos.
  const pagina = contexto.pages()[0] ?? (await contexto.newPage());

  return { contexto, pagina };
}

/**
 * Un "golpe" de scroll con aspecto humano: baja una fracción irregular de la
 * pantalla y espera un rato irregular. Pensado para listados con carga
 * diferida, donde bajar de golpe al final NO dispara la carga (y además canta
 * muchísimo).
 *
 * Devuelve true si ya estamos al final de la página.
 */
export async function scrollHumano(pagina, { minPausa = 500, maxPausa = 2000 } = {}) {
  const alFinal = await pagina.evaluate(() => {
    // Entre el 60% y el 95% de la pantalla: una persona no scrollea siempre igual.
    const salto = Math.round(window.innerHeight * (0.6 + Math.random() * 0.35));
    // OJO: scroll INSTANTANEO, nada de behavior:'smooth'. El suave es asincrono,
    // asi que dos saltos seguidos se pisan y te quedas casi donde estabas: el
    // listado deja de cargar y parece que se ha acabado cuando no es verdad.
    // El aspecto humano lo da el tamaño irregular del salto y la pausa, no la
    // animacion.
    window.scrollBy(0, salto);
    return window.scrollY + window.innerHeight >= document.body.scrollHeight - 100;
  });
  await pausaHumana(minPausa, maxPausa);
  return alFinal;
}

/** Cierra el navegador sin reventar si ya estaba cerrado. */
export async function cerrarNavegador(contexto) {
  try {
    await contexto?.close();
  } catch {
    /* ya estaba cerrado */
  }
}

/**
 * Espera a que el usuario pulse Enter en la terminal.
 * Se usa cuando detectamos un captcha: NO intentamos resolverlo ni saltarlo,
 * simplemente cedemos el control a la persona que está delante de la pantalla.
 */
export function esperarEnter(mensaje) {
  return new Promise((resolve) => {
    const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
    rl.question(`\n${mensaje}\n> `, () => {
      rl.close();
      resolve();
    });
  });
}

/**
 * Detecta las señales típicas de un muro de verificación (captcha, "verify you
 * are human", DataDome, Cloudflare...). Si encuentra alguna, pausa el script.
 *
 * Es deliberadamente conservador: ante la duda, prefiere no pausar. Si Vueling
 * cambia el muro, siempre puedes pausar tú a mano con Ctrl+C.
 */
export async function comprobarCaptcha(pagina, { paso = 'sin especificar' } = {}) {
  const señales = [
    'iframe[src*="recaptcha"]',
    'iframe[src*="hcaptcha"]',
    'iframe[title*="challenge" i]',
    '#px-captcha',                       // PerimeterX
    '[id*="datadome" i]',                // DataDome
    'text=/verify (that )?you are (a )?human/i',
    'text=/no soy un robot/i',
    // Booking y compañía: pantallas de "confirma que eres una persona".
    'text=/comprueba que eres (una persona|humano)/i',
    'text=/confirma que eres (una persona|humano)/i',
    'text=/press (and hold|y mant)/i',   // el típico "mantén pulsado"
    'text=/unusual (traffic|activity)/i',
  ];

  for (const señal of señales) {
    // count() es instantáneo: no espera al timeout si no existe.
    const encontrado = await pagina.locator(señal).count().catch(() => 0);
    if (encontrado > 0) {
      console.log('\n' + '='.repeat(70));
      console.log(`[!] Parece que hay un CAPTCHA o verificación (paso: ${paso}).`);
      console.log('    NO voy a intentar saltarlo.');
      console.log('='.repeat(70));
      await esperarEnter('Resuelve el captcha en la ventana y pulsa Enter para continuar');
      return true;
    }
  }
  return false;
}
