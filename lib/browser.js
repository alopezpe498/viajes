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
import { existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import readline from 'node:readline';
import { apuntarScraping, apuntarEsperaDeScraping } from '../services/cronometro.js';
import { semaforo } from '../services/paralelo.js';
import { parametro } from '../services/orquestador.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

/** Carpeta donde se guarda el perfil persistente del navegador. */
export const DIR_PERFIL = path.join(__dirname, '..', 'browser-profile');

/** Timeout generoso: Vueling puede tardar bastante en pintar resultados. */
export const TIMEOUT_LARGO = 30_000;

/**
 * DÓNDE ESTÁ EL CHROME DE ESTE ORDENADOR.
 *
 * `channel: 'chrome'` funciona en Windows y en Mac, y en el servidor de Linux no
 * encuentra nada: por eso el log repetía «No se encontró Chrome del sistema» en
 * CADA trabajo. Aquí se miran las rutas de siempre y se deja fijarla a mano con
 * `RUTA_CHROME` en el .env, que es lo que resuelve una instalación rara.
 *
 * Se busca UNA vez por proceso: la respuesta no cambia mientras el servidor esté
 * levantado, y buscarla por trabajo era la mitad del ruido.
 */
const RUTAS_DE_CHROME = [
  '/usr/bin/google-chrome',
  '/usr/bin/google-chrome-stable',
  '/usr/bin/chromium-browser',
  '/usr/bin/chromium',
  '/snap/bin/chromium',
  '/opt/google/chrome/chrome',
];

let chromeBuscado = false;
let chromeEncontrado = null;

export function chromeDelSistema() {
  if (chromeBuscado) return chromeEncontrado;
  chromeBuscado = true;

  const puesto = process.env.RUTA_CHROME?.trim();
  if (puesto) {
    chromeEncontrado = existsSync(puesto) ? puesto : null;
    if (!chromeEncontrado) {
      console.warn(`[browser] RUTA_CHROME apunta a «${puesto}» y ahí no hay nada.`);
    }
    return chromeEncontrado;
  }

  // En Windows y Mac el canal de Playwright ya lo resuelve: no hay que buscar.
  if (process.platform !== 'linux') return null;

  chromeEncontrado = RUTAS_DE_CHROME.find((r) => existsSync(r)) ?? null;
  if (chromeEncontrado) console.log(`[browser] Chrome del sistema: ${chromeEncontrado}`);
  return chromeEncontrado;
}

/** Lo mismo dicho mil veces deja de leerse. Cada aviso, una vez por arranque. */
const yaDichos = new Set();
function avisarUnaVez(texto) {
  if (yaDichos.has(texto)) return;
  yaDichos.add(texto);
  console.warn(texto);
}

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
/**
 * UN NAVEGADOR POR DOMINIO, Y UNO SOLO POR DOMINIO.
 *
 * DE DÓNDE VIENE ESTO. El correctivo anterior puso una única plaza de navegador
 * para todo, y arregló el «profile is already in use» a costa de serializar el
 * scraping entero: un viaje de 23m 51s con solo 6m 21s de scraping y 5m 12s de
 * IA, y CATORCE MINUTOS Y MEDIO de resto. Las tres fases paralelas se pasaban el
 * viaje esperando turno para un Chrome que estaba ocupado con otra cosa.
 *
 * La plaza única era demasiado gruesa. Lo que no se puede compartir no es «el
 * navegador»: es EL PERFIL. Y un perfil por dominio resuelve las dos cosas a la
 * vez:
 *
 *   · Booking y Kayak ya no se estorban — son sitios distintos, sus cookies no
 *     tienen nada que ver y cada uno abre SU `browser-profile-booking`.
 *   · Y sigue habiendo uno solo por dominio, que es lo que de verdad importaba:
 *     dos búsquedas simultáneas contra Booking desde la misma IP es como se
 *     consigue un captcha.
 *
 * El perfil de cada dominio se mantiene entre viajes, así que las sesiones
 * calientes que evitan los captchas siguen ahí; simplemente están repartidas en
 * cuatro carpetas en vez de en una.
 */
const plazasPorDominio = new Map();

function plazaDelDominio(de) {
  const dominio = String(de ?? 'otros').toLowerCase();
  if (!plazasPorDominio.has(dominio)) {
    plazasPorDominio.set(dominio, semaforo(() => parametro('concurrencia_por_dominio', 1)));
  }
  return plazasPorDominio.get(dominio);
}

/** Qué plaza tiene cada contexto abierto, para poder soltarla al cerrar. */
const plazaDe = new Map();

/**
 * EL TOPE POR TRABAJO, Y ESTA VEZ MATANDO.
 *
 * LO QUE PASÓ. El primer trabajo de Civitatis se quedó colgado y el vigilante
 * tardó QUINCE MINUTOS en soltar la plaza —y cuando la soltó, el navegador
 * seguía vivo por su cuenta—. Quince minutos de un viaje que debería durar diez.
 *
 * Dos cambios, y el segundo es el que importa:
 *
 *   · El tope baja a tres minutos. Un scraping que no ha terminado en tres
 *     minutos no va a terminar: se ha quedado esperando un selector que no
 *     existe o una página que no carga, y los dos tienen ya su propio tope de
 *     30 s por paso. Si se pasa de tres minutos es que ninguno saltó.
 *
 *   · Al saltar, se CIERRA el navegador. Soltar la plaza y dejar el Chrome
 *     abierto era lo peor de los dos mundos: el siguiente trabajo entraba y se
 *     encontraba el perfil ocupado por un fantasma.
 */
const TOPE_POR_TRABAJO_MIN = 3;

/** ¿Este error es el del perfil pisado? Es transitorio por definición. */
export function esPerfilPisado(err) {
  const t = `${err?.message ?? ''}`.toLowerCase();

  // «profile» + «in use» en la misma frase, en vez de la frase exacta: Chrome
  // no siempre lo dice igual —«is already in use», «appears to be in use»— y
  // la prueba cazó justo la variante que se me había escapado.
  if (t.includes('profile') && t.includes('in use')) return true;

  return (
    t.includes('singletonlock') ||
    t.includes('opening in existing browser session') ||
    t.includes('existing browser session') ||
    t.includes('profilelock') ||
    t.includes('browser has disconnected') ||
    t.includes('target page, context or browser has been closed')
  );
}

export async function abrirNavegador(opciones = {}) {
  const dominio = String(opciones.de ?? 'otros').toLowerCase();
  const pedida = Date.now();
  const { soltar } = await plazaDelDominio(dominio).coger();

  // LO QUE SE HA ESPERADO, APUNTADO APARTE DE LO QUE SE HA TRABAJADO.
  //
  // La métrica decía «Gdansk 37m 40s» dentro de una fase de 18m 57s, que es
  // imposible y delataba el problema: la espera en cola se contaba como trabajo
  // de la parada. Son dos cosas distintas y desde aquí se distinguen.
  const espera = Date.now() - pedida;

  const tope = Math.max(1, parametro('tope_por_trabajo_scraping_min', TOPE_POR_TRABAJO_MIN));
  let elContexto = null;

  const alarma = setTimeout(async () => {
    console.warn(
      `[browser] ${dominio}: el trabajo lleva ${tope} min y sigue colgado. ` +
        'Mato el navegador y suelto la plaza.'
    );
    // SE MATA, no se abandona. Un contexto huérfano deja el perfil tomado y el
    // siguiente trabajo del mismo dominio se encuentra el «profile in use».
    try {
      await elContexto?.close();
    } catch {
      /* ya estaba muerto, que es justo lo que se buscaba */
    }
    abiertos.delete(elContexto);
    pararReloj(elContexto);
    soltar();
  }, tope * 60 * 1000);

  const devolver = () => {
    clearTimeout(alarma);
    soltar();
  };

  // REINTENTO CON ESPERA CRECIENTE. Un Chrome zombi de una ejecución anterior
  // deja el SingletonLock puesto y el arranque falla por algo que se arregla
  // solo en unos segundos. Darlo por perdido a la primera es lo que convirtió un
  // tropiezo en «0 excursiones preseleccionadas».
  const veces = Math.max(0, Math.min(5, parametro('reintentos_navegador', 2)));

  for (let intento = 0; ; intento += 1) {
    try {
      const abierto = await arrancarNavegador({ ...opciones, dominio });
      elContexto = abierto.contexto;
      plazaDe.set(abierto.contexto, devolver);
      apuntarEsperaDeScraping({ de: dominio, ms: espera });
      return abierto;
    } catch (err) {
      if (!esPerfilPisado(err) || intento >= veces) {
        devolver();
        throw err;
      }
      const pausa = 2000 * (intento + 1);
      console.warn(
        `[browser] ${dominio}: el perfil estaba en uso (${err.message.slice(0, 80)}). ` +
          `Reintento ${intento + 1} de ${veces} en ${pausa / 1000}s.`
      );
      await dormir(pausa);
    }
  }
}

async function arrancarNavegador({ headless = false, de = null, dominio = null } = {}) {
  // CADA DOMINIO, SU PERFIL. Es lo que permite que Booking y Kayak corran a la
  // vez sin pisarse: son carpetas distintas, y un perfil solo se puede abrir una
  // vez, no un perfil cualquiera.
  const cual = String(dominio ?? de ?? '').toLowerCase().replace(/[^a-z0-9]+/g, '');
  const perfil = cual ? `${DIR_PERFIL}-${cual}` : DIR_PERFIL;

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
  const chrome = chromeDelSistema();

  try {
    // Opción preferida: Chrome de escritorio real. En Linux se le da la ruta
    // encontrada; en Windows y Mac basta el canal, que Playwright ya resuelve.
    contexto = await chromium.launchPersistentContext(perfil, {
      ...opcionesBase,
      ...(chrome ? { executablePath: chrome } : { channel: 'chrome' }),
    });
  } catch {
    // Fallback: Chromium empaquetado con Playwright.
    avisarUnaVez(
      '[browser] No se encontró Chrome del sistema; uso el Chromium de Playwright. ' +
        'En el servidor, instálalo o pon RUTA_CHROME en el .env.'
    );
    contexto = await chromium.launchPersistentContext(perfil, opcionesBase);
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

  abiertos.add(contexto);

  // DE AQUÍ SALE EL «SCRAPING 3M 30S» DEL REGISTRO.
  //
  // Una sesión de navegador es la unidad natural: abrir Chrome, buscar y
  // cerrarlo. Medirlo aquí y no dentro de cada proveedor tiene la ventaja de que
  // cuenta TODO lo que cuesta —arrancar el perfil, esperar a que cargue, los
  // reintentos internos del scraper— y no solo el rato en que se leen tarjetas.
  //
  // `de` es quién lo abrió. Es un texto que da el proveedor, no algo adivinado
  // de la pila de llamadas: adivinarlo funcionaría hasta el día que alguien
  // renombre un fichero.
  cronometros.set(contexto, { de: de ?? 'sin nombre', desde: Date.now() });
  return { contexto, pagina };
}

/**
 * LOS NAVEGADORES QUE ESTÁN ABIERTOS AHORA MISMO.
 *
 * Existe solo para el botón de «Abortar ya»: un scraping colgado esperando a que
 * Kayak pinte algo no se puede alcanzar desde ninguna otra parte, y matar el
 * proceso entero era justo lo que se quería evitar.
 *
 * La cola ejecuta de uno en uno, así que casi siempre hay cero o uno; es un Set
 * porque cerrar algo que ya se cerró tiene que ser inofensivo.
 */
const abiertos = new Set();

/** Cuándo se abrió cada contexto y quién lo abrió. Solo para medir. */
const cronometros = new Map();

/** Cierra el reloj de un contexto y se lo cuenta al cronómetro de la fase. */
function pararReloj(contexto) {
  const reloj = cronometros.get(contexto);
  if (!reloj) return;
  cronometros.delete(contexto);
  apuntarScraping({ desde: reloj.desde, hasta: Date.now(), de: reloj.de });
}

/**
 * Cierra a la fuerza todos los navegadores abiertos.
 *
 * Lo que estuviera esperando dentro de Playwright revienta con su propio error
 * —«Target closed»— y sube como un fallo normal de la fase, que es exactamente
 * lo que se quiere: la fase se entera de que la han cortado.
 */
export async function abortarNavegadores() {
  const cuantos = abiertos.size;
  for (const c of [...abiertos]) {
    try {
      await c.close();
    } catch {
      /* ya estaba cerrándose */
    }
    abiertos.delete(c);
    pararReloj(c);
    plazaDe.get(c)?.();
    plazaDe.delete(c);
  }
  return cuantos;
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
  } finally {
    abiertos.delete(contexto);
    pararReloj(contexto);
    // Y aquí se suelta la plaza, que es lo que faltaba: tenerla de abrir a
    // cerrar es lo único que impide que dos Chrome pisen el mismo perfil.
    plazaDe.get(contexto)?.();
    plazaDe.delete(contexto);
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
