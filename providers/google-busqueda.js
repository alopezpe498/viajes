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
 * SE VA DIRECTO AL MODO IA por URL (`udm=50`), sin pasar por el cuadro de
 * búsqueda. La versión anterior escribía la pregunta en la portada y esperaba a
 * que apareciera el bloque de respuesta con IA entre los resultados normales;
 * ese bloque salía a veces y a veces no, y cuando no salía se tiraba de los
 * resultados corrientes —fragmentos sueltos de cada web—. En París eso daba 2
 * sitios de 10.
 *
 * Y LA RESPUESTA VIENE EN STREAMING: se escribe sola durante varios segundos.
 * Leer el DOM al cargar devuelve el primer párrafo, así que se espera a que el
 * texto deje de crecer antes de extraer nada.
 *
 * Sigue siendo frágil, y conviene saberlo: ni la URL ni los contenedores están
 * documentados. Cuando Google cambie la maqueta, esto devolverá menos datos —no
 * datos falsos—, y las fichas se quedarán con huecos, que es el fallo bueno.
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
  TIMEOUT_LARGO,
} from '../lib/browser.js';

/**
 * EL MODO IA DE GOOGLE, POR URL DIRECTA.
 *
 * `udm=50` abre el Modo IA con la consulta ya procesada, sin pasar por el
 * cuadro de búsqueda. Antes se escribía la pregunta en la caja de la portada y
 * se esperaba a que apareciera el bloque de respuesta con IA entre los
 * resultados normales; ese bloque aparecía a veces y a veces no, y cuando no
 * aparecía se tiraba de los resultados corrientes, que traen fragmentos sueltos
 * de cada web: en la prueba de París salieron 2 sitios de 10.
 *
 * Con esta URL la tabla viene completa, con tramos de precio, horarios (días de
 * cierre incluidos) y tiempos de visita.
 */
const BASE_MODO_IA = 'https://www.google.com/search?udm=50&q=';

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
 * Ninguno está documentado y todos son susceptibles de desaparecer, así que se
 * prueban todos y se usa EL MÁS LARGO, no el primero que traiga algo. Esto no
 * es una manía: `div[aria-label*="IA" i]` casa con trozos de la interfaz del
 * Modo IA —la cabecera de la conversación, sin ir más lejos— que traen 400
 * caracteres y no crecen nunca. Cogiendo el primero, la espera de streaming los
 * daba por respuesta terminada a los dos segundos y la tabla se quedaba sin
 * leer. Ese era el fallo de los 2 sitios de 10.
 */
const BLOQUES_IA = [
  '[data-attrid="AIOverview"]',
  '[data-subtree="aio"]',
  '#m-x-content',
  'div[aria-label*="IA" i]',
  'div[aria-label*="AI Overview" i]',
  '[role="main"]',
  '#main',
];

/** Lo que se considera "ha contestado algo": menos que esto no vale la pena. */
const MINIMO_UTIL = 200;

/** Techo de espera del streaming. Pasado esto, se usa lo que haya. */
const TOPE_STREAMING_MS = 45_000;
/** Cada cuánto se mira si el texto ha crecido. */
const LATIDO_MS = 800;
/**
 * Cuántas miradas seguidas sin crecer para darlo por terminado.
 *
 * Ocho, o sea seis segundos y pico, y no es exageración: el streaming SE PARA A
 * MEDIAS. Midiendo París cada 0,8 s la curva fue 708, 1030 —y ahí cuatro
 * segundos clavado—, 3442, 4210. Con una ventana corta se aceptaba el 1030, que
 * es el enunciado y la primera fila, y de ahí salían dos sitios de diez. La
 * ventana tiene que ser más larga que la pausa más larga; seis segundos le dan
 * margen de sobra a los cuatro medidos.
 */
const QUIETO_PARA_TERMINAR = 8;
/** Cuántas aguantando quieto sin haber crecido nunca para aceptarlo igual. */
const QUIETO_SIN_CRECER = 15;

/**
 * ESPERA A QUE LA RESPUESTA DEJE DE CRECER.
 *
 * El Modo IA escribe en streaming: el texto va apareciendo durante varios
 * segundos. Pero antes de empezar a escribir, Google ya ha pintado la pregunta
 * —dos veces, la cabecera de la conversación y el enunciado— y esa cabecera se
 * queda quieta un buen rato. Medir solo "el texto no ha crecido" daba la
 * respuesta por terminada a los tres segundos, con el enunciado y nada más.
 *
 * Así que se exige que HAYA CRECIDO por encima de la primera medida antes de
 * aceptar ninguna quietud. Eso se calibra solo: la primera medida es el
 * enunciado, y la respuesta, cuando llega, siempre lo supera. No hace falta
 * saber cuánto ocupa la pregunta ni acertar un mínimo a ojo.
 *
 * Y una salida por si la respuesta ya estaba entera en la primera mirada, que
 * con la caché de Google puede pasar: si el texto lleva mucho rato quieto sin
 * haber crecido, se acepta igual. Vale más leer de más que colgarse.
 */
async function esperarAQueTermine(pagina, leer) {
  const empezo = Date.now();
  let inicial = -1;
  let anterior = -1;
  let quieto = 0;

  while (Date.now() - empezo < TOPE_STREAMING_MS) {
    await dormir(LATIDO_MS);
    const largo = (await leer().catch(() => '')).length;
    if (inicial < 0) inicial = largo;

    if (largo > 0 && largo === anterior) quieto += 1;
    else quieto = 0;
    anterior = largo;

    const crecio = largo > inicial;
    const quietoDeSobra = quieto >= QUIETO_SIN_CRECER;

    if (largo >= MINIMO_UTIL && quieto >= QUIETO_PARA_TERMINAR && (crecio || quietoDeSobra)) {
      console.log(
        `[google-busqueda] respuesta estable en ${((Date.now() - empezo) / 1000).toFixed(1)} s ` +
          `(${largo} caracteres${crecio ? '' : ', sin crecer desde el principio'}).`
      );
      return true;
    }
  }

  console.warn(
    `[google-busqueda] la respuesta seguía creciendo a los ${TOPE_STREAMING_MS / 1000} s: ` +
      'uso lo que haya llegado.'
  );
  return false;
}

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
  const url = BASE_MODO_IA + encodeURIComponent(pregunta);
  console.log(`[google-busqueda] ${limpios.length} sitios de ${ciudad}, en una sola consulta.`);

  const { contexto, pagina } = await abrirNavegador({ headless });

  try {
    // DIRECTOS AL MODO IA. Sin portada, sin escribir en la caja y sin pulsar
    // Enter: la consulta va en la URL y Google la procesa al cargar.
    await pagina.goto(url, { waitUntil: 'domcontentloaded', timeout: TIMEOUT_LARGO });
    await aceptarCookies(pagina);

    if (await hayCaptcha(pagina)) {
      throw new ErrorCaptcha('Google pidió verificación al abrir el Modo IA.');
    }

    // DE DÓNDE SE LEE. Se miran todos los contenedores conocidos y se coge el
    // que más texto traiga, no el primero que traiga algo. El Modo IA es una
    // página dedicada: toda la zona principal ES la respuesta, y varios de los
    // selectores casan con trozos pequeños de la interfaz que nunca crecen.
    // Que se cuele algo de menú alrededor no estorba: quien lo lee después es
    // la IA, que sabe distinguir una tabla de una barra de navegación.
    const dondeLeer = async () => {
      let mejor = '';
      for (const sel of BLOQUES_IA) {
        const b = pagina.locator(sel).first();
        if (!(await b.count().catch(() => 0))) continue;
        const t = (await b.innerText().catch(() => '')).trim();
        if (t.length > mejor.length) mejor = t;
      }
      return mejor;
    };

    // LA ESPERA, que es el arreglo. La respuesta se escribe en streaming y
    // leerla nada más cargar devolvía el primer párrafo: con eso salían 2 de 10
    // sitios. Se espera a que el texto deje de crecer.
    await esperarAQueTermine(pagina, dondeLeer);

    if (await hayCaptcha(pagina)) {
      throw new ErrorCaptcha('Google pidió verificación mientras respondía.');
    }

    const texto = await dondeLeer();

    if (texto.length < MINIMO_UTIL) {
      throw new Error(
        `El Modo IA devolvió muy poco (${texto.length} caracteres). ` +
          'O no ha respondido, o ha cambiado la maqueta.'
      );
    }

    console.log(`[google-busqueda] Modo IA: ${texto.length} caracteres.`);
    return { texto, fuente: 'google-modo-ia', url: pagina.url() };
  } finally {
    await cerrarNavegador(contexto);
  }
}

export default { buscarTablaDeSitios, componerPregunta, ErrorCaptcha };
