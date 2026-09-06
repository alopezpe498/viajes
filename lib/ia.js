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

const URL_API = 'https://api.anthropic.com/v1/messages';
const VERSION_API = '2023-06-01';

/** Las respuestas largas tardan. Un minuto es de sobra y evita colgarse. */
const TIMEOUT_MS = 60_000;

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

/** El modelo que toca usar, del .env o el de por defecto. */
export function modeloIA() {
  return process.env.MODELO_IA || MODELO_POR_DEFECTO;
}

/**
 * Le pregunta algo al modelo y devuelve el JSON ya parseado.
 *
 * @param {string} prompt        La pregunta.
 * @param {object} opciones
 * @param {number} opciones.maxTokens  Techo de respuesta (por defecto 8000).
 * @param {string} opciones.paso       Nombre del paso, para los mensajes de error.
 * @returns {Promise<any>} lo que haya devuelto, ya como objeto o array.
 */
export async function consultarJSON(prompt, { maxTokens = 8000, paso = 'la consulta' } = {}) {
  const clave = process.env.ANTHROPIC_API_KEY;
  if (!clave) throw new Error(SIN_CLAVE);

  let ultimoTexto = '';

  // Dos vueltas: la buena y la de "te lo pido otra vez, pero en serio".
  for (let intento = 1; intento <= 2; intento++) {
    const mensaje =
      intento === 1
        ? prompt
        : `${prompt}\n\nIMPORTANTE: tu respuesta anterior no era JSON válido. ` +
          'Devuelve EXCLUSIVAMENTE el JSON, empezando por { o [ y sin nada más.';

    ultimoTexto = await pedirTexto({ clave, mensaje, maxTokens, paso });

    try {
      return JSON.parse(limpiar(ultimoTexto));
    } catch {
      if (intento === 2) break;
      console.warn(`[ia] La respuesta de ${paso} no era JSON. Lo pido otra vez.`);
    }
  }

  throw new Error(
    `La IA no devolvió JSON válido al ${paso}, ni siquiera al repetírselo. ` +
      `Empezaba por: ${ultimoTexto.slice(0, 80)}…`
  );
}

/** Una llamada a /v1/messages. Devuelve el texto tal cual lo mande el modelo. */
async function pedirTexto({ clave, mensaje, maxTokens, paso }) {
  const control = new AbortController();
  const reloj = setTimeout(() => control.abort(), TIMEOUT_MS);

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
        model: modeloIA(),
        max_tokens: maxTokens,
        system: SISTEMA,
        messages: [{ role: 'user', content: mensaje }],
      }),
    });
  } catch (err) {
    if (err.name === 'AbortError') {
      throw new Error(`La IA tardó más de ${TIMEOUT_MS / 1000} s en responder al ${paso}.`);
    }
    throw new Error(`No se pudo hablar con la IA al ${paso}: ${err.message}`);
  } finally {
    clearTimeout(reloj);
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
  return (datos.content ?? [])
    .filter((b) => b.type === 'text')
    .map((b) => b.text)
    .join('')
    .trim();
}

/**
 * Quita el envoltorio de markdown si lo hay y se queda con lo que va del primer
 * { o [ al último } o ]. Se pide que no lo pongan, pero pedirlo no basta.
 */
function limpiar(texto) {
  let t = String(texto).trim();

  // Bloque de código con o sin etiqueta de lenguaje.
  const valla = t.match(/^```[a-zA-Z]*\s*\n?([\s\S]*?)\n?```$/);
  if (valla) t = valla[1].trim();

  // Y por si viniera una frase antes o después: nos quedamos con el JSON.
  const primeraLlave = t.search(/[{[]/);
  const ultimaLlave = Math.max(t.lastIndexOf('}'), t.lastIndexOf(']'));
  if (primeraLlave > 0 && ultimaLlave > primeraLlave) {
    t = t.slice(primeraLlave, ultimaLlave + 1);
  }

  return t;
}
