/**
 * lib/ia.js
 * -----------------------------------------------------------------------------
 * La única puerta por la que se habla con la API de Anthropic.
 *
 * Igual que lib/browser.js concentra todo lo del navegador, aquí se concentra
 * todo lo de la IA: la clave, el modelo, el formato de la petición y — sobre
 * todo — la manía de los modelos de envolver el JSON en ```json.
 *
 * DOS REGLAS QUE NO SE NEGOCIAN
 *
 *  1. Sin clave, la app NO se rompe. Se lanza un error con un mensaje que se
 *     entiende ("Falta configurar la clave de IA en .env") y la cola lo enseña
 *     como cualquier otro fallo, con su botón de reintentar. Arrancar el
 *     servidor sin clave tiene que seguir funcionando: solo fallan los trabajos
 *     que de verdad necesitan la IA.
 *
 *  2. Se responde SOLO con JSON. Se pide en el system prompt, se limpia lo que
 *     llegue por si acaso, y si aun así no parsea se reintenta UNA vez. Una, no
 *     un bucle: si el modelo no da un JSON a la segunda, algo va mal de verdad
 *     y prefiero enterarme a gastar tokens en silencio.
 *
 * Sin dependencias: fetch y process.loadEnvFile() vienen en Node 24.
 */

import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { parametro, faseEnCurso, anotar, ORIGENES, parametroTexto } from '../services/orquestador.js';
import { apuntarIA, apuntarReintento } from '../services/cronometro.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

// El .env se carga una sola vez, al importar el módulo. Si no existe, no pasa
// nada: puede que las variables vengan del entorno del sistema.
try {
  process.loadEnvFile(path.join(__dirname, '..', '.env'));
} catch {
  /* sin .env; miramos igualmente process.env */
}

/** Modelo por defecto: el más barato y rápido de la familia. */
export const MODELO_POR_DEFECTO = 'claude-haiku-4-5';

/** Y el de criterio, cuando el .env no dice otra cosa. */
export const MODELO_CRITERIO_POR_DEFECTO = 'claude-sonnet-5';

/**
 * DOS MODELOS, Y LA DIFERENCIA NO ES DE PRECIO SINO DE TRABAJO.
 *
 * El cronómetro dejó el motivo por escrito: un viaje de 17m 02s con 56 llamadas,
 * todas al modelo grande, y la fase «Qué ver» sola se llevaba 7m 48s de los
 * cuales 6m 35s eran IA. Pero no todas esas llamadas deciden nada: pedir los
 * diez imprescindibles de una ciudad o traducir un horario es mecánica, y la
 * mecánica no mejora por pensarla más despacio. Elegir por dónde se entra a un
 * país sí.
 *
 *   criterio · decide. Qué ciudades entran, cuántas noches, qué excursión
 *              merece la pena, cómo se reparte un día.
 *   rapido   · ejecuta. Listar, traducir, rellenar, estimar.
 *
 * LAS DOS SE LEEN DEL .ENV Y NO DE AQUÍ, y los parámetros de fase guardan
 * «criterio» o «rapido», NUNCA un nombre de modelo: así el día que salga una
 * versión nueva se cambia en un sitio y no en diez filas de una tabla.
 *
 * `MODELO_IA` sigue valiendo como respaldo para no romper una instalación que
 * todavía no tenga las dos nuevas.
 */
export function modeloCriterio() {
  return process.env.MODELO_CRITERIO || process.env.MODELO_IA || MODELO_CRITERIO_POR_DEFECTO;
}

export function modeloRapido() {
  return process.env.MODELO_RAPIDO || process.env.MODELO_IA || MODELO_POR_DEFECTO;
}

/** «criterio» → el nombre real. Cualquier otra cosa, el rápido. */
export function modeloDeClase(clase) {
  return clase === 'criterio' ? modeloCriterio() : modeloRapido();
}

/**
 * QUÉ CLASE DE MODELO TOCA EN ESTA LLAMADA.
 *
 * En este orden, que es el de lo más concreto a lo más general:
 *
 *   1. Lo que diga la llamada. Hay consultas que saben lo que necesitan y no
 *      dependen de en qué fase caigan: el diálogo de países razona, la
 *      interpretación de un texto de destino no.
 *   2. El parámetro de la fase en la que estamos, si estamos en una.
 *   3. `rapido`. Una llamada de una ficha o de una pantalla no es una decisión
 *      del viaje, y tratarla como si lo fuera es de donde salía la factura.
 */
export function claseDeLaLlamada(pedida = null) {
  if (pedida === 'criterio' || pedida === 'rapido') return pedida;

  const fase = faseEnCurso();
  if (!fase?.fase) return 'rapido';

  const guardada = parametroTexto(`modelo_${fase.fase}`, '');
  return guardada === 'criterio' ? 'criterio' : 'rapido';
}

/**
 * LA TEMPERATURA DE LAS LLAMADAS QUE PUNTÚAN.
 *
 * Un solo sitio del que leerla, para que las tres o cuatro llamadas que deciden
 * méritos no se vayan cada una por su lado. Se lee EN CADA LLAMADA, como el
 * plazo: moverla no obliga a reiniciar.
 *
 * NO ES CERO, Y ES A PROPÓSITO. Cero sería lo más estable, y para una
 * clasificación pura sería lo correcto. Pero la llamada de los sitios no es
 * pura: en la misma respuesta ordena los imprescindibles Y redacta la
 * descripción de cada uno, con su consejo práctico. Bajarla a cero estabiliza el
 * orden y de paso apaga la prosa, que es un precio que aquí no hace falta pagar.
 *
 * El día que la evidencia y el texto se pidan por separado —que es a donde va la
 * recalibración— la parte que puntúe podrá bajar a cero sin llevarse nada por
 * delante. Mientras tanto, 0.2 es el punto en el que se nota la estabilidad sin
 * que las fichas se queden secas.
 */
export function temperaturaAlPuntuar() {
  const t = parametro('temperatura_al_puntuar', 0.2);
  return Math.min(1, Math.max(0, Number.isFinite(t) ? t : 0.2));
}

const URL_API = 'https://api.anthropic.com/v1/messages';
const VERSION_API = '2023-06-01';

/**
 * CUÁNTO SE ESPERA A QUE CONTESTE, Y CUÁNTAS VECES SE INSISTE.
 *
 * Esto era `const TIMEOUT_MS = 60_000` con el comentario «un minuto es de
 * sobra». Y lo era con Haiku. Al pasar a Sonnet dejó de serlo —contesta mejor y
 * más despacio— y empezaron a caerse fases enteras con «La IA tardó más de 60 s
 * al investigar Tesalónica». Un número que depende del modelo que tengas puesto
 * no puede estar escrito a fuego: se lee de los parámetros, y se lee EN CADA
 * LLAMADA para que cambiarlo no obligue a reiniciar el servidor.
 *
 * Los respaldos son los de fábrica, y están aquí por si alguien usa este módulo
 * antes de que existan las tablas: nunca dejar la llamada sin plazo.
 */
const TIMEOUT_POR_DEFECTO_S = 180;
const REINTENTOS_POR_DEFECTO = 1;

const milisegundosDeEspera = () =>
  Math.max(5, parametro('timeout_ia_segundos', TIMEOUT_POR_DEFECTO_S)) * 1000;

const cuantosReintentos = () =>
  Math.max(0, Math.min(3, parametro('reintentos_ia', REINTENTOS_POR_DEFECTO)));

/**
 * DEJA CONSTANCIA DEL REINTENTO DONDE SE VA A LEER.
 *
 * Si esto ocurre dentro de una fase del orquestador, la nota va a SU registro,
 * que es donde se repasa por qué un viaje salió como salió. Fuera del
 * orquestador —una consulta desde la pantalla de una etapa— no hay fase a la
 * que anotar y se queda en la consola.
 */
function apuntarReintentoEnElRegistro(texto) {
  const fase = faseEnCurso();
  if (fase) anotar(fase.viajeId, fase.fase, texto, ORIGENES.ninguno);
  console.warn(`[ia] ${texto}`);
}

/** Lo que se le dice al modelo en TODAS las consultas de este proyecto. */
const SISTEMA =
  'Eres un asistente de planificación de viajes. ' +
  'Responde SOLO con JSON válido, sin markdown ni texto extra. ' +
  'No expliques nada fuera del JSON, no uses bloques de código, ' +
  'no añadas comentarios. La primera letra de tu respuesta debe ser { o [.';

/** El mensaje que ve el usuario cuando no hay clave. Se usa en varios sitios. */
export const SIN_CLAVE = 'Falta configurar la clave de IA en .env';

/** ¿Está la IA configurada? Sirve para no ofrecer botones que no van a funcionar. */
export function hayClaveIA() {
  return Boolean(process.env.ANTHROPIC_API_KEY);
}

/**
 * El modelo que toca usar. Se queda por compatibilidad: lo lee el worker para
 * enseñarlo en pantalla. Lo que decide de verdad es `claseDeLaLlamada`.
 */
export function modeloIA() {
  return modeloRapido();
}

/**
 * Le pregunta algo al modelo y devuelve el JSON ya parseado.
 *
 * @param {string} prompt        La pregunta.
 * @param {object} opciones
 * @param {number} opciones.maxTokens  Techo de respuesta (por defecto 8000).
 * @param {string} opciones.paso       Nombre del paso, para los mensajes de error.
 * @param {string} [opciones.modelo]   'criterio' o 'rapido'. Sin esto manda el
 *                                     parámetro de la fase, y fuera de una fase,
 *                                     'rapido'.
 * @param {number} [opciones.temperatura] Solo para las llamadas que PUNTÚAN. Sin
 *                                     esto no se manda `temperature` y rige la
 *                                     de por defecto de la API, que es lo que ha
 *                                     hecho este programa toda su vida.
 * @returns {Promise<any>} lo que haya devuelto, ya como objeto o array.
 */
export async function consultarJSON(
  prompt,
  { maxTokens = 8000, paso = 'la consulta', conWeb = false, modelo = null, temperatura = null } = {}
) {
  const clave = process.env.ANTHROPIC_API_KEY;
  if (!clave) throw new Error(SIN_CLAVE);

  let ultimoTexto = '';
  let ultimoFallo = '';
  // El techo puede subir entre intentos: ver abajo, en la rama del corte.
  let techo = maxTokens;
  // Con búsqueda web, si el servidor la rechaza se repite sin ella. Un dato de
  // hace un año es peor que uno de hoy, pero mucho mejor que ninguno.
  let web = conWeb;

  // Dos vueltas: la buena y la de "te lo pido otra vez, pero en serio".
  for (let intento = 1; intento <= 2; intento++) {
    const mensaje =
      intento === 1
        ? prompt
        : `${prompt}\n\nIMPORTANTE: tu respuesta anterior no era JSON válido. ` +
          'Devuelve EXCLUSIVAMENTE el JSON, empezando por { o [ y sin nada más.';

    let cortada = false;
    try {
      const r = await pedirTexto({ clave, mensaje, maxTokens: techo, paso, web, modelo, temperatura });
      ultimoTexto = r.texto;
      cortada = r.seCorto;
    } catch (err) {
      // La herramienta de búsqueda puede no estar habilitada en la cuenta. Eso
      // no es motivo para quedarse sin respuesta: se repite sin ella.
      if (web && esFalloDeHerramienta(err)) {
        console.warn(`[ia] Sin búsqueda web en ${paso} (${err.message}). Repito sin ella.`);
        web = false;
        const r = await pedirTexto({ clave, mensaje, maxTokens: techo, paso, web, modelo, temperatura });
        ultimoTexto = r.texto;
        cortada = r.seCorto;
      } else {
        throw err;
      }
    }

    try {
      return JSON.parse(limpiar(ultimoTexto));
    } catch (falloJSON) {
      // UNA COMA DE MÁS NO VALE UNA LLAMADA ENTERA.
      //
      // El modelo rápido cierra de vez en cuando con `…}, ]` o `…", }`. Es el
      // único error de sintaxis que se puede arreglar sin adivinar nada: se
      // quita la coma sobrante y se vuelve a intentar. Si con eso parsea, se
      // dice en el log —para que se vea cuántas veces pasa— y se sigue.
      const base = limpiar(ultimoTexto);
      const remiendos = [
        ['una coma de más', base.replace(/,(\s*[}\]])/g, '$1')],
        ['comillas sin escapar dentro de un texto', escaparComillasDeDentro(base)],
        [
          'comillas sin escapar y una coma de más',
          escaparComillasDeDentro(base).replace(/,(\s*[}\]])/g, '$1'),
        ],
      ];
      for (const [que, intentoReparado] of remiendos) {
        try {
          const r = JSON.parse(intentoReparado);
          console.warn(`[ia] La respuesta de ${paso} traía ${que}. Lo he arreglado y parsea.`);
          return r;
        } catch {
          /* ese remiendo no era: se prueba el siguiente */
        }
      }
      // Y SE DICE QUÉ PASÓ, que hasta ahora solo se veían los 80 primeros
      // caracteres y nunca el motivo ni el final, que es donde está el fallo.
      console.warn(
        `[ia] La respuesta de ${paso} no es JSON (${falloJSON.message.slice(0, 120)}). ` +
          `Acaba en: …${ultimoTexto.slice(-120).replace(/\s+/g, ' ')}`
      );
      if (intento === 2) {
        ultimoFallo = falloJSON.message;
        break;
      }
      // SI SE CORTÓ, EL PROBLEMA NO ES QUE NO SEPA ESCRIBIR JSON: ES QUE NO LE
      // CABÍA. Repetir con la misma medida vuelve a cortarlo por el mismo
      // sitio, así que la segunda vuelta va con el doble de techo (hasta 24.000,
      // que es techo de sobra para lo más largo que pide este programa).
      if (cortada) {
        techo = Math.min(techo * 2, 24000);
        console.warn(
          `[ia] La respuesta de ${paso} se cortó por el tope. La pido otra vez con ${techo} tokens.`
        );
      } else {
        console.warn(`[ia] La respuesta de ${paso} no era JSON. Lo pido otra vez.`);
      }
    }
  }

  throw new Error(
    `La IA no devolvió JSON válido al ${paso}, ni siquiera al repetírselo` +
      `${techo !== maxTokens ? ` con ${techo} tokens de techo` : ''}` +
      `${ultimoFallo ? ` (${ultimoFallo.slice(0, 90)})` : ''}. ` +
      `Empezaba por: ${ultimoTexto.slice(0, 60)}… y acababa en: …${ultimoTexto.slice(-60).replace(/\s+/g, ' ')}`
  );
}

/**
 * ¿El fallo es porque la cuenta no tiene la búsqueda web?
 *
 * La API contesta 400 con un mensaje sobre la herramienta. No hay un código
 * específico, así que se mira el texto: es feo, pero la alternativa es dejar sin
 * respuesta a quien no la tenga habilitada.
 */
function esFalloDeHerramienta(err) {
  const m = String(err?.message ?? '').toLowerCase();
  return m.includes('400') && (m.includes('tool') || m.includes('web_search'));
}

/**
 * La herramienta de BÚSQUEDA WEB del servidor de Anthropic.
 *
 * La ejecuta la API, no nosotros: no hay que llamar a ningún buscador ni meter
 * otra clave. Con ella el modelo consulta páginas antes de contestar, que es lo
 * único que hace fiable un "¿cuánto cuesta el bus de Sarajevo a Mostar?": ese
 * dato cambia, y de memoria un modelo se lo inventa con toda la seguridad del
 * mundo.
 *
 * `max_uses` acotado a propósito: cinco búsquedas bastan para un tramo o una
 * ciudad, y cada una cuesta.
 */
const HERRAMIENTA_WEB = { type: 'web_search_20250305', name: 'web_search', max_uses: 5 };

/**
 * Una llamada a /v1/messages, CON REINTENTO SI SE PASA DE TIEMPO.
 *
 * Un timeout no es un error de lógica: casi siempre es una respuesta que venía
 * larga o un mal momento de la red, y volver a preguntar sale mucho más barato
 * que dar la fase por perdida y relanzarla entera a mano. Solo se reintenta ESO:
 * un 401 o un JSON malo no mejoran por repetirlos.
 */
async function pedirTexto(opciones) {
  const veces = cuantosReintentos();

  for (let intento = 0; ; intento++) {
    const empezo = Date.now();
    try {
      return await unaLlamada(opciones);
    } catch (err) {
      const esTimeout = err.porTimeout === true;
      if (!esTimeout || intento >= veces) throw err;

      // Lo que ha costado el intento fallido es tiempo perdido de esta fase, y
      // es exactamente el número que hay que poder ver al preguntarse por qué
      // una fase tardó el doble que de costumbre.
      apuntarReintento({ motivo: 'timeout de IA', ms: Date.now() - empezo });

      apuntarReintentoEnElRegistro(
        `Reintento ${intento + 1} de ${veces} tras agotarse el tiempo al ${opciones.paso}.`
      );
    }
  }
}

/**
 * LAS LLAMADAS QUE ESTÁN AHORA MISMO EN EL AIRE.
 *
 * Existe solo para poder cortarlas: el botón de «Abortar ya» del orquestador
 * necesita alcanzar el `fetch` que está esperando, y esa promesa no es
 * alcanzable desde ningún otro sitio. Se apunta al salir y se borra al volver,
 * pase lo que pase.
 *
 * Es un Set y no una variable porque una fase puede tener dos consultas en
 * paralelo (`Promise.allSettled` en la ficha de país).
 */
const enElAire = new Set();

/**
 * Corta TODAS las llamadas de IA que estén esperando respuesta.
 *
 * Devuelve cuántas ha cortado. Cada una lanzará su AbortError, que sube como un
 * error normal de la fase: no hace falta que nadie más se entere de esto.
 */
export function abortarLlamadasDeIA() {
  const cuantas = enElAire.size;
  for (const c of enElAire) {
    // SE MARCA ANTES DE CORTAR, y esto no es un detalle: sin la marca, el corte
    // llega al mismo `catch` que un timeout, y el reintento automático volvería
    // a preguntar. El botón de «abortar ya» habría costado tres minutos más.
    c.porElUsuario = true;
    c.abort();
  }
  enElAire.clear();
  return cuantas;
}

/** El intento de verdad. Lo envuelve `pedirTexto`, que es quien insiste. */
async function unaLlamada({
  clave,
  mensaje,
  maxTokens,
  paso,
  web = false,
  modelo: opcionesDeModelo = null,
  temperatura = null,
}) {
  const espera = milisegundosDeEspera();
  const control = new AbortController();
  enElAire.add(control);
  const reloj = setTimeout(() => control.abort(), espera);

  // Se apunta la hora de salida aquí y la de vuelta abajo. Lo que tarda una
  // llamada es lo que tarda la red y el modelo; medirlo más arriba metería
  // dentro el armado del prompt, que es gratis, y el parseo, que casi.
  const salida = Date.now();
  const clase = claseDeLaLlamada(opcionesDeModelo);
  const modelo = modeloDeClase(clase);

  let respuesta;
  try {
    respuesta = await fetch(URL_API, {
      method: 'POST',
      signal: control.signal,
      headers: {
        'content-type': 'application/json',
        'x-api-key': clave,
        'anthropic-version': VERSION_API,
      },
      body: JSON.stringify({
        model: modelo,
        max_tokens: maxTokens,
        system: SISTEMA,
        messages: [{ role: 'user', content: mensaje }],
        // LA TEMPERATURA SOLO VIAJA SI ALGUIEN LA PIDE.
        //
        // Aquí no se mandaba nunca, así que todas las llamadas del proyecto
        // salían con la de por defecto de la API, que es la más alta. Para lo que
        // se le pide a este programa casi siempre da igual —listar sitios,
        // traducir un horario, redactar un párrafo— pero hay un puñado de
        // llamadas que PUNTÚAN, y en ésas la variabilidad no aporta nada: no se
        // busca una idea distinta cada vez, se busca el mismo veredicto ante la
        // misma evidencia. Medido en fase 1 sobre el mismo destino, Hammamet
        // salía 3, 2 y 2 y Kairouan 5, 4 y 4 — y con esos bailes quién entra en
        // la ruta es lotería, porque el peso máximo decide qué repartos son
        // legales.
        //
        // No se pone un valor por defecto aquí a propósito: quien quiera bajarla
        // tiene que decirlo en su llamada, y así se ve de un vistazo cuáles son
        // las que puntúan. El resto del programa sigue exactamente como estaba.
        ...(Number.isFinite(temperatura) ? { temperature: temperatura } : {}),
        ...(web ? { tools: [HERRAMIENTA_WEB] } : {}),
      }),
    });
  } catch (err) {
    if (err.name === 'AbortError' && control.porElUsuario) {
      // Cortada a mano: ni se reintenta ni se explica como una lentitud.
      const fallo = new Error(`Cancelado por el usuario al ${paso}.`);
      fallo.porElUsuario = true;
      throw fallo;
    }

    if (err.name === 'AbortError') {
      // Se marca para que `pedirTexto` sepa que ESTE sí merece otra oportunidad,
      // y se dice qué hacer si al final no hay manera: quien lee el registro
      // quiere saber el siguiente paso, no solo el diagnóstico.
      const fallo = new Error(
        `La IA tardó más de ${Math.round(espera / 1000)} s en responder al ${paso}. ` +
          'Puedes relanzar solo esta fase desde la pantalla del orquestador.'
      );
      fallo.porTimeout = true;
      throw fallo;
    }
    throw new Error(`No se pudo hablar con la IA al ${paso}: ${err.message}`);
  } finally {
    clearTimeout(reloj);
    enElAire.delete(control);
    apuntarIA({ desde: salida, hasta: Date.now(), modelo, clase, web });
  }

  if (!respuesta.ok) {
    // Los mensajes de la API son utiles; los pasamos, recortados.
    const cuerpo = await respuesta.text().catch(() => '');
    throw new Error(
      `La IA respondió ${respuesta.status} al ${paso}` +
        (respuesta.status === 401 ? ' (la clave de .env no vale)' : '') +
        (cuerpo ? `: ${cuerpo.slice(0, 200)}` : '')
    );
  }

  const datos = await respuesta.json();

  // Con búsqueda web la respuesta trae además bloques `server_tool_use` y
  // `web_search_tool_result`. Solo interesa el texto, que es donde viene el
  // JSON; los demás se ignoran sin más.
  const texto = (datos.content ?? [])
    .filter((b) => b.type === 'text')
    .map((b) => b.text)
    .join('')
    .trim();

  // QUÉ MODELO HA USADO CADA LLAMADA, DICHO SIEMPRE.
  //
  // Esto faltaba, y es lo que dejó que el coste subiera sin que nadie lo
  // decidiera: al poner la fase «Qué ver» en criterio se fueron al modelo caro
  // el extractor de datos de Google, el lector de horarios y los títulos de
  // Wikipedia —mecánicas puras que comparten fase con el ranking de
  // imprescindibles— y el viaje pasó de 10-13 llamadas caras a 25. No saltó
  // ninguna alarma porque no había dónde verlo: el log decía qué se preguntaba,
  // nunca con qué.
  //
  // `heredado` es la mitad que importa. Una llamada que dice su clase es una
  // decisión tomada; una que la hereda de la fase es una que se moverá sola el
  // día que alguien toque el interruptor de esa fase. Con esa palabra en el log,
  // un `grep` contesta a «¿qué se me va a encarecer si subo esta fase?», que
  // hasta ahora había que contestar leyendo el código entero — y leyéndolo mal:
  // el primer inventario de esta tanda dijo 26 llamadas heredadas y eran 19.
  console.log(
    `[ia] ${paso} · ${clase}${opcionesDeModelo ? '' : ' (heredado de la fase)'}` +
      `${web ? ` · ${(datos.content ?? []).filter((b) => b.type === 'server_tool_use').length} búsqueda/s web` : ''}` +
      `${datos.stop_reason === 'max_tokens' ? ' · CORTADA por el tope de tokens' : ''}`
  );

  // SE DICE SI LA RESPUESTA SE CORTÓ, y esto costó dos ciudades enteras.
  //
  // En el viaje 139, «Qué ver» falló en Bucarest y en Sofía con «la IA no
  // devolvió JSON válido». Y sí lo era: empezaba por `{ "parrafo_por_que": …`
  // perfectamente formado y se acababa a media frase, porque la respuesta
  // chocó con `max_tokens`. Reintentarlo tal cual —que es lo que se hacía— solo
  // sirve para que se corte otra vez por el mismo sitio. La API lo dice en
  // `stop_reason`; hasta ahora nadie lo miraba.
  return { texto, seCorto: datos.stop_reason === 'max_tokens' };
}

/**
 * Quita el envoltorio de markdown si lo hay y se queda con lo que va del primer
 * { o [ al último } o ]. Se pide que no lo pongan, pero pedirlo no basta.
 */
/**
 * LA COMILLA SIN ESCAPAR DENTRO DE UN TEXTO.
 *
 * EL CASO, y costó tres intentos en dos viajes: Sofía. El modelo devuelve
 *
 *     "titulo_wikipedia_local": "Ротонда „Свети Георги""
 *
 * —el nombre búlgaro lleva comillas dentro— y esa comilla del medio cierra la
 * cadena antes de tiempo: `Expected ',' or '}' after property value`. No es que
 * la respuesta venga rota de cualquier manera; es SIEMPRE lo mismo, y se puede
 * arreglar sin adivinar: se recorre el texto sabiendo si se está dentro de una
 * cadena, y una comilla que no venga seguida de `,` `}` `]` o `:` no cierra
 * nada, es parte del nombre. Se escapa y sigue.
 *
 * Solo se usa cuando el parseo YA ha fallado: en el camino bueno no toca nada.
 */
function escaparComillasDeDentro(texto) {
  let fuera = '';
  let dentro = false;

  for (let i = 0; i < texto.length; i += 1) {
    const c = texto[i];

    if (!dentro) {
      fuera += c;
      if (c === '"') dentro = true;
      continue;
    }

    if (c === '\\') {
      // Lo escapado viaja entero: la barra y lo que venga detrás.
      fuera += c + (texto[i + 1] ?? '');
      i += 1;
      continue;
    }

    if (c === '"') {
      const siguiente = texto.slice(i + 1).match(/^\s*(.)/)?.[1] ?? '';
      if ([',', '}', ']', ':'].includes(siguiente)) {
        fuera += c;
        dentro = false;
      } else {
        fuera += '\\"';
      }
      continue;
    }

    fuera += c;
  }

  return fuera;
}

function limpiar(texto) {
  let t = String(texto).trim();

  // Bloque de código con o sin etiqueta de lenguaje.
  const valla = t.match(/^```[a-zA-Z]*\s*\n?([\s\S]*?)\n?```$/);
  if (valla) t = valla[1].trim();

  // Y LA VALLA A MEDIAS, que es la que se cuela. La de arriba exige que el
  // cierre sea lo ÚLTIMO del texto: si detrás viene una frase —«Aquí tienes el
  // JSON…»— o si falta el cierre, no casa y el texto se queda con el ```json
  // delante. Se quitan por separado, que es lo que de verdad se sabe: lo de
  // delante sobra y lo de detrás también.
  if (t.startsWith('```')) {
    t = t.replace(/^```[a-zA-Z]*\s*\n?/, '').replace(/\n?```[\s\S]*$/, '').trim();
  }

  // Y por si viniera una frase antes o después: nos quedamos con el JSON.
  const primeraLlave = t.search(/[{[]/);
  const ultimaLlave = Math.max(t.lastIndexOf('}'), t.lastIndexOf(']'));
  if (primeraLlave > 0 && ultimaLlave > primeraLlave) {
    t = t.slice(primeraLlave, ultimaLlave + 1);
  }

  return t;
}

/**
 * PREGUNTAR A LA IA CON CONTEXTO FRESCO DE GOOGLE, SIN PAGAR LA BÚSQUEDA WEB.
 *
 * `consultarJSON` acepta `conWeb: true`, que activa la búsqueda web del
 * proveedor. Funciona bien y se cobra aparte, por consulta: ciento sesenta
 * búsquedas acumuladas en cosas como "qué trenes hay de Cracovia a Varsovia".
 *
 * Aquí se hace lo mismo por otro camino: se le pregunta al Modo IA de Google
 * —el navegador que ya se abre para los datos duros de los sitios— y su
 * respuesta se le da al modelo como CONTEXTO. El modelo sigue haciendo lo que
 * sabe hacer, que es ordenar ese texto en JSON, pero ya no necesita salir a
 * buscar: el texto reciente se lo damos nosotros.
 *
 * SI GOOGLE NO CONTESTA, SE PREGUNTA IGUAL. Un captcha o una maqueta cambiada
 * dejan al modelo con lo que sepa de memoria, que para "cómo se va de Cracovia a
 * Varsovia" es bastante. Peor sería quedarse sin respuesta: esto sustituye a una
 * búsqueda que tampoco garantizaba nada.
 */
export async function consultarJSONConGoogle(pregunta, prompt, opciones = {}) {
  let contexto = null;

  try {
    const { preguntarAlModoIA } = await import('../providers/google-busqueda.js');
    const r = await preguntarAlModoIA(pregunta);
    contexto = r.texto;
    console.log(`[ia] contexto de Google: ${contexto.length} caracteres para «${opciones.paso ?? 'la consulta'}».`);
  } catch (err) {
    console.warn(`[ia] sin contexto de Google (${err.message}); pregunto solo con lo que sepa.`);
  }

  const conContexto = contexto
    ? [
        'Esto es lo que dice Google hoy sobre lo que te voy a preguntar:',
        '',
        '--- LO QUE DICE GOOGLE ---',
        contexto.slice(0, 12000),
        '--- FIN ---',
        '',
        'Úsalo como fuente principal: está más al día que tu memoria. Lo que no',
        'esté ahí, complétalo con lo que sepas, pero NO te inventes teléfonos,',
        'precios ni horarios concretos: en esos, si no aparecen, deja el hueco.',
        '',
        prompt,
      ].join('\n')
    : prompt;

  // conWeb queda FUERA a propósito: el contexto ya lo hemos traído nosotros, y
  // dejarlo pasar volvería a cobrar la búsqueda que se quería evitar.
  const { conWeb, exigirContexto, ...resto } = opciones;

  // CUANDO EL DATO SOLO VALE SI VIENE DE LA BÚSQUEDA.
  //
  // Sin contexto esto sigue preguntando, y para «cómo se va de A a B» está bien:
  // el modelo sabe que hay tren. Pero hay llamadas cuyo único sentido es sacar
  // un número del texto de Google —el precio de un billete— y ahí seguir sin
  // contexto es peor que no contestar: devuelve una cifra de memoria que el
  // llamador guardará como «traída de la búsqueda». Con `exigirContexto` se
  // corta aquí y quien llama se queda con su hueco, que es la verdad.
  if (!contexto && exigirContexto) {
    throw new Error(
      `Sin contexto de Google para ${opciones.paso ?? 'la consulta'}: no pregunto de memoria.`
    );
  }

  return consultarJSON(conContexto, { ...resto, conWeb: false });
}
