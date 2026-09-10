/**
 * services/orquestador-parada.js
 * -----------------------------------------------------------------------------
 * PARAR EL ORQUESTADOR SIN MATAR EL PROCESO.
 *
 * Hasta ahora, si un viaje se torcía a mitad, la única salida era `pm2 kill`:
 * se perdía el trabajo entero y la base quedaba como quedara. Dos niveles, y no
 * son el mismo botón con distinta prisa:
 *
 *   PARADA LIMPIA · Se pide y se espera. El orquestador termina la operación
 *                   que tenga entre manos —la llamada de IA que ya salió, el
 *                   scraping ya lanzado— y no empieza la siguiente. No hay nada
 *                   que limpiar porque no se ha cortado nada por la mitad. Es la
 *                   que se usa el 90 % de las veces.
 *
 *   ABORTAR       · Freno de emergencia, para cuando algo está colgado. Corta la
 *                   llamada en vuelo, cierra el navegador, vacía la cola y
 *                   DESPUÉS limpia lo que la fase interrumpida hubiera dejado a
 *                   medias. Se paga con datos parciales que hay que barrer.
 *
 * CÓMO SE BARRE SIN DESTROZAR NADA. Al empezar cada fase se guarda el último id
 * de cada tabla del viaje. Lo que aparezca POR ENCIMA de esos ids lo escribió
 * esa fase y nadie más: los ids son autoincrementales, así que «por encima de»
 * es exactamente «creado después». Se borra eso y solo eso; lo de las fases
 * anteriores está todo por debajo y no se toca jamás.
 *
 * EL CATÁLOGO NO SE BARRE. La fase de sitios escribe en `sitios_lugar` y la de
 * traslados en `catalogo_transporte_tramo`, que son conocimiento del mundo
 * compartido entre viajes: borrar ahí por abortar un viaje se llevaría por
 * delante lo que otro ya había investigado. Además no hace falta: esas escrituras
 * son idempotentes —volver a pasar por ahí las reutiliza— y regenerar la fase
 * las encuentra hechas.
 */

import { todas, una, ejecutar, db } from '../db/index.js';
import { anotar, ORIGENES, TABLAS_DEL_VIAJE, fotoDeLaBase } from './orquestador.js';

export { fotoDeLaBase };

/** Las dos formas de pedir que pare. Cualquier otra cosa es «no pares». */
export const PARADAS = ['limpia', 'abortar'];

// =============================================================================
// PEDIR LA PARADA
// =============================================================================
/**
 * Deja pedida la parada. No para nada por sí sola: el que para es el worker,
 * que mira esta marca entre paso y paso.
 *
 * Devuelve `false` si no había nada corriendo, para que la pantalla no diga que
 * ha parado algo que ya estaba quieto.
 */
export function pedirParada(viajeId, modo = 'limpia') {
  const como = PARADAS.includes(modo) ? modo : 'limpia';
  ejecutar('UPDATE viajes SET orquestador_parada = ? WHERE id = ?', como, Number(viajeId));
  return como;
}

/** ¿Se ha pedido parar? Devuelve 'limpia', 'abortar' o null. */
export function paradaPedida(viajeId) {
  const v = una('SELECT orquestador_parada FROM viajes WHERE id = ?', Number(viajeId));
  return PARADAS.includes(v?.orquestador_parada) ? v.orquestador_parada : null;
}

/** Se olvida la petición. Se llama al arrancar y al acabar de atenderla. */
export function limpiarParada(viajeId) {
  ejecutar('UPDATE viajes SET orquestador_parada = NULL WHERE id = ?', Number(viajeId));
}

/**
 * EL PUNTO DE CONTROL QUE MIRAN LAS FASES.
 *
 * Se llama entre paso y paso —entre ciudad y ciudad, entre salto y salto— y
 * devuelve true cuando toca dejarlo. La fase que lo respete se corta en un sitio
 * limpio; la que no lo mire, se corta entre fases igual, que es el mínimo
 * garantizado por el worker.
 *
 * `paso` es dónde se estaba: se guarda para poder decir «parado tras la fase
 * sitios, paso Varsovia» en vez de solo el nombre de la fase.
 */
export function hayQueParar(viajeId, fase = null, paso = null) {
  const pedida = paradaPedida(viajeId);
  if (!pedida) return false;

  if (fase && paso) {
    ejecutar(
      'UPDATE orquestador_fases SET paso = ? WHERE viaje_id = ? AND fase = ?',
      String(paso).slice(0, 200),
      viajeId,
      fase
    );
  }
  return true;
}

/** Dónde se quedó una fase, para el mensaje. */
export function pasoDeLaFase(viajeId, fase) {
  return una(
    'SELECT paso FROM orquestador_fases WHERE viaje_id = ? AND fase = ?',
    viajeId,
    fase
  )?.paso ?? null;
}

// =============================================================================
// BARRER LO PARCIAL
// =============================================================================
/**
 * BORRA LO QUE ESCRIBIÓ ESTA FASE Y NADA MÁS.
 *
 * Solo tras un ABORTO: una parada limpia no deja nada a medias y aquí no hay
 * nada que hacer.
 *
 * Se apoya en la foto que se tomó al empezar la fase. Sin foto no se borra nada:
 * es preferible dejar datos parciales —que el relanzado sabe rehacer— a borrar a
 * ciegas con un criterio inventado.
 */
export function limpiarParcialesDeFase(viajeId, fase) {
  const fila = una(
    'SELECT marcas FROM orquestador_fases WHERE viaje_id = ? AND fase = ?',
    viajeId,
    fase
  );

  let foto = null;
  try {
    foto = fila?.marcas ? JSON.parse(fila.marcas) : null;
  } catch {
    foto = null;
  }
  if (!foto) return { borrado: {}, sinFoto: true };

  const borrado = {};
  db.exec('BEGIN');
  try {
    for (const tabla of TABLAS_DEL_VIAJE) {
      const desde = Number(foto[tabla]);
      if (!Number.isFinite(desde)) continue;
      const r = ejecutar(`DELETE FROM ${tabla} WHERE viaje_id = ? AND id > ?`, viajeId, desde);
      if (r.changes) borrado[tabla] = r.changes;
    }
    db.exec('COMMIT');
  } catch (err) {
    db.exec('ROLLBACK');
    console.error(`[parada] no pude limpiar lo parcial de ${fase}: ${err.message}`);
    return { borrado: {}, error: err.message };
  }

  return { borrado, sinFoto: false };
}

/**
 * CIERRA LA FASE INTERRUMPIDA COMO LO QUE ES: a medias.
 *
 * NUNCA 'hecho'. Una fase que se corta puede haber dejado tres ciudades de cinco
 * y marcarla como hecha haría que el relanzado la saltara, dejando el viaje
 * incompleto para siempre y sin que nada lo dijera.
 *
 * Se deja en 'pendiente' precisamente para que el relanzado la vuelva a hacer
 * entera: es el estado del que sabe salir el mecanismo que ya existe.
 */
export function dejarFaseAMedias(viajeId, fase) {
  ejecutar(
    `UPDATE orquestador_fases
        SET estado = 'pendiente', terminado_en = datetime('now')
      WHERE viaje_id = ? AND fase = ?`,
    viajeId,
    fase
  );
}

/**
 * Cancela los trabajos de la cola de este viaje que todavía no han empezado.
 *
 * El que está EN CURSO no se toca desde aquí: lo corta quien lo esté ejecutando
 * al ver la marca. Marcar como cancelado un trabajo que sigue vivo dejaría la
 * cola mintiendo.
 */
export function vaciarColaDelViaje(viajeId) {
  const r = ejecutar(
    `UPDATE trabajos
        SET estado = 'error', mensaje_error = 'Cancelado al abortar el montaje.',
            terminado_en = datetime('now')
      WHERE viaje_id = ? AND estado = 'pendiente'`,
    Number(viajeId)
  );
  return r.changes;
}

// =============================================================================
// LO QUE SE ESCRIBE EN EL REGISTRO
// =============================================================================
/** «Parado por el usuario tras la fase Ciudades y noches, paso Varsovia». */
export function anotarParada(viajeId, fase, etiquetaFase, paso) {
  anotar(
    viajeId,
    fase,
    `Parado por el usuario tras la fase ${etiquetaFase}` +
      (paso ? `, paso ${paso}` : '') +
      '. Las fases anteriores quedan hechas; esta queda pendiente.',
    ORIGENES.ninguno
  );
}

/** «Abortado durante la fase X, paso Y. Datos parciales limpiados.» */
export function anotarAborto(viajeId, fase, etiquetaFase, paso, borrado) {
  const cuantos = Object.entries(borrado ?? {})
    .map(([tabla, n]) => `${n} de ${tabla}`)
    .join(', ');

  anotar(
    viajeId,
    fase,
    `Abortado por el usuario durante la fase ${etiquetaFase}` +
      (paso ? `, paso ${paso}` : '') +
      '. ' +
      (cuantos
        ? `Datos parciales de la fase limpiados (${cuantos}).`
        : 'No había datos parciales que limpiar.'),
    ORIGENES.ninguno
  );
}

export default {
  PARADAS,
  fotoDeLaBase,
  pedirParada,
  paradaPedida,
  limpiarParada,
  hayQueParar,
  pasoDeLaFase,
  limpiarParcialesDeFase,
  dejarFaseAMedias,
  vaciarColaDelViaje,
  anotarParada,
  anotarAborto,
};
