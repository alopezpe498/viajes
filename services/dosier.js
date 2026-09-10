/**
 * services/dosier.js
 * -----------------------------------------------------------------------------
 * EL DOSIER: un solo archivo HTML con el viaje entero dentro.
 *
 * Es la salida final de todo lo que la aplicación recopila, y está pensada para
 * una situación concreta: el móvil, en la calle, sin conexión. De ahí las tres
 * reglas que mandan sobre todo lo demás:
 *
 *   1. TODO va dentro del archivo. Los datos como JSON en un <script>, el CSS y
 *      el JS en línea, las fotos en base64. Ni una petición a internet: ni CDNs,
 *      ni fuentes, ni llamadas a esta aplicación. Se abre con file:// y funciona.
 *   2. Se genera con lo que ya está guardado. El dosier no busca nada: si una
 *      excursión no tiene su ficha descargada, enseña lo básico y ya está.
 *   3. Si algo falla al generarlo (una foto que no se deja descargar), se omite
 *      esa foto y se sigue. Un dosier sin una imagen sirve; uno que no se genera
 *      no sirve de nada.
 *
 * SOBRE LAS FOTOS. Se piden tal y como están guardadas, que ya son miniaturas:
 * las de Wikipedia vienen a 330 px de ancho (~33 KB) y las de Civitatis a 230 px
 * (~8 KB). No se reescalan aquí a propósito: redimensionar en el servidor pediría
 * una librería nativa de imagen para llegar a un tamaño que las fuentes ya nos
 * dan. Sí hay tope por foto y presupuesto total, que es lo que de verdad importa
 * para que el archivo quepa en un móvil.
 */

import fs from 'node:fs/promises';
import { createWriteStream } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import ejs from 'ejs';
import { ZipArchive } from 'archiver';

import { todas, una, ejecutar, normalizarNombre } from '../db/index.js';
import { lienzoDeViaje, FRANJAS } from './lienzo.js';
import { fichaDeFila } from './catalogo.js';
import { adjuntosDe, rutaDe, comoTamano, limpiarAdjuntosHuerfanos } from './adjuntos.js';
import { reservasDelViaje } from './reservas.js';
import { medioElegidoDeTramo } from './movilidad.js';
import { trasladosDeEtapa, trasladosDeElementos } from './traslados.js';
import { fichasDeComer } from './comer.js';
import { direccionDeCandidato, direccionDe } from './direcciones.js';
import { fichasParaElDosier, fronterasParaElDosier, paisesDelViaje } from './ficha-pais.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const RAIZ = path.join(__dirname, '..');

/** Donde se guardan los archivos generados. */
export const CARPETA = path.join(RAIZ, 'dosieres');

/** Tope por foto. Por encima, se omite: una sola imagen no vale tanto. */
const TOPE_FOTO = 200 * 1024;

/** Presupuesto total de fotos. Con el resto del HTML deja el archivo holgado. */
const TOPE_FOTOS_TOTAL = 4 * 1024 * 1024;

/** Lo que se espera a que conteste una imagen antes de rendirse. */
const TIMEOUT_FOTO = 8000;

const MESES = [
  'enero', 'febrero', 'marzo', 'abril', 'mayo', 'junio',
  'julio', 'agosto', 'septiembre', 'octubre', 'noviembre', 'diciembre',
];
const DIAS_SEMANA = ['domingo', 'lunes', 'martes', 'miércoles', 'jueves', 'viernes', 'sábado'];

/** "2026-09-25" -> "viernes, 25 de septiembre" */
function enLargo(iso) {
  if (!iso) return '';
  const [a, m, d] = iso.split('-').map(Number);
  const fecha = new Date(Date.UTC(a, m - 1, d, 12));
  return `${DIAS_SEMANA[fecha.getUTCDay()]}, ${d} de ${MESES[m - 1]}`;
}

/** "2026-09-25" -> "25 sep" */
function enCorto(iso) {
  if (!iso) return '';
  const [, m, d] = iso.split('-').map(Number);
  return `${d} ${MESES[m - 1].slice(0, 3)}`;
}

/** JSON.parse que no tumba la generación por un datos_extra raro. */
function seguroJSON(texto) {
  try {
    return texto ? (JSON.parse(texto) ?? {}) : {};
  } catch {
    return {};
  }
}

// =============================================================================
// LAS FOTOS
// =============================================================================
/**
 * Descarga una imagen y la devuelve como data: URI.
 *
 * Devuelve null en cuanto algo no encaja —no responde, tarda, no es una imagen,
 * pesa demasiado—, y el que llama simplemente no pinta foto. Esto NO es sitio
 * para lanzar excepciones: se está generando un archivo, no navegando.
 */
async function comoDataUri(url) {
  if (!url || !/^https?:\/\//i.test(url)) return null;

  const corte = AbortSignal.timeout(TIMEOUT_FOTO);
  try {
    const r = await fetch(url, {
      signal: corte,
      headers: {
        // Wikipedia pide identificarse; Civitatis no se queja pero tampoco
        // estorba. Es la misma cortesía que con cualquier servicio ajeno.
        'User-Agent': 'CreadorViajes/0.1 (uso personal; generación de dosier)',
        Accept: 'image/jpeg,image/png,image/webp,image/*',
      },
    });
    if (!r.ok) return null;

    const tipo = r.headers.get('content-type') ?? '';
    if (!tipo.startsWith('image/')) return null;

    const datos = Buffer.from(await r.arrayBuffer());
    if (!datos.length || datos.length > TOPE_FOTO) return null;

    return `data:${tipo.split(';')[0]};base64,${datos.toString('base64')}`;
  } catch {
    return null;
  }
}

/**
 * Descarga las fotos que hagan falta, sin repetir y sin pasarse del presupuesto.
 *
 * De una en una y con una pausa corta: es exactamente la misma cortesía que se
 * tiene con Wikipedia en el resto del proyecto, y aquí no hay ninguna prisa.
 */
async function reunirFotos(urls) {
  const unicas = [...new Set(urls.filter(Boolean))];
  const fotos = {};
  let peso = 0;
  let omitidas = 0;

  for (const url of unicas) {
    if (peso >= TOPE_FOTOS_TOTAL) {
      omitidas++;
      continue;
    }
    const uri = await comoDataUri(url);
    if (!uri) {
      omitidas++;
      continue;
    }
    fotos[url] = uri;
    peso += uri.length;
    await new Promise((r) => setTimeout(r, 120));
  }

  return { fotos, peso, pedidas: unicas.length, omitidas };
}

// =============================================================================
// LOS ADJUNTOS DENTRO DEL ZIP
// =============================================================================
/**
 * Un nombre que se pueda leer en una carpeta.
 *
 * Estos archivos acaban descomprimidos en un movil, y ahi lo que se ve es el
 * nombre: "vuelo-ida" dice mas que "transporte-66".
 */
function comoCarpeta(texto) {
  return String(texto ?? '')
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/[^a-zA-Z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 48)
    .toLowerCase() || 'otros';
}

/**
 * Los adjuntos de un elemento, listos para el dosier.
 *
 * Cada uno lleva DOS formas de llegar a el, y las dos hacen falta:
 *   - `rel`: la ruta dentro del ZIP ("adjuntos/vuelo-ida/1-billete.pdf"), que
 *     es la que funciona con el archivo descomprimido y sin conexion.
 *   - `id`: para cuando el dosier se mira desde la propia aplicacion, sin
 *     descomprimir nada. El HTML cambia unas por otras al cargarse.
 */
function adjuntosParaElDosier(tipo, elementoId, nombreCarpeta) {
  const carpeta = `adjuntos/${comoCarpeta(nombreCarpeta)}`;

  return adjuntosDe(tipo, elementoId).map((a, i) => {
    const limpio = comoCarpeta(a.nombre_original.replace(/\.[^.]+$/, ''));
    const extension = path.extname(a.nombre_archivo) || '.dat';
    return {
      id: a.id,
      nombre: a.nombre_original,
      tamano: comoTamano(a.tamano),
      mime: a.mime,
      // El numero delante evita que dos billetes que se llamen igual se pisen.
      rel: `${carpeta}/${i + 1}-${limpio}${extension}`,
      enDisco: rutaDe(a),
    };
  });
}

// =============================================================================
// LOS DATOS
// =============================================================================
/**
 * La ficha completa de algo colocado en el lienzo.
 *
 * El lienzo dice QUÉ hay y DÓNDE está; el detalle vive en el catálogo, que es
 * donde lo dejaron las investigaciones. Aquí se juntan las dos cosas.
 */
function fichaDeCandidato(candidatoId, ciudad) {
  const c = candidatoId ? una('SELECT * FROM candidatos WHERE id = ?', candidatoId) : null;
  if (!c) return null;

  const base = {
    nombre: c.titulo,
    tipo: c.tipo,
    url: c.url,
    imagen: c.imagen_url,
    precio: c.precio,
    moneda: c.moneda,
    duracion: c.duracion,
    valoracion: c.valoracion,
    opiniones: c.num_opiniones,
  };

  // --- Excursión de Civitatis: su ficha está en el catálogo, POR CIUDAD ---
  //
  // Y la ciudad importa: Civitatis lista la misma excursión desde varias
  // ciudades —el tour del Palacio Real sale en la página de Madrid y también en
  // la de Granada—, así que en el catálogo hay dos filas con la MISMA url. Eso
  // es correcto (la clave única es ciudad + actividad), pero buscar solo por
  // url devuelve la primera que caiga, que puede ser la de la otra ciudad y no
  // tener la ficha descargada. El síntoma era una excursión ampliada que en el
  // dosier salía pelada.
  if (c.tipo === 'actividad') {
    const norm = ciudad ? normalizarNombre(ciudad) : null;
    const busca = (sql, ...args) => una(`SELECT * FROM catalogo_actividades ${sql}`, ...args);

    const a =
      (norm && c.url && busca('WHERE ciudad_norm = ? AND url = ?', norm, c.url)) ||
      (norm && busca('WHERE ciudad_norm = ? AND titulo = ?', norm, c.titulo)) ||
      // Sin ciudad o sin coincidencia, la que tenga ficha antes que la que no.
      (c.url && busca('WHERE url = ? ORDER BY (detalles_en IS NULL), id LIMIT 1', c.url)) ||
      busca('WHERE titulo = ? ORDER BY (detalles_en IS NULL), id LIMIT 1', c.titulo);

    const f = a ? fichaDeFila(a) : null;
    return {
      ...base,
      imagen: a?.imagen_url ?? base.imagen,
      descripcion: f?.descripcion ?? null,
      horarios: f?.horarios ?? null,
      duracionDetalle: f?.duracion ?? null,
      idiomas: f?.idiomas ?? null,
      incluye: f?.incluye ?? null,
      noIncluye: f?.noIncluye ?? null,
      puntoEncuentro: f?.puntoEncuentro ?? null,
      cancelacion: f?.cancelacion ?? null,
      extra: f?.extra ?? null,
    };
  }

  // --- Sitio: puede venir de puntos_interes o de sitios_lugar ---
  const punto = c.url
    ? una('SELECT * FROM puntos_interes WHERE wikipedia_url = ?', c.url)
    : una('SELECT * FROM puntos_interes WHERE nombre = ?', c.titulo);
  const sitio = punto
    ? null
    : c.url
      ? una('SELECT * FROM sitios_lugar WHERE wikipedia_url = ?', c.url)
      : una('SELECT * FROM sitios_lugar WHERE nombre = ?', c.titulo);

  const extra = punto ? seguroJSON(punto.datos_extra) : {};
  const dentro = punto
    ? todas('SELECT nombre, descripcion FROM sitios_lugar WHERE punto_interes_id = ? ORDER BY orden, id', punto.id)
    : [];

  return {
    ...base,
    imagen: punto?.imagen_url ?? sitio?.imagen_url ?? base.imagen,
    descripcion: punto?.descripcion_corta ?? sitio?.descripcion ?? null,
    porQue: extra.parrafoPorQue ?? punto?.por_que ?? null,
    comoMoverse: extra.comoMoverse ?? null,
    dentro,
    lat: punto?.lat ?? sitio?.lat ?? null,
    lon: punto?.lon ?? sitio?.lon ?? null,
  };
}

/** Lo que se sabe de un vuelo elegido, para el bloque de transporte. */
function detalleDeVuelo(candidatoId) {
  const c = candidatoId ? una('SELECT * FROM candidatos WHERE id = ?', candidatoId) : null;
  if (!c) return null;

  const extra = seguroJSON(c.datos_extra);
  return {
    titulo: c.titulo,
    precio: c.precio,
    moneda: c.moneda,
    aerolineas: extra.aerolineas ?? null,
    clase: extra.clase ?? null,
    url: c.url,
    trayectos: (extra.tramos ?? []).map((t) => ({
      horaSalida: t.horaSalida,
      horaLlegada: t.horaLlegada,
      diasDespues: t.diasDespues ?? 0,
      origen: t.aeropuertoOrigen,
      destino: t.aeropuertoDestino,
      nombreOrigen: t.nombreOrigen,
      nombreDestino: t.nombreDestino,
      duracion: t.duracion,
      escalas: t.escalas,
      escalaTexto: t.escalaTexto,
    })),
  };
}

/**
 * La dirección y el teléfono de una comida puesta en el lienzo.
 *
 * La tarjeta del lienzo solo guarda el candidato; los datos del sitio viven en
 * el catálogo, y se cruzan por nombre —que es la misma llave con la que se
 * apuntó—.
 */
function datosDeComida(candidatoId) {
  const c = una('SELECT * FROM candidatos WHERE id = ?', Number(candidatoId));
  if (!c) return {};

  const etapa = una('SELECT nombre_ciudad FROM etapas WHERE id = ?', c.etapa_id);
  if (!etapa) return {};

  const f = fichasDeComer(etapa.nombre_ciudad).find((x) => x.nombre === c.titulo);
  if (!f) return {};

  return {
    direccion: f.direccion,
    telefono: f.telefono,
    telefonoMarcable: f.telefonoMarcable,
    cocina: f.cocina,
  };
}

/** Cómo se dice cada medio en el papel. */
const ETIQUETA_MEDIO = {
  andando: 'andando',
  coche: 'en coche',
  publico: 'en transporte público',
  metro: 'en metro',
  bus: 'en bus',
  taxi: 'en taxi',
  app: 'con la app',
  tarjeta: 'con la tarjeta',
  especial: '',
  otro: '',
};

/**
 * El medio elegido de un tramo, ya listo para el dosier.
 *
 * Lo del CATÁLOGO (duración, frecuencia, precio orientativo) y LO MÍO (el
 * horario que cogí, lo que pagué, el localizador) van juntos pero separados: en
 * el papel se lee primero lo mío, que es lo que necesito en la estación.
 */
function medioDelDosier(transporteId) {
  const m = medioElegidoDeTramo(transporteId);
  if (!m) return null;
  return {
    etiqueta: m.etiquetaMedio,
    nombre: m.nombre,
    duracion: m.duracion,
    frecuencia: m.frecuencia,
    precio: m.precio,
    nota: m.nota,
    notaSentido: m.nota_sentido,
    horario: m.horario,
    precioReal: m.precioReal,
    referencia: m.referencia,
    notaPropia: m.notaPropia,
  };
}

/** El alojamiento elegido de una etapa, con su dirección si se sabe. */
function hotelDeEtapa(etapaId) {
  const h = una(
    "SELECT * FROM candidatos WHERE etapa_id = ? AND tipo = 'hotel' AND marcado = 1",
    etapaId
  );
  if (!h) return null;

  const extra = seguroJSON(h.datos_extra);
  return {
    id: h.id,
    nombre: h.titulo,
    url: h.url,
    precio: h.precio,
    moneda: h.moneda,
    noches: h.duracion,
    valoracion: h.valoracion,
    opiniones: h.num_opiniones,
    zona: extra.zona ?? null,
    distanciaCentro: extra.distanciaCentro ?? null,
    estrellas: extra.estrellas ?? null,
    imagen: h.imagen_url,
  };
}

/**
 * Qué falta para que el viaje esté listo de verdad.
 *
 * Es SOLO informativo: el check lo pongo yo. Un viaje puede estar listo con la
 * última noche sin cerrar si así lo he decidido; esto solo lo recuerda.
 */
export function loQueFalta(viajeId) {
  const tramos = todas(
    'SELECT * FROM transportes WHERE viaje_id = ? ORDER BY id',
    viajeId
    // Un tramo también queda resuelto eligiendo su medio en "Cómo llegar": el
    // bus de las 9:15 con el billete comprado no es menos tramo cerrado que un
    // vuelo elegido, y sin esto el dosier seguía pidiéndolo.
  ).filter((t) => !t.candidato_id && !t.notas && !t.ficha_transporte_id);

  const etapas = todas(
    "SELECT * FROM etapas WHERE viaje_id = ? AND estado = 'confirmada' ORDER BY orden, id",
    viajeId
  );
  const sinHotel = etapas.filter((e) => !hotelDeEtapa(e.id));

  return {
    tramosSinResolver: tramos.length,
    etapasSinHotel: sinHotel.length,
    nombresSinHotel: sinHotel.map((e) => e.nombre_ciudad),
    todoResuelto: tramos.length === 0 && sinHotel.length === 0,
  };
}

/**
 * Estado del dosier de un viaje: si lo hay, de cuándo es y si se ha quedado
 * viejo. Lo usan la ruta y el lienzo para pintar su panel.
 */
export function estadoDelDosier(viaje) {
  const hay = Boolean(viaje.dosier_en);
  // Las dos fechas son cadenas 'YYYY-MM-DD HH:MM:SS' de SQLite: se comparan como
  // texto sin más, que para ese formato es exactamente el orden cronológico.
  const viejo = hay && viaje.modificado_en ? viaje.modificado_en > viaje.dosier_en : false;

  return {
    hay,
    generadoEn: viaje.dosier_en,
    generadoEnLargo: viaje.dosier_en ? textoDeMomento(viaje.dosier_en) : null,
    viejo,
    listo: Boolean(viaje.listo),
    falta: loQueFalta(viaje.id),
  };
}

/** "2026-09-06 16:13:03" -> "6 de septiembre a las 16:13" */
function textoDeMomento(iso) {
  const m = /^(\d{4})-(\d{2})-(\d{2})[ T](\d{2}):(\d{2})/.exec(iso ?? '');
  if (!m) return iso;
  return `${Number(m[3])} de ${MESES[Number(m[2]) - 1]} a las ${m[4]}:${m[5]}`;
}

/**
 * Reúne TODO lo que va dentro del dosier.
 *
 * Sale ya con la forma que el archivo va a embeber, para que la plantilla no
 * tenga que calcular nada: dentro del HTML generado no hay servidor al que
 * preguntar.
 */
export function datosDelDosier(viajeId) {
  const viaje = una('SELECT * FROM viajes WHERE id = ?', viajeId);
  if (!viaje) return null;

  const lienzo = lienzoDeViaje(viajeId);
  const etapas = todas(
    "SELECT * FROM etapas WHERE viaje_id = ? AND estado = 'confirmada' ORDER BY orden, id",
    viajeId
  );

  const hoteles = new Map(
    etapas.map((e) => {
      const h = hotelDeEtapa(e.id);
      return [
        e.id,
        h ? { ...h, adjuntos: adjuntosParaElDosier('alojamiento', h.id, `hotel-${e.nombre_ciudad}`) } : null,
      ];
    })
  );

  // --- Los tramos, con el detalle de su vuelo si lo tienen ----------------
  const tramos = todas('SELECT * FROM transportes WHERE viaje_id = ? ORDER BY id', viajeId).map((t) => {
    const origen = t.etapa_origen_id ? etapas.find((e) => e.id === t.etapa_origen_id) : null;
    const destino = t.etapa_destino_id ? etapas.find((e) => e.id === t.etapa_destino_id) : null;
    return {
      id: t.id,
      tipo: t.tipo,
      donde: !origen ? 'ida' : !destino ? 'vuelta' : 'salto',
      origen: origen?.nombre_ciudad ?? 'casa',
      destino: destino?.nombre_ciudad ?? 'casa',
      notas: t.notas,
      precio: t.precio_estimado,
      vuelo: detalleDeVuelo(t.candidato_id),
      // El medio elegido en "Cómo llegar", con lo que se tecleó debajo: el
      // horario real, lo que costó y el localizador. En un viaje que se hace en
      // bus, esto ES el transporte del viaje, y sin esto el dosier salía vacío
      // en la mitad de los tramos.
      medio: medioDelDosier(t.id),
      adjuntos: adjuntosParaElDosier(
        'transporte',
        t.id,
        !origen ? 'vuelo-ida' : !destino ? 'vuelo-vuelta' : `trayecto-${origen.nombre_ciudad}-${destino.nombre_ciudad}`
      ),
    };
  });
  const tramoPorId = new Map(tramos.map((t) => [t.id, t]));

  // --- Los días, cada uno con sus franjas y sus bloques fijos -------------
  const colocadosPorDia = new Map();
  for (const c of lienzo?.colocados ?? []) {
    if (!colocadosPorDia.has(c.dia)) colocadosPorDia.set(c.dia, []);
    colocadosPorDia.get(c.dia).push(c);
  }
  const fijosPorDia = new Map();
  for (const f of lienzo?.fijos ?? []) {
    if (!fijosPorDia.has(f.dia)) fijosPorDia.set(f.dia, []);
    fijosPorDia.get(f.dia).push(f);
  }

  const dias = (lienzo?.dias ?? []).map((d) => {
    const suyos = colocadosPorDia.get(d.n) ?? [];
    const etapa = etapas.find((e) => e.id === d.etapaId);

    const franjas = FRANJAS.map((f) => ({
      clave: f.clave,
      etiqueta: f.etiqueta,
      horas: f.horas ?? null,
      cosas: suyos
        .filter((c) => c.franja === f.clave)
        .map((c) => ({
          id: c.id,
          hora: c.hora,
          manual: c.manual,
          texto: c.nombre,
          // Los traslados del lienzo: el metro de las 9:00, el taxi al
          // aeropuerto. Van finos también aquí, y con el teléfono a mano.
          traslado: c.tipo === 'traslado',
          medio: c.medio ?? null,
          // "andando", "coche", "público": en el papel hay que decir CÓMO se
          // va, porque el mismo trayecto son 20 minutos o son 8.
          medioEtiqueta: ETIQUETA_MEDIO[c.medio] ?? null,
          // LA DURACIÓN TECLEADA EN EL LIENZO, la lleve la tarjeta que la lleve.
          //
          // Antes solo viajaban las de traslados y comidas, que eran las únicas
          // que podían tenerla. Ahora cualquier tarjeta puede llevar hora y
          // duración, y las dos tienen que llegar al papel: en la calle, "10:00
          // · 1 h 30" es la mitad de lo que se consulta.
          duracion: c.duracion,
          telefono: c.telefono ?? null,
          telefonoMarcable: c.telefono ? String(c.telefono).replace(/[^+\d]/g, '') : null,
          // Una comida colocada: dónde es y a qué número se llama para
          // reservar. En la calle es lo único que hace falta.
          ...(c.tipo === 'comer' ? datosDeComida(c.candidatoId) : {}),
          ficha: c.manual ? null : fichaDeCandidato(c.candidatoId, d.ciudad),
          // Los bonos y las entradas de esa excursión.
          adjuntos: c.manual ? [] : adjuntosParaElDosier('excursion', c.candidatoId, c.nombre),
        })),
      transportes: (fijosPorDia.get(d.n) ?? [])
        .filter((f2) => f2.franja === f.clave)
        .map((f2) => ({
          texto: f2.texto,
          hora: f2.hora,
          donde: f2.donde,
          detalle: tramoPorId.get(f2.id) ?? null,
        })),
    }));

    return {
      n: d.n,
      fecha: d.fecha,
      fechaLarga: enLargo(d.fecha),
      fechaCorta: d.fechaCorta,
      ciudad: d.ciudad,
      // De qué parada es este día: es lo que empareja el día con su chuleta de
      // traslados, que va al final.
      etapaId: d.etapaId ?? null,
      // El hotel de ESA noche. El último día ya no se duerme allí: se vuelve.
      hotel: d.n === (lienzo?.dias?.length ?? 0) ? null : (hoteles.get(d.etapaId) ?? null),
      franjas: franjas.filter((f) => f.cosas.length || f.transportes.length),
      vacio: !suyos.length && !(fijosPorDia.get(d.n) ?? []).length,
    };
  });

  // --- La chuleta de traslados de cada parada ----------------------------
  // Va al final de la etapa porque en la calle es justo lo que se consulta:
  // "¿cuánto hay de aquí a allá?". No es el plan del día, es la referencia que
  // uno mira cuando el plan se tuerce.
  const chuletas = etapas.map((e) => {
    const suyos = trasladosDeEtapa(e.id).traslados.filter((t) => t.resultados.length);
    return {
      etapaId: e.id,
      ciudad: e.nombre_ciudad,
      traslados: suyos.map((t) => ({
        recorrido: t.recorrido,
        medios: t.resultados.map((r) => ({
          etiqueta: r.etiqueta,
          texto: r.texto,
        })),
      })),
    };
  }).filter((c) => c.traslados.length);

  // --- Dónde comer: lo apuntado de cada parada ---------------------------
  // Lo que está APUNTADO pero no puesto en un día. En el lienzo no sale porque
  // no tiene día, y es justo lo que uno mira a las dos de la tarde sin plan:
  // "¿qué tenía yo apuntado por aquí?". Con sus distancias, que en la calle son
  // lo que decide.
  const colocadosIds = new Set(
    (lienzo?.colocados ?? []).map((c) => c.candidatoId).filter(Boolean)
  );

  const dondeComer = etapas
    .map((e) => {
      const apuntados = todas(
        "SELECT * FROM candidatos WHERE etapa_id = ? AND tipo = 'comer' ORDER BY id",
        e.id
      ).filter((c) => !colocadosIds.has(c.id));

      const fichas = fichasDeComer(e.nombre_ciudad);
      const distancias = trasladosDeElementos('comer', fichas.map((f) => f.id));

      return {
        etapaId: e.id,
        ciudad: e.nombre_ciudad,
        sitios: apuntados
          .map((c) => {
            const f = fichas.find((x) => x.nombre === c.titulo);
            if (!f) return null;
            return {
              nombre: f.nombre,
              cocina: f.cocina,
              precio: f.precioSimbolo ?? f.precioTexto,
              valoracion: f.valoracion,
              direccion: f.direccion,
              telefono: f.telefono,
              telefonoMarcable: f.telefonoMarcable,
              nota: f.nota,
              distancias: (distancias.get(f.id) ?? [])
                .filter((d) => d.resultados.length)
                .map((d) => ({
                  linea: d.linea,
                  tiempos: d.resultados.map((r) => `${r.texto} ${r.etiqueta}`).join(' · '),
                })),
            };
          })
          .filter(Boolean),
      };
    })
    .filter((x) => x.sitios.length);

  // --- Reservas: todo lo cerrado, junto y a mano -------------------------
  const reservas = {
    vuelos: tramos
      // Un tramo con billetes adjuntos entra en Reservas aunque no tenga vuelo
      // elegido: si has guardado el billete, es que ese trayecto está cerrado.
      .filter((t) => t.vuelo || t.notas || t.medio || t.adjuntos.length)
      .map((t) => ({
        recorrido: `${t.origen} → ${t.destino}`,
        donde: t.donde,
        vuelo: t.vuelo,
        medio: t.medio,
        notas: t.notas,
        precio: t.precio,
        adjuntos: t.adjuntos,
      })),
    hoteles: etapas
      .map((e) => ({ ciudad: e.nombre_ciudad, desde: enCorto(e.fecha_inicio), hasta: enCorto(e.fecha_fin), hotel: hoteles.get(e.id) }))
      .filter((x) => x.hotel),
  };

  // --- MIS RESERVAS: los localizadores, que es lo que se busca con prisa ----
  //
  // Van con sus adjuntos dentro del ZIP, como el resto: en el mostrador no hay
  // cobertura y el billete tiene que abrirse igual.
  const misReservas = reservasDelViaje(viaje.id).reservadas.map((r) => ({
    tipo: r.nombreTipo,
    titulo: r.titulo,
    donde: r.donde,
    fecha: enCorto(r.fecha),
    fechaISO: r.fecha,
    localizador: r.localizador,
    notas: r.notas,
    enlace: r.enlaceUrl,
    adjuntos: adjuntosParaElDosier('reserva', r.candidatoId, `reserva-${r.tipo}-${r.titulo ?? ''}`),
  }));

  // Y por día, para la portada: el localizador a mano en el día que toca.
  const localizadoresPorFecha = new Map();
  for (const r of misReservas) {
    if (!r.fechaISO || !r.localizador) continue;
    if (!localizadoresPorFecha.has(r.fechaISO)) localizadoresPorFecha.set(r.fechaISO, []);
    localizadoresPorFecha.get(r.fechaISO).push({
      tipo: r.tipo,
      titulo: r.titulo,
      localizador: r.localizador,
    });
  }

  for (const d of dias) {
    d.localizadores = localizadoresPorFecha.get(d.fechaISO ?? d.fecha) ?? [];
  }

  return {
    viaje: {
      id: viaje.id,
      nombre: viaje.nombre,
      destino: viaje.destino,
      fechaInicio: viaje.fecha_inicio,
      fechaFin: viaje.fecha_fin,
      fechasLargas: `${enLargo(viaje.fecha_inicio)} — ${enLargo(viaje.fecha_fin)}`,
      adultos: viaje.adultos,
      ninos: viaje.ninos,
      presupuesto: viaje.presupuesto,
    },
    ruta: etapas.map((e) => ({
      ciudad: e.nombre_ciudad,
      noches: e.noches,
      desde: enCorto(e.fecha_inicio),
      hasta: enCorto(e.fecha_fin),
      hotel: hoteles.get(e.id) ?? null,
      notas: e.notas,
    })),
    dias,
    reservas,
    misReservas,
    chuletas,
    dondeComer,
    // ANTES DE VIAJAR, con su fecha de generación a la vista.
    //
    // Va al dosier porque el dosier es lo que se abre sin conexión, y estando
    // allí el número del consulado o si el seguro era obligatorio no se pueden
    // buscar. La fecha se enseña sin disimulo: un requisito de entrada de hace
    // tres meses puede haber cambiado, y quien lo lea tiene que poder juzgarlo.
    antesDeViajar: fichasParaElDosier(viajeId),
    // LOS CRUCES DE FRONTERA VAN CON LAS FICHAS, y una sola vez: no son de
    // ninguno de los dos países. En el dosier importan más que en la pantalla,
    // porque es lo que se lleva encima el día que hay que enseñar el pasaporte.
    fronteras: fronterasParaElDosier(viajeId),
    generadoEn: new Date().toISOString(),
  };
}

// =============================================================================
// GENERAR
// =============================================================================
/**
 * Las urls de foto que el dosier va a PINTAR, para descargarlas de una vez.
 *
 * Solo las de sitios y excursiones: el hotel se enseña con su nombre, su zona y
 * su nota, sin foto. Descargar la del hotel serían decenas de KB embebidos que
 * nadie llega a ver.
 */
function fotosQueHacenFalta(datos) {
  const urls = [];
  for (const d of datos.dias) {
    for (const f of d.franjas) {
      for (const c of f.cosas) if (c.ficha?.imagen) urls.push(c.ficha.imagen);
    }
  }
  return urls;
}

/** Los dos archivos de un viaje. Siempre los mismos: generar sustituye. */
export const rutaDelArchivo = (viajeId) => path.join(CARPETA, `viaje-${viajeId}.html`);
export const rutaDelZip = (viajeId) => path.join(CARPETA, `viaje-${viajeId}.zip`);

/** Todos los adjuntos que van dentro del ZIP, con su sitio dentro. */
function adjuntosDelDosier(datos) {
  const lista = [];
  for (const t of datos.reservas.vuelos) lista.push(...(t.adjuntos ?? []));
  for (const h of datos.reservas.hoteles) lista.push(...(h.hotel?.adjuntos ?? []));
  // Los billetes y bonos de las reservas del usuario, que son los papeles que de
  // verdad hay que enseñar en un mostrador.
  for (const r of datos.misReservas ?? []) lista.push(...(r.adjuntos ?? []));
  for (const d of datos.dias) {
    for (const f of d.franjas) for (const c of f.cosas) lista.push(...(c.adjuntos ?? []));
  }
  // El mismo adjunto sale en el día Y en la sección de reservas: una sola copia.
  return [...new Map(lista.map((a) => [a.rel, a])).values()];
}

/**
 * Empaqueta el HTML y los adjuntos.
 *
 * Descomprimido queda así, y por eso los enlaces del HTML son relativos:
 *
 *   dosier.html
 *   adjuntos/vuelo-ida/1-billete-iberia.pdf
 *   adjuntos/hotel-madrid/1-confirmacion.pdf
 *
 * Un adjunto que ya no esté en el disco se omite y se cuenta: el ZIP se hace
 * igual. Que falte un billete no puede dejarte sin el resto del viaje.
 */
async function empaquetar(viajeId, html, adjuntos) {
  const destino = rutaDelZip(viajeId);
  const salida = createWriteStream(destino);
  const zip = new ZipArchive({ zlib: { level: 9 } });

  const omitidos = [];
  const terminado = new Promise((resolve, reject) => {
    salida.on('close', resolve);
    salida.on('error', reject);
    zip.on('error', reject);
    // Los avisos (un archivo que desaparece a mitad) no tumban el ZIP.
    zip.on('warning', (err) => console.warn('[dosier] aviso del ZIP:', err.message));
  });

  zip.pipe(salida);
  zip.append(html, { name: 'dosier.html' });

  for (const a of adjuntos) {
    try {
      await fs.access(a.enDisco);
      zip.file(a.enDisco, { name: a.rel });
    } catch {
      omitidos.push(a.nombre);
    }
  }

  await zip.finalize();
  await terminado;

  const { size } = await fs.stat(destino);
  return { archivo: destino, bytes: size, omitidos };
}

/**
 * Genera el dosier y lo deja en disco.
 *
 * Devuelve { archivo, bytes, fotos } o lanza si el viaje no existe. Las fotos
 * que no se puedan traer se omiten: eso NO es un fallo de la generación.
 */
export async function generarDosier(viajeId) {
  // Que las paradas sepan de qué país son ANTES de armar los datos.
  //
  // `datosDelDosier` es síncrona y sin red a propósito, así que no puede
  // geocodificar por su cuenta. Esto lo deja resuelto y guardado en las etapas,
  // y de ahí lo lee el filtro de las fichas de país. Si falla, el dosier sale
  // igual: simplemente sin esa sección.
  try {
    await paisesDelViaje(viajeId);
  } catch (err) {
    console.warn(`[dosier] no pude resolver los países del viaje #${viajeId}: ${err.message}`);
  }

  // Antes de nada, fuera los adjuntos cuyo elemento ya no existe: si no, el ZIP
  // se llevaría el billete de un tramo que se borró hace tres cambios de ruta.
  await limpiarAdjuntosHuerfanos(viajeId);

  const datos = datosDelDosier(viajeId);
  if (!datos) return null;

  const { fotos, peso, pedidas, omitidas } = await reunirFotos(fotosQueHacenFalta(datos));
  console.log(
    `[dosier] Viaje #${viajeId}: ${pedidas - omitidas} de ${pedidas} fotos ` +
      `(${Math.round(peso / 1024)} KB)` + (omitidas ? `, ${omitidas} omitidas` : '')
  );

  const html = await ejs.renderFile(path.join(RAIZ, 'views', 'dosier.ejs'), { datos, fotos }, {
    // El dosier es una plantilla suelta: no hereda nada de las de la aplicación.
    rmWhitespace: false,
  });

  await fs.mkdir(CARPETA, { recursive: true });

  // El HTML suelto se queda para "Ver": una revisión rápida no tiene por qué
  // pasar por descomprimir nada.
  const archivo = rutaDelArchivo(viajeId);
  await fs.writeFile(archivo, html, 'utf8');

  // Y el ZIP, que es lo que se descarga y se comparte.
  const adjuntos = adjuntosDelDosier(datos);
  const zip = await empaquetar(viajeId, html, adjuntos);

  ejecutar("UPDATE viajes SET dosier_en = datetime('now') WHERE id = ?", viajeId);

  console.log(
    `[dosier] Viaje #${viajeId}: ${zip.archivo} · ${(zip.bytes / 1024 / 1024).toFixed(2)} MB · ` +
      `${adjuntos.length - zip.omitidos.length} adjunto/s` +
      (zip.omitidos.length ? ` · ${zip.omitidos.length} sin encontrar` : '')
  );

  return {
    archivo: zip.archivo,
    html: archivo,
    bytes: zip.bytes,
    bytesHtml: Buffer.byteLength(html, 'utf8'),
    fotos: pedidas - omitidas,
    fotosOmitidas: omitidas,
    adjuntos: adjuntos.length - zip.omitidos.length,
    adjuntosOmitidos: zip.omitidos.length,
    nombresOmitidos: zip.omitidos,
  };
}

/** Lee el HTML ya generado, para verlo. Devuelve null si no está. */
export async function leerDosier(viajeId) {
  try {
    return await fs.readFile(rutaDelArchivo(viajeId), 'utf8');
  } catch {
    return null;
  }
}

/** ¿Existe ya el ZIP? Devuelve su ruta o null. */
export async function zipDelViaje(viajeId) {
  const ruta = rutaDelZip(viajeId);
  try {
    await fs.access(ruta);
    return ruta;
  } catch {
    return null;
  }
}
