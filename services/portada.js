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

import { todas, una, ejecutar, nochesEntre } from '../db/index.js';

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
 * Borra un viaje y todo lo suyo.
 *
 * La cascada la hace SQLite: `candidatos`, `etapas`, `transportes`,
 * `itinerario`, `trabajos` y `avisos` referencian `viajes(id)` con
 * `ON DELETE CASCADE`, y las claves ajenas están activadas desde db/index.js.
 * Un solo DELETE se lo lleva todo.
 *
 * Lo que NO se toca, a propósito: `destinos`, `puntos_interes`, `sitios_lugar`
 * y `catalogo_actividades`. Eso es el CATÁLOGO: conocimiento sobre el mundo que
 * vale para el siguiente viaje. Borrar el viaje a Japón no debe borrar lo que
 * sabemos de Japón.
 *
 * Devuelve el recuento de lo que se llevó por delante, para poder decirlo.
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
    trabajos: cuenta('SELECT COUNT(*) AS n FROM trabajos WHERE viaje_id = ?'),
    avisos: cuenta('SELECT COUNT(*) AS n FROM avisos WHERE viaje_id = ?'),
  };

  ejecutar('DELETE FROM viajes WHERE id = ?', viajeId);
  return { nombre: viaje.nombre, arrastre };
}

/** Qué se va a llevar por delante el borrado, para poder avisar antes. */
export function loQueArrastra(viajeId) {
  const viaje = una('SELECT * FROM viajes WHERE id = ?', viajeId);
  if (!viaje) return null;

  return {
    nombre: viaje.nombre,
    etapas: una('SELECT COUNT(*) AS n FROM etapas WHERE viaje_id = ?', viajeId).n,
    apuntados: una(
      "SELECT COUNT(*) AS n FROM candidatos WHERE viaje_id = ? AND tipo IN ('sitio','actividad','comer')",
      viajeId
    ).n,
    enElLienzo: una('SELECT COUNT(*) AS n FROM itinerario WHERE viaje_id = ?', viajeId).n,
  };
}

/** Cambia el nombre del viaje. Sin nombre no se guarda nada. */
export function renombrarViaje(viajeId, nombre) {
  const limpio = String(nombre ?? '').trim().slice(0, 120);
  if (!limpio) return null;
  const r = ejecutar('UPDATE viajes SET nombre = ? WHERE id = ?', limpio, viajeId);
  return r.changes ? limpio : null;
}
