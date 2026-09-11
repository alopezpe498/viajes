/**
 * services/fase-actual.js
 * -----------------------------------------------------------------------------
 * EN QUÉ FASE ESTAMOS, CUANDO HAY VARIAS A LA VEZ.
 *
 * EL PROBLEMA QUE RESUELVE. Hasta ahora «la fase en curso» era una variable de
 * módulo, y eso valía porque la cola corre los trabajos de uno en uno y las seis
 * fases iban en fila. Al poner «dormir», «sitios» y «excursiones» a la vez, esa
 * variable pasa a ser mentira: la última en arrancar pisa a las otras dos, y
 * todo lo que dependa de ella —a qué registro va una línea, a qué fase se le
 * apunta una llamada de IA, qué modelo le toca— se lo atribuye a quien no es.
 *
 * LA SOLUCIÓN NO ES PASAR LA FASE POR PARÁMETRO. Habría que hilarla por decenas
 * de funciones que no tienen nada que ver con esto, incluidas las de `lib/`, y
 * la primera que se olvidara volvería a mentir en silencio.
 *
 * `AsyncLocalStorage` es exactamente la herramienta: guarda un valor asociado a
 * una cadena de ejecución y lo arrastra a través de los `await`, así que dentro
 * de `enFase('sitios', ...)` todo lo que se llame —por hondo que esté— sabe que
 * está en «sitios», y lo que se llame a la vez dentro de `enFase('dormir', ...)`
 * sabe que está en «dormir». Sin tocar ninguna firma.
 *
 * Vive en su propio fichero, y no dentro de `orquestador.js`, para que `lib/ia.js`
 * y el cronómetro puedan leerlo sin importar medio orquestador ni montar un
 * ciclo de imports.
 */
import { AsyncLocalStorage } from 'node:async_hooks';

const almacen = new AsyncLocalStorage();

/**
 * EL RESPALDO DE CUANDO NO HAY CONTEXTO.
 *
 * Las fases que corren solas siguen marcándose con `empezarFase`, que escribe
 * aquí. Es lo que hace que este cambio no rompa nada de lo que ya funcionaba: si
 * nadie ha abierto un contexto, se responde lo de siempre.
 */
let suelta = null;

/** Marca la fase «a secas», como se hacía antes. */
export function marcarFaseSuelta(valor) {
  suelta = valor;
}

/** Corre `fn` sabiendo que está dentro de esta fase. */
export function enFase(viajeId, fase, fn) {
  return almacen.run({ viajeId, fase }, fn);
}

/**
 * La fase de esta cadena de ejecución, o la suelta si no hay ninguna.
 * `null` cuando la llamada no viene del orquestador.
 */
export function faseDeAqui() {
  return almacen.getStore() ?? suelta;
}

/**
 * LA PARADA DE ESTA CADENA. Se apunta aparte porque cambia muchas veces dentro
 * de la misma fase y el contexto no se puede reescribir: se guarda un hueco
 * mutable dentro del propio contexto.
 */
export function enParadaDeAqui(nombre) {
  const ctx = almacen.getStore();
  if (ctx) ctx.parada = nombre;
}

export function paradaDeAqui() {
  return almacen.getStore()?.parada ?? null;
}

/**
 * EL TROZO DE RELOJ QUE ESTÁ ABIERTO EN ESTA CADENA.
 *
 * El cronómetro necesita saber qué segmento cerrar, y «el último» dejó de valer
 * en cuanto hay tres paradas abiertas a la vez. Colgarlo del contexto lo resuelve
 * para los dos casos de golpe: en paralelo cada rama tiene el suyo, y en fila
 * —traslados, lienzo— la fase entera comparte contexto y cada parada cierra la
 * anterior, que es lo que hacía antes.
 */
export function segmentoDeAqui(valor) {
  const ctx = almacen.getStore();
  if (!ctx) return null;
  if (valor !== undefined) ctx.segmento = valor;
  return ctx.segmento ?? null;
}
