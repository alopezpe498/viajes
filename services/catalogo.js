/**
 * services/catalogo.js
 * -----------------------------------------------------------------------------
 * El CATÁLOGO: lo que sabemos del mundo, al margen de ningún viaje.
 *
 * La diferencia con `services/proveedores.js` es de fondo, no de forma:
 *   - proveedores.js responde "¿qué hoteles hay para MI viaje del 19 al 22?"
 *   - catalogo.js responde   "¿qué se puede ver en Lisboa?"
 *
 * Lo segundo no caduca con el viaje. Por eso nada de aquí lleva viaje_id ni
 * fechas, y por eso la caché de actividades de Civitatis cuelga de la CIUDAD:
 * el próximo viaje a Lisboa se aprovecha del scrapeo del anterior.
 *
 * De momento solo se usa la parte de actividades. Las de destinos y puntos de
 * interés están listas para cuando llegue la pantalla que los investigue.
 */

import { todas, una, ejecutar, db, normalizarNombre } from '../db/index.js';

export { normalizarNombre };

// =============================================================================
// DESTINOS
// =============================================================================
/**
 * Busca un destino por nombre, sin importar acentos ni mayúsculas.
 *
 * A propósito NO filtra por tipo. Cuando alguien escribe "Japón" en el wizard
 * no dice si es país, región o ciudad: eso lo decide la IA después. Si aquí
 * filtrásemos por tipo, el "Japón" que se creó como país no se encontraría al
 * volver a buscarlo, y acabaríamos con dos.
 */
export function destinoPorNombre(nombre) {
  return una(
    'SELECT * FROM destinos WHERE nombre_norm = ? ORDER BY id LIMIT 1',
    normalizarNombre(nombre)
  );
}

/**
 * Crea el destino si no estaba, y devuelve el que haya.
 *
 * Se crea con `investigado_en` a null, que es lo que significa "está en el
 * catálogo pero todavía no sabemos nada de él". La pantalla de descubrir
 * necesita que la fila exista desde el primer momento para tener un id al que
 * ir mientras la IA piensa.
 */
export function asegurarDestino(nombre, { tipo = 'pais', pais = null, lat = null, lon = null } = {}) {
  const existente = destinoPorNombre(nombre);
  if (existente) return existente;

  const r = ejecutar(
    `INSERT INTO destinos (nombre, nombre_norm, tipo, pais, lat, lon) VALUES (?, ?, ?, ?, ?, ?)`,
    nombre,
    normalizarNombre(nombre),
    tipo,
    pais,
    lat,
    lon
  );
  return una('SELECT * FROM destinos WHERE id = ?', Number(r.lastInsertRowid));
}

/** Los imprescindibles de un destino, en el orden en que se quieren enseñar. */
export function puntosDe(destinoId) {
  return todas(
    'SELECT * FROM puntos_interes WHERE destino_id = ? ORDER BY orden, id',
    destinoId
  );
}

/** La ficha profunda de un punto: sus templos, barrios y mercados. */
export function sitiosDe(puntoInteresId) {
  return todas(
    'SELECT * FROM sitios_lugar WHERE punto_interes_id = ? ORDER BY orden, id',
    puntoInteresId
  );
}

// =============================================================================
// CACHÉ DE ACTIVIDADES (Civitatis), por ciudad
// =============================================================================
/**
 * Lo que el catálogo sabe de una ciudad. Ordenado como se pinta: primero lo
 * mejor valorado, y lo que no tiene nota al final.
 */
export function actividadesDeCiudad(ciudad) {
  return todas(
    `SELECT * FROM catalogo_actividades
      WHERE ciudad_norm = ?
      ORDER BY (valoracion IS NULL), valoracion DESC, id ASC`,
    normalizarNombre(ciudad)
  );
}

/** Cuántas actividades hay guardadas de una ciudad y de cuándo son. */
export function estadoCacheCiudad(ciudad) {
  const fila = una(
    'SELECT COUNT(*) AS total, MAX(visto_en) AS visto_en FROM catalogo_actividades WHERE ciudad_norm = ?',
    normalizarNombre(ciudad)
  );
  return { total: fila?.total ?? 0, vistoEn: fila?.visto_en ?? null };
}

/**
 * Guarda en el catálogo lo que acaba de traer Civitatis.
 *
 * Es un "upsert": si la actividad ya estaba se le refrescan precio y valoración
 * y se le actualiza `visto_en`; si es nueva, entra. La clave es la url (y el
 * título como respaldo cuando no hay url), que es el mismo criterio con el que
 * el worker evita duplicados dentro de un viaje.
 *
 * Devuelve cuántas filas se han tocado. No lanza: si el catálogo fallara, el
 * viaje tiene que seguir funcionando igual, porque esto es una caché y no la
 * fuente de la verdad de la pantalla.
 */
export function guardarActividadesEnCatalogo(ciudad, actividades) {
  if (!ciudad || !actividades?.length) return 0;

  const ciudadNorm = normalizarNombre(ciudad);
  const sentencia = db.prepare(
    `INSERT INTO catalogo_actividades
       (ciudad, ciudad_norm, clave_unica, titulo, precio, moneda, duracion,
        valoracion, num_opiniones, url, imagen_url, origen_datos, datos_extra, visto_en)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'civitatis', ?, datetime('now'))
     ON CONFLICT (ciudad_norm, clave_unica) DO UPDATE SET
       titulo        = excluded.titulo,
       precio        = excluded.precio,
       moneda        = excluded.moneda,
       duracion      = excluded.duracion,
       valoracion    = excluded.valoracion,
       num_opiniones = excluded.num_opiniones,
       imagen_url    = excluded.imagen_url,
       datos_extra   = excluded.datos_extra,
       visto_en      = datetime('now')`
  );

  let tocadas = 0;
  try {
    db.exec('BEGIN');
    for (const a of actividades) {
      sentencia.run(
        ciudad,
        ciudadNorm,
        a.url || `titulo:${a.titulo}`,
        a.titulo ?? '(sin título)',
        a.precio ?? null,
        a.moneda ?? null,
        a.duracion ?? null,
        a.valoracion ?? null,
        a.numOpiniones ?? null,
        a.url ?? null,
        a.imagenUrl ?? null,
        JSON.stringify({ precioTexto: a.precioTexto ?? null })
      );
      tocadas++;
    }
    db.exec('COMMIT');
  } catch (err) {
    try { db.exec('ROLLBACK'); } catch { /* ya estaba cerrada */ }
    console.warn('[catalogo] No se pudo guardar la caché de actividades:', err.message);
    return 0;
  }
  return tocadas;
}
/**
 * =============================================================================
 * LA FICHA COMPLETA DE UNA EXCURSION
 * =============================================================================
 * Va en el CATALOGO, no en el viaje, y esa es toda la idea: lo que incluye el
 * free tour de Lisboa o donde se queda uno para empezarlo no cambia porque yo
 * viaje en marzo o en octubre. Se busca UNA vez, cuando alguien pulsa "Ver
 * detalles" de esa excursion, y se queda para siempre y para todos los viajes.
 *
 * `detalles_en` es la marca de "esto ya se buscó". Sin ella no se distinguiria
 * una ficha que no tiene punto de encuentro (una entrada de museo, que no lo
 * tiene) de una que no se ha pedido nunca.
 */

/** Una actividad del catálogo por su id. */
export function actividadPorId(id) {
  return una('SELECT * FROM catalogo_actividades WHERE id = ?', Number(id));
}

/**
 * Guarda la ficha que acaba de traer el provider.
 *
 * Lo que venga vacío se guarda como NULL sin más: que una ficha no tenga
 * horarios no es un fallo, es que Civitatis no los publica ahí.
 */
export function guardarFichaActividad(id, ficha) {
  const texto = (v) => {
    const t = String(v ?? '').trim();
    return t || null;
  };

  ejecutar(
    `UPDATE catalogo_actividades
        SET descripcion_larga = ?, duracion_detalle = ?, idiomas = ?, horarios = ?,
            incluye = ?, no_incluye = ?, punto_encuentro = ?, cancelacion = ?,
            detalles_extra = ?, detalles_en = datetime('now')
      WHERE id = ?`,
    texto(ficha.descripcion),
    texto(ficha.duracion),
    texto(ficha.idiomas),
    texto(ficha.horarios),
    texto(ficha.incluye),
    texto(ficha.noIncluye),
    texto(ficha.puntoEncuentro),
    texto(ficha.cancelacion),
    ficha.extra ? JSON.stringify(ficha.extra) : null,
    Number(id)
  );

  return actividadPorId(id);
}

/**
 * La ficha de una actividad, lista para pintar.
 *
 * Devuelve `null` si todavía no se ha buscado, para que la pantalla sepa que
 * tiene que ofrecer el botón en vez de una ficha vacía.
 */
export function fichaDeActividad(id) {
  return fichaDeFila(actividadPorId(id));
}

/**
 * Lo mismo, pero a partir de una fila que ya se tiene en la mano.
 *
 * La pantalla de la etapa lee las excursiones de una ciudad con un solo
 * `SELECT *`, así que ya trae las columnas de la ficha dentro. Volver a
 * consultarlas una por una serían veintiocho consultas para nada.
 */
export function fichaDeFila(a) {
  if (!a || !a.detalles_en) return null;

  let extra = null;
  try {
    extra = a.detalles_extra ? JSON.parse(a.detalles_extra) : null;
  } catch {
    extra = null; // JSON corrupto: se enseña el resto y ya está
  }

  return {
    descripcion: a.descripcion_larga,
    duracion: a.duracion_detalle,
    idiomas: a.idiomas,
    horarios: a.horarios,
    incluye: a.incluye,
    noIncluye: a.no_incluye,
    puntoEncuentro: a.punto_encuentro,
    cancelacion: a.cancelacion,
    extra,
    buscadaEn: a.detalles_en,
  };
}
