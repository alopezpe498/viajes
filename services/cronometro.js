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

// =============================================================================
// EL ESTADO
// =============================================================================

/** El viaje que se está montando ahora, con lo que ya han contado sus fases. */
let viaje = null;

/** La fase abierta ahora mismo. */
let fase = null;

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
  viaje = { viajeId, desde: ahora(), fases: [] };
  fase = null;
}

/**
 * Empieza una fase. Si había otra abierta se cierra sin decir nada: es lo que
 * pasa cuando una fase revienta y el bucle sigue con la siguiente.
 */
export function arrancarFase(viajeId, clave) {
  if (fase) pararFase();
  if (!viaje || viaje.viajeId !== viajeId) arrancarViaje(viajeId);

  fase = {
    viajeId,
    clave,
    desde: ahora(),
    ia: [],
    scraping: [],
    paradas: [],
    reintentos: [],
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
  if (!fase) return;

  const limpio = String(nombre ?? '').trim();
  const ultima = fase.paradas[fase.paradas.length - 1];
  if (ultima && !ultima.hasta) ultima.hasta = ahora();
  if (!limpio) return;

  fase.paradas.push({ nombre: limpio, desde: ahora(), hasta: null });
}

// =============================================================================
// LO QUE APUNTAN LOS QUE TARDAN
// =============================================================================

/** Una llamada al modelo, con lo que costó, qué modelo fue y si buscó en la web. */
export function apuntarIA({ desde, hasta, modelo, web = false }) {
  if (!fase || !desde || !hasta) return;
  fase.ia.push({ desde, hasta, modelo: modelo ?? 'desconocido', web: Boolean(web) });
}

/** Una sesión de navegador: de abrirlo a cerrarlo. */
export function apuntarScraping({ desde, hasta, de }) {
  if (!fase || !desde || !hasta) return;
  fase.scraping.push({ desde, hasta, de: de ?? 'sin nombre' });
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
  if (!fase) return () => {};

  if (ms != null) {
    fase.reintentos.push({ motivo, ms });
    return () => {};
  }

  const desde = ahora();
  const suyo = fase;
  return () => {
    suyo.reintentos.push({ motivo, ms: ahora() - desde });
  };
}

// =============================================================================
// LAS LÍNEAS
// =============================================================================

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
    const conWeb = f.ia.filter((x) => x.web).length;
    trozos.push(
      `IA ${comoRato(ia)} (${f.ia.length} llamada${f.ia.length === 1 ? '' : 's'}, ${modelos}` +
        `${conWeb ? `; ${conWeb} con búsqueda web` : ''})`
    );
  }

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

  return [...porNombre.entries()]
    .sort((a, b) => b[1] - a[1])
    .map(([nombre, ms]) => `${nombre} ${comoRato(ms)}`)
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
export function pararFase(etiqueta = null) {
  if (!fase) return [];

  enParada(null); // cierra el segmento de la última parada
  fase.hasta = ahora();

  const { total } = cuentasDe(fase);
  const comoSeLlama = etiqueta ?? fase.clave;

  const lineas = [`Fase «${comoSeLlama}» completada en ${comoRato(total)}.`];
  lineas.push(`   Desglose: ${lineaDeDesglose(fase)}.`);

  const paradas = lineaDeParadas(fase);
  if (paradas) lineas.push(`   Por parada: ${paradas}.`);

  const reintentos = lineaDeReintentos(fase.reintentos);
  if (reintentos) lineas.push(`   Incluye ${reintentos}.`);

  if (viaje) viaje.fases.push({ ...fase, etiqueta: comoSeLlama });
  fase = null;

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
  if (fase) pararFase();
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
