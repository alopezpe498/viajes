/**
 * services/cronometro.js
 * -----------------------------------------------------------------------------
 * DÓNDE SE VAN LOS VEINTE MINUTOS.
 *
 * Montar un viaje tarda un rato largo y hasta ahora nadie sabía en qué. La
 * sospecha razonable es que casi todo es scraping —abrir Booking cuatro veces no
 * es gratis— pero una sospecha no sirve para decidir qué merece la pena
 * paralelizar. Esto lo mide.
 *
 * MIDE, NO CAMBIA NADA. Ninguna función de aquí decide, reintenta ni altera el
 * orden de nada: solo apunta cuándo empezó y cuándo acabó cada cosa. Si se borra
 * el módulo entero, el viaje sale exactamente igual y un poco más a ciegas.
 *
 * TRES DECISIONES QUE EXPLICAN EL CÓDIGO:
 *
 *   1. SE GUARDAN INTERVALOS, NO SUMAS. Dos llamadas de IA en paralelo —la ficha
 *      de país hace un `Promise.allSettled`— duran 20 s cada una y 20 s en total,
 *      no 40. Sumando duraciones, el desglose acabaría diciendo que una fase de
 *      tres minutos gastó cuatro, y el «resto» saldría negativo. Guardando
 *      [desde, hasta] y fundiendo los solapes, cada cubo dice tiempo de reloj de
 *      verdad.
 *
 *   2. EL MÓDULO NO SABE ESCRIBIR EN EL REGISTRO. No importa nada de
 *      `orquestador.js`: devuelve las líneas ya redactadas y las escribe quien
 *      llama. Así no hay import circular —`orquestador` sí importa esto— y el
 *      cronómetro se puede usar desde `lib/`, que es donde están las dos cosas
 *      que de verdad tardan.
 *
 *   3. FUERA DEL ORQUESTADOR NO HACE NADA. Una consulta de IA lanzada desde la
 *      pantalla de una etapa no tiene fase abierta: `apuntarIA` se va por donde
 *      ha venido. El coste de tener esto enchufado en el flujo manual es cero.
 *
 * Vale una sola ejecución a la vez, igual que `faseEnCurso()`, y por el mismo
 * motivo: la cola corre los trabajos de uno en uno.
 */

import { faseDeAqui, enParadaDeAqui, segmentoDeAqui } from './fase-actual.js';

// =============================================================================
// EL ESTADO
// =============================================================================

/** El viaje que se está montando ahora, con lo que ya han contado sus fases. */
let viaje = null;

/**
 * LAS FASES ABIERTAS AHORA MISMO, por clave.
 *
 * Era una sola variable, y con las seis fases en fila valía. Con «dormir»,
 * «sitios» y «excursiones» corriendo a la vez ya no: la última en arrancar
 * pisaba a las otras dos y todo lo que midiera se lo quedaba ella.
 *
 * Cuál de las abiertas es la de una llamada concreta lo dice `faseDeAqui()`, que
 * lo arrastra por la cadena de ejecución. Aquí solo se guardan.
 */
const abiertas = new Map();

/** La fase de esta cadena de ejecución, si está abierta. */
function laMia() {
  const ctx = faseDeAqui();
  if (ctx?.fase && abiertas.has(ctx.fase)) return abiertas.get(ctx.fase);
  // Fuera de todo contexto, y con una sola fase abierta, es esa. Es lo que hace
  // que nada de lo que ya funcionaba deje de funcionar.
  return abiertas.size === 1 ? [...abiertas.values()][0] : null;
}

const ahora = () => Date.now();

// =============================================================================
// CUENTAS CON INTERVALOS
// =============================================================================

/**
 * CUÁNTO TIEMPO DE RELOJ CUBREN ESTOS INTERVALOS, contando una sola vez lo que
 * se solapa. Es toda la aritmética que hace falta para que los cubos sumen algo
 * que se pueda enseñar.
 */
function tiempoCubierto(intervalos) {
  if (!intervalos.length) return 0;

  const ordenados = [...intervalos].sort((a, b) => a.desde - b.desde);
  let total = 0;
  let [desde, hasta] = [ordenados[0].desde, ordenados[0].hasta];

  for (const i of ordenados.slice(1)) {
    if (i.desde > hasta) {
      total += hasta - desde;
      [desde, hasta] = [i.desde, i.hasta];
    } else if (i.hasta > hasta) {
      hasta = i.hasta;
    }
  }
  return total + (hasta - desde);
}

/** 252000 → «4m 12s». Lo que uno diría, no milisegundos. */
export function comoRato(ms) {
  // El redondeo a segundos va PRIMERO: con 59,6 s, decidir antes de redondear
  // dejaba escrito «60s», que no es como lo diría nadie.
  const s = Math.round(Math.max(0, Number(ms) || 0) / 1000);
  if (s < 60) return `${s}s`;

  const m = Math.floor(s / 60);
  const resto = s % 60;
  if (m < 60) return resto ? `${m}m ${String(resto).padStart(2, '0')}s` : `${m}m`;

  const h = Math.floor(m / 60);
  return `${h}h ${String(m % 60).padStart(2, '0')}m`;
}

/** «4 búsquedas Booking, 2 Civitatis», ordenado de más a menos. */
function comoLista(cuentas, { singular = '', plural = '' } = {}) {
  const pares = [...cuentas.entries()].sort((a, b) => b[1] - a[1]);
  return pares
    .map(([que, n], i) => {
      const palabra = i === 0 ? (n === 1 ? singular : plural) : '';
      return `${n}${palabra ? ` ${palabra}` : ''} ${que}`.trim();
    })
    .join(', ');
}

/** Cuenta cuántas veces aparece cada valor. */
function contar(lista, comoSeLlama) {
  const cuentas = new Map();
  for (const x of lista) {
    const clave = comoSeLlama(x);
    if (!clave) continue;
    cuentas.set(clave, (cuentas.get(clave) ?? 0) + 1);
  }
  return cuentas;
}

// =============================================================================
// ARRANCAR Y PARAR
// =============================================================================

/** Empieza a cronometrar un viaje entero. Lo llama el worker antes del bucle. */
export function arrancarViaje(viajeId) {
  viaje = { viajeId, desde: ahora(), fases: [], bloques: [] };
  abiertas.clear();
}

/**
 * Empieza una fase. Si había otra abierta se cierra sin decir nada: es lo que
 * pasa cuando una fase revienta y el bucle sigue con la siguiente.
 */
export function arrancarFase(viajeId, clave) {
  if (!viaje || viaje.viajeId !== viajeId) arrancarViaje(viajeId);

  abiertas.set(clave, {
    viajeId,
    clave,
    desde: ahora(),
    ia: [],
    scraping: [],
    paradas: [],
    reintentos: [],
  });
}

/**
 * UN BLOQUE EN PARALELO: cuánto duró de reloj y cuánto de trabajo.
 *
 * Sin esto, el resumen de un viaje con tres fases a la vez no cuadra: la suma de
 * las fases pasa del total del viaje y parece un error de cuentas cuando es
 * justo lo contrario —es lo que se ha ganado—. Se marca el bloque y el resumen
 * lo dice con sus dos números.
 */
export function abrirBloqueParalelo(nombre) {
  if (!viaje) return () => {};
  const bloque = { nombre, desde: ahora(), hasta: null, claves: [] };
  viaje.bloques.push(bloque);
  return (claves) => {
    bloque.hasta = ahora();
    bloque.claves = claves ?? [];
  };
}

/**
 * MARCA EN QUÉ PARADA SE ESTÁ TRABAJANDO.
 *
 * Se engancha en `hayQueParar`, que las cinco fases con paradas ya llaman una
 * vez por ciudad y con su nombre. Aprovecharlo evita tocar las cinco fases para
 * añadir lo mismo, y de paso garantiza que si alguien escribe una fase nueva con
 * paradas, el desglose le sale solo.
 */
export function enParada(nombre) {
  const f = laMia();
  if (!f) return;

  const limpio = String(nombre ?? '').trim();

  // CON PARADAS EN PARALELO, CADA UNA LLEVA SU RELOJ.
  //
  // Antes se cerraba «el último segmento abierto», y valía porque solo había uno
  // vivo. Con tres a la vez eso deja de querer decir nada. El segmento va colgado
  // del contexto de ejecución, así que cada rama cierra EL SUYO — y en las fases
  // que siguen yendo en fila, donde la fase entera comparte contexto, cada parada
  // cierra la anterior exactamente como antes.
  const abierto = segmentoDeAqui();
  if (abierto && !abierto.hasta) abierto.hasta = ahora();

  enParadaDeAqui(limpio || null);

  // Repetir el mismo nombre cierra: es como `porParada` marca el final de una
  // parada sin tener que inventar una función aparte.
  if (!limpio || abierto?.nombre === limpio) {
    segmentoDeAqui(null);
    enParadaDeAqui(null);
    return;
  }

  const nuevo = { nombre: limpio, desde: ahora(), hasta: null };
  f.paradas.push(nuevo);
  segmentoDeAqui(nuevo);
}

/** Cierra el reloj de una parada. Lo llama quien la abrió, al acabar. */
export function fueraDeParada(nombre) {
  enParada(nombre);
}

// =============================================================================
// LO QUE APUNTAN LOS QUE TARDAN
// =============================================================================

/** Una llamada al modelo, con lo que costó, qué modelo fue y si buscó en la web. */
export function apuntarIA({ desde, hasta, modelo, clase = null, web = false }) {
  const f = laMia();
  if (!f || !desde || !hasta) return;
  f.ia.push({
    desde,
    hasta,
    modelo: modelo ?? 'desconocido',
    clase,
    web: Boolean(web),
    parada: faseDeAqui()?.parada ?? null,
  });
}

/**
 * LO QUE SE HA ESPERADO EN LA COLA DEL NAVEGADOR.
 *
 * Va en su propio cubo y NUNCA cuenta como trabajo de la parada. La métrica
 * decía «Gdansk 37m 40s» dentro de una fase de 18m 57s —imposible— porque la
 * espera se sumaba como si la ciudad hubiera estado haciendo algo. Estaba
 * parada, que es justo lo contrario y justo lo que había que ver.
 */
export function apuntarEsperaDeScraping({ de, ms }) {
  const f = laMia();
  if (!f || !ms || ms < 0) return;
  (f.esperas ??= []).push({ de: de ?? 'sin nombre', ms });
}

/** Una sesión de navegador: de abrirlo a cerrarlo. */
export function apuntarScraping({ desde, hasta, de }) {
  const f = laMia();
  if (!f || !desde || !hasta) return;
  f.scraping.push({ desde, hasta, de: de ?? 'sin nombre' });
}

/**
 * UN REINTENTO, CON LO QUE COSTÓ DE MÁS.
 *
 * Los dos que existen hoy son de naturaleza distinta y por eso el motivo es
 * texto libre: el de la IA sabe exactamente cuánto duró el intento fallido, y el
 * de los filtros aflojados de «dormir» se mide envolviendo la búsqueda nueva.
 *
 * Si no se pasa `ms`, se devuelve la función que cierra la cuenta.
 */
export function apuntarReintento({ motivo, ms = null }) {
  const f = laMia();
  if (!f) return () => {};

  if (ms != null) {
    f.reintentos.push({ motivo, ms });
    return () => {};
  }

  const desde = ahora();
  return () => {
    f.reintentos.push({ motivo, ms: ahora() - desde });
  };
}

// =============================================================================
// LAS LÍNEAS
// =============================================================================

/**
 * LOS NÚMEROS DE UNA FASE ABIERTA, para poder mirarlos sin cerrarla.
 *
 * Lo usa la verificación: el reparto entre scraping e IA es lo que hay que poder
 * comprobar —que uno va en fila y el otro se solapa— y esperar a que la fase
 * cierre para verlo obliga a leerlo de un texto ya redondeado.
 */
export function cuentasDeLaFase(clave) {
  const f = abiertas.get(clave);
  return f ? cuentasDe(f) : { total: 0, scraping: 0, ia: 0, resto: 0 };
}

/** El desglose de una fase, ya en números. */
function cuentasDe(f) {
  const total = (f.hasta ?? ahora()) - f.desde;
  const scraping = tiempoCubierto(f.scraping);
  const ia = tiempoCubierto(f.ia);

  // El «resto» se calcula contra la unión de TODO, no restando los dos cubos: si
  // una sesión de navegador y una llamada de IA llegaran a solaparse, restarlos
  // por separado daría un resto negativo, que es la clase de número que hace que
  // nadie vuelva a mirar la tabla.
  const trabajado = tiempoCubierto([...f.scraping, ...f.ia]);

  return { total, scraping, ia, resto: Math.max(0, total - trabajado) };
}

/** «scraping 3m 30s (4 búsquedas Booking) · IA 25s (4 llamadas, …) · resto 17s» */
function lineaDeDesglose(f) {
  const { scraping, ia, resto } = cuentasDe(f);
  const trozos = [];

  if (f.scraping.length) {
    const cuales = comoLista(contar(f.scraping, (x) => x.de), {
      singular: 'búsqueda',
      plural: 'búsquedas',
    });
    trozos.push(`scraping ${comoRato(scraping)} (${cuales})`);
  }

  if (f.ia.length) {
    const modelos = [...new Set(f.ia.map((x) => x.modelo))].join(' y ');
    const clases = [...new Set(f.ia.map((x) => x.clase).filter(Boolean))].join('/');
    const conWeb = f.ia.filter((x) => x.web).length;
    trozos.push(
      `IA ${comoRato(ia)} (${f.ia.length} llamada${f.ia.length === 1 ? '' : 's'}, ${modelos}` +
        `${clases ? ` [${clases}]` : ''}${conWeb ? `; ${conWeb} con búsqueda web` : ''})`
    );
  }

  const esperado = (f.esperas ?? []).reduce((n2, x) => n2 + x.ms, 0);
  if (esperado) trozos.push(`esperando cola ${comoRato(esperado)}`);

  trozos.push(`resto ${comoRato(resto)}`);
  return trozos.join(' · ');
}

/** «Atenas 2m 05s · Nafplio 1m 40s» */
function lineaDeParadas(f) {
  const cerradas = f.paradas.filter((p) => p.hasta);
  if (cerradas.length < 2) return null;

  // Una ciudad puede aparecer dos veces si la fase vuelve sobre ella: se suman.
  const porNombre = new Map();
  for (const p of cerradas) {
    porNombre.set(p.nombre, (porNombre.get(p.nombre) ?? 0) + (p.hasta - p.desde));
  }

  // UNA PARADA NO PUEDE DURAR MÁS QUE SU FASE.
  //
  // Y lo decía: «Gdansk 37m 40s» dentro de una fase de 18m 57s. El segmento de
  // una parada incluye el rato que pasó esperando cola de navegador, que es
  // tiempo de reloj compartido con las otras paradas. Se acota al total de la
  // fase para que el número no mienta, y la espera se cuenta aparte.
  const tope = (f.hasta ?? ahora()) - f.desde;

  return [...porNombre.entries()]
    .sort((a, b) => b[1] - a[1])
    .map(([nombre, ms]) => `${nombre} ${comoRato(Math.min(ms, tope))}`)
    .join(' · ');
}

/** «1 reintento por timeout (+3m)» */
function lineaDeReintentos(reintentos) {
  if (!reintentos.length) return null;

  const porMotivo = new Map();
  for (const r of reintentos) {
    const x = porMotivo.get(r.motivo) ?? { n: 0, ms: 0 };
    porMotivo.set(r.motivo, { n: x.n + 1, ms: x.ms + r.ms });
  }

  return [...porMotivo.entries()]
    .map(([motivo, x]) => `${x.n} reintento${x.n === 1 ? '' : 's'} por ${motivo} (+${comoRato(x.ms)})`)
    .join(', ');
}

/**
 * Cierra la fase y devuelve las líneas que hay que escribir en su registro.
 *
 * `etiqueta` es el nombre bonito de la fase; si no se pasa se usa la clave.
 */
export function pararFase(etiqueta = null, clave = null) {
  const cual = clave ?? faseDeAqui()?.fase ?? (abiertas.size === 1 ? [...abiertas.keys()][0] : null);
  const f = cual ? abiertas.get(cual) : null;
  if (!f) return [];

  // Cierra los segmentos de parada que sigan abiertos.
  for (const p of f.paradas) if (!p.hasta) p.hasta = ahora();
  f.hasta = ahora();
  abiertas.delete(cual);

  const { total } = cuentasDe(f);
  const comoSeLlama = etiqueta ?? f.clave;

  const lineas = [`Fase «${comoSeLlama}» completada en ${comoRato(total)}.`];
  lineas.push(`   Desglose: ${lineaDeDesglose(f)}.`);

  const paradas = lineaDeParadas(f);
  if (paradas) lineas.push(`   Por parada: ${paradas}.`);

  const reintentos = lineaDeReintentos(f.reintentos);
  if (reintentos) lineas.push(`   Incluye ${reintentos}.`);

  if (viaje) viaje.fases.push({ ...f, etiqueta: comoSeLlama });

  return lineas;
}

/**
 * EL RESUMEN DEL VIAJE ENTERO. Se llama cuando ya no queda fase por correr.
 *
 * Los totales se calculan sobre los intervalos de TODAS las fases juntas, no
 * sumando los subtotales ya redondeados: sumar «4m» + «3m» + «2m» y enseñarlo
 * como el total es la forma más fácil de que la línea final no cuadre con las de
 * arriba y nadie se fíe de ninguna.
 */
export function resumenDeViaje() {
  for (const clave of [...abiertas.keys()]) pararFase(null, clave);
  if (!viaje || !viaje.fases.length) return [];

  const total = ahora() - viaje.desde;
  const todaIA = viaje.fases.flatMap((f) => f.ia);
  const todoScraping = viaje.fases.flatMap((f) => f.scraping);
  const todosReintentos = viaje.fases.flatMap((f) => f.reintentos);

  const scraping = tiempoCubierto(todoScraping);
  const ia = tiempoCubierto(todaIA);
  const resto = Math.max(0, total - tiempoCubierto([...todoScraping, ...todaIA]));

  const porFase = viaje.fases
    .map((f) => `${f.etiqueta} ${comoRato((f.hasta ?? ahora()) - f.desde)}`)
    .join(' · ');

  const lineas = [`Viaje generado en ${comoRato(total)}: ${porFase}.`];

  // LO QUE FUE EN PARALELO SE DICE CON SUS DOS NÚMEROS.
  //
  // Sin esto la línea de arriba no cuadra: tres fases de 4, 3 y 2 minutos dentro
  // de un bloque que duró 4 suman 9, y quien lo lea pensará que las cuentas
  // están mal. Están bien: esos 5 minutos de diferencia son exactamente lo que
  // se ha ganado, y es el número que se quería ver.
  for (const b of viaje.bloques ?? []) {
    if (!b.hasta) continue;
    const suyas = viaje.fases.filter((f) => b.claves.includes(f.clave));
    const trabajo = suyas.reduce((n2, f) => n2 + ((f.hasta ?? ahora()) - f.desde), 0);
    lineas.push(
      `   ${b.nombre}: ${comoRato(b.hasta - b.desde)} de reloj, ${comoRato(trabajo)} de trabajo` +
        `${trabajo > b.hasta - b.desde ? ` (${comoRato(trabajo - (b.hasta - b.desde))} ahorrados)` : ''}.`
    );
  }

  const trozos = [];
  if (todoScraping.length) {
    const cuales = comoLista(contar(todoScraping, (x) => x.de), {
      singular: 'sesión',
      plural: 'sesiones',
    });
    trozos.push(`Scraping total ${comoRato(scraping)} (${cuales})`);
  }
  if (todaIA.length) {
    // Con un modelo solo se dice su nombre; con dos o más, cuántas de cada uno.
    // «38 llamadas: 38 claude-haiku-4-5» es la mitad de la línea sin decir nada.
    // POR MODELO REAL, no por clase: «criterio» no dice cuánto cuesta ni cuánto
    // tarda, y el nombre sí. La clase se ve en el desglose de cada fase.
    const cuentas = contar(todaIA, (x) => x.modelo);
    const modelos =
      cuentas.size > 1 ? `: ${comoLista(cuentas)}` : `, ${[...cuentas.keys()][0]}`;
    const conWeb = todaIA.filter((x) => x.web).length;
    trozos.push(
      `IA total ${comoRato(ia)} (${todaIA.length} llamada${todaIA.length === 1 ? '' : 's'}${modelos}` +
        `${conWeb ? `; ${conWeb} con búsqueda web` : ''})`
    );
  }
  trozos.push(`resto ${comoRato(resto)}`);
  lineas.push(`   ${trozos.join(' · ')}.`);

  const reintentos = lineaDeReintentos(todosReintentos);
  if (reintentos) lineas.push(`   Reintentos del viaje: ${reintentos}.`);

  viaje = null;
  return lineas;
}
