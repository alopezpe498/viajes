/**
 * services/portada.js
 * -----------------------------------------------------------------------------
 * Lo que se ve en la home: cada viaje como un billete.
 *
 * Un billete no enseña el viaje crudo, enseña en qué punto está: por dónde pasa
 * la ruta, cuántas noches hay repartidas y si cuadran con las del viaje. Eso son
 * datos de tres tablas, y sacarlos con una consulta por viaje sería una consulta
 * por billete. Así que van dos: los viajes y TODAS sus etapas de una vez, y el
 * cruce se hace en memoria.
 */

import { todas, una, ejecutar, db, normalizarNombre, nochesEntre } from '../db/index.js';

const MESES_LARGOS = [
  'enero', 'febrero', 'marzo', 'abril', 'mayo', 'junio',
  'julio', 'agosto', 'septiembre', 'octubre', 'noviembre', 'diciembre',
];

/** "2027-04-12" -> { mes: "Abril", dia: "12" } para el talón del billete. */
function talonDe(iso) {
  if (!iso) return null;
  const [, m, d] = iso.split('-').map(Number);
  const mes = MESES_LARGOS[m - 1];
  return { mes: mes.charAt(0).toUpperCase() + mes.slice(1), dia: String(d) };
}

/** "2027-04-12" -> "12 de abril". */
function enLargo(iso) {
  if (!iso) return null;
  const [, m, d] = iso.split('-').map(Number);
  return `${d} de ${MESES_LARGOS[m - 1]}`;
}

/** Hoy en YYYY-MM-DD, para saber qué salida está por delante. */
const hoy = () => new Date().toISOString().slice(0, 10);

/**
 * Los billetes y los dos datos del panel lateral.
 */
export function datosDePortada() {
  const viajes = todas('SELECT * FROM viajes ORDER BY creado_en DESC, id DESC');

  // Todas las etapas confirmadas de todos los viajes, de un tirón.
  const etapas = todas(
    `SELECT viaje_id, nombre_ciudad, noches, orden
       FROM etapas
      WHERE estado = 'confirmada'
      ORDER BY viaje_id, orden, id`
  );
  const porViaje = new Map();
  for (const e of etapas) {
    if (!porViaje.has(e.viaje_id)) porViaje.set(e.viaje_id, []);
    porViaje.get(e.viaje_id).push(e);
  }

  const billetes = viajes.map((v) => {
    const suyas = porViaje.get(v.id) ?? [];
    const repartidas = suyas.reduce((suma, e) => suma + (e.noches ?? 0), 0);
    const totales = nochesEntre(v.fecha_inicio, v.fecha_fin);

    return {
      id: v.id,
      nombre: v.nombre,
      talon: talonDe(v.fecha_inicio),
      ciudades: suyas.map((e) => e.nombre_ciudad),
      etapas: suyas.length,
      nochesRepartidas: repartidas,
      nochesTotales: totales,
      // El chip de estado solo tiene sentido si el viaje tiene fechas: sin
      // ellas no hay nada con lo que cuadrar.
      estado: !v.fecha_inicio || !v.fecha_fin
        ? null
        : repartidas === totales && totales > 0
          ? 'cuadra'
          : 'faltan',
      faltan: Math.max(0, totales - repartidas),
      sobran: Math.max(0, repartidas - totales),
    };
  });

  // La próxima salida: la fecha de inicio futura más cercana.
  const proxima = una(
    `SELECT MIN(fecha_inicio) AS f FROM viajes
      WHERE fecha_inicio IS NOT NULL AND fecha_inicio >= ?`,
    hoy()
  )?.f;

  return {
    billetes,
    total: viajes.length,
    proximaSalida: enLargo(proxima),
  };
}

/**
 * BORRA UN VIAJE Y TODO LO QUE ESE VIAJE GENERÓ.
 *
 * Antes esto se quedaba a medias, y a propósito: se borraba el viaje —con sus
 * etapas, candidatos, lienzo, traslados y adjuntos, que caen solos por las
 * claves ajenas— y se dejaba intacto el CATÁLOGO, con el argumento de que
 * borrar el viaje a Japón no debe borrar lo que sabemos de Japón.
 *
 * El argumento sigue siendo bueno cuando hay más viajes. Deja de serlo cuando
 * el catálogo de esa ciudad lo trajo ESTE viaje y no lo usa nadie más: entonces
 * no es conocimiento compartido, es el rastro de una prueba. Y repetir esa
 * prueba desde cero era imposible, porque la segunda vez todo salía de la
 * caché y no se volvía a buscar nada.
 *
 * Así que ahora se limpia también lo que quede huérfano, y SOLO lo huérfano:
 *
 *   - Restaurantes, transporte urbano, excursiones y tramos de las ciudades
 *     que ya no visita ningún viaje.
 *   - Las ciudades investigadas y sus sitios, si su destino no lo usa nadie.
 *   - Las direcciones que apuntaban a algo que ya no existe.
 *
 * Si otro viaje pisa la misma ciudad, no se toca nada de ella. Es la diferencia
 * entre limpiar y romper.
 */
export function borrarViaje(viajeId) {
  const viaje = una('SELECT * FROM viajes WHERE id = ?', viajeId);
  if (!viaje) return null;

  const cuenta = (sql) => una(sql, viajeId)?.n ?? 0;
  const arrastre = {
    etapas: cuenta('SELECT COUNT(*) AS n FROM etapas WHERE viaje_id = ?'),
    candidatos: cuenta('SELECT COUNT(*) AS n FROM candidatos WHERE viaje_id = ?'),
    itinerario: cuenta('SELECT COUNT(*) AS n FROM itinerario WHERE viaje_id = ?'),
    transportes: cuenta('SELECT COUNT(*) AS n FROM transportes WHERE viaje_id = ?'),
    traslados: cuenta('SELECT COUNT(*) AS n FROM traslados WHERE viaje_id = ?'),
    adjuntos: cuenta('SELECT COUNT(*) AS n FROM adjuntos WHERE viaje_id = ?'),
    trabajos: cuenta('SELECT COUNT(*) AS n FROM trabajos WHERE viaje_id = ?'),
    avisos: cuenta('SELECT COUNT(*) AS n FROM avisos WHERE viaje_id = ?'),
  };

  // Lo que tocaba este viaje, APUNTADO ANTES de borrarlo: después ya no hay de
  // dónde sacarlo.
  const ciudades = todas(
    'SELECT DISTINCT nombre_ciudad FROM etapas WHERE viaje_id = ? AND nombre_ciudad IS NOT NULL',
    viajeId
  ).map((e) => e.nombre_ciudad);

  const destinoIds = todas(
    'SELECT DISTINCT destino_id FROM etapas WHERE viaje_id = ? AND destino_id IS NOT NULL',
    viajeId
  ).map((e) => e.destino_id);

  // El destino del viaje se guarda por nombre, no por id: se busca su fila.
  const delNombre = viaje.destino
    ? una('SELECT id FROM destinos WHERE nombre_norm = ?', normalizarNombre(viaje.destino))
    : null;
  if (delNombre && !destinoIds.includes(delNombre.id)) destinoIds.push(delNombre.id);

  db.exec('BEGIN');
  try {
    ejecutar('DELETE FROM viajes WHERE id = ?', viajeId);
    Object.assign(arrastre, limpiarLoHuerfano(ciudades, destinoIds));
    db.exec('COMMIT');
  } catch (err) {
    db.exec('ROLLBACK');
    throw err;
  }

  return { nombre: viaje.nombre, arrastre };
}

/**
 * La limpieza de después: lo que se ha quedado sin dueño.
 *
 * Se llama con el viaje YA borrado, así que cualquier etapa que siga
 * apareciendo es de otro viaje y manda: esa ciudad no se toca.
 */
function limpiarLoHuerfano(ciudades, destinoIds) {
  const hecho = {
    comer: 0,
    movilidad: 0,
    excursiones: 0,
    tramos: 0,
    ciudadesInvestigadas: 0,
    destinos: 0,
    direcciones: 0,
  };

  for (const ciudad of ciudades) {
    const norm = normalizarNombre(ciudad);

    // ¿La visita algún otro viaje? Entonces su catálogo es de los dos.
    const laUsaOtro = una(
      'SELECT 1 AS s FROM etapas WHERE nombre_ciudad = ? LIMIT 1',
      ciudad
    );
    if (laUsaOtro) continue;

    hecho.comer += ejecutar('DELETE FROM catalogo_comer WHERE ciudad_norm = ?', norm).changes;
    hecho.movilidad += ejecutar('DELETE FROM catalogo_movilidad WHERE ciudad_norm = ?', norm).changes;
    hecho.excursiones += ejecutar(
      'DELETE FROM catalogo_actividades WHERE ciudad_norm = ?',
      norm
    ).changes;
    // Los tramos entre ciudades tienen dos extremos: basta con que sobre uno.
    hecho.tramos += ejecutar(
      'DELETE FROM catalogo_transporte_tramo WHERE ciudad_a_norm = ? OR ciudad_b_norm = ?',
      norm,
      norm
    ).changes;
  }

  for (const destinoId of destinoIds) {
    // ¿Queda alguna etapa de otro viaje colgando de este destino, o algún viaje
    // que lo tenga por destino? Si es que sí, se queda entero.
    const enEtapas = una('SELECT 1 AS s FROM etapas WHERE destino_id = ? LIMIT 1', destinoId);
    if (enEtapas) continue;

    const destino = una('SELECT * FROM destinos WHERE id = ?', destinoId);
    if (!destino) continue;

    const enViajes = una(
      'SELECT 1 AS s FROM viajes WHERE destino IS NOT NULL AND lower(destino) = lower(?) LIMIT 1',
      destino.nombre
    );
    if (enViajes) continue;

    // Las ciudades investigadas cuelgan del destino, y de ellas cuelgan sus
    // sitios y sus distancias: se van solas por las claves ajenas.
    hecho.ciudadesInvestigadas += ejecutar(
      'DELETE FROM puntos_interes WHERE destino_id = ?',
      destinoId
    ).changes;
    hecho.destinos += ejecutar('DELETE FROM destinos WHERE id = ?', destinoId).changes;
  }

  hecho.direcciones = limpiarDireccionesHuerfanas();
  return hecho;
}

/**
 * Direcciones que apuntan a algo que ya no existe.
 *
 * `direcciones` no tiene clave ajena —guarda (tipo, id) contra seis tablas
 * distintas, y SQLite no sabe hacer eso—, así que aquí no limpia nadie. Sin
 * esto se van acumulando filas fantasma que además pueden colarse en un
 * autocompletado.
 */
function limpiarDireccionesHuerfanas() {
  const TABLAS = {
    hotel: 'candidatos',
    punto: 'puntos_interes',
    sitio: 'sitios_lugar',
    actividad: 'catalogo_actividades',
    movilidad: 'catalogo_movilidad',
    comer: 'catalogo_comer',
  };

  let n = 0;
  for (const [tipo, tabla] of Object.entries(TABLAS)) {
    n += ejecutar(
      `DELETE FROM direcciones
        WHERE tipo_elemento = ?
          AND elemento_id NOT IN (SELECT id FROM ${tabla})`,
      tipo
    ).changes;
  }
  return n;
}

/** Qué se va a llevar por delante el borrado, para poder avisar antes. */
export function loQueArrastra(viajeId) {
  const viaje = una('SELECT * FROM viajes WHERE id = ?', viajeId);
  if (!viaje) return null;

  // Y QUÉ CIUDADES SE QUEDAN SIN CATÁLOGO. Son las que no visita ningún otro
  // viaje: al irse este, su caché de restaurantes, excursiones y transporte no
  // le sirve ya a nadie. Se cuenta antes para poder decirlo en el aviso, que
  // borrar sin saber qué se borra es lo que da miedo.
  const ciudades = todas(
    'SELECT DISTINCT nombre_ciudad FROM etapas WHERE viaje_id = ? AND nombre_ciudad IS NOT NULL',
    viajeId
  ).map((e) => e.nombre_ciudad);

  const soloDeEsteViaje = ciudades.filter(
    (c) => !una(
      'SELECT 1 AS s FROM etapas WHERE nombre_ciudad = ? AND viaje_id <> ? LIMIT 1',
      c,
      viajeId
    )
  );

  const enCatalogo = soloDeEsteViaje.reduce(
    (suma, ciudad) => {
      const norm = normalizarNombre(ciudad);
      return {
        comer: suma.comer +
          una('SELECT COUNT(*) AS n FROM catalogo_comer WHERE ciudad_norm = ?', norm).n,
        excursiones: suma.excursiones +
          una('SELECT COUNT(*) AS n FROM catalogo_actividades WHERE ciudad_norm = ?', norm).n,
        movilidad: suma.movilidad +
          una('SELECT COUNT(*) AS n FROM catalogo_movilidad WHERE ciudad_norm = ?', norm).n,
      };
    },
    { comer: 0, excursiones: 0, movilidad: 0 }
  );

  return {
    nombre: viaje.nombre,
    etapas: una('SELECT COUNT(*) AS n FROM etapas WHERE viaje_id = ?', viajeId).n,
    apuntados: una(
      "SELECT COUNT(*) AS n FROM candidatos WHERE viaje_id = ? AND tipo IN ('sitio','actividad','comer')",
      viajeId
    ).n,
    enElLienzo: una('SELECT COUNT(*) AS n FROM itinerario WHERE viaje_id = ?', viajeId).n,
    traslados: una('SELECT COUNT(*) AS n FROM traslados WHERE viaje_id = ?', viajeId).n,
    ciudadesQueSeLimpian: soloDeEsteViaje,
    enCatalogo,
  };
}

/** Cambia el nombre del viaje. Sin nombre no se guarda nada. */
export function renombrarViaje(viajeId, nombre) {
  const limpio = String(nombre ?? '').trim().slice(0, 120);
  if (!limpio) return null;
  const r = ejecutar('UPDATE viajes SET nombre = ? WHERE id = ?', limpio, viajeId);
  return r.changes ? limpio : null;
}
