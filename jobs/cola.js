/**
 * jobs/cola.js
 * -----------------------------------------------------------------------------
 * La cola de trabajos, sin más magia que una tabla de SQLite.
 *
 * Un "trabajo" es un encargo de scraping para un viaje: ve a Civitatis, tráete
 * las actividades de este destino y guárdalas como candidatos.
 *
 * Estados:
 *   pendiente → nadie lo ha cogido todavía
 *   en_curso  → el worker lo está ejecutando ahora mismo
 *   hecho     → terminó bien
 *   error     → falló; mensaje_error explica qué pasó, en cristiano
 *
 * Aquí solo se manipula la tabla. Quien de verdad ejecuta el trabajo es
 * jobs/worker.js.
 */

import { todas, una, ejecutar } from '../db/index.js';

/** Estados que significan "esto todavía está en marcha". */
const ACTIVOS = ['pendiente', 'en_curso'];

/**
 * Mete un trabajo en la cola.
 * Si ya hay uno activo para ese viaje y tipo, NO duplica: devuelve el que había.
 * Así, aunque recargues la pantalla veinte veces, se scrapea una sola vez.
 */
export function encolar(viajeId, tipo = 'actividades', referenciaId = null) {
  const existente = trabajoActivo(viajeId, tipo, referenciaId);
  if (existente) return existente;

  const r = ejecutar(
    `INSERT INTO trabajos (viaje_id, tipo, estado, referencia_id) VALUES (?, ?, 'pendiente', ?)`,
    viajeId,
    tipo,
    referenciaId
  );
  return una('SELECT * FROM trabajos WHERE id = ?', Number(r.lastInsertRowid));
}

/**
 * El trabajo pendiente o en curso de un viaje, si lo hay.
 *
 * `referenciaId` distingue trabajos del mismo tipo que van sobre cosas
 * distintas: investigar Kioto e investigar Osaka son los dos
 * 'investigar_ciudad' del mismo viaje, y no se pueden confundir. Cuando se pasa
 * null (lo normal en actividades, vuelos u hoteles) se ignora la referencia.
 */
export function trabajoActivo(viajeId, tipo = 'actividades', referenciaId = null) {
  const filtroRef = referenciaId == null ? '' : 'AND referencia_id = ?';
  const extra = referenciaId == null ? [] : [referenciaId];
  return una(
    `SELECT * FROM trabajos
      WHERE viaje_id = ? AND tipo = ? ${filtroRef} AND estado IN ('pendiente', 'en_curso')
      ORDER BY id DESC LIMIT 1`,
    viajeId,
    tipo,
    ...extra
  );
}

/** El último trabajo de un viaje, en el estado que sea. Sirve para ver errores. */
export function ultimoTrabajo(viajeId, tipo = 'actividades', referenciaId = null) {
  const filtroRef = referenciaId == null ? '' : 'AND referencia_id = ?';
  const extra = referenciaId == null ? [] : [referenciaId];
  return una(
    `SELECT * FROM trabajos WHERE viaje_id = ? AND tipo = ? ${filtroRef} ORDER BY id DESC LIMIT 1`,
    viajeId,
    tipo,
    ...extra
  );
}

/**
 * El siguiente trabajo a ejecutar: el pendiente más antiguo, DE LOS TIPOS QUE
 * quien pregunta sabe hacer.
 *
 * Lo de filtrar por tipo no es un capricho, viene de un susto real: si tienes
 * dos servidores levantados contra la misma base de datos (pasa más de lo que
 * parece — uno arrancado a mano y otro desde otra terminal) y uno lleva código
 * viejo, ese cogería un trabajo de un tipo que no conoce y lo dejaría en error.
 * Filtrando, el que no sabe hacerlo sencillamente no lo coge, y lo recoge el
 * que sí sabe.
 */
export function siguientePendiente(tiposConocidos = null) {
  if (!tiposConocidos || !tiposConocidos.length) {
    return una(`SELECT * FROM trabajos WHERE estado = 'pendiente' ORDER BY id ASC LIMIT 1`);
  }
  const huecos = tiposConocidos.map(() => '?').join(', ');
  return una(
    `SELECT * FROM trabajos WHERE estado = 'pendiente' AND tipo IN (${huecos}) ORDER BY id ASC LIMIT 1`,
    ...tiposConocidos
  );
}

/**
 * Reclama un trabajo para EJECUTARLO. Devuelve true solo si lo hemos cogido
 * nosotros.
 *
 * Aqui esta la clave: el UPDATE lleva `AND estado = 'pendiente'`, asi que si
 * dos workers intentan coger el mismo trabajo a la vez, SQLite deja que solo
 * uno cambie la fila; al otro le salen 0 cambios y se aparta.
 *
 * Sin esto, los dos ejecutaban el mismo trabajo y los dos intentaban abrir
 * Chrome con el MISMO perfil persistente: uno arrancaba y el otro se quedaba
 * esperando el candado del perfil, colgado para siempre y sin volver a coger
 * ningun trabajo mas. Ese era el bug de "Booking no abre el navegador".
 */
export function reclamar(id) {
  const r = ejecutar(
    `UPDATE trabajos SET estado = 'en_curso' WHERE id = ? AND estado = 'pendiente'`,
    id
  );
  return r.changes === 1;
}

/** @deprecated Usa reclamar(), que ademas comprueba que nadie se te adelante. */
export function marcarEnCurso(id) {
  ejecutar(`UPDATE trabajos SET estado = 'en_curso' WHERE id = ?`, id);
}

/**
 * Latido: deja constancia de que este proceso esta procesando la cola.
 * Devuelve el pid del worker que manda ahora mismo.
 */
export function latir(pid) {
  ejecutar(
    `INSERT INTO worker_latido (id, pid, visto_en) VALUES (1, ?, datetime('now'))
       ON CONFLICT(id) DO UPDATE SET pid = excluded.pid, visto_en = excluded.visto_en`,
    pid
  );
  return pid;
}

/**
 * ¿Hay ya otro worker vivo? Se considera vivo si ha latido en los ultimos
 * `segundos`. Si el proceso anterior murio, su latido envejece y el siguiente
 * toma el relevo solo.
 */
export function otroWorkerVivo(pidPropio, segundos = 30) {
  const fila = una(`SELECT pid, visto_en FROM worker_latido WHERE id = 1`);
  if (!fila || fila.pid === pidPropio) return null;

  // Antes que nada: ¿ese proceso existe todavía? El `kill(pid, 0)` no mata
  // nada, solo pregunta. Si ya no está (lo normal tras reiniciar el servidor),
  // tomamos el relevo al momento en vez de esperar a que caduque el latido.
  try {
    process.kill(fila.pid, 0);
  } catch {
    return null; // el proceso del latido ya no existe: la cola es nuestra
  }

  const frescura = una(
    `SELECT (julianday('now') - julianday(?)) * 86400 AS antiguedad`,
    fila.visto_en
  ).antiguedad;

  return frescura != null && frescura < segundos ? fila : null;
}

export function marcarHecho(id) {
  ejecutar(
    `UPDATE trabajos SET estado = 'hecho', mensaje_error = NULL, terminado_en = datetime('now') WHERE id = ?`,
    id
  );
}

export function marcarError(id, mensaje) {
  ejecutar(
    `UPDATE trabajos SET estado = 'error', mensaje_error = ?, terminado_en = datetime('now') WHERE id = ?`,
    String(mensaje).slice(0, 500), // que un stack largo no reviente la fila
    id
  );
}

/**
 * Al arrancar la app: si quedó algún trabajo 'en_curso' es que el servidor se
 * reinició a mitad (o se cayó). Nadie lo va a terminar, así que lo marcamos como
 * error para que la pantalla ofrezca reintentar en vez de quedarse girando.
 */
export function recuperarInterrumpidos() {
  const colgados = todas(`SELECT id FROM trabajos WHERE estado = 'en_curso'`);
  for (const t of colgados) {
    marcarError(t.id, 'Interrumpido por reinicio del servidor. Puedes reintentarlo.');
  }
  if (colgados.length) {
    console.log(`[cola] ${colgados.length} trabajo/s en curso marcados como interrumpidos.`);
  }
  return colgados.length;
}

export { ACTIVOS };
