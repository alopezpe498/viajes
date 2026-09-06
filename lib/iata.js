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
 * PARA AMPLIAR: añade la linea y ya esta. La clave se normaliza sola
 * (minusculas y sin acentos), asi que da igual como lo escribas aqui.
 */

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

/** Cuantas ciudades conocemos. Util para el README y para pruebas. */
export const TOTAL_CIUDADES = Object.keys(CIUDADES).length;

export default { iataDe, normalizarCiudad, TOTAL_CIUDADES };
