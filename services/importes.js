/**
 * services/importes.js
 * -----------------------------------------------------------------------------
 * LEER UN PRECIO ESCRITO POR OTRO.
 *
 * EL FALLO QUE ORIGINA ESTE FICHERO. En el viaje por Asia, los hoteles salían a
 * precios de risa: categoría alta por lo que cuesta un menú del día. No era la
 * conversión de moneda ni el precio por persona. Era esto:
 *
 *     "THB 4,500"  →  4.5
 *     "JPY 28,000" →  28
 *     "$1,234.56"  →  1.234
 *     "MYR 450.00" →  45000
 *
 * El lector de precios daba por hecho el formato europeo —el punto separa miles
 * y la coma decimales— y hacía `replace('.', '')` seguido de `replace(',', '.')`.
 * Con "€ 1.138" eso funciona. Con "4,500" baht convierte cuatro mil quinientos
 * en cuatro y medio, y nadie mira dos veces un hotel barato.
 *
 * LA REGLA QUE LO ARREGLA, y no hace falta saber de qué país viene el número:
 * el separador DECIMAL es el último que aparece, y solo lo es si detrás quedan
 * una o dos cifras. Tres cifras detrás es un separador de miles, venga con punto
 * o con coma. Con eso «4,500» y «4.500» son los dos cuatro mil quinientos, y
 * «45,50» y «45.50» son los dos cuarenta y cinco con cincuenta, que es
 * exactamente como lo leería una persona.
 *
 * Y LA MONEDA NO SE CONVIERTE AQUÍ. No hay fuente de tipos de cambio en esta
 * casa y no se va a inventar una: un precio en moneda local se devuelve DICIENDO
 * en qué moneda está, y quien lo enseñe decide si puede fiarse. Un número sin
 * moneda tratado como euros es la otra mitad de este mismo fallo.
 */

/** Lo que se reconoce, por símbolo y por código. */
const MONEDAS = {
  '€': 'EUR', $: 'USD', '£': 'GBP', '¥': 'JPY', '₩': 'KRW', '₫': 'VND',
  '₹': 'INR', '฿': 'THB', '₱': 'PHP', '₽': 'RUB', '₪': 'ILS', '₺': 'TRY', 'zł': 'PLN',
};

const CODIGOS = [
  'EUR', 'USD', 'GBP', 'JPY', 'CNY', 'KRW', 'THB', 'VND', 'IDR', 'MYR', 'SGD',
  'INR', 'PHP', 'HKD', 'TWD', 'AED', 'CHF', 'SEK', 'NOK', 'DKK', 'PLN', 'CZK',
  'HUF', 'RON', 'BGN', 'TRY', 'ILS', 'MAD', 'EGP', 'ZAR', 'AUD', 'NZD', 'CAD',
  'MXN', 'BRL', 'ARS', 'CLP', 'COP', 'PEN', 'RUB', 'UAH', 'RSD', 'HRK', 'ISK',
];

/**
 * EL NÚMERO DE UN TEXTO DE PRECIO, sin suponer de qué país viene.
 *
 * Devuelve null cuando no hay ningún número: un hueco es una respuesta legítima
 * y un cero inventado no lo es.
 */
export function importeDeTexto(texto) {
  const t = String(texto ?? '');
  if (!t.trim()) return null;

  // El primer grupo de cifras con sus separadores. Se coge el más largo de los
  // que empiezan antes: "3 noches, 2 adultos · € 1.138" tiene varios números y
  // el que interesa es el que va con la moneda, pero quien llama ya recorta el
  // texto al trozo del precio, así que el primero vale.
  const m = /\d[\d.,\s ']*\d|\d/.exec(t);
  if (!m) return null;

  // Los separadores de millar «invisibles» —espacio fino, apóstrofo suizo— no
  // dicen nada y estorban: fuera antes de decidir.
  const crudo = m[0].replace(/[\s ']/g, '');

  const ultimoPunto = crudo.lastIndexOf('.');
  const ultimaComa = crudo.lastIndexOf(',');
  const corte = Math.max(ultimoPunto, ultimaComa);

  let entero = crudo;
  let decimales = '';

  if (corte !== -1) {
    const detras = crudo.length - corte - 1;
    // Una o dos cifras detrás: es el separador decimal. Tres (o más, o
    // ninguna): es de millar y el número es entero.
    if (detras === 1 || detras === 2) {
      entero = crudo.slice(0, corte);
      decimales = crudo.slice(corte + 1);
    }
  }

  const n = Number(`${entero.replace(/[.,]/g, '')}.${decimales || '0'}`);
  return Number.isFinite(n) ? n : null;
}

/**
 * LA MONEDA MÁS CERCANA AL PRINCIPIO DEL TEXTO, no la primera de la lista.
 *
 * `monedaDeTexto` recorre los códigos en el orden en que están escritos, y para
 * su pregunta —«¿de qué moneda habla esto?»— vale. Para la de `precioConMoneda`
 * —«¿en qué está ESTE número?»— no: en «desde 7 € / 8 USD» el dólar aparece más
 * tarde pero gana, porque «USD» está antes que el símbolo «€» en la lista. Y
 * entonces siete euros se leen como siete dólares.
 *
 * Aquí manda la POSICIÓN: lo que esté pegado al número es lo suyo.
 */
function monedaMasCercana(texto) {
  const t = String(texto ?? '');
  let mejor = null;

  for (const codigo of CODIGOS) {
    const m = new RegExp(`\\b${codigo}\\b`, 'i').exec(t);
    if (m && (mejor == null || m.index < mejor.donde)) mejor = { donde: m.index, codigo };
  }
  for (const [simbolo, codigo] of Object.entries(MONEDAS)) {
    const donde = t.indexOf(simbolo);
    if (donde >= 0 && (mejor == null || donde < mejor.donde)) mejor = { donde, codigo };
  }
  return mejor?.codigo ?? null;
}

/** El código de moneda que nombra un texto, o null. */
export function monedaDeTexto(texto) {
  const t = String(texto ?? '');
  if (!t.trim()) return null;

  for (const codigo of CODIGOS) {
    if (new RegExp(`\\b${codigo}\\b`, 'i').test(t)) return codigo;
  }
  for (const [simbolo, codigo] of Object.entries(MONEDAS)) {
    if (t.includes(simbolo)) return codigo;
  }
  return null;
}

/**
 * EL PRECIO DE UN TEXTO: cuánto y en qué.
 *
 * `enEuros` es el campo con el que se puede hacer aritmética, y solo se rellena
 * cuando de verdad son euros. Si el precio viene en bats, `importe` trae 4500 y
 * `enEuros` viene a null: que el que sume decida, en vez de sumar bats como si
 * fueran euros, que es lo que pasaba.
 */
export function precioDeTexto(texto) {
  const importe = importeDeTexto(texto);
  if (importe == null) return null;

  const moneda = monedaDeTexto(texto);
  return {
    importe,
    moneda,
    enEuros: moneda === 'EUR' || moneda === null ? importe : null,
    texto: String(texto).trim(),
  };
}

/**
 * LO QUE VALE CADA MONEDA EN EUROS. FIJAS Y FECHADAS: septiembre de 2026.
 *
 * ESTO NO EXISTÍA A PROPÓSITO, y el comentario de `services/presupuesto.js` lo
 * dice: «No hay tabla de cambio en esta casa y no se va a inventar una». Sigue
 * valiendo PARA EL PRESUPUESTO, que es dinero que se va a pagar: ahí un precio en
 * bats no se suma, se deja fuera del total y se dice.
 *
 * Nace ahora para otra cosa: para PODER COMPARAR. La regla del ahorro grande
 * tiene que decidir si un tren en zlotys es cuatro veces más barato que un taxi
 * en euros, y sin una escala común esa pregunta no se puede ni formular. Para eso
 * sobra el orden de magnitud, y una llamada de red en vivo sería una dependencia
 * nueva y un modo de fallo nuevo a cambio de decimales que no cambian ninguna
 * decisión.
 *
 * LA CONTRAPARTIDA ES INNEGOCIABLE: todo número que salga de aquí se enseña con
 * «≈» y diciendo de qué moneda viene. Un euro sacado de una tasa de hace meses no
 * es un precio consultado, y hacerlo pasar por uno es el pecado que ya se pagó
 * con los 176 €.
 *
 * Solo están las monedas de los sitios a los que de verdad se viaja desde aquí.
 * El zloty va primero por algo: Polonia es el viaje de la casa y el PLN es la
 * moneda que más aparece en el catálogo de traslados.
 */
export const A_EURO_FECHA = 'septiembre de 2026';
export const A_EURO = {
  EUR: 1,
  PLN: 0.23,   // ~4,35 zl/EUR
  USD: 0.92,   // ~1,09 USD/EUR
  GBP: 1.17,
  CHF: 1.06,
  CZK: 0.040,  // ~25 Kc/EUR
  HUF: 0.0025, // ~400 Ft/EUR
  RON: 0.20,
  SEK: 0.088,
  NOK: 0.086,
  DKK: 0.134,
};

/**
 * EL PRECIO Y LA MONEDA QUE LE CORRESPONDE A ESE NÚMERO EN CONCRETO.
 *
 * EL FALLO QUE ORIGINA ESTO. En el catálogo de traslados estaba esto:
 *
 *     "Alquiler: 15-30 USD/día + 80 EUR/90 USD tasa retorno one-way; ..."
 *
 * y el lector de la fase de traslados devolvía 15. Quince EUROS. Su guarda solo
 * miraba si había una moneda PEGADA al número —así bloqueaba "40 PLN"— y en un
 * RANGO la moneda va detrás del SEGUNDO número: "15-30 USD" colaba entero. Un
 * alquiler de quince dólares compitiendo en la regla del ahorro grande contra
 * billetes que sí eran euros.
 *
 * Y al revés también fallaba: "49 PLN (aprox. 11-13 USD) anticipado" no tiene un
 * solo euro en todo el texto, así que devolvía null y ese precio de PKP se tiraba
 * a la basura teniéndolo escrito delante.
 *
 * POR QUÉ NO VALE `precioDeTexto` PARA ESTO. Aquélla contesta «qué monedas nombra
 * este texto», y en un texto con tres monedas eso no dice cuál es la del precio.
 * Ésta contesta otra pregunta: «el primer número que aparece, ¿en qué está?». Se
 * coge el primero porque es el que la fuente pone de titular —lo que viene detrás
 * son suplementos, tasas y precios de última hora— y se busca su moneda saltando
 * por encima del resto de SU rango, que es donde se escondía.
 *
 * El vocabulario de monedas no se duplica: lo pone `monedaDeTexto`, aplicado a la
 * ventana de texto que rodea a ese número y no al texto entero.
 */
export function precioConMoneda(texto) {
  const t = String(texto ?? '');

  // El número entero, no un trozo suyo: sin los bordes, al descartar "40 PLN" el
  // buscador se quedaba con el "0" de al lado y devolvía 4.
  const m = /(?<![\d.,])(\d+(?:[.,]\d+)?)(?![\d.,])/.exec(t);
  if (!m) return null;

  const importe = importeDeTexto(m[1]);
  if (importe == null || importe <= 0) return null;

  // Se salta el resto del rango —"-30", "– 70", " a 44"— para llegar a la moneda.
  const trasElRango = t
    .slice(m.index + m[0].length)
    .replace(/^\s*(?:[-–—]|a|al|to|hasta|y)?\s*\d+(?:[.,]\d+)?/, '');
  // Un símbolo pegado por delante también cuenta: "$41", "€12".
  const ventana = `${t.slice(Math.max(0, m.index - 2), m.index)} ${trasElRango.slice(0, 14)}`;

  const moneda = monedaMasCercana(ventana);

  // SIN MONEDA NO HAY NÚMERO. Un "45 - 70" pelado puede ser cualquier cosa, y
  // adivinar cuál es justo lo que se está arreglando.
  if (!moneda || !A_EURO[moneda]) return null;

  return {
    importe,
    moneda,
    // Lo que se compara y lo que se enseña, siempre en euros.
    euros: moneda === 'EUR' ? importe : importe * A_EURO[moneda],
    // Y si ha salido de la tabla, lo dice: quien lo pinte le pone el «≈».
    aproximado: moneda !== 'EUR',
    tasaDe: moneda === 'EUR' ? null : A_EURO_FECHA,
  };
}
