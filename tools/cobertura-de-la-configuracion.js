/**
 * ¿LLEGA CADA COSA QUE CONFIGURAS A DONDE TIENE QUE LLEGAR?
 *
 *   node tools/cobertura-de-la-configuracion.js
 *
 * Sale 0 si todo está en su sitio y 1 si algo se ha caído, para poder colgarlo
 * de un hook o mirarlo antes de un despliegue.
 *
 * POR QUÉ EXISTE. El repaso de la configuración encontró que media pantalla de
 * preguntas no decide nada: `habitacionFamiliar` es obligatoria con más de dos
 * viajeros y no aparece en la búsqueda de Booking; el presupuesto que declaras
 * solo se enseña; `{{CALENDARIO}}` lo pide el prompt y no lo rellena nadie.
 *
 * Y ESO SE TORCIÓ EN SILENCIO. Nadie rompió nada de golpe: se fueron añadiendo
 * preguntas sin conectarlas, o se movió un prompt y el dato dejó de viajar.
 * Arreglar los casos de hoy deja una foto buena de hoy; lo que evita que vuelva
 * a pasar es que haya algo que lo diga solo. Es lo mismo que resolvió el lío de
 * los modelos de IA: no fue arreglar tres llamadas, fue que el log dijera con
 * qué modelo se hizo cada una.
 *
 * DOS COMPROBACIONES, Y LA PRIMERA NO NECESITA QUE NADIE DECLARE NADA:
 *
 *   A · HUECOS HUÉRFANOS. `rellenar()` sustituye `{{X}}` por el valor de la
 *       clave `X`, y si no la encuentra la deja VACÍA sin decir nada. Así que un
 *       prompt puede pedir un dato que nadie le manda y el único síntoma es un
 *       modelo peor, que no se nota. Se comparan los huecos de cada prompt
 *       contra las claves que el código construye.
 *
 *   B · COBERTURA DECLARADA. Para cada variable de configuración se declara
 *       abajo a dónde DEBE llegar. Si deja de llegar, esto lo dice. Aquí sí hay
 *       una declaración porque «dónde debe llegar el ritmo» es una decisión de
 *       producto, no algo que se pueda deducir del código.
 *
 * LO QUE ESTO NO HACE: comprobar que el dato se USE BIEN. Que `nivelPrecio`
 * llegue al prompt del hotel no garantiza que el hotel salga acorde. Esto caza
 * la desconexión, que es el fallo silencioso; lo otro se mira en el viaje.
 */

import { todas } from '../db/index.js';
import { readFileSync, readdirSync } from 'node:fs';

// =============================================================================
// LO QUE SE ESPERA DE CADA VARIABLE
// =============================================================================
/**
 * `fases` son las fases a cuyo PROMPT tiene que llegar (por su hueco `{{…}}`).
 * `codigo` son ficheros donde tiene que aparecer la variable, para lo que decide
 * el código y no la IA.
 *
 * `pendiente` marca lo que HOY no se cumple y está reconocido: no cuenta como
 * fallo, pero se lista aparte para que no se olvide. Cuando se arregle, se quita
 * la marca y a partir de ahí ya es un fallo si se cae.
 */
const ESPERADO = [
  // --- Datos del viaje ------------------------------------------------------
  { clave: 'fecha_inicio', hueco: 'FECHA_INICIO', fases: ['ciudades_y_noches'],
    codigo: ['services/orquestador-ciudades.js'] },
  { clave: 'ciudad_origen', hueco: 'ORIGEN', fases: ['ciudades_y_noches'],
    codigo: ['services/proveedores.js'] },
  { clave: 'adultos', hueco: 'VIAJEROS',
    fases: ['ciudades_y_noches', 'traslados', 'dormir', 'excursiones', 'lienzo'] },
  { clave: 'edades_ninos', hueco: 'VIAJEROS',
    fases: ['traslados', 'excursiones', 'lienzo'],
    codigo: ['services/orquestador-sitios.js'] },
  { clave: 'ritmo', hueco: 'RITMO',
    fases: ['ciudades_y_noches', 'traslados', 'excursiones', 'lienzo'],
    codigo: ['services/orquestador-traslados.js'] },
  { clave: 'tipo_viaje', hueco: 'TIPO_VIAJE', fases: ['ciudades_y_noches'] },

  // --- Intereses ------------------------------------------------------------
  { clave: 'intereses', hueco: 'INTERESES', fases: ['ciudades_y_noches', 'sitios', 'excursiones'],
    codigo: ['services/rubrica-ciudades.js'] },
  { clave: 'categorias', hueco: 'CATEGORIAS', fases: ['sitios'],
    codigo: ['services/rubrica-ciudades.js'] },

  // --- Alojamiento ----------------------------------------------------------
  { clave: 'nivelPrecio', codigo: ['services/orquestador-dormir.js', 'services/presupuesto.js'] },
  { clave: 'zona', codigo: ['services/orquestador-dormir.js'] },
  { clave: 'tipoAlojamiento', hueco: 'TIPO', fases: ['dormir'],
    codigo: ['services/orquestador-dormir.js'] },
  { clave: 'desayuno', codigo: ['services/orquestador-dormir.js'] },
  { clave: 'cancelacionGratis', codigo: ['services/orquestador-dormir.js'] },
  { clave: 'notaMinima', codigo: ['services/orquestador-dormir.js'] },

  // --- Vuelos ---------------------------------------------------------------
  { clave: 'escalas', codigo: ['services/orquestador-ciudades.js', 'services/orquestador-traslados.js'] },
  { clave: 'franjaIda', codigo: ['services/orquestador-ciudades.js'] },
  { clave: 'franjaVuelta', codigo: ['services/orquestador-ciudades.js'] },

  // --- LO QUE HOY NO LLEGA, reconocido y sin olvidar ------------------------
  { clave: 'habitacionFamiliar', codigo: ['services/orquestador-dormir.js'],
    pendiente: 'se pregunta —obligatoria con más de dos viajeros— y no la lee la búsqueda de Booking' },
  { clave: 'presupuesto', codigo: ['services/orquestador-dormir.js'],
    pendiente: 'solo se enseña; ninguna decisión lo mira' },
  { clave: 'edades_ninos_en_dormir', hueco: 'VIAJEROS', fases: ['dormir'],
    pendiente: 'al prompt del hotel llega «N niño(s)» sin las edades: un bebé y uno de 14 no piden lo mismo' },
  { clave: 'nivelPrecio_en_excursiones', codigo: ['services/orquestador-excursiones.js'],
    pendiente: 'las excursiones se eligen sin mirar lo que cuestan' },
  { clave: 'intereses_en_dormir', hueco: 'INTERESES', fases: ['dormir'],
    pendiente: 'el perfil no influye en qué hotel ni en qué barrio' },
  { clave: 'intereses_en_lienzo', hueco: 'INTERESES', fases: ['lienzo'],
    pendiente: 'cuando el día no da para todo, lo que se cae se elige sin mirar tu perfil' },
  { clave: 'filtros_hoteles', codigo: ['services/orquestador-dormir.js'],
    pendiente: 'piscina, estrellas y distancia máxima no se pueden pedir en automático' },
];

// =============================================================================
// DE DÓNDE SALEN LOS DATOS
// =============================================================================
const FICHEROS = [];
for (const d of ['services', 'lib', 'routes', 'jobs']) {
  try {
    for (const f of readdirSync(d)) if (f.endsWith('.js')) FICHEROS.push(d + '/' + f);
  } catch {
    /* carpeta que no existe en esta instalación */
  }
}
const FUENTE = new Map(FICHEROS.map((f) => [f, readFileSync(f, 'utf8')]));
const TODO = [...FUENTE.values()].join('\n');

const prompts = todas('SELECT fase, prompt_actual FROM prompts_orquestador');
const huecosDe = (fase) => {
  const p = prompts.find((x) => x.fase === fase);
  if (!p) return null;
  return new Set([...p.prompt_actual.matchAll(/\{\{([A-Z_]+)\}\}/g)].map((m) => m[1]));
};

// LAS TRES FORMAS DE RELLENAR UN HUECO, y las tres hacen falta.
//
// Esto me costó dos vueltas y cuatro falsos positivos, así que queda escrito:
// una comprobación que grita en falso deja de leerse a la tercera vez, y
// entonces no sirve para nada.
//
//   1. `{ CLAVE: valor }` — la normal. La primera versión además exigía que
//      estuviera al principio de una línea, y se le escapó `{{TEXTO}}`, que se
//      rellena en línea: `rellenar(promptDeFase(…), { TEXTO: t })`.
//   2. `{ CLAVE, }` — el atajo de propiedad de ES6, sin dos puntos. Así se
//      rellena `{{PASAPORTE}}` en `paises.js`.
//   3. `plantilla.replace('{{CLAVE}}', …)` — sin pasar por `rellenar()`. Así se
//      rellena `{{REGISTRO}}` en `registro-traducido.js`.
//
// Se quitan antes los comentarios, porque una frase como «NO BORRA EL REGISTRO:»
// daría por rellenado `{{REGISTRO}}` sin que nadie lo rellene.
const SIN_COMENTARIOS = TODO
  .replace(/\/\*[\s\S]*?\*\//g, ' ')
  .replace(/^\s*\/\/.*$/gm, ' ');

const RELLENADAS = new Set([
  ...[...SIN_COMENTARIOS.matchAll(/\b([A-Z][A-Z_]{2,})\s*:/g)].map((m) => m[1]),
  ...[...SIN_COMENTARIOS.matchAll(/[{,]\s*([A-Z][A-Z_]{2,})\s*[,}]/g)].map((m) => m[1]),
  ...[...SIN_COMENTARIOS.matchAll(/replace\(\s*['\"`]\{\{([A-Z_]+)\}\}/g)].map((m) => m[1]),
]);

let fallos = 0;
const pendientes = [];

// =============================================================================
// A · HUECOS QUE NADIE RELLENA
// =============================================================================
console.log('# ¿LLEGA CADA COSA QUE CONFIGURAS A DONDE TIENE QUE LLEGAR?\n');
console.log('## A · Huecos que un prompt pide y nadie rellena\n');

const huerfanos = [];
for (const p of prompts) {
  for (const m of p.prompt_actual.matchAll(/\{\{([A-Z_]+)\}\}/g)) {
    if (!RELLENADAS.has(m[1])) huerfanos.push(`${p.fase} · {{${m[1]}}}`);
  }
}
const unicos = [...new Set(huerfanos)];
if (unicos.length) {
  for (const h of unicos) console.log(`  ✘ ${h} — el prompt lo pide y llega VACÍO`);
  fallos += unicos.length;
} else {
  console.log('  Ninguno: todos los huecos de todos los prompts tienen quien los rellene.');
}

// =============================================================================
// B · CADA VARIABLE, DONDE DEBE ESTAR
// =============================================================================
console.log('\n## B · Cada variable, donde debe estar\n');

for (const v of ESPERADO) {
  const faltan = [];

  for (const fase of v.fases ?? []) {
    const h = huecosDe(fase);
    if (!h) faltan.push(`la fase «${fase}» no existe`);
    else if (!h.has(v.hueco)) faltan.push(`{{${v.hueco}}} no está en el prompt de «${fase}»`);
  }

  for (const f of v.codigo ?? []) {
    const t = FUENTE.get(f);
    if (t === undefined) faltan.push(`${f} no existe`);
    else if (!t.includes(v.clave.split('_en_')[0])) faltan.push(`no aparece en ${f}`);
  }

  if (v.pendiente) {
    pendientes.push({ ...v, faltan });
    continue;
  }

  if (faltan.length) {
    console.log(`  ✘ ${v.clave.padEnd(22)} ${faltan.join(' · ')}`);
    fallos += 1;
  } else {
    console.log(`  ✔ ${v.clave.padEnd(22)} llega a todo lo que se espera de ella`);
  }
}

// =============================================================================
// LO RECONOCIDO Y SIN ARREGLAR
// =============================================================================
console.log('\n## Reconocido y sin arreglar\n');
console.log('  No cuenta como fallo, pero sigue ahí. Al arreglar uno, se le quita');
console.log('  la marca `pendiente` y desde entonces ya es un fallo si se cae.\n');
for (const p of pendientes) {
  console.log(`  ⏳ ${p.clave}`);
  console.log(`     ${p.pendiente}`);
}

console.log('');
if (fallos) {
  console.log(`${fallos} cosa(s) que DEBERÍAN llegar y no llegan.`);
  process.exit(1);
}
console.log(`Todo lo que se espera, llega. ${pendientes.length} pendiente(s) reconocido(s).`);
