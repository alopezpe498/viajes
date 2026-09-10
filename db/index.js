/**
 * db/index.js
 * -----------------------------------------------------------------------------
 * Conexion a SQLite y esquema de la base de datos.
 *
 * Usamos el modulo `node:sqlite` que trae Node 24 de serie: cero dependencias y,
 * sobre todo, nada de compilacion nativa (que en Windows es la principal fuente
 * de dolores de cabeza al instalar). La BD es un unico fichero: db/viajes.db
 */

import { DatabaseSync } from 'node:sqlite';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

/** Fichero fisico de la base de datos. */
export const RUTA_BD = path.join(__dirname, 'viajes.db');

export const db = new DatabaseSync(RUTA_BD);

// Las claves ajenas no vienen activadas por defecto en SQLite.
db.exec('PRAGMA foreign_keys = ON');

// QUE NADIE SE CAIGA POR UN "database is locked".
//
// Con el servidor abierto y un trabajo largo escribiendo, dos escrituras que se
// cruzan hacen que SQLite conteste "database is locked" al instante y el trabajo
// muera. Le paso al orquestador entero: la fase de excursiones se fue a error a
// mitad de camino por esto.
//
// WAL deja que se lea mientras otro escribe, y el busy_timeout dice que espere
// cinco segundos en vez de rendirse a la primera. Son los dos ajustes de siempre
// para una base de datos de fichero, y ninguno cambia lo que se guarda.
db.exec('PRAGMA journal_mode = WAL');
db.exec('PRAGMA busy_timeout = 5000');

/**
 * Crea las tablas si no existen.
 *
 * El esquema tiene DOS MUNDOS y conviene no mezclarlos:
 *
 *  CATALOGO (destinos, puntos_interes, sitios_lugar, catalogo_actividades)
 *    Conocimiento estable sobre el mundo. Describe sitios, no viajes: sirve
 *    igual para el viaje de este año y para el de dentro de tres. Ninguna de
 *    estas tablas lleva viaje_id, y ninguna lleva fechas ni precios mios.
 *
 *  VIAJE (viajes, etapas, transportes, candidatos, itinerario, avisos)
 *    Mis decisiones y mis cotizaciones, con fechas. Aqui si hay viaje_id.
 *
 *  - viajes:      la cabecera. El campo `destino` es ahora el AMBITO ("Japon"),
 *                 no una ciudad concreta: las ciudades son etapas.
 *  - etapas:      las paradas de la ruta. Un viaje de un solo destino es un
 *                 viaje con UNA etapa, asi que lo de antes sigue encajando.
 *  - transportes: como se va de una etapa a la siguiente (o desde/hacia casa).
 *  - candidatos:  TODO lo que se puede marcar (actividades, vuelos, hoteles...).
 *                 Una sola tabla para los tres tipos, porque comparten casi
 *                 todos los campos y asi el catalogo, los vuelos y los hoteles
 *                 se pintan y se marcan con el mismo codigo.
 *  - itinerario:  el reparto por dias. Vacia en esta fase (es la pantalla 8).
 */
export function crearEsquema() {
  db.exec(`
    CREATE TABLE IF NOT EXISTS viajes (
      id           INTEGER PRIMARY KEY AUTOINCREMENT,
      nombre       TEXT    NOT NULL,
      -- AMBITO del viaje, no una ciudad: "Japon", "Portugal", "Lisboa".
      -- Las ciudades que se visitan viven ahora en "etapas".
      destino      TEXT,
      fecha_inicio TEXT,
      fecha_fin    TEXT,
      presupuesto  REAL,
      tipo_viaje   TEXT,                        -- cultural/gastronomico/naturaleza/relax/mixto
      paso_actual  INTEGER NOT NULL DEFAULT 1,  -- permite retomar el wizard donde lo dejaste
      estado       TEXT    NOT NULL DEFAULT 'borrador', -- borrador/planificado/archivado
      creado_en    TEXT    NOT NULL DEFAULT (datetime('now'))
    );

    CREATE TABLE IF NOT EXISTS candidatos (
      id            INTEGER PRIMARY KEY AUTOINCREMENT,
      viaje_id      INTEGER NOT NULL REFERENCES viajes(id) ON DELETE CASCADE,
      -- De que cuelga el candidato dentro del viaje:
      --   hoteles y actividades -> de una ETAPA (se duerme y se visita en una ciudad)
      --   vuelos y demas        -> de un TRANSPORTE (unen dos etapas, o casa con una)
      -- Los dos son nullable: un candidato suelto sigue siendo valido.
      etapa_id      INTEGER REFERENCES etapas(id) ON DELETE SET NULL,
      transporte_id INTEGER REFERENCES transportes(id) ON DELETE SET NULL,
      tipo          TEXT    NOT NULL,           -- actividad/vuelo/hotel/sitio
      titulo        TEXT    NOT NULL,
      precio        REAL,
      moneda        TEXT,
      duracion      TEXT,
      valoracion    REAL,
      num_opiniones INTEGER,
      url           TEXT,
      imagen_url    TEXT,
      origen_datos  TEXT,                       -- civitatis/vueling/booking/manual
      marcado       INTEGER NOT NULL DEFAULT 0, -- SQLite no tiene BOOLEAN: 0/1
      datos_extra   TEXT                        -- JSON como texto
    );

    -- El LIENZO: cada fila es una cosa colocada en un dia y una franja.
    CREATE TABLE IF NOT EXISTS itinerario (
      id           INTEGER PRIMARY KEY AUTOINCREMENT,
      viaje_id     INTEGER NOT NULL REFERENCES viajes(id) ON DELETE CASCADE,
      etapa_id     INTEGER REFERENCES etapas(id) ON DELETE CASCADE,
      dia          INTEGER NOT NULL,          -- numero de dia del viaje, 1..N
      franja       TEXT    NOT NULL,          -- manana / mediodia / tarde / noche
      candidato_id INTEGER REFERENCES candidatos(id) ON DELETE CASCADE,
      texto_manual TEXT,
      hora         TEXT,                      -- "HH:MM", opcional
      orden        INTEGER NOT NULL DEFAULT 0,
      creado_en    TEXT    NOT NULL DEFAULT (datetime('now')),
      -- O una cosa colocada, o un texto a mano. Nunca las dos, nunca ninguna.
      CHECK ((candidato_id IS NOT NULL) <> (texto_manual IS NOT NULL))
    );

    -- =========================================================================
    -- CATÁLOGO — conocimiento estable sobre el mundo, independiente de viajes
    -- =========================================================================
    -- Regla que separa estas tablas de las de arriba: aquí NO hay fechas, ni
    -- precios, ni decisiones mías. Lo que hay describe un sitio y sirve igual
    -- para el viaje de este año y para el de dentro de tres. Por eso nada de
    -- aquí lleva viaje_id.

    -- Un destino es el ámbito que se investiga: un país, una región o una
    -- ciudad suelta. "Japón" es un destino; "Tokio" también puede serlo.
    CREATE TABLE IF NOT EXISTS destinos (
      id             INTEGER PRIMARY KEY AUTOINCREMENT,
      nombre         TEXT NOT NULL,
      nombre_norm    TEXT NOT NULL,              -- clave de búsqueda: sin acentos ni mayúsculas
      tipo           TEXT NOT NULL DEFAULT 'pais', -- pais / region / ciudad
      pais           TEXT,
      lat            REAL,
      lon            REAL,
      resumen        TEXT,
      investigado_en TEXT,                       -- datetime de la última investigación; null = sin investigar
      datos_extra    TEXT,                       -- JSON como texto
      creado_en      TEXT NOT NULL DEFAULT (datetime('now')),
      UNIQUE (nombre_norm, tipo)
    );

    -- Los "imprescindibles" de un destino: los 15 sitios que uno mira antes de
    -- decidir la ruta. Pueden ser ciudades (Tokio) o sitios concretos que se
    -- visitan desde una ciudad (Monte Fuji, que se hace desde Hakone).
    CREATE TABLE IF NOT EXISTS puntos_interes (
      id                    INTEGER PRIMARY KEY AUTOINCREMENT,
      destino_id            INTEGER NOT NULL REFERENCES destinos(id) ON DELETE CASCADE,
      nombre                TEXT NOT NULL,
      categoria             TEXT NOT NULL DEFAULT 'ciudad',  -- ciudad / sitio
      ciudad_base           TEXT,                 -- desde qué ciudad se visita (Monte Fuji -> "Hakone")
      lat                   REAL,
      lon                   REAL,
      descripcion_corta     TEXT,                 -- 2-3 líneas
      por_que               TEXT,                 -- por qué merece la pena
      dias_recomendados_min INTEGER,
      dias_recomendados_max INTEGER,
      imagen_url            TEXT,
      wikipedia_url         TEXT,
      orden                 INTEGER NOT NULL DEFAULT 0,
      investigado_en        TEXT,                 -- null = solo tiene el nivel superficial
      datos_extra           TEXT,                 -- JSON como texto
      creado_en             TEXT NOT NULL DEFAULT (datetime('now'))
    );

    -- La ficha profunda de un punto de interés: los templos, barrios y mercados
    -- DE esa ciudad. Solo se rellena cuando uno baja a investigar ese punto.
    CREATE TABLE IF NOT EXISTS sitios_lugar (
      id                INTEGER PRIMARY KEY AUTOINCREMENT,
      punto_interes_id  INTEGER NOT NULL REFERENCES puntos_interes(id) ON DELETE CASCADE,
      nombre            TEXT NOT NULL,
      descripcion       TEXT,
      imagen_url        TEXT,
      wikipedia_url     TEXT,
      lat               REAL,
      lon               REAL,
      orden             INTEGER NOT NULL DEFAULT 0,
      creado_en         TEXT NOT NULL DEFAULT (datetime('now'))
    );

    -- Caché de actividades de Civitatis. Antes vivía SOLO dentro de cada viaje
    -- (candidatos con viaje_id), lo que obligaba a volver a scrapear Lisboa en
    -- cada viaje a Lisboa. Ahora cuelga de la CIUDAD normalizada, que es de lo
    -- que de verdad depende, y los candidatos del viaje se siguen creando igual.
    CREATE TABLE IF NOT EXISTS catalogo_actividades (
      id            INTEGER PRIMARY KEY AUTOINCREMENT,
      ciudad        TEXT NOT NULL,               -- tal y como se escribió ("Lisboa")
      ciudad_norm   TEXT NOT NULL,               -- clave real ("lisboa")
      -- Con qué se decide que dos filas son la misma actividad: la url si la
      -- hay y, si no, el título. Es exactamente el criterio que ya usaba el
      -- worker para no duplicar; aquí lo hace cumplir la propia base de datos.
      clave_unica   TEXT NOT NULL,
      titulo        TEXT NOT NULL,
      precio        REAL,
      moneda        TEXT,
      duracion      TEXT,
      valoracion    REAL,
      num_opiniones INTEGER,
      url           TEXT,
      imagen_url    TEXT,
      origen_datos  TEXT NOT NULL DEFAULT 'civitatis',
      datos_extra   TEXT,
      visto_en      TEXT NOT NULL DEFAULT (datetime('now')),  -- para saber si la caché está rancia
      UNIQUE (ciudad_norm, clave_unica)
    );

    -- =========================================================================
    -- VIAJE — mis decisiones, con fechas y precios
    -- =========================================================================

    -- Una etapa es una parada de la ruta. Un viaje de un solo destino es un
    -- viaje con una etapa: así lo de antes sigue encajando sin excepciones.
    CREATE TABLE IF NOT EXISTS etapas (
      id               INTEGER PRIMARY KEY AUTOINCREMENT,
      viaje_id         INTEGER NOT NULL REFERENCES viajes(id) ON DELETE CASCADE,
      -- El destino del CATALOGO del que sabemos cosas de esta parada. Es lo que
      -- permite que su pestaña "Que ver" enseñe los sitios y las excursiones
      -- que ya tenemos guardados de esa ciudad.
      destino_id       INTEGER REFERENCES destinos(id) ON DELETE SET NULL,
      punto_interes_id INTEGER REFERENCES puntos_interes(id) ON DELETE SET NULL, -- null: ciudad escrita a mano
      nombre_ciudad    TEXT NOT NULL,
      orden            INTEGER NOT NULL DEFAULT 1,
      noches           INTEGER NOT NULL DEFAULT 0,
      fecha_inicio     TEXT,                     -- DERIVADAS: orden + noches + fecha de inicio del viaje
      fecha_fin        TEXT,                     -- no se editan a mano, se recalculan
      estado           TEXT NOT NULL DEFAULT 'recopilando', -- recopilando / confirmada
      notas            TEXT,
      creado_en        TEXT NOT NULL DEFAULT (datetime('now'))
    );

    -- Cómo se va de una etapa a la siguiente. Los nulos son "casa":
    --   etapa_origen_id  NULL -> vuelo/tren de IDA desde casa
    --   etapa_destino_id NULL -> la VUELTA a casa
    CREATE TABLE IF NOT EXISTS transportes (
      id               INTEGER PRIMARY KEY AUTOINCREMENT,
      viaje_id         INTEGER NOT NULL REFERENCES viajes(id) ON DELETE CASCADE,
      etapa_origen_id  INTEGER REFERENCES etapas(id) ON DELETE CASCADE,
      etapa_destino_id INTEGER REFERENCES etapas(id) ON DELETE CASCADE,
      tipo             TEXT NOT NULL DEFAULT 'vuelo',  -- vuelo / tren / coche / bus / ferry
      candidato_id     INTEGER REFERENCES candidatos(id) ON DELETE SET NULL, -- el elegido
      datos_extra      TEXT,
      creado_en        TEXT NOT NULL DEFAULT (datetime('now'))
    );

    -- Cola de trabajos en segundo plano (scraping). La procesa jobs/worker.js
    -- dentro del mismo proceso de Express, de uno en uno.
    CREATE TABLE IF NOT EXISTS trabajos (
      id            INTEGER PRIMARY KEY AUTOINCREMENT,
      viaje_id      INTEGER NOT NULL REFERENCES viajes(id) ON DELETE CASCADE,
      tipo          TEXT    NOT NULL,           -- 'actividades' (de momento)
      estado        TEXT    NOT NULL DEFAULT 'pendiente', -- pendiente/en_curso/hecho/error
      mensaje_error TEXT,
      creado_en     TEXT    NOT NULL DEFAULT (datetime('now')),
      terminado_en  TEXT
    );

    -- Avisos del destino (pantalla 3). Tabla propia, y no la de candidatos, porque
    -- un aviso no se marca ni se elige: solo se lee.
    CREATE TABLE IF NOT EXISTS avisos (
      id        INTEGER PRIMARY KEY AUTOINCREMENT,
      viaje_id  INTEGER NOT NULL REFERENCES viajes(id) ON DELETE CASCADE,
      categoria TEXT NOT NULL,          -- clima / seguridad / festivos
      severidad TEXT NOT NULL,          -- info / precaucion / alerta
      titulo    TEXT NOT NULL,
      texto     TEXT,
      url       TEXT,                   -- enlace a la fuente, si lo hay
      creado_en TEXT NOT NULL DEFAULT (datetime('now'))
    );

    -- Latido del worker. Sirve para que solo UNA instancia de la app procese
    -- la cola: si levantas dos servidores contra esta misma base de datos, el
    -- segundo ve el latido del primero y no arranca su bucle.
    CREATE TABLE IF NOT EXISTS worker_latido (
      id       INTEGER PRIMARY KEY CHECK (id = 1),  -- fila unica
      pid      INTEGER,
      visto_en TEXT NOT NULL
    );

    -- Migraciones ya aplicadas. Antes bastaba con mirar si existia una columna,
    -- pero hay migraciones que no añaden columnas (borrar datos, por ejemplo),
    -- asi que llevamos registro explicito.
    CREATE TABLE IF NOT EXISTS migraciones (
      clave       TEXT PRIMARY KEY,
      aplicada_en TEXT NOT NULL DEFAULT (datetime('now'))
    );

    CREATE INDEX IF NOT EXISTS idx_candidatos_viaje ON candidatos(viaje_id, tipo);
    CREATE INDEX IF NOT EXISTS idx_itinerario_viaje ON itinerario(viaje_id, dia, franja, orden);
    CREATE INDEX IF NOT EXISTS idx_trabajos_estado  ON trabajos(estado, id);
    CREATE INDEX IF NOT EXISTS idx_trabajos_viaje   ON trabajos(viaje_id, tipo, id);
    CREATE INDEX IF NOT EXISTS idx_avisos_viaje     ON avisos(viaje_id, categoria, id);
    CREATE INDEX IF NOT EXISTS idx_etapas_viaje     ON etapas(viaje_id, orden);
    CREATE INDEX IF NOT EXISTS idx_transportes_viaje ON transportes(viaje_id, id);
    CREATE INDEX IF NOT EXISTS idx_puntos_destino   ON puntos_interes(destino_id, orden);
    CREATE INDEX IF NOT EXISTS idx_sitios_punto     ON sitios_lugar(punto_interes_id, orden);
    CREATE INDEX IF NOT EXISTS idx_catactiv_ciudad  ON catalogo_actividades(ciudad_norm, id);
  `);
}

/**
 * Migraciones. Se ejecutan al arrancar, despues de crearEsquema().
 * Cada una lleva una clave y se apunta en la tabla `migraciones` cuando se hace,
 * asi que ninguna se aplica dos veces.
 */

/** ¿Ya se aplico esta migracion? */
function yaAplicada(clave) {
  return Boolean(db.prepare('SELECT 1 FROM migraciones WHERE clave = ?').get(clave));
}

/** Deja constancia de que una migracion ya se hizo. */
function marcarAplicada(clave) {
  db.prepare('INSERT OR IGNORE INTO migraciones (clave) VALUES (?)').run(clave);
}

export function migrarEsquema() {
  migracionViajeros();
  migracionQuitarHotelesFalsos();
  migracionQuitarVuelosFalsos();
  migracionFiltrosHoteles();
  migracionFiltrosVuelos();
  migracionEtapasYCatalogo();
  migracionDescubrir();
  migracionSitiosLugar();
  migracionTransporteEtapa();
  migracionLienzo();
  migracionEtapaNoEsUnSitio();
  migracionFichaActividadYFiltrosTramo();
  migracionDosier();
  migracionAdjuntos();
  migracionDistanciasCiudades();
  migracionMovilidad();
  migracionTrasladosYDirecciones();
  migracionComer();
  migracionBusquedasEfimeras();
  migracionIata();
  migracionFichaPais();
  migracionPaisDeEtapa();
  migracionCiudadDeOrigen();
  migracionFichaRevisada();
  migracionDatosDurosDeSitios();
  migracionBloquesDeSitios();
  migracionBusquedasDeSitios();
  migracionNotaDeBusqueda();
  migracionOrquestador();
  migracionFase1Ciudades();
  migracionFase1PromptAfinado();
  migracionFase1CiudadUnica();
  migracionFase1DiasVsNoches();
  migracionFase2Traslados();
  migracionFase2ConHorario();
  migracionMargenDelCoche();
  migracionMargenesRealistas();
  migracionFase3Dormir();
  migracionFase4Sitios();
  migracionFase5Excursiones();
  migracionFase1PuertaPorRuta();
  migracionFase1NochesPorPeso();
  migracionFase1RutaPrevista();
  migracionPromptDeTramos();
  migracionOrigenDelPrecioDeTramo();
  migracionDuracionesPorCategoria();
  migracionPasadasDeRevision();
  migracionVueltaDecente();
  migracionCorrectivoGrecia();
  migracionSlugsDeCivitatis();
  migracionReservas();
  migracionAdjuntosDeReserva();
  migracionCorrectivoPeloponeso();
  migracionFase6Lienzo();
  migracionFase6Referencias();
  migracionRegistroDelOrquestador();
  migracionPresupuesto();
  migracionClima();
  migracionReservaAnticipada();
  migracionMultipais();
  migracionRegla1ConVariosPaises();
  migracionPuertaSinUnSoloPais();
  migracionCorrectivoAtenas();
  migracionReservaDeTraslados();

  // Estos tres van al final a proposito: cuelgan de columnas que en una base de
  // datos ya existente no aparecen hasta que la migracion las añade, asi que en
  // crearEsquema() todavia no se pueden crear.
  db.exec(`
    CREATE INDEX IF NOT EXISTS idx_candidatos_etapa  ON candidatos(etapa_id, tipo);
    CREATE INDEX IF NOT EXISTS idx_candidatos_transp ON candidatos(transporte_id);
    CREATE INDEX IF NOT EXISTS idx_itinerario_etapa  ON itinerario(etapa_id, dia);
  `);
}

/**
 * Migracion 19: las busquedas dejan de acumularse.
 *
 * EL PROBLEMA, con numeros: Madrid tenia 71 fichas en la pestaña "Comer". Cada
 * busqueda anadia doce mas y ninguna se iba nunca, asi que a la cuarta consulta
 * la pestaña era una lista infinita donde no se encontraba lo que uno mismo se
 * habia apuntado tres dias antes.
 *
 * DOS COSAS DISTINTAS MEZCLADAS EN LA MISMA LISTA:
 *
 *   - Lo que YO me he apuntado. Es mio, es del viaje y no se toca nunca.
 *   - Lo que salio en una busqueda. Es material de usar y tirar: si vuelvo a
 *     buscar, lo de antes ya no me interesa.
 *
 * `busqueda` es la marca de en que consulta salio cada ficha. La pantalla
 * enseña lo apuntado + lo de la ULTIMA busqueda, y lo demas se queda plegado.
 *
 * NO SE BORRA NADA, y eso es deliberado. Las filas siguen en el catalogo porque
 * se pagaron: cada una es una llamada a Places, y el proximo viaje a Madrid las
 * reutiliza sin volver a pedirlas. Lo que se limpia es LA PANTALLA, que es
 * donde estaba el problema.
 *
 * Y DE PASO, LA MOVILIDAD DUPLICABA. `guardarFichaMovilidad` era un INSERT a
 * secas: pulsar "Buscar otra vez" en Moverse metia otra vez las mismas cinco
 * fichas de metro y taxi. Se le pone un indice unico por (ciudad, nombre) para
 * que una segunda busqueda ACTUALICE en vez de duplicar, que es lo que ya hacen
 * las actividades y los restaurantes.
 */
/**
 * Migracion 20: cache de codigos IATA.
 *
 * Hasta ahora los codigos vivian en una lista fija de lib/iata.js y punto: si
 * la ciudad no estaba, la busqueda de vuelos moria con un "añadelo a
 * lib/iata.js". Eso es pedirle a la persona que edite codigo fuente para
 * buscar un vuelo a Cadiz.
 *
 * La lista se queda como semilla —es correcta, es gratis y sabe cosas que
 * importan, como que PAR son los tres aeropuertos de Paris y no solo CDG—,
 * pero lo que no este se resuelve solo y se guarda AQUI, para no volver a
 * preguntarlo nunca.
 *
 * `codigo` puede ser NULL: es la forma de recordar que se pregunto y no habia
 * respuesta, y asi no se reintenta en bucle. `buscado_en` permite reintentarlo
 * pasado un tiempo si algun dia interesa.
 */
/**
 * Migracion 21: la ficha practica de cada pais.
 *
 * Que hace falta para ENTRAR (pasaporte, visado, vacunas, seguro) y que hay que
 * saber ESTANDO (moneda, cambio, festivos, avisos de Exteriores). Es
 * informacion que se consulta mientras se organiza el viaje, no estando alli:
 * un visado se tramita con semanas de antelacion y una vacuna con mas.
 *
 * Se guarda por PAIS + FECHAS, no por viaje: los festivos y los avisos dependen
 * de cuando se va, pero dos viajes a Portugal la misma semana comparten ficha y
 * no hay por que generarla dos veces. Cada llamada a la IA cuesta.
 *
 * `generado_en` es la pieza importante: con ella se sabe si lo que se enseña se
 * quedo viejo. Un visado puede cambiar de un mes para otro.
 */
/**
 * Migracion 22: el pais de cada parada, guardado en la propia parada.
 *
 * Se averigua geocodificando la ciudad, y eso es una peticion a Open-Meteo por
 * ciudad. Sin guardarlo habia que repetirlas ENTERAS cada vez que se abria el
 * panel de "Antes de viajar", y ademas el dosier —que se genera sin red y de
 * forma sincrona— no tenia de donde sacarlo: su filtro por pais se quedaba
 * vacio y dejaba pasar fichas de otros viajes con las mismas fechas.
 *
 * `etapas.destino_id` no servia: en las etapas reales viene a null.
 *
 * El pais de una parada es una propiedad de la parada. Aqui es donde va.
 */
/**
 * Migracion 23: de donde sale el viaje.
 *
 * Estaba clavado en una constante —'BCN'— y el propio comentario de
 * services/proveedores.js decia lo que habia que hacer el dia que se quisiera
 * elegir por viaje: una columna aqui y un campo en la pantalla 1. Pues eso.
 *
 * Barcelona sigue siendo el valor por defecto, asi que los viajes que ya
 * existen se comportan exactamente igual que antes.
 */
/**
 * Migracion 24: "Antes de viajar", ya revisado.
 *
 * El boton de Mi ruta nace con cara de aviso, y con razon: hay cosas que mirar.
 * Pero una vez miradas deja de ser un aviso y pasa a ser una tarea hecha, igual
 * que un vuelo elegido. Sin esto, el ambar se queda ahi para siempre y acaba
 * siendo ruido que se ignora.
 *
 * Va por VIAJE, no por pais: revisar los papeles de Polonia para el viaje de
 * septiembre no significa haberlos revisado para el de diciembre.
 */
/**
 * Migracion 25: los datos DUROS de cada sitio.
 *
 * Hasta ahora la ficha de un sitio era la IA (que lo propone) mas Wikipedia
 * (que lo describe). Las dos cosas cuentan QUE es, y ninguna dice lo que hace
 * falta para ir: cuanto cuesta, a que hora abre, cuanto se tarda en verlo.
 *
 * Esas columnas se llenan SOLO con lo que devuelva una busqueda real. La IA
 * interviene para extraer los campos del texto de la busqueda, no para
 * aportarlos: si la busqueda no trae el precio, la columna se queda vacia. Un
 * precio inventado es peor que un hueco, porque el hueco se nota y el invento
 * no.
 *
 * `datos_en` y `datos_fuente` son la trazabilidad: de donde salio y cuando. Con
 * mas de treinta dias se siguen enseñando, pero avisando de que pueden haber
 * cambiado.
 *
 * ES CATALOGO, no viaje: el horario del Castillo de San Jorge no depende de mi
 * viaje, asi que el siguiente que vaya a Lisboa lo hereda sin volver a buscar.
 */
function migracionDatosDurosDeSitios() {
  const CLAVE = '2026-09-datos-duros-sitios';
  if (yaAplicada(CLAVE)) return false;

  const cols = db.prepare('PRAGMA table_info(sitios_lugar)').all().map((c) => c.name);
  const anadir = (nombre, tipo) => {
    if (!cols.includes(nombre)) db.exec(`ALTER TABLE sitios_lugar ADD COLUMN ${nombre} ${tipo}`);
  };

  anadir('precio', 'TEXT');
  anadir('horarios', 'TEXT');
  anadir('tiempo_visita', 'TEXT');
  anadir('web', 'TEXT');
  anadir('telefono', 'TEXT');
  anadir('datos_en', 'TEXT');       // cuando se obtuvieron
  anadir('datos_fuente', 'TEXT');   // de donde
  // Los dias que cierra, ya interpretados. Lo rellena el aviso del lienzo la
  // primera vez que hace falta, no la busqueda.
  anadir('cierra_dias', 'TEXT');    // JSON: [0..6], domingo = 0
  anadir('cierra_en', 'TEXT');

  marcarAplicada(CLAVE);
  console.log('[bd] Migración: datos duros de los sitios.');
  return true;
}

/**
 * LOS SITIOS DE UNA ETAPA, REPARTIDOS EN BLOQUES.
 *
 * Antes había una lista y ya está. Ahora hay cuatro cajones —los imprescindibles,
 * los de segundo nivel, los de niños y lo que el usuario se busque por su cuenta—
 * y cada sitio vive en uno solo.
 *
 * Todo lo que ya estaba guardado pasa a 'imprescindibles': es lo que era, la
 * lista corta de lo que no te puedes perder, y así ninguna etapa investigada
 * hasta hoy aparece vacía al abrirla.
 *
 * `categoria` la pone la IA de una lista cerrada. Se guarda aunque de momento
 * solo se enseñe: la fila de filtros vendrá después.
 */
function migracionBloquesDeSitios() {
  const CLAVE = '2026-09-bloques-de-sitios';
  if (yaAplicada(CLAVE)) return false;

  const cols = db.prepare('PRAGMA table_info(sitios_lugar)').all().map((c) => c.name);
  const anadir = (nombre, tipo) => {
    if (!cols.includes(nombre)) db.exec(`ALTER TABLE sitios_lugar ADD COLUMN ${nombre} ${tipo}`);
  };

  anadir('bloque', "TEXT NOT NULL DEFAULT 'imprescindibles'");
  anadir('categoria', 'TEXT');
  // Qué escribió el usuario para que apareciera este sitio. Solo lo llevan los
  // del bloque 'busqueda', y sirve para agruparlos por consulta en su pestaña.
  anadir('busqueda', 'TEXT');

  // Lo de antes es lo imprescindible. Un UPDATE explícito y no solo el DEFAULT,
  // porque el DEFAULT no toca las filas que ya existían.
  db.exec("UPDATE sitios_lugar SET bloque = 'imprescindibles' WHERE bloque IS NULL");

  marcarAplicada(CLAVE);
  console.log('[bd] Migración: bloques y categoría de los sitios.');
  return true;
}

/**
 * LO QUE EL USUARIO SE BUSCA POR SU CUENTA.
 *
 * Una búsqueda no es una ficha: es una conversación corta que puede quedarse a
 * medias. Escribes «búnkers de Berlín», la IA propone seis y tú eliges dos. Ese
 * estado intermedio —propuesto pero no elegido— no cabe en `sitios_lugar`, que
 * es catálogo y solo guarda sitios de verdad.
 *
 * Así que la búsqueda vive aquí con lo suyo: qué se pidió, si era un sitio
 * concreto o un tema, qué propuso la IA y en qué punto está. Las fichas que
 * salgan van a `sitios_lugar` como todas las demás, con bloque 'busqueda'.
 *
 * Cuelga de la ETAPA y no del catálogo: «búnkers» es una curiosidad de este
 * viaje, no un dato de Berlín que deba heredar el siguiente que vaya.
 */
function migracionBusquedasDeSitios() {
  const CLAVE = '2026-09-busquedas-de-sitios';
  if (yaAplicada(CLAVE)) return false;

  db.exec(`
    CREATE TABLE IF NOT EXISTS busquedas_sitios (
      id            INTEGER PRIMARY KEY AUTOINCREMENT,
      viaje_id      INTEGER NOT NULL REFERENCES viajes(id) ON DELETE CASCADE,
      etapa_id      INTEGER NOT NULL REFERENCES etapas(id) ON DELETE CASCADE,
      texto         TEXT    NOT NULL,
      -- 'concreto' (un sitio) o 'generico' (un tema). Lo decide la IA.
      tipo          TEXT,
      -- pendiente → proponiendo → esperando | generando → hecha | error
      estado        TEXT    NOT NULL DEFAULT 'pendiente',
      -- Lo que la IA propuso cuando el texto era un tema: [{nombre, descripcion}]
      propuestas    TEXT,
      -- Cuántas fichas salieron, para poder contarlo sin recorrer el catálogo.
      fichas        INTEGER NOT NULL DEFAULT 0,
      mensaje_error TEXT,
      creado_en     TEXT    NOT NULL DEFAULT (datetime('now')),
      terminado_en  TEXT
    );
    CREATE INDEX IF NOT EXISTS idx_busquedas_sitios_etapa ON busquedas_sitios(etapa_id);
  `);

  marcarAplicada(CLAVE);
  console.log('[bd] Migración: búsquedas de sitios del usuario.');
  return true;
}

/**
 * UN AVISO QUE NO ES UN ERROR.
 *
 * Buscas «Torre Eiffel» y ya la tienes en Imprescindibles: no se regenera, y
 * hasta aquí bien. Pero la pantalla se quedaba diciendo «0 fichas» sin explicar
 * por qué, que parece que ha fallado algo. No cabía en `mensaje_error` porque no
 * ha fallado nada: es una respuesta correcta que hay que contar.
 */
function migracionNotaDeBusqueda() {
  const CLAVE = '2026-09-nota-de-busqueda';
  if (yaAplicada(CLAVE)) return false;

  const cols = db.prepare('PRAGMA table_info(busquedas_sitios)').all().map((c) => c.name);
  if (!cols.includes('nota')) db.exec('ALTER TABLE busquedas_sitios ADD COLUMN nota TEXT');

  marcarAplicada(CLAVE);
  console.log('[bd] Migración: nota de las búsquedas de sitios.');
  return true;
}

/**
 * LOS CIMIENTOS DEL ORQUESTADOR.
 *
 * El modo automático monta el viaje entero en segundo plano llamando a las
 * mismas funciones que usa el flujo manual. Esta migración no trae ninguna
 * decisión: trae los sitios donde se guardan las que vendrán.
 *
 * CUATRO COSAS, y cada una está separada por un motivo:
 *
 *   · `viajes.automatico` y `viajes.config_auto`. El interruptor y todo lo que
 *     hay que tener decidido de antemano. Va en JSON y no en veinte columnas
 *     porque es una hoja de preferencias que va a crecer en cada fase, y añadir
 *     una columna por cada casilla acaba en una tabla que nadie mira.
 *
 *   · `parametros_orquestador`. Los números con los que decide. Guardar el
 *     valor de fábrica AL LADO del actual es lo que permite el botón de
 *     restaurar sin tener que ir a buscarlo al código.
 *
 *   · `prompts_orquestador`. Lo que se le dice a la IA en cada fase, editable
 *     desde la pantalla. El worker lee SIEMPRE de aquí, nunca de código: si el
 *     prompt vive en dos sitios, el que se edita nunca es el que se usa.
 *
 *   · `orquestador_fases`. En qué punto va cada viaje, con su log. Una fila por
 *     viaje y fase.
 *
 * Y UN FLAG EN LO QUE TOCAN LAS FASES. `tocado_a_mano` marca lo que ha decidido
 * una persona para que ninguna fase lo pise. Todavía no lo lee nadie —las fases
 * son cascarones—, pero la columna tiene que existir desde el principio: el día
 * que una fase empiece a escribir de verdad, no puede ser el día en que se
 * descubre que no hay dónde apuntar lo que era tuyo.
 */
function migracionOrquestador() {
  const CLAVE = '2026-09-orquestador';
  if (yaAplicada(CLAVE)) return false;

  // --- 1) El interruptor y la hoja de preferencias -------------------------
  const colsViaje = db.prepare('PRAGMA table_info(viajes)').all().map((c) => c.name);
  if (!colsViaje.includes('automatico')) {
    db.exec('ALTER TABLE viajes ADD COLUMN automatico INTEGER NOT NULL DEFAULT 0');
  }
  if (!colsViaje.includes('config_auto')) {
    db.exec('ALTER TABLE viajes ADD COLUMN config_auto TEXT');
  }

  // --- 2) Los números con los que decide -----------------------------------
  db.exec(`
    CREATE TABLE IF NOT EXISTS parametros_orquestador (
      clave         TEXT PRIMARY KEY,
      valor         TEXT NOT NULL,
      valor_fabrica TEXT NOT NULL,
      descripcion   TEXT NOT NULL,
      unidad        TEXT,
      orden         INTEGER NOT NULL DEFAULT 0
    );

    CREATE TABLE IF NOT EXISTS prompts_orquestador (
      fase           TEXT PRIMARY KEY,
      prompt_actual  TEXT NOT NULL,
      prompt_fabrica TEXT NOT NULL,
      actualizado_en TEXT
    );

    CREATE TABLE IF NOT EXISTS orquestador_fases (
      id           INTEGER PRIMARY KEY AUTOINCREMENT,
      viaje_id     INTEGER NOT NULL REFERENCES viajes(id) ON DELETE CASCADE,
      fase         TEXT    NOT NULL,
      orden        INTEGER NOT NULL,
      -- pendiente | en_curso | hecho | con_huecos | error
      estado       TEXT    NOT NULL DEFAULT 'pendiente',
      -- Lo que iba haciendo, en español. YA NO SE ESCRIBE: las líneas viven en
      -- la tabla orquestador_registro, que no se borra al relanzar una fase. La
      -- columna se queda con lo que hubiera: los viajes viejos no pierden nada.
      log          TEXT,
      -- Lo que no consiguió. Una fase con huecos NO detiene el proceso.
      huecos       TEXT,
      empezado_en  TEXT,
      terminado_en TEXT,
      UNIQUE (viaje_id, fase)
    );
    CREATE INDEX IF NOT EXISTS idx_orq_fases_viaje ON orquestador_fases(viaje_id);
  `);

  // --- 3) El flag de "esto lo he decidido yo" ------------------------------
  //
  // En las cuatro tablas que van a tocar las fases: las paradas, lo apuntado
  // (vuelos y hoteles), los traslados y lo colocado en el lienzo.
  for (const tabla of ['etapas', 'candidatos', 'traslados', 'itinerario']) {
    const cols = db.prepare(`PRAGMA table_info(${tabla})`).all().map((c) => c.name);
    if (cols.length && !cols.includes('tocado_a_mano')) {
      db.exec(`ALTER TABLE ${tabla} ADD COLUMN tocado_a_mano INTEGER NOT NULL DEFAULT 0`);
    }
  }

  sembrarParametros();
  sembrarPrompts();

  marcarAplicada(CLAVE);
  console.log('[bd] Migración: cimientos del orquestador.');
  return true;
}

/**
 * LOS PARÁMETROS DE FÁBRICA.
 *
 * `INSERT OR IGNORE`: si el parámetro ya está, no se toca. Lo que el usuario
 * haya cambiado manda sobre lo que diga esta lista, y añadir un parámetro nuevo
 * en una versión futura no puede resetear los diez anteriores.
 */
function sembrarParametros() {
  const PARAMETROS = [
    ['antelacion_vuelo_internacional_min', '120', 'Cuánto antes hay que estar en el aeropuerto para un vuelo de fuera de Europa', 'minutos'],
    ['antelacion_vuelo_europeo_min', '60', 'Lo mismo para un vuelo europeo', 'minutos'],
    ['antelacion_tren_min', '30', 'Cuánto antes hay que estar en la estación', 'minutos'],
    ['minimo_noches_por_ciudad', '2', 'Por debajo de esto, una ciudad no compensa: se duerme más de lo que se ve', 'noches'],
    ['max_ciudades_candidatas', '8', 'Cuántas ciudades se ponen sobre la mesa antes de elegir', 'ciudades'],
    ['umbral_empate_traslado_min', '30', 'Diferencia de tiempo por debajo de la cual decide el precio y no el reloj', 'minutos'],
    ['factor_precio_traslado', '3', 'Cuántas veces más caro tiene que ser para descartar la opción rápida', 'veces'],
    ['duracion_comida_min', '90', 'Lo que se reserva para comer al repartir el día', 'minutos'],
    ['max_excursiones_largas_por_dia', '1', 'Excursiones de día entero que caben en una jornada', 'excursiones'],
    ['max_excursiones_por_viaje', '0', 'Tope de excursiones en todo el viaje (0 = sin límite)', 'excursiones'],
    ['dias_caducidad_datos_sitios', '30', 'A partir de aquí, los datos de un sitio se vuelven a buscar', 'días'],
  ];

  const meter = db.prepare(
    `INSERT OR IGNORE INTO parametros_orquestador
       (clave, valor, valor_fabrica, descripcion, unidad, orden)
     VALUES (?, ?, ?, ?, ?, ?)`
  );
  PARAMETROS.forEach(([clave, valor, descripcion, unidad], i) => {
    meter.run(clave, valor, valor, descripcion, unidad, i);
  });
}

/**
 * UNA FILA POR FASE, con un prompt de relleno.
 *
 * El de verdad llegará con cada fase. Lo que importa hoy es que la fila exista
 * y que el worker ya lea de aquí: así, cuando se escriba el prompt bueno, no hay
 * que cambiar ni una línea de código para que se use.
 */
function sembrarPrompts() {
  const FASES = [
    ['ciudades_y_noches', 'Elegir qué ciudades entran en el viaje, cuántas noches en cada una y por qué aeropuerto se entra y se sale.'],
    ['traslados', 'Decidir cómo se va de cada ciudad a la siguiente.'],
    ['dormir', 'Elegir alojamiento en cada parada con los filtros de la configuración.'],
    ['sitios', 'Elegir qué ver en cada parada y apuntarlo.'],
    ['excursiones', 'Elegir excursiones que merezcan la pena y repartirlas.'],
    ['lienzo', 'Colocar lo apuntado en los días, respetando horarios y cierres.'],
  ];

  const meter = db.prepare(
    `INSERT OR IGNORE INTO prompts_orquestador (fase, prompt_actual, prompt_fabrica)
     VALUES (?, ?, ?)`
  );
  for (const [fase, texto] of FASES) {
    const placeholder = `[PENDIENTE DE ESCRIBIR] ${texto}`;
    meter.run(fase, placeholder, placeholder);
  }
}

/**
 * LA FASE 1 DEL ORQUESTADOR, YA CON CONTENIDO.
 *
 * Dos cosas: dónde guardar las ciudades que se pensaron y no entraron, y el
 * prompt de verdad en lugar del marcador de posición.
 *
 * LAS DESCARTADAS SE GUARDAN porque son trabajo ya hecho. La IA se ha molestado
 * en valorar Nara y en decir por qué no cabe en siete días; tirar eso obliga a
 * volver a preguntarlo el día que alguien quiera añadirla a mano.
 *
 * EL PROMPT SE PISA A PROPÓSITO, y es la única vez que se hará. Lo que había era
 * un `[PENDIENTE DE ESCRIBIR]` que no servía para nada; a partir de ahora, lo
 * que el usuario escriba en el cerebro manda y esta migración no vuelve a tocar
 * la fila —lleva su propia clave y solo corre una vez—.
 */
function migracionFase1Ciudades() {
  const CLAVE = '2026-09-fase1-ciudades';
  if (yaAplicada(CLAVE)) return false;

  const cols = db.prepare('PRAGMA table_info(viajes)').all().map((c) => c.name);
  if (!cols.includes('ciudades_candidatas')) {
    db.exec('ALTER TABLE viajes ADD COLUMN ciudades_candidatas TEXT');
  }

  const texto = promptDeCiudadesYNoches();
  db.prepare(
    `UPDATE prompts_orquestador
        SET prompt_actual = CASE
              -- Solo se pisa lo que nadie ha tocado. Si el usuario ya lo editó,
              -- su versión manda: para eso está la pantalla del cerebro.
              WHEN prompt_actual = prompt_fabrica THEN ?
              ELSE prompt_actual
            END,
            prompt_fabrica = ?
      WHERE fase = 'ciudades_y_noches'`
  ).run(texto, texto);

  marcarAplicada(CLAVE);
  console.log('[bd] Migración: prompt real de la fase «ciudades y noches».');
  return true;
}

/**
 * EL PROMPT DE FÁBRICA DE LA FASE 1.
 *
 * Va en dos secciones marcadas porque son dos llamadas con el mismo criterio en
 * medio: primero se piden candidatas, luego se buscan vuelos de verdad, y solo
 * después se cierra la ruta. Las dos mitades tienen que decir lo mismo sobre el
 * ritmo y los niños, y por eso se editan juntas y no en dos filas separadas.
 *
 * Los {{HUECOS}} los rellena services/orquestador-ciudades.js.
 */
function promptDeCiudadesYNoches() {
  return `=== PASO 1: CANDIDATAS ===
Eres un planificador de viajes con experiencia real en {{DESTINO}}.

EL VIAJE
- Destino: {{DESTINO}}
- {{FORMA_DEL_DESTINO}}
- Fechas: del {{FECHA_INICIO}} al {{FECHA_FIN}} ({{DIAS}} días, {{NOCHES}} noches)
- Salen desde: {{ORIGEN}}
- Viajeros: {{VIAJEROS}}
- Ritmo: {{RITMO}}
- Tipo de viaje: {{TIPO_VIAJE}}
- Les interesa: {{INTERESES}}

Propón hasta {{MAX_CIUDADES}} ciudades candidatas para este viaje. Todavía no
decides la ruta: pones sobre la mesa lo que merece la pena, con datos para poder
elegir después.

Devuelve SOLO este JSON:

{
  "ciudades": [
    {
      "nombre": "nombre en español de la ciudad",
      "peso": 1-5,
      "noches_min": número,
      "noches_max": número,
      "aeropuerto_internacional": true|false,
      "iata": "TYO"|null,
      "por_que": "una frase: qué tiene esta ciudad que no tengan las otras"
    }
  ],
  "tiempos": [
    {"desde": "ciudad", "hasta": "ciudad", "minutos": número, "modo": "tren|coche|vuelo|bus|barco"}
  ]
}

REGLAS, y la primera es la que más se incumple:

1. NO TE SALGAS DE {{DESTINO}}. Si el destino es un país, todas las ciudades son
   de ese país. Si el destino es UNA CIUDAD, el viaje es esa ciudad: la única
   candidata es ella, y solo añades otra si de verdad merece dormir allí —no un
   sitio que se ve en media jornada y se vuelve a cenar—. Proponer ciudades de
   otro país es el peor fallo que puedes cometer aquí.
2. LAS CIUDADES TIENEN QUE CABER EN {{DIAS}} DÍAS. No propongas ocho ciudades
   para una semana. Cuenta que cada cambio de ciudad se come medio día entre
   hacer maletas, trayecto y encontrar el alojamiento, y que por debajo de
   {{MINIMO_NOCHES}} noches una ciudad se duerme más de lo que se ve. Si el
   viaje es corto, propón pocas y buenas.
3. "peso" es cuánto merece la pena, de 1 a 5, y sirve para repartir noches
   después. No pongas todo a 5: si todo es imprescindible, no has priorizado.
4. "aeropuerto_internacional" en true SOLO si tiene aeropuerto con vuelos
   intercontinentales o europeos de verdad, no un aeródromo regional. De esto
   depende por dónde se entra al país, así que no lo pongas por cortesía.
5. AJUSTA A LOS VIAJEROS. Con niños pequeños, nada de tres trayectos largos en
   una semana: menos ciudades y más noches en cada una. Con ritmo tranquilo,
   igual. Con ritmo intenso puedes apretar, pero sin llegar a la paliza.
6. "tiempos" es tu ESTIMACIÓN de trayecto entre las candidatas que se podrían
   encadenar. No hace falta que estén todas contra todas: las que tengan sentido.
   Es una orientación, no un horario: no te inventes precisión que no tienes.
7. Los tiempos y las noches son números enteros. Nada de rangos dentro del JSON.

=== PASO 2: PUERTA DE ENTRADA Y SALIDA ===
Eres el mismo planificador. Ya se han buscado vuelos REALES a las mejores puertas
y toca decidir por dónde se entra y por dónde se sale.

EL VIAJE
- Destino: {{DESTINO}} · {{DIAS}} días, {{NOCHES}} noches
- Se sale desde: {{ORIGEN}}

LAS CIUDADES QUE PROPUSISTE
{{CANDIDATAS}}

TIEMPOS QUE ESTIMASTE ENTRE ELLAS
{{TIEMPOS}}

LAS COMBINACIONES CON VUELOS REALES
{{COMBINACIONES}}

Devuelve SOLO este JSON:

{ "elegida": "cN",
  "ruta_prevista": ["ciudad de entrada", "...", "ciudad de salida"],
  "minutos_internos": número,
  "por_que": "una o dos líneas" }

LA REGLA, Y NO ES LA QUE PARECE:

NO gana la combinación con menos minutos de vuelo. Gana la que da MENOS TIEMPO
TOTAL contando el aire Y la carretera de la ruta que esa entrada y esa salida
obligan a hacer por dentro.

Piénsalo así: por cada combinación, imagina la ruta que sale de entrar por una y
salir por la otra, pasando por las ciudades de más peso. Suma los traslados
internos de esa ruta con la tabla de tiempos de arriba. Esa suma, más los vuelos,
es lo que compite.

Media hora ganada en el aire no compensa cuatro horas de tren de más. Un ejemplo
real de este mismo programa: en Polonia se eligió entrar por Varsovia y salir por
Cracovia con Gdansk en medio, porque esos vuelos eran algo más cortos. La ruta
resultante subía al norte y volvía a bajar. Entrando por Gdansk se recorría el
país de una sola pasada.

EL RESTO DE CRITERIOS:

1. PREFIERE NO REPETIR CIUDAD de entrada y salida: entrar y salir por la misma
   obliga a volver sobre tus pasos al final del viaje.
2. PENALIZA las combinaciones que obliguen a pasar DOS VECES por la misma ciudad
   en mitad de la ruta. Pasar de largo por una ciudad camino de otra es normal;
   dormir, irse y volver, no.
3. Que la ruta siga la geografía: de una punta a la otra, sin zigzag.
4. Las ciudades de más peso tienen que caber. Una combinación que obliga a
   dejar fuera lo mejor del país no es buena aunque el avión sea corto.
5. "por_que" DICE LA VERDAD. Si la combinación que eliges desanda camino o repite
   paso por una ciudad, dilo y explica por qué compensa igual. Está PROHIBIDO
   describir como "lineal", "sin rodeos" o "de una pasada" una ruta que no lo es:
   quien lee esto lo hace para saber si fiarse.
6. "ruta_prevista" es LA ruta cuyos traslados internos has sumado para elegir.
   Solo puede contener ciudades candidatas NO descartadas, empezando por la
   entrada y acabando en la salida. Si una ciudad no está en la ruta, sus tiempos
   no entran en la suma: sumar minutos de un recorrido distinto del que declaras
   es el fallo exacto que motivó este cambio.
7. "minutos_internos" es esa suma, con la tabla de tiempos de arriba, tramo a
   tramo.

=== PASO 3: CIERRE ===
Eres el mismo planificador. Ya hay vuelos reales comprados y la puerta de entrada
y de salida están DECIDIDAS: no se discuten.

EL VIAJE
- Destino: {{DESTINO}}
- Fechas: del {{FECHA_INICIO}} al {{FECHA_FIN}}
- NOCHES A REPARTIR: {{NOCHES}}

  Ojo con esto, que es donde se falla: el viaje dura {{DIAS}} días pero se
  reparten {{NOCHES}} NOCHES. Son cosas distintas y siempre hay una noche menos
  que días, porque el último día se vuelve a casa y no se duerme allí. Lo que
  tienen que sumar tus paradas es {{NOCHES}}.
- Viajeros: {{VIAJEROS}} · Ritmo: {{RITMO}}
- Les interesa: {{INTERESES}}

ENTRADA Y SALIDA, YA FIJADAS CON VUELOS REALES
- Se entra por: {{ENTRADA}}
- Se sale por: {{SALIDA}}
- {{HORARIOS_VUELOS}}

RUTA PREVISTA AL ELEGIR LA PUERTA (con los vuelos ya comprados sobre esta base)
{{RUTA_PREVISTA}}

CANDIDATAS QUE PROPUSISTE
{{CANDIDATAS}}

TIEMPOS ENTRE ELLAS. Cada línea dice DE DÓNDE SALE el dato: del catálogo
(real), medido por carretera, o estimado por ti sin comprobar. Lo que ponga
"sin dato" es un hueco de verdad: ahí no sabes nada.
{{TIEMPOS}}

Cierra la ruta. Devuelve SOLO este JSON:

{
  "ruta": [
    {"ciudad": "nombre", "noches": número, "motivo": "solo si incumple el mínimo de noches"}
  ],
  "noches_totales": número,
  "descartadas": [
    {"ciudad": "nombre", "por_que": "por qué se queda fuera"}
  ],
  "resumen": "dos frases: por qué esta ruta y no otra, dicha con honestidad"
}

REGLA 1, Y ES LA QUE SE FALLA SIEMPRE: LAS NOCHES SUMAN {{NOCHES}}.

No {{NOCHES}} aproximadamente: {{NOCHES}} exactas. Antes de responder, SUMA las
noches que has puesto y escribe el resultado en "noches_totales". Si esa suma no
da {{NOCHES}}, tu respuesta no vale y hay que rehacerla.

Y cuando no cuadre, QUITA UNA CIUDAD. No repartas de menos para que quepan todas:
tres ciudades bien vistas valen más que cinco de pasada. Los rangos de noches de
las candidatas son una orientación de cuánto pide cada sitio, NO un presupuesto
que haya que gastar entero.

Ejemplo con 11 noches: 4 + 4 + 3 = 11 vale. 4 + 3 + 3 + 3 = 13 NO vale.

EL RESTO DE REGLAS:

2. LA PRIMERA PARADA ES {{ENTRADA}} Y LA ÚLTIMA ES {{SALIDA}}. Sin excepciones:
   los vuelos ya están comprados. Si entrada y salida son la misma ciudad, esa
   ciudad aparece al principio y al final, y son dos paradas distintas.
3. Ninguna parada con 0 noches. Si una ciudad no llega a una noche, no es una
   parada: es una excursión, y va fuera de la ruta.
   Y SI SOLO HAY UNA PARADA —un viaje a una sola ciudad—, esa parada se lleva
   LAS {{NOCHES}} NOCHES, y la ruta tiene un único elemento. No la partas en dos
   ni metas una segunda ciudad para rellenar.
4. Mínimo {{MINIMO_NOCHES}} noches por ciudad. Puedes bajar de ahí SOLO si es un
   tránsito obligado (se pasa por allí porque no hay otra forma de llegar), y
   entonces tienes que explicarlo en "motivo".
5. Ordena para no dar rodeos: sigue la geografía, no el orden en que se te
   ocurrieron. Un trayecto largo al principio se lleva mejor que al final.
6. No metas ciudades que no estén en las candidatas.
7. LAS NOCHES SE REPARTEN POR PESO, y el peso de cada candidata está escrito
   arriba. Una ciudad de peso alto se lleva más noches que una de peso bajo, y
   una ciudad del PESO MÁXIMO de la lista NO puede quedarse con el mínimo de
   {{MINIMO_NOCHES}} mientras otra de peso menor tiene más.
   Con 6 noches y tres ciudades de pesos 5, 4 y 5, lo que sale es 2-2-2.
   Si aun así una ciudad de peso máximo se queda corta, tiene que ser por una
   imposibilidad REAL —un horario de vuelo de los de arriba, un trayecto de los
   de la tabla de tiempos— y la explicas en "motivo" CITANDO ese dato.
   Cuenta también lo que se comen los vuelos, que sus horas sí las tienes: si se
   llega de madrugada esa primera noche casi no existe, y si se sale a primera
   hora la última tampoco.
8. LAS NOCHES SON EL MEDIO; LO QUE REPARTES ES TIEMPO ÚTIL.
   Con la tabla de tiempos y los horarios de los vuelos, estima a qué hora se
   llega a cada parada y cuánto día real le queda: una parada a la que se llega
   a mediodía y de la que se sale a la mañana siguiente da media tarde, no un
   día. Si un sitio pide un día entero (monasterios repartidos, un yacimiento
   grande, una ciudad densa), la noche extra va ahí ANTES que a una parada que
   ya tiene un día completo y no lo llena.
   Escribe en el motivo la cuenta de tiempo útil de las paradas que queden
   justas.
9. LOS HORARIOS QUE NO ESTÉN ESCRITOS AQUÍ ARRIBA, NO LOS SABES.
   Tienes las horas de los vuelos y la tabla de tiempos entre ciudades. Nada
   más. PROHIBIDO decir que un tren "llega de madrugada", que un bus "sale a
   primera hora" o cualquier hora concreta que no te hayan dado: eso es
   inventárselo, y con un invento así se le quitaron dos noches a una ciudad en
   un viaje de verdad.
   Si para decidir te falta un horario, DILO tal cual en el "motivo" o en el
   "resumen" ("no tengo el horario del tren de X a Y") y reparte sin él.
10. TU PUNTO DE PARTIDA ES LA RUTA PREVISTA: tu trabajo es repartir las noches
   sobre ella, no inventar otra. Los vuelos se compraron con esa ruta delante.
   Solo puedes apartarte de ella si al repartir aparece una imposibilidad real
   —una parada se queda a 0 noches, un mínimo que no se cumple—, y entonces lo
   dices en el resumen: qué has cambiado respecto a la prevista y por qué.
11. EL "resumen" DICE LA VERDAD SOBRE LA FORMA DE LA RUTA. Si desanda camino, si
   repite paso por una ciudad o si hay un trayecto largo incómodo, se dice y se
   explica por qué compensa. PROHIBIDO llamar "lineal" o "sin rodeos" a una ruta
   que sube y vuelve a bajar: el resumen se lee para decidir si fiarse de lo que
   ha montado la máquina, y un resumen que adorna no sirve para eso.`;
}

/**
 * EL PROMPT DE LA FASE 1, AFINADO DESPUES DE PROBARLO.
 *
 * La primera version fallaba en lo mismo dos veces seguidas: la IA repartia 15 y
 * 14 noches en un viaje de 11. Los rangos de las candidatas se leian como un
 * presupuesto a gastar, y ninguna de las siete reglas le hacia hacer la suma.
 *
 * Ahora la cuenta es la regla 1, se le pide que escriba el total que le sale
 * —hacer la suma en voz alta es lo que hace que salga bien— y se le dice que
 * cuando no cuadre quite una ciudad en vez de estirar las noches.
 *
 * Solo se pisa lo que nadie haya editado: si el usuario ya afino el suyo, manda
 * el suyo.
 */
function migracionFase1PromptAfinado() {
  const CLAVE = '2026-09-fase1-prompt-afinado';
  if (yaAplicada(CLAVE)) return false;

  const texto = promptDeCiudadesYNoches();
  db.prepare(
    `UPDATE prompts_orquestador
        SET prompt_actual = CASE WHEN prompt_actual = prompt_fabrica THEN ? ELSE prompt_actual END,
            prompt_fabrica = ?
      WHERE fase = 'ciudades_y_noches'`
  ).run(texto, texto);

  marcarAplicada(CLAVE);
  console.log('[bd] Migración: prompt de la fase 1 afinado (la suma de noches).');
  return true;
}

/**
 * EL PROMPT DE LA FASE 1, ahora distinguiendo un pais de una ciudad.
 *
 * Probado con un viaje a Paris, la IA propuso Versalles, Amberes y Brujas. Las
 * dos ultimas estan en Belgica. El prompt pedia "ciudades candidatas" sin decir
 * en ningun sitio que el destino podia ser ya una ciudad, y con eso se puso a
 * montar una ruta por Europa.
 *
 * Ahora se le dice la forma del destino, y la primera regla es no salirse de el.
 */
function migracionFase1CiudadUnica() {
  const CLAVE = '2026-09-fase1-ciudad-unica';
  if (yaAplicada(CLAVE)) return false;

  const texto = promptDeCiudadesYNoches();
  db.prepare(
    `UPDATE prompts_orquestador
        SET prompt_actual = CASE WHEN prompt_actual = prompt_fabrica THEN ? ELSE prompt_actual END,
            prompt_fabrica = ?
      WHERE fase = 'ciudades_y_noches'`
  ).run(texto, texto);

  marcarAplicada(CLAVE);
  console.log('[bd] Migración: prompt de la fase 1 distingue país de ciudad.');
  return true;
}

/**
 * EL PROMPT DE LA FASE 1: dias y noches no son lo mismo.
 *
 * Con un viaje de 12 dias y 11 noches, la IA devolvio 12 noches dos veces
 * seguidas. Le llegaban los dos numeros y usaba el que no era. Ahora se le dice
 * la diferencia con todas las letras, y en el sitio donde se equivoca.
 */
function migracionFase1DiasVsNoches() {
  const CLAVE = '2026-09-fase1-dias-vs-noches';
  if (yaAplicada(CLAVE)) return false;

  const texto = promptDeCiudadesYNoches();
  db.prepare(
    `UPDATE prompts_orquestador
        SET prompt_actual = CASE WHEN prompt_actual = prompt_fabrica THEN ? ELSE prompt_actual END,
            prompt_fabrica = ?
      WHERE fase = 'ciudades_y_noches'`
  ).run(texto, texto);

  marcarAplicada(CLAVE);
  console.log('[bd] Migración: el prompt de la fase 1 separa días de noches.');
  return true;
}

/**
 * LA FASE 2 DEL ORQUESTADOR: traslados.
 *
 * Dos parametros nuevos y el prompt de verdad.
 *
 * LOS ACCESOS SON PARAMETROS Y NO CONSTANTES porque son justo lo que cambia de
 * una persona a otra: quien vive al lado de la estacion y quien tarda cuarenta
 * minutos en llegar al aeropuerto no deberian recibir la misma recomendacion. Y
 * son la mitad de la cuenta de puerta a puerta, que es toda esta fase.
 */
function migracionFase2Traslados() {
  const CLAVE = '2026-09-fase2-traslados';
  if (yaAplicada(CLAVE)) return false;

  const meter = db.prepare(
    `INSERT OR IGNORE INTO parametros_orquestador
       (clave, valor, valor_fabrica, descripcion, unidad, orden)
     VALUES (?, ?, ?, ?, ?, ?)`
  );
  meter.run('acceso_aeropuerto_min', '45', '45',
    'Cuánto se tarda del centro al aeropuerto (y del aeropuerto al centro al llegar)', 'minutos', 11);
  meter.run('acceso_estacion_min', '25', '25',
    'Lo mismo para la estación de tren o autobús', 'minutos', 12);

  const texto = promptDeTraslados();
  db.prepare(
    `UPDATE prompts_orquestador
        SET prompt_actual = CASE WHEN prompt_actual = prompt_fabrica THEN ? ELSE prompt_actual END,
            prompt_fabrica = ?
      WHERE fase = 'traslados'`
  ).run(texto, texto);

  marcarAplicada(CLAVE);
  console.log('[bd] Migración: fase 2 del orquestador (traslados).');
  return true;
}

/**
 * EL PROMPT DE FABRICA DE LA FASE 2.
 *
 * Se le dan las opciones YA MEDIDAS puerta a puerta y la regla de empate ya
 * resuelta. No se le pide que calcule: sumar es lo que peor hace y aqui la suma
 * decide. Se le pide lo que si sabe hacer, que es elegir con criterio de viajero
 * y poner una hora de salida que no destroce la manana.
 */
function promptDeTraslados() {
  return `Eres quien decide cómo se va de una ciudad a otra en un viaje ya planificado.

EL SALTO
- De {{DESDE}} a {{HASTA}}, el día {{DIA}}
- Viajeros: {{VIAJEROS}}
- Ritmo del viaje: {{RITMO}}

LAS OPCIONES, ya medidas puerta a puerta
{{OPCIONES}}

REGLA DE EMPATE POR PRECIO (ya comprobada, no la recalcules)
{{REGLA_DEL_EMPATE}}

Elige una y devuelve SOLO este JSON:

{
  "elegida": "opN",
  "hora_salida": "10:05",
  "por_que": "una línea, concreta: por qué esta y no otra"
}

REGLAS:

1. LOS TIEMPOS YA ESTÁN CALCULADOS Y SON PUERTA A PUERTA: incluyen ir a la
   estación o al aeropuerto, la antelación, el trayecto y salir al llegar. No los
   recalcules ni compares duraciones de trayecto: un vuelo de 55 minutos puede
   ser peor que un tren de 2h30 y por eso están medidos así.
2. GANA LA MÁS RÁPIDA PUERTA A PUERTA, salvo que arriba diga que se cumple la
   regla de empate por precio. Si se cumple, gana la barata.
3. LA HORA DE SALIDA es la del transporte, y tiene que caber en el día del
   cambio. Con ritmo tranquilo o normal, nada de salir del hotel antes de las
   8:00: eso significa no coger nada que salga antes de las 9:00 en tren ni antes
   de las 10:00 en avión. Con ritmo intenso puedes apretar una hora.
   Si en "horarios" hay frecuencias en vez de horas concretas, propón una hora
   razonable que encaje con esa frecuencia.
4. ENTRE UN TRANSPORTE CON HORARIO Y UNO SIN ÉL, gana el que lo tiene. Un tren
   o un autobús salen cuando dicen; un coche de alquiler hay que recogerlo,
   devolverlo y aparcarlo, y un viaje compartido depende de que un desconocido
   no cancele. Esos minutos no están en la tabla de arriba, así que tenlos en
   cuenta tú: solo elige coche o viaje compartido si gana por MUCHO —más de una
   hora— o si no hay transporte público que haga ese trayecto.
5. Con niños, un transbordo menos vale más que media hora menos.
6. "por_que" en UNA línea y concreta: "sale a las 10:05 y llega a comer, sin
   madrugón" sirve; "es la mejor opción" no dice nada.
7. Devuelve el identificador tal cual viene ("op1", "op2"…). Si te inventas uno
   que no está en la lista, la elección se pierde.`;
}

/**
 * EL PROMPT DE LA FASE 2: mejor un transporte con horario.
 *
 * Probado con Polonia, eligio "Alquiler de coches" para ir de Cracovia a Wroclaw
 * y "BlaBlaCar" para ir de Wroclaw a Varsovia. Los dos ganaban por minutos en la
 * tabla, y la tabla no sabe que un coche hay que recogerlo y devolverlo ni que
 * un viaje compartido lo puede cancelar alguien. Esos minutos no se pueden
 * calcular, asi que se le dicen.
 */
function migracionFase2ConHorario() {
  const CLAVE = '2026-09-fase2-con-horario';
  if (yaAplicada(CLAVE)) return false;

  const texto = promptDeTraslados();
  db.prepare(
    `UPDATE prompts_orquestador
        SET prompt_actual = CASE WHEN prompt_actual = prompt_fabrica THEN ? ELSE prompt_actual END,
            prompt_fabrica = ?
      WHERE fase = 'traslados'`
  ).run(texto, texto);

  marcarAplicada(CLAVE);
  console.log('[bd] Migración: la fase 2 prefiere transporte con horario.');
  return true;
}

/**
 * EL MARGEN DEL COCHE, que faltaba en la cuenta de puerta a puerta.
 *
 * Recoger un alquiler, revisarlo, devolverlo y aparcar al llegar no esta en la
 * duracion del trayecto. Sin contarlo, el coche ganaba saltos entre ciudades por
 * veinte minutos frente a un tren directo. Vale tambien para el viaje compartido,
 * donde el margen es esperar a alguien que puede no aparecer.
 */
function migracionMargenDelCoche() {
  const CLAVE = '2026-09-margen-del-coche';
  if (yaAplicada(CLAVE)) return false;

  db.prepare(
    `INSERT OR IGNORE INTO parametros_orquestador
       (clave, valor, valor_fabrica, descripcion, unidad, orden)
     VALUES (?, ?, ?, ?, ?, ?)`
  ).run('margen_coche_min', '60', '60',
    'Lo que se pierde con un coche de alquiler o un viaje compartido: recogerlo, devolverlo, aparcar o esperar al conductor',
    'minutos', 13);

  marcarAplicada(CLAVE);
  console.log('[bd] Migración: margen del coche en el puerta a puerta.');
  return true;
}

/**
 * LOS MARGENES DEL COCHE Y DEL VIAJE COMPARTIDO, con valores realistas.
 *
 * El primer intento puso una hora para los dos y salio al reves de lo buscado: a
 * un alquiler se le quitaba el acceso a la estacion y se le ponia menos margen
 * que la suma que tenia antes, o sea que se volvia mas rapido. Recoger un coche,
 * revisarlo, devolverlo con gasolina y aparcar en un centro historico son dos
 * horas largas; esperar a un BlaBlaCar en su punto de encuentro, tres cuartos.
 */
function migracionMargenesRealistas() {
  const CLAVE = '2026-09-margenes-realistas';
  if (yaAplicada(CLAVE)) return false;

  db.prepare(
    `INSERT OR IGNORE INTO parametros_orquestador
       (clave, valor, valor_fabrica, descripcion, unidad, orden)
     VALUES (?, ?, ?, ?, ?, ?)`
  ).run('margen_viaje_compartido_min', '45', '45',
    'Lo que se pierde esperando un viaje compartido en su punto de encuentro', 'minutos', 14);

  // El del alquiler sube a lo que de verdad cuesta: solo si nadie lo ha tocado.
  db.prepare(
    `UPDATE parametros_orquestador
        SET valor = CASE WHEN valor = valor_fabrica THEN '120' ELSE valor END,
            valor_fabrica = '120',
            descripcion = 'Lo que se pierde con un coche de alquiler: recogerlo, revisarlo, devolverlo y aparcar'
      WHERE clave = 'margen_coche_min'`
  ).run();

  marcarAplicada(CLAVE);
  console.log('[bd] Migración: márgenes realistas de coche y viaje compartido.');
  return true;
}

/**
 * LA FASE 3 DEL ORQUESTADOR: dormir.
 *
 * Dos parametros de relajacion y el prompt de verdad. Los porcentajes son
 * parametros y no constantes porque son la unica forma de decir "prefiero pagar
 * un poco mas antes que dormir a las afueras" sin tocar codigo.
 */
function migracionFase3Dormir() {
  const CLAVE = '2026-09-fase3-dormir';
  if (yaAplicada(CLAVE)) return false;

  const meter = db.prepare(
    `INSERT OR IGNORE INTO parametros_orquestador
       (clave, valor, valor_fabrica, descripcion, unidad, orden)
     VALUES (?, ?, ?, ?, ?, ?)`
  );
  meter.run('relajacion_precio_pct', '25', '25',
    'Cuánto se sube el techo de precio cada vez que una búsqueda de alojamiento no da resultados', '%', 15);
  meter.run('relajacion_precio_max_veces', '2', '2',
    'Cuántas veces se puede subir ese techo antes de empezar a soltar otros filtros', 'veces', 16);

  const texto = promptDeDormir();
  db.prepare(
    `UPDATE prompts_orquestador
        SET prompt_actual = CASE WHEN prompt_actual = prompt_fabrica THEN ? ELSE prompt_actual END,
            prompt_fabrica = ?
      WHERE fase = 'dormir'`
  ).run(texto, texto);

  marcarAplicada(CLAVE);
  console.log('[bd] Migración: fase 3 del orquestador (dormir).');
  return true;
}

/** El prompt de fabrica de la fase 3, en sus dos pasos. */
function promptDeDormir() {
  return `=== PASO 1: TRADUCIR EL NIVEL DE PRECIO ===
Conoces el mercado de alojamiento de {{CIUDAD}}.

- Ciudad: {{CIUDAD}}{{PAIS}}
- Fechas: del {{FECHA_ENTRADA}} al {{FECHA_SALIDA}}
- Nivel pedido: {{NIVEL}}
- Viajeros: {{VIAJEROS}}
- Tipo de alojamiento: {{TIPO}}

¿Cuánto cuesta POR NOCHE un alojamiento decente de nivel "{{NIVEL}}" en {{CIUDAD}}
en esas fechas, para esos viajeros? Devuelve un rango en euros.

Devuelve SOLO este JSON:

{ "min_por_noche": número, "max_por_noche": número, "por_que": "media línea" }

REGLAS:

1. EL PRECIO ES DE ESA CIUDAD, no de una capital europea cualquiera. Lo mismo
   vale muy distinto en Cracovia que en Zúrich, y ese es justo el motivo de esta
   pregunta.
2. Ten en cuenta la TEMPORADA de esas fechas: en agosto o en Navidad sube.
3. Es el precio de la HABITACIÓN o el apartamento entero por noche, no por
   persona.
4. "económico" no es un albergue con literas ni "alto" es un cinco estrellas de
   lujo: son gamas de alojamiento normal, decente y bien situado.
5. El rango tiene que ser ancho de verdad —lo típico es que el techo sea casi el
   doble del suelo—: si lo aprietas demasiado, la búsqueda se queda sin nada.

=== PASO 2: ELEGIR ===
Eres quien elige dónde dormir en un viaje ya planificado.

LA PARADA
- Ciudad: {{CIUDAD}} · {{NOCHES}} noche(s) · {{VIAJEROS}}
- Se buscó con: {{FILTROS}}
- ¿Se sale temprano de aquí? {{SALIDA_TEMPRANA}}

LAS OPCIONES
{{OPCIONES}}

Elige una y devuelve SOLO este JSON:

{ "elegida": "opN", "por_que": "dos líneas como mucho, concretas" }

CRITERIOS, por orden:

1. BIEN SITUADO PARA LO QUE SE VA A HACER: cerca del centro histórico o de la
   zona donde está lo que se visita. Un hotel barato a cuarenta minutos en
   autobús cuesta dos horas al día, y eso no sale a cuenta en ninguna moneda.
2. MEJOR RELACIÓN VALORACIÓN/PRECIO dentro de lo que hay. Un 8,9 a 70 € gana a
   un 9,4 a 130 €; pero un 7,2 a 45 € no gana a un 8,8 a 60 €.
3. Si arriba dice que se sale temprano de esta parada, la cercanía a la estación
   o al aeropuerto cuenta como criterio secundario: no por encima de estar bien
   situado, pero sí para desempatar.
4. Desconfía de lo que tenga muy pocas opiniones: una nota de 9,8 con once
   opiniones dice menos que un 8,6 con dos mil.
5. "por_que" concreto y en dos líneas como mucho: dónde está, qué tiene y qué
   se ha descartado a cambio. "Es el mejor" no explica nada.
6. Devuelve el identificador tal cual ("op1", "op2"…).`;
}

/**
 * LA FASE 4 DEL ORQUESTADOR: sitios.
 *
 * El prompt de esta fase no genera nada: es el bloque que se le AÑADE a la
 * generacion de siempre para decirle como usar los intereses declarados. Por eso
 * es corto y por eso es justo lo que hay que poder afinar: la diferencia entre
 * "sesga" y "filtra" son dos frases, y la segunda deja un viaje a Cracovia sin
 * Wawel.
 */
function migracionFase4Sitios() {
  const CLAVE = '2026-09-fase4-sitios';
  if (yaAplicada(CLAVE)) return false;

  const texto = promptDeSitios();
  db.prepare(
    `UPDATE prompts_orquestador
        SET prompt_actual = CASE WHEN prompt_actual = prompt_fabrica THEN ? ELSE prompt_actual END,
            prompt_fabrica = ?
      WHERE fase = 'sitios'`
  ).run(texto, texto);

  marcarAplicada(CLAVE);
  console.log('[bd] Migración: fase 4 del orquestador (sitios).');
  return true;
}

/** El prompt de fabrica de la fase 4: como usar los intereses. */
function promptDeSitios() {
  return `LO QUE LE INTERESA A QUIEN VIAJA

Lo ha escrito así: "{{INTERESES}}"
Y ha marcado estas categorías: {{CATEGORIAS}}

Esto SESGA lo que propones, no lo decide. La diferencia importa:

1. LOS IMPRESCINDIBLES DE LA CIUDAD ENTRAN IGUAL, encajen o no con sus intereses.
   Quien dice que le interesa la naturaleza no quiere un viaje a Cracovia sin el
   castillo de Wawel ni el casco viejo: quiere naturaleza ADEMÁS de eso. Dejar
   fuera lo que todo el mundo va a ver no es personalizar, es fallar.
2. LO QUE CAMBIA ES EL RESTO. Con los imprescindibles puestos, los huecos que
   quedan se llenan con lo que encaje con sus intereses antes que con lo
   genérico. Ahí es donde se nota que el viaje es suyo.
3. QUE NINGÚN INTERÉS SE QUEDE A CERO. Si ha dicho "naturaleza" y la ciudad
   tiene algo de eso —un parque grande, un río, una excursión a la montaña o a
   unas minas—, tiene que aparecer al menos una cosa. Si la ciudad de verdad no
   tiene nada de eso, no te lo inventes: es una respuesta correcta.
4. Los intereses valen para los tres bloques, también para el de niños.`;
}

/**
 * LA FASE 5 DEL ORQUESTADOR: excursiones.
 *
 * UNA COLUMNA Y UN PROMPT.
 *
 * `cubierto_por` es la regla del solapamiento hecha dato. Auschwitz es un sitio
 * de la ficha de Cracovia Y una excursion de Civitatis: son la misma visita
 * contada dos veces. Si se elige la excursion, el sitio queda marcado como
 * cubierto por ella, y el lienzo sabra que programar los dos es programar lo
 * mismo dos veces.
 *
 * Guarda el id del candidato de la excursion, no un simple si/no: asi, si se
 * quita la excursion, se puede saber que sitio vuelve a quedar libre.
 */
function migracionFase5Excursiones() {
  const CLAVE = '2026-09-fase5-excursiones';
  if (yaAplicada(CLAVE)) return false;

  const cols = db.prepare('PRAGMA table_info(sitios_lugar)').all().map((c) => c.name);
  if (!cols.includes('cubierto_por')) {
    db.exec('ALTER TABLE sitios_lugar ADD COLUMN cubierto_por INTEGER');
  }

  const texto = promptDeExcursiones();
  db.prepare(
    `UPDATE prompts_orquestador
        SET prompt_actual = CASE WHEN prompt_actual = prompt_fabrica THEN ? ELSE prompt_actual END,
            prompt_fabrica = ?
      WHERE fase = 'excursiones'`
  ).run(texto, texto);

  marcarAplicada(CLAVE);
  console.log('[bd] Migración: fase 5 del orquestador (excursiones).');
  return true;
}

/** El prompt de fabrica de la fase 5. */
function promptDeExcursiones() {
  return `Eres quien decide qué excursiones merecen la pena en un viaje ya planificado.

LA PARADA
- Ciudad: {{CIUDAD}} · {{NOCHES}} noche(s) · ritmo {{RITMO}}
- Viajeros: {{VIAJEROS}}
- Les interesa: {{INTERESES}}
- Topes que no puedes superar: {{TOPES}}

LO QUE YA VAN A VER POR SU CUENTA (fichas de sitios de esta parada)
{{SITIOS}}

LAS EXCURSIONES ENCONTRADAS
{{EXCURSIONES}}

Devuelve SOLO este JSON:

{
  "elegidas": [
    {"id": "exN", "por_que": "una línea", "cubre_sitios": ["nombre exacto de un sitio de la lista de arriba"]}
  ],
  "descartadas": [
    {"id": "exN", "por_que": "una línea"}
  ]
}

LA REGLA CENTRAL ES EL SOLAPAMIENTO:

Muchas excursiones son "visitar con guía" un sitio que ya está en su lista. No
son un extra: son la MISMA visita contada dos veces, y hay que elegir una.

- ELIGE LA EXCURSIÓN cuando el sitio gana mucho con quien lo explique: un campo
  de concentración, unas minas, un yacimiento, un templo con siglos de historia
  encima. Sin contexto, la mitad de lo que se ve no se entiende.
- PRESCINDE DE ELLA cuando el sitio se disfruta solo: miradores, parques,
  barrios, mercados, paseos. Pagar por que alguien te acompañe a un mirador es
  pagar por caminar acompañado.
- Cuando elijas una excursión que cubre un sitio de su lista, PONLO en
  "cubre_sitios" con el nombre exacto que tiene arriba. Es lo que evita que
  acaben con la misma visita dos veces en el calendario.

EL RESTO DE CRITERIOS:

1. PRIORIDAD A LO QUE NO SE PUEDE HACER POR LIBRE: una salida en balsa por un
   cañón, una excursión a un sitio sin transporte público, algo que necesita
   permiso o guía obligatorio. Ahí la excursión no compite con nada.
2. CANTIDAD SEGÚN LAS NOCHES Y EL RITMO. Los topes de arriba son el máximo
   absoluto, no el objetivo. Con 2 noches y ritmo tranquilo no caben dos
   excursiones de día completo: quedaría un viaje sin ver la ciudad. Es
   perfectamente correcto no elegir NINGUNA si ninguna aporta.
3. CON NIÑOS, mira la duración y la hora: una salida de doce horas o a las seis
   de la mañana no funciona con niños pequeños, por buena que sea.
4. Los intereses declarados desempatan, pero no mandan sobre lo anterior.
5. Justifica cada elegida y cada descartada que estuviera cerca de entrar. Las
   que no vengan a cuento no hace falta ni mencionarlas.
6. Devuelve los identificadores tal cual ("ex1", "ex2"…).`;
}

/**
 * LA PUERTA SE ELIGE POR LA RUTA ENTERA, no por los minutos de vuelo.
 *
 * En Polonia salio entrar por Varsovia y salir por Cracovia con Gdansk en medio:
 * los vuelos eran algo mas cortos y la ruta subia al norte y volvia a bajar. La
 * puerta y la forma de la ruta son la misma decision, asi que ahora se deciden
 * juntas y con la matriz de tiempos delante.
 *
 * Si el usuario ya edito su prompt, NO se pisa: solo se actualiza el de fabrica,
 * y el codigo aguanta que su version no tenga la seccion nueva.
 */
function migracionFase1PuertaPorRuta() {
  const CLAVE = '2026-09-fase1-puerta-por-ruta';
  if (yaAplicada(CLAVE)) return false;

  const texto = promptDeCiudadesYNoches();
  const fila = db
    .prepare("SELECT prompt_actual, prompt_fabrica FROM prompts_orquestador WHERE fase = 'ciudades_y_noches'")
    .get();
  const loEdito = fila && fila.prompt_actual !== fila.prompt_fabrica;

  db.prepare(
    `UPDATE prompts_orquestador
        SET prompt_actual = CASE WHEN prompt_actual = prompt_fabrica THEN ? ELSE prompt_actual END,
            prompt_fabrica = ?
      WHERE fase = 'ciudades_y_noches'`
  ).run(texto, texto);

  marcarAplicada(CLAVE);
  console.log(
    '[bd] Migración: la puerta de entrada se elige por la ruta entera.' +
      (loEdito
        ? ' OJO: tu prompt de esta fase está editado y NO se ha tocado; para coger el criterio nuevo, pulsa «Restaurar de fábrica» en la pantalla del Orquestador.'
        : '')
  );
  return true;
}

/**
 * EL REPARTO DE NOCHES, CON DATOS EN VEZ DE INVENTOS.
 *
 * En un viaje a Polonia la IA justifico asi el reparto: "Cracovia absorbe solo
 * la noche de salida porque llega de madrugada tras 360 min de tren". El tren de
 * Gdansk a Cracovia sale a las 9:15 y llega sobre las 15:30: ni 360 minutos ni
 * madrugada. Con ese invento, una ciudad de peso maximo se quedo con una noche.
 *
 * Dos cambios, y los dos van juntos: la tabla de tiempos ahora dice DE DONDE
 * sale cada dato (catalogo, carretera o estimacion suya), y el prompt le
 * prohibe usar horarios que no le hayan dado. Ademas se le dice en claro que
 * una ciudad de peso maximo no se queda con el minimo de noches sin una
 * imposibilidad real y citada.
 *
 * Solo se pisa lo que nadie haya editado.
 */
function migracionFase1NochesPorPeso() {
  const CLAVE = '2026-09-fase1-noches-por-peso';
  if (yaAplicada(CLAVE)) return false;

  const texto = promptDeCiudadesYNoches();
  const fila = db
    .prepare("SELECT prompt_actual, prompt_fabrica FROM prompts_orquestador WHERE fase = 'ciudades_y_noches'")
    .get();
  const loEdito = fila && fila.prompt_actual !== fila.prompt_fabrica;

  db.prepare(
    `UPDATE prompts_orquestador
        SET prompt_actual = CASE WHEN prompt_actual = prompt_fabrica THEN ? ELSE prompt_actual END,
            prompt_fabrica = ?
      WHERE fase = 'ciudades_y_noches'`
  ).run(texto, texto);

  marcarAplicada(CLAVE);
  console.log(
    '[bd] Migracion: las noches se reparten por peso y con horarios de verdad.' +
      (loEdito
        ? ' OJO: tu prompt de esta fase esta editado y NO se ha tocado; para coger el criterio nuevo, pulsa «Restaurar de fabrica» en la pantalla del Orquestador.'
        : '')
  );
  return true;
}

/**
 * LA PUERTA DECLARA LA RUTA QUE HA SUMADO, Y EL CIERRE PARTE DE ELLA.
 *
 * En un viaje a Polonia el paso 2 justifico su eleccion sumando los traslados de
 * una ruta que pasaba por Lodz —una ciudad que estaba descartada— y despues el
 * paso 3 monto otra ruta distinta. O sea: los vuelos se compraron con las
 * cuentas de un recorrido que no existio nunca, y nadie podia verlo porque la
 * ruta que se sumaba no se escribia en ninguna parte.
 *
 * Dos cambios que van juntos:
 *
 *   · El paso 2 devuelve "ruta_prevista" y "minutos_internos": la ruta cuyos
 *     tramos ha sumado y cuanto suman. Con eso, el codigo puede comprobar que
 *     solo lleva candidatas vivas y dejarlo escrito en el registro.
 *   · El paso 3 la recibe como punto de partida y solo puede apartarse de ella
 *     por una imposibilidad real, diciendolo en el resumen.
 *
 * Solo se pisa lo que nadie haya editado.
 */
function migracionFase1RutaPrevista() {
  const CLAVE = '2026-09-fase1-ruta-prevista';
  if (yaAplicada(CLAVE)) return false;

  const texto = promptDeCiudadesYNoches();
  const fila = db
    .prepare("SELECT prompt_actual, prompt_fabrica FROM prompts_orquestador WHERE fase = 'ciudades_y_noches'")
    .get();
  const loEdito = fila && fila.prompt_actual !== fila.prompt_fabrica;

  db.prepare(
    `UPDATE prompts_orquestador
        SET prompt_actual = CASE WHEN prompt_actual = prompt_fabrica THEN ? ELSE prompt_actual END,
            prompt_fabrica = ?
      WHERE fase = 'ciudades_y_noches'`
  ).run(texto, texto);

  marcarAplicada(CLAVE);
  console.log(
    '[bd] Migracion: la puerta declara su ruta prevista y el cierre parte de ella.' +
      (loEdito
        ? ' OJO: tu prompt de esta fase esta editado y NO se ha tocado; para coger el criterio nuevo, pulsa «Restaurar de fabrica» en la pantalla del Orquestador.'
        : '')
  );
  return true;
}

/**
 * EL PROMPT DE INVESTIGAR UN TRAMO, y por que ya no pide precios.
 *
 * Vivia escondido en services/movilidad.js. Ahora esta aqui como los demas, con
 * su fila en `prompts_orquestador`, editable desde la pantalla del Orquestador:
 * un prompt que decide cosas y que no se puede leer ni corregir desde la
 * aplicacion es un prompt que nadie revisa.
 *
 * Y LO IMPORTANTE: SE LE PROHIBE DAR PRECIOS.
 *
 * Este prompt devolvia el precio de cada medio y el modelo lo escribia de
 * memoria: el Pendolino de Gdansk a Cracovia salio a 120 EUR (cuesta unos 25),
 * FlixBus a 90 y un alquiler de coche a 1 EUR. Y en la ejecucion anterior, otros
 * numeros distintos para los mismos trayectos. Eso no es un dato: es un numero
 * con aspecto de dato, y encima entraba en la regla del empate, o sea que
 * decidia.
 *
 * La linea se traza donde de verdad esta:
 *
 *   · QUE MEDIOS HAY y QUIEN LOS OPERA es conocimiento estable: que entre esas
 *     dos ciudades hay tren de PKP Intercity y autobuses de FlixBus no cambia de
 *     un martes a otro, y el modelo lo sabe.
 *   · CUANTO SE TARDA y CADA CUANTO SALE cambia poco y sirve para ordenar. Se le
 *     pide, pero marcado como estimacion.
 *   · CUANTO CUESTA cambia cada dia, por hora y por antelacion. Ese sale de la
 *     busqueda, en un paso aparte, o se queda vacio.
 */
export function promptDeInvestigarTramo() {
  return `Dime como se va de {{DESDE}} a {{HASTA}} por tierra: que medios existen
de verdad hoy y quien los opera.

Un objeto por medio disponible: autobus, tren, ferry, coche de alquiler, traslado
privado. NO incluyas el avion: eso lo lleva la aplicacion por otro sitio.

Devuelve SOLO este JSON:
{"medios":[{
  "medio":"bus|tren|ferry|coche|traslado",
  "nombre":"nombre de la compañia o del servicio, corto",
  "duracion":"2 h 30",
  "frecuencia":"cada 2 h, 6 salidas al dia",
  "nota":"donde se coge, si hay que reservar, que conviene saber",
  "notaSentido":"solo si algun dato cambia segun la direccion; si no, cadena vacia",
  "web":"url oficial si la hay, si no cadena vacia"
}]}

REGLAS:

1. NO HAY CAMPO DE PRECIO Y NO DEBES INVENTARTE UNO. Si escribes un precio en
   cualquier campo, el dato se tira entero. El precio de cada opcion lo busca
   despues la aplicacion; si no lo encuentra, se queda vacio y se dice.
2. "duracion" y "frecuencia" son una ESTIMACION tuya y asi se van a enseñar. Da
   la que mejor sepas, en redondo, sin fingir precision: "unas 3 h" vale mas que
   "3 h 07".
3. El resto de datos, si no los sabes, cadena VACIA. NO te los inventes: es peor
   un horario falso que un hueco.
4. Entre 2 y 5 medios. Si de verdad solo hay uno, devuelve uno.
5. Si entre esas dos ciudades no hay transporte terrestre razonable, devuelve
   {"medios":[]}.
6. En español de España.`;
}

/**
 * EL PROMPT DE LOS TRAMOS SALE DEL CODIGO Y DEJA DE PEDIR PRECIOS.
 *
 * Dos cosas a la vez, porque son la misma: el texto se guarda en
 * `prompts_orquestador` —asi se puede leer y corregir desde la pantalla— y en
 * ese mismo movimiento se le quita el campo del precio, que era de donde salian
 * los 120 EUR del Pendolino.
 *
 * No hay nada que pisar: es una fila nueva.
 */
function migracionPromptDeTramos() {
  const CLAVE = '2026-09-prompt-tramos-sin-precio';
  if (yaAplicada(CLAVE)) return false;

  const texto = promptDeInvestigarTramo();
  db.prepare(
    `INSERT INTO prompts_orquestador (fase, prompt_actual, prompt_fabrica)
     VALUES ('traslados_investigar', ?, ?)
     ON CONFLICT (fase) DO UPDATE SET
       prompt_actual = CASE WHEN prompt_actual = prompt_fabrica THEN excluded.prompt_actual ELSE prompt_actual END,
       prompt_fabrica = excluded.prompt_fabrica`
  ).run(texto, texto);

  marcarAplicada(CLAVE);
  console.log('[bd] Migracion: el prompt de investigar tramos ya es editable y no pide precios.');
  return true;
}

/**
 * DE DONDE SALE EL PRECIO DE CADA OPCION DE TRASLADO.
 *
 * Hasta ahora la columna `precio` no decia su procedencia, y como el prompt se
 * los inventaba, todo el catalogo esta lleno de precios que parecen datos. Esta
 * columna los separa:
 *
 *   'busqueda' · lo trajo el Modo IA de Google en el paso de precios.
 *   'manual'   · lo escribiste tu en la ficha.
 *   NULL       · no se sabe de donde salio. Son las filas de antes de este
 *                cambio, y se tratan como precio DESCONOCIDO: se siguen viendo
 *                (no se borra nada), pero no entran en la regla del empate ni se
 *                le pasan a la IA como si fueran ciertos.
 */
function migracionOrigenDelPrecioDeTramo() {
  const CLAVE = '2026-09-origen-precio-tramo';
  if (yaAplicada(CLAVE)) return false;

  anadirColumnaSiFalta('catalogo_transporte_tramo', 'precio_origen', 'TEXT');

  // Lo que escribio una persona SI se sabe de donde viene.
  db.exec(
    "UPDATE catalogo_transporte_tramo SET precio_origen = 'manual' " +
      "WHERE origen = 'manual' AND precio IS NOT NULL AND precio <> ''"
  );

  const sinRastro = db
    .prepare(
      "SELECT COUNT(*) AS n FROM catalogo_transporte_tramo WHERE precio IS NOT NULL AND precio <> '' AND precio_origen IS NULL"
    )
    .get().n;

  marcarAplicada(CLAVE);
  console.log(
    '[bd] Migracion: los precios de traslado guardan su procedencia.' +
      (sinRastro ? ` ${sinRastro} precio(s) antiguos quedan como desconocidos: se ven, pero ya no deciden.` : '')
  );
  return true;
}

/**
 * CUANTO DURA UNA VISITA CUANDO NADIE LO HA DICHO.
 *
 * Las fichas traen `tiempo_visita` de la busqueda ("2-3 horas", "45 min"), pero
 * no todas: en el viaje de Polonia el lienzo coloco doce cosas y ninguna llevaba
 * duracion. Sin duraciones el validador no puede ver un solape —todo dura cero
 * y todo cabe—, asi que el dia se llenaba y nadie avisaba.
 *
 * Cuando no hay dato se aplica un valor por categoria. Son numeros de
 * servilleta, y por eso son parametros: un museo pide mas que un mirador, y
 * quien mejor sabe cuanto pide cada cosa es quien viaja.
 */
function migracionDuracionesPorCategoria() {
  const CLAVE = '2026-09-duraciones-por-categoria';
  if (yaAplicada(CLAVE)) return false;

  const meter = db.prepare(
    `INSERT INTO parametros_orquestador (clave, valor, valor_fabrica, descripcion, unidad, orden)
     VALUES (?, ?, ?, ?, 'minutos', ?)
     ON CONFLICT (clave) DO NOTHING`
  );

  const desde = db.prepare('SELECT COALESCE(MAX(orden), 0) AS n FROM parametros_orquestador').get().n;
  const porCategoria = [
    ['visita_museos_min', 120, 'Lo que se reserva para un museo si su ficha no dice cuanto se tarda'],
    ['visita_monumentos_min', 75, 'Lo mismo para un monumento o un edificio que se visita por dentro'],
    ['visita_naturaleza_min', 120, 'Lo mismo para un parque, un bosque o una playa'],
    ['visita_miradores_min', 45, 'Lo mismo para un mirador: se sube, se mira y se baja'],
    ['visita_barrios_min', 90, 'Lo mismo para un barrio o un paseo'],
    ['visita_gastronomia_min', 60, 'Lo mismo para un sitio de comer o de probar algo'],
    ['visita_ocio_min', 150, 'Lo mismo para un parque de ocio o una actividad larga'],
    ['visita_compras_min', 60, 'Lo mismo para un mercado o una zona de tiendas'],
    ['visita_por_defecto_min', 90, 'Y cuando ni siquiera se sabe de que categoria es'],
  ];

  porCategoria.forEach(([clave, valor, descripcion], i) => {
    meter.run(clave, String(valor), String(valor), descripcion, desde + i + 1);
  });

  marcarAplicada(CLAVE);
  console.log('[bd] Migracion: duraciones por categoria para lo que se coloca en el lienzo.');
  return true;
}

/**
 * CUANTAS VECES SE REVISA EL LIENZO ANTES DE RENDIRSE.
 *
 * La fase 6 termina consultando los avisos de verdad y corrigiendo lo que
 * chirrie. Cada pasada cuesta una llamada, asi que se le pone tope: con dos o
 * tres se arregla lo que se puede arreglar, y lo que quede se dice en el
 * registro en vez de declarar que todo cuadra.
 */
function migracionPasadasDeRevision() {
  const CLAVE = '2026-09-pasadas-revision-lienzo';
  if (yaAplicada(CLAVE)) return false;

  const desde = db.prepare('SELECT COALESCE(MAX(orden), 0) AS n FROM parametros_orquestador').get().n;
  db.prepare(
    `INSERT INTO parametros_orquestador (clave, valor, valor_fabrica, descripcion, unidad, orden)
     VALUES ('max_revisiones_lienzo', '2', '2',
             'Cuantas veces se revisa y corrige el lienzo antes de dejar el aviso escrito',
             'pasadas', ?)
     ON CONFLICT (clave) DO NOTHING`
  ).run(desde + 1);

  marcarAplicada(CLAVE);
  console.log('[bd] Migracion: tope de pasadas de revision del lienzo.');
  return true;
}

/**
 * EL PROMPT DE LA VUELTA: un directo de madrugada no siempre gana.
 *
 * En un viaje a Grecia la vuelta ATH -> BCN se eligio a las 4:10 de la
 * madrugada por ser el unico directo del dia. Cumplia todos los filtros y por
 * eso nadie lo discutio, pero esa eleccion se come la ultima noche entera del
 * viaje: hay que salir del hotel a las dos.
 *
 * "Directo" deja de ser una regla y pasa a ser una preferencia con juicio. Y el
 * juicio se le pide a la IA con las dos opciones delante y una regla escrita,
 * que es editable como todas las demas.
 */
export function promptDelVueloDeVuelta() {
  return `Hay que elegir el vuelo de vuelta de {{CIUDAD}} a casa el {{FECHA}}.

LAS DOS OPCIONES SOBRE LA MESA

- DIRECTO: sale a las {{DIRECTO_SALIDA}}, llega a las {{DIRECTO_LLEGADA}},
  {{DIRECTO_DURACION}} de viaje{{DIRECTO_ESCALAS}}.
- CON ESCALA: sale a las {{ESCALA_SALIDA}}, llega a las {{ESCALA_LLEGADA}},
  {{ESCALA_DURACION}} de viaje{{ESCALA_ESCALAS}}.

LA REGLA

Un directo que sale de madrugada mata la ultima noche del viaje. Prefiere la
escala si llega a hora decente y no anade mas de {{MAX_HORAS_EXTRA}} horas de
viaje total; si la escala tampoco cumple la franja o alarga mas que eso, gana el
directo.

Se considera hora decente salir a partir de las {{HORA_MINIMA}}.

Devuelve SOLO este JSON:

{"elegido": "directo" | "escala", "por_que": "una linea, concreta"}

Y que el "por_que" diga la cuenta: cuantas horas de mas y que se gana a cambio.`;
}

/**
 * LOS DOS NUMEROS DE LA VUELTA.
 *
 * A partir de que hora se considera que un vuelo de vuelta respeta la ultima
 * noche, y cuanto viaje de mas se acepta a cambio de no madrugar de esa manera.
 * Son parametros porque la respuesta no es la misma para todo el mundo: hay
 * quien prefiere plantarse en casa a mediodia aunque le cueste levantarse a las
 * dos de la manana.
 */
function migracionVueltaDecente() {
  const CLAVE = '2026-09-vuelta-decente';
  if (yaAplicada(CLAVE)) return false;

  const desde = db.prepare('SELECT COALESCE(MAX(orden), 0) AS n FROM parametros_orquestador').get().n;
  const meter = db.prepare(
    `INSERT INTO parametros_orquestador (clave, valor, valor_fabrica, descripcion, unidad, orden)
     VALUES (?, ?, ?, ?, ?, ?)
     ON CONFLICT (clave) DO NOTHING`
  );

  meter.run(
    'hora_minima_salida_vuelta',
    '08:00',
    '08:00',
    'Antes de esta hora, el vuelo de vuelta se come la ultima noche del viaje',
    'hora',
    desde + 1
  );
  meter.run(
    'max_horas_extra_por_escala',
    '2',
    '2',
    'Cuanto viaje de mas se acepta por una escala que salve esa ultima noche',
    'horas',
    desde + 2
  );

  const texto = promptDelVueloDeVuelta();
  db.prepare(
    `INSERT INTO prompts_orquestador (fase, prompt_actual, prompt_fabrica)
     VALUES ('vuelo_de_vuelta', ?, ?)
     ON CONFLICT (fase) DO UPDATE SET
       prompt_actual = CASE WHEN prompt_actual = prompt_fabrica THEN excluded.prompt_actual ELSE prompt_actual END,
       prompt_fabrica = excluded.prompt_fabrica`
  ).run(texto, texto);

  marcarAplicada(CLAVE);
  console.log('[bd] Migracion: la vuelta de madrugada se discute, con sus dos parametros y su prompt.');
  return true;
}

/**
 * DOS CORRECTIVOS DE PROMPT TRAS EL VIAJE A GRECIA.
 *
 * FASE 1: las noches se repartian por peso y salia bien en noches y mal en
 * tiempo real. Meteora, que pide un dia entero de monasterios, recibio una noche
 * —llegada a las 14:05 y salida a las 10:00, o sea media tarde— y Delfos, que se
 * ve en un dia, recibio dos. La regla nueva le hace contar TIEMPO UTIL, que es
 * lo que de verdad se reparte.
 *
 * FASE 6: la IA intentaba colocar los bloques fijos —el vuelo, el traslado—
 * porque los veia en la descripcion del dia, y el cotejo de colocaciones los
 * contaba como perdidas. Ahora la seccion de los dias dice en claro que esos ya
 * estan puestos y no son suyos.
 *
 * Solo se pisa lo que nadie haya editado.
 */
function migracionCorrectivoGrecia() {
  const CLAVE = '2026-09-correctivo-grecia';
  if (yaAplicada(CLAVE)) return false;

  const pisar = (fase, texto) => {
    const fila = db
      .prepare('SELECT prompt_actual, prompt_fabrica FROM prompts_orquestador WHERE fase = ?')
      .get(fase);
    const loEdito = fila && fila.prompt_actual !== fila.prompt_fabrica;
    db.prepare(
      `UPDATE prompts_orquestador
          SET prompt_actual = CASE WHEN prompt_actual = prompt_fabrica THEN ? ELSE prompt_actual END,
              prompt_fabrica = ?
        WHERE fase = ?`
    ).run(texto, texto, fase);
    return loEdito;
  };

  const editados = [
    pisar('ciudades_y_noches', promptDeCiudadesYNoches()) ? 'ciudades y noches' : null,
    pisar('lienzo', promptDelLienzo()) ? 'lienzo' : null,
  ].filter(Boolean);

  marcarAplicada(CLAVE);
  console.log(
    '[bd] Migracion: reparto por tiempo util (fase 1) y bloques fijos declarados (fase 6).' +
      (editados.length
        ? ` OJO: tu prompt de ${editados.join(' y ')} esta editado y NO se ha tocado; para coger el criterio nuevo, pulsa «Restaurar de fabrica».`
        : '')
  );
  return true;
}

/**
 * LOS SLUGS DE CIVITATIS, DESCUBIERTOS Y GUARDADOS.
 *
 * El slug se fabricaba desde el nombre en español y con eso basta para Roma o
 * Cracovia, pero no para las transliteraciones: "Tesalonica" no existe en
 * Civitatis —se llama "salonica"— y "Meteora" tampoco —es "kalambaka"—. Las dos
 * paradas del viaje a Grecia se quedaron sin excursiones por eso.
 *
 * Ahora el slug se DESCUBRE en el indice de destinos del pais y se guarda aqui,
 * para no repetir el descubrimiento en cada viaje. `slug` a NULL significa "lo
 * he buscado y ese destino no esta en Civitatis", que tambien es una respuesta y
 * evita volver a abrir el navegador para nada.
 */
function migracionSlugsDeCivitatis() {
  const CLAVE = '2026-09-slugs-civitatis';
  if (yaAplicada(CLAVE)) return false;

  db.exec(`
    CREATE TABLE IF NOT EXISTS civitatis_destinos (
      nombre_norm TEXT PRIMARY KEY,
      nombre      TEXT NOT NULL,
      slug        TEXT,
      pais        TEXT,
      visto_en    TEXT NOT NULL DEFAULT (datetime('now'))
    );
  `);

  marcarAplicada(CLAVE);
  console.log('[bd] Migracion: los slugs de Civitatis se descubren una vez y se guardan.');
  return true;
}

/**
 * LAS RESERVAS: lo que el usuario cierra de verdad.
 *
 * La aplicacion monta el viaje —elige vuelo, hotel, excursiones— pero hasta
 * ahora no guardaba nada de lo que pasa DESPUES: el localizador del vuelo, el
 * codigo del bono, el numero de confirmacion del hotel. Eso acababa en un correo
 * y en la calle no aparece.
 *
 * Una reserva cuelga de un CANDIDATO —el vuelo elegido, el hotel de esa parada,
 * la excursion apuntada—, que es la cosa concreta que se ha reservado. Uno a
 * uno: un candidato tiene como mucho una reserva, y por eso `candidato_id` es
 * unico.
 *
 * `reservado` vive en el candidato y no aqui a proposito: es un estado de la
 * cosa («esto ya esta cerrado»), y desmarcarlo no puede borrar el localizador
 * que costo encontrar. Se apaga la luz, no se tira el papel.
 *
 * Los adjuntos —billetes, tarjetas de embarque, bonos— van a la tabla de
 * siempre con tipo 'reserva' y el id del candidato, asi que heredan el subir,
 * ver, borrar y el viaje dentro del ZIP del dosier sin tocar nada de eso.
 */
function migracionReservas() {
  const CLAVE = '2026-09-reservas';
  if (yaAplicada(CLAVE)) return false;

  db.exec(`
    CREATE TABLE IF NOT EXISTS reservas (
      id            INTEGER PRIMARY KEY AUTOINCREMENT,
      viaje_id      INTEGER NOT NULL REFERENCES viajes(id) ON DELETE CASCADE,
      candidato_id  INTEGER NOT NULL UNIQUE REFERENCES candidatos(id) ON DELETE CASCADE,
      localizador   TEXT,
      notas         TEXT,
      enlace        TEXT,
      creado_en     TEXT NOT NULL DEFAULT (datetime('now')),
      actualizado_en TEXT
    );
    CREATE INDEX IF NOT EXISTS idx_reservas_viaje ON reservas(viaje_id);
  `);

  anadirColumnaSiFalta('candidatos', 'reservado', 'INTEGER NOT NULL DEFAULT 0');

  const desde = db.prepare('SELECT COALESCE(MAX(orden), 0) AS n FROM parametros_orquestador').get().n;
  db.prepare(
    `INSERT INTO parametros_orquestador (clave, valor, valor_fabrica, descripcion, unidad, orden)
     VALUES ('dias_aviso_sin_reservar', '21', '21',
             'Cuando faltan menos dias que estos para salir, avisa de lo que sigue sin reservar',
             'dias', ?)
     ON CONFLICT (clave) DO NOTHING`
  ).run(desde + 1);

  marcarAplicada(CLAVE);
  console.log('[bd] Migracion: las reservas del viaje, con su localizador y sus adjuntos.');
  return true;
}

/**
 * LOS ADJUNTOS ACEPTAN UN CUARTO TIPO: 'reserva'.
 *
 * La tabla nacio con un CHECK que enumera los tres tipos que habia entonces, y
 * SQLite no sabe modificar un CHECK: hay que rehacer la tabla. Se hace con el
 * baile de siempre —crear la nueva, copiar TODO, cambiar los nombres— dentro de
 * una transaccion, asi que o sale entero o no sale nada. No se pierde ni una
 * fila: los adjuntos son papeles del viaje y no hay ninguno que sobre.
 *
 * El CHECK se queda, ojo, no se quita: es lo que impide que un dia entre un tipo
 * inventado y los adjuntos se queden colgando de nada.
 */
function migracionAdjuntosDeReserva() {
  const CLAVE = '2026-09-adjuntos-reserva';
  if (yaAplicada(CLAVE)) return false;

  const antes = db.prepare('SELECT COUNT(*) AS n FROM adjuntos').get().n;

  db.exec('BEGIN');
  try {
    db.exec(`
      CREATE TABLE adjuntos_nueva (
        id              INTEGER PRIMARY KEY AUTOINCREMENT,
        viaje_id        INTEGER NOT NULL REFERENCES viajes(id) ON DELETE CASCADE,
        tipo_elemento   TEXT    NOT NULL CHECK (tipo_elemento IN ('transporte','alojamiento','excursion','reserva')),
        elemento_id     INTEGER NOT NULL,
        nombre_archivo  TEXT    NOT NULL,
        nombre_original TEXT    NOT NULL,
        mime            TEXT    NOT NULL,
        tamano          INTEGER NOT NULL,
        subido_en       TEXT    NOT NULL DEFAULT (datetime('now'))
      );

      INSERT INTO adjuntos_nueva
        (id, viaje_id, tipo_elemento, elemento_id, nombre_archivo, nombre_original, mime, tamano, subido_en)
        SELECT id, viaje_id, tipo_elemento, elemento_id, nombre_archivo, nombre_original, mime, tamano, subido_en
          FROM adjuntos;

      DROP TABLE adjuntos;
      ALTER TABLE adjuntos_nueva RENAME TO adjuntos;

      CREATE INDEX IF NOT EXISTS idx_adjuntos_elemento ON adjuntos(tipo_elemento, elemento_id);
      CREATE INDEX IF NOT EXISTS idx_adjuntos_viaje ON adjuntos(viaje_id);
    `);
    db.exec('COMMIT');
  } catch (err) {
    db.exec('ROLLBACK');
    throw err;
  }

  const despues = db.prepare('SELECT COUNT(*) AS n FROM adjuntos').get().n;
  marcarAplicada(CLAVE);
  console.log(
    `[bd] Migracion: los adjuntos aceptan el tipo 'reserva' (${despues} de ${antes} filas conservadas).`
  );
  return true;
}

/**
 * LOS NUMEROS DEL CORRECTIVO DEL PELOPONESO.
 *
 * Cinco ajustes salidos de una ejecucion real, y cada uno trae su umbral. Van a
 * parametros y no a constantes porque los cinco son cuestion de gusto: a que
 * hora es un madrugon, cuanto dinero justifica una hora, cuanta antelacion pide
 * un aeropuerto. La aplicacion pone un valor sensato y quien viaja lo ajusta.
 */
function migracionCorrectivoPeloponeso() {
  const CLAVE = '2026-09-correctivo-peloponeso';
  if (yaAplicada(CLAVE)) return false;

  const meter = db.prepare(
    `INSERT INTO parametros_orquestador (clave, valor, valor_fabrica, descripcion, unidad, orden)
     VALUES (?, ?, ?, ?, ?, ?)
     ON CONFLICT (clave) DO NOTHING`
  );
  let orden = db.prepare('SELECT COALESCE(MAX(orden), 0) AS n FROM parametros_orquestador').get().n;
  const nuevo = (clave, valor, descripcion, unidad) => meter.run(clave, valor, valor, descripcion, unidad, ++orden);

  // --- 1) La hora a la que empieza a ser un madrugon ----------------------
  nuevo('hora_minima_tren', '09:00', 'Antes de esta hora, coger un tren es madrugar (con ritmo intenso, una hora menos)', 'hora');
  nuevo('hora_minima_avion', '10:00', 'Lo mismo para un avion: a las 10:00 en el aire son las 08:00 en el hotel', 'hora');
  nuevo('max_penalizacion_horario_min', '90', 'Cuanto tiempo de mas se acepta por cambiar a una opcion que respete esa hora', 'minutos');

  // --- 2) Lo que ocupa de verdad un vuelo -------------------------------
  nuevo('presentacion_vuelo_min', '150', 'Cuanto antes del despegue hay que estar ya en el aeropuerto', 'minutos');
  nuevo('presentacion_tren_min', '30', 'Lo mismo para un tren o un autobus', 'minutos');
  nuevo('acceso_por_defecto_min', '45', 'Cuanto se tarda en llegar al aeropuerto o la estacion cuando no se sabe', 'minutos');
  nuevo('salida_del_aeropuerto_min', '40', 'Maletas y salir: cuanto pasa desde que aterriza hasta que empieza el dia', 'minutos');

  // --- 3) El ahorro grande ----------------------------------------------
  nuevo('factor_ahorro_traslado', '4', 'Cuantas veces mas barata tiene que ser una opcion para que el ahorro mande', 'veces');
  nuevo('max_tiempo_extra_ahorro_min', '75', 'Cuanto tiempo de mas se acepta a cambio de ese ahorro', 'minutos');

  // --- 4) La joya que se queda fuera -------------------------------------
  nuevo('peso_minimo_aviso_candidata', '4', 'De este peso para arriba, si una candidata queda fuera del viaje se avisa', 'peso');

  // --- 5) El final del dia -----------------------------------------------
  nuevo('hora_maxima_inicio', '22:00', 'A partir de esta hora ya no se coloca nada en el lienzo', 'hora');
  nuevo('margen_tras_llegada_min', '60', 'Lo que se deja libre despues de una llegada antes de colocar nada', 'minutos');

  marcarAplicada(CLAVE);
  console.log('[bd] Migracion: los umbrales del correctivo del Peloponeso.');
  return true;
}

/**
 * EL REGISTRO DEL ORQUESTADOR, QUE YA NO SE BORRA.
 *
 * Hasta ahora lo que iba diciendo cada fase vivia en `orquestador_fases.log`, y
 * al relanzar una fase ese log se ponia a NULL: se perdia el rastro de lo que
 * habia decidido la vez anterior. Y ese rastro es justo lo que hace falta para
 * revisar un viaje montado solo —por que Gdansk y no Wroclaw, de donde salio ese
 * precio— y para comprobar si una fase mejora o empeora entre ejecuciones.
 *
 * Asi que las lineas se guardan aparte, una por fila, para siempre:
 *
 *   · `pasada` numera las ejecuciones de esa fase. Relanzar no pisa: suma una.
 *   · `origen` dice de donde sale el dato de esa linea —scraping, busqueda o
 *     IA—, que es la etiqueta que se pinta en la pantalla.
 *   · `creado_en` es la hora exacta, que es lo que ordena el historico.
 *
 * Lo que ya estuviera escrito en `log` se traspasa como pasada 1: nadie pierde
 * el registro del viaje que montara ayer.
 */
function migracionRegistroDelOrquestador() {
  const CLAVE = '2026-09-registro-orquestador';
  if (yaAplicada(CLAVE)) return false;

  db.exec(`
    CREATE TABLE IF NOT EXISTS orquestador_registro (
      id        INTEGER PRIMARY KEY AUTOINCREMENT,
      viaje_id  INTEGER NOT NULL REFERENCES viajes(id) ON DELETE CASCADE,
      fase      TEXT    NOT NULL,
      -- Que ejecucion de esa fase. La primera es 1; relanzarla escribe la 2.
      pasada    INTEGER NOT NULL DEFAULT 1,
      linea     TEXT    NOT NULL,
      -- scraping | busqueda | ia | NULL (la linea no lleva ningun dato)
      origen    TEXT,
      creado_en TEXT    NOT NULL DEFAULT (datetime('now'))
    );
    CREATE INDEX IF NOT EXISTS idx_orq_registro
      ON orquestador_registro(viaje_id, fase, pasada, id);
  `);

  anadirColumnaSiFalta('orquestador_fases', 'pasada', 'INTEGER NOT NULL DEFAULT 1');

  // El traspaso de lo que ya habia. Sin origen: son lineas de antes de que
  // existiera la etiqueta, y ponerles una ahora seria inventarsela.
  const meter = db.prepare(
    `INSERT INTO orquestador_registro (viaje_id, fase, pasada, linea, origen, creado_en)
     VALUES (?, ?, 1, ?, NULL, ?)`
  );
  let lineas = 0;
  for (const f of db.prepare('SELECT * FROM orquestador_fases WHERE log IS NOT NULL').all()) {
    for (const linea of String(f.log).split('\n').filter((t) => t.trim())) {
      meter.run(f.viaje_id, f.fase, linea, f.terminado_en ?? f.empezado_en ?? null);
      lineas += 1;
    }
  }

  marcarAplicada(CLAVE);
  console.log(
    `[bd] Migracion: el registro del orquestador ya no se borra` +
      (lineas ? ` (${lineas} lineas traspasadas del log anterior).` : '.')
  );
  return true;
}

/**
 * LA FASE 6 DEL ORQUESTADOR: el lienzo.
 *
 * Solo el prompt. Los parametros que usa —la comida y el tope de excursiones
 * largas— ya existian de fases anteriores.
 *
 * En este prompt hay una prohibicion que parece rara y es la mas importante: NO
 * se le dice cuantas visitas caben en un dia. Un dia lleno en Brujas y un dia
 * lleno en Tokio no se parecen en nada, y cualquier numero que se escriba aqui
 * sera el equivocado en la mitad de las ciudades.
 */
function migracionFase6Lienzo() {
  const CLAVE = '2026-09-fase6-lienzo';
  if (yaAplicada(CLAVE)) return false;

  const texto = promptDelLienzo();
  db.prepare(
    `UPDATE prompts_orquestador
        SET prompt_actual = CASE WHEN prompt_actual = prompt_fabrica THEN ? ELSE prompt_actual END,
            prompt_fabrica = ?
      WHERE fase = 'lienzo'`
  ).run(texto, texto);

  marcarAplicada(CLAVE);
  console.log('[bd] Migración: fase 6 del orquestador (el lienzo).');
  return true;
}

/** El prompt de fabrica de la fase 6. */
function promptDelLienzo() {
  return `Eres quien reparte los días de un viaje ya planificado. Te toca {{CIUDAD}}.

CÓMO ES ESTE VIAJE
- Ritmo: {{RITMO}} · Viajeros: {{VIAJEROS}}
- Franjas del día: {{FRANJAS}}
- La comida ocupa {{DURACION_COMIDA}} minutos.

LOS DÍAS QUE TIENES

Los bloques marcados como FIJO —vuelos y traslados— YA ESTÁN COLOCADOS. No son
tuyos: no los pongas en "plan", no les inventes referencia y no los muevas. Tu
trabajo es repartir lo de la lista de colocables ALREDEDOR de ellos.

{{DIAS}}

LO QUE HAY QUE COLOCAR
{{COLOCABLES}}

Devuelve SOLO este JSON:

{
  "dias": [
    {
      "dia": número,
      "por_que": "media línea: la idea del día",
      "plan": [
        {"ref": "s3", "franja": "manana|mediodia|tarde|noche", "hora": "10:00"},
        {"tipo": "comida", "franja": "mediodia", "hora": "13:30", "zona": "dónde toca comer"}
      ]
    }
  ],
  "fuera": [ {"ref": "s7", "por_que": "por qué no cabe"} ]
}

LAS REGLAS:

1. LOS BLOQUES FIJOS SON INTOCABLES. Un vuelo que llega a las 17:40 o un tren
   que sale a las 9:40 ya están puestos y no se mueven. Todo lo demás se coloca
   alrededor.
2. EL DÍA DE LLEGADA EMPIEZA CUANDO SE LLEGA, no antes: hay que contar el
   trayecto desde el aeropuerto y un respiro para dejar las maletas. Ese día va
   algo suave y cerca del hotel, o nada.
   EL DÍA DE SALIDA TERMINA CUANDO EMPIEZA EL BLOQUE DEL VIAJE. Si se sale por
   la mañana, ese día no lleva plan: es un día de maletas y aeropuerto.
3. LAS EXCURSIONES SON ANCLAS. Tienen hora y punto de encuentro: se colocan
   primero y el resto del día se monta alrededor. Nunca dos excursiones de día
   completo el mismo día (máximo {{MAX_LARGAS}} por día).
4. AGRUPA POR ZONAS. Todo lo que esté junto, el mismo día y seguido. Cruzar la
   ciudad dos veces en una tarde es media tarde perdida. Entre dos sitios
   consecutivos, cuenta el desplazamiento.
5. EL MARGEN NO ES RELLENO, ES LO QUE HACE QUE EL PLAN AGUANTE. Deja aire entre
   visitas libres; deja MÁS aire antes de cualquier cosa con hora de entrada
   —una excursión, un museo con pase—, porque llegar tarde a eso significa
   perderlo. Con ritmo intenso se aprieta, pero el margen NO desaparece nunca.
6. CUÁNTAS COSAS CABEN EN UN DÍA LO DECIDES TÚ MIRANDO LA CIUDAD. En una ciudad
   compacta, donde todo está a diez minutos andando, caben más cosas que en una
   donde cada trayecto son cuarenta minutos de metro. El ritmo es una guía, no
   una cifra: "tranquilo" en una megaciudad pueden ser dos visitas, y en un
   casco histórico pequeño, cuatro. No repartas por cupo.
7. COMER TODOS LOS DÍAS, un bloque de {{DURACION_COMIDA}} minutos entre las
   13:00 y las 15:00 aproximadamente, en la zona donde toque estar a esa hora.
   No elijas restaurante: solo la zona y la hora.
   Y no programes nada que pise la cena: con ritmo tranquilo, nada que siga
   después de las 20:30.
8. RESPETA LOS HORARIOS REALES. Si algo cierra el día que te toca, muévelo a
   otro día; si no cabe en ningún otro, déjalo en "fuera" diciendo que cierra.
   Con ritmo tranquilo no empieces antes de las 9:00 ni acabes más allá de las
   22:00; con intenso puedes madrugar por una excursión.
9. CON NIÑOS, alterna. Un plato fuerte y una pausa: un parque, un paseo, un
   sitio donde se pueda correr. Tres museos seguidos no funcionan.
10. NO HACE FALTA COLOCARLO TODO. Lo que no quepa va a "fuera" con su motivo, y
    se queda apuntado para quien quiera meterlo a mano. Un día razonable con un
    hueco vale más que un día perfecto en el papel e imposible en la calle.
11. USA LAS REFERENCIAS TAL CUAL VIENEN ("s1", "x2"…). Las que empiezan por "x"
    son excursiones y las que empiezan por "s", sitios. Si te inventas una que no
    está en la lista, esa colocación se pierde.
12. Los sitios marcados como [segundo nivel] entran DESPUÉS de los demás: son el
    relleno de los huecos que queden, no la primera opción.`;
}

/**
 * EL LIENZO TRABAJA CON LAS FICHAS GENERADAS, no con lo apuntado.
 *
 * En la primera ejecucion completa el lienzo quedo vacio: pedia candidatos con
 * "Me lo apunto" puesto y ninguna fase apunta sitios —la 4 los genera y tiene
 * dicho expresamente que no los apunte—. Ahora se reparten las fichas generadas
 * y el "Me lo apunto" se hace AL COLOCAR.
 *
 * Eso cambia como se nombran las piezas en el prompt: un sitio generado no tiene
 * id de candidato hasta que se coloca, asi que se usan referencias propias.
 */
function migracionFase6Referencias() {
  const CLAVE = '2026-09-fase6-referencias';
  if (yaAplicada(CLAVE)) return false;

  const texto = promptDelLienzo();
  const fila = db
    .prepare("SELECT prompt_actual, prompt_fabrica FROM prompts_orquestador WHERE fase = 'lienzo'")
    .get();
  const loEdito = fila && fila.prompt_actual !== fila.prompt_fabrica;

  db.prepare(
    `UPDATE prompts_orquestador
        SET prompt_actual = CASE WHEN prompt_actual = prompt_fabrica THEN ? ELSE prompt_actual END,
            prompt_fabrica = ?
      WHERE fase = 'lienzo'`
  ).run(texto, texto);

  marcarAplicada(CLAVE);
  console.log(
    '[bd] Migración: el lienzo reparte las fichas generadas.' +
      (loEdito
        ? ' OJO: tu prompt del lienzo está editado y NO se ha tocado. Pide "id" y el código ahora espera "ref": restáuralo de fábrica o cámbialo a mano, o no se colocará nada.'
        : '')
  );
  return true;
}

function migracionFichaRevisada() {
  const CLAVE = '2026-09-ficha-revisada';
  if (yaAplicada(CLAVE)) return false;

  const cols = db.prepare('PRAGMA table_info(viajes)').all().map((c) => c.name);
  if (!cols.includes('antes_revisado_en')) {
    db.exec('ALTER TABLE viajes ADD COLUMN antes_revisado_en TEXT');
  }

  marcarAplicada(CLAVE);
  console.log('[bd] Migración: "Antes de viajar" revisado.');
  return true;
}

function migracionCiudadDeOrigen() {
  const CLAVE = '2026-09-ciudad-de-origen';
  if (yaAplicada(CLAVE)) return false;

  const cols = db.prepare('PRAGMA table_info(viajes)').all().map((c) => c.name);
  if (!cols.includes('ciudad_origen')) {
    db.exec("ALTER TABLE viajes ADD COLUMN ciudad_origen TEXT NOT NULL DEFAULT 'Barcelona'");
  }

  marcarAplicada(CLAVE);
  console.log('[bd] Migración: ciudad de origen del viaje.');
  return true;
}

function migracionPaisDeEtapa() {
  const CLAVE = '2026-09-pais-de-etapa';
  if (yaAplicada(CLAVE)) return false;

  const cols = db.prepare('PRAGMA table_info(etapas)').all().map((c) => c.name);
  if (!cols.includes('pais')) db.exec('ALTER TABLE etapas ADD COLUMN pais TEXT');
  if (!cols.includes('codigo_pais')) db.exec('ALTER TABLE etapas ADD COLUMN codigo_pais TEXT');

  // Lo que ya se sepa por el catalogo se aprovecha; el resto se resolvera solo
  // la primera vez que alguien abra el panel.
  db.exec(`
    UPDATE etapas
       SET pais = (SELECT d.pais FROM destinos d WHERE d.id = etapas.destino_id)
     WHERE pais IS NULL AND destino_id IS NOT NULL
  `);

  marcarAplicada(CLAVE);
  console.log('[bd] Migración: país de cada parada.');
  return true;
}

function migracionFichaPais() {
  const CLAVE = '2026-09-ficha-pais';
  if (yaAplicada(CLAVE)) return false;

  db.exec(`
    CREATE TABLE IF NOT EXISTS fichas_pais (
      id           INTEGER PRIMARY KEY AUTOINCREMENT,
      pais_norm    TEXT NOT NULL,          -- sin acentos y en minusculas
      pais         TEXT NOT NULL,          -- como se escribe de verdad
      codigo_pais  TEXT,                   -- ISO-2, p.ej. "PT"
      fecha_inicio TEXT,                   -- las fechas con las que se genero
      fecha_fin    TEXT,
      datos        TEXT NOT NULL,          -- JSON con los dos bloques
      generado_en  TEXT NOT NULL DEFAULT (datetime('now')),
      UNIQUE (pais_norm, fecha_inicio, fecha_fin)
    );
    CREATE INDEX IF NOT EXISTS idx_ficha_pais ON fichas_pais (pais_norm);
  `);

  marcarAplicada(CLAVE);
  console.log('[bd] Migración: ficha práctica por país.');
  return true;
}

function migracionIata() {
  const CLAVE = '2026-09-iata-cache';
  if (yaAplicada(CLAVE)) return false;

  db.exec(`
    CREATE TABLE IF NOT EXISTS iata_ciudades (
      id         INTEGER PRIMARY KEY AUTOINCREMENT,
      ciudad_norm TEXT NOT NULL UNIQUE,   -- sin acentos y en minusculas
      ciudad      TEXT NOT NULL,          -- tal y como se escribio la primera vez
      codigo      TEXT,                   -- NULL = se busco y no se encontro
      aeropuerto  TEXT,                   -- el nombre, para poder explicarlo
      origen      TEXT NOT NULL,          -- lista/ia/manual
      buscado_en  TEXT NOT NULL DEFAULT (datetime('now')),
      creado_en   TEXT NOT NULL DEFAULT (datetime('now'))
    );
    CREATE INDEX IF NOT EXISTS idx_iata_norm ON iata_ciudades (ciudad_norm);
  `);

  marcarAplicada(CLAVE);
  console.log('[bd] Migración: caché de códigos IATA.');
  return true;
}

function migracionBusquedasEfimeras() {
  const CLAVE = '2026-09-busquedas-efimeras';
  if (yaAplicada(CLAVE)) return false;

  // --- Comer: de que busqueda es cada ficha --------------------------------
  const colsComer = db.prepare('PRAGMA table_info(catalogo_comer)').all().map((c) => c.name);
  if (!colsComer.includes('busqueda')) {
    db.exec('ALTER TABLE catalogo_comer ADD COLUMN busqueda TEXT');
  }

  // Lo que ya habia no pertenece a ninguna busqueda concreta: se queda en el
  // historico. Lo apuntado sale igual, que eso no depende de esta columna.
  db.exec("UPDATE catalogo_comer SET busqueda = 'antiguo' WHERE busqueda IS NULL");

  // --- Traslados: los que quiero tener a mano ------------------------------
  const colsTraslados = db.prepare('PRAGMA table_info(traslados)').all().map((c) => c.name);
  if (!colsTraslados.includes('fijado')) {
    db.exec('ALTER TABLE traslados ADD COLUMN fijado INTEGER NOT NULL DEFAULT 0');
  }

  // --- Movilidad: que no se dupliquen -------------------------------------
  const colsMov = db.prepare('PRAGMA table_info(catalogo_movilidad)').all().map((c) => c.name);
  if (!colsMov.includes('nombre_norm')) {
    db.exec('ALTER TABLE catalogo_movilidad ADD COLUMN nombre_norm TEXT');
  }

  const sinNorm = db.prepare('SELECT id, nombre FROM catalogo_movilidad WHERE nombre_norm IS NULL').all();
  const ponerNorm = db.prepare('UPDATE catalogo_movilidad SET nombre_norm = ? WHERE id = ?');
  for (const f of sinNorm) ponerNorm.run(normalizarNombre(f.nombre), f.id);

  // Si ya hubiera duplicados de antes, el indice unico no se podria crear: se
  // deja el primero de cada grupo, que es el que lleva mas tiempo y el que
  // puede tener direccion puesta a mano.
  db.exec(`
    DELETE FROM catalogo_movilidad
     WHERE id NOT IN (
       SELECT MIN(id) FROM catalogo_movilidad GROUP BY ciudad_norm, nombre_norm
     )
  `);
  db.exec(`
    CREATE UNIQUE INDEX IF NOT EXISTS idx_movilidad_unica
      ON catalogo_movilidad(ciudad_norm, nombre_norm)
  `);

  marcarAplicada(CLAVE);
  console.log('[bd] Migración: las búsquedas dejan de acumularse en pantalla.');
  return true;
}

/**
 * Migracion 18: bares y restaurantes.
 *
 * EL HUECO YA ESTABA HECHO. `lienzo.js` lleva desde su primera version con
 * `comer` entre los tipos de la mochila y con su icono; lo que faltaba era de
 * donde salen las fichas.
 *
 * ES CATALOGO, COMO LAS EXCURSIONES. Que la Casa Botin este en la calle
 * Cuchilleros y tenga 4,3 de nota no depende de mi viaje: se busca una vez por
 * ciudad y sirve para el siguiente. Por eso va por `ciudad_norm` y no por etapa,
 * igual que `catalogo_actividades`.
 *
 * Y ESO IMPORTA MAS AQUI QUE EN NINGUN SITIO, porque la fuente es Google Places
 * (New), que es la API CARA de las tres que usamos. Cada llamada se paga. La
 * regla es la misma que con Civitatis y hay que cumplirla a rajatabla:
 *
 *   - La busqueda pide los campos JUSTOS (field mask minima).
 *   - Lo que vuelve se guarda ENTERO en el catalogo.
 *   - Un sitio ya guardado NO se vuelve a pedir nunca.
 *   - Los detalles (telefono, web, horarios) solo BAJO DEMANDA, al abrir la
 *     ficha, y una sola vez. `detalles_en` es la marca de "esto ya se pidio":
 *     sin ella no se distinguiria un bar sin telefono de uno que no se ha
 *     mirado.
 *
 * `clave_unica` es el `place_id` de Google cuando viene de ahi, y `nombre:...`
 * cuando lo escribe la IA o yo a mano. Asi la misma busqueda repetida actualiza
 * la fila en vez de duplicarla, y una ficha escrita a mano no choca con nada.
 *
 * LAS COORDENADAS VIENEN PUESTAS. Places las devuelve, asi que un restaurante
 * de Google no necesita geocodificarse. Uno escrito a mano si, y por eso su
 * direccion vive donde la de todo lo demas: en la tabla `direcciones`.
 */
function migracionComer() {
  const CLAVE = '2026-09-comer';
  if (yaAplicada(CLAVE)) return false;

  db.exec(`
    CREATE TABLE IF NOT EXISTS catalogo_comer (
      id            INTEGER PRIMARY KEY AUTOINCREMENT,
      ciudad        TEXT NOT NULL,
      ciudad_norm   TEXT NOT NULL,
      -- place_id de Google, o "nombre:..." si lo dijo la IA o lo escribi yo.
      clave_unica   TEXT NOT NULL,
      nombre        TEXT NOT NULL,
      cocina        TEXT,               -- "tapas", "italiano", "de mercado"
      precio_nivel  INTEGER,            -- 1..4, como los simbolos de moneda
      precio_texto  TEXT,               -- "20-30 €" cuando alguien lo dice asi
      valoracion    REAL,
      num_opiniones INTEGER,
      direccion     TEXT,               -- la que da la fuente, tal cual
      telefono      TEXT,               -- se pinta SIEMPRE como enlace tel:
      web           TEXT,
      url_mapa      TEXT,               -- la ficha en Google Maps
      -- Places las trae puestas: un restaurante suyo no hay que geocodificarlo.
      lat           REAL,
      lng           REAL,
      horarios      TEXT,
      nota          TEXT,
      origen        TEXT NOT NULL DEFAULT 'places',   -- places / ia / manual
      -- La marca de "los detalles ya se pidieron". Sin ella no se sabria si un
      -- bar no tiene telefono o si es que nadie lo ha preguntado.
      detalles_en   TEXT,
      visto_en      TEXT NOT NULL DEFAULT (datetime('now')),
      creado_en     TEXT NOT NULL DEFAULT (datetime('now')),
      UNIQUE (ciudad_norm, clave_unica)
    );

    CREATE INDEX IF NOT EXISTS idx_comer_ciudad ON catalogo_comer(ciudad_norm);
  `);

  // -------------------------------------------------------------------------
  // Ensanchar el CHECK de `direcciones` para que admita 'comer'.
  //
  // ESTO ES UNA RECONSTRUCCION, y conviene decirlo claro en vez de disimularlo:
  // SQLite no sabe modificar un CHECK, asi que la unica via es tabla nueva,
  // copiar y renombrar. Se hace aqui porque la alternativa —un restaurante que
  // no puede tener direccion— dejaria fuera justo lo que da sentido a la
  // pestaña: calcular cuanto hay del hotel al sitio donde vas a cenar.
  //
  // Es una tabla mia, de la tanda anterior, y las filas se copian todas. Va en
  // una transaccion: o se rehace entera o se queda como estaba.
  // -------------------------------------------------------------------------
  const tieneComer = String(
    db.prepare("SELECT sql FROM sqlite_master WHERE name = 'direcciones'").get()?.sql ?? ''
  ).includes("'comer'");

  if (!tieneComer) {
    db.exec('BEGIN');
    try {
      db.exec(`
        CREATE TABLE direcciones_nueva (
          id            INTEGER PRIMARY KEY AUTOINCREMENT,
          tipo_elemento TEXT NOT NULL
                        CHECK (tipo_elemento IN
                          ('hotel','punto','sitio','actividad','movilidad','comer')),
          elemento_id   INTEGER NOT NULL,
          direccion     TEXT NOT NULL,
          lat           REAL,
          lng           REAL,
          estado        TEXT NOT NULL DEFAULT 'pendiente'
                        CHECK (estado IN ('pendiente','buscando','ok','sin_resultado','error')),
          fuente        TEXT,
          mensaje       TEXT,
          buscada_en    TEXT,
          creado_en     TEXT NOT NULL DEFAULT (datetime('now')),
          actualizado_en TEXT NOT NULL DEFAULT (datetime('now')),
          UNIQUE (tipo_elemento, elemento_id)
        );

        INSERT INTO direcciones_nueva
          (id, tipo_elemento, elemento_id, direccion, lat, lng, estado, fuente,
           mensaje, buscada_en, creado_en, actualizado_en)
        SELECT id, tipo_elemento, elemento_id, direccion, lat, lng, estado, fuente,
               mensaje, buscada_en, creado_en, actualizado_en
          FROM direcciones;

        DROP TABLE direcciones;
        ALTER TABLE direcciones_nueva RENAME TO direcciones;
      `);
      db.exec('COMMIT');
      console.log('[bd] `direcciones` rehecha para admitir restaurantes.');
    } catch (err) {
      try { db.exec('ROLLBACK'); } catch { /* ya estaba cerrada */ }
      throw err;
    }
  }

  marcarAplicada(CLAVE);
  console.log('[bd] Migración: bares y restaurantes.');
  return true;
}

/**
 * Migracion 17: direcciones y traslados guardados.
 *
 * LA PREGUNTA QUE QUITA: "¿cuanto hay de aqui a alla?". Se hace veinte veces
 * planificando un dia y hasta ahora habia que salir a Google Maps, mirarlo y
 * volver, sin que quedara constancia de nada.
 *
 * ============================================================================
 * A) UNA TABLA DE DIRECCIONES, NO UNA COLUMNA EN CADA SITIO
 * ============================================================================
 * Las cosas que tienen direccion viven en cinco tablas distintas: el hotel en
 * `candidatos`, los sitios en `puntos_interes` y `sitios_lugar`, las
 * excursiones en `catalogo_actividades` y el transporte urbano en
 * `catalogo_movilidad`. Cinco ALTER y cinco sitios donde acordarse de leerla.
 *
 * Va aparte, con el mismo patron de (tipo_elemento, elemento_id) que ya usa
 * `adjuntos` y que funciona. Una sola tabla, un solo servicio, y anadir manana
 * los restaurantes es anadir un valor al CHECK.
 *
 * EL ALCANCE LO DA EL TIPO, y eso es lo que hace que la eleccion sea correcta:
 *
 *   'hotel'      -> candidatos.id            Es del VIAJE. Mi hotel en Mostar
 *                                            es mio; el del ano que viene sera
 *                                            otro.
 *   'punto'      -> puntos_interes.id        Es CATALOGO. La direccion del
 *   'sitio'      -> sitios_lugar.id          Prado no cambia entre viajes, asi
 *   'actividad'  -> catalogo_actividades.id  que se teclea una vez y sirve
 *   'movilidad'  -> catalogo_movilidad.id    siempre.
 *
 * LAS COORDENADAS SON INTERNAS. El usuario piensa en direcciones y en nombres;
 * lat/lng son el combustible del calculo y no se ensenan en ninguna pantalla.
 * Por eso van aqui dentro y no en un campo de formulario.
 *
 * ============================================================================
 * B) LOS TRASLADOS SON MATERIAL DE INVESTIGACION
 * ============================================================================
 * Un traslado consultado NO se borra porque la actividad salga del lienzo.
 * Saber que del hotel al centro hay 20 minutos andando sigue siendo verdad y
 * sigue sirviendo, aunque ese dia se decida no ir. Por eso los traslados
 * cuelgan de la ETAPA y no de la tarjeta.
 *
 * Los extremos se guardan CONGELADOS (texto y coordenadas), no como referencia
 * al elemento. Si manana borro la excursion o le cambio la direccion, la
 * consulta que hice sigue diciendo lo que decia cuando la hice. Ademas se
 * apunta de donde salio cada extremo (`origen_tipo`/`origen_id`) para poder
 * recalcular, pero eso es un extra, no la fuente de verdad.
 */
function migracionTrasladosYDirecciones() {
  const CLAVE = '2026-09-traslados-y-direcciones';
  if (yaAplicada(CLAVE)) return false;

  db.exec(`
    -- ---------------------------------------------------------------- A) ----
    CREATE TABLE IF NOT EXISTS direcciones (
      id            INTEGER PRIMARY KEY AUTOINCREMENT,
      tipo_elemento TEXT NOT NULL
                    CHECK (tipo_elemento IN ('hotel','punto','sitio','actividad','movilidad')),
      elemento_id   INTEGER NOT NULL,
      direccion     TEXT NOT NULL,          -- tal y como se escribe, texto libre
      -- Internas: alimentan el calculo y NO se ensenan en ninguna pantalla.
      lat           REAL,
      lng           REAL,
      estado        TEXT NOT NULL DEFAULT 'pendiente'
                    CHECK (estado IN ('pendiente','buscando','ok','sin_resultado','error')),
      fuente        TEXT,                   -- google / nominatim
      mensaje       TEXT,                   -- por que no se encontro, para decirlo con suavidad
      buscada_en    TEXT,
      creado_en     TEXT NOT NULL DEFAULT (datetime('now')),
      actualizado_en TEXT NOT NULL DEFAULT (datetime('now')),
      UNIQUE (tipo_elemento, elemento_id)
    );

    -- ---------------------------------------------------------------- B) ----
    CREATE TABLE IF NOT EXISTS traslados (
      id            INTEGER PRIMARY KEY AUTOINCREMENT,
      viaje_id      INTEGER NOT NULL REFERENCES viajes(id) ON DELETE CASCADE,
      etapa_id      INTEGER NOT NULL REFERENCES etapas(id) ON DELETE CASCADE,

      -- Los extremos, congelados: lo que valia cuando se consulto.
      origen_texto   TEXT NOT NULL,
      origen_tipo    TEXT,                  -- de que elemento salio, si salio de uno
      origen_id      INTEGER,
      origen_lat     REAL,
      origen_lng     REAL,

      destino_texto  TEXT NOT NULL,
      destino_tipo   TEXT,
      destino_id     INTEGER,
      destino_lat    REAL,
      destino_lng    REAL,

      -- JSON: [{ modo, minutos, km, fuente }]. Google da tres modos, el plan B
      -- da dos: se guarda lo que haya y la pantalla ensena lo que hay.
      resultados     TEXT,
      fuente         TEXT,                  -- google / osrm / mixto
      estado         TEXT NOT NULL DEFAULT 'pendiente'
                     CHECK (estado IN ('pendiente','calculando','ok','error')),
      mensaje        TEXT,
      calculado_en   TEXT,
      creado_en      TEXT NOT NULL DEFAULT (datetime('now'))
    );

    CREATE INDEX IF NOT EXISTS idx_traslados_etapa ON traslados(etapa_id);
    CREATE INDEX IF NOT EXISTS idx_traslados_viaje ON traslados(viaje_id);
  `);

  // Una tarjeta del lienzo puede venir de un traslado consultado. `medio` dice
  // en que se va (andando/coche/publico), que es lo que decide su icono y sus
  // minutos; sin el, la tarjeta no sabria cual de los tres tiempos es el suyo.
  const cols = db.prepare('PRAGMA table_info(itinerario)').all().map((c) => c.name);
  if (!cols.includes('traslado_id')) {
    db.exec('ALTER TABLE itinerario ADD COLUMN traslado_id INTEGER');
  }
  if (!cols.includes('medio')) {
    db.exec('ALTER TABLE itinerario ADD COLUMN medio TEXT');
  }

  // Un traslado nuevo o borrado cambia el viaje: el dosier tiene que enterarse.
  db.exec(`
    DROP TRIGGER IF EXISTS tocar_por_traslados_ins;
    CREATE TRIGGER tocar_por_traslados_ins AFTER INSERT ON traslados
    BEGIN
      UPDATE viajes SET modificado_en = datetime('now') WHERE id = NEW.viaje_id;
    END;

    DROP TRIGGER IF EXISTS tocar_por_traslados_del;
    CREATE TRIGGER tocar_por_traslados_del AFTER DELETE ON traslados
    BEGIN
      UPDATE viajes SET modificado_en = datetime('now') WHERE id = OLD.viaje_id;
    END;
  `);

  // Civitatis ya trae el punto de encuentro de muchas excursiones, escrito por
  // ellos. Volcarlo aqui ahorra teclearlo, y como la direccion es editable, si
  // viene mal se corrige. Solo las que ya lo tienen: no se inventa nada.
  const conPunto = db
    .prepare(
      `SELECT id, punto_encuentro FROM catalogo_actividades
        WHERE punto_encuentro IS NOT NULL AND TRIM(punto_encuentro) <> ''`
    )
    .all();
  const meter = db.prepare(
    `INSERT OR IGNORE INTO direcciones (tipo_elemento, elemento_id, direccion, estado)
     VALUES ('actividad', ?, ?, 'pendiente')`
  );
  let volcadas = 0;
  for (const a of conPunto) {
    const limpio = puntoDeEncuentroLimpio(a.punto_encuentro);
    if (!limpio) continue;
    meter.run(a.id, limpio);
    volcadas += 1;
  }

  marcarAplicada(CLAVE);
  console.log(
    `[bd] Migración: direcciones y traslados guardados` +
      (volcadas ? ` (${volcadas} puntos de encuentro volcados).` : '.')
  );
  return true;
}

/**
 * El punto de encuentro de Civitatis, sin la morralla de alrededor.
 *
 * Lo que raspa el scraper viene asi:
 *
 *   "Alexanderplatz, frente a la entrada de la torre de TV.
 *
 *    Ver mapa
 *
 *    Segun la fecha y hora seleccionadas, tu punto de encuentro podria variar."
 *
 * La direccion es la PRIMERA linea. Lo demas es el enlace de su mapa y una
 * advertencia legal que sale en todas las fichas. Metido tal cual en el campo
 * quedaria feo y, sobre todo, el geocodificador no encontraria nada: le estarias
 * pidiendo que busque un parrafo.
 */
function puntoDeEncuentroLimpio(bruto) {
  const primera = String(bruto ?? '')
    .split(/\r?\n/)
    .map((l) => l.trim())
    .filter(Boolean)
    .find((l) => l.toLowerCase() !== 'ver mapa' && !/^seg[uú]n la fecha/i.test(l));

  return primera ? primera.slice(0, 400) : null;
}

/**
 * Migracion 16: movilidad. Dos cosas que faltaban y que no son la misma.
 *
 * A) COMO IR DE UNA CIUDAD A OTRA (`catalogo_transporte_tramo`).
 *    Hasta ahora el enlace del tramo llevaba SIEMPRE al buscador de vuelos,
 *    tambien en Sarajevo → Mostar, que se hace en bus por 8 euros. Ahora cada
 *    pareja de ciudades tiene sus medios: bus, tren, ferry, coche...
 *
 * B) COMO MOVERSE DENTRO (`catalogo_movilidad`).
 *    El metro, el bono de tres dias, el telefono del taxi. Eso no tenia sitio en
 *    ninguna parte y acababa en una nota suelta o en el movil de alguien.
 *
 * LAS DOS SON CATALOGO. Los medios entre Sarajevo y Mostar y el precio del bus
 * urbano de Mostar no dependen de mi viaje: se consultan una vez y sirven para
 * el que venga. Por eso van por NOMBRE NORMALIZADO de ciudad y no por etapa: la
 * etapa es de un viaje, la ciudad es del mundo.
 *
 * EL PAR DE CIUDADES NO TIENE DIRECCION, como en las distancias: se guarda con
 * el nombre menor delante y una fila sirve para los dos sentidos. Cuando algun
 * dato SI depende del sentido —un ferry que solo sale por la mañana en una
 * direccion— se dice en `nota_sentido`, que para eso esta.
 *
 * LO ELEGIDO ES DEL VIAJE, NO DEL CATALOGO. Que yo coja el bus de las 9:15 con
 * la reserva ABC123 no le importa a nadie mas, asi que va en `transporte_datos`,
 * una fila por (tramo, ficha). Que sea por FICHA y no por tramo es lo que
 * permite cambiar de idea sin perder lo tecleado: si apunte el horario del tren
 * y luego me decido por el bus, el del tren sigue ahi cuando vuelva.
 *
 * TODO ADITIVO: tablas nuevas y columnas nuevas. No se borra ni se renombra
 * nada de lo que ya habia.
 */
function migracionMovilidad() {
  const CLAVE = '2026-09-movilidad';
  if (yaAplicada(CLAVE)) return false;

  db.exec(`
    -- ---------------------------------------------------------------- A) ----
    CREATE TABLE IF NOT EXISTS catalogo_transporte_tramo (
      id            INTEGER PRIMARY KEY AUTOINCREMENT,
      -- El par, con el nombre normalizado menor delante: una fila, dos sentidos.
      ciudad_a_norm TEXT NOT NULL,
      ciudad_b_norm TEXT NOT NULL,
      ciudad_a      TEXT NOT NULL,     -- tal y como se escriben, para enseñarlos
      ciudad_b      TEXT NOT NULL,
      medio         TEXT NOT NULL,     -- bus / tren / ferry / coche / traslado / avion / otro
      nombre        TEXT NOT NULL,     -- "Autobús Centrotrans", "Tren regional"
      duracion      TEXT,
      frecuencia    TEXT,
      precio        TEXT,              -- texto: "8-12 €" dice más que un número
      nota          TEXT,
      nota_sentido  TEXT,              -- lo que SÍ cambia según la dirección
      web           TEXT,
      orden         INTEGER NOT NULL DEFAULT 0,
      origen        TEXT NOT NULL DEFAULT 'ia',   -- 'ia' o 'manual'
      creado_en     TEXT NOT NULL DEFAULT (datetime('now')),
      CHECK (ciudad_a_norm <= ciudad_b_norm)
    );

    CREATE INDEX IF NOT EXISTS idx_transporte_tramo_par
      ON catalogo_transporte_tramo(ciudad_a_norm, ciudad_b_norm);

    -- Lo que yo elijo y tecleo para ESTE viaje. Una fila por (tramo, ficha).
    CREATE TABLE IF NOT EXISTS transporte_datos (
      id            INTEGER PRIMARY KEY AUTOINCREMENT,
      transporte_id INTEGER NOT NULL REFERENCES transportes(id) ON DELETE CASCADE,
      ficha_id      INTEGER NOT NULL REFERENCES catalogo_transporte_tramo(id) ON DELETE CASCADE,
      horario       TEXT,
      precio_real   TEXT,
      referencia    TEXT,
      nota          TEXT,
      creado_en     TEXT NOT NULL DEFAULT (datetime('now')),
      UNIQUE (transporte_id, ficha_id)
    );

    -- ---------------------------------------------------------------- B) ----
    CREATE TABLE IF NOT EXISTS catalogo_movilidad (
      id          INTEGER PRIMARY KEY AUTOINCREMENT,
      ciudad_norm TEXT NOT NULL,
      ciudad      TEXT NOT NULL,
      tipo        TEXT NOT NULL,   -- metro / bus / taxi / app / tarjeta / especial / otro
      nombre      TEXT NOT NULL,
      descripcion TEXT,
      precio      TEXT,
      telefono    TEXT,            -- se pinta SIEMPRE como enlace tel:
      web         TEXT,
      nota        TEXT,
      orden       INTEGER NOT NULL DEFAULT 0,
      origen      TEXT NOT NULL DEFAULT 'ia',
      creado_en   TEXT NOT NULL DEFAULT (datetime('now'))
    );

    CREATE INDEX IF NOT EXISTS idx_movilidad_ciudad ON catalogo_movilidad(ciudad_norm);
  `);

  // El medio elegido de cada tramo. Nullable: un tramo sin decidir es lo normal.
  const cols = db.prepare('PRAGMA table_info(transportes)').all().map((c) => c.name);
  if (!cols.includes('ficha_transporte_id')) {
    db.exec('ALTER TABLE transportes ADD COLUMN ficha_transporte_id INTEGER');
  }

  // Un traslado colocado en el lienzo apunta a su ficha de movilidad. La tarjeta
  // se pinta FINA: un trayecto en metro no ocupa lo que una visita al Prado.
  const colsIt = db.prepare('PRAGMA table_info(itinerario)').all().map((c) => c.name);
  if (!colsIt.includes('movilidad_id')) {
    db.exec('ALTER TABLE itinerario ADD COLUMN movilidad_id INTEGER');
  }
  if (!colsIt.includes('duracion_min')) {
    db.exec('ALTER TABLE itinerario ADD COLUMN duracion_min INTEGER');
  }

  marcarAplicada(CLAVE);
  console.log('[bd] Migración: movilidad (transporte entre ciudades y dentro de ellas).');
  return true;
}

/**
 * Migracion 15: cuanto hay de una ciudad a otra.
 *
 * PARA DECIDIR LA RUTA, NO PARA NAVEGAR. Al mirar Italia hay que poder saber si
 * Florencia esta a tiro de Roma para un fin de semana o si es meterse tres horas
 * de carretera. Eso se decide ANTES de armar la ruta, mirando el mapa.
 *
 * ESTO NO CADUCA. La distancia de Roma a Florencia era la misma el año pasado y
 * sera la misma el que viene: se calcula UNA vez y se reutiliza siempre. Por eso
 * es catalogo y no dato de viaje, y por eso `fecha_calculo` esta ahi para saber
 * cuando se supo, no para invalidarlo.
 *
 * EL PAR NO TIENE DIRECCION. Ir de Roma a Florencia y volver son los mismos
 * kilometros, asi que se guarda una sola fila con el id menor primero. El indice
 * unico sobre ese par ordenado es lo que impide que se dupliquen: sin el, dos
 * consultas simultaneas guardarian A→B y B→A y despues habria dos verdades.
 *
 * LAS CIUDADES SON `puntos_interes`. Es lo que hay en el mapa de exploracion de
 * un pais —los resultados de Italia son Roma, Florencia, Venecia— y lo que
 * apunta cada etapa que sale de ahi. Una parada que no venga del mapa (un viaje
 * de una sola ciudad) no tiene punto, y para esa la distancia de su tramo sigue
 * viviendo donde vivia: en la propia fila de `transportes`.
 */
function migracionDistanciasCiudades() {
  const CLAVE = '2026-09-distancias-ciudades';
  if (yaAplicada(CLAVE)) return false;

  db.exec(`
    CREATE TABLE IF NOT EXISTS distancias_ciudades (
      id                INTEGER PRIMARY KEY AUTOINCREMENT,
      ciudad_origen_id  INTEGER NOT NULL REFERENCES puntos_interes(id) ON DELETE CASCADE,
      ciudad_destino_id INTEGER NOT NULL REFERENCES puntos_interes(id) ON DELETE CASCADE,
      km                REAL,
      minutos_coche     INTEGER,
      -- 'carretera' o 'recta': entre islas no hay coche que valga, y decir
      -- "8 h en coche" de Palermo a Napoles seria mentira.
      fuente            TEXT NOT NULL DEFAULT 'carretera',
      fecha_calculo     TEXT NOT NULL DEFAULT (datetime('now')),
      -- El par va SIEMPRE con el id menor delante: asi una sola fila sirve para
      -- los dos sentidos y el unico de abajo puede hacer su trabajo.
      CHECK (ciudad_origen_id < ciudad_destino_id)
    );

    CREATE UNIQUE INDEX IF NOT EXISTS idx_distancias_par
      ON distancias_ciudades(ciudad_origen_id, ciudad_destino_id);
  `);

  marcarAplicada(CLAVE);
  console.log('[bd] Migración: caché de distancias entre ciudades.');
  return true;
}

/**
 * Migracion 14: los adjuntos.
 *
 * El billete de avion, la confirmacion del hotel, el bono de la excursion. Todo
 * eso llega por correo en PDF o como foto, y hasta ahora no habia donde
 * ponerlo: acababa en la galeria del movil, perdido entre otras mil cosas.
 *
 * TRES CLASES DE ELEMENTO, y `elemento_id` apunta a una tabla distinta segun
 * cual sea. Es una relacion polimorfica, asi que NO lleva clave ajena: SQLite no
 * puede tener una columna que apunte a tres tablas.
 *
 *   'transporte'  -> transportes.id   (billetes, tarjetas de embarque)
 *   'alojamiento' -> candidatos.id    (el hotel ELEGIDO de una etapa)
 *   'excursion'   -> candidatos.id    (la excursion apuntada)
 *
 * El alojamiento cuelga del hotel elegido y no de la etapa a proposito: la
 * confirmacion es DE ESE hotel. Si cambio de hotel, esa confirmacion ya no vale
 * para nada y se va con el.
 *
 * Sin clave ajena, la limpieza la hace el codigo: `borrarAdjuntosDe()` en cada
 * sitio donde se borra un elemento, y `limpiarAdjuntosHuerfanos()` como red de
 * seguridad para los caminos que se me escapen (recalcular la ruta borra tramos
 * sin pasar por ningun sitio evidente). Los archivos del disco tambien.
 *
 * `viaje_id` no estaba en la lista pero hace falta por dos motivos: la ruta en
 * disco se agrupa por viaje, y borrar un viaje tiene que llevarse sus adjuntos
 * por delante (eso si es una cascada de verdad).
 */
function migracionAdjuntos() {
  const CLAVE = '2026-09-adjuntos';
  if (yaAplicada(CLAVE)) return false;

  db.exec(`
    CREATE TABLE IF NOT EXISTS adjuntos (
      id              INTEGER PRIMARY KEY AUTOINCREMENT,
      viaje_id        INTEGER NOT NULL REFERENCES viajes(id) ON DELETE CASCADE,
      tipo_elemento   TEXT    NOT NULL CHECK (tipo_elemento IN ('transporte','alojamiento','excursion')),
      elemento_id     INTEGER NOT NULL,
      nombre_archivo  TEXT    NOT NULL,   -- como se llama en el disco (unico)
      nombre_original TEXT    NOT NULL,   -- como se llamaba al subirlo
      mime            TEXT    NOT NULL,
      tamano          INTEGER NOT NULL,
      subido_en       TEXT    NOT NULL DEFAULT (datetime('now'))
    );

    CREATE INDEX IF NOT EXISTS idx_adjuntos_elemento
      ON adjuntos(tipo_elemento, elemento_id);
    CREATE INDEX IF NOT EXISTS idx_adjuntos_viaje ON adjuntos(viaje_id);
  `);

  // Un adjunto nuevo o borrado cambia el viaje: el dosier tiene que enterarse.
  db.exec(`
    DROP TRIGGER IF EXISTS tocar_por_adjuntos_ins;
    CREATE TRIGGER tocar_por_adjuntos_ins AFTER INSERT ON adjuntos
    BEGIN
      UPDATE viajes SET modificado_en = datetime('now') WHERE id = NEW.viaje_id;
    END;

    DROP TRIGGER IF EXISTS tocar_por_adjuntos_del;
    CREATE TRIGGER tocar_por_adjuntos_del AFTER DELETE ON adjuntos
    BEGIN
      UPDATE viajes SET modificado_en = datetime('now') WHERE id = OLD.viaje_id;
    END;
  `);

  marcarAplicada(CLAVE);
  console.log('[bd] Migración: tabla de adjuntos.');
  return true;
}

/**
 * Migracion 13: el viaje listo y su dosier.
 *
 * TRES COLUMNAS Y UNOS DISPARADORES.
 *
 *  - `listo`: lo pongo yo a mano cuando digo que el viaje esta listo. NO se
 *    deduce de nada: la pantalla enseña que falta —tramos sin resolver, etapas
 *    sin hotel— pero eso solo informa. Un viaje puede estar listo con el hotel
 *    de la ultima noche sin cerrar si asi lo decido.
 *  - `dosier_en`: cuando se genero el ultimo dosier.
 *  - `modificado_en`: cuando se toco el viaje por ultima vez. Comparada con la
 *    de arriba es lo que dice si el dosier se ha quedado viejo.
 *
 * POR QUE DISPARADORES Y NO LLAMADAS A MANO
 * Porque "tocar el viaje" pasa desde una docena de sitios —colocar algo en el
 * lienzo, confirmar una etapa, elegir un vuelo, cambiar las noches— y basta
 * olvidarse de uno para que el dosier diga que esta al dia cuando no lo esta.
 * Con disparadores lo hace la propia base de datos y no hay nada que recordar.
 *
 * OJO CON LOS FALSOS POSITIVOS: cada disparador lleva un WHEN que compara
 * columna a columna, asi que una escritura que deja los mismos valores NO marca
 * el viaje como modificado. Sin eso, `recalcularFechasEtapas` —que se ejecuta
 * al entrar en la ruta y reescribe las mismas fechas— avisaria de que el viaje
 * ha cambiado cada vez que se mira. Por eso tampoco entran aqui las columnas de
 * cache: la distancia de un tramo la rellena OSRM sola y no es un cambio mio.
 */
function migracionDosier() {
  const CLAVE = '2026-09-dosier';
  if (yaAplicada(CLAVE)) return false;

  const columnas = db.prepare('PRAGMA table_info(viajes)').all().map((c) => c.name);
  for (const [nombre, tipo] of [
    ['listo', 'INTEGER NOT NULL DEFAULT 0'],
    ['modificado_en', 'TEXT'],
    ['dosier_en', 'TEXT'],
  ]) {
    if (!columnas.includes(nombre)) db.exec(`ALTER TABLE viajes ADD COLUMN ${nombre} ${tipo}`);
  }

  // Los viajes que ya existian se dan por tocados ahora mismo: no hay forma de
  // saber cuando fue, y decir "nunca" haria que un dosier nuevo naciera viejo.
  db.exec("UPDATE viajes SET modificado_en = datetime('now') WHERE modificado_en IS NULL");

  db.exec(`
    -- Lo colocado en el lienzo
    DROP TRIGGER IF EXISTS tocar_por_itinerario_ins;
    CREATE TRIGGER tocar_por_itinerario_ins AFTER INSERT ON itinerario
    BEGIN
      UPDATE viajes SET modificado_en = datetime('now') WHERE id = NEW.viaje_id;
    END;

    DROP TRIGGER IF EXISTS tocar_por_itinerario_upd;
    CREATE TRIGGER tocar_por_itinerario_upd AFTER UPDATE ON itinerario
    WHEN old.dia IS NOT new.dia OR old.franja IS NOT new.franja
      OR old.hora IS NOT new.hora OR old.orden IS NOT new.orden
      OR old.texto_manual IS NOT new.texto_manual
    BEGIN
      UPDATE viajes SET modificado_en = datetime('now') WHERE id = NEW.viaje_id;
    END;

    DROP TRIGGER IF EXISTS tocar_por_itinerario_del;
    CREATE TRIGGER tocar_por_itinerario_del AFTER DELETE ON itinerario
    BEGIN
      UPDATE viajes SET modificado_en = datetime('now') WHERE id = OLD.viaje_id;
    END;

    -- Las paradas
    DROP TRIGGER IF EXISTS tocar_por_etapas_ins;
    CREATE TRIGGER tocar_por_etapas_ins AFTER INSERT ON etapas
    BEGIN
      UPDATE viajes SET modificado_en = datetime('now') WHERE id = NEW.viaje_id;
    END;

    DROP TRIGGER IF EXISTS tocar_por_etapas_upd;
    CREATE TRIGGER tocar_por_etapas_upd AFTER UPDATE ON etapas
    WHEN old.nombre_ciudad IS NOT new.nombre_ciudad OR old.orden IS NOT new.orden
      OR old.noches IS NOT new.noches OR old.estado IS NOT new.estado
      OR old.fecha_inicio IS NOT new.fecha_inicio OR old.fecha_fin IS NOT new.fecha_fin
      OR old.notas IS NOT new.notas
    BEGIN
      UPDATE viajes SET modificado_en = datetime('now') WHERE id = NEW.viaje_id;
    END;

    DROP TRIGGER IF EXISTS tocar_por_etapas_del;
    CREATE TRIGGER tocar_por_etapas_del AFTER DELETE ON etapas
    BEGIN
      UPDATE viajes SET modificado_en = datetime('now') WHERE id = OLD.viaje_id;
    END;

    -- Los tramos de transporte. Solo lo que decido yo: la distancia y la
    -- duracion las rellena OSRM y no son un cambio del viaje.
    DROP TRIGGER IF EXISTS tocar_por_transportes_ins;
    CREATE TRIGGER tocar_por_transportes_ins AFTER INSERT ON transportes
    BEGIN
      UPDATE viajes SET modificado_en = datetime('now') WHERE id = NEW.viaje_id;
    END;

    DROP TRIGGER IF EXISTS tocar_por_transportes_upd;
    CREATE TRIGGER tocar_por_transportes_upd AFTER UPDATE ON transportes
    WHEN old.candidato_id IS NOT new.candidato_id OR old.notas IS NOT new.notas
      OR old.tipo IS NOT new.tipo OR old.precio_estimado IS NOT new.precio_estimado
    BEGIN
      UPDATE viajes SET modificado_en = datetime('now') WHERE id = NEW.viaje_id;
    END;

    DROP TRIGGER IF EXISTS tocar_por_transportes_del;
    CREATE TRIGGER tocar_por_transportes_del AFTER DELETE ON transportes
    BEGIN
      UPDATE viajes SET modificado_en = datetime('now') WHERE id = OLD.viaje_id;
    END;

    -- El alojamiento (y cualquier otra cosa) que elijo o suelto. NO entra el
    -- alta de candidatos: que un scraper guarde veinte hoteles no cambia el
    -- viaje, cambia lo que hay para elegir.
    DROP TRIGGER IF EXISTS tocar_por_eleccion;
    CREATE TRIGGER tocar_por_eleccion AFTER UPDATE OF marcado ON candidatos
    WHEN old.marcado IS NOT new.marcado
    BEGIN
      UPDATE viajes SET modificado_en = datetime('now') WHERE id = NEW.viaje_id;
    END;
  `);

  marcarAplicada(CLAVE);
  console.log('[bd] Migración: viaje listo, fecha del dosier y disparadores de "modificado".');
  return true;
}

/**
 * Migracion 12: la ficha de una excursion y los filtros de cada tramo.
 *
 * DOS COSAS QUE NO SE PARECEN, PERO VAN JUNTAS PORQUE SON SOLO COLUMNAS.
 *
 * a) `catalogo_actividades` gana los campos de la FICHA COMPLETA de Civitatis.
 *    Van en el CATALOGO y no en el viaje a proposito: lo que incluye el free
 *    tour de Lisboa o donde se queda uno para empezarlo es conocimiento estable
 *    sobre el mundo. Se busca UNA vez, cuando alguien pulsa "Ver detalles" de
 *    esa excursion, y sirve para siempre y para todos los viajes.
 *    Todas nullable: una ficha puede no tener punto de encuentro (una entrada
 *    a un acuario no lo tiene) y eso no es un error, es que no existe.
 *
 * b) `transportes` gana sus propios filtros de vuelo. Antes los filtros eran
 *    del VIAJE entero, y eso obligaba a querer lo mismo a la ida que a la
 *    vuelta. Ahora cada tramo se busca por separado (solo ida, con su fecha) y
 *    guarda lo suyo: puedo querer directos a la ida y me da igual a la vuelta.
 *    Sin valor, el tramo hereda los del viaje, asi que lo que ya habia sigue
 *    funcionando igual.
 */
function migracionFichaActividadYFiltrosTramo() {
  const CLAVE = '2026-09-ficha-actividad-y-filtros-tramo';
  if (yaAplicada(CLAVE)) return false;

  const columnasDe = (tabla) => db.prepare(`PRAGMA table_info(${tabla})`).all().map((c) => c.name);

  const deActividad = columnasDe('catalogo_actividades');
  const nuevas = [
    ['descripcion_larga', 'TEXT'],   // la descripcion entera, con su itinerario
    ['horarios', 'TEXT'],            // horarios de salida, cuando la ficha los publica
    ['duracion_detalle', 'TEXT'],    // "3 horas." tal cual lo dice la ficha
    ['incluye', 'TEXT'],
    ['no_incluye', 'TEXT'],
    ['punto_encuentro', 'TEXT'],
    ['idiomas', 'TEXT'],
    ['cancelacion', 'TEXT'],
    ['detalles_extra', 'TEXT'],      // JSON con el resto de filas de "Detalles"
    ['detalles_en', 'TEXT'],         // cuando se busco: sin esto no se sabe si falta o no se pidio
  ];
  for (const [nombre, tipo] of nuevas) {
    if (!deActividad.includes(nombre)) {
      db.exec(`ALTER TABLE catalogo_actividades ADD COLUMN ${nombre} ${tipo}`);
    }
  }

  if (!columnasDe('transportes').includes('filtros_vuelos')) {
    db.exec('ALTER TABLE transportes ADD COLUMN filtros_vuelos TEXT');
  }

  marcarAplicada(CLAVE);
  console.log('[bd] Migración: ficha completa de las excursiones y filtros por tramo.');
  return true;
}

/**
 * Migracion 11: una etapa no es un museo.
 *
 * EL FALLO QUE ARREGLA
 * El boton "Añadir a mi ruta" de la pantalla de descubrir creaba una ETAPA por
 * cada resultado, sin mirar de que nivel era el destino. Para un pais eso esta
 * bien: los resultados de Japon son Tokio, Kioto y Osaka, y cada uno es una
 * parada. Para una CIUDAD es un disparate: los resultados de Madrid son el
 * Prado, el Palacio Real y el Retiro, y ninguno de los tres es una parada del
 * viaje — son cosas que ver DENTRO de la parada Madrid.
 *
 * El sintoma era un viaje con tres candidatos llamados "Madrid, Madrid,
 * Madrid": como los tres son de categoria 'sitio', la etapa tomaba el nombre de
 * su `ciudad_base`, que en los tres casos era Madrid.
 *
 * Y ademas la etapa Madrid de verdad estaba suelta: no apuntaba a nada del
 * catalogo, asi que su pestaña "Que ver" salia vacia aunque el catalogo tuviera
 * quince sitios y veintiocho excursiones de esa misma ciudad.
 *
 * LO QUE HACE
 *  a) Añade `etapas.destino_id`: el enlace que faltaba entre una parada y el
 *     destino del catalogo del que sabemos cosas.
 *  b) Convierte en CANDIDATOS las etapas que en realidad eran sitios, dentro de
 *     la etapa de su ciudad (creandola si no estaba), y las borra como etapas.
 *  c) Reengancha al catalogo las etapas sueltas cuyo nombre coincide con un
 *     destino ya investigado.
 *
 * No borra nada del catalogo. Lo que se apunto sigue apuntado, solo que en el
 * sitio correcto.
 */
function migracionEtapaNoEsUnSitio() {
  const CLAVE = '2026-09-etapa-no-es-un-sitio';
  if (yaAplicada(CLAVE)) return false;

  console.log('[bd] Migrando: una etapa no es un museo.');

  anadirColumnaSiFalta('etapas', 'destino_id', 'INTEGER REFERENCES destinos(id) ON DELETE SET NULL');
  db.exec('CREATE INDEX IF NOT EXISTS idx_etapas_destino ON etapas(destino_id);');

  let convertidas = 0;
  let reenganchadas = 0;
  let etapasCreadas = 0;

  db.exec('BEGIN');
  try {
    // --- b) Las etapas que en realidad son sitios --------------------------
    // Se reconocen por su origen: vienen de un punto de interes cuyo destino es
    // de nivel CIUDAD. Un punto de un destino de nivel pais (Kioto dentro de
    // Japon) si es una parada legitima y no se toca.
    const impostoras = db
      .prepare(
        `SELECT e.*, p.nombre AS punto_nombre, p.wikipedia_url, p.imagen_url,
                p.descripcion_corta, d.id AS destino_id, d.nombre AS destino_nombre
           FROM etapas e
           JOIN puntos_interes p ON p.id = e.punto_interes_id
           JOIN destinos d ON d.id = p.destino_id
          WHERE d.tipo = 'ciudad'`
      )
      .all();

    for (const mala of impostoras) {
      // La etapa de la ciudad: la que ya exista para ese viaje, o una nueva.
      let ciudad = db
        .prepare(
          `SELECT * FROM etapas
            WHERE viaje_id = ? AND id <> ?
              AND (destino_id = ? OR nombre_ciudad = ?)
            ORDER BY (estado = 'confirmada') DESC, orden, id
            LIMIT 1`
        )
        .get(mala.viaje_id, mala.id, mala.destino_id, mala.destino_nombre);

      if (!ciudad) {
        const ultimo = db
          .prepare('SELECT MAX(orden) AS n FROM etapas WHERE viaje_id = ?')
          .get(mala.viaje_id);
        const r = db
          .prepare(
            `INSERT INTO etapas (viaje_id, destino_id, nombre_ciudad, orden, noches, estado)
             VALUES (?, ?, ?, ?, 0, 'recopilando')`
          )
          .run(mala.viaje_id, mala.destino_id, mala.destino_nombre, (ultimo?.n ?? 0) + 1);
        ciudad = db.prepare('SELECT * FROM etapas WHERE id = ?').get(Number(r.lastInsertRowid));
        etapasCreadas++;
      } else if (!ciudad.destino_id) {
        db.prepare('UPDATE etapas SET destino_id = ? WHERE id = ?').run(mala.destino_id, ciudad.id);
      }

      // El sitio pasa a ser un candidato DENTRO de esa etapa, con el mismo
      // criterio de duplicados que usa "me lo apunto": url si la hay, titulo si no.
      const clave = mala.wikipedia_url || null;
      const yaEsta = db
        .prepare(
          `SELECT id FROM candidatos
            WHERE etapa_id = ? AND tipo = 'sitio'
              AND ((url IS NOT NULL AND url = ?) OR (url IS NULL AND titulo = ?))`
        )
        .get(ciudad.id, clave, mala.punto_nombre);

      if (!yaEsta) {
        db.prepare(
          `INSERT INTO candidatos
             (viaje_id, etapa_id, tipo, titulo, url, imagen_url, origen_datos, marcado, datos_extra)
           VALUES (?, ?, 'sitio', ?, ?, ?, 'catalogo', 1, ?)`
        ).run(
          mala.viaje_id,
          ciudad.id,
          mala.punto_nombre,
          clave,
          mala.imagen_url,
          JSON.stringify({ dePunto: mala.punto_interes_id, migradoDeEtapa: mala.id })
        );
      }

      db.prepare('DELETE FROM etapas WHERE id = ?').run(mala.id);
      convertidas++;
    }

    // --- c) Etapas sueltas que son una ciudad conocida ---------------------
    // Se enganchan por nombre normalizado, que es como se busca en el catalogo.
    const sueltas = db
      .prepare('SELECT id, viaje_id, nombre_ciudad FROM etapas WHERE destino_id IS NULL')
      .all();

    const buscarDestino = db.prepare(
      "SELECT id FROM destinos WHERE nombre_norm = ? AND tipo = 'ciudad' ORDER BY id LIMIT 1"
    );
    const enganchar = db.prepare('UPDATE etapas SET destino_id = ? WHERE id = ?');

    for (const e of sueltas) {
      const d = buscarDestino.get(normalizarNombre(e.nombre_ciudad));
      if (!d) continue;
      enganchar.run(d.id, e.id);
      reenganchadas++;
    }

    db.exec('COMMIT');
  } catch (err) {
    db.exec('ROLLBACK');
    throw err;
  }

  marcarAplicada(CLAVE);
  console.log(
    `[bd] Migración hecha: ${convertidas} etapas convertidas en sitios apuntados` +
      (etapasCreadas ? ` (${etapasCreadas} etapas de ciudad creadas)` : '') +
      `, ${reenganchadas} etapas reenganchadas al catálogo.`
  );
  return true;
}

/**
 * Migracion 10: `itinerario` pasa a ser el lienzo.
 *
 * La tabla existia desde el primer dia pero nunca se llego a usar (cero filas,
 * ni una consulta en todo el proyecto), y su forma era la de otra idea: `dia`
 * guardaba una FECHA en una columna de texto.
 *
 * El lienzo necesita el NUMERO de dia (1..N), y eso en una columna TEXT es una
 * trampa: SQLite guardaria "10" y al ordenar pondria el dia 10 antes que el 2.
 * Como no hay datos que conservar, se rehace la tabla con la forma correcta en
 * vez de arrastrar la vieja.
 *
 * El CHECK del final es la regla que pide el diseño: una fila es O una cosa
 * colocada O un texto escrito a mano, nunca las dos ni ninguna.
 */
function migracionLienzo() {
  const CLAVE = '2026-09-lienzo';
  if (yaAplicada(CLAVE)) return false;

  // La opinión del lienzo se guarda en el viaje: es una sola por viaje y se
  // reescribe entera cada vez que se pide.
  anadirColumnaSiFalta('viajes', 'opinion_lienzo', 'TEXT');
  anadirColumnaSiFalta('viajes', 'opinion_lienzo_en', 'TEXT');

  const columnas = db.prepare('PRAGMA table_info(itinerario)').all().map((c) => c.name);
  const yaEsNueva = columnas.includes('franja');
  if (yaEsNueva) { marcarAplicada(CLAVE); return false; }

  const cuantas = db.prepare('SELECT COUNT(*) AS n FROM itinerario').get().n;
  console.log(`[bd] Migrando: rehago la tabla itinerario para el lienzo (${cuantas} filas dentro).`);

  db.exec(`
    DROP TABLE IF EXISTS itinerario;

    CREATE TABLE itinerario (
      id           INTEGER PRIMARY KEY AUTOINCREMENT,
      viaje_id     INTEGER NOT NULL REFERENCES viajes(id) ON DELETE CASCADE,
      etapa_id     INTEGER REFERENCES etapas(id) ON DELETE CASCADE,
      dia          INTEGER NOT NULL,          -- numero de dia del viaje, 1..N
      franja       TEXT    NOT NULL,          -- manana / mediodia / tarde / noche
      candidato_id INTEGER REFERENCES candidatos(id) ON DELETE CASCADE,
      texto_manual TEXT,
      hora         TEXT,                      -- "HH:MM", opcional
      orden        INTEGER NOT NULL DEFAULT 0,
      creado_en    TEXT    NOT NULL DEFAULT (datetime('now')),
      -- O una cosa colocada, o un texto a mano. Nunca las dos, nunca ninguna.
      CHECK ((candidato_id IS NOT NULL) <> (texto_manual IS NOT NULL))
    );

    CREATE INDEX IF NOT EXISTS idx_itinerario_viaje ON itinerario(viaje_id, dia, franja, orden);
    CREATE INDEX IF NOT EXISTS idx_itinerario_etapa ON itinerario(etapa_id, dia);
    CREATE UNIQUE INDEX IF NOT EXISTS idx_itinerario_candidato ON itinerario(candidato_id)
      WHERE candidato_id IS NOT NULL;
  `);

  marcarAplicada(CLAVE);
  console.log('[bd] Migración hecha.');
  return true;
}

/**
 * Migracion 9: lo que le faltaba a `transportes` para la pantalla de etapa.
 *
 *  - distancia_km / duracion_min: la referencia de OSRM, cacheada en la propia
 *    fila. Se guardan aqui y no en una tabla aparte porque son del tramo y
 *    mueren con el: si el tramo desaparece al reordenar, el dato ya no vale.
 *  - notas / precio_estimado: cuando el tramo se resuelve a mano ("Shinkansen
 *    Hikari, ~2h15, JR Pass"). Un tren no se scrapea, se apunta.
 *  - fuente_distancia: 'carretera' o 'recta'. Importa distinguirlo: 460 km por
 *    carretera es un tren; 9.700 km en linea recta es un avion, y la pantalla
 *    tiene que poder decirlo con esas palabras.
 */
function migracionTransporteEtapa() {
  const CLAVE = '2026-09-transporte-de-etapa';
  if (yaAplicada(CLAVE)) return false;

  console.log('[bd] Migrando: distancias y notas en los tramos de transporte.');

  anadirColumnaSiFalta('transportes', 'distancia_km', 'REAL');
  anadirColumnaSiFalta('transportes', 'duracion_min', 'INTEGER');
  anadirColumnaSiFalta('transportes', 'fuente_distancia', 'TEXT');
  anadirColumnaSiFalta('transportes', 'notas', 'TEXT');
  anadirColumnaSiFalta('transportes', 'precio_estimado', 'REAL');

  marcarAplicada(CLAVE);
  console.log('[bd] Migración hecha.');
  return true;
}

/**
 * Migracion 8: clave unica de los sitios de una ficha profunda.
 *
 * Mismo problema que con los puntos de interes y misma solucion: al reinvestigar
 * una ciudad, el "Templo Kiyomizu-dera" tiene que ser el de la vez anterior y
 * actualizarse, no aparecer dos veces. La clave es (punto_interes_id,
 * nombre_norm).
 */
function migracionSitiosLugar() {
  const CLAVE = '2026-09-sitios-lugar-unicos';
  if (yaAplicada(CLAVE)) return false;

  console.log('[bd] Migrando: clave única de los sitios de cada ficha.');

  anadirColumnaSiFalta('sitios_lugar', 'nombre_norm', 'TEXT');

  const sinNorm = db.prepare('SELECT id, nombre FROM sitios_lugar WHERE nombre_norm IS NULL').all();
  const ponerNorm = db.prepare('UPDATE sitios_lugar SET nombre_norm = ? WHERE id = ?');
  for (const s of sinNorm) ponerNorm.run(normalizarNombre(s.nombre), s.id);

  db.exec(`
    CREATE UNIQUE INDEX IF NOT EXISTS idx_sitios_unico ON sitios_lugar(punto_interes_id, nombre_norm);
  `);

  marcarAplicada(CLAVE);
  console.log(`[bd] Migración hecha: ${sinNorm.length} sitios normalizados.`);
  return true;
}

/**
 * Migracion 7: lo que hace falta para la pantalla de descubrir.
 *
 * Dos cosas:
 *
 *  a) `trabajos.referencia_id`. Hasta ahora todo trabajo era "haz esto PARA el
 *     viaje 5" y con el viaje_id bastaba. Los trabajos nuevos no: investigar un
 *     destino es "investiga el destino 3" e investigar una ciudad es "investiga
 *     el punto 47". Esa es la referencia. Sigue habiendo viaje_id porque el
 *     trabajo se lanza desde un viaje y ahi es donde se ve el progreso.
 *
 *  b) `puntos_interes.nombre_norm` y un indice UNICO por (destino_id,
 *     nombre_norm). Al reinvestigar un destino, "Kioto" tiene que ser el mismo
 *     Kioto de la vez anterior y actualizarse, no aparecer dos veces. Sin esta
 *     clave, cada "Actualizar" duplicaria la lista entera.
 */
function migracionDescubrir() {
  const CLAVE = '2026-09-descubrir-destino';
  if (yaAplicada(CLAVE)) return false;

  console.log('[bd] Migrando: preparo la pantalla de descubrir.');

  anadirColumnaSiFalta('trabajos', 'referencia_id', 'INTEGER');
  anadirColumnaSiFalta('puntos_interes', 'nombre_norm', 'TEXT');

  // Rellenamos nombre_norm de lo que hubiera (hoy nada, pero esto tiene que
  // funcionar igual si se relanza con la tabla ya poblada).
  const sinNorm = db
    .prepare('SELECT id, nombre FROM puntos_interes WHERE nombre_norm IS NULL')
    .all();
  const ponerNorm = db.prepare('UPDATE puntos_interes SET nombre_norm = ? WHERE id = ?');
  for (const p of sinNorm) ponerNorm.run(normalizarNombre(p.nombre), p.id);

  db.exec(`
    CREATE UNIQUE INDEX IF NOT EXISTS idx_puntos_unico ON puntos_interes(destino_id, nombre_norm);
    CREATE INDEX IF NOT EXISTS idx_trabajos_ref ON trabajos(tipo, referencia_id, id);
  `);

  marcarAplicada(CLAVE);
  console.log(`[bd] Migración hecha: ${sinNorm.length} puntos de interés normalizados.`);
  return true;
}

/**
 * Migracion 6: separar CATALOGO de VIAJE e introducir las ETAPAS.
 *
 * Es la migracion mas grande hasta ahora, asi que conviene decir que NO hace:
 * no borra ni una columna ni una fila. Todo lo viejo sigue donde estaba y
 * sigue leyendose igual; lo que hace es añadir el andamiaje nuevo y colgar de
 * el lo que ya habia.
 *
 * La idea: un viaje de un solo destino es, en el modelo nuevo, un viaje con
 * UNA etapa. Si a cada viaje existente le creamos esa etapa y le colgamos sus
 * candidatos, nada se rompe y a partir de ahora se pueden añadir mas.
 */
function migracionEtapasYCatalogo() {
  const CLAVE = '2026-09-etapas-y-catalogo';
  if (yaAplicada(CLAVE)) return false;

  console.log('[bd] Migrando: separo catálogo de viaje y creo las etapas.');

  // --- 1) Columnas nuevas en tablas que ya existian ------------------------
  // CREATE TABLE IF NOT EXISTS no toca una tabla que ya esta creada, asi que
  // las columnas hay que añadirlas a mano. Se comprueba antes por si alguien
  // (yo, la semana que viene) vuelve a lanzar esto con la BD a medias.
  anadirColumnaSiFalta('candidatos', 'etapa_id', 'INTEGER REFERENCES etapas(id) ON DELETE SET NULL');
  anadirColumnaSiFalta('candidatos', 'transporte_id', 'INTEGER REFERENCES transportes(id) ON DELETE SET NULL');
  anadirColumnaSiFalta('itinerario', 'etapa_id', 'INTEGER REFERENCES etapas(id) ON DELETE SET NULL');

  const viajes = db
    .prepare('SELECT id, destino, fecha_inicio, fecha_fin FROM viajes ORDER BY id')
    .all();

  const insertarEtapa = db.prepare(
    `INSERT INTO etapas (viaje_id, nombre_ciudad, orden, noches, fecha_inicio, fecha_fin, estado, notas)
     VALUES (?, ?, 1, ?, ?, ?, 'confirmada', ?)`
  );
  const insertarTransporte = db.prepare(
    `INSERT INTO transportes (viaje_id, etapa_origen_id, etapa_destino_id, tipo, datos_extra)
     VALUES (?, ?, ?, 'vuelo', ?)`
  );

  let etapasCreadas = 0;
  let candidatosColgados = 0;
  let itinerarioColgado = 0;

  db.exec('BEGIN');
  try {
    for (const viaje of viajes) {
      // Un viaje sin destino no tiene de que hacer etapa. Se queda sin ella y
      // ya la tendra cuando se le ponga uno: la etapa no es obligatoria.
      if (!viaje.destino) continue;

      // Por si esto se relanza a mano sobre una BD que ya tiene etapas.
      const yaTiene = db
        .prepare('SELECT id FROM etapas WHERE viaje_id = ? ORDER BY orden LIMIT 1')
        .get(viaje.id);
      if (yaTiene) continue;

      const etapaId = Number(
        insertarEtapa.run(
          viaje.id,
          viaje.destino,
          nochesEntre(viaje.fecha_inicio, viaje.fecha_fin),
          viaje.fecha_inicio ?? null,
          viaje.fecha_fin ?? null,
          'Etapa creada al separar el modelo en etapas: era el destino único de este viaje.'
        ).lastInsertRowid
      );
      etapasCreadas++;

      // --- Transportes: casa -> etapa -> casa ------------------------------
      // Aunque hoy un candidato de Kayak trae ida Y vuelta en la misma tarjeta,
      // el modelo nuevo quiere las dos patas por separado, porque en una ruta
      // de varias etapas cada salto es un transporte distinto. Creamos las dos
      // y colgamos los vuelos actuales de la de IDA, que es la que existe
      // siempre; la de vuelta queda preparada y sin candidato elegido.
      const idaId = Number(
        insertarTransporte.run(viaje.id, null, etapaId, JSON.stringify({ pata: 'ida' })).lastInsertRowid
      );
      insertarTransporte.run(viaje.id, etapaId, null, JSON.stringify({ pata: 'vuelta' }));

      // --- Candidatos ------------------------------------------------------
      // Hoteles y actividades se duermen y se visitan EN la ciudad -> etapa.
      const r1 = db
        .prepare(
          `UPDATE candidatos SET etapa_id = ?
            WHERE viaje_id = ? AND etapa_id IS NULL AND tipo <> 'vuelo'`
        )
        .run(etapaId, viaje.id);
      // Los vuelos unen sitios, no estan en ninguno -> transporte.
      const r2 = db
        .prepare(
          `UPDATE candidatos SET transporte_id = ?
            WHERE viaje_id = ? AND transporte_id IS NULL AND tipo = 'vuelo'`
        )
        .run(idaId, viaje.id);
      candidatosColgados += r1.changes + r2.changes;

      // --- Itinerario ------------------------------------------------------
      const r3 = db
        .prepare('UPDATE itinerario SET etapa_id = ? WHERE viaje_id = ? AND etapa_id IS NULL')
        .run(etapaId, viaje.id);
      itinerarioColgado += r3.changes;
    }

    db.exec('COMMIT');
  } catch (err) {
    db.exec('ROLLBACK');
    throw err;
  }

  const enCatalogo = volcarActividadesAlCatalogo();

  marcarAplicada(CLAVE);
  console.log(
    `[bd] Migración hecha: ${etapasCreadas} etapas, ${candidatosColgados} candidatos ` +
      `y ${itinerarioColgado} filas de itinerario colgadas; ${enCatalogo} actividades al catálogo.`
  );
  return true;
}

/**
 * Pasa al catalogo las actividades de Civitatis que hoy solo viven dentro de
 * cada viaje. No las borra de ahi: el viaje sigue teniendo sus candidatos y sus
 * marcas, y el catalogo se queda con una copia por CIUDAD, que es de lo que en
 * realidad dependen. Asi el proximo viaje a Lisboa no tiene que volver a
 * scrapear Lisboa.
 */
function volcarActividadesAlCatalogo() {
  const filas = db
    .prepare(
      `SELECT v.destino AS ciudad, c.titulo, c.precio, c.moneda, c.duracion,
              c.valoracion, c.num_opiniones, c.url, c.imagen_url, c.datos_extra
         FROM candidatos c
         JOIN viajes v ON v.id = c.viaje_id
        WHERE c.tipo = 'actividad' AND c.origen_datos = 'civitatis' AND v.destino IS NOT NULL
        ORDER BY c.id`
    )
    .all();

  // INSERT OR IGNORE + UNIQUE(ciudad_norm, clave_unica): la propia BD se
  // encarga de que la misma actividad de la misma ciudad no entre dos veces,
  // aunque este repetida en cinco viajes distintos.
  const insertar = db.prepare(
    `INSERT OR IGNORE INTO catalogo_actividades
       (ciudad, ciudad_norm, clave_unica, titulo, precio, moneda, duracion,
        valoracion, num_opiniones, url, imagen_url, origen_datos, datos_extra)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'civitatis', ?)`
  );

  let metidas = 0;
  db.exec('BEGIN');
  try {
    for (const f of filas) {
      const r = insertar.run(
        f.ciudad,
        normalizarNombre(f.ciudad),
        f.url || `titulo:${f.titulo}`,
        f.titulo,
        f.precio,
        f.moneda,
        f.duracion,
        f.valoracion,
        f.num_opiniones,
        f.url,
        f.imagen_url,
        f.datos_extra
      );
      metidas += r.changes;
    }
    db.exec('COMMIT');
  } catch (err) {
    db.exec('ROLLBACK');
    throw err;
  }
  return metidas;
}

/** Añade una columna solo si no estaba ya: SQLite no tiene IF NOT EXISTS aqui. */
/**
 * EL PRESUPUESTO DEL VIAJE: EL AMBITO DE CADA PRECIO Y EL GASTO DIARIO.
 *
 * Sumar precios de sitios distintos sale mal si no se sabe QUE cuenta cada uno.
 * Los cuatro origenes que tiene la aplicacion no dicen lo mismo:
 *
 *   - Kayak     -> el TOTAL de la reserva. La receta busca la linea "en total"
 *                  justamente para eso, y deja el por-persona en datos_extra.
 *   - Booking   -> el TOTAL de la estancia para la ocupacion pedida.
 *   - Civitatis -> "desde 45 EUR", que es POR PERSONA.
 *   - Traslados -> depende: un billete de tren es de cada uno y un taxi es del
 *                  coche entero. Y dentro del mismo medio "traslado" conviven
 *                  BlaBlaCar (por plaza) y un privado (por vehiculo).
 *
 * Multiplicar por los viajeros lo que ya venia multiplicado dobla el viaje; no
 * multiplicar lo que era de uno lo parte por la mitad. Asi que el ambito se
 * guarda CON el dato, en el momento en que se captura, y la suma solo lo
 * obedece. Ninguna pantalla vuelve a deducirlo.
 *
 * `presupuesto_diario` es la otra mitad: lo que se gasta en comer y en moverse
 * por la ciudad, que no lo trae ninguna busqueda porque no se reserva. Eso lo
 * estima la IA una vez por viaje y se ensena aparte, etiquetado como estimacion.
 * Si el usuario lo toca, `tocado_a_mano` impide que nadie se lo vuelva a pisar.
 */
function migracionPresupuesto() {
  const CLAVE = '2026-09-presupuesto-del-viaje';
  if (yaAplicada(CLAVE)) return false;

  // --- 1) El ambito, en las tres tablas que llevan precio --------------------
  anadirColumnaSiFalta('candidatos', 'precio_ambito', 'TEXT');
  anadirColumnaSiFalta('catalogo_transporte_tramo', 'precio_ambito', 'TEXT');
  anadirColumnaSiFalta('transportes', 'precio_ambito', 'TEXT');

  // Lo que ya estaba guardado tambien tiene ambito: se sabe por su origen, que
  // es exactamente el mismo criterio que se aplica de ahora en adelante.
  db.exec(`
    UPDATE candidatos SET precio_ambito = 'por_grupo'
      WHERE tipo IN ('vuelo', 'hotel') AND precio_ambito IS NULL;
    UPDATE candidatos SET precio_ambito = 'por_persona'
      WHERE tipo = 'actividad' AND precio_ambito IS NULL;
  `);

  db.exec(`
    UPDATE catalogo_transporte_tramo SET precio_ambito = 'por_persona'
      WHERE precio_ambito IS NULL AND medio IN ('tren', 'bus', 'ferry', 'avion', 'otro');
    UPDATE catalogo_transporte_tramo SET precio_ambito = 'por_grupo'
      WHERE precio_ambito IS NULL AND medio IN ('coche', 'traslado');
  `);

  // EL COCHE COMPARTIDO NO ES UN TAXI. BlaBlaCar viene guardado como "traslado"
  // en unos tramos y como "coche" en otros, y en los dos se paga por plaza: es
  // la unica excepcion a la regla del medio, y por eso va escrita aparte.
  db.exec(`
    UPDATE catalogo_transporte_tramo SET precio_ambito = 'por_persona'
     WHERE LOWER(nombre) LIKE '%blablacar%'
        OR LOWER(nombre) LIKE '%compartid%';
  `);

  // Los tramos ya resueltos heredan el ambito de la ficha que se eligio; los
  // apuntados a mano, el de su tipo.
  db.exec(`
    UPDATE transportes
       SET precio_ambito = (
         SELECT f.precio_ambito FROM catalogo_transporte_tramo f
          WHERE f.id = transportes.ficha_transporte_id)
     WHERE ficha_transporte_id IS NOT NULL AND precio_ambito IS NULL;

    UPDATE transportes SET precio_ambito = 'por_persona'
     WHERE precio_ambito IS NULL AND precio_estimado IS NOT NULL
       AND tipo IN ('vuelo', 'tren', 'bus', 'ferry');

    UPDATE transportes SET precio_ambito = 'por_grupo'
     WHERE precio_ambito IS NULL AND precio_estimado IS NOT NULL
       AND tipo IN ('coche', 'traslado', 'taxi');
  `);

  // --- 2) El gasto diario estimado -----------------------------------------
  db.exec(`
    CREATE TABLE IF NOT EXISTS presupuesto_diario (
      viaje_id      INTEGER PRIMARY KEY REFERENCES viajes(id) ON DELETE CASCADE,
      importe       REAL,                      -- euros por persona y dia
      porque        TEXT,                      -- media linea, para poder juzgarlo
      nivel         TEXT,                      -- el nivel de precio con que se calculo
      tocado_a_mano INTEGER NOT NULL DEFAULT 0,
      calculado_en  TEXT
    );
  `);

  // --- 3) El prompt que lo estima, editable como los demas ------------------
  const texto = promptDeGastoDiario();
  db.prepare(
    `INSERT INTO prompts_orquestador (fase, prompt_actual, prompt_fabrica)
     VALUES ('gasto_diario', ?, ?)
     ON CONFLICT (fase) DO UPDATE SET
       prompt_actual = CASE WHEN prompt_actual = prompt_fabrica THEN excluded.prompt_actual ELSE prompt_actual END,
       prompt_fabrica = excluded.prompt_fabrica`
  ).run(texto, texto);

  marcarAplicada(CLAVE);
  console.log('[bd] Migracion: presupuesto del viaje (ambito de los precios y gasto diario).');
  return true;
}

/**
 * EL PROMPT DEL GASTO DIARIO.
 *
 * Es lo unico del presupuesto que no se puede buscar: nadie publica lo que se
 * gasta uno al dia. Por eso vive en su propio bloque de la pantalla, con la
 * palabra "estimacion" delante, y por eso lo primero que se le pide al modelo es
 * una cifra que alguien reconoceria como razonable, no una precision falsa.
 *
 * Se pide TAMBIEN el porque en media linea. Sin el, un numero suelto no se puede
 * juzgar: con el, se ve en que se ha ido el dinero y si el nivel encaja.
 */
function promptDeGastoDiario() {
  return `Estima cuanto se gasta AL DIA y POR PERSONA en {{DESTINO}}, pasando por {{CIUDADES}}, en COMIDA, BEBIDA y TRANSPORTE URBANO.

Nada mas: ni excursiones, ni entradas, ni alojamiento, ni los viajes entre ciudades. Todo eso ya esta contado aparte con precios reales, y sumarlo aqui otra vez seria contarlo dos veces.

NIVEL DEL VIAJE: {{NIVEL}}
  - sencillo: desayuno de bar, comida de menu del dia o de mercado, cena normal, metro y autobus.
  - normal: cafe por la manana, comida informal, cena en un sitio decente, algun taxi corto.
  - con caprichos: sin mirar la carta por el precio, buena cena casi todos los dias, taxi cuando apetezca.

VIAJEROS: {{VIAJEROS}}
DIAS: {{DIAS}}

REGLAS:
1. UN solo numero, en euros, por persona y por dia. Si hay ninos, da la media del grupo.
2. Es una ESTIMACION y se va a ensenar como tal, separada de los precios reales. No hace falta acertar al euro; hace falta una cifra que alguien que conozca ese pais reconoceria como razonable hoy.
3. Ajustalo al pais y a las ciudades concretas: no cuesta lo mismo comer en Napoles que en Copenhague, ni en una capital que en un pueblo.
4. El porque, en MEDIA LINEA: pais, nivel y en que se va el dinero.
   Ejemplo: "Grecia, nivel normal: ~45 EUR/persona/dia en tabernas y transporte urbano".
5. En espanol de Espana.

Devuelve SOLO este JSON:
{"importe": 45, "porque": "Grecia, nivel normal: ~45 EUR/persona/dia en tabernas y transporte urbano"}`;
}

/**
 * LA CAPA METEOROLOGICA DE LA FICHA DE PAIS.
 *
 * DOS COSAS DISTINTAS QUE LA GENTE CONFUNDE, y por eso van en dos tablas:
 *
 *   clima_tipico · QUE SUELE HACER en esas fechas del ano. Sale del archivo
 *                  historico de Open-Meteo —mediciones reales de los ultimos
 *                  anos, no un modelo— y no caduca: lo que hizo en Atenas la
 *                  ultima semana de septiembre de 2021 a 2025 ya no va a
 *                  cambiar. Se guarda por CIUDAD y por las fechas de SU parada,
 *                  que es lo que hace que un viaje largo ensene Atenas en
 *                  septiembre y Tesalonica en octubre, cada una con lo suyo.
 *
 *   clima_ahora  · QUE ESTA PASANDO ALLI ESTA SEMANA. Prevision de los proximos
 *                  dias. No depende de las fechas del viaje —sirve para mirar
 *                  el destino aunque falten meses— y por eso la clave es solo la
 *                  ciudad, con su hora de actualizacion bien guardada.
 *
 * NO VAN DENTRO DE `fichas_pais` A PROPOSITO. Esa tabla se comparte entre viajes
 * con el mismo pais y las mismas fechas, y el clima es de las CIUDADES de cada
 * ruta: metido ahi, un viaje a Grecia por Tesalonica acabaria ensenando el clima
 * de Atenas de otro viaje. Es el mismo susto que ya dio el dosier con las fichas
 * de pais. Asi que se guardan por ciudad y la pantalla arma las lineas con las
 * paradas de SU viaje.
 */
function migracionClima() {
  const CLAVE = '2026-09-clima-de-la-ficha';
  if (yaAplicada(CLAVE)) return false;

  db.exec(`
    CREATE TABLE IF NOT EXISTS clima_tipico (
      ciudad_norm  TEXT NOT NULL,
      fecha_inicio TEXT,
      fecha_fin    TEXT,
      ciudad       TEXT NOT NULL,
      lat          REAL,
      lon          REAL,
      datos        TEXT NOT NULL,           -- JSON con las medias y la frase
      generado_en  TEXT NOT NULL DEFAULT (datetime('now')),
      PRIMARY KEY (ciudad_norm, fecha_inicio, fecha_fin)
    );

    CREATE TABLE IF NOT EXISTS clima_ahora (
      ciudad_norm    TEXT PRIMARY KEY,
      ciudad         TEXT NOT NULL,
      lat            REAL,
      lon            REAL,
      datos          TEXT NOT NULL,         -- JSON con los dias y los avisos
      actualizado_en TEXT NOT NULL DEFAULT (datetime('now'))
    );
  `);

  // --- Los umbrales de lo severo, editables como todo lo demas -------------
  //
  // Son un juicio, no una verdad. Setenta kilometros por hora de racha es
  // incomodo en Atenas y normal en Punta Arenas, asi que el numero tiene que
  // poder cambiarse sin tocar codigo. Van a la seccion General porque no son de
  // ninguna fase del orquestador: valen igual mirando la ficha de un pais.
  const meter = db.prepare(
    `INSERT INTO parametros_orquestador (clave, valor, valor_fabrica, descripcion, unidad, orden)
     VALUES (?, ?, ?, ?, ?, ?)
     ON CONFLICT (clave) DO NOTHING`
  );
  let orden = db.prepare('SELECT COALESCE(MAX(orden), 0) AS n FROM parametros_orquestador').get().n;
  const nuevo = (clave, valor, descripcion, unidad) => meter.run(clave, valor, valor, descripcion, unidad, ++orden);

  nuevo('anos_historico_clima', '5', 'Cuantos anos atras se miran para saber que tiempo suele hacer en esas fechas', 'anos');
  nuevo('dias_prevision', '7', 'Cuantos dias de prevision se piden para el bloque de "ahora en el destino"', 'dias');
  nuevo('calor_extremo_c', '35', 'Maxima prevista a partir de la cual el bloque de ahora avisa de calor', 'grados');
  nuevo('frio_extremo_c', '-5', 'Minima prevista por debajo de la cual el bloque de ahora avisa de frio', 'grados');
  nuevo('lluvia_torrencial_mm', '30', 'Litros en un dia a partir de los cuales la lluvia deja de ser lluvia', 'mm');
  nuevo('racha_viento_fuerte_kmh', '60', 'Racha maxima a partir de la cual se avisa de viento fuerte', 'km/h');

  marcarAplicada(CLAVE);
  console.log('[bd] Migracion: capa meteorologica de la ficha de pais.');
  return true;
}

/**
 * LO QUE HAY QUE RESERVAR CON SEMANAS DE ANTELACION.
 *
 * Un horario de apertura te dice si HOY esta abierto. No te dice que las
 * entradas de la Alhambra se agotan con un mes, ni que el Museo Ghibli las
 * vende el dia 10 del mes anterior y punto. Ese dato no se descubre mirando la
 * ficha: se descubre el dia que intentas entrar, y entonces ya no sirve.
 *
 * DOS CAMPOS Y NO UNO:
 *
 *   reserva_anticipada · 'no' | 'recomendada' | 'imprescindible'. Es lo que
 *                        decide si se avisa y con cuanto tiempo. Tres valores y
 *                        no un si/no, porque «conviene» y «o reservas o no
 *                        entras» no son la misma frase ni piden la misma prisa.
 *   reserva_detalle    · el texto tal y como lo diga la fuente: cuanta
 *                        antelacion y donde se compra. Sin esto, el aviso seria
 *                        «reserva con tiempo», que no le dice a nadie que hacer.
 *
 * NULL es distinto de 'no': null es «no se ha mirado» y 'no' es «se ha mirado y
 * no hace falta». La diferencia importa para el boton de revisar los sitios que
 * ya estaban apuntados antes de que esto existiera.
 */
function migracionReservaAnticipada() {
  const CLAVE = '2026-09-reserva-anticipada-sitios';
  if (yaAplicada(CLAVE)) return false;

  anadirColumnaSiFalta('sitios_lugar', 'reserva_anticipada', 'TEXT');
  anadirColumnaSiFalta('sitios_lugar', 'reserva_detalle', 'TEXT');
  // Cuando se miro, para poder distinguir «sin revisar» de «revisado y no hace
  // falta» aunque el resultado sea 'no'.
  anadirColumnaSiFalta('sitios_lugar', 'reserva_en', 'TEXT');

  const meter = db.prepare(
    `INSERT INTO parametros_orquestador (clave, valor, valor_fabrica, descripcion, unidad, orden)
     VALUES (?, ?, ?, ?, ?, ?)
     ON CONFLICT (clave) DO NOTHING`
  );
  let orden = db.prepare('SELECT COALESCE(MAX(orden), 0) AS n FROM parametros_orquestador').get().n;
  const nuevo = (clave, valor, descripcion, unidad) => meter.run(clave, valor, valor, descripcion, unidad, ++orden);

  // LOS DOS PLAZOS SON DISTINTOS A PROPOSITO. Lo imprescindible avisa pronto,
  // porque a treinta dias todavia da tiempo a comprar la entrada o a cambiar el
  // plan. Lo recomendable avisa tarde, en la ultima quincena, porque un aviso
  // que sale con tres meses de margen se lee, se olvida y estorba a los demas.
  nuevo('dias_aviso_reserva', '30', 'A cuantos dias del viaje se avisa de los sitios de reserva imprescindible', 'dias');
  nuevo('dias_aviso_reserva_recomendada', '15', 'Lo mismo para los de reserva solo recomendable, que avisan mas tarde', 'dias');

  marcarAplicada(CLAVE);
  console.log('[bd] Migracion: aviso de reserva anticipada en los sitios.');
  return true;
}

/**
 * VIAJES DE MAS DE UN PAIS.
 *
 * Hasta ahora `viajes.destino` era un pais y punto: la regla 1 de la fase 1 dice
 * que proponer una ciudad de otro pais es el peor fallo posible, y esa regla es
 * la que ha mantenido a raya las alucinaciones. La regla se queda; lo que cambia
 * es contra que se compara. Deja de ser "no te salgas de Croacia" y pasa a ser
 * "no te salgas de EXACTAMENTE estos paises", con la lista delante.
 *
 * `destino` NO se toca: sigue siendo lo que el usuario escribio ("Croacia y
 * Montenegro") y es lo que se lee en el chip de Mi ruta. Lo que se anade es la
 * lista interpretada, que es con lo que trabajan las fases.
 *
 *   paises          · JSON con los nombres en espanol: ["Croacia","Montenegro"].
 *                     Vacio o null = viaje de un pais, y todo sigue igual que
 *                     antes. Esa es la garantia de que esto no toca el flujo
 *                     que ya funciona.
 *   paises_estado   · 'interpretado' (la IA ha leido el texto y espera un si),
 *                     'confirmado' (el usuario ha cerrado la lista y el
 *                     orquestador puede arrancar).
 *   paises_dialogo  · JSON con la ultima opinion de la IA sobre la seleccion.
 *                     Se guarda para que recargar la pantalla no la pierda ni
 *                     obligue a volver a preguntar.
 *
 *   fronteras       · JSON con los cruces que hace la ruta CONFIRMADA. Va aqui y
 *                     no en `fichas_pais` porque no depende del pais sino del
 *                     ORDEN real de las paradas: la misma pareja de paises da
 *                     un cruce o dos segun por donde se vuelva.
 */
function migracionMultipais() {
  const CLAVE = '2026-09-viajes-de-varios-paises';
  if (yaAplicada(CLAVE)) return false;

  anadirColumnaSiFalta('viajes', 'paises', 'TEXT');
  anadirColumnaSiFalta('viajes', 'paises_estado', 'TEXT');
  anadirColumnaSiFalta('viajes', 'paises_dialogo', 'TEXT');
  anadirColumnaSiFalta('viajes', 'fronteras', 'TEXT');
  anadirColumnaSiFalta('viajes', 'fronteras_en', 'TEXT');

  const meter = db.prepare(
    `INSERT INTO prompts_orquestador (fase, prompt_actual, prompt_fabrica)
     VALUES (?, ?, ?)
     ON CONFLICT (fase) DO UPDATE SET
       prompt_actual = CASE WHEN prompt_actual = prompt_fabrica THEN excluded.prompt_actual ELSE prompt_actual END,
       prompt_fabrica = excluded.prompt_fabrica`
  );
  meter.run('paises_interpretar', promptDeInterpretarPaises(), promptDeInterpretarPaises());
  meter.run('paises_criterio', promptDeCriterioDePaises(), promptDeCriterioDePaises());
  meter.run('fronteras', promptDeFronteras(), promptDeFronteras());

  marcarAplicada(CLAVE);
  console.log('[bd] Migracion: viajes de mas de un pais.');
  return true;
}

/**
 * DE LO QUE ESCRIBE EL USUARIO A UNA LISTA DE PAISES.
 *
 * Es un paso de lectura, no de criterio: aqui no se opina sobre si el viaje
 * tiene sentido, solo se traduce "Croacia y Montenegro" a dos nombres. Y si el
 * texto es ambiguo se DICE, en vez de elegir por su cuenta: preguntar cuesta un
 * clic y adivinar mal cuesta un viaje entero montado sobre el pais equivocado.
 */
function promptDeInterpretarPaises() {
  return `Un usuario ha escrito esto como destino de su viaje:

"{{TEXTO}}"

Dime QUE PAISES son. Nada mas: no opines sobre el viaje, no propongas ciudades,
no digas si es buena idea. Solo lee.

REGLAS:
1. Nombres de pais en ESPANOL y en su forma habitual: "Bosnia y Herzegovina",
   "Republica Checa", "Corea del Sur".
2. Si el texto nombra una REGION o una CIUDAD, devuelve el pais al que pertenece
   y dilo en "nota": "Toscana" es Italia, "Bali" es Indonesia.
3. Si algo esta mal escrito pero se entiende sin duda ("Cracovia", "Montenegr"),
   corrigelo y sigue.
4. "seguro" es false cuando el texto es AMBIGUO de verdad: un nombre que puede
   ser dos paises, una region que se reparte entre varios ("Laponia" es Finlandia,
   Suecia, Noruega y Rusia), o algo que no reconoces. Con false explica la duda
   en "nota" y pon en "paises" tu mejor lectura para que se pueda confirmar o
   corregir. NO inventes un pais para rellenar.
5. El orden importa: devuelvelos en el orden en que los escribio el usuario.

Devuelve SOLO este JSON:
{"paises": ["Croacia", "Montenegro"], "seguro": true, "nota": null}`;
}

/**
 * EL DIALOGO DE CRITERIO, y la distincion que lo hace util.
 *
 * Hay dos formas de que una combinacion no funcione y no se parecen en nada:
 *
 *   "no te lo recomiendo"  es una opinion. Se puede insistir, y el orquestador
 *                          lo monta tal cual: es el viaje de quien lo hace.
 *   "no cabe"              es aritmetica. Si solo los traslados minimos entre
 *                          esos paises se comen los dias que hay, no hay viaje
 *                          que montar, y dejar insistir seria mentir.
 *
 * Por eso se le pide que marque cual de las dos es, y con que numeros lo dice.
 * Sin esa distincion, el boton de "asi lo quiero" o no existe —y entonces la
 * app decide por ti— o existe siempre —y entonces te deja montar un imposible—.
 *
 * NADA DE BUSQUEDAS EN ESTE PASO. Es criterio de viajero sobre un mapa: que hay
 * entre esos paises, cuanto se tarda, cuantas fronteras. Los precios y los
 * horarios llegan despues, en las fases que si buscan.
 */
function promptDeCriterioDePaises() {
  return `Eres un planificador de viajes con experiencia real en la zona. Te doy
una combinacion de paises y unos dias, y quiero tu criterio ANTES de montar nada.

EL VIAJE
- Paises que quiere visitar: {{SELECCION}}
- Todos los que menciono: {{TODOS}}
- Fechas: del {{FECHA_INICIO}} al {{FECHA_FIN}} ({{DIAS}} dias)
- Salen desde: {{ORIGEN}}
- Viajeros: {{VIAJEROS}}
- Ritmo: {{RITMO}}

Evalua ESA SELECCION. Para cada pais de la lista completa, di si entra o no y
por que, en UNA frase.

REGLAS:
1. Piensa en TIEMPO UTIL, no en kilometros. Lo que mata un viaje corto no es la
   distancia: son los cruces de frontera, los cambios de alojamiento y las
   medias jornadas que se van en traslados. Un pais que obliga a un tercer
   cruce para dos noches casi nunca compensa.
2. "veredicto" del viaje entero es UNO de estos dos, y la diferencia importa:
     "cabe"     la combinacion es viable, aunque no sea la que tu elegirias.
                Se puede montar. Si no te gusta, dilo en "opinion" y en las
                frases de cada pais, pero el veredicto sigue siendo "cabe".
     "no_cabe"  MATERIALMENTE imposible: solo los traslados minimos entre esos
                paises se comen los dias disponibles y no queda viaje. Usa esto
                SOLO con numeros detras, y ponlos en "por_que_no_cabe":
                cuantas horas de traslado minimo y cuantos dias hay.
   No uses "no_cabe" porque te parezca apretado o poco recomendable. Apretado es
   "cabe" con una opinion clara. "no_cabe" es que no existe manera.
3. "recomendado" es tu criterio pais a pais: true si lo dejarias dentro con
   estos dias, false si lo quitarias. Puedes recomendar quitar un pais y que el
   veredicto siga siendo "cabe": son cosas distintas.
4. En "opinion", DOS o TRES frases sobre la seleccion actual: que ruta tendria
   sentido, que se gana quitando algo, que se pierde. Habla claro y sin adornos.
5. NADA de precios, horarios ni datos que no puedas saber de memoria. Esto es
   criterio geografico y de tiempos, y se enseña como tal.
6. En espanol de Espana.

Devuelve SOLO este JSON:
{
  "veredicto": "cabe",
  "por_que_no_cabe": null,
  "opinion": "Croacia y Montenegro en 7 dias se hace bien por la costa...",
  "paises": [
    {"nombre": "Croacia", "recomendado": true, "por_que": "Es el eje del viaje y por donde se entra."},
    {"nombre": "Montenegro", "recomendado": false, "por_que": "Da para un viaje propio y te obliga a un tercer cruce que se come medio dia."}
  ]
}`;
}

/**
 * LOS CRUCES DE FRONTERA DE UNA RUTA YA DECIDIDA.
 *
 * Esto no se puede preguntar antes: depende del ORDEN de las paradas. La misma
 * pareja de paises da un cruce o dos segun por donde se vuelva, y el caso que
 * de verdad pilla a la gente es la DOBLE ENTRADA —volar de vuelta desde
 * Singapur despues de haber pasado por Malasia exige poder entrar dos veces en
 * Singapur—, que no se ve mirando la lista de paises: se ve mirando la ruta.
 */
function promptDeFronteras() {
  return `Esta es la ruta REAL y ya decidida de un viaje, en orden:

{{RUTA}}

El viajero tiene pasaporte de {{PASAPORTE}}. Vuela desde {{ORIGEN}} y vuelve a
{{ORIGEN}}.

Dime que pasos de frontera hace esta ruta y que hace falta en cada uno.

REGLAS:
1. UN punto por cada cruce que se hace de verdad, en el orden del viaje. Si dos
   paradas seguidas son del mismo pais, ahi no hay frontera y no se menciona.
2. "tipo" es "terrestre", "aereo" o "maritimo", segun como se cruce en ESTA ruta.
3. "que_pide": que documentacion y que trato tiene ese paso concreto para ese
   pasaporte, en una o dos frases. Si es un paso Schengen interno sin control,
   dilo: tambien es informacion.
4. LA DOBLE ENTRADA es lo mas importante de esta lista. Si la ruta ENTRA MAS DE
   UNA VEZ en el mismo pais —porque se vuelve a pasar por el, o porque el vuelo
   de vuelta sale de alli—, tiene que salir un punto con "dobleEntrada": true
   explicando que hacen falta dos entradas y que eso puede exigir un visado de
   entradas multiples. Es el fallo que se descubre en el mostrador.
5. No inventes tasas ni importes. Si no estas seguro de un requisito, dilo en
   vez de afirmarlo: esto se lee para preparar papeles con semanas.
6. En espanol de Espana y en frases cortas.

Devuelve SOLO este JSON:
{
  "cruces": [
    {"desde": "Croacia", "hasta": "Montenegro", "entre": "Dubrovnik → Kotor",
     "tipo": "terrestre", "que_pide": "...", "dobleEntrada": false}
  ],
  "nota": null
}`;
}

/**
 * LA REGLA 1 DE LA FASE 1, AHORA CON UNA LISTA DELANTE.
 *
 * La regla decia "no te salgas de {{DESTINO}}" y funcionaba: es la que ha
 * mantenido a raya las alucinaciones —para un viaje a Paris llego a proponer
 * Amberes y Brujas—. No se relaja: se le cambia el objeto. Deja de ser "no te
 * salgas de Croacia" y pasa a ser "no te salgas de EXACTAMENTE estos paises",
 * con la lista escrita. Con un solo pais la lista tiene un elemento y la regla
 * dice literalmente lo mismo que decia antes.
 *
 * Se sustituye SOLO ese parrafo. El resto del prompt —los pesos, los tiempos,
 * el minimo de noches— no tiene nada que ver con esto y no se toca. Y si el
 * usuario habia editado el prompt a mano, no se le pisa: se actualiza el de
 * fabrica y el suyo se queda, que es la regla de siempre de esta tabla.
 */
function migracionRegla1ConVariosPaises() {
  const CLAVE = '2026-09-regla1-varios-paises';
  if (yaAplicada(CLAVE)) return false;

  const fila = db
    .prepare("SELECT prompt_actual, prompt_fabrica FROM prompts_orquestador WHERE fase = 'ciudades_y_noches'")
    .get();
  if (!fila) { marcarAplicada(CLAVE); return false; }

  const VIEJO = `1. NO TE SALGAS DE {{DESTINO}}. Si el destino es un país, todas las ciudades son
   de ese país. Si el destino es UNA CIUDAD, el viaje es esa ciudad: la única
   candidata es ella, y solo añades otra si de verdad merece dormir allí —no un
   sitio que se ve en media jornada y se vuelve a cenar—. Proponer ciudades de
   otro país es el peor fallo que puedes cometer aquí.`;

  const NUEVO = `1. NO TE SALGAS DE ESTOS PAÍSES: {{LISTA_PAISES}}. Todas las ciudades que
   propongas tienen que estar en uno de ellos. Proponer una ciudad de fuera de
   esa lista es el peor fallo que puedes cometer aquí.
   Si el destino es UNA CIUDAD, el viaje es esa ciudad: la única candidata es
   ella, y solo añades otra si de verdad merece dormir allí —no un sitio que se
   ve en media jornada y se vuelve a cenar—.
   Cuando la lista tiene VARIOS países, las candidatas de todos compiten juntas
   por peso y por geografía: no repartas cupos por país ni metas una ciudad
   floja solo para que ese país aparezca. Si con los días que hay un país solo
   da para una parada —o para ninguna—, eso es un resultado correcto.`;

  const cambiar = (t) => (t && t.includes(VIEJO) ? t.replace(VIEJO, NUEVO) : t);

  const nuevaFabrica = cambiar(fila.prompt_fabrica);
  // Al prompt en uso solo se le toca si era el de fabrica; si lo editaste tú,
  // se queda como lo dejaste.
  const nuevoActual =
    fila.prompt_actual === fila.prompt_fabrica ? nuevaFabrica : fila.prompt_actual;

  db.prepare(
    "UPDATE prompts_orquestador SET prompt_actual = ?, prompt_fabrica = ? WHERE fase = 'ciudades_y_noches'"
  ).run(nuevoActual, nuevaFabrica);

  const hecho = nuevaFabrica !== fila.prompt_fabrica;
  marcarAplicada(CLAVE);
  console.log(
    `[bd] Migracion: la regla 1 de la fase 1 ${hecho ? 'ya habla de una lista de paises' : 'NO se pudo cambiar (texto distinto del esperado)'}.`
  );
  return true;
}

/**
 * DOS FRASES DEL PROMPT DE LA PUERTA QUE HABLABAN DE "EL PAIS".
 *
 * No eran reglas de "no te salgas": son el criterio de por donde entrar y salir,
 * que es open-jaw y no sabe de fronteras. Pero decian "lo mejor del pais" y
 * "recorrer el pais de una sola pasada", y con dos paises eso empuja al modelo a
 * optimizar uno solo. Se cambia "pais" por "viaje", que es lo que de verdad se
 * esta recorriendo, y la regla dice lo mismo en los dos casos.
 */
function migracionPuertaSinUnSoloPais() {
  const CLAVE = '2026-09-puerta-sin-un-solo-pais';
  if (yaAplicada(CLAVE)) return false;

  const fila = db
    .prepare("SELECT prompt_actual, prompt_fabrica FROM prompts_orquestador WHERE fase = 'ciudades_y_noches'")
    .get();
  if (!fila) { marcarAplicada(CLAVE); return false; }

  const CAMBIOS = [
    ['Entrando por Gdansk se recorría el\npaís de una sola pasada.',
     'Entrando por Gdansk se recorría la\nruta de una sola pasada.'],
    ['dejar fuera lo mejor del país no es buena aunque el avión sea corto.',
     'dejar fuera lo mejor del viaje no es buena aunque el avión sea corto.'],
  ];

  const cambiar = (t) => {
    let salida = t ?? '';
    for (const [viejo, nuevo] of CAMBIOS) {
      if (salida.includes(viejo)) salida = salida.replace(viejo, nuevo);
    }
    return salida;
  };

  const nuevaFabrica = cambiar(fila.prompt_fabrica);
  const nuevoActual = fila.prompt_actual === fila.prompt_fabrica ? nuevaFabrica : fila.prompt_actual;

  db.prepare(
    "UPDATE prompts_orquestador SET prompt_actual = ?, prompt_fabrica = ? WHERE fase = 'ciudades_y_noches'"
  ).run(nuevoActual, nuevaFabrica);

  marcarAplicada(CLAVE);
  console.log(
    `[bd] Migracion: el prompt de la puerta ${nuevaFabrica !== fila.prompt_fabrica ? 'ya no asume un solo pais' : 'no necesitaba cambios'}.`
  );
  return true;
}

/**
 * CORRECTIVO DE ATENAS: lo que costo tres excursiones fuera del lienzo.
 *
 * DOS PARAMETROS para que una excursion colocada ocupe de verdad. Hasta ahora
 * `duracionDeLoColocado` solo sabia de sitios, asi que una excursion entraba con
 * duracion NULA y era invisible para el validador: el crucero de diez horas del
 * dia 6 ocupaba lo mismo que nada y la revision le mando encima el Museo de la
 * Acropolis a las 9:00. Cuando el catalogo dice "dia completo" sin numero, hace
 * falta un valor; cuando no dice nada, otro.
 *
 * Y DOS REGLAS DE PROMPT, que es donde estaban los otros dos fallos:
 *
 *   Las excursiones se elegian sin saber cuantos dias libres tenia la parada.
 *   Atenas tenia UNO —dia de llegada, dia de la Acropolis, dia de salida— y se
 *   preseleccionaron tres de dia completo. Elegir menos y que entre todo vale
 *   mas que elegir mucho y que sobre: el aviso de "apuntada pero sin sitio"
 *   tiene que ser la excepcion, no el resultado normal de la fase.
 *
 *   Y la guillotina de las dos noches se aplicaba a unos si y a otros no: Delfos
 *   fuera "por no llegar a 2 noches" y Nauplia dentro con 1. Puede haber
 *   excepcion —un transito geografico obligado—, pero entonces tiene que caber
 *   lo que se va a ver alli. Parar a dormir en Nauplia y que Micenas no quepa es
 *   quedarse con lo peor de las dos opciones.
 */
function migracionCorrectivoAtenas() {
  const CLAVE = '2026-09-correctivo-atenas';
  if (yaAplicada(CLAVE)) return false;

  // --- 1) Lo que ocupa una excursion cuando no lo dice con numeros ---------
  const meter = db.prepare(
    `INSERT INTO parametros_orquestador (clave, valor, valor_fabrica, descripcion, unidad, orden)
     VALUES (?, ?, ?, ?, ?, ?)
     ON CONFLICT (clave) DO NOTHING`
  );
  let orden = db.prepare('SELECT COALESCE(MAX(orden), 0) AS n FROM parametros_orquestador').get().n;
  const nuevo = (clave, valor, descripcion, unidad) =>
    meter.run(clave, valor, valor, descripcion, unidad, ++orden);

  nuevo('excursion_dia_completo_min', '480', 'Lo que ocupa una excursion que dice "dia completo" sin dar horas', 'minutos');
  nuevo('excursion_por_defecto_min', '180', 'Lo que ocupa una excursion que no dice cuanto dura', 'minutos');

  // --- 2) La fase de excursiones sabe cuantos dias hay ---------------------
  const exc = db
    .prepare("SELECT prompt_actual, prompt_fabrica FROM prompts_orquestador WHERE fase = 'excursiones'")
    .get();
  if (exc) {
    const REGLA_DIAS = `
DIAS DISPONIBLES, Y ESTO MANDA SOBRE TODO LO DEMAS:
En {{CIUDAD}} hay {{DIAS_UTILES}} dia(s) con hueco para una excursion LARGA (de
media jornada o mas). Son los dias de la parada menos el de llegada, el de
salida y los que ya se comen los traslados.

NO preselecciones mas excursiones de dia completo que dias disponibles. Si hay
un dia, eliges UNA; si hay cero, no eliges ninguna larga por buena que sea, y lo
dices en el motivo. Las cortas (dos o tres horas) no gastan ese cupo: caben
dentro de un dia que ya tiene otras cosas.

Elegir menos y que entre todo vale mas que elegir mucho y que sobre. Una
excursion preseleccionada que despues no cabe en ningun dia no es media victoria:
es una tarjeta marcada que no esta en el viaje.
`;

    const ponRegla = (t) => {
      if (!t || t.includes('{{DIAS_UTILES}}')) return t;
      // Va delante de las reglas, que es donde se lee antes de decidir.
      const marca = '\nREGLAS';
      const i = t.indexOf(marca);
      return i > 0 ? t.slice(0, i) + '\n' + REGLA_DIAS + t.slice(i) : t + '\n' + REGLA_DIAS;
    };

    const nuevaFabrica = ponRegla(exc.prompt_fabrica);
    const nuevoActual = exc.prompt_actual === exc.prompt_fabrica ? nuevaFabrica : exc.prompt_actual;
    db.prepare(
      "UPDATE prompts_orquestador SET prompt_actual = ?, prompt_fabrica = ? WHERE fase = 'excursiones'"
    ).run(nuevoActual, nuevaFabrica);
  }

  // --- 3) La guillotina de las dos noches, con su excepcion razonada -------
  const ciu = db
    .prepare("SELECT prompt_actual, prompt_fabrica FROM prompts_orquestador WHERE fase = 'ciudades_y_noches'")
    .get();
  if (ciu) {
    const REGLA_NOCHES = `
LA REGLA DE LAS DOS NOCHES SE APLICA IGUAL PARA TODOS, O SE RAZONA:
Una parada por debajo de {{MINIMO_NOCHES}} noches solo vale si se cumplen LAS
DOS cosas a la vez:
  (a) es transito geografico obligado de la ruta —se pasa por ahi si o si—, y
  (b) lo que se va a ver alli cabe en el tiempo util que le queda.

Si (b) no se cumple, elige una de las tres y dilo en "por_que":
  · darle la segunda noche quitandosela a otra parada,
  · convertirla en parada DE PASO sin noche (comer y una visita corta de camino),
  · o dejarla fuera.

Lo que no vale es parar a dormir en un sitio cuyo motivo principal no cabe. Paso
de verdad: Delfos se quedo fuera "por no llegar a 2 noches" y Nauplia entro con
una, y Micenas —que era la razon de parar en Nauplia— no cupo. Se pago la noche
y no se vio lo que se iba a ver.
`;

    const ponRegla = (t) => {
      if (!t || t.includes('LA REGLA DE LAS DOS NOCHES SE APLICA IGUAL')) return t;
      return t + '\n' + REGLA_NOCHES;
    };

    const nuevaFabrica = ponRegla(ciu.prompt_fabrica);
    const nuevoActual = ciu.prompt_actual === ciu.prompt_fabrica ? nuevaFabrica : ciu.prompt_actual;
    db.prepare(
      "UPDATE prompts_orquestador SET prompt_actual = ?, prompt_fabrica = ? WHERE fase = 'ciudades_y_noches'"
    ).run(nuevoActual, nuevaFabrica);
  }

  // --- 4) Las excursiones YA COLOCADAS, que entraron con duracion nula -----
  //
  // No es cosmetico: mientras `duracion_min` sea NULL, esa tarjeta ocupa cero
  // para el validador y se le puede colocar otra encima. Se rellena con la
  // duracion del propio candidato, que es la del catalogo de Civitatis. Solo
  // toca lo que esta a NULL: una duracion escrita a mano no se pisa.
  const rellenadas = db
    .prepare(
      `UPDATE itinerario
          SET duracion_min = (
            SELECT CASE
              WHEN c.duracion LIKE '%dia completo%' OR c.duracion LIKE '%día completo%' THEN 480
              ELSE NULL END
            FROM candidatos c WHERE c.id = itinerario.candidato_id)
        WHERE duracion_min IS NULL
          AND candidato_id IN (SELECT id FROM candidatos WHERE tipo = 'actividad')
          AND EXISTS (SELECT 1 FROM candidatos c WHERE c.id = itinerario.candidato_id
                        AND (c.duracion LIKE '%dia completo%' OR c.duracion LIKE '%día completo%'))`
    )
    .run();

  // Las que dan horas concretas ("8h 30m - 9h") no se pueden convertir en SQL
  // sin reimplementar el lector de duraciones, asi que se marcan para que las
  // rellene el codigo la primera vez que se lea el lienzo.
  const pendientes = db
    .prepare(
      `SELECT COUNT(*) AS n FROM itinerario
        WHERE duracion_min IS NULL
          AND candidato_id IN (SELECT id FROM candidatos WHERE tipo IN ('actividad', 'comer'))`
    )
    .get().n;

  marcarAplicada(CLAVE);
  console.log(
    '[bd] Migracion: correctivo de Atenas (ocupacion de excursiones, dias utiles y guillotina).' +
      (pendientes ? ` ${pendientes} colocacion(es) sin duracion se rellenaran al leer el lienzo.` : '')
  );
  return true;
}

/**
 * LOS TRASLADOS YA ELEGIDOS TAMBIEN SE RESERVAN.
 *
 * `reservas` cuelga siempre de un candidato. Los vuelos tenian el suyo desde que
 * se elegian; los traslados por tierra no tenian ninguno, asi que el tipo
 * 'traslado' estaba declarado en TIPOS_RESERVABLES desde el primer dia y no
 * habia ni una fila que lo usara: ni check, ni cajon, ni localizador.
 *
 * De aqui en adelante lo crea `elegirMedio`. Esto es para los saltos que ya
 * estaban resueltos: se les da su candidato con la ficha que tienen elegida.
 *
 * SIN PRECIO A PROPOSITO. El del traslado vive en `transportes.precio_estimado`,
 * que es de donde lo lee el presupuesto con su ambito; ponerlo tambien en el
 * candidato lo sumaria dos veces en el panel de "Tu seleccion".
 */
function migracionReservaDeTraslados() {
  const CLAVE = '2026-09-reserva-de-traslados';
  if (yaAplicada(CLAVE)) return false;

  const resueltos = db
    .prepare(
      `SELECT t.id, t.viaje_id, f.id AS ficha_id, f.nombre, f.duracion, f.web
         FROM transportes t
         JOIN catalogo_transporte_tramo f ON f.id = t.ficha_transporte_id
        WHERE t.ficha_transporte_id IS NOT NULL
          AND NOT EXISTS (
            SELECT 1 FROM candidatos c
             WHERE c.transporte_id = t.id AND c.tipo = 'traslado')`
    )
    .all();

  const meter = db.prepare(
    `INSERT INTO candidatos
       (viaje_id, transporte_id, tipo, titulo, duracion, url, origen_datos, marcado, datos_extra)
     VALUES (?, ?, 'traslado', ?, ?, ?, 'catalogo', 1, ?)`
  );

  for (const t of resueltos) {
    meter.run(
      t.viaje_id,
      t.id,
      String(t.nombre || 'Traslado').slice(0, 200),
      t.duracion || null,
      t.web || null,
      JSON.stringify({ de: 'tramo', deId: t.ficha_id })
    );
  }

  marcarAplicada(CLAVE);
  console.log(
    `[bd] Migracion: ${resueltos.length} traslado(s) ya elegido(s) pasan a ser reservables.`
  );
  return true;
}

function anadirColumnaSiFalta(tabla, columna, definicion) {
  const columnas = db.prepare(`PRAGMA table_info(${tabla})`).all().map((c) => c.name);
  if (columnas.includes(columna)) return false;
  db.exec(`ALTER TABLE ${tabla} ADD COLUMN ${columna} ${definicion}`);
  console.log(`[bd] Migración: añadida la columna ${tabla}.${columna}.`);
  return true;
}

/**
 * Noches entre dos fechas YYYY-MM-DD. Del 19 al 22 son 3 noches, no 4 dias:
 * es lo que se contrata en un hotel y lo que hay que repartir entre etapas.
 */
export function nochesEntre(inicio, fin) {
  if (!inicio || !fin) return 0;
  const dia = 24 * 60 * 60 * 1000;
  // Mediodia para que ningun cambio de hora se lleve por delante un dia.
  const a = new Date(`${inicio}T12:00:00`);
  const b = new Date(`${fin}T12:00:00`);
  return Math.max(0, Math.round((b - a) / dia));
}

/**
 * Clave de busqueda de un nombre: sin acentos, en minusculas y sin espacios de
 * sobra. Es lo que hace que "Lisboa", "lisboa" y "LISBOA " sean la misma
 * ciudad en el catalogo.
 */
export function normalizarNombre(nombre) {
  return String(nombre ?? '')
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .trim()
    .replace(/\s+/g, ' ');
}

/** Migracion 5: filtros de busqueda de vuelos por viaje (JSON, como los de hotel). */
function migracionFiltrosVuelos() {
  const CLAVE = '2026-09-filtros-vuelos';
  if (yaAplicada(CLAVE)) return false;

  const columnas = db.prepare('PRAGMA table_info(viajes)').all().map((c) => c.name);
  if (!columnas.includes('filtros_vuelos')) {
    db.exec(`ALTER TABLE viajes ADD COLUMN filtros_vuelos TEXT`);
    console.log('[bd] Migración: añadida la columna filtros_vuelos.');
  }

  marcarAplicada(CLAVE);
  return true;
}

/**
 * Migracion 4: guardar los filtros de busqueda de hoteles por viaje.
 *
 * Es un JSON en una sola columna en vez de una columna por filtro, porque la
 * lista de filtros va a seguir creciendo y no quiero un ALTER TABLE cada vez.
 */
function migracionFiltrosHoteles() {
  const CLAVE = '2026-09-filtros-hoteles';
  if (yaAplicada(CLAVE)) return false;

  const columnas = db.prepare('PRAGMA table_info(viajes)').all().map((c) => c.name);
  if (!columnas.includes('filtros_hoteles')) {
    db.exec(`ALTER TABLE viajes ADD COLUMN filtros_hoteles TEXT`);
    console.log('[bd] Migración: añadida la columna filtros_hoteles.');
  }

  marcarAplicada(CLAVE);
  return true;
}

/**
 * Migracion 3: fuera los vuelos falsos del seed.
 *
 * Mismo caso que los hoteles: al conectar Kayak, todo vuelo que exista en ese
 * momento viene del seed (origen_datos 'vueling') y es inventado. Los reales
 * llegan despues con origen_datos 'kayak', asi que no los toca.
 */
function migracionQuitarVuelosFalsos() {
  const CLAVE = '2026-09-quitar-vuelos-falsos';
  if (yaAplicada(CLAVE)) return false;

  const r = db.prepare(`DELETE FROM candidatos WHERE tipo = 'vuelo' AND origen_datos <> 'kayak'`).run();

  marcarAplicada(CLAVE);
  console.log(`[bd] Migración: borrados ${r.changes} vuelos falsos del seed.`);
  return true;
}

/**
 * Migracion 2: fuera los hoteles falsos del seed.
 *
 * Los hoteles ya vienen de Booking de verdad, asi que los inventados del seed
 * solo confunden (mezclados con los reales no habria forma de distinguirlos).
 * Se borran TODOS los candidatos de hotel cuyo origen sea el seed, marcados o no:
 * un hotel falso marcado tampoco sirve de nada.
 */
function migracionQuitarHotelesFalsos() {
  const CLAVE = '2026-09-quitar-hoteles-falsos';
  if (yaAplicada(CLAVE)) return false;

  // Borramos TODOS los hoteles que haya en este momento, marcados o no.
  // Suena bruto, pero es exacto: esta migracion corre justo cuando se conecta
  // Booking, o sea que todo hotel que exista ahora mismo viene del seed y es
  // inventado. Los reales (que tambien llevaran origen_datos='booking') se
  // crean despues, asi que no los toca. Y un hotel falso marcado no sirve
  // de nada: mejor que desaparezca a que se mezcle con los de verdad.
  const r = db.prepare(`DELETE FROM candidatos WHERE tipo = 'hotel'`).run();

  marcarAplicada(CLAVE);
  console.log(`[bd] Migración: borrados ${r.changes} hoteles falsos del seed.`);
  return true;
}

/** Migracion 1: viajeros, ritmo y renumeracion del wizard a 7 pasos. */
function migracionViajeros() {
  const CLAVE = '2026-09-viajeros-y-7-pasos';
  const columnas = db.prepare('PRAGMA table_info(viajes)').all().map((c) => c.name);
  if (columnas.includes('adultos')) { marcarAplicada(CLAVE); return false; } // ya migrado

  console.log('[bd] Migrando: añado viajeros y ritmo, y renumero el wizard a 7 pasos.');

  db.exec(`
    ALTER TABLE viajes ADD COLUMN adultos      INTEGER NOT NULL DEFAULT 2;
    ALTER TABLE viajes ADD COLUMN ninos        INTEGER NOT NULL DEFAULT 0;
    ALTER TABLE viajes ADD COLUMN edades_ninos TEXT;                       -- JSON, p.ej. "[4,9]"
    ALTER TABLE viajes ADD COLUMN ritmo        TEXT NOT NULL DEFAULT 'normal';
  `);

  // Renumeracion de paso_actual. El wizard pasa de 8 a 7 pasos porque el
  // antiguo paso 4 ("Tipo de viaje") desaparece y su contenido se absorbe en la
  // nueva pantalla 1:
  //
  //   antes                        despues
  //   1 Fechas                 ->  1 Configuración
  //   2 Destino                ->  2 Destino
  //   3 Avisos                 ->  3 Avisos
  //   4 Tipo      (desaparece) ->  4 Qué ver   (el siguiente que le tocaba)
  //   5 Qué ver                ->  4 Qué ver
  //   6 Vuelos                 ->  5 Vuelos
  //   7 Hoteles                ->  6 Hotel
  //   8 Resumen                ->  7 Dosier
  //
  // O sea: los pasos 1-4 se quedan igual y del 5 en adelante restan uno.
  db.exec(`
    UPDATE viajes
       SET paso_actual = CASE
             WHEN paso_actual <= 4 THEN paso_actual
             ELSE paso_actual - 1
           END;
    UPDATE viajes SET paso_actual = 1 WHERE paso_actual < 1;
    UPDATE viajes SET paso_actual = 7 WHERE paso_actual > 7;
  `);

  marcarAplicada(CLAVE);
  console.log('[bd] Migración hecha.');
  return true;
}

/** Azucar: devuelve todas las filas de una consulta. */
export const todas = (sql, ...params) => db.prepare(sql).all(...params);

/** Azucar: devuelve la primera fila (o undefined). */
export const una = (sql, ...params) => db.prepare(sql).get(...params);

/** Azucar: ejecuta una escritura y devuelve { lastInsertRowid, changes }. */
export const ejecutar = (sql, ...params) => db.prepare(sql).run(...params);
