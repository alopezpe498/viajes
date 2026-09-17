/**
 * services/rubrica-sitios.js
 * -----------------------------------------------------------------------------
 * CUÁNTO VALE UN SITIO, CONTADO EN VEZ DE OPINADO.
 *
 * Hermana de `rubrica-ciudades.js` y con el mismo contrato: la IA NOMBRA HECHOS,
 * el código hace la ARITMÉTICA. Lo que cambia son las casillas, porque las de
 * una ciudad no valen para un museo —«puerta de región» no se le puede
 * preguntar al Partenón—.
 *
 * EL PROBLEMA QUE VIENE A RESOLVER. Hasta aquí, la jerarquía entera de sitios
 * salía del ORDEN de una lista:
 *
 *     orden ≤ 3   → intocable: no se mueve, no se expulsa, agota la parada
 *                   entera antes de ceder y dispara los AVISOS GRAVES
 *     orden 4-10  → imprescindible
 *     resto       → segundo nivel: el primero en caer
 *
 * Y ese orden lo escribe el modelo de un tirón, sin evidencia y sin criterios.
 * Lo dice el propio comentario de la llamada que lo genera, en
 * `descubrir.js:843`: «ESTA LLAMADA PUNTÚA, aunque no lo parezca… No hay ninguna
 * otra fuente de jerarquía entre sitios: es el orden de llegada de esta lista».
 *
 * En Atenas esa lista pone el Ágora Antigua de #3 —intocable— y el Museo
 * Arqueológico Nacional de #4. Los dos son de primer orden mundial, y esa raya
 * es la que echó el museo del viaje 105. También pone de #10 el Odeón de Herodes
 * Ático, que se ve de fuera en veinte minutos y está DENTRO de la Acrópolis.
 *
 * NO ENCHUFADA TODAVÍA. Este fichero calcula y no decide nada: `importanciaDe`
 * sigue leyendo `orden`. Se escribe primero para poder puntuar el catálogo que
 * ya existe y mirar la tabla antes de que mueva un solo viaje.
 */

import { todas, ejecutar } from '../db/index.js';
import { parametro } from './orquestador.js';
import { consultarJSON, hayClaveIA, temperaturaAlPuntuar } from '../lib/ia.js';

// =============================================================================
// LAS CASILLAS
// =============================================================================
/**
 * SEIS CASILLAS, Y CADA UNA EXIGE PODER NOMBRAR LA COSA.
 *
 * El filtro no es la casilla: es la evidencia. «Es impresionante» no marca nada;
 * «los frisos originales del Partenón, que solo están aquí» sí.
 *
 * POR QUÉ `reconocimiento` PESA 2 Y NO 3, que es lo que vale en ciudades. Son
 * dos razones y las dos se ven en nuestros propios registros.
 *
 *   1. AQUÍ SE CONTARÍA TRES VECES LO MISMO. En una ciudad, «tiene UNESCO» y
 *      «tiene un hito de primer orden» suelen ser cosas distintas. En un SITIO
 *      es la misma fila: la Acrópolis marcaría `es_el_motivo` (+3),
 *      `unico_en_su_clase` (+3) y `reconocimiento`, y las tres por la misma
 *      frase. Con peso 3 serían 9 de 12 puntos salidos de una sola afirmación, y
 *      la rúbrica dejaría de discriminar justo donde tiene que hacerlo: entre
 *      dos sitios que son los dos de primer orden.
 *
 *      Que esto pasa de verdad se ve en la rúbrica de CIUDADES, donde el mismo
 *      monumento ya se cuenta dos veces a peso completo:
 *
 *          El Jem: unesco «Anfiteatro de El Jem» +3 · hito «Anfiteatro romano
 *                  de El Jem, el tercero…» +3
 *          Atenas: unesco «La Acrópolis de Atenas» +3 · hito «Partenón» +3
 *
 *      Es el mismo anfiteatro y la misma colina. Aquí no se repite el error.
 *
 *   2. UNA INSCRIPCIÓN CUBRE UN CONJUNTO ENTERO. «Monumentos paleocristianos y
 *      bizantinos de Tesalónica» —que salió tal cual en el viaje 109— es UNA
 *      declaración que ampara quince iglesias. Con peso 3, las quince suben de
 *      golpe y media ciudad se vuelve intocable; con 2 suben, que es justo, sin
 *      desbancar a lo que de verdad es el motivo del viaje.
 *
 * Y sigue siendo la tercera casilla más pesada, empatada con la colección: un
 * reconocimiento mundial no es un detalle. Simplemente no es, por sí solo, la
 * razón por la que alguien coge un avión.
 *
 * Los pesos van a la tabla de parámetros porque son la primera calibración y se
 * van a quedar cortos en algo.
 */
export const CASILLAS = {
  es_el_motivo: {
    peso: 3,
    parametro: 'rubrica_sitio_peso_motivo',
    // UNA PRUEBA, NO UNA IMPRESIÓN. Y esto sale de medir, no de opinar.
    //
    // Escrita como «es una de las razones de primer orden», esta casilla hacía
    // dos cosas malas a la vez, y las dos se midieron con tres tiradas de la
    // misma pregunta:
    //
    //   · A UN MUSEO NO SE LA MARCABA NUNCA. El Museo de la Acrópolis y el
    //     Arqueológico Nacional sacaban 3/3/3, siempre con una sola casilla.
    //     No era baile: era que la instrucción no les alcanzaba.
    //   · Y DONDE SÍ LA CONSIDERABA, SALÍA A CARA O CRUZ. De los ocho sitios que
    //     bailaban entre tiradas, en cuatro la que aparecía y desaparecía era
    //     esta. La varianza estaba CONCENTRADA aquí, no repartida: firma de
    //     instrucción ambigua, no de modelo ruidoso.
    //
    // «¿Es una razón de primer orden?» se puede leer como «¿atrae visitantes?»,
    // y por ahí colaba el Odeón de Herodes Ático mientras el museo que guarda
    // los originales del Partenón no entraba por ninguna parte.
    //
    // La prueba de la ausencia no admite esa lectura: o la ciudad pierde algo
    // sin él, o no lo pierde.
    pide:
      'si la ciudad, SIN ESTE SITIO, perdería una de sus razones de primer orden ' +
      'para visitarla. Si seguiría teniendo sus razones, no se marca',
    ejemplo: 'sin la Acrópolis, Atenas pierde la razón por la que se viaja a Atenas',
  },
  unico_en_su_clase: {
    peso: 3,
    parametro: 'rubrica_sitio_peso_unico',
    // IRREPETIBLE EN EL MUNDO, no «notable».
    //
    // Pedida floja, se marcaba para cualquier cosa con un superlativo local y se
    // juntaba siempre con `coleccion_o_recinto`: 3+2 = 5, y veinte sitios del
    // catálogo empataban ahí. La casilla que debía separar lo irrepetible no
    // separaba nada.
    pide:
      'si lo que se ve aquí NO EXISTE en ningún otro sitio del mundo. Ser el ' +
      'mejor de su ciudad, de su país o de su época no basta',
    ejemplo: 'los frisos originales del Partenón, que solo están aquí',
  },
  reconocimiento: {
    peso: 2,
    parametro: 'rubrica_sitio_peso_reconocimiento',
    pide: 'el nombre exacto de la inscripción o distinción',
    ejemplo: 'Patrimonio de la Humanidad desde 1987',
  },
  // LO QUE SE VE DENTRO, PARTIDO POR ALCANCE. Y ES EL ARREGLO DE LA 3ª TIRADA.
  //
  // Antes esto era UNA casilla de peso 2, y se convirtió en el cajón de sastre:
  // 41 de los 156 sitios del catálogo sacaban 2 puntos con ella como ÚNICA
  // casilla. Valía lo mismo «la mayor colección de arte griego antiguo del
  // mundo» que «el mausoleo de un santo local», así que el Museo Arqueológico
  // Nacional de Atenas empataba con el Odeón de Herodes Ático, y en Kairuan
  // ocho sitios seguidos valían exactamente igual.
  //
  // Lo que faltaba no era un peso: era el ALCANCE. Y el alcance se puede
  // NOMBRAR —«de referencia mundial en arte cicládico», «museo municipal de
  // etnografía»— que es el requisito de esta casa para que algo puntúe.
  //
  // SON EXCLUYENTES: una colección es de referencia o es local, no las dos.
  // Lo impone `sanearEvidencia`, no la buena voluntad del modelo.
  coleccion_de_referencia: {
    peso: 3,
    parametro: 'rubrica_sitio_peso_coleccion_referencia',
    pide:
      'si la colección o el recinto son una referencia MUNDIAL o NACIONAL en su ' +
      'materia. Di cuál de las dos y en qué materia',
    ejemplo: 'la mayor colección de arte cicládico del mundo',
  },
  coleccion_local: {
    peso: 1,
    parametro: 'rubrica_sitio_peso_coleccion_local',
    pide:
      'si se ve algo de interés dentro pero su alcance es la ciudad o la región',
    ejemplo: 'el mausoleo de Sidi Sahbi, santo local de Kairuan',
  },
  el_sitio_es_la_ciudad: {
    peso: 1,
    parametro: 'rubrica_sitio_peso_barrio',
    pide: 'qué trozo de ciudad es y por qué se recorre',
    ejemplo: 'Plaka, el casco bajo la Acrópolis',
  },
  sabor_local: {
    peso: 1,
    parametro: 'rubrica_sitio_peso_sabor',
    pide: 'qué se come, se compra o se ve hacer, y dónde',
    ejemplo: 'el mercado de Varvakios, pescado y carne desde 1886',
  },
};

/** El peso de una casilla, de la tabla si está y del código si no. */
export function pesoDeCasilla(nombre) {
  const c = CASILLAS[nombre];
  if (!c) return 0;
  return parametro(c.parametro, c.peso);
}

/**
 * EL MÁXIMO POSIBLE DE VERDAD.
 *
 * No es la suma de las seis: las dos de colección se excluyen, así que la mayor
 * se lleva la plaza y la otra no puede sumar nunca. Contarlas las dos daría un
 * techo que ningún sitio puede alcanzar, y «8 de 14» se leería peor de lo que es.
 */
export function puntosMaximos() {
  const excluyentes = ['coleccion_de_referencia', 'coleccion_local'];
  const sueltas = Object.keys(CASILLAS).filter((k) => !excluyentes.includes(k));
  return (
    sueltas.reduce((n, k) => n + pesoDeCasilla(k), 0) +
    Math.max(...excluyentes.map((k) => pesoDeCasilla(k)))
  );
}

// =============================================================================
// LA EVIDENCIA
// =============================================================================
/**
 * LO QUE NO SE PUEDE NOMBRAR NO PUNTÚA.
 *
 * Copiado de la rúbrica de ciudades porque el fallo es el mismo: pedirle a un
 * modelo que marque casillas sin obligarle a citar la cosa acaba con todas
 * marcadas. La evidencia tiene que ser un NOMBRE, no un adjetivo.
 */
const RELLENO = [
  'si', 'sí', 'no', 'varios', 'varias', 'muchos', 'muchas', 'alguno', 'algunos',
  'importante', 'importantes', 'famoso', 'famosa', 'conocido', 'conocida',
  'bonito', 'bonita', 'impresionante', 'espectacular', 'interesante', 'destacado',
  'principal', 'emblematico', 'emblemático', 'unico', 'único', 'imperdible',
  'merece la pena', 'vale la pena', 'muy recomendable', 'n/a', 'ninguno', 'null',
];

const sinAcentos = (t) =>
  String(t ?? '').toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '').trim();

/**
 * ¿Esta evidencia nombra algo?
 *
 * Tres condiciones y las tres hacen falta: que haya texto, que no sea una de las
 * fórmulas de relleno, y que tenga cuerpo suficiente para contener un nombre
 * propio. «El museo» son once caracteres y no nombra nada.
 */
export function evidenciaValida(texto) {
  const t = String(texto ?? '').trim();
  if (t.length < 12) return false;
  const limpio = sinAcentos(t).replace(/[.,;:!¡?¿"'«»]/g, '');
  return !RELLENO.includes(limpio);
}

/**
 * LA EVIDENCIA, LIMPIA.
 *
 * Devuelve solo las casillas que existen Y cuya evidencia nombra algo. Lo que
 * llegue de más —una casilla inventada, una evidencia vacía— se cae aquí y no
 * llega nunca a la aritmética.
 */
export function sanearEvidencia(crudo) {
  const lista = Array.isArray(crudo) ? crudo : Array.isArray(crudo?.casillas) ? crudo.casillas : [];
  const vistas = new Set();
  const buenas = [];

  for (const c of lista) {
    const clave = String(c?.casilla ?? '').trim();
    if (!CASILLAS[clave] || vistas.has(clave)) continue;
    if (!evidenciaValida(c?.evidencia)) continue;
    vistas.add(clave);
    buenas.push({ casilla: clave, evidencia: String(c.evidencia).trim() });
  }

  // UNA COLECCIÓN ES DE REFERENCIA O ES LOCAL, NO LAS DOS.
  //
  // Se impone aquí y no en el encargo porque una regla que depende de que el
  // modelo se acuerde no es una regla. Si vienen las dos, manda la de
  // referencia: quien la marcó tuvo que nombrar el alcance, y esa afirmación es
  // más fuerte que la otra.
  if (vistas.has('coleccion_de_referencia') && vistas.has('coleccion_local')) {
    return buenas.filter((c) => c.casilla !== 'coleccion_local');
  }

  return buenas;
}

// =============================================================================
// LA CUENTA
// =============================================================================
/**
 * LOS PUNTOS DE UN SITIO, con su desglose.
 *
 * Devuelve siempre el desglose además del total: un número que no se puede leer
 * no se puede discutir, y toda la gracia de esto es poder decir en voz alta por
 * qué un sitio gana a otro.
 */
export function puntosDeSitio(evidencia) {
  const buenas = sanearEvidencia(evidencia);
  const desglose = buenas.map((c) => ({
    casilla: c.casilla,
    evidencia: c.evidencia,
    peso: pesoDeCasilla(c.casilla),
  }));

  return {
    puntos: desglose.reduce((n, d) => n + d.peso, 0),
    maximo: puntosMaximos(),
    desglose,
  };
}

/**
 * EN QUÉ BANDA CAE, que es lo que el motor entiende.
 *
 * Tres bandas y no una escala continua, y es deliberado: el escalón de
 * «intocable» es el que dispara los avisos graves y el que hace que una parada
 * se agote antes de ceder. Ese mecanismo funciona; lo que fallaba era el
 * criterio de detrás. Se cambia el criterio y se deja el mecanismo.
 *
 *   3 · intocable        — lo que justifica el viaje
 *   2 · imprescindible   — lo que no querrías perderte
 *   1 · segundo nivel    — lo que se ve si sobra tiempo
 *
 * Los cortes van a la tabla: son la primera calibración y se van a mover.
 */
export function bandaDeSitio(puntos) {
  const n = Number(puntos) || 0;
  if (n >= parametro('banda_sitio_intocable_desde', 8)) return 3;
  if (n >= parametro('banda_sitio_imprescindible_desde', 4)) return 2;
  return 1;
}

export const NOMBRE_DE_BANDA = {
  3: 'intocable',
  2: 'imprescindible',
  1: 'segundo nivel',
};

/**
 * LA CUENTA, ESCRITA PARA LEERLA.
 *
 * «Acrópolis, 11 de 12: es el motivo «por lo que se viene a Atenas» +3 · único
 * «los frisos originales» +3 · …». Es lo que va al registro y a la pantalla.
 */
export function comoSeLeeLaCuenta(desglose) {
  if (!desglose?.length) return 'sin evidencia';
  return desglose
    .map((d) => `${d.casilla.replace(/_/g, ' ')} «${d.evidencia.slice(0, 60)}» +${d.peso}`)
    .join(' · ');
}

// =============================================================================
// LO QUE SE LE PIDE A LA IA
// =============================================================================
/**
 * EL ENCARGO, Y VIVE AQUÍ PARA QUE SOLO HAYA UNO.
 *
 * Estaba copiado en `tools/puntuar-sitios.js` y el medidor de varianza tenía su
 * propia versión resumida —18 líneas de reglas frente a 53—. Medir la varianza
 * de un encargo con OTRO encargo no mide nada, y encima los números no se podían
 * comparar con la tabla. Dos copias de una pregunta son dos preguntas.
 *
 * Mismo contrato que la rúbrica de ciudades: se nombra la cosa o no cuenta.
 */
export function encargoDeEvidencia(ciudad, sitios) {
  return [
    `Estos son los sitios que el catálogo tiene para ${ciudad}:`,
    '',
    ...sitios.map((s) => `- [${s.id}] ${s.nombre}${s.categoria ? ` (${s.categoria})` : ''}`),
    '',
    'Para CADA SITIO, recorre las SEIS casillas UNA POR UNA y decide en cada una',
    'si se cumple. Son preguntas independientes: un mismo sitio puede cumplir',
    'varias, y lo normal en los grandes es que cumpla cuatro o cinco.',
    '',
    ...Object.entries(CASILLAS).map(
      ([clave, c]) => `  · ${clave}: ${c.pide}.  Ejemplo: «${c.ejemplo}»`
    ),
    '',
    'Reglas:',
    '- Una casilla SOLO se marca si puedes NOMBRAR la cosa concreta en',
    '  "evidencia". «Es impresionante» no vale; «los frisos originales del',
    '  Partenón, que solo están aquí» sí.',
    '- NO ELIJAS LA MEJOR CASILLA: contéstalas todas. Que un museo tenga una gran',
    '  colección no impide que además sea único en su clase y el motivo del',
    '  viaje. Marcar solo la más obvia es el error a evitar.',
    '',
    '- "es_el_motivo" SE CONTESTA CON UNA PRUEBA, no con una impresión:',
    '  ¿SI ESTE SITIO NO EXISTIERA, la ciudad perdería una de sus razones de',
    '  primer orden para venir? Si la ciudad seguiría teniendo sus razones, NO',
    '  se marca.',
    '  Un MUSEO puede serlo por sí mismo cuando guarda lo esencial de un',
    '  yacimiento o de una civilización: sin él, eso no se ve en ninguna parte.',
    '  Sí: «sin el Museo de la Acrópolis no se pueden ver los originales que ya',
    '      no están en la colina».',
    '  NO: «un museo municipal, o uno de artes y tradiciones populares» — por',
    '      interesante que sea, sin él la ciudad conserva intactas todas sus',
    '      razones de primer orden. Eso es "coleccion_local".',
    '  NO: «un monumento muy visitado, bien conservado o muy fotografiado» —',
    '      recibir visitas no es ser una razón para venir a la ciudad.',
    '  Un CASCO HISTÓRICO también puede serlo por sí mismo, igual que un museo:',
    '  hay ciudades a las que se viaja POR su medina o su casco amurallado.',
    '  Sí: «sin su medina, la ciudad pierde aquello por lo que se la visita».',
    '  NO: «un barrio con carácter, bohemio, gastronómico o de moda» — sin él la',
    '      ciudad conserva todas sus razones de primer orden. Eso es',
    '      "el_sitio_es_la_ciudad", que es la casilla de los barrios.',
    '',
    '- "unico_en_su_clase" ES EXIGENTE: significa que eso no existe en ningún',
    '  otro sitio DEL MUNDO. Ser el mejor conservado de su país, el más grande',
    '  de su época o el único de su ciudad NO basta.',
    '  Sí: «los frisos originales del Partenón, que no están en ningún otro sitio».',
    '  Sí: «la momia de Tutankamón».',
    '  NO: «un teatro romano del siglo II bien conservado» — hay decenas en el',
    '      Mediterráneo. Un anfiteatro, una mezquita o un museo arqueológico no',
    '      son únicos por ser buenos.',
    '',
    '- Y "unico_en_su_clase" no se marca por el mismo hecho que las de colección.',
    '  Si lo que hace único al sitio es precisamente lo que guarda, entonces es',
    '  "unico_en_su_clase" y no la otra. Una cosa, una casilla.',
    '',
    '- LAS DOS DE COLECCIÓN SON EXCLUYENTES y el listón de "de referencia" es',
    '  ALTO. "coleccion_de_referencia" solo si es una referencia MUNDIAL o',
    '  NACIONAL en su materia, y tienes que decir CUÁL DE LAS DOS y EN QUÉ.',
    '  Ser el mejor museo de su ciudad, el más visitado de la región o muy',
    '  completo NO basta: eso es "coleccion_local".',
    '  Sí: «el Museo Arqueológico Nacional de Atenas, referencia MUNDIAL en',
    '      escultura y cerámica griega antigua».',
    '  NO: «el Museo de Artes y Tradiciones Populares de Kairuan, el mejor de la',
    '      ciudad para entender la artesanía local» — eso es alcance regional,',
    '      así que va en "coleccion_local".',
    '  Ante la duda, "coleccion_local". Es la respuesta prudente y la correcta',
    '  para la mayoría de los sitios.',
    '- Si de un sitio no sabes nada concreto, devuélvelo con "casillas": [].',
    '  Es una respuesta correcta y no un fallo.',
    '- No repitas la misma casilla dos veces en el mismo sitio.',
    '',
    'Ejemplo de un sitio grande, con cuatro casillas a la vez:',
    '{"id":7,"casillas":[',
    '  {"casilla":"es_el_motivo","evidencia":"la Acrópolis es por lo que se viene a Atenas"},',
    '  {"casilla":"unico_en_su_clase","evidencia":"el Partenón original, que no está en ningún otro sitio"},',
    '  {"casilla":"reconocimiento","evidencia":"Patrimonio de la Humanidad desde 1987"},',
    '  {"casilla":"coleccion_o_recinto","evidencia":"el recinto entero: Erecteion, Atenea Niké, Propileos"}]}',
    '',
    'Devuelve SOLO este JSON:',
    '{"sitios":[{"id":12,"casillas":[{"casilla":"es_el_motivo","evidencia":"…"}]}]}',
  ].join('\n');
}

// =============================================================================
// GUARDARLA EN EL CATÁLOGO
// =============================================================================
/**
 * PUNTÚA LOS SITIOS DE UNA CIUDAD Y LO DEJA ESCRITO.
 *
 * Se llama al terminar de investigar la ciudad, con los sitios ya guardados y ya
 * fundidos: así se puntúa lo que de verdad se va a visitar.
 *
 * UNA LLAMADA APARTE, Y NO METIDA EN LA QUE GENERA LOS SITIOS. En el plan dije
 * que iría dentro —«la IA ya está ahí escribiendo la descripción»— y al montarlo
 * se ve que es mala idea:
 *
 *   · El encargo de la rúbrica son 62 líneas de reglas con sus contraejemplos.
 *     Metidas en el prompt que además pide nombre, descripción, categoría,
 *     coordenadas y títulos de Wikipedia de diez sitios, lo que se consigue es
 *     que salgan peor las dos cosas.
 *   · Y sobre todo: nos ha costado SEIS iteraciones y cinco mediciones dejar
 *     este encargo quieto. Diluirlo dentro de otro más grande es reintroducir
 *     a ciegas el ruido que acabamos de quitar.
 *
 * Es UNA llamada por ciudad, de las baratas, en una fase que ya hace bastantes
 * más. Lo medido: la ciudad entera de golpe, no sitio a sitio.
 *
 * NO LANZA NUNCA. Si la IA falla, los sitios se quedan sin puntos —que es
 * «todavía no se ha medido», no «vale cero»— y el reparto sigue usando `orden`
 * para ellos. Puntuar es una mejora, no un requisito.
 */
export async function puntuarLosSitios(punto, ciudad, di = () => {}) {
  if (!punto?.id || !hayClaveIA()) return 0;

  const sitios = todas(
    `SELECT id, nombre, categoria FROM sitios_lugar
      WHERE punto_interes_id = ? AND cubierto_por IS NULL AND bloque <> 'busqueda'
      ORDER BY orden, id`,
    punto.id
  );
  if (!sitios.length) return 0;

  let r;
  try {
    r = await consultarJSON(encargoDeEvidencia(ciudad, sitios), {
      maxTokens: 4000,
      paso: `puntuar los sitios de ${ciudad}`,
      temperatura: temperaturaAlPuntuar(),
    });
  } catch (err) {
    di(`   ${ciudad}: no pude puntuar los sitios (${err.message}). Se quedan sin nota.`);
    return 0;
  }

  const porId = new Map((Array.isArray(r?.sitios) ? r.sitios : []).map((x) => [Number(x?.id), x]));
  let puestos = 0;

  for (const s of sitios) {
    const cuenta = puntosDeSitio(porId.get(s.id)?.casillas);

    // SIN NINGUNA CASILLA NO SE ESCRIBE NADA, y es importante: un cero escrito
    // dice «lo he medido y no vale nada», y lo que ha pasado es que no se supo
    // nombrar ningún hecho. Eso es «no lo sé», y «no lo sé» se queda en NULL
    // para que el reparto siga usando el orden de siempre con ese sitio.
    if (!cuenta.desglose.length) continue;

    ejecutar(
      'UPDATE sitios_lugar SET puntos = ?, evidencia = ? WHERE id = ?',
      cuenta.puntos,
      JSON.stringify(cuenta.desglose),
      s.id
    );
    puestos += 1;
  }

  if (puestos) {
    const altos = todas(
      `SELECT nombre, puntos FROM sitios_lugar
        WHERE punto_interes_id = ? AND puntos IS NOT NULL
        ORDER BY puntos DESC, orden LIMIT 3`,
      punto.id
    );
    di(
      `   ${ciudad}: ${puestos} de ${sitios.length} sitios puntuados. Arriba: ` +
        altos.map((a) => `${a.nombre} (${a.puntos})`).join(', ') + '.'
    );
  }

  return puestos;
}
