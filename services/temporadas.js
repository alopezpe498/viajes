/**
 * services/temporadas.js
 * -----------------------------------------------------------------------------
 * COSAS QUE NO EXISTEN EN LAS FECHAS DEL VIAJE.
 *
 * EL CASO QUE ORIGINA ESTE FICHERO. Para un viaje a Polonia del 21 al 27 de
 * septiembre se preseleccionó y se colocó «Zakopane y baños termales + Paseo en
 * moto de nieve». En septiembre, en los Tatras, no hay nieve: esa excursión o no
 * opera esos días o opera sin la moto, que es la mitad de por qué la eliges.
 *
 * POR QUÉ ESTO NO VA EN EL PROMPT. Podría pedírsele a la IA que «no proponga
 * actividades fuera de temporada», y lo haría casi siempre. Casi. Una lista de
 * términos y meses es una tabla: se lee igual cada vez, se puede probar con
 * casos y se corrige en un sitio. Un prompt no se puede probar.
 *
 * Y LO DUDOSO NO SE TIRA. Hay actividades que llevan «hielo» en el nombre y
 * funcionan todo el año —una pista cubierta, una cueva de hielo—. Descartar de
 * más también estropea un viaje.
 *
 * LO QUE ENSEÑÓ POLONIA, Y POR QUÉ ESTO SE MIRA SOLO EN EL TÍTULO. La tabla se
 * aplicaba sobre el título MÁS la descripción larga, que es una página de
 * Civitatis scrapeada entera: reseñas de usuarios, nombres de bares, topónimos.
 * Ahí dentro «belen» casó con «Ana Belén, Alicante» —una reseñista— y descartó
 * la excursión a Auschwitz-Birkenau por ser de Navidad. Y «ski», con
 * «Zakaski u Ani», «Karski» y «staromiejskie», se llevó tres free tours por
 * falta de nieve en septiembre.
 *
 * Medido sobre el catálogo: de 5 coincidencias, 4 eran falsas y todas duras. La
 * única buena tenía la palabra en el TÍTULO. Así que se mira el título, se exige
 * palabra entera, y sin un dato real de temporada no se descarta nada.
 */

/**
 * LA TABLA. Cada entrada: qué palabras la delatan y en qué meses existe.
 *
 * `meses` son los del hemisferio norte, que es donde se viaja aquí. `duro` dice
 * si estar fuera de temporada es motivo para descartar (una moto de nieve sin
 * nieve no es una actividad distinta: no la hay) o solo para avisar.
 */
export const TEMPORADAS = [
  {
    que: 'nieve',
    palabras: ['moto de nieve', 'motonieve', 'snowmobile', 'trineo', 'husky', 'perros de trineo',
               'raquetas de nieve', 'snowshoe', 'esqui', 'esquí', 'ski', 'snowboard',
               'estacion de esqui', 'estación de esquí', 'freeride', 'heliski'],
    meses: [12, 1, 2, 3],
    duro: true,
    porQue: 'hace falta nieve',
  },
  {
    que: 'hielo al aire libre',
    palabras: ['patinaje sobre hielo', 'pista de hielo', 'ice skating', 'hotel de hielo',
               'iglu', 'iglú', 'aurora boreal', 'northern lights'],
    meses: [11, 12, 1, 2, 3],
    duro: false,
    porQue: 'depende del frío y de las noches largas',
  },
  {
    que: 'navidad',
    palabras: ['mercadillo navideno', 'mercadillo navideño', 'mercado de navidad',
               'christmas market', 'weihnachtsmarkt', 'belen', 'belén viviente', 'nochevieja',
               'cotillon', 'cotillón'],
    meses: [11, 12, 1],
    duro: true,
    porQue: 'solo se monta en Navidad',
  },
  {
    que: 'baño y playa',
    palabras: ['bano en el mar', 'baño en el mar', 'playa y snorkel', 'snorkel',
               'kayak de mar', 'paddle surf', 'banana boat', 'chiringuito'],
    meses: [5, 6, 7, 8, 9, 10],
    duro: false,
    porQue: 'en invierno el agua no acompaña',
  },
  {
    que: 'flor',
    palabras: ['cerezos en flor', 'hanami', 'lavanda en flor', 'campos de lavanda',
               'tulipanes', 'keukenhof'],
    meses: [3, 4, 5, 6, 7],
    duro: false,
    porQue: 'la floración dura unas semanas',
  },
  {
    que: 'vendimia',
    palabras: ['vendimia', 'grape harvest', 'oktoberfest'],
    meses: [8, 9, 10],
    duro: false,
    porQue: 'va con la cosecha',
  },
];

/** Sin acentos y en minúsculas, para poder comparar. */
function normalizar(texto) {
  return String(texto ?? '')
    .toLowerCase()
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '');
}

/** Los meses que toca un viaje entre dos fechas «YYYY-MM-DD». */
export function mesesDelViaje(desde, hasta) {
  const a = new Date(`${desde}T12:00:00`);
  const b = new Date(`${hasta ?? desde}T12:00:00`);
  if (Number.isNaN(a.getTime())) return [];

  const meses = new Set();
  const cursor = new Date(a);
  // Un viaje no dura más de unos meses; el tope evita un bucle infinito con
  // fechas corruptas, que es la clase de dato que llega de fuera.
  for (let i = 0; i < 400 && cursor <= (Number.isNaN(b.getTime()) ? a : b); i += 1) {
    meses.add(cursor.getMonth() + 1);
    cursor.setDate(cursor.getDate() + 1);
  }
  return [...meses];
}

/**
 * ¿ESTA ACTIVIDAD EXISTE EN ESTAS FECHAS?
 *
 * Devuelve null cuando nada la delata —que es lo normal— o el veredicto cuando
 * sí: `{ que, duro, porQue, meses }`.
 *
 * `fechasPropias` es lo que diga la ficha si lo dice: si Civitatis publicara la
 * temporada de operación, manda sobre esta tabla. Hoy no la publica en la parte
 * estable de la página —la enseña en el calendario de reserva, después de elegir
 * día— así que casi siempre llega vacío.
 */
export function fueraDeTemporada({ titulo, fechasPropias = null, meses }) {
  const t = normalizar(titulo);
  if (!t.trim() || !meses?.length) return null;

  const encontrada = TEMPORADAS.find((x) => x.palabras.some((p) => diceLaPalabra(t, p)));
  if (!encontrada) return null;

  // LO QUE DIGA LA FICHA MANDA SOBRE LA TABLA.
  const suyos = mesesDeTexto(fechasPropias);
  const temporada = suyos?.length ? suyos : encontrada.meses;

  const dentro = meses.some((m) => temporada.includes(m));
  if (dentro) return null;

  return {
    que: encontrada.que,
    // DESCARTAR SOLO CON UN DATO DE VERDAD.
    //
    // `duro` significa «esto no se coloca». Salía de la tabla, que es una
    // heurística escrita a mano: «moto de nieve» ⇒ diciembre a marzo. Una
    // heurística sirve para sospechar, no para borrar del viaje una visita a
    // Auschwitz.
    //
    // Ahora solo es duro cuando la temporada la dice la FICHA —`fechasPropias`,
    // lo que publique el proveedor—. Si la única prueba es que el título lleva
    // una palabra de la tabla, se avisa y se deja puesto: es la misma regla que
    // los cierres de los sitios, «no se corrige, se dice».
    //
    // El precio de esto, dicho: la «moto de nieve» que originó este fichero ya
    // no se descarta sola, se coloca con su aviso. Un aviso de más molesta; un
    // imprescindible borrado por el nombre de una reseñista arruina el viaje.
    duro: Boolean(suyos?.length),
    porQue: encontrada.porQue,
    meses: temporada,
    deLaFicha: Boolean(suyos?.length),
  };
}

/**
 * ¿EL TEXTO DICE ESA PALABRA, O SOLO LA LLEVA DENTRO DE OTRA?
 *
 * `includes` a secas encontró «ski» dentro de «Zakaski u Ani» —un bar de
 * Cracovia—, de «Karski» y de «staromiejskie», y con eso descartó tres free
 * tours por no haber nieve en septiembre. Una palabra de tres letras dentro de
 * topónimos polacos casa en todas partes.
 *
 * Las fronteras son «lo que no es letra ni número», no `\b`: después de
 * `normalizar` no hay acentos, pero sí guiones y puntos, y `\b` los trata como
 * límite igual. Esto es lo mismo y se lee.
 */
function diceLaPalabra(texto, palabra) {
  const p = normalizar(palabra);
  if (!p) return false;
  let desde = 0;
  for (;;) {
    const i = texto.indexOf(p, desde);
    if (i < 0) return false;
    const antes = i === 0 ? '' : texto[i - 1];
    const despues = texto[i + p.length] ?? '';
    const pegada = /[a-z0-9]/.test(antes) || /[a-z0-9]/.test(despues);
    if (!pegada) return true;
    desde = i + 1;
  }
}

/** «De diciembre a marzo», «Temporada: dic-mar» → [12,1,2,3]. */
export function mesesDeTexto(texto) {
  const t = normalizar(texto);
  if (!t.trim()) return null;

  const NOMBRES = [
    ['enero', 1], ['ene', 1], ['febrero', 2], ['feb', 2], ['marzo', 3], ['mar', 3],
    ['abril', 4], ['abr', 4], ['mayo', 5], ['may', 5], ['junio', 6], ['jun', 6],
    ['julio', 7], ['jul', 7], ['agosto', 8], ['ago', 8], ['septiembre', 9], ['sept', 9], ['sep', 9],
    ['octubre', 10], ['oct', 10], ['noviembre', 11], ['nov', 11], ['diciembre', 12], ['dic', 12],
  ];

  const hallados = [];
  for (const [nombre, n] of NOMBRES) {
    const re = new RegExp(`\\b${nombre}\\b`, 'g');
    let m;
    while ((m = re.exec(t)) !== null) {
      if (hallados.some((h) => m.index < h.hasta && m.index + nombre.length > h.desde)) continue;
      hallados.push({ mes: n, desde: m.index, hasta: m.index + nombre.length });
    }
  }
  if (!hallados.length) return null;

  hallados.sort((a, b) => a.desde - b.desde);

  // Un rango («de diciembre a marzo») se expande dando la vuelta al año.
  const meses = new Set();
  for (let i = 0; i < hallados.length; i += 1) {
    meses.add(hallados[i].mes);
    const sig = hallados[i + 1];
    if (!sig) continue;
    const enMedio = t.slice(hallados[i].hasta, sig.desde);
    if (!/^\s*(?:-|a|al|to|hasta|–)\s*$/.test(enMedio)) continue;
    for (let m = hallados[i].mes; m !== sig.mes; m = (m % 12) + 1) meses.add(m);
    meses.add(sig.mes);
  }
  return [...meses].sort((a, b) => a - b);
}
