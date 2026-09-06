/**
 * services/avisos.js
 * -----------------------------------------------------------------------------
 * Los avisos del destino (pantalla 3), de tres fuentes reales y gratuitas.
 *
 * A diferencia de los otros proveedores, esto NO abre navegador: las tres
 * fuentes responden a un fetch normal. Por eso el trabajo de avisos tarda
 * segundos en vez de medio minuto y no se pelea con nadie por el perfil de
 * Chrome.
 *
 * REGLA DE ORO: si una fuente falla, las otras siguen. Cada una va en su propio
 * try/catch y, si se cae, devuelve un aviso "No he podido consultar X" en
 * severidad info. La pantalla nunca se queda en blanco ni revienta por esto.
 *
 * Las tres fuentes:
 *   1. CLIMA      Open-Meteo (geocoding + archivo histórico). Sin clave.
 *   2. SEGURIDAD  Recomendaciones de viaje de Exteriores (exteriores.gob.es).
 *   3. FESTIVOS   Nager.Date. Sin clave.
 */

/** Corta una petición que se eternice: mejor un aviso de fallo que colgarse. */
const TIMEOUT_MS = 12_000;

/** Petición con timeout y con un User-Agent honesto. */
async function pedir(url, { comoTexto = false } = {}) {
  const control = new AbortController();
  const reloj = setTimeout(() => control.abort(), TIMEOUT_MS);
  try {
    const respuesta = await fetch(url, {
      signal: control.signal,
      headers: {
        'User-Agent': 'CreadorViajes/0.1 (generador de viajes personal)',
        Accept: comoTexto ? 'text/html' : 'application/json',
      },
    });
    if (!respuesta.ok) throw new Error(`respondió ${respuesta.status}`);
    if (comoTexto) return respuesta.text();

    // Nager.Date contesta 204 con el cuerpo vacío para los países que no cubre
    // (Nepal, por ejemplo). Eso no es un fallo: es que no tiene datos. Si lo
    // pasáramos a JSON.parse reventaría y el aviso diría "no he podido
    // consultarlo", que es mentira y además asusta.
    const cuerpo = (await respuesta.text()).trim();
    return cuerpo === '' ? null : JSON.parse(cuerpo);
  } finally {
    clearTimeout(reloj);
  }
}

/** Un aviso con la forma que espera la pantalla. */
const aviso = (categoria, severidad, titulo, texto, extra = {}) => ({
  categoria,
  severidad,
  titulo,
  texto,
  ...extra,
});

/** El aviso que sale cuando una fuente se cae. Nunca es alarmante: es info. */
const avisoFuenteCaida = (categoria, nombre, err) =>
  aviso(
    categoria,
    'info',
    `No he podido consultar ${nombre}`,
    `La consulta falló (${err?.message ?? err}). Puedes reintentarlo con «Actualizar datos»; el resto de avisos sí están.`
  );

// =============================================================================
// GEOCODING — de qué sitio estamos hablando
// =============================================================================
/**
 * Nombre de ciudad -> { lat, lon, pais, codigoPais }.
 * Es el punto de partida: el clima necesita coordenadas, y las otras dos
 * fuentes necesitan el país.
 */
export async function situarDestino(destino) {
  const url =
    'https://geocoding-api.open-meteo.com/v1/search' +
    `?name=${encodeURIComponent(destino)}&count=1&language=es&format=json`;

  const datos = await pedir(url);
  const sitio = datos?.results?.[0];
  if (!sitio) throw new Error(`Open-Meteo no encuentra «${destino}»`);

  return {
    lat: sitio.latitude,
    lon: sitio.longitude,
    // Open-Meteo no siempre trae el nombre del país (Nuuk, por ejemplo, viene
    // solo con country_code "GL"). Sin nombre no se puede consultar Exteriores,
    // asi que lo dejamos en null y esa fuente se salta sola.
    pais: sitio.country ?? null,    // en español, porque pedimos language=es
    codigoPais: sitio.country_code, // ISO-2, p.ej. "PT"
    nombre: sitio.name,
  };
}

// =============================================================================
// 1. CLIMA — Open-Meteo
// =============================================================================
/**
 * UMBRALES. Están aquí arriba y sueltos a propósito: son un juicio, no una
 * verdad, y querrás cambiarlos. Se comparan contra la MEDIA de varios años
 * para esas mismas fechas, no contra un pronóstico.
 */
export const UMBRALES_CLIMA = {
  calorFuerte: 32,      // ºC de máxima media: por encima, aviso de calor
  frio: 5,              // ºC de mínima media: por debajo, aviso de frío
  lluviaFrecuente: 0.4, // proporción de días con lluvia: >40% del periodo
  mmParaContarComoLluvia: 1, // un día "de lluvia" es el que pasa de 1 mm
  anosDeHistorico: 5,   // cuántos años atrás promediamos
};

/**
 * Clima típico del destino en esas fechas.
 *
 * El viaje es futuro, así que no hay datos: lo que hacemos es mirar QUÉ PASÓ
 * esos mismos días en los últimos años y promediarlo. Son normales caseras,
 * pero salen de mediciones reales, no de un modelo.
 */
async function avisosDeClima(sitio, fechaInicio, fechaFin) {
  const anoViaje = Number(fechaInicio.slice(0, 4));
  const mmDia = [];
  const maximas = [];
  const minimas = [];
  let anosConDatos = 0;

  for (let i = 1; i <= UMBRALES_CLIMA.anosDeHistorico; i++) {
    const ano = anoViaje - i;
    const desde = `${ano}${fechaInicio.slice(4)}`;
    const hasta = `${ano}${fechaFin.slice(4)}`;

    const url =
      'https://archive-api.open-meteo.com/v1/archive' +
      `?latitude=${sitio.lat}&longitude=${sitio.lon}` +
      `&start_date=${desde}&end_date=${hasta}` +
      '&daily=temperature_2m_max,temperature_2m_min,precipitation_sum&timezone=auto';

    try {
      const d = await pedir(url);
      const max = d?.daily?.temperature_2m_max ?? [];
      const min = d?.daily?.temperature_2m_min ?? [];
      const lluvia = d?.daily?.precipitation_sum ?? [];
      if (!max.length) continue;

      maximas.push(...max.filter((v) => v != null));
      minimas.push(...min.filter((v) => v != null));
      mmDia.push(...lluvia.filter((v) => v != null));
      anosConDatos++;
    } catch {
      // Un año que falle no tumba el resto: seguimos con los demás.
    }
  }

  if (!anosConDatos) throw new Error('el archivo histórico no devolvió datos');

  const media = (xs) => xs.reduce((a, b) => a + b, 0) / xs.length;
  const maxMedia = media(maximas);
  const minMedia = media(minimas);
  const diasLluvia = mmDia.filter((mm) => mm >= UMBRALES_CLIMA.mmParaContarComoLluvia).length;
  const proporcionLluvia = mmDia.length ? diasLluvia / mmDia.length : 0;

  const avisos = [];
  const redondo = (n) => Math.round(n);

  if (maxMedia > UMBRALES_CLIMA.calorFuerte) {
    avisos.push(
      aviso('clima', 'precaucion', 'Va a hacer calor',
        `En esas fechas la máxima ronda los ${redondo(maxMedia)} °C de media (histórico de ${anosConDatos} años). ` +
        'Cuidado con las horas centrales y lleva agua encima.')
    );
  }
  if (minMedia < UMBRALES_CLIMA.frio) {
    avisos.push(
      aviso('clima', 'precaucion', 'Va a hacer frío',
        `Las mínimas bajan a unos ${redondo(minMedia)} °C de media (histórico de ${anosConDatos} años). ` +
        'Abrigo de verdad, no una chaqueta fina.')
    );
  }
  if (proporcionLluvia > UMBRALES_CLIMA.lluviaFrecuente) {
    avisos.push(
      aviso('clima', 'precaucion', 'Llueve a menudo en esas fechas',
        `Llovió en el ${Math.round(proporcionLluvia * 100)} % de esos días en los últimos ${anosConDatos} años. ` +
        'Mete chubasquero y ten un plan B bajo techo.')
    );
  }

  // Si no hay nada que avisar, se dice: un "todo bien" también es información.
  if (!avisos.length) {
    avisos.push(
      aviso('clima', 'info', 'Clima templado en esas fechas',
        `Máximas de unos ${redondo(maxMedia)} °C y mínimas de ${redondo(minMedia)} °C de media, ` +
        `y solo llovió el ${Math.round(proporcionLluvia * 100)} % de los días (histórico de ${anosConDatos} años).`)
    );
  }

  return avisos;
}

// =============================================================================
// 2. SEGURIDAD — Recomendaciones de viaje de Exteriores
// =============================================================================
const BASE_EXTERIORES =
  'https://www.exteriores.gob.es/es/ServiciosAlCiudadano/Paginas/Detalle-recomendaciones-de-viaje.aspx';

/** Quita etiquetas y deja texto legible. */
function aTextoPlano(html) {
  return html
    .replace(/<script[\s\S]*?<\/script>/gi, ' ')
    .replace(/<style[\s\S]*?<\/style>/gi, ' ')
    .replace(/<br\s*\/?>/gi, ' ')
    .replace(/<\/p>/gi, ' ')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&nbsp;|&#160;| |​/g, ' ')
    .replace(/&aacute;/gi, 'á').replace(/&eacute;/gi, 'é').replace(/&iacute;/gi, 'í')
    .replace(/&oacute;/gi, 'ó').replace(/&uacute;/gi, 'ú').replace(/&ntilde;/gi, 'ñ')
    .replace(/&amp;/gi, '&').replace(/&quot;/gi, '"').replace(/&#39;/gi, "'")
    .replace(/\s+/g, ' ')
    .trim();
}

/** Se queda con las primeras N frases de un texto. */
function primerasFrases(texto, n = 3) {
  const frases = texto.split(/(?<=[.!?])\s+/).filter((f) => f.trim().length > 20);
  return frases.slice(0, n).join(' ');
}

/**
 * Aviso de seguridad a partir de la ficha del país en Exteriores.
 *
 * LA RECETA: la URL es
 *   .../Detalle-recomendaciones-de-viaje.aspx?trc=<País en español>
 * con los espacios como "+" (así aparecen en su propio listado de 197 países).
 *
 * La ficha es un acordeón de secciones. Cada una es un
 *   <h3 class="accordion__main">Seguridad</h3>
 * seguido del contenido. Para no pelearme contando <div> anidados, cojo el
 * trozo de HTML que va DESDE ese encabezado HASTA el siguiente
 * "accordion__main", y lo limpio de etiquetas.
 *
 * (Comprobado el 05/09/2026 con Portugal: la sección Seguridad empieza por
 *  "Condiciones semejantes a las de España. Se advierte a los ciudadanos...".)
 */
async function avisosDeSeguridad(sitio) {
  // España no tiene ficha propia: es el país desde el que se viaja.
  if (sitio.codigoPais === 'ES') return [];

  // Sin nombre de país no hay ficha que pedir (la URL de Exteriores va por
  // nombre, no por código). Callarse es más honesto que decir "no he podido".
  if (!sitio.pais) return [];

  const paisUrl = encodeURIComponent(sitio.pais).replace(/%20/g, '+');
  const url = `${BASE_EXTERIORES}?trc=${paisUrl}`;

  const html = await pedir(url, { comoTexto: true });

  // Recorte de la sección "Seguridad".
  // OJO con el HTML real: el atributo va SIN comillas (class=accordion__main)
  // y dentro del h3 hay un <span> con la flechita del acordeón. Un patrón
  // estricto tipo class="..." y >Seguridad</h3> no casa con nada.
  const inicio = html.search(/<h3[^>]*accordion__main[^>]*>\s*Seguridad\b/i);
  if (inicio === -1) {
    throw new Error(`la ficha de ${sitio.pais} no trae sección "Seguridad"`);
  }
  const resto = html.slice(inicio);
  const siguiente = resto.slice(1).search(/<h3[^>]*accordion__main/i);
  const trozo = siguiente === -1 ? resto : resto.slice(0, siguiente + 1);

  const texto = aTextoPlano(trozo).replace(/^\s*Seguridad\s*/i, '');
  if (texto.length < 40) throw new Error(`la sección "Seguridad" de ${sitio.pais} vino vacía`);

  // La severidad sale de lo que dice el propio texto oficial.
  const enMinusculas = texto.toLowerCase();
  let severidad = 'info';
  // Ojo con las variantes: el texto oficial dice tanto 'se recomienda precaución'
  // como 'deberán tomar precauciones', y con tilde o sin ella segun la pagina.
  if (/desaconseja/.test(enMinusculas)) severidad = 'alerta';
  else if (/precauci[oó]n|precauciones|extrem[ae]/.test(enMinusculas)) severidad = 'precaucion';

  return [
    aviso('seguridad', severidad, `Seguridad en ${sitio.pais}`, primerasFrases(texto, 3), {
      url,
      textoEnlace: 'Leer recomendación completa',
      fuente: 'Ministerio de Asuntos Exteriores',
    }),
  ];
}

// =============================================================================
// 3. FESTIVOS — Nager.Date
// =============================================================================
/** "2026-09-15" -> "15/09" */
const aDiaMes = (iso) => `${iso.slice(8, 10)}/${iso.slice(5, 7)}`;

/**
 * Festivos NACIONALES que caen dentro de las fechas del viaje.
 * Solo los de tipo "Public" y globales: los autonómicos o los opcionales
 * (tipo Carnaval en Portugal) llenarían la pantalla sin aportar gran cosa.
 */
async function avisosDeFestivos(sitio, fechaInicio, fechaFin) {
  const anos = [...new Set([fechaInicio.slice(0, 4), fechaFin.slice(0, 4)])];
  const festivos = [];

  for (const ano of anos) {
    const url = `https://date.nager.at/api/v3/PublicHolidays/${ano}/${sitio.codigoPais}`;
    const lista = await pedir(url);
    // null = país sin datos en Nager. Se queda sin avisos de festivos y ya:
    // mejor no decir nada que inventarse un aviso de "no he podido".
    festivos.push(...(Array.isArray(lista) ? lista : []));
  }

  return festivos
    .filter((f) => f.global && (f.types ?? []).includes('Public'))
    .filter((f) => f.date >= fechaInicio && f.date <= fechaFin)
    .map((f) =>
      aviso('festivos', 'info', `${aDiaMes(f.date)}: ${f.localName}`,
        `El ${aDiaMes(f.date)} es festivo nacional en ${sitio.pais} (${f.localName}). ` +
        'Museos y comercios pueden cerrar o llenarse, y el transporte suele ir en horario reducido.')
    );
}

// =============================================================================
// FUNCIÓN PÚBLICA
// =============================================================================
/**
 * Todos los avisos de un viaje. Cada fuente va por su cuenta: si una se cae,
 * deja su propio aviso de "no he podido consultarla" y las demás siguen.
 */
export async function reunirAvisos({ destino, fechaInicio, fechaFin }) {
  const avisos = [];

  // El geocoding es el único imprescindible: sin país ni coordenadas no hay
  // nada que consultar en ninguna de las tres fuentes.
  let sitio;
  try {
    sitio = await situarDestino(destino);
  } catch (err) {
    throw new Error(
      `No he podido situar «${destino}» en el mapa (${err.message}). ` +
        'Prueba con el nombre de la ciudad tal cual, sin el país.'
    );
  }

  const fuentes = [
    { categoria: 'clima', nombre: 'el clima (Open-Meteo)', fn: () => avisosDeClima(sitio, fechaInicio, fechaFin) },
    { categoria: 'seguridad', nombre: 'las recomendaciones de Exteriores', fn: () => avisosDeSeguridad(sitio) },
    { categoria: 'festivos', nombre: 'los festivos (Nager.Date)', fn: () => avisosDeFestivos(sitio, fechaInicio, fechaFin) },
  ];

  for (const fuente of fuentes) {
    try {
      avisos.push(...(await fuente.fn()));
    } catch (err) {
      console.warn(`[avisos] falló ${fuente.categoria}: ${err.message}`);
      avisos.push(avisoFuenteCaida(fuente.categoria, fuente.nombre, err));
    }
  }

  return { sitio, avisos };
}

export default { reunirAvisos, situarDestino, UMBRALES_CLIMA };
