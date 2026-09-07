/**
 * services/ruta.js
 * -----------------------------------------------------------------------------
 * La ruta de un viaje: sus paradas, en orden, con sus noches y sus tramos.
 *
 * TODO lo que cambia la ruta pasa por `recalcularRuta()`. No es manía de
 * ordenado: es que tres cosas dependen unas de otras y tocarlas por separado
 * las descuadra en cuanto te descuidas.
 *
 *   1. El ORDEN tiene que ser 1, 2, 3… sin huecos. Si borras la etapa 2, la 3
 *      pasa a ser la 2, o el número del círculo miente.
 *   2. Las FECHAS son derivadas y van en cascada: la primera empieza cuando
 *      empieza el viaje y cada una arranca donde acabó la anterior. Cambiar una
 *      noche en la primera parada mueve todas las demás.
 *   3. Los TRAMOS de transporte son los huecos ENTRE paradas, más la ida desde
 *      casa y la vuelta. Reordenar cambia qué salto es cuál: el tren de Tokio a
 *      Kioto deja de tener sentido si Kioto pasa a ir antes.
 *
 * Así que se recalcula todo entero después de cada operación. Son tres paradas
 * y media, no hay nada que optimizar.
 */

import { todas, una, ejecutar, db, nochesEntre } from '../db/index.js';
import { ciudadDeCasa } from './proveedores.js';
import { resumenDeTramo } from './etapa.js';
import { distanciaGuardada, comoEtiqueta } from './distancias-ciudades.js';

// Se reexporta para no romper a quien ya la importaba de aquí.
export { ciudadDeCasa };

// =============================================================================
// EL RECÁLCULO
// =============================================================================
/**
 * Deja la ruta de un viaje coherente: orden sin huecos, fechas en cascada y los
 * tramos de transporte que tocan. Se llama después de CUALQUIER cambio.
 */
export function recalcularRuta(viajeId) {
  renumerar(viajeId);
  recalcularFechas(viajeId);
  sincronizarTransportes(viajeId);
}

/** El orden de las confirmadas pasa a ser 1, 2, 3… sin saltos. */
function renumerar(viajeId) {
  const confirmadas = todas(
    "SELECT id FROM etapas WHERE viaje_id = ? AND estado = 'confirmada' ORDER BY orden, id",
    viajeId
  );
  const poner = db.prepare('UPDATE etapas SET orden = ? WHERE id = ?');
  confirmadas.forEach((e, i) => poner.run(i + 1, e.id));

  // Las que están en 'recopilando' van detrás de todas, para que si mañana se
  // confirman no se cuelen en medio.
  const sueltas = todas(
    "SELECT id FROM etapas WHERE viaje_id = ? AND estado <> 'confirmada' ORDER BY orden, id",
    viajeId
  );
  sueltas.forEach((e, i) => poner.run(confirmadas.length + i + 1, e.id));
}

/**
 * Fechas en cascada.
 *
 * La primera parada empieza el día que empieza el viaje. Cada una dura sus
 * noches, y la siguiente arranca el día en que acaba la anterior: ese día se
 * viaja, no se duerme en dos sitios.
 *
 * Sin fechas de viaje no hay nada que calcular y se dejan a null: la pantalla
 * enseña "— → —" y el reparto de noches sigue funcionando igual.
 */
function recalcularFechas(viajeId) {
  const viaje = una('SELECT fecha_inicio FROM viajes WHERE id = ?', viajeId);

  // Las que no están confirmadas nunca llevan fechas: todavía no ocupan sitio.
  ejecutar(
    "UPDATE etapas SET fecha_inicio = NULL, fecha_fin = NULL WHERE viaje_id = ? AND estado <> 'confirmada'",
    viajeId
  );

  const confirmadas = todas(
    "SELECT id, noches FROM etapas WHERE viaje_id = ? AND estado = 'confirmada' ORDER BY orden, id",
    viajeId
  );

  if (!viaje?.fecha_inicio) {
    ejecutar(
      "UPDATE etapas SET fecha_inicio = NULL, fecha_fin = NULL WHERE viaje_id = ? AND estado = 'confirmada'",
      viajeId
    );
    return;
  }

  const poner = db.prepare('UPDATE etapas SET fecha_inicio = ?, fecha_fin = ? WHERE id = ?');
  let cursor = viaje.fecha_inicio;
  for (const etapa of confirmadas) {
    const fin = sumarDias(cursor, etapa.noches ?? 0);
    poner.run(cursor, fin, etapa.id);
    cursor = fin;
  }
}

/**
 * Los tramos que DEBERÍA haber, según cómo está la ruta ahora mismo.
 *
 * Con paradas A, B, C hacen falta cuatro: casa→A, A→B, B→C y C→casa. El nulo
 * en un extremo significa "casa", que es como lo guarda la tabla.
 */
function tramosQueTocan(confirmadas) {
  if (!confirmadas.length) return [];

  const tramos = [{ origen: null, destino: confirmadas[0].id }];
  for (let i = 0; i < confirmadas.length - 1; i++) {
    tramos.push({ origen: confirmadas[i].id, destino: confirmadas[i + 1].id });
  }
  tramos.push({ origen: confirmadas.at(-1).id, destino: null });
  return tramos;
}

/**
 * Ajusta la tabla `transportes` a la ruta actual: crea los tramos que faltan y
 * borra los que ya no existen.
 *
 * Lo importante es que un tramo que SIGUE existiendo no se toca, para no perder
 * el transporte que ya se hubiera elegido: si mueves Osaka al final, el tren de
 * Tokio a Kioto sigue siendo el mismo salto y conserva su elección.
 */
function sincronizarTransportes(viajeId) {
  const confirmadas = todas(
    "SELECT id FROM etapas WHERE viaje_id = ? AND estado = 'confirmada' ORDER BY orden, id",
    viajeId
  );
  const quieren = tramosQueTocan(confirmadas);
  const clave = (t) => `${t.origen ?? 'casa'}>${t.destino ?? 'casa'}`;
  const querido = new Set(quieren.map(clave));

  const actuales = todas('SELECT * FROM transportes WHERE viaje_id = ?', viajeId);
  const hay = new Map(
    actuales.map((t) => [clave({ origen: t.etapa_origen_id, destino: t.etapa_destino_id }), t])
  );

  let creados = 0;
  let borrados = 0;

  db.exec('BEGIN');
  try {
    for (const t of actuales) {
      const k = clave({ origen: t.etapa_origen_id, destino: t.etapa_destino_id });
      if (!querido.has(k)) {
        ejecutar('DELETE FROM transportes WHERE id = ?', t.id);
        borrados++;
      }
    }

    for (const t of quieren) {
      if (hay.has(clave(t))) continue;
      ejecutar(
        `INSERT INTO transportes (viaje_id, etapa_origen_id, etapa_destino_id, tipo, datos_extra)
         VALUES (?, ?, ?, ?, ?)`,
        viajeId,
        t.origen,
        t.destino,
        // Desde y hacia casa se vuela; entre paradas de un mismo país casi
        // nunca, así que el tipo por defecto no es el mismo.
        t.origen === null || t.destino === null ? 'vuelo' : 'tren',
        JSON.stringify({ pata: t.origen === null ? 'ida' : t.destino === null ? 'vuelta' : 'salto' })
      );
      creados++;
    }
    db.exec('COMMIT');
  } catch (err) {
    db.exec('ROLLBACK');
    throw err;
  }

  return { creados, borrados };
}

// =============================================================================
// LEER LA RUTA
// =============================================================================
/**
 * Todo lo que necesita la pantalla, en un objeto. Es el mismo que devuelven los
 * endpoints después de cada cambio, para que el cliente repinte sin recargar.
 */
export function rutaDeViaje(viajeId) {
  const viaje = una('SELECT * FROM viajes WHERE id = ?', viajeId);
  if (!viaje) return null;

  const confirmadas = todas(
    "SELECT * FROM etapas WHERE viaje_id = ? AND estado = 'confirmada' ORDER BY orden, id",
    viajeId
  );
  const candidatas = todas(
    "SELECT * FROM etapas WHERE viaje_id = ? AND estado = 'recopilando' ORDER BY orden, id",
    viajeId
  );

  const totales = nochesEntre(viaje.fecha_inicio, viaje.fecha_fin);
  const usadas = confirmadas.reduce((suma, e) => suma + (e.noches ?? 0), 0);

  return {
    viaje: {
      id: viaje.id,
      nombre: viaje.nombre,
      ambito: viaje.destino,
      fechaInicio: viaje.fecha_inicio,
      fechaFin: viaje.fecha_fin,
    },
    noches: {
      usadas,
      totales,
      // Con qué cara se enseña el contador. 'sin_fechas' no es un error: es un
      // viaje al que todavía no se le han puesto fechas, y repartir noches
      // sigue teniendo sentido.
      estado: !viaje.fecha_inicio || !viaje.fecha_fin
        ? 'sin_fechas'
        : usadas > totales
          ? 'exceso'
          : usadas === totales
            ? 'exacto'
            : 'faltan',
      diferencia: Math.abs(totales - usadas),
    },
    candidatos: candidatas.map((e) => ({ id: e.id, nombre: e.nombre_ciudad })),
    etapas: confirmadas.map((e) => ({
      id: e.id,
      nombre: e.nombre_ciudad,
      orden: e.orden,
      noches: e.noches ?? 0,
      fechaInicio: e.fecha_inicio,
      fechaFin: e.fecha_fin,
      puntoInteresId: e.punto_interes_id,
    })),
    tramos: tramosParaPintar(viajeId, confirmadas),
    casa: ciudadDeCasa(),
  };
}

/**
 * Los tramos con el texto ya escrito, que es lo que pinta el chip.
 *
 * El texto depende de dónde esté el tramo: los extremos hablan de casa y llevan
 * el nombre del sitio del que se sale o al que se vuelve; los de en medio
 * preguntan directamente cómo se va de una parada a la siguiente.
 */
/** La distancia guardada entre dos ciudades del catálogo, en la forma que
 *  esperan los textos. Null si todavía no se ha calculado. */
function refDeCiudades(a, b) {
  const g = distanciaGuardada(a, b);
  return g ? { km: g.km, minutos: g.minutos_coche, fuente: g.fuente } : null;
}

function tramosParaPintar(viajeId, confirmadas) {
  if (!confirmadas.length) return [];

  const casa = ciudadDeCasa();
  const porId = new Map(confirmadas.map((e) => [e.id, e]));
  const filas = todas('SELECT * FROM transportes WHERE viaje_id = ?', viajeId);

  return filas
    .map((t) => {
      const origen = t.etapa_origen_id ? porId.get(t.etapa_origen_id) : null;
      const destino = t.etapa_destino_id ? porId.get(t.etapa_destino_id) : null;

      // Un tramo que apunta a una etapa que ya no está es basura de un recálculo
      // a medias: se ignora en vez de pintar "undefined".
      if (t.etapa_origen_id && !origen) return null;
      if (t.etapa_destino_id && !destino) return null;

      const elegido = t.candidato_id
        ? una('SELECT titulo FROM candidatos WHERE id = ?', t.candidato_id)
        : null;

      const donde = !origen ? 'ida' : !destino ? 'vuelta' : 'salto';

      // El texto lo escribe la MISMA función que usa la pantalla de etapa: si
      // el chip y la etapa contaran el tramo con palabras distintas, cualquiera
      // pensaría que son dos cosas.
      const texto = resumenDeTramo(
        t,
        origen?.nombre_ciudad ?? casa,
        destino?.nombre_ciudad ?? casa,
        donde,
        elegido,
        casa
      );

      return {
        id: t.id,
        donde,
        // Para colocarlo: va justo DESPUÉS de esta etapa (o al principio de todo
        // si es la ida).
        despuesDe: origen?.id ?? null,
        antesDe: destino?.id ?? null,
        tipo: t.tipo,
        resuelto: Boolean(t.candidato_id || t.notas),
        texto,
        // Los km y el tiempo de coche del salto, de la caché de ciudades. Solo
        // en los saltos de en medio: en la ida y la vuelta se vuela, y poner
        // "1.400 km · 14 h en coche" al lado de un vuelo no informa de nada.
        km: donde === 'salto' && origen?.punto_interes_id && destino?.punto_interes_id
          ? comoEtiqueta(refDeCiudades(origen.punto_interes_id, destino.punto_interes_id))
          : null,
      };
    })
    .filter(Boolean)
    .sort((a, b) => posicion(a, confirmadas) - posicion(b, confirmadas));
}

/** Dónde va cada tramo en la lista: la ida la primera, la vuelta la última. */
function posicion(tramo, confirmadas) {
  if (tramo.donde === 'ida') return -1;
  if (tramo.donde === 'vuelta') return confirmadas.length;
  return confirmadas.findIndex((e) => e.id === tramo.despuesDe);
}

// =============================================================================
// OPERACIONES
// =============================================================================
/** Un candidato pasa a la ruta: al final, con una noche para empezar. */
export function confirmarEtapa(etapaId) {
  const etapa = una('SELECT * FROM etapas WHERE id = ?', etapaId);
  if (!etapa) return null;

  const ultimo = una(
    "SELECT MAX(orden) AS n FROM etapas WHERE viaje_id = ? AND estado = 'confirmada'",
    etapa.viaje_id
  );

  ejecutar(
    "UPDATE etapas SET estado = 'confirmada', orden = ?, noches = MAX(noches, 1) WHERE id = ?",
    (ultimo?.n ?? 0) + 1,
    etapaId
  );

  recalcularRuta(etapa.viaje_id);
  return etapa.viaje_id;
}

/**
 * Clona una etapa al final de la ruta.
 *
 * EL CASO QUE LO PIDE: Barcelona → Sarajevo → Mostar, pero el vuelo de vuelta
 * sale de Sarajevo. La ruta de verdad es Sarajevo → Mostar → Sarajevo, y esa
 * segunda parada en Sarajevo suele ser de cero noches: se pasa por allí a coger
 * el avión.
 *
 * QUÉ SE COPIA Y QUÉ NO. Se copia el enganche al CATÁLOGO —el destino y, si lo
 * tiene, el punto— y nada más. Por eso la clonada nace con sus sitios y sus
 * excursiones ya investigados, sin repetir una sola búsqueda: eso es
 * conocimiento sobre la ciudad, no sobre el viaje.
 *
 * No se copia NADA del viaje: ni hotel elegido, ni transporte, ni lo apuntado,
 * ni lo colocado en el lienzo, ni las cotizaciones. Volver a pasar por Sarajevo
 * no significa dormir otra vez en el mismo hotel ni repetir el free tour.
 *
 * Las dos son etapas independientes: borrar una no toca a la otra, y el
 * catálogo que comparten no se duplica ni se toca.
 */
export function clonarEtapa(etapaId) {
  const etapa = una('SELECT * FROM etapas WHERE id = ?', etapaId);
  if (!etapa) return null;

  const ultimo = una(
    "SELECT MAX(orden) AS n FROM etapas WHERE viaje_id = ? AND estado = 'confirmada'",
    etapa.viaje_id
  );

  const r = ejecutar(
    `INSERT INTO etapas
       (viaje_id, destino_id, punto_interes_id, nombre_ciudad, orden, noches, estado)
     VALUES (?, ?, ?, ?, ?, 0, 'confirmada')`,
    etapa.viaje_id,
    etapa.destino_id,
    etapa.punto_interes_id,
    etapa.nombre_ciudad,
    (ultimo?.n ?? 0) + 1
  );

  // El recálculo crea los tramos que ahora hacen falta: el salto desde la
  // parada anterior y la vuelta a casa, que pasa a salir de esta.
  recalcularRuta(etapa.viaje_id);

  console.log(
    `[ruta] Viaje #${etapa.viaje_id}: «${etapa.nombre_ciudad}» clonada al final de la ruta (0 noches).`
  );
  return { viajeId: etapa.viaje_id, etapaId: Number(r.lastInsertRowid) };
}

/** Fuera una etapa, esté confirmada o no. Sus tramos se van con ella. */
export function quitarEtapa(etapaId) {
  const etapa = una('SELECT * FROM etapas WHERE id = ?', etapaId);
  if (!etapa) return null;

  // Los transportes referencian la etapa con ON DELETE CASCADE, así que se van
  // solos; el recálculo de después crea los que hagan falta para la ruta nueva.
  ejecutar('DELETE FROM etapas WHERE id = ?', etapaId);

  recalcularRuta(etapa.viaje_id);
  return etapa.viaje_id;
}

/**
 * Una noche más o una menos.
 *
 * El suelo es CERO, no uno. Antes era uno —"una parada de cero noches no es una
 * parada"—, y para el caso normal está bien; pero una parada de paso, esa por la
 * que se cruza para coger el avión de vuelta, existe y no se duerme en ella. Es
 * exactamente lo que crea "Clonar", y tenía que poder volver a cero después de
 * haberle puesto una noche por error.
 */
export function cambiarNoches(etapaId, delta) {
  const etapa = una('SELECT * FROM etapas WHERE id = ?', etapaId);
  if (!etapa) return null;

  const nuevas = Math.max(0, (etapa.noches ?? 0) + (Number(delta) || 0));
  ejecutar('UPDATE etapas SET noches = ? WHERE id = ?', nuevas, etapaId);

  recalcularRuta(etapa.viaje_id);
  return etapa.viaje_id;
}

/**
 * Nuevo orden de las paradas, tal y como han quedado tras arrastrar.
 *
 * Solo se hace caso de los ids que de verdad son etapas confirmadas de ESTE
 * viaje: lo que llega del navegador no se cree sin comprobar.
 */
export function reordenar(viajeId, ordenIds) {
  const validos = new Set(
    todas(
      "SELECT id FROM etapas WHERE viaje_id = ? AND estado = 'confirmada'",
      viajeId
    ).map((e) => e.id)
  );

  const limpio = (Array.isArray(ordenIds) ? ordenIds : [])
    .map(Number)
    .filter((id) => validos.has(id));

  // Si faltara alguna (por una petición a medias), va al final en el orden que
  // tuviera, en vez de quedarse sin número.
  for (const id of validos) if (!limpio.includes(id)) limpio.push(id);

  const poner = db.prepare('UPDATE etapas SET orden = ? WHERE id = ?');
  limpio.forEach((id, i) => poner.run(i + 1, id));

  recalcularRuta(viajeId);
  return limpio.length;
}

/** "2026-10-19" + 3 -> "2026-10-22". Al mediodía, para que no muerda el cambio de hora. */
function sumarDias(iso, dias) {
  const d = new Date(`${iso}T12:00:00`);
  d.setDate(d.getDate() + Number(dias || 0));
  return d.toISOString().slice(0, 10);
}
