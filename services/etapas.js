/**
 * services/etapas.js
 * -----------------------------------------------------------------------------
 * Las etapas de un viaje: las paradas de la ruta.
 *
 * De momento NINGUNA pantalla las enseña. Este módulo existe para que el modelo
 * nuevo no se quede a medias: cada vez que se toca el destino o las fechas de un
 * viaje, su etapa tiene que enterarse, o en dos semanas la tabla `etapas` sería
 * un montón de filas desfasadas que no se corresponden con nada.
 *
 * Mientras el wizard siga siendo de un solo destino, cada viaje tiene UNA etapa
 * confirmada que es el reflejo de `viajes.destino`. Cuando se rediseñe la
 * navegación, esa etapa ya estará ahí y solo habrá que dejar añadir más.
 *
 * REGLA DE LAS FECHAS
 * Las fechas de una etapa NO se editan a mano: son derivadas. Salen de la fecha
 * de inicio del viaje, del orden de las etapas y de las noches de cada una.
 * Por eso hay una sola función que las calcula, y se llama siempre que algo de
 * eso cambia.
 */

import { todas, una, ejecutar, nochesEntre } from '../db/index.js';

/** Todas las etapas de un viaje, en el orden de la ruta. */
export function etapasDe(viajeId) {
  return todas('SELECT * FROM etapas WHERE viaje_id = ? ORDER BY orden, id', viajeId);
}

/** Solo las que entran en el itinerario (las de 'recopilando' aún se están mirando). */
export function etapasConfirmadas(viajeId) {
  return todas(
    "SELECT * FROM etapas WHERE viaje_id = ? AND estado = 'confirmada' ORDER BY orden, id",
    viajeId
  );
}

/**
 * La primera etapa confirmada del viaje.
 *
 * Es la que usan las pantallas que todavía piensan en términos de "el destino
 * del viaje": mientras haya una sola, esta es esa. Devuelve undefined si el
 * viaje no tiene ninguna (un viaje recién creado, sin destino).
 */
export function etapaPrincipal(viajeId) {
  return una(
    "SELECT * FROM etapas WHERE viaje_id = ? AND estado = 'confirmada' ORDER BY orden, id LIMIT 1",
    viajeId
  );
}

/** El transporte de ida (desde casa) de un viaje, que es de donde cuelgan los vuelos. */
export function transporteDeIda(viajeId) {
  return una(
    'SELECT * FROM transportes WHERE viaje_id = ? AND etapa_origen_id IS NULL ORDER BY id LIMIT 1',
    viajeId
  );
}

/**
 * Recalcula fecha_inicio y fecha_fin de todas las etapas confirmadas.
 *
 * Va encadenando: la primera empieza el día que empieza el viaje, y cada etapa
 * termina tantas noches después. La siguiente arranca el día en que acaba la
 * anterior, porque ese día se viaja: se duerme en la nueva ciudad, no en dos.
 *
 * Las etapas en 'recopilando' se quedan sin fechas a propósito: todavía no
 * ocupan sitio en el calendario.
 */
export function recalcularFechasEtapas(viajeId) {
  const viaje = una('SELECT fecha_inicio, fecha_fin FROM viajes WHERE id = ?', viajeId);
  if (!viaje) return 0;

  ejecutar(
    "UPDATE etapas SET fecha_inicio = NULL, fecha_fin = NULL WHERE viaje_id = ? AND estado <> 'confirmada'",
    viajeId
  );

  const confirmadas = etapasConfirmadas(viajeId);
  if (!confirmadas.length || !viaje.fecha_inicio) return 0;

  let cursor = viaje.fecha_inicio;
  for (const etapa of confirmadas) {
    const fin = sumarDias(cursor, etapa.noches ?? 0);
    ejecutar('UPDATE etapas SET fecha_inicio = ?, fecha_fin = ? WHERE id = ?', cursor, fin, etapa.id);
    cursor = fin;
  }
  return confirmadas.length;
}

/**
 * Mantiene la etapa única de un viaje pegada a lo que dice el viaje.
 *
 * Esto es el puente entre el wizard de hoy (un destino, dos fechas) y el modelo
 * de mañana (una ruta). Mientras el viaje tenga una sola etapa, cambiar el
 * destino cambia el nombre de esa etapa, y cambiar las fechas cambia sus noches.
 * En cuanto haya varias etapas se planta y no toca nada: ahí ya manda la ruta,
 * no el campo `destino`.
 *
 * Devuelve la etapa resultante, o null si el viaje no tiene destino todavía.
 */
export function sincronizarEtapaUnica(viajeId) {
  const viaje = una('SELECT * FROM viajes WHERE id = ?', viajeId);
  if (!viaje?.destino) return null;

  const etapas = etapasDe(viajeId);

  // Más de una etapa: el viaje ya es una ruta de verdad. No es asunto nuestro.
  if (etapas.length > 1) {
    recalcularFechasEtapas(viajeId);
    return etapaPrincipal(viajeId);
  }

  const noches = nochesEntre(viaje.fecha_inicio, viaje.fecha_fin);

  if (!etapas.length) {
    const r = ejecutar(
      `INSERT INTO etapas (viaje_id, nombre_ciudad, orden, noches, fecha_inicio, fecha_fin, estado)
       VALUES (?, ?, 1, ?, ?, ?, 'confirmada')`,
      viajeId,
      viaje.destino,
      noches,
      viaje.fecha_inicio ?? null,
      viaje.fecha_fin ?? null
    );
    asegurarTransportes(viajeId, Number(r.lastInsertRowid));
    return una('SELECT * FROM etapas WHERE id = ?', Number(r.lastInsertRowid));
  }

  const etapa = etapas[0];
  ejecutar(
    `UPDATE etapas SET nombre_ciudad = ?, noches = ?, estado = 'confirmada' WHERE id = ?`,
    viaje.destino,
    noches,
    etapa.id
  );
  asegurarTransportes(viajeId, etapa.id);
  recalcularFechasEtapas(viajeId);
  return una('SELECT * FROM etapas WHERE id = ?', etapa.id);
}

/**
 * Se asegura de que existan las dos patas de casa: la ida y la vuelta.
 * Con una etapa sola, todo viaje es casa -> ciudad -> casa.
 */
function asegurarTransportes(viajeId, etapaId) {
  const ida = una(
    'SELECT id FROM transportes WHERE viaje_id = ? AND etapa_origen_id IS NULL LIMIT 1',
    viajeId
  );
  if (!ida) {
    ejecutar(
      `INSERT INTO transportes (viaje_id, etapa_origen_id, etapa_destino_id, tipo, datos_extra)
       VALUES (?, NULL, ?, 'vuelo', ?)`,
      viajeId,
      etapaId,
      JSON.stringify({ pata: 'ida' })
    );
  }

  const vuelta = una(
    'SELECT id FROM transportes WHERE viaje_id = ? AND etapa_destino_id IS NULL LIMIT 1',
    viajeId
  );
  if (!vuelta) {
    ejecutar(
      `INSERT INTO transportes (viaje_id, etapa_origen_id, etapa_destino_id, tipo, datos_extra)
       VALUES (?, ?, NULL, 'vuelo', ?)`,
      viajeId,
      etapaId,
      JSON.stringify({ pata: 'vuelta' })
    );
  }
}

/** "2026-10-19" + 3 -> "2026-10-22". Al mediodía, para que no muerda el cambio de hora. */
function sumarDias(iso, dias) {
  const d = new Date(`${iso}T12:00:00`);
  d.setDate(d.getDate() + Number(dias || 0));
  return d.toISOString().slice(0, 10);
}
