/**
 * jobs/worker.js
 * -----------------------------------------------------------------------------
 * El que de verdad ejecuta los trabajos de la cola.
 *
 * Vive DENTRO del proceso de Express (no hay un servicio aparte). Cada pocos
 * segundos mira si hay algo pendiente y, si lo hay, lo ejecuta. Nunca dos a la
 * vez: los scrapers abren un Chrome con perfil persistente y dos a la vez se
 * pelearían por el mismo perfil.
 *
 * Regla de oro: un fallo de scraping JAMÁS tumba el servidor. Todo va envuelto
 * en try/catch y acaba como un trabajo en estado 'error' con un mensaje legible.
 */

import { una, todas, db, ejecutar } from '../db/index.js';
import { buscarActividades, destinoASlug, buscarFichaActividad } from '../providers/civitatis.js';
import { buscarHoteles } from '../providers/booking.js';
import { buscarVuelosKayak } from '../providers/kayak.js';
import {
  ocupacionDe,
  filtrosHotelesDe,
  resumenFiltros,
  filtrosVuelosDe,
  resumenFiltrosVuelos,
  ORIGEN_POR_DEFECTO, ciudadDeCasa } from '../services/proveedores.js';
import { resolverIata } from '../lib/iata.js';
import { reunirAvisos } from '../services/avisos.js';
import { sincronizarEtapaUnica } from '../services/etapas.js';
import { filtrosVuelosDeTramo } from '../services/etapa.js';
import { calcularDesde, referenciaDelViaje } from '../services/distancias-ciudades.js';
import {
  investigarTramo,
  investigarMovilidad,
  fichasDeTramo,
  fichasDeMovilidad,
} from '../services/movilidad.js';
import { geocodificarFila, guardarDireccion } from '../services/direcciones.js';
import { situarLugarConGoogle } from '../lib/google.js';
import { buscarDatosDeSitios, pedirDatosDeSitios, interpretarHorario } from '../services/datos-sitios.js';
import { calcularTraslado } from '../services/traslados.js';
import {
  investigarComer,
  investigarDetallesDeComer,
  consultaPendiente,
} from '../services/comer.js';
import {
  guardarActividadesEnCatalogo,
  estadoCacheCiudad,
  actividadPorId,
  guardarFichaActividad,
} from '../services/catalogo.js';
import {
  investigarDestinoConIA,
  investigarCiudadConIA,
  ponerFotosDeWikipedia,
  fichaDeWikipedia,
  guardarInvestigacion,
  guardarFichaProfunda,
} from '../services/descubrir.js';
import { modeloIA } from '../lib/ia.js';
import { sitioPorTexto } from '../services/geocodificar.js';
import {
  siguientePendiente,
  reclamar,
  marcarHecho,
  marcarError,
  recuperarInterrumpidos,
  latir,
  otroWorkerVivo,
} from './cola.js';

/** Cada cuánto mira la cola. */
const INTERVALO_MS = 4000;

/** Cuántas actividades pedimos a Civitatis por destino. */
const MAX_ACTIVIDADES = 30;

/** Cuántos hoteles pedimos a Booking por búsqueda. */
const MAX_HOTELES = 20;

/** Cuántas opciones de vuelo pedimos a Kayak por búsqueda. */
const MAX_VUELOS = 15;

/**
 * Tope de precio: se descarta lo que valga más de 4 veces la MEDIANA.
 *
 * Viene de la prueba real en París: entre resultados de 224 € a 1.965 € se
 * coló un "Pullman Paris Tour Eiffel" a 11.918 €. No era un fallo del parser
 * (lo comprobé), es que Booking a veces recomienda una suite cuando ya no
 * quedan habitaciones normales. Metido en una lista de presupuesto, ese dato
 * solo estorba: descuadra el "más barato", la media y el aviso de presupuesto.
 *
 * Se usa la MEDIANA y no la media justamente porque la media ya vendría
 * contaminada por ese mismo valor extremo.
 */
export const FACTOR_PRECIO_ABSURDO = 4;

/**
 * ¿Que hoteles se caen por precio absurdo? Separado en su propia funcion para
 * poder probarlo con datos guardados, sin depender de una busqueda en vivo.
 */
export function filtrarPreciosAbsurdos(precios) {
  const med = mediana(precios);
  const tope = med != null ? med * FACTOR_PRECIO_ABSURDO : Infinity;
  return { mediana: med, tope, fuera: precios.filter((p) => p != null && p > tope) };
}

/**
 * Palabras que descartan una tarjeta: son SERVICIOS, no cosas que ver o hacer.
 * Civitatis los cuela en el listado (eSIM, seguros de viaje, traslados al
 * aeropuerto...) y en un catálogo de "qué ver" sobran.
 *
 * AMPLIAR AQUÍ si aparecen más. Se comparan en minúsculas y sin acentos contra
 * el título, así que basta con escribirlas en minúscula y sin tildes.
 */
const PALABRAS_EXCLUIDAS = [
  'esim',
  'e-sim',
  'tarjeta sim',
  'seguro',          // "Seguro de viaje Civitatis"
  'traslado',        // cubre también "traslados"
  'wifi portatil',
  'alquiler de coche',
];

/** Quita acentos y pasa a minúsculas, para comparar títulos con tranquilidad. */
function normalizar(texto) {
  return String(texto ?? '')
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase();
}

/** ¿Es una actividad de verdad o uno de esos servicios que cuelan? */
function esActividadDeVerdad(titulo) {
  const t = normalizar(titulo);
  return !PALABRAS_EXCLUIDAS.some((palabra) => t.includes(palabra));
}

/**
 * Traduce el error del provider a algo que se entienda leyéndolo en pantalla.
 * El provider ya lanza un ErrorDestino cuando Civitatis redirige a la portada
 * (que es su forma de decir "ese destino no existe").
 */
function mensajeLegible(err, destino, tipo = 'actividades') {
  // Estos ya vienen redactados para leerse en pantalla: no los tocamos.
  if (err && err.name === 'ErrorSinIata') return err.message;
  const sinDestino =
    err?.name === 'ErrorDestino' ||
    /no existe en civitatis/i.test(err?.message ?? '') ||
    /no encontre ninguna tarjeta/i.test(err?.causa?.message ?? err?.message ?? '');

  if (sinDestino) {
    return `No encuentro «${destino}» en Civitatis; prueba con otro nombre de destino.`;
  }
  if (/no devolvió alojamientos/i.test(err?.message ?? '')) {
    return `Booking no encuentra alojamientos en «${destino}» para esas fechas. Prueba a cambiar el destino o las fechas.`;
  }
  if (/timeout/i.test(err?.message ?? '')) {
    return `Civitatis tardó demasiado en responder buscando «${destino}». Reintenta en un rato.`;
  }

  // Los de IA ya vienen escritos para leerse: el de la clave que falta, sobre
  // todo, que es el más probable la primera vez que se usa esto.
  if (tipo === 'descubrir_destino' || tipo === 'investigar_ciudad' || tipo === 'opinar_lienzo') {
    return err?.message ?? String(err);
  }

  const que =
    tipo === 'hoteles' ? 'los hoteles'
    : tipo === 'vuelos' ? 'los vuelos'
    : tipo === 'avisos' ? 'los avisos'
    : 'las actividades';
  return `No se pudieron traer ${que} de «${destino}». ${err?.message ?? err}`;
}

/**
 * Ejecuta un trabajo de tipo 'actividades':
 * scrapea Civitatis y guarda el resultado como candidatos del viaje.
 */
async function ejecutarActividades(trabajo) {
  const viaje = una('SELECT * FROM viajes WHERE id = ?', trabajo.viaje_id);
  if (!viaje) throw new Error('El viaje ya no existe.');
  if (!viaje.destino) throw new Error('El viaje no tiene destino todavía.');

  const slug = destinoASlug(viaje.destino);
  console.log(`[worker] Trabajo #${trabajo.id}: buscando actividades de "${viaje.destino}" (slug: ${slug})`);

  const actividades = await buscarActividades({
    destino: viaje.destino,
    maxResultados: MAX_ACTIVIDADES,
  });

  // Fuera los servicios que no son actividades.
  const utiles = actividades.filter((a) => esActividadDeVerdad(a.titulo));
  const descartadas = actividades.length - utiles.length;

  if (!utiles.length) {
    throw new Error(`Civitatis no devolvió ninguna actividad para «${viaje.destino}».`);
  }

  // Al pulsar "Actualizar datos" se borran las NO marcadas pero las marcadas se
  // quedan. Si no filtrásemos, el scrapeo volvería a insertarlas y verías el
  // mismo "Free tour por Lisboa" dos veces: una marcada y otra no.
  // Nos quedamos con las que ya están, por url (que es única por actividad) y,
  // como respaldo, por título para las que no tengan url.
  const yaEstan = new Set(
    todas(
      `SELECT url, titulo FROM candidatos
        WHERE viaje_id = ? AND tipo = 'actividad' AND origen_datos = 'civitatis'`,
      viaje.id
    ).map((c) => c.url || `titulo:${c.titulo}`)
  );

  const nuevas = utiles.filter((a) => !yaEstan.has(a.url || `titulo:${a.titulo}`));
  const repetidas = utiles.length - nuevas.length;

  // Guardamos en una transacción: o entran todas o no entra ninguna.
  // Lo que trae Civitatis vale para CUALQUIER viaje a esta ciudad, asi que
  // ademas de meterlo en el viaje lo dejamos en el catalogo. La proxima vez que
  // alguien vaya a Lisboa ya no hara falta volver a abrir el navegador.
  const enCatalogo = guardarActividadesEnCatalogo(viaje.destino, utiles);

  // Los candidatos de actividad cuelgan de la etapa: se visitan EN una ciudad.
  const etapa = sincronizarEtapaUnica(viaje.id);

  const insertar = db.prepare(
    `INSERT INTO candidatos
       (viaje_id, etapa_id, tipo, titulo, precio, moneda, duracion, valoracion, num_opiniones,
        url, imagen_url, origen_datos, marcado, datos_extra)
     VALUES (?, ?, 'actividad', ?, ?, ?, ?, ?, ?, ?, ?, 'civitatis', 0, ?)`
  );

  db.exec('BEGIN');
  try {
    for (const a of nuevas) {
      insertar.run(
        viaje.id,
        etapa?.id ?? null,
        a.titulo ?? '(sin título)',
        a.precio ?? null,
        a.moneda ?? null,
        a.duracion ?? null,
        a.valoracion ?? null,
        a.numOpiniones ?? null,
        a.url ?? null,
        a.imagenUrl ?? null,
        // Lo que no cabe en columnas propias se guarda tal cual por si hace falta.
        JSON.stringify({ precioTexto: a.precioTexto ?? null })
      );
    }
    db.exec('COMMIT');
  } catch (err) {
    db.exec('ROLLBACK');
    throw err;
  }

  console.log(
    `[worker] Trabajo #${trabajo.id}: guardadas ${nuevas.length} actividades` +
      (descartadas ? ` · ${descartadas} descartadas por ser servicios` : '') +
      (repetidas ? ` · ${repetidas} ya estaban (marcadas de antes)` : '') +
      (enCatalogo ? ` · ${enCatalogo} al catálogo de ${viaje.destino}` : '')
  );
}

/**
 * Error de CONFIGURACION, no de scraping: no hay codigo IATA para el destino.
 *
 * Ahora esto es raro: lo que no esta en la lista se resuelve solo y se guarda.
 * Llegar aqui significa que ni siquiera la IA supo por donde se vuela a ese
 * sitio, y entonces reintentar no arregla nada: su mensaje pasa tal cual a la
 * pantalla para que se pueda escribir el codigo a mano.
 */
class ErrorSinIata extends Error {
  constructor(mensaje) {
    super(mensaje);
    this.name = 'ErrorSinIata';
  }
}

/**
 * Mediana de una lista de números. Devuelve null si no hay nada.
 * Se exporta para poder comprobar el filtro de precios sin lanzar un scraping.
 */
export function mediana(numeros) {
  const xs = numeros.filter((n) => Number.isFinite(n)).sort((a, b) => a - b);
  if (!xs.length) return null;
  const medio = Math.floor(xs.length / 2);
  return xs.length % 2 ? xs[medio] : (xs[medio - 1] + xs[medio]) / 2;
}

/**
 * Ejecuta un trabajo de tipo 'hoteles': scrapea Booking y guarda el resultado.
 */
async function ejecutarHoteles(trabajo) {
  const viaje = una('SELECT * FROM viajes WHERE id = ?', trabajo.viaje_id);
  if (!viaje) throw new Error('El viaje ya no existe.');

  // Un trabajo de hoteles CON referencia es de una ETAPA: se busca en su ciudad
  // y con sus fechas. Sin referencia es el de siempre, del viaje entero. Así la
  // pantalla de etapa reutiliza este trabajo sin romper el paso 6 del wizard.
  const etapa = trabajo.referencia_id
    ? una('SELECT * FROM etapas WHERE id = ?', trabajo.referencia_id)
    : null;
  if (trabajo.referencia_id && !etapa) throw new Error('Esa etapa ya no existe.');

  const ciudad = etapa ? etapa.nombre_ciudad : viaje.destino;
  const entrada = etapa ? etapa.fecha_inicio : viaje.fecha_inicio;
  const salida = etapa ? etapa.fecha_fin : viaje.fecha_fin;

  if (!ciudad) throw new Error('No sé en qué ciudad buscar.');
  if (!entrada || !salida) {
    throw new Error(
      etapa
        ? `«${ciudad}» no tiene fechas: confírmala en la ruta para poder cotizar.`
        : 'El viaje no tiene fechas: vuelve al paso 1 y ponlas.'
    );
  }

  // Booking busca bien por texto: le pasamos el nombre de la ciudad tal cual,
  // sin slug ni código. Los viajeros salen de la configuración del viaje.
  const { adultos, edadesNinos } = ocupacionDe(viaje);
  const filtros = filtrosHotelesDe(viaje);
  console.log(
    `[worker] Trabajo #${trabajo.id}: buscando hoteles en "${ciudad}"` +
      (etapa ? ` (etapa #${etapa.id})` : '') +
      ` (${entrada} a ${salida}, ${adultos} adultos` +
      (edadesNinos.length ? `, niños de ${edadesNinos.join(' y ')} años` : '') +
      `) · filtros: ${resumenFiltros(filtros)}`
  );

  const hoteles = await buscarHoteles({
    destino: ciudad,
    fechaEntrada: entrada,
    fechaSalida: salida,
    adultos,
    edadesNinos,
    filtros,
    maxResultados: MAX_HOTELES,
  });

  if (!hoteles.length) {
    const conFiltros = resumenFiltros(filtros) !== 'sin filtros';
    throw new Error(
      `Booking no devolvió alojamientos para «${ciudad}» en esas fechas` +
        (conFiltros ? ' con esos filtros. Prueba a aflojarlos.' : '.')
    );
  }

  // --- Filtro de precios absurdos ---------------------------------------
  const med = mediana(hoteles.map((h) => h.precioTotal));
  const tope = med != null ? med * FACTOR_PRECIO_ABSURDO : Infinity;
  const utiles = hoteles.filter((h) => h.precioTotal == null || h.precioTotal <= tope);
  const descartados = hoteles.length - utiles.length;

  if (!utiles.length) {
    throw new Error(`Todos los hoteles de «${ciudad}» quedaron fuera del filtro de precio.`);
  }

  // --- No repetir lo que ya está (por url, como en actividades) ----------
  const yaEstan = new Set(
    todas(
      etapa
        ? `SELECT url, titulo FROM candidatos
            WHERE etapa_id = ? AND tipo = 'hotel' AND origen_datos = 'booking'`
        : `SELECT url, titulo FROM candidatos
            WHERE viaje_id = ? AND tipo = 'hotel' AND origen_datos = 'booking'`,
      etapa ? etapa.id : viaje.id
    ).map((c) => c.url || `titulo:${c.titulo}`)
  );
  const nuevos = utiles.filter((h) => !yaEstan.has(h.url || `titulo:${h.titulo}`));
  const repetidos = utiles.length - nuevos.length;

  // Un hotel se duerme EN una ciudad: cuelga de la etapa. Si el trabajo ya
  // venía con una, esa; si no, la única del viaje.
  const etapaDestino = etapa ?? sincronizarEtapaUnica(viaje.id);

  const insertar = db.prepare(
    `INSERT INTO candidatos
       (viaje_id, etapa_id, tipo, titulo, precio, moneda, duracion, valoracion, num_opiniones,
        url, imagen_url, origen_datos, marcado, datos_extra)
     VALUES (?, ?, 'hotel', ?, ?, ?, ?, ?, ?, ?, ?, 'booking', 0, ?)`
  );

  db.exec('BEGIN');
  try {
    for (const h of nuevos) {
      insertar.run(
        viaje.id,
        etapaDestino?.id ?? null,
        h.nombre ?? '(sin nombre)',
        h.precioTotal ?? null,          // precio TOTAL de la estancia, no por noche
        h.moneda ?? null,
        h.estanciaTexto ?? null,        // "3 noches, 2 adultos, 2 niños"
        h.valoracion ?? null,
        h.numOpiniones ?? null,
        h.url ?? null,
        h.imagenUrl ?? null,
        JSON.stringify({
          zona: h.zona ?? null,
          direccion: h.direccion ?? null,
          estrellas: h.estrellas ?? null,
          estrellasAutodeclaradas: h.estrellasAutodeclaradas ?? null,
          distanciaCentro: h.distanciaCentro ?? null,
          esAnuncio: h.esAnuncio ?? false,
        })
      );
    }
    db.exec('COMMIT');
  } catch (err) {
    db.exec('ROLLBACK');
    throw err;
  }

  console.log(
    `[worker] Trabajo #${trabajo.id}: guardados ${nuevos.length} hoteles` +
      (descartados ? ` · ${descartados} descartados por precio absurdo (> ${Math.round(tope)} €)` : '') +
      (repetidos ? ` · ${repetidos} ya estaban (marcados de antes)` : '')
  );
}

/**
 * Ejecuta un trabajo de tipo 'ficha_actividad': la ficha completa de UNA
 * excursion de Civitatis.
 *
 * `referencia_id` es el id de la actividad en `catalogo_actividades`.
 *
 * Es el trabajo mas barato de todos: una sola pagina, sin paginacion ni
 * recorrido. Y se pide UNO A UNO, cuando alguien pulsa "Ver detalles" de esa
 * excursion; nunca en masa. Con veintiocho excursiones por ciudad, buscarlas
 * todas seria media hora de navegador para leer tres.
 *
 * Lo que se guarda va al CATALOGO, asi que la segunda vez que alguien abra esa
 * misma excursion -en este viaje o en otro- ya no se busca nada.
 */
async function ejecutarFichaActividad(trabajo) {
  const actividad = actividadPorId(trabajo.referencia_id);
  if (!actividad) throw new Error('Esa excursión ya no está en el catálogo.');
  if (!actividad.url) {
    throw new Error(`«${actividad.titulo}» no tiene enlace a Civitatis: no hay ficha que buscar.`);
  }

  console.log(`[worker] Trabajo #${trabajo.id}: ficha de «${actividad.titulo}» (${actividad.ciudad}).`);

  const ficha = await buscarFichaActividad({ url: actividad.url });
  guardarFichaActividad(actividad.id, ficha);

  const traidos = Object.entries(ficha).filter(([, v]) => v).map(([k]) => k);
  console.log(
    `[worker] Trabajo #${trabajo.id}: ficha guardada` +
      (traidos.length ? ` (${traidos.join(', ')})` : ' vacía')
  );
}

/**
 * Ejecuta un trabajo de tipo 'preparar_etapa': deja una parada LISTA PARA
 * TRABAJAR, con sus sitios y sus excursiones.
 *
 * `referencia_id` es el id de la etapa.
 *
 * POR QUE UN SOLO TRABAJO Y NO DOS
 * Porque lo que se quiere saber es una sola cosa —"¿puedo entrar ya en Sevilla?"—
 * y con dos trabajos sueltos habria que sondear dos estados y decidir en la
 * pantalla cuando estan los dos. Aqui van encadenados y la pantalla solo mira
 * si este ha terminado.
 *
 * DE DONDE SALEN LOS SITIOS, que depende de como naciera la parada:
 *
 *  a) La etapa cuelga de un destino de nivel CIUDAD (escribiste "Sevilla" en el
 *     mapa): lo que hay que ver son los `puntos_interes` de ese destino.
 *  b) La etapa es un punto de un destino de nivel PAIS (Oporto, dentro de
 *     Portugal): lo que hay que ver es la ficha profunda de ese punto.
 *
 * SI UNA FUENTE FALLA, LA OTRA SIGUE. Que la IA no conteste no puede dejarte sin
 * las excursiones de Civitatis, ni al reves. Solo se da el trabajo por fallido
 * si fallan LAS DOS: entonces si que no hay nada que enseñar.
 */
async function ejecutarPrepararEtapa(trabajo) {
  const etapa = una('SELECT * FROM etapas WHERE id = ?', trabajo.referencia_id);
  if (!etapa) throw new Error('Esa parada ya no existe.');

  const fallos = [];

  // --- 1) Los sitios ------------------------------------------------------
  try {
    const destino = etapa.destino_id
      ? una('SELECT * FROM destinos WHERE id = ?', etapa.destino_id)
      : null;
    const punto = etapa.punto_interes_id
      ? una('SELECT * FROM puntos_interes WHERE id = ?', etapa.punto_interes_id)
      : null;

    if (destino && destino.tipo === 'ciudad' && !destino.investigado_en) {
      await investigarDestino(trabajo, destino);
    } else if (punto && !punto.investigado_en) {
      await investigarPunto(trabajo, punto);
    } else {
      console.log(
        `[worker] Trabajo #${trabajo.id}: «${etapa.nombre_ciudad}» ya tenía sus sitios. No pregunto a la IA.`
      );
    }
  } catch (err) {
    fallos.push(`sitios: ${err.message}`);
    console.warn(`[worker] Trabajo #${trabajo.id}: sin sitios de ${etapa.nombre_ciudad} (${err.message}).`);
  }

  // --- 2) Las excursiones -------------------------------------------------
  // Van al CATALOGO por nombre de ciudad, asi que si otra parada o otro viaje
  // ya las trajo, esto no abre el navegador.
  try {
    await traerExcursionesSiHacenFalta(trabajo, etapa.nombre_ciudad);
  } catch (err) {
    fallos.push(`excursiones: ${err.message}`);
    console.warn(
      `[worker] Trabajo #${trabajo.id}: sin excursiones de ${etapa.nombre_ciudad} (${err.message}).`
    );
  }

  if (fallos.length === 2) throw new Error(fallos.join(' · '));

  console.log(
    `[worker] Trabajo #${trabajo.id}: «${etapa.nombre_ciudad}» preparada` +
      (fallos.length ? ` (con un fallo — ${fallos[0]})` : '')
  );
}

/**
 * Ejecuta un trabajo de tipo 'distancias': cuánto hay de la ciudad de entrada a
 * cada candidata de un destino.
 *
 * `referencia_id` es el id del destino (el país o la región que se está
 * mirando en el mapa).
 *
 * NO ABRE NAVEGADOR. Son peticiones a Google Routes, que van de una en una
 * y tardan décimas. Por eso no compite con los scrapers por el perfil de Chrome
 * y puede correr mientras se mira el mapa.
 *
 * Un par que falla NO tumba el trabajo: se queda sin dato, la ficha enseña un
 * guión y se reintenta la próxima vez que se abra el mapa. Es exactamente lo que
 * hace `calcularDesde`.
 */
async function ejecutarDistancias(trabajo) {
  const referencia = referenciaDelViaje(trabajo.viaje_id);
  if (!referencia) {
    console.log(`[worker] Trabajo #${trabajo.id}: el viaje no tiene ciudad de referencia todavía.`);
    return;
  }

  const candidatas = todas(
    `SELECT id, nombre FROM puntos_interes
      WHERE destino_id = ? AND categoria = 'ciudad' AND lat IS NOT NULL AND lon IS NOT NULL`,
    trabajo.referencia_id
  );

  console.log(
    `[worker] Trabajo #${trabajo.id}: distancias desde «${referencia.nombre}» ` +
      `a ${candidatas.length} ciudad/es.`
  );

  const { hechas, fallidas } = await calcularDesde(referencia.ciudadId, candidatas.map((c) => c.id));

  console.log(
    `[worker] Trabajo #${trabajo.id}: ${hechas} distancia/s calculada/s` +
      (fallidas ? ` · ${fallidas} sin dato (se reintentan al volver al mapa)` : '')
  );
}

/**
 * Ejecuta un trabajo de tipo 'transporte_tramo': cómo se va de una ciudad a la
 * siguiente. `referencia_id` es el id del tramo.
 *
 * PREGUNTA CON BÚSQUEDA WEB. Los horarios y los precios de un autobús cambian, y
 * un modelo sin buscar te los da igual de convencido. Vale más un campo vacío
 * que un dato falso con el que alguien pierda el bus.
 *
 * Lo que salga va al CATÁLOGO, por pareja de ciudades: el próximo viaje que
 * pase por Sarajevo → Mostar ya lo tiene.
 */
async function ejecutarTransporteTramo(trabajo) {
  const tramo = una('SELECT * FROM transportes WHERE id = ?', trabajo.referencia_id);
  if (!tramo) throw new Error('Ese tramo ya no existe.');

  const origen = tramo.etapa_origen_id
    ? una('SELECT nombre_ciudad FROM etapas WHERE id = ?', tramo.etapa_origen_id)
    : null;
  const destino = tramo.etapa_destino_id
    ? una('SELECT nombre_ciudad FROM etapas WHERE id = ?', tramo.etapa_destino_id)
    : null;

  if (!origen || !destino) {
    throw new Error('Este tramo va a casa o viene de casa: eso se resuelve con el buscador de vuelos.');
  }

  const a = origen.nombre_ciudad;
  const b = destino.nombre_ciudad;

  // Si el catálogo ya lo sabe, no se pregunta: es conocimiento sobre el mundo.
  const yaHay = fichasDeTramo(a, b);
  if (yaHay.length) {
    console.log(`[worker] Trabajo #${trabajo.id}: ${a} → ${b} ya tenía ${yaHay.length} medio/s. No pregunto.`);
    return;
  }

  console.log(`[worker] Trabajo #${trabajo.id}: buscando cómo ir de ${a} a ${b} (IA + web).`);
  const fichas = await investigarTramo(a, b);

  console.log(
    `[worker] Trabajo #${trabajo.id}: ${fichas.length} medio/s guardado/s` +
      (fichas.length ? ` (${fichas.map((f) => f.medio).join(', ')})` : ' — ninguno; se podrá crear a mano')
  );
}

/**
 * Ejecuta un trabajo de tipo 'movilidad_ciudad': cómo moverse por una ciudad.
 * `referencia_id` es el id de la etapa, pero lo que se guarda va por CIUDAD.
 *
 * El dato más útil de todos es el teléfono de un taxi, y es justo el que hay que
 * pedir con búsqueda: inventado no sirve para nada y encima es peligroso.
 */
async function ejecutarMovilidadCiudad(trabajo) {
  const etapa = una('SELECT * FROM etapas WHERE id = ?', trabajo.referencia_id);
  if (!etapa) throw new Error('Esa parada ya no existe.');

  const yaHay = fichasDeMovilidad(etapa.nombre_ciudad);
  if (yaHay.length) {
    console.log(
      `[worker] Trabajo #${trabajo.id}: ${etapa.nombre_ciudad} ya tenía ${yaHay.length} opción/es de movilidad.`
    );
    return;
  }

  console.log(`[worker] Trabajo #${trabajo.id}: buscando cómo moverse por ${etapa.nombre_ciudad} (IA + web).`);
  const fichas = await investigarMovilidad(etapa.nombre_ciudad);

  console.log(
    `[worker] Trabajo #${trabajo.id}: ${fichas.length} opción/es guardada/s` +
      (fichas.filter((f) => f.telefono).length
        ? ` · ${fichas.filter((f) => f.telefono).length} con teléfono`
        : '')
  );
}

/**
 * Buscar las coordenadas de una dirección.
 *
 * Va por la cola y no en la petición que la guarda porque geocodificar es lento
 * —hay que preguntarle a Google— y guardar una dirección
 * tiene que ser instantáneo: se escribe, se guarda y la ficha dice "situando…".
 *
 * La ciudad de la parada se pasa como contexto: "Calle Mayor 3" a secas puede
 * estar en media España, y con la ciudad detrás no.
 */
async function ejecutarGeocodificar(trabajo) {
  const fila = una('SELECT * FROM direcciones WHERE id = ?', trabajo.referencia_id);
  if (!fila) throw new Error('Esa dirección ya no existe.');

  // De qué ciudad es. Se saca de la parada que la usa, que es lo único que
  // convierte una calle suelta en una dirección buscable.
  const cerca = ciudadDeLaDireccion(fila);

  console.log(
    `[worker] Trabajo #${trabajo.id}: situando «${fila.direccion}»` +
      (cerca ? ` (en ${cerca})` : '')
  );
  const r = await geocodificarFila(fila.id, { cerca });

  console.log(
    `[worker] Trabajo #${trabajo.id}: ` +
      (r?.situada ? `situada con ${r.fuente}.` : 'no se ha encontrado.')
  );
}

/**
 * De qué ciudad es una dirección.
 *
 * Cada tipo vive en una tabla distinta y llega a la ciudad por un camino
 * distinto. Si no se averigua no pasa nada: se busca sin contexto, que es lo que
 * se hacía antes de tener esto.
 */
function ciudadDeLaDireccion(fila) {
  const { tipo_elemento: tipo, elemento_id: id } = fila;

  if (tipo === 'hotel') {
    return una(
      `SELECT e.nombre_ciudad AS c FROM candidatos k
         JOIN etapas e ON e.id = k.etapa_id WHERE k.id = ?`,
      id
    )?.c ?? null;
  }
  if (tipo === 'movilidad') {
    return una('SELECT ciudad AS c FROM catalogo_movilidad WHERE id = ?', id)?.c ?? null;
  }
  if (tipo === 'comer') {
    return una('SELECT ciudad AS c FROM catalogo_comer WHERE id = ?', id)?.c ?? null;
  }
  if (tipo === 'actividad') {
    return una('SELECT ciudad AS c FROM catalogo_actividades WHERE id = ?', id)?.c ?? null;
  }
  if (tipo === 'punto') {
    return una('SELECT ciudad_base AS c FROM puntos_interes WHERE id = ?', id)?.c ?? null;
  }
  if (tipo === 'sitio') {
    return una(
      `SELECT p.ciudad_base AS c FROM sitios_lugar s
         JOIN puntos_interes p ON p.id = s.punto_interes_id WHERE s.id = ?`,
      id
    )?.c ?? null;
  }
  return null;
}

/**
 * Calcular un traslado: cuánto hay de un sitio a otro.
 *
 * Google y solo Google: es el único que sabe de transporte público.
 * Nunca lanza por un fallo de la fuente: el traslado se queda con su mensaje y
 * un botón de recalcular, que es más útil que un trabajo en rojo.
 */
async function ejecutarTraslado(trabajo) {
  const fila = una('SELECT * FROM traslados WHERE id = ?', trabajo.referencia_id);
  if (!fila) throw new Error('Ese traslado ya no existe.');

  console.log(
    `[worker] Trabajo #${trabajo.id}: calculando ${fila.origen_texto} → ${fila.destino_texto}.`
  );
  const r = await calcularTraslado(fila.id);

  console.log(
    `[worker] Trabajo #${trabajo.id}: ` +
      (r?.resultados?.length
        ? `${r.resultados.length} medio/s (fuente: ${r.fuente}).`
        : 'sin resultado.')
  );
}

/**
 * Buscar dónde comer en la ciudad de una parada.
 *
 * Places primero (que es quien tiene notas y opiniones de verdad) y la IA con
 * búsqueda web detrás. Lo que vuelve se guarda en el CATÁLOGO por ciudad, así
 * que la próxima vez que alguien pase por aquí ya está.
 */
async function ejecutarComerBuscar(trabajo) {
  const etapa = una('SELECT * FROM etapas WHERE id = ?', trabajo.referencia_id);
  if (!etapa) throw new Error('Esa parada ya no existe.');

  // Lo que se tecleó en el buscador. Si no hay nada, la búsqueda rápida.
  const consulta = consultaPendiente(etapa.id);

  console.log(
    `[worker] Trabajo #${trabajo.id}: buscando dónde comer en ${etapa.nombre_ciudad}` +
      (consulta ? ` («${consulta}»).` : ' (los mejores).')
  );
  const r = await investigarComer(etapa.nombre_ciudad, consulta);

  console.log(
    `[worker] Trabajo #${trabajo.id}: ${r.sitios.length} sitio/s (fuente: ${r.fuente}).`
  );
}

/**
 * Los detalles de UN sitio: teléfono, web y horarios.
 *
 * Solo bajo demanda, al abrir su ficha, y una sola vez. Es la parte cara de
 * Places: de veinte resultados se abren dos, y pedirlos todos al buscar sería
 * pagar diez veces por lo que nadie va a leer.
 */
async function ejecutarComerDetalles(trabajo) {
  const f = una('SELECT * FROM catalogo_comer WHERE id = ?', trabajo.referencia_id);
  if (!f) throw new Error('Ese sitio ya no está en el catálogo.');

  console.log(`[worker] Trabajo #${trabajo.id}: datos de «${f.nombre}».`);
  const ficha = await investigarDetallesDeComer(f.id);

  console.log(
    `[worker] Trabajo #${trabajo.id}: ` +
      (ficha?.telefono || ficha?.web || ficha?.horarios ? 'datos guardados.' : 'sin datos.')
  );
}

/** Los tipos de trabajo que ESTE worker sabe ejecutar. */
const TIPOS_CONOCIDOS = [
  'actividades', 'hoteles', 'vuelos', 'avisos',
  'descubrir_destino', 'investigar_ciudad', 'opinar_lienzo',
  'ficha_actividad', 'preparar_etapa', 'distancias',
  'transporte_tramo', 'movilidad_ciudad',
  'geocodificar', 'traslado',
  'comer_buscar', 'comer_detalles',
  'datos_sitios', 'horario_cierre',
];

/**
 * Construye el titulo que se ve en la lista y en el panel de seleccion.
 * Ej: "Volotea + Vueling · directos"  ·  "Ryanair · 1 escala"
 */
function tituloDeOpcion(opcion) {
  // Kayak da las aerolineas como un string tipo "Volotea, Vueling".
  const aerolineas = [
    ...new Set(
      String(opcion.aerolinea ?? '')
        .split(/\s*,\s*/)
        .map((a) => a.trim())
        .filter(Boolean)
    ),
  ];
  const nombres = aerolineas.length ? aerolineas.join(' + ') : 'Aerolínea sin identificar';

  const escalas = (opcion.tramos ?? []).map((t) => t.escalas).filter((e) => e != null);
  let comoVa = '';
  if (escalas.length && escalas.every((e) => e === 0)) {
    comoVa = escalas.length > 1 ? 'directos' : 'directo';
  } else if (escalas.length) {
    const total = escalas.reduce((a, b) => a + b, 0);
    comoVa = `${total} ${total === 1 ? 'escala' : 'escalas'}`;
  }

  return comoVa ? `${nombres} · ${comoVa}` : nombres;
}

/** "1h 40m" -> 100 minutos. Para poder ordenar por duración total. */
function aMinutos(duracion) {
  if (!duracion) return null;
  const h = /(\d+)\s*h/.exec(duracion);
  const m = /(\d+)\s*m/.exec(duracion);
  const total = (h ? Number(h[1]) * 60 : 0) + (m ? Number(m[1]) : 0);
  return total || null;
}

/** 215 -> "3h 35m" */
function comoDuracion(minutos) {
  if (!minutos) return null;
  return `${Math.floor(minutos / 60)}h ${String(minutos % 60).padStart(2, '0')}m`;
}

/**
 * Ejecuta un trabajo de tipo 'vuelos': busca en Kayak y guarda cada OPCION.
 *
 * MODELO COMBINADO: Kayak no vende ida y vuelta por separado, vende paquetes
 * con un unico precio (y a veces con aerolinea distinta en cada tramo). Por eso
 * cada opcion se guarda como UN candidato, con el detalle de los dos tramos
 * dentro de datos_extra. Marcar "un vuelo" = elegir el paquete entero.
 */
async function ejecutarVuelos(trabajo) {
  const viaje = una('SELECT * FROM viajes WHERE id = ?', trabajo.viaje_id);
  if (!viaje) throw new Error('El viaje ya no existe.');

  // Con referencia, el trabajo es de un TRAMO concreto de la ruta (casa→primera
  // parada, o última→casa): se busca entre sus dos puntas y con sus fechas. Sin
  // referencia es el de siempre, del viaje entero.
  const tramo = trabajo.referencia_id
    ? una('SELECT * FROM transportes WHERE id = ?', trabajo.referencia_id)
    : null;
  if (trabajo.referencia_id && !tramo) throw new Error('Ese tramo ya no existe.');

  const etapaOrigen = tramo?.etapa_origen_id
    ? una('SELECT * FROM etapas WHERE id = ?', tramo.etapa_origen_id)
    : null;
  const etapaDestino = tramo?.etapa_destino_id
    ? una('SELECT * FROM etapas WHERE id = ?', tramo.etapa_destino_id)
    : null;

  // De casa se sale y a casa se vuelve: el nulo de cada punta es ORIGEN_POR_DEFECTO.
  const ciudadOrigen = tramo ? (etapaOrigen?.nombre_ciudad ?? null) : null;
  const ciudadDestino = tramo ? (etapaDestino?.nombre_ciudad ?? null) : viaje.destino;

  if (!tramo && !viaje.destino) throw new Error('El viaje no tiene destino todavía.');

  // LAS FECHAS, Y AQUI ESTA LA DIFERENCIA GORDA.
  //
  // Un TRAMO se busca SOLO IDA, con SU fecha. BCN→Madrid del 11 y Madrid→BCN
  // del 13 son dos busquedas distintas, cada una con sus horarios y sus
  // filtros. Antes se buscaba la ventana entera del viaje como un ida y vuelta
  // y se colgaba del tramo de ida: eso mezclaba los dos sentidos en una sola
  // tarjeta y hacia imposible querer una cosa a la ida y otra a la vuelta.
  //
  // De paso desaparece la aproximacion que habia documentada aqui: entrar por
  // una ciudad y salir por otra ya no obliga a fingir un ida y vuelta a la
  // misma, porque cada punta se busca por separado y con sus dos puntas reales.
  //
  // Sin tramo (la busqueda del viaje entero, la del paso 5) sigue siendo un ida
  // y vuelta con las fechas del viaje, como siempre.
  const fechaIda = tramo
    ? (etapaOrigen?.fecha_fin ?? etapaDestino?.fecha_inicio)
    : viaje.fecha_inicio;
  const fechaVuelta = tramo ? null : viaje.fecha_fin;

  if (!fechaIda) {
    throw new Error(
      tramo
        ? 'Ese tramo no tiene fecha: confirma las etapas en la ruta y dales sus noches.'
        : 'El viaje no tiene fechas: vuelve al paso 1 y ponlas.'
    );
  }

  // Kayak necesita códigos IATA, no nombres de ciudad.
  // DE CASA SE SALE Y A CASA SE VUELVE, y "casa" ya no es una constante: es lo
  // que diga el viaje. El nulo de cada punta es la ciudad de origen.
  const casa = ciudadDeCasa(viaje);
  const nombreOrigen = ciudadOrigen ?? casa;
  const nombreDestino = ciudadDestino ?? casa;

  // Se resuelven de la caché, de la lista de siempre o preguntándolo, por ese
  // orden. Lo que se aprende queda guardado: cada ciudad se pregunta una vez.
  // La ciudad de casa pasa por el mismo resolutor que las demás: si alguien
  // pone "Cádiz" como origen, tiene que salir XRY igual que en el destino.
  const origenIata = await resolverIata(nombreOrigen);
  const destinoIata = await resolverIata(nombreDestino);

  if (!origenIata) {
    throw new ErrorSinIata(
      `No he podido averiguar por qué aeropuerto se vuela a «${nombreOrigen}». ` +
        'Si tiene uno, escríbelo tú en el campo del origen con su código de tres letras.'
    );
  }
  if (!destinoIata) {
    throw new ErrorSinIata(
      `No he podido averiguar por qué aeropuerto se vuela a «${nombreDestino}». ` +
        'Si tiene uno, escríbelo tú en el campo del destino con su código de tres letras.'
    );
  }
  if (destinoIata === origenIata) {
    throw new ErrorSinIata(
      `«${nombreDestino}» es el mismo sitio del que sales (${origenIata}): no hay vuelo que buscar.`
    );
  }

  const { adultos, edadesNinos } = ocupacionDe(viaje);
  // Cada tramo tiene los suyos; mientras no los tenga, hereda los del viaje.
  const filtros = tramo ? filtrosVuelosDeTramo(tramo) : filtrosVuelosDe(viaje);
  console.log(
    `[worker] Trabajo #${trabajo.id}: buscando vuelos ${origenIata}→${destinoIata}` +
      (tramo ? ` (tramo #${tramo.id}, solo ida)` : '') +
      ` (${fechaIda}${fechaVuelta ? ` a ${fechaVuelta}` : ''}, ${adultos} adultos` +
      (edadesNinos.length ? `, niños de ${edadesNinos.join(' y ')} años` : '') +
      `) · filtros: ${resumenFiltrosVuelos(filtros)}`
  );

  const opciones = await buscarVuelosKayak({
    origen: origenIata,
    destino: destinoIata,
    fechaIda,
    fechaVuelta,
    adultos,
    edadesNinos,
    filtros,
    maxResultados: MAX_VUELOS,
  });

  if (!opciones.length) {
    throw new Error(
      `Kayak no devolvió vuelos para ${origenIata}→${destinoIata} el ${fechaIda}.`
    );
  }

  // No repetimos lo que ya está. La huella son los horarios de los dos tramos:
  // misma aerolínea + mismos horarios = la misma opción.
  const yaEstan = new Set(
    todas(
      tramo
        ? `SELECT titulo, datos_extra FROM candidatos
            WHERE transporte_id = ? AND tipo = 'vuelo' AND origen_datos = 'kayak'`
        : `SELECT titulo, datos_extra FROM candidatos
            WHERE viaje_id = ? AND tipo = 'vuelo' AND origen_datos = 'kayak'`,
      tramo ? tramo.id : viaje.id
    ).map((c) => `${c.titulo}|${JSON.parse(c.datos_extra || '{}').huella ?? ''}`)
  );

  // AMBITO: DE QUIEN SON ESTOS VUELOS.
  //
  // Un vuelo no esta en ninguna ciudad: une dos sitios. Por eso cuelga del
  // transporte y no de la etapa.
  //
  //  - Con tramo: son de ESE tramo, y ahi van.
  //  - Sin tramo (la busqueda del viaje entero, la del paso 5): son del VIAJE, y
  //    se quedan con `transporte_id` a NULL.
  //
  // Antes los del viaje se colgaban de la pata de ida, y eso los mezclaba con
  // los del tramo de ida: el paso 5 acababa listando los de la ida y los de la
  // vuelta del tramo como si fueran opciones del viaje. Y ademas `refrescarVuelos`
  // ya borraba por `transporte_id IS NULL`, o sea que los daba por del viaje
  // mientras que el worker los guardaba como del tramo: los dos sitios no
  // estaban diciendo lo mismo. Ahora si.
  //
  // La etapa unica se sigue sincronizando: eso crea la ruta minima del viaje y
  // no depende de donde se guarden los vuelos.
  if (!tramo) sincronizarEtapaUnica(viaje.id);
  const ida = tramo;

  const insertar = db.prepare(
    `INSERT INTO candidatos
       (viaje_id, transporte_id, tipo, titulo, precio, moneda, duracion, valoracion, num_opiniones,
        url, imagen_url, origen_datos, marcado, datos_extra)
     VALUES (?, ?, 'vuelo', ?, ?, ?, ?, NULL, NULL, NULL, NULL, 'kayak', 0, ?)`
  );

  let guardados = 0;
  let repetidos = 0;

  db.exec('BEGIN');
  try {
    for (const o of opciones) {
      const titulo = tituloDeOpcion(o);
      const huella = (o.tramos ?? []).map((t) => `${t.horaSalida}-${t.horaLlegada}`).join('/');
      if (yaEstan.has(`${titulo}|${huella}`)) {
        repetidos++;
        continue;
      }

      const minutosTotales =
        (o.tramos ?? []).reduce((suma, t) => suma + (aMinutos(t.duracion) ?? 0), 0) || null;

      // Con una busqueda de solo ida cada opcion trae UN trayecto, y ese es la
      // ida. Con ida y vuelta, el primero es la ida y el segundo la vuelta.
      const etiquetaTramo = (i) => (tramo || i === 0 ? 'ida' : 'vuelta');

      insertar.run(
        viaje.id,
        ida?.id ?? null,
        titulo,
        o.precio ?? null, // precio del PAQUETE (ida + vuelta), no por tramo
        o.moneda ?? null,
        comoDuracion(minutosTotales),
        JSON.stringify({
          huella,
          origen: origenIata,
          destino: destinoIata,
          aerolineas: o.aerolinea ?? null,
          clase: o.clase ?? null,
          precioPorPersona: o.precioPorPersona ?? null,
          minutosTotales,
          // Detalle completo de cada tramo, tal cual lo da el provider.
          tramos: (o.tramos ?? []).map((t, i) => ({
            tramo: etiquetaTramo(i),
            horaSalida: t.horaSalida ?? null,
            horaLlegada: t.horaLlegada ?? null,
            diasDespues: t.diasDespues ?? 0,
            duracion: t.duracion ?? null,
            escalas: t.escalas ?? null,
            escalaTexto: t.escalaTexto ?? null,
            aeropuertoOrigen: t.aeropuertoOrigen ?? null,
            aeropuertoDestino: t.aeropuertoDestino ?? null,
          })),
        })
      );
      guardados++;
    }
    db.exec('COMMIT');
  } catch (err) {
    db.exec('ROLLBACK');
    throw err;
  }

  console.log(
    `[worker] Trabajo #${trabajo.id}: guardadas ${guardados} opciones de vuelo` +
      (repetidos ? ` · ${repetidos} ya estaban (marcadas de antes)` : '')
  );
}

/**
 * Ejecuta un trabajo de tipo 'avisos'.
 *
 * Este NO abre navegador: las tres fuentes (Open-Meteo, Exteriores y
 * Nager.Date) responden a un fetch normal. Por eso tarda segundos y no compite
 * con los scrapers por el perfil de Chrome.
 */
async function ejecutarAvisos(trabajo) {
  const viaje = una('SELECT * FROM viajes WHERE id = ?', trabajo.viaje_id);
  if (!viaje) throw new Error('El viaje ya no existe.');
  if (!viaje.destino) throw new Error('El viaje no tiene destino todavía.');
  if (!viaje.fecha_inicio || !viaje.fecha_fin) {
    throw new Error('El viaje no tiene fechas: vuelve al paso 1 y ponlas.');
  }

  console.log(`[worker] Trabajo #${trabajo.id}: buscando avisos de "${viaje.destino}"`);

  const { sitio, avisos } = await reunirAvisos({
    destino: viaje.destino,
    fechaInicio: viaje.fecha_inicio,
    fechaFin: viaje.fecha_fin,
  });

  const insertar = db.prepare(
    `INSERT INTO avisos (viaje_id, categoria, severidad, titulo, texto, url)
     VALUES (?, ?, ?, ?, ?, ?)`
  );

  db.exec('BEGIN');
  try {
    // Los de este viaje se rehacen enteros: son una foto, no una selección.
    db.prepare('DELETE FROM avisos WHERE viaje_id = ?').run(viaje.id);
    for (const a of avisos) {
      insertar.run(viaje.id, a.categoria, a.severidad, a.titulo, a.texto ?? null, a.url ?? null);
    }
    db.exec('COMMIT');
  } catch (err) {
    db.exec('ROLLBACK');
    throw err;
  }

  const porCategoria = avisos.reduce((cuenta, a) => {
    cuenta[a.categoria] = (cuenta[a.categoria] ?? 0) + 1;
    return cuenta;
  }, {});
  console.log(
    `[worker] Trabajo #${trabajo.id}: ${avisos.length} avisos de ${sitio.nombre}, ${sitio.pais ?? sitio.codigoPais} ` +
      `(${Object.entries(porCategoria).map(([k, v]) => `${k}: ${v}`).join(', ')})`
  );
}

/**
 * Ejecuta un trabajo de tipo 'descubrir_destino'.
 *
 * Tampoco abre navegador. Son dos llamadas de red muy distintas seguidas:
 * primero la IA dice QUÉ hay que ver, y luego Wikipedia pone la cara a cada
 * cosa. La segunda parte no puede tumbar la primera: si Wikipedia no contesta,
 * los puntos se guardan igual y las tarjetas salen con el placeholder.
 *
 * `trabajo.referencia_id` es el id del destino del catálogo.
 */
async function ejecutarDescubrirDestino(trabajo) {
  const destino = una('SELECT * FROM destinos WHERE id = ?', trabajo.referencia_id);
  if (!destino) throw new Error('Ese destino ya no está en el catálogo.');
  await investigarDestino(trabajo, destino);
}

/**
 * Lo que hay que ver en un destino del catálogo. Separado de su trabajo porque
 * lo llaman dos: el de siempre y el que prepara una etapa entera.
 */
async function investigarDestino(trabajo, destino) {
  // El NIVEL del destino decide qué se le pide a la IA: de un país se piden
  // ciudades donde dormir, de una ciudad se piden sitios de dentro. Normalmente
  // viene del mapamundi; si es un destino viejo sin nivel, se lo preguntamos a
  // Nominatim antes de investigar en vez de adivinarlo.
  let tipo = destino.tipo;
  if (!tipo) {
    const sitio = await sitioPorTexto(destino.nombre).catch(() => null);
    tipo = sitio?.tipo ?? 'pais';
    ejecutar('UPDATE destinos SET tipo = ? WHERE id = ?', tipo, destino.id);
    console.log(`[worker] Trabajo #${trabajo.id}: «${destino.nombre}» no tenía nivel; Google dice "${tipo}".`);
  }

  console.log(
    `[worker] Trabajo #${trabajo.id}: investigando "${destino.nombre}" (${tipo}) con la IA (${modeloIA()})`
  );

  const investigacion = await investigarDestinoConIA(destino.nombre, tipo);
  console.log(
    `[worker] Trabajo #${trabajo.id}: la IA propone ${investigacion.puntos.length} sitios. ` +
      'Ahora busco fotos en Wikipedia.'
  );

  const conFoto = await ponerFotosDeWikipedia(investigacion.puntos);

  const guardados = guardarInvestigacion(destino.id, investigacion);

  console.log(
    `[worker] Trabajo #${trabajo.id}: ${guardados} sitios de ${destino.nombre} guardados ` +
      `(${conFoto} con foto de Wikipedia, ${guardados - conFoto} sin ella).`
  );
}

/**
 * Ejecuta un trabajo de tipo 'investigar_ciudad': la ficha profunda.
 *
 * Cuatro pasos, y el orden importa:
 *
 *   1. La IA cuenta qué hay DENTRO (6-10 sitios) y por qué merece la pena.
 *   2. Wikipedia le pone foto y enlace a cada uno.
 *   3. Se guarda. Ya hay ficha aunque lo siguiente falle.
 *   4. Solo si es una CIUDAD: las excursiones de Civitatis, y solo si no las
 *      teníamos ya cacheadas de otro viaje.
 *
 * El 4 va el último y en su propio try/catch a posta: es el que abre el
 * navegador y el que más veces va a fallar. Si Civitatis se pone tonto, la
 * ficha ya está guardada y la pantalla se ve entera menos la pestaña de
 * excursiones. Al revés sería absurdo: perder la ficha por unos free tours.
 */
async function ejecutarInvestigarCiudad(trabajo) {
  const punto = una('SELECT * FROM puntos_interes WHERE id = ?', trabajo.referencia_id);
  if (!punto) throw new Error('Ese sitio ya no está en el catálogo.');
  await investigarPunto(trabajo, punto);
}

/**
 * La ficha profunda de un punto del catálogo. Igual que arriba: separada de su
 * trabajo para que la pueda usar también el que prepara una etapa.
 */
async function investigarPunto(trabajo, punto) {
  const destino = una('SELECT * FROM destinos WHERE id = ?', punto.destino_id);
  const nombreDestino = destino?.nombre ?? punto.ciudad_base ?? punto.nombre;

  console.log(
    `[worker] Trabajo #${trabajo.id}: ficha profunda de "${punto.nombre}" (${punto.categoria}) con la IA`
  );

  // --- 1) Qué hay dentro -----------------------------------------------
  const ficha = await investigarCiudadConIA(punto, nombreDestino);
  console.log(`[worker] Trabajo #${trabajo.id}: la IA propone ${ficha.sitios.length} lugares. Busco fotos.`);

  // --- 2) Foto y enlace de cada uno ------------------------------------
  const conFoto = await ponerFotosDeWikipedia(ficha.sitios);

  // De paso, si el propio punto se quedó sin enlace en la investigación del
  // destino, lo reintentamos con su nombre a secas.
  if (!punto.wikipedia_url) {
    const suya = await fichaDeWikipedia(punto.nombre);
    if (suya?.wikipediaUrl) {
      ejecutar(
        'UPDATE puntos_interes SET wikipedia_url = ?, imagen_url = COALESCE(imagen_url, ?) WHERE id = ?',
        suya.wikipediaUrl,
        suya.imagenUrl,
        punto.id
      );
    }
  }

  // --- 3) Guardar -------------------------------------------------------
  const guardados = guardarFichaProfunda(punto, ficha);
  console.log(
    `[worker] Trabajo #${trabajo.id}: ${guardados} lugares de ${punto.nombre} (${conFoto} con foto).`
  );

  // --- 3b) Y SITUARLOS. Dirección y coordenada de cada uno, con Places ----
  //
  // Hasta ahora los sitios se guardaban con lo que dijera la IA y punto: sin
  // dirección y con coordenadas aproximadas. En "Comer" sí llegaban, porque
  // esas fichas nacen de Places; en Sitios y Excursiones no llegaba ninguna, y
  // sin dirección no hay traslado que calcular ni marcador que pintar.
  //
  // Va después de guardar y no antes a propósito: si Places falla, la ficha ya
  // está hecha y lo único que falta son las direcciones.
  await situarLosSitios(trabajo, punto);

  // --- 3c) Y los datos duros, en su propio trabajo -------------------------
  //
  // Precio, horarios, duración, web y teléfono salen de UNA búsqueda en Google
  // con navegador. Va aparte porque abre una ventana y puede tardar o toparse
  // con un captcha, y la ficha no tiene por qué esperar a eso: se pinta con lo
  // que hay y se completa cuando llegue.
  pedirDatosDeSitios(trabajo.viaje_id, punto.id);

  // --- 4) Excursiones, solo para ciudades -------------------------------
  let excursiones = null;
  if (punto.categoria === 'ciudad') {
    try {
      excursiones = await traerExcursionesSiHacenFalta(trabajo, punto.nombre);
    } catch (err) {
      // Ni una palabra más alta que otra: la ficha ya está hecha.
      console.warn(
        `[worker] Trabajo #${trabajo.id}: sin excursiones de ${punto.nombre} (${err.message}). La ficha se guarda igual.`
      );
    }
  }

  ejecutar("UPDATE puntos_interes SET investigado_en = datetime('now') WHERE id = ?", punto.id);

  console.log(
    `[worker] Trabajo #${trabajo.id}: ficha de ${punto.nombre} lista` +
      (excursiones == null ? '' : ` · ${excursiones} excursiones en el catálogo`)
  );
}

/**
 * SITÚA CON PLACES LOS SITIOS DE UNA CIUDAD RECIÉN INVESTIGADA.
 *
 * Una llamada a Places por sitio, y solo por los que no tengan ya dirección:
 * reinvestigar una ciudad no vuelve a pagar por lo que ya se sabía.
 *
 * Lo que se guarda es doble y las dos cosas hacen falta:
 *   · La DIRECCIÓN, en la tabla `direcciones`, que es de donde tira el buscador
 *     de traslados y el mapa de la parada.
 *   · Las COORDENADAS, en la propia fila del sitio, porque las de la IA son
 *     aproximadas y las de Places son las buenas.
 *
 * Si Google no contesta no pasa nada grave: el sitio se queda sin dirección y
 * se puede escribir a mano. Lo que no se hace es dejarlo a medias en silencio.
 */
async function situarLosSitios(trabajo, punto) {
  const sitios = todas(
    `SELECT s.id, s.nombre, s.lat, s.lon
       FROM sitios_lugar s
      WHERE s.punto_interes_id = ?
        AND NOT EXISTS (
          SELECT 1 FROM direcciones d
           WHERE d.tipo_elemento = 'sitio' AND d.elemento_id = s.id
        )
      ORDER BY s.orden, s.id`,
    punto.id
  );
  if (!sitios.length) return;

  const ciudad = punto.ciudad_base || punto.nombre;
  let situados = 0;

  for (const s of sitios) {
    const enPlaces = await situarLugarConGoogle(s.nombre, ciudad);
    if (!enPlaces?.direccion) continue;

    guardarDireccion('sitio', s.id, enPlaces.direccion);

    // La dirección ya viene con su punto: se marca situada sin pasar por la
    // cola de geocodificación, que sería preguntar dos veces lo mismo.
    if (enPlaces.lat != null && enPlaces.lng != null) {
      ejecutar(
        `UPDATE direcciones
            SET lat = ?, lng = ?, estado = 'ok', fuente = 'places',
                buscada_en = datetime('now'), actualizado_en = datetime('now')
          WHERE tipo_elemento = 'sitio' AND elemento_id = ?`,
        enPlaces.lat,
        enPlaces.lng,
        s.id
      );
      ejecutar('UPDATE sitios_lugar SET lat = ?, lon = ? WHERE id = ?', enPlaces.lat, enPlaces.lng, s.id);
    }
    situados += 1;
  }

  console.log(
    `[worker] Trabajo #${trabajo.id}: ${situados} de ${sitios.length} sitios situados con Places.`
  );
}

/**
 * LOS DATOS DUROS DE LOS SITIOS DE UNA CIUDAD.
 *
 * Abre un navegador de verdad y hace UNA búsqueda con todos los sitios de la
 * ciudad. Va por la cola y no dentro de la investigación a propósito: tarda sus
 * segundos, puede saltar un captcha y no puede retrasar la lista de sitios, que
 * es lo que la pantalla está esperando para pintar algo.
 *
 * Si falla, falla este trabajo y solo este: la ficha ya está hecha y lo único
 * que se queda sin rellenar son los huecos de precio y horario, que la pantalla
 * pinta con un guion.
 */
async function ejecutarDatosDeSitios(trabajo) {
  const punto = una('SELECT * FROM puntos_interes WHERE id = ?', trabajo.referencia_id);
  if (!punto) throw new Error('Ese sitio ya no está en el catálogo.');

  console.log(
    `[worker] Trabajo #${trabajo.id}: datos duros de los sitios de ${punto.nombre} (Google).`
  );
  const r = await buscarDatosDeSitios(punto);
  console.log(`[worker] Trabajo #${trabajo.id}: ${r.mensaje}`);
}

/**
 * Las excursiones de una ciudad, del catálogo o de Civitatis.
 *
 * Aquí es donde se nota que la caché de actividades dejó de colgar del viaje y
 * pasó a colgar de la ciudad: si alguien ya miró Kioto en otro viaje, esto no
 * abre el navegador. Solo se scrapea la primera vez.
 */
async function traerExcursionesSiHacenFalta(trabajo, ciudad) {
  const cache = estadoCacheCiudad(ciudad);
  if (cache.total > 0) {
    console.log(
      `[worker] Trabajo #${trabajo.id}: ${ciudad} ya tenía ${cache.total} excursiones cacheadas (${cache.vistoEn}). No abro el navegador.`
    );
    return cache.total;
  }

  console.log(`[worker] Trabajo #${trabajo.id}: buscando excursiones de "${ciudad}" en Civitatis`);
  const actividades = await buscarActividades({ destino: ciudad, maxResultados: MAX_ACTIVIDADES });
  const utiles = actividades.filter((a) => esActividadDeVerdad(a.titulo));
  if (!utiles.length) throw new Error(`Civitatis no devolvió actividades de «${ciudad}»`);

  return guardarActividadesEnCatalogo(ciudad, utiles);
}

/**
 * Ejecuta un trabajo de tipo 'opinar_lienzo'.
 *
 * CASCARÓN A PROPÓSITO. La opinión de verdad —mirar el reparto y decir si el
 * ritmo tiene sentido, si falta algo, si el orden se puede mejorar— llega en el
 * siguiente prompt. Lo que existe ya es todo lo demás: el botón, la cola, el
 * sondeo y el hueco donde aterriza el resultado. Cuando haya contenido real,
 * solo hay que rellenar el medio.
 */
async function ejecutarOpinarLienzo(trabajo) {
  console.log(`[worker] Trabajo #${trabajo.id}: opinión del lienzo (todavía en hueco)`);

  ejecutar(
    "UPDATE viajes SET opinion_lienzo = ?, opinion_lienzo_en = datetime('now') WHERE id = ?",
    'La opinión de la IA llegará en la próxima versión.',
    trabajo.viaje_id
  );
}

/** Ejecuta un trabajo cualquiera según su tipo. */
async function ejecutarTrabajo(trabajo) {
  if (trabajo.tipo === 'opinar_lienzo') return ejecutarOpinarLienzo(trabajo);
  if (trabajo.tipo === 'actividades') return ejecutarActividades(trabajo);
  if (trabajo.tipo === 'avisos') return ejecutarAvisos(trabajo);
  if (trabajo.tipo === 'descubrir_destino') return ejecutarDescubrirDestino(trabajo);
  if (trabajo.tipo === 'investigar_ciudad') return ejecutarInvestigarCiudad(trabajo);
  if (trabajo.tipo === 'hoteles') return ejecutarHoteles(trabajo);
  if (trabajo.tipo === 'vuelos') return ejecutarVuelos(trabajo);
  if (trabajo.tipo === 'ficha_actividad') return ejecutarFichaActividad(trabajo);
  if (trabajo.tipo === 'preparar_etapa') return ejecutarPrepararEtapa(trabajo);
  if (trabajo.tipo === 'distancias') return ejecutarDistancias(trabajo);
  if (trabajo.tipo === 'transporte_tramo') return ejecutarTransporteTramo(trabajo);
  if (trabajo.tipo === 'movilidad_ciudad') return ejecutarMovilidadCiudad(trabajo);
  if (trabajo.tipo === 'datos_sitios') return ejecutarDatosDeSitios(trabajo);
  if (trabajo.tipo === 'horario_cierre') return interpretarHorario(trabajo.referencia_id);
  if (trabajo.tipo === 'geocodificar') return ejecutarGeocodificar(trabajo);
  if (trabajo.tipo === 'traslado') return ejecutarTraslado(trabajo);
  if (trabajo.tipo === 'comer_buscar') return ejecutarComerBuscar(trabajo);
  if (trabajo.tipo === 'comer_detalles') return ejecutarComerDetalles(trabajo);
  throw new Error(`Tipo de trabajo desconocido: ${trabajo.tipo}`);
}

let ocupado = false;

/** Una vuelta: coge el siguiente pendiente, si lo hay, y lo ejecuta. */
async function unaVuelta() {
  // Latimos siempre, ocupados o no: es lo que le dice a otra instancia que
  // esta cola ya tiene dueño.
  latir(process.pid);

  if (ocupado) return;            // ya hay un scraper corriendo: ni tocarlo
  const trabajo = siguientePendiente(TIPOS_CONOCIDOS);
  if (!trabajo) return;

  // Reclamo atomico: si otro proceso se nos adelanta, nos apartamos.
  if (!reclamar(trabajo.id)) return;

  ocupado = true;

  try {
    await ejecutarTrabajo(trabajo);
    marcarHecho(trabajo.id);
  } catch (err) {
    // Necesitamos el destino para el mensaje; puede que el viaje ya no esté.
    const viaje = una('SELECT destino FROM viajes WHERE id = ?', trabajo.viaje_id);
    const mensaje = mensajeLegible(err, viaje?.destino ?? 'ese destino', trabajo.tipo);
    console.error(`[worker] Trabajo #${trabajo.id} FALLÓ: ${mensaje}`);
    marcarError(trabajo.id, mensaje);
  } finally {
    ocupado = false;
  }
}

/**
 * Arranca el bucle. Usamos setTimeout encadenado y no setInterval, para que dos
 * vueltas no se solapen si una tarda más de la cuenta.
 */
export function arrancarWorker({ intervaloMs = INTERVALO_MS } = {}) {
  // ¿Hay ya otra instancia de la app procesando esta misma base de datos?
  // Si la hay, no arrancamos el bucle: dos workers peleandose por el mismo
  // perfil de Chrome es justo lo que dejaba trabajos colgados sin ejecutar.
  const otro = otroWorkerVivo(process.pid);
  if (otro) {
    console.warn('');
    console.warn(`  [!] Ya hay otro servidor procesando la cola (PID ${otro.pid}).`);
    console.warn('      Esta instancia NO va a ejecutar trabajos, para no pelearse');
    console.warn('      con él por el perfil de Chrome. Puedes navegar igualmente:');
    console.warn('      las búsquedas las hará el otro proceso.');
    console.warn('      Si aquel ya no existe, espera 30 s y reinicia este.');
    console.warn('');
    return false;
  }

  recuperarInterrumpidos();
  latir(process.pid);

  const tic = async () => {
    try {
      await unaVuelta();
    } catch (err) {
      // Red de seguridad: pase lo que pase, el bucle sigue vivo.
      console.error('[worker] Error inesperado en el bucle:', err);
    }
    setTimeout(tic, intervaloMs).unref?.();
  };

  setTimeout(tic, 1500).unref?.(); // un respiro tras arrancar el servidor
  console.log(`[worker] Cola en marcha (PID ${process.pid}, revisa cada ${intervaloMs / 1000}s).`);
  return true;
}
