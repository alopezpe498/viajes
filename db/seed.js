/**
 * db/seed.js
 * -----------------------------------------------------------------------------
 * Datos de ejemplo para poder recorrer el wizard entero sin haber conectado
 * todavia los providers de scraping.
 *
 * IMPORTANTE: TODO lo que hay aqui es FALSO. Estan calcados en forma y en rangos
 * de lo que devuelven de verdad providers/civitatis.js, vueling.js y booking.js
 * (mismos campos, mismas escalas de valoracion, mismos formatos de precio), para
 * que el dia que se enchufen los providers reales no haya que tocar ni las
 * plantillas ni las consultas. Pero ninguno de estos precios es real ni esta
 * consultado en vivo.
 */

import { db, una, ejecutar } from './index.js';
import { sincronizarEtapaUnica } from '../services/etapas.js';

/**
 * 20 actividades de Paris.
 * Formato calcado del de Civitatis: valoracion sobre 10, precio null cuando es
 * gratis... salvo que aqui usamos 0 para los free tours, igual que hace el
 * provider real.
 */
const ACTIVIDADES = [
  ['Free tour por Montmartre',                 0,     '2h 30m', 9.6, 18432],
  ['Museo del Louvre sin colas',              99,     '3 horas', 8.6,  4210],
  ['Crucero por el Sena',                     21,     '1 hora',  8.3, 12045],
  ['Free tour por París',                      0,     '3 horas', 9.4, 27310],
  ['Torre Eiffel: acceso a la segunda planta', 45,    '2 horas', 8.9,  9876],
  ['Excursión a Versalles',                   65,     '9 horas', 9.1,  6543],
  ['Museo de Orsay con audioguía',            34,     '2h 30m',  9.0,  3120],
  ['Tour de los cafés literarios',            28,     '2 horas', 8.7,   412],
  ['Escapada a Giverny y Monet',              79,     '8 horas', 9.2,  1877],
  ['Free tour del París de la Revolución',     0,     '2h 45m',  9.3,  2044],
  ['Catacumbas de París',                     38,     '1h 30m',  8.1,  5390],
  ['Barrio Latino y Panteón',                 24,     '3 horas', 8.8,   961],
  ['Disneyland® Paris: entrada 1 día',       104,     'Todo el día', 8.4, 7346],
  ['Cena crucero por el Sena',               129,     '2h 30m',  8.2,  1503],
  ['Tour de fantasmas y leyendas',            22,     '2 horas', 8.9,   734],
  ['Montmartre y Sacré-Cœur con guía',        30,     '3 horas', 9.0,  1288],
  ['Excursión a los castillos del Loira',    145,     '12 horas', 8.8,   402],
  ['Mercadillos de Saint-Ouen',               19,     '2h 30m',  7.9,   287],
  ['Museo Rodin y jardines',                  26,     '1h 30m',  8.5,   615],
  ['Tour gastronómico por Le Marais',         89,     '3h 30m',  9.5,   958],
];

/**
 * 4 vuelos. Numeros, horarios y precios tomados del test real de Vueling
 * (BCN-OVD), reutilizados aqui como ida y vuelta a Paris. Repito: FALSOS.
 */
const VUELOS = [
  ['VY1570', 'ida',    'BCN', 'CDG', '07:10', '08:45', '1h 35m', 138],
  ['VY1578', 'ida',    'BCN', 'CDG', '14:00', '15:40', '1h 40m', 199],
  ['VY1572', 'ida',    'BCN', 'CDG', '19:40', '21:15', '1h 35m', 181],
  ['VY1573', 'vuelta', 'CDG', 'BCN', '09:30', '11:00', '1h 30m', 177],
];

/**
 * 5 hoteles. Mismo formato que devuelve providers/booking.js: el precio es el
 * TOTAL de la estancia, no por noche.
 */
const HOTELES = [
  ['Hotel Trianon Rive Gauche',      1591, 8.4, 3615, 'Saint-Germain - 6º distrito', 4, 'a 1,2 km del centro'],
  ['Ibis Styles Paris Batignolles',  1001, 8.3, 3208, 'Batignolles - 17º distrito',  3, 'a 4,3 km del centro'],
  ['Hôtel Botaniste',                1131, 8.6,  952, 'Passy - 16º distrito',        4, 'a 6,5 km del centro'],
  ['Hilton Garden Inn La Villette',   874, 8.3,  868, 'La Villette - 19º distrito',  4, 'a 5 km del centro'],
  ['Campanile Prime Paris 19',        591, 8.2, 6501, 'La Villette - 19º distrito',  3, 'a 4,6 km del centro'],
];

/**
 * Avisos del destino (pantalla 3). Tambien falsos: el dia de mañana saldran de
 * un servicio de clima / avisos de viaje.
 */
export const AVISOS_EJEMPLO = [
  {
    severidad: 'info',
    titulo: 'Clima previsto',
    texto: 'Máximas de 22 °C y mínimas de 13 °C. Alguna lluvia suelta a media semana: mete un chubasquero fino.',
  },
  {
    severidad: 'precaucion',
    titulo: 'Jornada de huelga en el transporte',
    texto: 'Hay convocatoria de huelga parcial en el metro para el segundo día. Las líneas 1 y 14 son automáticas y suelen funcionar.',
  },
  {
    severidad: 'precaucion',
    titulo: 'Museos cerrados los martes',
    texto: 'El Louvre cierra los martes y el Orsay los lunes. Cuadra las visitas antes de comprar entradas.',
  },
  {
    severidad: 'alerta',
    titulo: 'Carteristas en zonas turísticas',
    texto: 'Especial cuidado en la línea 1 del metro, alrededores de la Torre Eiffel y Montmartre. Nada en los bolsillos traseros.',
  },
  {
    severidad: 'info',
    titulo: 'Festivo local',
    texto: 'El día 15 es festivo: comercios con horario reducido y transporte en frecuencia de domingo.',
  },
];

/** Imagen de marcador de posicion: aun no bajamos imagenes reales. */
const SIN_IMAGEN = null;

/**
 * Si la base de datos esta vacia, crea un viaje de ejemplo a Paris con todos sus
 * candidatos. Si ya hay viajes, no toca nada.
 */
export function sembrarSiHaceFalta() {
  const { total } = una('SELECT COUNT(*) AS total FROM viajes');
  if (total > 0) {
    console.log(`[seed] La BD ya tiene ${total} viaje/s: no siembro nada.`);
    return null;
  }

  console.log('[seed] BD vacía: creo el viaje de ejemplo a París con datos falsos.');

  const viaje = ejecutar(
    `INSERT INTO viajes (nombre, destino, fecha_inicio, fecha_fin, presupuesto, tipo_viaje, paso_actual, estado)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
    'Escapada a París',
    'París',
    '2026-09-14',
    '2026-09-17',
    900,
    'cultural,gastronomico',
    5, // lo dejamos en el catalogo, que es la pantalla mas vistosa
    'borrador'
  );
  const viajeId = Number(viaje.lastInsertRowid);

  // El viaje sembrado tiene un solo destino, o sea: UNA etapa. Se crea aqui
  // para que hasta el viaje de ejemplo cumpla el modelo nuevo y sus actividades
  // cuelguen de algo.
  const etapa = sincronizarEtapaUnica(viajeId);

  const insertar = db.prepare(
    `INSERT INTO candidatos
       (viaje_id, etapa_id, tipo, titulo, precio, moneda, duracion, valoracion, num_opiniones,
        url, imagen_url, origen_datos, marcado, datos_extra)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
  );

  // --- Actividades ---------------------------------------------------------
  for (const [titulo, precio, duracion, valoracion, opiniones] of ACTIVIDADES) {
    insertar.run(
      viajeId, etapa?.id ?? null, 'actividad', titulo, precio, 'EUR', duracion, valoracion, opiniones,
      null, SIN_IMAGEN, 'civitatis', 0, null
    );
  }

  // --- Vuelos y hoteles: YA NO SE SIEMBRAN ---------------------------------
  // Los hoteles vienen de Booking de verdad (providers/booking.js, por la cola)
  // y los vuelos vendran de Kayak igual. Sembrar falsos solo serviria para
  // confundirlos con los reales, que llevan el mismo origen_datos.
  // Las constantes VUELOS y HOTELES se dejan mas arriba como documentacion del
  // formato que devuelven esos providers, pero no se insertan.

  console.log(`[seed] Viaje #${viajeId} creado: ${ACTIVIDADES.length} actividades (vuelos y hoteles se buscan de verdad).`);
  return viajeId;
}
