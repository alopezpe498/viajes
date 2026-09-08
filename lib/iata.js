/**
 * lib/iata.js
 * -----------------------------------------------------------------------------
 * Mapa de ciudad -> codigo IATA, para poder pasarle a Kayak un destino que
 * entienda a partir del nombre que escribiste en el paso 2.
 *
 * OJO, DETALLE IMPORTANTE: son codigos de CIUDAD, no de aeropuerto.
 *   PAR = todos los aeropuertos de Paris (CDG + ORY + BVA)
 *   LON = todos los de Londres (LHR + LGW + STN + LTN + LCY + SEN)
 *   ROM = Fiumicino + Ciampino
 * Es lo que quieres en un buscador: que compare todas las opciones de la ciudad
 * y no solo las de una terminal concreta. Si algun dia quieres forzar un
 * aeropuerto en particular, pon aqui su codigo (CDG en vez de PAR).
 *
 * Cuando una ciudad tiene un unico aeropuerto, el codigo de ciudad y el de
 * aeropuerto coinciden (LIS, BER, PRG...), asi que no hay nada que elegir.
 *
 * YA NO HAY QUE AMPLIARLA A MANO. La lista de abajo es la semilla —correcta,
 * gratis y sin red—, pero lo que no este se resuelve solo con la IA y se
 * guarda en la tabla `iata_ciudades`. El orden es: cache, lista, IA. La cache
 * va primero para que una correccion escrita a mano en la tabla mande sobre
 * todo lo demas.
 *
 * Antes, si la ciudad no estaba aqui, la busqueda de vuelos moria con un
 * "añadelo a lib/iata.js": pedirle a alguien que edite codigo fuente para
 * buscar un vuelo a Cadiz. Y Cadiz es justo el caso: no tiene aeropuerto, hay
 * que saber que le toca Jerez (XRY), y eso una lista escrita a mano no lo
 * adivina.
 */

import { una, ejecutar } from '../db/index.js';
import { consultarJSON, hayClaveIA } from './ia.js';

/** Quita acentos y pasa a minusculas, para que "París" y "paris" sean lo mismo. */
export function normalizarCiudad(nombre) {
  return String(nombre ?? '')
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .trim()
    .replace(/\s+/g, ' ');
}

/**
 * Destinos habituales desde España. Ordenados por zonas para que sea comodo
 * añadir mas.
 */
const CIUDADES = {
  // --- España ---------------------------------------------------------------
  'madrid': 'MAD',
  'barcelona': 'BCN',
  'valencia': 'VLC',
  'sevilla': 'SVQ',
  'malaga': 'AGP',
  'bilbao': 'BIO',
  'oviedo': 'OVD',
  'asturias': 'OVD',
  'santiago de compostela': 'SCQ',
  'vigo': 'VGO',
  'a coruna': 'LCG',
  'alicante': 'ALC',
  'palma de mallorca': 'PMI',
  'mallorca': 'PMI',
  'ibiza': 'IBZ',
  'menorca': 'MAH',
  'tenerife': 'TCI',      // codigo de ciudad: Norte + Sur
  'las palmas': 'LPA',
  'gran canaria': 'LPA',
  'lanzarote': 'ACE',
  'fuerteventura': 'FUE',
  'granada': 'GRX',
  'zaragoza': 'ZAZ',
  'santander': 'SDR',
  'san sebastian': 'EAS',

  // --- Europa ---------------------------------------------------------------
  'paris': 'PAR',
  'londres': 'LON',
  'roma': 'ROM',
  'milan': 'MIL',
  'venecia': 'VCE',
  'florencia': 'FLR',
  'napoles': 'NAP',
  'lisboa': 'LIS',
  'oporto': 'OPO',
  'porto': 'OPO',
  'berlin': 'BER',
  'munich': 'MUC',
  'frankfurt': 'FRA',
  'hamburgo': 'HAM',
  'amsterdam': 'AMS',
  'bruselas': 'BRU',
  'viena': 'VIE',
  'praga': 'PRG',
  'budapest': 'BUD',
  'varsovia': 'WAW',
  'cracovia': 'KRK',
  'copenhague': 'CPH',
  'estocolmo': 'STO',
  'oslo': 'OSL',
  'helsinki': 'HEL',
  'dublin': 'DUB',
  'edimburgo': 'EDI',
  'zurich': 'ZRH',
  'ginebra': 'GVA',
  'atenas': 'ATH',
  'estambul': 'IST',
  'reikiavik': 'REK',
  'bucarest': 'BUH',
  'sofia': 'SOF',
  'zagreb': 'ZAG',
  'dubrovnik': 'DBV',
  'split': 'SPU',
  'malta': 'MLA',

  // --- Resto del mundo ------------------------------------------------------
  'nueva york': 'NYC',
  'new york': 'NYC',
  'los angeles': 'LAX',
  'chicago': 'CHI',
  'miami': 'MIA',
  'san francisco': 'SFO',
  'boston': 'BOS',
  'washington': 'WAS',
  'toronto': 'YTO',
  'ciudad de mexico': 'MEX',
  'mexico': 'MEX',
  'cancun': 'CUN',
  'la habana': 'HAV',
  'buenos aires': 'BUE',
  'sao paulo': 'SAO',
  'rio de janeiro': 'RIO',
  'bogota': 'BOG',
  'lima': 'LIM',
  'santiago de chile': 'SCL',
  'tokio': 'TYO',
  'osaka': 'OSA',
  'pekin': 'BJS',
  'shanghai': 'SHA',
  'hong kong': 'HKG',
  'bangkok': 'BKK',
  'singapur': 'SIN',
  'dubai': 'DXB',
  'doha': 'DOH',
  'delhi': 'DEL',
  'bombay': 'BOM',
  'seul': 'SEL',
  'sidney': 'SYD',
  'melbourne': 'MEL',
  'marrakech': 'RAK',
  'casablanca': 'CAS',
  'el cairo': 'CAI',
  'ciudad del cabo': 'CPT',
  'johannesburgo': 'JNB',
  'nairobi': 'NBO',
  'tel aviv': 'TLV',
};

/**
 * Devuelve el codigo IATA de una ciudad, o null si no la conocemos.
 * Si te pasan ya un codigo de 3 letras ("LIS"), lo acepta tal cual.
 */
export function iataDe(destino) {
  const bruto = String(destino ?? '').trim();
  if (!bruto) return null;

  // Si ya es un codigo de 3 letras, nos lo creemos.
  if (/^[A-Za-z]{3}$/.test(bruto)) return bruto.toUpperCase();

  return CIUDADES[normalizarCiudad(bruto)] ?? null;
}

/** Cuantas ciudades trae la semilla. Util para el README y para pruebas. */
export const TOTAL_CIUDADES = Object.keys(CIUDADES).length;

// =============================================================================
// RESOLVER UN CODIGO QUE NO ESTA EN LA LISTA
// =============================================================================

/** Lo que la cache sepa de esta ciudad, o null si no la ha visto nunca. */
function deLaCache(norm) {
  return una('SELECT * FROM iata_ciudades WHERE ciudad_norm = ?', norm) ?? null;
}

function guardarEnCache(norm, ciudad, codigo, { aeropuerto = null, origen = 'ia' } = {}) {
  ejecutar(
    `INSERT INTO iata_ciudades (ciudad_norm, ciudad, codigo, aeropuerto, origen, buscado_en)
     VALUES (?, ?, ?, ?, ?, datetime('now'))
     ON CONFLICT (ciudad_norm) DO UPDATE SET
       codigo     = excluded.codigo,
       aeropuerto = excluded.aeropuerto,
       origen     = excluded.origen,
       buscado_en = excluded.buscado_en`,
    norm,
    ciudad,
    codigo,
    aeropuerto,
    origen
  );
}

/**
 * Le pregunta a la IA por el codigo de una ciudad.
 *
 * Se pide el codigo de CIUDAD cuando existe (PAR, LON, ROM: agrupan todos los
 * aeropuertos y es lo que quieres en un buscador), y el del aeropuerto que
 * sirve a esa ciudad cuando la ciudad no tiene el suyo. Ese segundo caso es el
 * que importa de verdad: Cadiz no tiene aeropuerto y hay que saber que se vuela
 * a Jerez.
 *
 * Devuelve null si no lo sabe o si contesta cualquier cosa. Nunca inventa: un
 * codigo mal puesto manda a buscar vuelos a otro continente sin decir nada.
 */
async function preguntarALaIA(ciudad) {
  if (!hayClaveIA()) return null;

  const prompt = [
    `¿Qué código IATA se usa para buscar vuelos a «${ciudad}»?`,
    '',
    'Reglas:',
    '- Si la ciudad tiene código de CIUDAD (agrupa varios aeropuertos), usa ese:',
    '  París=PAR, Londres=LON, Roma=ROM, Milán=MIL, Nueva York=NYC.',
    '- Si no, el código del aeropuerto principal de la ciudad.',
    '- Si la ciudad NO tiene aeropuerto, el del aeropuerto más cercano que la',
    '  sirva de verdad. Ejemplo: Cádiz se vuela por Jerez, que es XRY.',
    '- Si no estás seguro, devuelve null. No inventes: un código equivocado',
    '  manda a buscar vuelos a otro sitio sin avisar.',
    '',
    'Responde SOLO este JSON:',
    '{"codigo": "XRY", "aeropuerto": "Jerez de la Frontera", "seguro": true}',
    'o {"codigo": null, "aeropuerto": null, "seguro": false}',
  ].join(`
`);

  try {
    const r = await consultarJSON(prompt, { maxTokens: 300, paso: 'resolver el código IATA' });
    const codigo = String(r?.codigo ?? '').trim().toUpperCase();
    if (!/^[A-Z]{3}$/.test(codigo)) return null;
    if (r?.seguro === false) return null;
    return { codigo, aeropuerto: r?.aeropuerto ? String(r.aeropuerto).trim() : null };
  } catch (err) {
    console.warn(`[iata] No pude resolver «${ciudad}» con la IA: ${err.message}`);
    return null;
  }
}

/**
 * EL CODIGO IATA DE UNA CIUDAD, VENGA DE DONDE VENGA.
 *
 * Cache -> lista de siempre -> IA. Lo que se aprende se guarda, asi que cada
 * ciudad se pregunta UNA vez en la vida de esta base de datos.
 *
 * Tambien se guardan los "no lo se" (codigo NULL): sin eso, una ciudad sin
 * aeropuerto haria una llamada a la IA en cada reintento de la busqueda.
 */
export async function resolverIata(destino) {
  const bruto = String(destino ?? '').trim();
  if (!bruto) return null;

  // Un codigo de tres letras ya escrito se acepta tal cual, como siempre.
  if (/^[A-Za-z]{3}$/.test(bruto)) return bruto.toUpperCase();

  const norm = normalizarCiudad(bruto);

  const guardado = deLaCache(norm);
  if (guardado) return guardado.codigo ?? null;

  const deLaLista = CIUDADES[norm];
  if (deLaLista) {
    guardarEnCache(norm, bruto, deLaLista, { origen: 'lista' });
    return deLaLista;
  }

  console.log(`[iata] «${bruto}» no está en la lista: se lo pregunto a la IA.`);
  const resuelto = await preguntarALaIA(bruto);

  guardarEnCache(norm, bruto, resuelto?.codigo ?? null, {
    aeropuerto: resuelto?.aeropuerto ?? null,
    origen: 'ia',
  });

  if (resuelto) {
    console.log(
      `[iata] «${bruto}» → ${resuelto.codigo}` +
        (resuelto.aeropuerto ? ` (${resuelto.aeropuerto})` : '') +
        ' · guardado, no se vuelve a preguntar.'
    );
  } else {
    console.warn(`[iata] No hay código para «${bruto}». Queda apuntado como desconocido.`);
  }

  return resuelto?.codigo ?? null;
}

/** Olvida lo que se sepa de una ciudad, para poder volver a preguntarlo. */
export function olvidarIata(destino) {
  return ejecutar(
    'DELETE FROM iata_ciudades WHERE ciudad_norm = ?',
    normalizarCiudad(destino)
  ).changes;
}

export default { iataDe, resolverIata, olvidarIata, normalizarCiudad, TOTAL_CIUDADES };
