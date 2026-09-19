/**
 * services/horarios.js
 * -----------------------------------------------------------------------------
 * QUÉ DÍAS ABRE, LEÍDO DEL TEXTO DEL HORARIO.
 *
 * EL FALLO QUE ORIGINA ESTE FICHERO. Un sitio cuyo horario decía «abre de
 * viernes a domingo» acabó fuera del lienzo con el motivo «cierra los viernes»,
 * que es exactamente el día en que abre, y encima era el único día que la parada
 * tenía. El rango se leyó del revés.
 *
 * Y se leyó del revés porque se le preguntaba al revés: al modelo se le pedía
 * la lista de días que CIERRA. Ante «viernes a domingo» eso obliga a expandir el
 * rango, restarlo de los siete días y devolver el complemento. Es aritmética, es
 * de la que sale mal una de cada diez veces, y en esta casa la aritmética no se
 * le pide al modelo: se hace aquí.
 *
 * ASÍ QUE HAY DOS LECTORES, Y ESTE ES EL PRIMERO:
 *
 *   1. Este, determinista, que entiende los formatos que de verdad llegan —los
 *      rangos con guion, con «a» y con «to», las abreviaturas de los dos
 *      idiomas, los tramos separados por punto y coma, el AM/PM inglés de los
 *      sitios no europeos— y no llama a nadie. Es el que se puede probar.
 *
 *   2. La IA, solo cuando este no encuentra ni un día en el texto. Y entonces se
 *      le pregunta por los días que ABRE, que es lo que el texto dice, y el
 *      complemento se calcula aquí.
 *
 * LA REGLA DE ORO, y está escrita en código más abajo: una lista de días
 * abiertos vacía NUNCA significa «cierra los siete». Significa «no lo sé», y
 * ante la duda un sitio abre: un sitio marcado como cerrado a diario no se puede
 * colocar ningún día y desaparece del viaje sin que nadie sepa por qué.
 */

import { mesesDeTexto } from './temporadas.js';

/** Domingo es 0, como en `Date.getDay()` y como en `cierra_dias`. */
export const TODOS_LOS_DIAS = [0, 1, 2, 3, 4, 5, 6];

/**
 * Los nombres de los días en los dos idiomas, de más largo a más corto: el orden
 * importa porque «domingo» tiene que ganarle a «dom» al buscar.
 */
const DIAS = [
  ['domingos', 0], ['domingo', 0], ['sunday', 0], ['sundays', 0], ['dom', 0], ['sun', 0],
  ['lunes', 1], ['mondays', 1], ['monday', 1], ['lun', 1], ['mon', 1],
  ['martes', 2], ['tuesdays', 2], ['tuesday', 2], ['tues', 2], ['mar', 2], ['tue', 2],
  ['miercoles', 3], ['wednesdays', 3], ['wednesday', 3], ['mierc', 3], ['mie', 3], ['wed', 3],
  // «JUEV» Y «VIER» FALTABAN, y es el mismo agujero que el «Mi-Dom» de abajo.
  // La IA abrevia como le da la gana, y «Lun-Vier: 06:00 - 18:00» se leía como
  // el lunes a secas —«vier» no casa con `\bvie\b`— así que de martes a viernes
  // quedaban CERRADOS por la regla de «la lista es la lista». Un horario de
  // oficina convertido en un sitio que solo abre los lunes.
  ['jueves', 4], ['thursdays', 4], ['thursday', 4], ['thurs', 4], ['thur', 4], ['juev', 4], ['jue', 4], ['thu', 4],
  ['viernes', 5], ['fridays', 5], ['friday', 5], ['vier', 5], ['vie', 5], ['fri', 5],
  ['sabados', 6], ['sabado', 6], ['saturdays', 6], ['saturday', 6], ['sab', 6], ['sat', 6],
];

/**
 * LAS ABREVIATURAS DE DOS LETRAS, QUE VAN APARTE Y CON CUIDADO.
 *
 * EL FALLO QUE ORIGINA ESTO. El Museo de la Segunda Guerra Mundial —el
 * imprescindible número uno de Gdansk— se fue del viaje con el motivo «cierra
 * los sábados», leyendo esto:
 *
 *     «Mi-Dom: 10:00 - 18:00, Mar: 10:00 - 16:00 (Lunes cerrado)»
 *
 * Arriba están «miercoles», «mierc» y «mie», pero no «mi». Así que del rango
 * solo se veía el «Dom» del final: abría domingo y martes, y los otros cinco
 * días —el sábado del viaje entre ellos— quedaban cerrados. El texto lo escribe
 * la IA en el paso de traducir horarios, o sea que abrevia como le da la gana y
 * el lector tiene que entenderla.
 *
 * NO SE PUEDEN METER ARRIBA SIN MÁS. Con dos letras, media lista son palabras
 * corrientes: «su» y «tu» son posesivos, «mi» lo es en español y día en inglés,
 * «we» es un pronombre y «do» un verbo. Un «consulta su web» convertido en
 * domingo cierra un sitio que abre, que es exactamente el fallo que se está
 * arreglando, pero al revés.
 *
 * Por eso solo cuentan cuando el texto las usa COMO DÍA: pegadas a un guion, a
 * una «a», a una coma, a dos puntos o a una hora. «Mi-Dom» sí; «mi horario» no.
 */
const DIAS_CORTOS = [
  ['lu', 1], ['ma', 2], ['mi', 3], ['ju', 4], ['vi', 5], ['sa', 6], ['do', 0],
  ['mo', 1], ['tu', 2], ['we', 3], ['th', 4], ['fr', 5], ['su', 0],
];

/** Grupos que valen por varios días de golpe. */
const GRUPOS = [
  ['fines de semana', [6, 0]],
  ['fin de semana', [6, 0]],
  ['weekends', [6, 0]],
  ['weekend', [6, 0]],
  ['entre semana', [1, 2, 3, 4, 5]],
  ['dias laborables', [1, 2, 3, 4, 5]],
  ['laborables', [1, 2, 3, 4, 5]],
  ['weekdays', [1, 2, 3, 4, 5]],
];

/**
 * LAS FRANJAS QUE SE DICEN CON PALABRAS EN VEZ DE CON NÚMEROS.
 *
 * EL CASO QUE ORIGINA ESTO. La «Taverna Savopoulos» publica su horario como
 * «Almuerzo y cena», y el lector lo daba por ilegible: sin un solo número no hay
 * rango que sacar, así que el sitio se quedaba sin horario y se podía colocar a
 * cualquier hora del día. Y es de las pocas cosas que un horario dice con
 * claridad: un restaurante que sirve almuerzos y cenas no abre a las once de la
 * mañana ni a las cinco de la tarde.
 *
 * Mismo patrón que `GRUPOS`, que traduce «fin de semana» a días: aquí se traduce
 * «almuerzo» a horas. Es vocabulario, no una forma nueva de leer nada.
 *
 * SE BUSCAN CON FRONTERA DE PALABRA y no con `includes` —que es lo que usa
 * GRUPOS— porque estas son cortas y se esconden dentro de otras: «cena» vive
 * dentro de «escena» y de «docena», y «Según la cartelera de espectáculos» no es
 * el horario de una cena.
 */
const FRANJAS = [
  [/\bdesayunos?\b/, [8 * 60, 11 * 60]],
  [/\balmuerzos?\b/, [13 * 60, 16 * 60]],
  [/\bcomidas?\b/, [13 * 60, 16 * 60]],
  [/\bmediod[ií]a\b/, [13 * 60, 16 * 60]],
  [/\bcenas?\b/, [20 * 60, 23 * 60 + 30]],
];

/**
 * Las franjas con nombre que aparecen en un texto, ordenadas por hora.
 *
 * Vacío si no nombra ninguna, que es lo normal: casi todos los horarios vienen
 * en números y por este camino no pasan.
 */
function franjasConNombre(texto) {
  const t = String(texto ?? '');
  return FRANJAS.filter(([re]) => re.test(t))
    .map(([, rango]) => rango)
    .sort((a, b) => a[0] - b[0]);
}

/**
 * LO QUE SIGNIFICA «SIEMPRE».
 *
 * EL FALLO QUE ORIGINA LA SEGUNDA MITAD DE ESTA LISTA. En Santorini, Oia, Pyrgos,
 * el Faro de Akrotiri y la Camini de Oia a Amoudi salieron los cuatro con «no he
 * podido leer su horario con seguridad»… y su horario decía «Abierto 24h». Aquí
 * estaba «24 h» CON ESPACIO y no «24h», así que no casaba ninguno.
 *
 * Y ES UN FALLO DE LOS QUE ENSUCIAN DOS VECES: un pueblo, un faro, un sendero y
 * un mirador no tienen horario porque no cierran, y acababan los cuatro en la
 * lista de avisos sin resolver, tapando los avisos de verdad. Un aviso que salta
 * siempre se deja de leer, y entonces no sirve ninguno.
 *
 * TRES ESTADOS Y NO DOS, que es lo que hacía falta: «tengo horario y lo leo»,
 * «está siempre abierto» y «no pude leerlo». El de en medio es el que faltaba, y
 * no genera aviso porque no hay nada que avisar.
 */
const SIEMPRE = [
  'todos los dias', 'todos los d as', 'a diario', 'diariamente', 'todo el ano',
  'every day', 'everyday', 'daily', 'open daily', '24/7', '24 h', 'abierto siempre',
  // Las formas que de verdad escriben Google y la traducción de horarios para un
  // sitio al aire libre.
  '24h', '24 horas', '24hs', 'las 24 horas', 'abierto 24',
  'open 24', 'always open', 'siempre abierto', 'sin horario', 'sin horarios',
  'acceso libre', 'entrada libre', 'al aire libre', 'no cierra', 'nunca cierra',
  // LO QUE SOLO SE VE POR FUERA TAMPOCO CIERRA.
  //
  // Una zaouia, una fuente o una mezquita a la que no se entra no tienen puerta
  // que cerrar: se ven desde la calle y se ven siempre. El lector las daba por
  // ilegibles y el lienzo soltaba «no he podido leer su horario con seguridad,
  // compruébalo antes de ir», que aquí es falso: no hay nada que comprobar.
  //
  // Y es el mismo defecto que ya arregló la lista de arriba con el faro y el
  // mirador, por otra puerta: un aviso que salta sin motivo tapa los que sí lo
  // tienen.
  //
  // FRASES ENTERAS Y NO LA PALABRA SUELTA. «Visible» a secas aparece en
  // «Visible desde la Acrópolis. Interior solo en espectáculos», donde el
  // interior SÍ tiene restricción y darlo por siempre abierto sería mentir.
  'solo exteriores', 'solo exterior', 'visible desde el exterior', 'visible todo el dia',
  // LO QUE ESCRIBE LA TRADUCCIÓN DE HORARIOS PARA UN SITIO AL AIRE LIBRE, visto en
  // Berga: los cinco avisos que quedaron sin resolver eran «Espacio público
  // abierto permanente», «Espacio abierto permanente» y «Libre (Centro de
  // visitantes tiene horario específico)». Ninguno casaba y el lienzo pedía
  // comprobar el horario de un lago. El «Libre» va aparte, más abajo, como tramo
  // EXACTO: la palabra suelta aparece en «día libre» o «libre de humo».
  'abierto permanente', 'abierto permanentemente', 'abierto de forma permanente',
  'espacio abierto',
  // Un barrio de tiendas: «Depende de cada tienda» (Naramachi, Japón). Las tiendas
  // tendrán su horario; el barrio se pasea a cualquier hora.
  'depende de cada tienda', 'depende de los comercios', 'depende de cada comercio',
  'depende de cada establecimiento', 'depende de cada puesto',
];

/**
 * «DESDE EL AMANECER HASTA EL ATARDECER». No es siempre abierto —de noche está
 * cerrado— pero sí un horario: el santuario Meiji lo dice así y el lienzo avisaba
 * de que no sabía leerlo. Se toma el tramo prudente que vale todo el año, de 7:00
 * a 17:00: en invierno amanece después de las siete y anochece antes de las seis.
 */
const DE_SOL_A_SOL = /(?:del|desde el)\s+amanecer\s+(?:al|hasta el)\s+atardecer|sunrise\s+(?:to|until)\s+sunset|de sol a sol/;

/**
 * «Libre» como tramo entero. El paréntesis de «Libre (Centro de visitantes…)» se
 * separa como nota antes de llegar aquí, así que lo que queda es exactamente
 * «libre»: eso, y solo eso, es un sitio sin horario.
 */
const SIEMPRE_EXACTO = /^\s*(?:libre|acceso libre|abierto)\s*$/;

/** Las palabras que dan la vuelta al sentido de un tramo. */
const CIERRE = ['cerrado', 'cierra', 'cierre', 'closed', 'except', 'excepto', 'salvo'];

/**
 * CERRADO DEL TODO, NO CERRADO LOS MARTES.
 *
 * EL FALLO QUE ORIGINA ESTO, y es del viaje 109. Los Baños de Pasha de
 * Tesalónica tienen esto por horario:
 *
 *     «Cerrado por restauración permanente»
 *
 * …y el lector contestaba «no lo sé» a los siete días. Así que el relleno del
 * día liberado lo dio por un sitio más y lo metió en el plan: diez minutos a las
 * 12:30 en un edificio que lleva años en obras. El aviso decía la verdad —«no he
 * podido leer su horario»— pero la frase se entiende perfectamente.
 *
 * Es el mismo pecado que «(Cierra martes)» dentro de un horario ilegible: una
 * afirmación clara que se pierde porque el resto del texto no cuadra.
 *
 * LA LISTA ES CORTA A PROPÓSITO. «Cerrado» a secas no basta —«Cerrado los
 * lunes» también lo lleva— y por eso hace falta la MARCA DE PERMANENCIA: obras,
 * restauración, temporalmente, definitivamente. Sin una de estas, el texto se
 * sigue leyendo como siempre.
 */
const CERRADO_DEL_TODO =
  /\b(?:permanente|permanentemente|permanently|definitivamente|temporalmente|clausurad|por\s+(?:obras|reformas?|restauraci[oó]n|renovaci[oó]n)|no\s+se\s+puede\s+visitar)/;

/**
 * LO QUE AVISA DE QUE ESTE TEXTO NO ES UNA LISTA CERRADA DE DÍAS.
 *
 * Un horario que empieza por «Variable» o que dice «consultar» no está
 * enumerando los días que abre: está avisando de que no se compromete. Si además
 * nombra un día —«Variable (Vie. hasta las 22:00 en verano)»— ese día es una
 * EXCEPCIÓN citada de pasada, no la lista completa.
 *
 * La diferencia importa porque la regla 2 de `horarioPorDias` cierra todo lo que
 * no se nombre, y aplicada a una nota cierra seis días que el texto no ha
 * mencionado siquiera.
 *
 * Ojo con lo que NO está en esta lista: «varía según época» sí aparece en
 * horarios buenos —«Lun-Dom: 08:00-20:00 (Varía según época)»— y ahí no estorba,
 * porque un texto que nombra los siete días no deja ninguno sin decidir y la
 * regla 2 ni llega a correr.
 */
const NO_ES_UNA_LISTA = [
  'variable', 'consultar', 'a confirmar', 'sin confirmar',
  'depende de', 'sujeto a', 'orientativo', 'aproximado', 'puede variar',
];

/** Sin acentos, en minúsculas y con los guiones raros vueltos guion normal. */
function normalizar(texto) {
  return String(texto ?? '')
    .toLowerCase()
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .replace(/[‐-―−]/g, '-') // – — − y compañía
    .replace(/\s+/g, ' ');
}

/**
 * LOS DÍAS QUE NOMBRA UN TRAMO, EN ORDEN Y SABIENDO SI VENÍAN EN RANGO.
 *
 * Se buscan los nombres de día con sus posiciones y se mira QUÉ HAY ENTRE dos
 * consecutivos: si solo hay un separador de rango —un guion, una «a», un «to»—
 * es un rango y se expande; cualquier otra cosa los deja como días sueltos.
 *
 * Se mira el texto de en medio en vez de partir por comas porque los formatos
 * reales mezclan las dos cosas en la misma línea: «Lun-Vie, Sab» es un rango y
 * un día suelto, y «Lun, Mie, Vie» son tres sueltos.
 *
 * Y el rango DA LA VUELTA A LA SEMANA cuando hace falta: «Viernes a Lunes» es
 * 5, 6, 0, 1 y no un recorrido hacia atrás. Está unas líneas más abajo.
 */

/**
 * ¿ESE «MI» ES UN MIÉRCOLES O ES UN POSESIVO?
 *
 * Lo decide lo que tiene pegado. Un día abreviado va siempre con la compañía de
 * un horario: un guion de rango, una «a», una coma o un punto y coma de lista,
 * los dos puntos de la hora, o la hora misma. Un pronombre va con una palabra
 * detrás. Se mira a los dos lados porque el día puede ir al principio del rango
 * («Mi-Dom») o al final («Lun a Mi»).
 */
function pareceUnDia(tramo, desde, hasta) {
  const antes = tramo.slice(Math.max(0, desde - 10), desde);
  const despues = tramo.slice(hasta, hasta + 10);

  const detras = /^\s*(?:[-,;:/.]|\d|(?:a|al|to|hasta|y)\s)/.test(despues);
  const delante = /(?:[-,;:/]|\d)\s*$/.test(antes) || /\b(?:a|al|to|hasta|y)\s+$/.test(antes);

  return detras || delante;
}

/**
 * LOS MESES ABREVIADOS, para poder distinguirlos de los días.
 *
 * Solo hace falta para desempatar «mar», que es martes y es marzo. Los demás no
 * colisionan: «mié», «jue», «vie», «sáb», «dom» y «lun» no son meses.
 */
const MESES_CORTOS = 'ene|feb|mar|abr|may|jun|jul|ago|sep|sept|oct|nov|dic';

/**
 * ¿ESE «MAR» ES MARZO EN VEZ DE MARTES?
 *
 * EL FALLO QUE ORIGINA ESTO, y es del viaje 106, el Palacio del Gran Maestre de
 * Rodas:
 *
 *     «Abr-Oct: 8:00 - 20:00 Nov-Mar: 8:30 - 15:30 (Cierra martes)»
 *
 * El «Mar» de «Nov-Mar» se leía como MARTES. Y como la regla de este fichero es
 * «la lista es la lista: lo que no está, cierra», el horario acababa diciendo
 * que el sitio **solo abre los martes** y cierra los otros seis días. Con la
 * frase «(Cierra martes)» al lado, o sea justo al revés de lo que pone.
 *
 * El resultado en el viaje fue más silencioso y peor: el lector se quedaba sin
 * poder decidir —los siete días en «no lo sé»— y el Palacio y el Museo se
 * quedaron colocados un martes 22 con un aviso de «no he podido leer su horario»
 * que nadie podía resolver, repetido en las tres pasadas de revisión.
 *
 * LA REGLA: «mar» es marzo cuando está pegado a otro mes con un guion o una «a»
 * —«nov-mar», «de noviembre a marzo»— o cuando lleva un mes justo detrás. En
 * cualquier otro sitio es martes, que es lo que es casi siempre.
 */
function esMarzoYNoMartes(tramo, desde, hasta) {
  const antes = tramo.slice(Math.max(0, desde - 14), desde);
  const despues = tramo.slice(hasta, hasta + 14);
  const unMes = `(?:${MESES_CORTOS})[a-zé]*`;
  return (
    new RegExp(`\\b${unMes}\\s*(?:-|–|a|al|to|hasta)\\s*$`, 'i').test(antes) ||
    new RegExp(`^\\s*(?:-|–|a|al|to|hasta)\\s*${unMes}\\b`, 'i').test(despues)
  );
}

function diasDelTramo(tramo) {
  const encontrados = [];

  // Se busca cada nombre con frontera de palabra. El orden de DIAS (de más
  // largo a más corto) evita que «dom» se coma el principio de «domingo».
  const yaVisto = [];
  for (const [palabra, n] of DIAS) {
    const re = new RegExp(`\\b${palabra}\\b`, 'g');
    let m;
    while ((m = re.exec(tramo)) !== null) {
      const desde = m.index;
      const hasta = desde + palabra.length;
      // Si este hueco ya lo ocupa un nombre más largo, no es otro día.
      if (yaVisto.some((v) => desde < v.hasta && hasta > v.desde)) continue;
      // «Nov-Mar» es un rango de MESES, no el martes.
      if (palabra === 'mar' && esMarzoYNoMartes(tramo, desde, hasta)) continue;
      yaVisto.push({ desde, hasta });
      encontrados.push({ dia: n, desde, hasta });
    }
  }

  // Y ahora las de dos letras, que solo valen si están puestas como día. Van
  // después a propósito: así «mie» y «miercoles» ya han ocupado su hueco y el
  // «mi» de dentro no se cuenta dos veces.
  for (const [palabra, n] of DIAS_CORTOS) {
    const re = new RegExp(`\\b${palabra}\\b`, 'g');
    let m;
    while ((m = re.exec(tramo)) !== null) {
      const desde = m.index;
      const hasta = desde + palabra.length;
      if (yaVisto.some((v) => desde < v.hasta && hasta > v.desde)) continue;
      if (!pareceUnDia(tramo, desde, hasta)) continue;
      yaVisto.push({ desde, hasta });
      encontrados.push({ dia: n, desde, hasta });
    }
  }

  encontrados.sort((a, b) => a.desde - b.desde);

  const dias = new Set();
  for (let i = 0; i < encontrados.length; i += 1) {
    const actual = encontrados[i];
    const siguiente = encontrados[i + 1];
    dias.add(actual.dia);

    if (!siguiente) continue;

    const enMedio = tramo.slice(actual.hasta, siguiente.desde);
    const esRango = /^\s*(?:-|a|al|to|hasta|through|thru)\s*$/.test(enMedio);
    if (!esRango) continue;

    // El rango se recorre HACIA DELANTE dando la vuelta a la semana: «vie a dom»
    // es 5, 6, 0 y no 5, 4, 3... 0. Dar la vuelta es justo lo que hay que hacer
    // bien y lo que se hacía mal.
    for (let d = actual.dia; d !== siguiente.dia; d = (d + 1) % 7) dias.add(d);
    dias.add(siguiente.dia);
  }

  // Y los grupos, que no son nombres de día pero valen por varios.
  for (const [palabra, cuales] of GRUPOS) {
    if (tramo.includes(palabra)) for (const d of cuales) dias.add(d);
  }

  return dias;
}

/**
 * LOS TRAMOS DE UN TEXTO DE HORARIO.
 *
 * AQUÍ ESTABA EL FALLO DE POLONIA, y es de una línea. Se partía por punto y coma
 * y salto de línea, nada más, así que esto:
 *
 *     «Mié-Dom: 10:00-18:00 (Lun: Cerrado)»
 *
 * era UN SOLO tramo, y como dentro aparecía la palabra «Cerrado», el tramo
 * entero se leía como un tramo de cierre: miércoles a domingo pasaban a ser los
 * días que el museo CIERRA. El domingo, que es justo cuando abre, quedó marcado
 * como cerrado y la revisión echó del plan los dos museos de Gdansk.
 *
 * El paréntesis es una NOTA APARTE —una excepción a lo que dice la frase de
 * fuera— y tiene que ser su propio tramo. Se saca antes de partir por el resto
 * de separadores.
 *
 * Y VOLVIÓ, CON UN PUNTO EN VEZ DE UN PARÉNTESIS. En el viaje 40:
 *
 *     «Martes a Domingo: 10:00 - 18:00. Lunes cerrado.»
 *     «Domingo a Viernes: 10:00 - 18:00. Sábados cerrado.»
 *
 * Exactamente la misma frase, exactamente el mismo destrozo: un solo tramo, la
 * palabra «cerrado» dentro, y el rango entero —que estaba bien expandido, el
 * rango nunca fue el problema— leído del revés. Con las dos cláusulas marcadas
 * como cierre salen los SIETE días cerrados, y el Museo Nacional de Cracovia, la
 * Sinagoga del Tempel y el Manggha se fueron del viaje por un horario que dice
 * que abren seis días de siete.
 *
 * Se salvaban por casualidad los que traían además un paréntesis o un punto y
 * coma en la misma frase —«Mar-Dom: 10:00-18:00 (Vie hasta 21:00). Lun: cerrado»
 * partía por el paréntesis y colaba—. Los tres que no tenían más separador que
 * el punto, no.
 */
function tramosDe(t) {
  const notas = [];
  // Los paréntesis, fuera y cada uno por su cuenta.
  const sinParentesis = t.replace(/\(([^)]*)\)/g, (_, dentro) => {
    notas.push(dentro.trim());
    return ' ; ';
  });

  // Y EL PUNTO, QUE TAMBIÉN SEPARA FRASES. Es el mismo fallo del paréntesis, con
  // el signo que se quedó fuera. Ver la cabecera de esta función.
  //
  // El punto que separa frases, NO el de las horas: «10.00 a 18.00» es una hora
  // y partirla por ahí rompería los horarios que la escriben con punto en vez de
  // con dos puntos.
  //
  // Lo que los distingue es lo que viene DETRÁS, no lo de delante. En «18:00.
  // Lunes cerrado» el punto lleva un dígito pegado por la izquierda igual que en
  // «10.00», así que mirar hacia atrás no separa nada —primer intento, y no
  // cortaba—. Un punto decimal siempre tiene un dígito DESPUÉS; un punto de
  // frase, no.
  // Y LA COMA, PERO SOLO CUANDO SEPARA DOS HORARIOS.
  //
  // EL FALLO QUE ORIGINA ESTO. La Lonja de los Paños y el Museo Nacional de
  // Cracovia llevaban toda la semana con «no he podido leer su horario», y su
  // horario es este:
  //
  //     «Lun: Cerrado, Mar-Dom: 10:00 - 18:00»
  //
  // Con punto y coma se lee perfectamente —cierra lunes, abre el resto— y con
  // coma no se lee nada, porque los dos trozos quedan en un solo tramo que a la
  // vez cierra y abre. El mismo horario, dos signos de puntuación, dos destinos.
  //
  // NO SE PARTE POR CUALQUIER COMA, y por eso el corte es estrecho: «Lun, Mar,
  // Mié: 9-14» es UNA lista de días y partirla se cargaría sus horas. Solo corta
  // la coma que lleva detrás otro día CON SUS DOS PUNTOS, que es la firma de
  // «aquí empieza otro horario».
  const CORTE_DE_COMA =
    /,(?=\s*(?:lun|mar|mie|jue|vie|sab|dom|mon|tue|wed|thu|fri|sat|sun)[a-z]*\s*(?:[-–a]\s*[a-z]+)?\s*:)/;

  return [...sinParentesis.split(new RegExp(`[;|\\n]+|\\.(?!\\d)|${CORTE_DE_COMA.source}`)), ...notas]
    .map((x) => x.trim())
    .filter(Boolean);
}

/** Los rangos horarios de un tramo, en minutos desde medianoche. */
function rangosDelTramo(tramo) {
  const rangos = [];
  // "10:00-18:00", "10.00 a 18.00", "9am-5pm", "10:00 - 16:00"
  const re = /(\d{1,2})[:.]?(\d{2})?\s*(am|pm)?\s*(?:-|a|al|to|hasta|–)\s*(\d{1,2})[:.]?(\d{2})?\s*(am|pm)?/g;
  let m;
  while ((m = re.exec(tramo)) !== null) {
    const enMinutos = (h, min, ampm) => {
      let hora = Number(h);
      if (!Number.isInteger(hora) || hora > 24) return null;
      if (ampm === 'pm' && hora < 12) hora += 12;
      if (ampm === 'am' && hora === 12) hora = 0;
      const mm = min === undefined ? 0 : Number(min);
      if (mm > 59) return null;
      return hora * 60 + mm;
    };
    const desde = enMinutos(m[1], m[2], m[3]);
    let hasta = enMinutos(m[4], m[5], m[6] ?? m[3]);
    if (desde == null || hasta == null) continue;

    // UN HORARIO PUEDE CRUZAR LA MEDIANOCHE, Y LOS DE COMER LO HACEN SIEMPRE.
    //
    // EL FALLO QUE ORIGINA ESTO. La «Taverna tradicional en Anafiotika» abre
    // «Generalmente 12:00 a 00:00» y el lector la daba por ilegible: el final
    // (0 min) es menor que el principio (720), así que el rango se tiraba y el
    // sitio se quedaba sin horario. De ahí salió el «cierra a las 12:00» que
    // dejó una comida puesta a una hora supuestamente imposible… en un sitio que
    // a las dos de la tarde está abierto de par en par.
    //
    // Le pasa a media hostelería: «18:00 a 02:00», «20:00 - 01:00». Un final
    // menor que el principio no es un dato roto, es la madrugada siguiente.
    if (hasta <= desde) {
      // Salvo que sea exactamente el mismo minuto, que sí es un dato roto.
      if (hasta === desde) continue;
      hasta += 24 * 60;
    }

    rangos.push([desde, hasta]);
  }
  return rangos;
}

/**
 * ¿ESTE TRAMO ES DE UNA TEMPORADA CONCRETA?
 *
 * EL FALLO QUE ORIGINA ESTO. La Fortaleza de Palamidio —el imprescindible
 * estrella de Nafplio— se fue del plan por «estar cerrada a las 16:00», leyendo
 * esto:
 *
 *     «Verano: 08:00 - 20:00 | Invierno: 08:30 - 15:30»
 *
 * El lector no sabía que eran DOS horarios alternativos, así que se quedó con el
 * último que vio: el de invierno. Y el viaje era el 24 de septiembre, cuando en
 * Grecia rige el de verano hasta las ocho de la tarde. La expulsión fue en falso
 * y se perdió el motivo de la parada.
 *
 * Devuelve los meses en los que manda ese tramo, o null si no habla de
 * temporadas —que es lo normal—.
 */
function temporadaDelTramo(tramo) {
  // Si el propio texto da los meses, mandan ellos: «de abril a octubre».
  const suyos = mesesDeTexto(tramo);
  const nombraMeses = Boolean(suyos?.length);

  const esVerano = /\b(verano|temporada alta|summer|high season|estival)\b/.test(tramo);
  const esInvierno = /\b(invierno|temporada baja|winter|low season|invernal)\b/.test(tramo);

  // «MAR» ES MARTES ANTES QUE MARZO, Y ESO CASI CUESTA UN MUSEO.
  //
  // `mesesDeTexto('Mar-Dom: 10:00 - 18:00')` devuelve [3]: lee «Mar» como marzo.
  // Es la única abreviatura del español que colisiona —«mié», «jue», «vie»,
  // «sáb», «dom» y «lun» no son meses— pero le toca al horario más común que
  // existe, «de martes a domingo».
  //
  // Convertía ese tramo en «esto solo rige en marzo», y en cuanto se pregunta por
  // otro mes el tramo deja de aplicar: el Museo del Ámbar de Gdansk salía
  // «cierra los domingos» citando un horario que dice «Mar-Dom», contradiciéndose
  // en la misma frase. Es el mismo pecado que ya tiene su comentario en
  // `avisosDeCierre`, por otra puerta.
  //
  // La regla: un tramo que ENUMERA DÍAS DE LA SEMANA no habla de temporadas, por
  // mucho que una de sus palabras se parezca a un mes. Para ser de temporada
  // tiene que decirlo con todas las letras —«verano», «invierno»— o dar meses
  // sin nombrar días.
  if (!esVerano && !esInvierno && diasDelTramo(tramo).size) return null;

  if (!esVerano && !esInvierno) return nombraMeses ? suyos : null;
  if (nombraMeses) return suyos;

  // El reparto de por defecto, hemisferio norte. Es una convención, no una
  // verdad, y por eso el que la usa lo dice en el aviso suave.
  return esVerano ? [4, 5, 6, 7, 8, 9, 10] : [11, 12, 1, 2, 3];
}

/**
 * EL HORARIO, DÍA A DÍA Y EN ESTRUCTURA.
 *
 * Devuelve los siete días, cada uno con su estado y sus rangos:
 *
 *   abierto     · con `rangos` si el texto los daba, vacío si solo decía el día.
 *   cerrado     · el texto lo dice.
 *   desconocido · el texto no habla de ese día y tampoco permite deducirlo.
 *
 * LOS TRES ESTADOS SON EL ARREGLO, no un detalle de tipos. Con dos —abierto o
 * cerrado— cualquier duda acaba convertida en un cierre, y un cierre inventado
 * echa un sitio del viaje. Con el tercero, la duda se puede tratar como lo que
 * es: se coloca el sitio y se avisa flojito.
 */
export function horarioPorDias(texto, mes = null) {
  const t = normalizar(texto);
  const porDia = TODOS_LOS_DIAS.map(() => ({ estado: 'desconocido', rangos: [] }));
  if (!t.trim()) return { porDia, fiable: false, temporadaDudosa: false };

  let huboApertura = false;
  let huboCierre = false;
  let porDefecto = null;
  // Los números ya leídos no los pisa una palabra: ver la guarda de más abajo.
  let porDefectoEsDeNumeros = false;
  let temporadaDudosa = false;
  // El texto dice, con todas las letras, que el sitio no se puede visitar.
  let cerradoDeclarado = false;

  // LOS TRAMOS QUE HABLAN DE TEMPORADA SE RESUELVEN ANTES DE NADA.
  //
  // Sin esto, dos horarios alternativos se leían como uno detrás de otro y
  // ganaba el último: el de invierno, en un viaje de septiembre.
  const todos = tramosDe(t);
  const conTemporada = todos.map((x) => ({ tramo: x, meses: temporadaDelTramo(x) }));
  const hayTemporadas = conTemporada.some((x) => x.meses);

  let tramos = todos;
  if (hayTemporadas) {
    if (mes == null) {
      // No se sabe cuándo se va: se coge el horario MÁS AMPLIO y se avisa. Lo
      // contrario —quedarse con el restrictivo— es lo que echó a Palamidio.
      temporadaDudosa = true;
      tramos = [
        conTemporada
          .filter((x) => x.meses)
          .sort((a, b) => {
            const ancho = (y) =>
              rangosDelTramo(y.tramo).reduce((n2, [d, h]) => n2 + (h - d), 0);
            return ancho(b) - ancho(a);
          })[0].tramo,
        ...conTemporada.filter((x) => !x.meses).map((x) => x.tramo),
      ];
    } else {
      // EL TRAMO DE TEMPORADA ES LA EXCEPCIÓN, Y UNA EXCEPCIÓN VA LA ÚLTIMA.
      //
      // EL FALLO QUE ORIGINA ESTO, y lo enseñó el viaje 105 en Tesalónica. Con
      // «Todo el año: 09:00 - 17:00 (Martes cerrado en invierno)» salía esto:
      //
      //     enero      martes ABIERTO    ← y el texto dice que cierra
      //     septiembre martes CERRADO    ← y septiembre no es invierno
      //
      // Invertido en los dos sentidos, y por dos motivos que se sumaban:
      //
      //   1. Cuando la temporada SÍ tocaba, el tramo estacional se ponía el
      //      PRIMERO y el general venía detrás y lo pisaba. Una excepción que se
      //      lee antes que la regla no es una excepción: es ruido.
      //   2. Cuando NO tocaba, `tramos = todos` lo dejaba puesto —y encima el
      //      último, o sea ganando—. Aplicar el horario de invierno en
      //      septiembre es justo lo que expulsó a Palamidio en su día.
      //
      // Y no era cosmético: el aviso decía «cierra los martes» con el sitio
      // colocado un martes, la recolocación lo movía al mismo martes porque ella
      // lee sin mes, y los dos avisos sobrevivieron TRES pasadas de revisión sin
      // converger. El motor peleando consigo mismo.
      const aplicables = conTemporada.filter((x) => x.meses?.includes(Number(mes)));
      const generales = conTemporada.filter((x) => !x.meses);

      if (aplicables.length || generales.length) {
        tramos = [...generales.map((x) => x.tramo), ...aplicables.map((x) => x.tramo)];
      } else {
        // Todos hablaban de temporada y ninguno es de este mes: no se sabe qué
        // rige. Se leen todos —el lector se queda con lo más amplio— y se avisa.
        tramos = todos;
        temporadaDudosa = true;
      }
    }
  }

  // ¿ESTO ENUMERA LOS DÍAS QUE ABRE, O ES UNA NOTA SOBRE UNA EXCEPCIÓN?
  //
  // EL FALLO QUE ORIGINA ESTO. El Museo de la Acrópolis dice «Variable (Vie.
  // hasta las 22:00 en verano)» y salía CERRADO de lunes a jueves y el fin de
  // semana, con `fiable` en true. Un cierre inventado y afirmado con plena
  // confianza, que es lo que expulsa un imprescindible sin que nadie se entere:
  // el mismo pecado del «Mi-Dom».
  //
  // El viernes de ese texto no sale de una enumeración: sale de una NOTA sobre
  // cuándo se alarga el horario en verano. La regla 2 de más abajo —«la lista es
  // la lista: lo que no está, cierra»— vale para «Mié-Dom: 10:00-18:00», donde
  // nombrar días SÍ es enumerar los que abre. Aquí no, y nadie lo distinguía.
  //
  // AQUÍ ESTABA LA PUERTA, SIN ENCHUFAR. En su sitio vivía un `exclusivo` que
  // se calculaba y no se usaba en ninguna línea del fichero: alguien penso esto
  // mismo y se quedó a medias. No servía tal cual —exigía un «solo» o un «abre
  // de» que un horario normal no lleva, así que «Mié-Dom» habría dejado de
  // cerrar lunes— porque la pregunta buena es la contraria: no «¿es una lista
  // exclusiva?» sino «¿se declara este texto incompleto?».
  const esUnaNota = NO_ES_UNA_LISTA.some((p2) => t.includes(p2));

  // EL RECINTO ABIERTO 24 H NO LO RECORTA UNA DE SUS PARTES.
  //
  // «Abierto 24 horas (Exteriores). Atracciones: Mar–Dom 11:00–19:00» salía
  // 11:00–19:00 de martes a domingo: la frase de las atracciones pisaba la del
  // recinto, y la Fortaleza de Kalemegdan, el #1 de Belgrado, se quedó fuera
  // del viaje por no caber en ese horario. Lo mismo el parque Kasai Rinkai,
  // cerrado los miércoles porque cierra su acuario, o Checkpoint Charlie a las
  // horas de su museo.
  //
  // Así que una vez dicho que el sitio entero —sin nombrar días— abre siempre,
  // lo que venga después sobre una parte no lo cierra ni lo acorta. Solo lo
  // cierra un cierre del sitio entero («cerrado por obras»).
  let abiertoSiempre = false;

  for (const tramo of tramos) {
    const esDeCierre = CIERRE.some((p2) => tramo.includes(p2));
    const dias = diasDelTramo(tramo);
    const rangos = rangosDelTramo(tramo);

    if (abiertoSiempre && !(esDeCierre && CERRADO_DEL_TODO.test(tramo) && !dias.size)) continue;

    // CERRADO Y PUNTO: los siete días, y con confianza.
    //
    // Va lo primero porque no admite matices: si el sitio está en obras, da
    // igual lo que diga el resto del texto. Y se marca `huboCierre` para que el
    // horario salga FIABLE: un «no lo sé» aquí es lo que metió los Baños de
    // Pasha en el plan del viaje 109.
    if (esDeCierre && CERRADO_DEL_TODO.test(tramo) && !dias.size) {
      for (const d of TODOS_LOS_DIAS) porDia[d] = { estado: 'cerrado', rangos: [] };
      huboCierre = true;
      cerradoDeclarado = true;
      continue;
    }

    if (!esDeCierre && DE_SOL_A_SOL.test(tramo) && !rangos.length) {
      for (const d of TODOS_LOS_DIAS) porDia[d] = { estado: 'abierto', rangos: [[7 * 60, 17 * 60]] };
      huboApertura = true;
      continue;
    }

    if (!esDeCierre && (SIEMPRE.some((p2) => tramo.includes(p2)) || SIEMPRE_EXACTO.test(tramo))) {
      // «SIEMPRE» ES UN HORARIO, NO UN HUECO.
      //
      // Si el tramo no da horas —«Abierto 24h», «Acceso libre»— el día se
      // quedaba abierto pero SIN RANGOS, y `abiertoA` contesta null a todo lo
      // que no tiene rangos: «abre, pero no sabemos entre qué horas». Para un
      // faro o un sendero sí lo sabemos: a cualquiera. Sin esto, la mitad del
      // arreglo de los sitios al aire libre se quedaba a medias — el día salía
      // bien y la hora seguía siendo un «compruébalo».
      const deVerdad = rangos.length ? rangos : [[0, 24 * 60]];
      for (const d of TODOS_LOS_DIAS) porDia[d] = { estado: 'abierto', rangos: deVerdad };
      huboApertura = true;
      if (!rangos.length && !dias.size) abiertoSiempre = true;
      continue;
    }

    if (!dias.size) {
      // Unas horas sin día delante valen para los días que no digan otra cosa.
      if (!esDeCierre && rangos.length) {
        porDefecto = rangos;
        porDefectoEsDeNumeros = true;
      } else if (!esDeCierre && !porDefectoEsDeNumeros) {
        // Y SI NO HAY NÚMEROS, LAS FRANJAS QUE SE DICEN CON PALABRAS.
        //
        // «Almuerzo y cena» no trae un solo dígito y dejaba el sitio sin horario,
        // colocable a cualquier hora. Aquí se traduce a sus tramos.
        //
        // LOS NÚMEROS MANDAN SIEMPRE, y por eso está el `porDefectoEsDeNumeros`:
        // «Almuerzos y cenas (13:00 - 23:00)» trae las dos cosas, y el paréntesis
        // se lee DESPUÉS por cómo parte `tramosDe`. Sin esta guarda, unas horas
        // exactas ya leídas podían quedar pisadas por las de la palabra según el
        // orden en que viniera escrito el texto.
        const franjas = franjasConNombre(tramo);
        if (franjas.length) porDefecto = franjas;
      }
      continue;
    }

    for (const d of dias) {
      porDia[d] = esDeCierre ? { estado: 'cerrado', rangos: [] } : { estado: 'abierto', rangos };
    }
    if (esDeCierre) huboCierre = true;
    else huboApertura = true;
  }

  // Lo que quede sin decidir, en este orden:
  for (const d of TODOS_LOS_DIAS) {
    if (porDia[d].estado !== 'desconocido') continue;

    // 1. Unas horas sueltas sin día valen para todos los que faltan.
    if (porDefecto) {
      porDia[d] = { estado: 'abierto', rangos: porDefecto };
      continue;
    }
    // 2. Si el texto ENUMERA días abiertos, la lista es la lista: lo que no
    //    está, cierra. Es como se leen «Vie a Dom» y «Mié-Dom: 10:00-18:00».
    //
    //    SALVO QUE EL TEXTO SE HAYA DECLARADO INCOMPLETO. Entonces el día que
    //    nombra es una excepción y no una lista, y los demás se quedan en
    //    DESCONOCIDO — que es lo que de verdad se sabe de ellos: nada. El sitio
    //    se coloca igual y se avisa flojito; lo que no se hace es cerrarlo.
    if (huboApertura && !esUnaNota) {
      porDia[d] = { estado: 'cerrado', rangos: [] };
      continue;
    }
    // 3. Y si lo único que dice el texto son excepciones —«cerrado los
    //    lunes»—, el resto de la semana abre.
    if (huboCierre) porDia[d] = { estado: 'abierto', rangos: [] };
  }

  // LA REGLA DE ORO, TAMBIÉN AQUÍ. Antes vivía solo en `diasQueCierra`, que sí
  // devolvía null al ver los siete cerrados… y el lienzo no usa esa función: usa
  // esta. Así que la red estaba puesta donde nadie se caía.
  //
  // Ningún sitio publica un horario para decir que no abre nunca. Si sale eso, lo
  // que está mal es la lectura, y lo honesto es decir que no se sabe: con
  // «desconocido» el sitio se coloca igual y se avisa flojito, que es la regla de
  // la casa. Marcarlo cerrado lo borra del viaje sin que nadie pueda discutirlo.
  //
  // CON UNA EXCEPCIÓN, Y SOLO UNA: que el texto lo DIGA. «Cerrado por
  // restauración permanente» no es una lectura fallida, es la frase entera, y
  // convertirla en «no lo sé» es lo que metió los Baños de Pasha de Tesalónica
  // en el plan del viaje 109 —diez minutos a las 12:30 en un edificio en obras—.
  //
  // La regla de oro sigue protegiendo todo lo demás, que es para lo que está:
  // aquí no se deduce el cierre de la ausencia de datos, se lee de una frase.
  if (!cerradoDeclarado && TODOS_LOS_DIAS.every((d) => porDia[d].estado === 'cerrado')) {
    return {
      porDia: TODOS_LOS_DIAS.map(() => ({ estado: 'desconocido', rangos: [] })),
      fiable: false,
      temporadaDudosa,
    };
  }

  return { porDia, fiable: huboApertura || huboCierre || Boolean(porDefecto), temporadaDudosa };
}

/**
 * ¿ABRE ESTE DÍA? true / false / null cuando el texto no lo dice.
 *
 * `null` NO es «cerrado». Quien lo reciba tiene que colocar el sitio igual y
 * avisar flojito: afirmar un cierre que el horario no dice es exactamente lo
 * que echó del viaje a dos museos que abrían.
 */
export function abreEl(texto, diaSemana, mes = null) {
  const { porDia, fiable } = horarioPorDias(texto, mes);
  if (!fiable) return null;
  const d = porDia[Number(diaSemana)];
  if (!d || d.estado === 'desconocido') return null;
  return d.estado === 'abierto';
}

/** ¿Y a esta hora? Mismos tres estados. `hora` en «HH:MM» o en minutos. */
export function abiertoA(texto, diaSemana, hora, mes = null) {
  const abre = abreEl(texto, diaSemana, mes);
  if (abre !== true) return abre;

  const { porDia } = horarioPorDias(texto, mes);
  const rangos = porDia[Number(diaSemana)].rangos;
  if (!rangos.length) return null; // abre, pero no sabemos entre qué horas

  const m =
    typeof hora === 'number'
      ? hora
      : (() => {
          const x = /^(\d{1,2}):(\d{2})$/.exec(String(hora ?? '').trim());
          return x ? Number(x[1]) * 60 + Number(x[2]) : null;
        })();
  if (m == null) return null;

  return rangos.some(([desde, hasta]) => m >= desde && m < hasta);
}

/** Los días que abre. Se mantiene por lo que ya lo usaba. */
export function diasQueAbre(texto) {
  const { porDia, fiable } = horarioPorDias(texto);
  if (!fiable) return null;
  const abiertos = TODOS_LOS_DIAS.filter((d) => porDia[d].estado === 'abierto');
  return abiertos.length ? abiertos : null;
}

/**
 * LOS DÍAS QUE CIERRA, que es lo que guarda la ficha.
 *
 * Solo los que el horario dice que cierran. Un día «desconocido» NO entra aquí:
 * esa es toda la diferencia entre avisar y expulsar.
 */
export function diasQueCierra(texto) {
  const { porDia, fiable } = horarioPorDias(texto);
  if (!fiable) return null;

  const cerrados = TODOS_LOS_DIAS.filter((d) => porDia[d].estado === 'cerrado');

  // LA REGLA DE ORO. Si sale que cierra los siete, la lectura está mal: ningún
  // sitio publica un horario para decir que nunca abre.
  if (cerrados.length >= 7) return null;
  return cerrados;
}

// =============================================================================
// LO QUE SOLO EXISTE A SUS HORAS
// =============================================================================

/**
 * LAS HORAS DE LOS PASES, SI EL TEXTO LAS DA.
 *
 * EL FALLO QUE ORIGINA ESTO. La revisión del lienzo movió un espectáculo
 * nocturno de luces —con pases a horas fijas— a las 09:00 de la mañana de otro
 * día para deshacer un solape. El movimiento comprobó el cierre del sitio y el
 * tope del día, que era todo lo que sabía comprobar, y pasó por alto lo único
 * que importaba: que a las nueve de la mañana ese espectáculo no existe.
 *
 * Un horario de apertura dice ENTRE QUÉ HORAS se puede ir; una lista de pases
 * dice A QUÉ HORAS exactas, y son cosas distintas. Se distinguen porque el texto
 * las nombra: «pases», «sesiones», «shows», «funciones», «salidas».
 *
 * Devuelve null cuando el texto no habla de pases, que es lo normal: la mayoría
 * de los sitios se visitan cuando uno quiera dentro de su horario.
 */
export function horasDeSesion(texto) {
  const t = normalizar(texto);
  if (!t.trim()) return null;

  // Sin una de estas palabras, las horas que haya son un horario de apertura y
  // no unos pases. Confundirlos clavaría un museo a la hora de abrir.
  const HABLA_DE_PASES = /\b(pases?|sesion|sesiones|show|shows|funcion|funciones|espectaculos?|salidas?|screenings?|performances?)\b/;
  if (!HABLA_DE_PASES.test(t)) return null;

  // Un rango («de 20:00 a 22:00») es un horario, no un pase: se descarta el
  // segundo número de cada rango mirando qué hay entre las dos horas.
  const horas = [];
  const re = /(\d{1,2})[:.]?(\d{2})?\s*(am|pm|h)?/g;
  let m;
  while ((m = re.exec(t)) !== null) {
    const crudo = Number(m[1]);
    if (!Number.isInteger(crudo) || crudo > 24) continue;
    // Un número suelto sin minutos, sin am/pm y sin "h" no es una hora.
    if (m[2] === undefined && !m[3]) continue;

    let h = crudo;
    if (m[3] === 'pm' && h < 12) h += 12;
    if (m[3] === 'am' && h === 12) h = 0;
    if (h > 23) continue;

    const min = m[2] === undefined ? 0 : Number(m[2]);
    if (min > 59) continue;

    horas.push({
      texto: `${String(h).padStart(2, '0')}:${String(min).padStart(2, '0')}`,
      desde: m.index,
      hasta: re.lastIndex,
    });
  }

  const sueltas = [];
  for (let i = 0; i < horas.length; i += 1) {
    const enMedio = i ? t.slice(horas[i - 1].hasta, horas[i].desde) : '';
    // Si viene detrás de un separador de rango, es el final de un horario.
    if (/^\s*(?:-|a|al|to|hasta)\s*$/.test(enMedio)) continue;
    sueltas.push(horas[i].texto);
  }

  const unicas = [...new Set(sueltas)].sort();
  return unicas.length ? unicas : null;
}

/** Las palabras por las que algo solo se entiende de noche. */
const DE_NOCHE = [
  'nocturn', 'de noche', 'por la noche', 'night', 'evening', 'after dark',
  'fuegos artificiales', 'castillo de fuegos', 'fireworks',
  'espectaculo de luces', 'juego de luces', 'luz y sonido', 'light show',
  'sound and light', 'son et lumiere', 'iluminacion nocturna',
  'atardecer', 'puesta de sol', 'sunset', 'amanecer', 'sunrise',
];

/**
 * ¿ESTO SOLO SE ENTIENDE A ÚLTIMA HORA?
 *
 * Es la red de seguridad de `horasDeSesion`: cuando no hay dato de pases, al
 * menos que un espectáculo nocturno no acabe en una franja de mañana. Se mira el
 * nombre, la descripción y el horario, que es donde está escrito.
 *
 * El amanecer va en la misma lista y por el mismo motivo: tampoco se puede
 * mover, solo que hacia el otro lado. Quien llame decide qué hacer con eso.
 */
export function soloAUltimaHora(...textos) {
  const t = normalizar(textos.filter(Boolean).join(' · '));
  if (!t.trim()) return false;
  return DE_NOCHE.some((p) => t.includes(p));
}

/** Un amanecer no es una cosa de noche, aunque esté en la misma lista. */
export function esDeAmanecer(...textos) {
  const t = normalizar(textos.filter(Boolean).join(' · '));
  return ['amanecer', 'sunrise', 'primera luz'].some((p) => t.includes(p));
}

/**
 * LA HORA A LA QUE ARRANCA UNA EXCURSIÓN, SACADA DE SU PROSA.
 *
 * Civitatis casi nunca rellena el campo «Horario» de la ficha —lo enseña en el
 * calendario de reserva, después de elegir día— pero SÍ lo dice en el itinerario:
 * «Tras recogeros en vuestro hotel de Túnez sobre las 8:00 horas…». Ese dato
 * estaba en la base, entero, y no lo leía nadie: la excursión a Dougga se colocó
 * a las 07:30 porque el modelo no tenía la hora y se la inventó.
 *
 * POR QUÉ NO VALE `horasDeSesion`. Aquella exige que el texto hable de pases o
 * sesiones, y hace bien: sin esa guarda clavaría cualquier museo a su hora de
 * apertura. Una descripción de excursión no dice «sesiones», dice «os
 * recogeremos». Son dos lecturas distintas del mismo tipo de dato.
 *
 * LO QUE HACE FALTA ACERTAR ES CUÁL DE LAS HORAS. La misma descripción suele
 * traer la de vuelta —«Regresaremos a Túnez en torno a las 16:00»— y coger la
 * primera o la última del texto acierta unas veces y otras no. Así que la hora
 * no se busca sola: se busca UNA PALABRA DE SALIDA y la hora que va con ella,
 * cerca y por detrás.
 *
 * Y las palabras de regreso descalifican: si entre la palabra de salida y la
 * hora se ha colado un «regreso», esa hora es de otra frase.
 *
 * Devuelve «HH:MM» o null. Null es una respuesta normal y frecuente: muchas
 * fichas no dicen la hora en ninguna parte, y para eso está el suelo del día.
 */

/** Lo que anuncia que una hora es de SALIDA. */
const DE_SALIDA = [
  'recogid', 'recogida', 'recogeros', 'recogeremos', 'os recogemos', 'te recogemos',
  'salida', 'saldremos', 'partiremos', 'partida', 'comenzaremos', 'comenzara',
  'empezaremos', 'empezara', 'iniciaremos', 'inicio', 'nos encontraremos',
  'quedaremos', 'cita', 'punto de encuentro', 'pick up', 'pickup',
];

/** Lo que anuncia que una hora es de VUELTA, y por tanto no sirve. */
const DE_REGRESO = [
  'regres', 'volvere', 'vuelta', 'retorno', 'de vuelta', 'llegada al hotel',
  'os dejaremos', 'te dejaremos', 'finaliza', 'finalizara', 'termina', 'terminara',
  'fin de la actividad', 'de regreso',
];

/** Cuántos caracteres puede haber entre la palabra de salida y su hora. */
const CERCA = 120;

export function horaDeInicioDeExcursion(...textos) {
  // LA FICHA ACABA DONDE EMPIEZA LO DE LOS DEMÁS. Detrás de la descripción
  // Civitatis pega «También te puede interesar» y las opiniones de los
  // clientes, y ahí hay cifras de sobra: «1950 viajeros» salió como las 19:50.
  let t = normalizar(textos.filter(Boolean).join(' · '));
  for (const corte of ['tambien te puede interesar', 'opiniones de nuestros clientes']) {
    const i = t.indexOf(corte);
    if (i >= 0) t = t.slice(0, i);
  }
  if (!t.trim()) return null;

  // Las horas del texto, con su posición. UNA HORA SE ESCRIBE COMO HORA: con
  // sus minutos detrás de «:» o «.» (8:00, 7.45), con am/pm, o «a las 8».
  //
  // Antes el separador era opcional y valía «horas», y eso leía horas donde no
  // las hay. Medido sobre las 67 fichas de la base, 15 de 20 horas eran falsas:
  //
  //     «1950 viajeros»                →  19:50
  //     «Brsalje ul. 3, 20000 Dubrovnik» →  20:00   (el código postal)
  //     «12 horas más tarde»           →  12:00   (la duración)
  //     «10 horas después de la recogida» → 10:00, y la ficha decía «a las 7:45»
  //
  // Un precio con decimales (10.60 EUR) tampoco es una hora.
  const horas = [];
  const apuntar = (crudo, minutos, sufijo, en) => {
    let h = Number(crudo);
    if (!Number.isInteger(h) || h > 24) return;
    const ampm = sufijo ? sufijo.replace(/[.\s]/g, '') : null;
    if (ampm === 'pm' && h < 12) h += 12;
    if (ampm === 'am' && h === 12) h = 0;
    if (h > 23) return;
    const min = minutos === undefined ? 0 : Number(minutos);
    if (min > 59) return;
    horas.push({ texto: `${String(h).padStart(2, '0')}:${String(min).padStart(2, '0')}`, en });
  };

  const conMinutos = /(?<![\d.,])(\d{1,2})[:.](\d{2})(?![\d.,]\d)(?!\s*(?:€|eur|euros|km|%))\s*(am|pm|a\.\s?m\.|p\.\s?m\.)?/g;
  const conAmPm = /(?<![\d.,:])(\d{1,2})\s*(am|pm|a\.\s?m\.|p\.\s?m\.)(?![a-z])/g;
  const aLas = /\blas (\d{1,2})(?![\d:.,])(?!\s*(?:horas|hora|h\b|minutos|min\b|personas|plazas))/g;
  let m;
  while ((m = conMinutos.exec(t)) !== null) apuntar(m[1], m[2], m[3], m.index);
  while ((m = conAmPm.exec(t)) !== null) apuntar(m[1], undefined, m[2], m.index);
  while ((m = aLas.exec(t)) !== null) apuntar(m[1], undefined, null, m.index + 4);
  horas.sort((x, y) => x.en - y.en);
  if (!horas.length) return null;

  // Para cada palabra de salida, la primera hora que venga DETRÁS y cerca.
  let mejor = null;
  for (const palabra of DE_SALIDA) {
    let desde = 0;
    for (;;) {
      const i = t.indexOf(palabra, desde);
      if (i < 0) break;
      desde = i + palabra.length;

      const suya = horas.find((x) => x.en >= i && x.en - i <= CERCA);
      if (!suya) continue;

      // Si entre la palabra y la hora se ha colado un regreso, esa hora es de
      // otra frase: «saldremos del hotel … y regresaremos sobre las 16:00».
      const enMedio = t.slice(i, suya.en);
      if (DE_REGRESO.some((p) => enMedio.includes(p))) continue;

      // La más temprana de las candidatas: una excursión empieza una vez.
      if (!mejor || suya.en < mejor.en) mejor = suya;
    }
  }

  return mejor?.texto ?? null;
}

/**
 * ¿VIENEN A BUSCARTE AL HOTEL?
 *
 * Importa porque decide si hay que salir antes: a una recogida en la puerta no
 * se llega con antelación, se baja. Un punto de encuentro, sí.
 *
 * SE EXIGE EVIDENCIA POSITIVA en el texto, y no basta con que
 * `punto_encuentro` esté vacío: vacío también es «esta ficha no se ha pedido
 * nunca» y «es una entrada de museo que no tiene ninguno». Un campo que no está
 * no afirma nada.
 */
const RECOGIDA = [
  'recogida en el hotel', 'recogida y traslado al hotel', 'recogida en vuestro hotel',
  'recogida en su hotel', 'recogida en tu hotel',
  'recogeros en vuestro hotel', 'recogeros en su hotel', 'recogerte en tu hotel',
  'recogida desde el hotel', 'pick up en el hotel',
  'traslado desde el hotel', 'recogida en los hoteles',
];

// Y LA FORMA LIBRE: «pasaremos a recogeros por vuestro hotel», «recogida y
// traslado de regreso al hotel». La lista no las cogía, y la excursión a Mostar
// desde Sarajevo salía sin recogida. Al revés, «os recogeremos en» a secas
// casaba con «os recogeremos en el punto de encuentro de Atenas»: sin la
// palabra hotel detrás no es una recogida en el hotel.
const RECOGIDA_LIBRE = [
  /recog\w*\s+(?:\S+\s+){0,3}?(?:en|por|desde)\s+(?:el|vuestro|vuestros|tu|su|sus|los)\s+hotel/,
  /recogida y traslado (?:de regreso )?al hotel/,
];

export function hayRecogidaEnHotel(...textos) {
  const t = normalizar(textos.filter(Boolean).join(' · '));
  if (!t.trim()) return false;
  return RECOGIDA.some((p) => t.includes(p)) || RECOGIDA_LIBRE.some((re) => re.test(t));
}
