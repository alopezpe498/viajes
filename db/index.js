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
