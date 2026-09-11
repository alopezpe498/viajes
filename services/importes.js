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
