/**
 * services/documentos.js
 * -----------------------------------------------------------------------------
 * TODOS LOS PAPELES DEL VIAJE EN UNA SOLA PANTALLA.
 *
 * Los adjuntos se suben cada uno en su sitio —el billete en su tramo, la
 * confirmación en su hotel, el bono en su excursión— y ahí es donde tienen que
 * subirse: junto a la cosa a la que pertenecen. Pero luego, el día antes de
 * salir, la pregunta es otra: «¿tengo todos los papeles?». Y esa no se contesta
 * abriendo siete pestañas.
 *
 * ESTO SOLO REÚNE Y ENSEÑA. No sube, no borra, no edita. Cada documento se sigue
 * gestionando donde vive.
 *
 * EL PROBLEMA DE VERDAD ERA LA ETIQUETA.
 *
 * Un adjunto guarda `(tipo_elemento, elemento_id)` y nada más, y eso es una
 * relación POLIMÓRFICA: según el tipo, el id apunta a `transportes` o a
 * `candidatos`. Una lista de nombres de archivo sin contexto no vale para nada
 * —«confirmacion.pdf» ¿de qué hotel?—, así que el trabajo de este fichero es
 * convertir ese par de números en «Hotel de Santorini · Oia».
 *
 * Y son dos caminos distintos, no uno:
 *
 *   · Los de `candidatos` (hotel, excursión, reserva) traen su título y cuelgan
 *     de una etapa, así que la ciudad sale de un JOIN y ya está.
 *   · Los de `transportes` NO tienen título: son un hueco entre dos paradas, y
 *     cualquiera de los dos extremos puede ser NULL —la ida sale de casa y la
 *     vuelta vuelve a casa—. Su etiqueta hay que componerla.
 *
 * LOS GRUPOS SON POR TIPO DE COSA, NO POR TIPO DE ARCHIVO. Un PDF y una foto del
 * mismo billete van juntos, porque lo que uno busca es «los papeles del vuelo»,
 * no «los PDF». Y el tipo `reserva` no tiene grupo propio: se reparte al que le
 * toque según de qué cuelgue, porque una reserva de hotel es papeleo de hotel.
 */

import path from 'node:path';
import fs from 'node:fs/promises';

import { todas, una } from '../db/index.js';
import { adjuntosDelViaje, comoTamano, rutaDe, limpiarAdjuntosHuerfanos } from './adjuntos.js';
import { ciudadDeCasa } from './proveedores.js';

/**
 * CÓMO SE VE CADA COSA EN EL VISOR.
 *
 * Cuatro maneras y un cajón de sastre, y la última es tan importante como las
 * otras: lo que no se sabe pintar se ofrece para descargar, sin disimulo. Un
 * visor que enseña un rectángulo roto es peor que uno que dice «esto no lo sé
 * enseñar, bájatelo».
 */
const COMO_SE_VE = new Map([
  ['application/pdf', 'pdf'],
  ['image/jpeg', 'imagen'],
  ['image/png', 'imagen'],
  ['message/rfc822', 'correo'],
  ['text/plain', 'texto'],
  // El HEIC se puede subir —es lo que hace un iPhone— pero NO lo pinta ningún
  // navegador salvo Safari. Fingir que sí dejaría un hueco en blanco sin
  // explicación, así que va por la puerta de la descarga, como el Word.
  ['image/heic', 'descarga'],
  ['image/heif', 'descarga'],
]);

/** Los cuatro cajones de la pantalla, en el orden en que se usan al viajar. */
export const GRUPOS = [
  { clave: 'transporte', titulo: 'Vuelos y transportes', icono: 'ti-plane' },
  { clave: 'alojamiento', titulo: 'Hoteles', icono: 'ti-bed' },
  { clave: 'excursion', titulo: 'Excursiones y reservas', icono: 'ti-ticket' },
  { clave: 'otros', titulo: 'Otros documentos', icono: 'ti-paperclip' },
];

/** El icono de la lista, por cómo se va a ver. */
const ICONOS = {
  pdf: 'ti-file-type-pdf',
  imagen: 'ti-photo',
  correo: 'ti-mail',
  texto: 'ti-file-text',
  descarga: 'ti-file-download',
};

/**
 * De qué grupo es un adjunto.
 *
 * Los tres primeros tipos van a su cajón. El cuarto —`reserva`— NO tiene cajón:
 * se mira de qué candidato cuelga y se le da el que le corresponde. Un bono de
 * excursión reservada es papeleo de excursión, y buscarlo en un grupo llamado
 * «Reservas» sería un sitio más donde mirar.
 */
function grupoDe(tipoElemento, candidato) {
  if (tipoElemento !== 'reserva') {
    return GRUPOS.some((g) => g.clave === tipoElemento) ? tipoElemento : 'otros';
  }
  if (candidato?.tipo === 'hotel') return 'alojamiento';
  if (candidato?.tipo === 'actividad') return 'excursion';
  if (candidato?.tipo === 'vuelo' || candidato?.tipo === 'traslado') return 'transporte';
  return 'otros';
}

/**
 * LA ETIQUETA DE UN TRAMO, que es el caso que no se resuelve con un JOIN.
 *
 * Un tramo son dos extremos y cualquiera de los dos puede faltar: sin origen es
 * la ida desde casa, sin destino es la vuelta. Y el nombre de casa no está en
 * ninguna tabla de etapas: lo sabe el viaje.
 */
function etiquetaDeTramo(tramo, nombreDeEtapa, casa) {
  const desde = tramo.etapa_origen_id ? nombreDeEtapa.get(tramo.etapa_origen_id) : casa;
  const hasta = tramo.etapa_destino_id ? nombreDeEtapa.get(tramo.etapa_destino_id) : casa;
  return `${desde ?? '¿?'} → ${hasta ?? '¿?'}`;
}

/**
 * Todos los documentos de un viaje, agrupados y con su etiqueta puesta.
 *
 * Devuelve `null` si el viaje no existe, para que la ruta conteste 404 en vez de
 * pintar una pantalla vacía que parece un viaje sin papeles.
 */
export async function documentosDelViaje(viajeId) {
  const viaje = una('SELECT * FROM viajes WHERE id = ?', Number(viajeId));
  if (!viaje) return null;

  // PRIMERO SE BARREN LOS HUÉRFANOS. Si se borró el hotel, su confirmación ya no
  // tiene de qué colgar y no se le puede poner etiqueta. La función ya existe y
  // es la que llaman las pestañas al listar; aquí hace la misma falta.
  await limpiarAdjuntosHuerfanos(viaje.id);

  const adjuntos = adjuntosDelViaje(viaje.id);

  // Los nombres de las paradas, de una vez: hacen falta para casi todas las
  // etiquetas y son cuatro filas.
  const nombreDeEtapa = new Map(
    todas('SELECT id, nombre_ciudad FROM etapas WHERE viaje_id = ?', viaje.id).map((e) => [
      e.id,
      e.nombre_ciudad,
    ])
  );
  const casa = ciudadDeCasa(viaje);

  const documentos = [];

  for (const a of adjuntos) {
    const esTramo = a.tipo_elemento === 'transporte';

    const tramo = esTramo
      ? una('SELECT * FROM transportes WHERE id = ?', a.elemento_id)
      : null;
    const candidato = esTramo
      ? null
      : una('SELECT * FROM candidatos WHERE id = ?', a.elemento_id);

    // No debería pasar —acabamos de barrer los huérfanos— pero si el elemento se
    // fue entre medias, el documento no desaparece de la lista: se enseña
    // diciendo lo que se sabe. Perder de vista un papel es peor que no saber de
    // dónde salió.
    const deQuien = esTramo
      ? tramo
        ? etiquetaDeTramo(tramo, nombreDeEtapa, casa)
        : 'Un tramo que ya no está en la ruta'
      : (candidato?.titulo ?? 'Algo que ya no está en el viaje');

    const ciudad = esTramo ? null : nombreDeEtapa.get(candidato?.etapa_id) ?? null;

    const comoSeVe = COMO_SE_VE.get(a.mime) ?? 'descarga';

    documentos.push({
      id: a.id,
      nombre: a.nombre_original,
      mime: a.mime,
      tamano: comoTamano(a.tamano),
      subidoEn: a.subido_en,
      comoSeVe,
      icono: ICONOS[comoSeVe] ?? 'ti-paperclip',
      grupo: grupoDe(a.tipo_elemento, candidato),
      // La etiqueta de debajo del nombre: de qué cuelga y, si se sabe, dónde.
      deQuien,
      ciudad,
      etiqueta: ciudad ? `${deQuien} · ${ciudad}` : deQuien,
      url: `/adjunto/${a.id}`,
    });
  }

  const grupos = GRUPOS.map((g) => ({
    ...g,
    documentos: documentos.filter((d) => d.grupo === g.clave),
  })).filter((g) => g.documentos.length);

  return { viaje, grupos, total: documentos.length };
}

/**
 * EL CONTENIDO LEGIBLE DE UN CORREO O DE UNA NOTA.
 *
 * Se lee en el servidor y no en el navegador a propósito: un `.eml` es texto
 * plano pero con cabeceras codificadas y un cuerpo que puede venir en varias
 * partes, y eso se resuelve una vez aquí en vez de en cada pintada.
 *
 * Devuelve `null` si el adjunto no es de los que se leen, o si el archivo ya no
 * está en el disco.
 */
export async function contenidoDe(adjunto) {
  if (!adjunto) return null;
  const comoSeVe = COMO_SE_VE.get(adjunto.mime);
  if (comoSeVe !== 'correo' && comoSeVe !== 'texto') return null;

  let crudo;
  try {
    crudo = await fs.readFile(rutaDe(adjunto), 'utf8');
  } catch {
    return null; // el archivo se fue del disco: la pantalla lo dirá
  }

  if (comoSeVe === 'texto') return { clase: 'texto', cuerpo: crudo };
  return { clase: 'correo', ...leerCorreo(crudo) };
}

// =============================================================================
// EL LECTOR DE CORREOS
// =============================================================================
/**
 * UN `.eml` A LA MÍNIMA EXPRESIÓN: de quién, para quién, asunto, fecha y cuerpo.
 *
 * NO es un cliente de correo y no pretende serlo. No pinta HTML, no saca los
 * adjuntos de dentro del correo, no sigue las conversaciones. Enseña lo que uno
 * va a buscar cuando abre la confirmación del hotel en el móvil: el asunto y lo
 * que decía.
 *
 * TRES COSAS QUE HAY QUE HACER O EL TEXTO SALE ILEGIBLE, y son las tres razones
 * por las que esto no es un `split('\n')`:
 *
 *   1. LAS CABECERAS SE PARTEN EN VARIAS LÍNEAS. El estándar deja continuar una
 *      cabecera larga empezando la siguiente línea con un espacio. Sin juntarlas,
 *      un asunto largo sale cortado por la mitad.
 *   2. LOS ACENTOS VIAJAN CODIFICADOS. «Confirmación» llega como
 *      `=?UTF-8?Q?Confirmaci=C3=B3n?=`. Sin descifrarlo, el asunto es un jeroglífico.
 *   3. EL CUERPO PUEDE VENIR EN VARIAS PARTES. Casi todos los correos se mandan
 *      dos veces, en texto y en HTML. Se busca la parte de TEXTO, que es la que
 *      se puede enseñar tal cual; si solo hay HTML, se le quitan las etiquetas,
 *      que es feo pero legible, y mucho mejor que enseñar el código.
 */

/** `=?UTF-8?Q?...?=` y `=?UTF-8?B?...?=` — los acentos de las cabeceras. */
function descifrarCabecera(texto) {
  return String(texto ?? '').replace(
    /=\?([^?]+)\?([QqBb])\?([^?]*)\?=/g,
    (entero, juego, como, dato) => {
      try {
        if (como.toUpperCase() === 'B') {
          return Buffer.from(dato, 'base64').toString(juegoValido(juego));
        }
        const bytes = dato
          .replace(/_/g, ' ')
          .replace(/=([0-9A-Fa-f]{2})/g, (m, hex) => String.fromCharCode(parseInt(hex, 16)));
        return Buffer.from(bytes, 'binary').toString(juegoValido(juego));
      } catch {
        return entero; // sin poder descifrarlo, se enseña como vino
      }
    }
  );
}

/** Node no conoce todos los juegos de caracteres; los raros caen a latin1. */
function juegoValido(juego) {
  const j = String(juego ?? '').toLowerCase();
  if (j.includes('utf-8') || j.includes('utf8')) return 'utf8';
  if (j.includes('8859') || j.includes('windows-1252')) return 'latin1';
  return 'utf8';
}

/** El `quoted-printable` del cuerpo: `=C3=B3` y los cortes de línea con `=`. */
function desQuotedPrintable(texto, juego = 'utf-8') {
  const sinCortes = String(texto ?? '').replace(/=\r?\n/g, '');
  const bytes = sinCortes.replace(/=([0-9A-Fa-f]{2})/g, (m, hex) =>
    String.fromCharCode(parseInt(hex, 16))
  );
  return Buffer.from(bytes, 'binary').toString(juegoValido(juego));
}

/**
 * Las entidades con nombre que de verdad salen en un correo en español. Las
 * numéricas se resuelven aparte y cubren todo lo demás.
 */
const ENTIDADES = {
  nbsp: ' ', amp: '&', lt: '<', gt: '>', quot: '"', apos: "'",
  aacute: 'á', eacute: 'é', iacute: 'í', oacute: 'ó', uacute: 'ú', ntilde: 'ñ',
  Aacute: 'Á', Eacute: 'É', Iacute: 'Í', Oacute: 'Ó', Uacute: 'Ú', Ntilde: 'Ñ',
  uuml: 'ü', Uuml: 'Ü', iquest: '¿', iexcl: '¡', euro: '€', hellip: '…',
  mdash: '—', ndash: '–', laquo: '«', raquo: '»', deg: '°',
};

/** Etiquetas fuera, entidades a su carácter. Feo pero legible. */
function sinEtiquetas(html) {
  return String(html ?? '')
    .replace(/<(script|style)[\s\S]*?<\/\1>/gi, '')
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<\/(p|div|tr|li|h[1-6])>/gi, '\n')
    .replace(/<[^>]+>/g, '')
    // Primero las numéricas, que cubren cualquier carácter, y después las de
    // nombre. Sin esto, «C&oacute;digo» se quedaba tal cual en pantalla.
    .replace(/&#(\d+);/g, (m, n) => String.fromCodePoint(Number(n)))
    .replace(/&#x([0-9a-f]+);/gi, (m, h) => String.fromCodePoint(parseInt(h, 16)))
    .replace(/&([a-zA-Z]+);/g, (m, n) => ENTIDADES[n] ?? m)
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

/** Parte cabeceras y cuerpo, juntando las cabeceras continuadas. */
function partirEnDos(crudo) {
  const corte = crudo.search(/\r?\n\r?\n/);
  const cabecera = corte === -1 ? crudo : crudo.slice(0, corte);
  const cuerpo = corte === -1 ? '' : crudo.slice(corte).replace(/^\r?\n\r?\n/, '');

  const cabeceras = new Map();
  // La continuación de una cabecera empieza con espacio o tabulador: se pega a
  // la anterior antes de partir por los dos puntos.
  const lineas = cabecera.replace(/\r?\n[ \t]+/g, ' ').split(/\r?\n/);
  for (const linea of lineas) {
    const i = linea.indexOf(':');
    if (i <= 0) continue;
    const clave = linea.slice(0, i).trim().toLowerCase();
    const valor = linea.slice(i + 1).trim();
    if (!cabeceras.has(clave)) cabeceras.set(clave, valor);
  }
  return { cabeceras, cuerpo };
}

/** El texto de un cuerpo, ya descodificado según diga su cabecera. */
function descodificarCuerpo(cuerpo, cabeceras) {
  const codificacion = (cabeceras.get('content-transfer-encoding') ?? '').toLowerCase();
  const juego = (cabeceras.get('content-type') ?? '').match(/charset="?([^";\s]+)"?/i)?.[1];

  if (codificacion.includes('base64')) {
    try {
      return Buffer.from(cuerpo.replace(/\s+/g, ''), 'base64').toString(juegoValido(juego));
    } catch {
      return cuerpo;
    }
  }
  if (codificacion.includes('quoted-printable')) return desQuotedPrintable(cuerpo, juego);
  return cuerpo;
}

export function leerCorreo(crudo) {
  const { cabeceras, cuerpo } = partirEnDos(String(crudo ?? ''));

  const tipo = cabeceras.get('content-type') ?? '';
  const frontera = tipo.match(/boundary="?([^";\s]+)"?/i)?.[1];

  let texto = null;
  let html = null;

  if (frontera) {
    // Multipart: se recorren las partes y se guarda la de texto, que es la que
    // se puede enseñar tal cual. El HTML queda de respaldo.
    for (const trozo of String(cuerpo).split(`--${frontera}`)) {
      const limpio = trozo.replace(/^\r?\n/, '');
      if (!limpio.trim() || limpio.startsWith('--')) continue;
      const parte = partirEnDos(limpio);
      const suTipo = (parte.cabeceras.get('content-type') ?? '').toLowerCase();
      // Una parte que es OTRO multipart (alternative dentro de mixed) se mira
      // por dentro, que es donde está el texto de verdad.
      if (suTipo.includes('multipart/')) {
        const dentro = leerCorreo(limpio);
        if (dentro.cuerpo && !texto) texto = dentro.cuerpo;
        continue;
      }
      const contenido = descodificarCuerpo(parte.cuerpo, parte.cabeceras);
      if (suTipo.includes('text/plain') && !texto) texto = contenido;
      else if (suTipo.includes('text/html') && !html) html = contenido;
    }
  } else if (tipo.toLowerCase().includes('text/html')) {
    html = descodificarCuerpo(cuerpo, cabeceras);
  } else {
    texto = descodificarCuerpo(cuerpo, cabeceras);
  }

  // SI NO PARECE UN CORREO, SE ENSEÑA COMO LO QUE SEA QUE ES.
  //
  // Un `.eml` que no trae ni remitente ni asunto es un archivo mal guardado, o
  // un texto al que le pusieron esa extensión. Dejar la pantalla en blanco haría
  // pensar que el documento se ha perdido; enseñar el contenido crudo al menos
  // deja ver qué hay dentro.
  const parece = cabeceras.has('from') || cabeceras.has('subject') || cabeceras.has('date');
  const cuerpoFinal = (texto ?? (html ? sinEtiquetas(html) : '')).trim();

  return {
    de: descifrarCabecera(cabeceras.get('from')) || null,
    para: descifrarCabecera(cabeceras.get('to')) || null,
    asunto: descifrarCabecera(cabeceras.get('subject')) || null,
    fecha: cabeceras.get('date') || null,
    cuerpo: (parece ? cuerpoFinal : cuerpoFinal || String(crudo ?? '').trim()) || null,
    // Se dice cuando el texto sale de desmontar el HTML: explica que la
    // presentación se vea pobre, y evita que parezca que falta algo.
    deHtml: !texto && Boolean(html),
  };
}

export default { documentosDelViaje, contenidoDe, leerCorreo, GRUPOS };
