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
  ['jueves', 4], ['thursdays', 4], ['thursday', 4], ['thurs', 4], ['thur', 4], ['jue', 4], ['thu', 4],
  ['viernes', 5], ['fridays', 5], ['friday', 5], ['vie', 5], ['fri', 5],
  ['sabados', 6], ['sabado', 6], ['saturdays', 6], ['saturday', 6], ['sab', 6], ['sat', 6],
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

/** Lo que significa «siempre». */
const SIEMPRE = [
  'todos los dias', 'todos los d as', 'a diario', 'diariamente', 'todo el ano',
  'every day', 'everyday', 'daily', 'open daily', '24/7', '24 h', 'abierto siempre',
];

/** Las palabras que dan la vuelta al sentido de un tramo. */
const CIERRE = ['cerrado', 'cierra', 'cierre', 'closed', 'except', 'excepto', 'salvo'];

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
 */
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
 * QUÉ DÍAS ABRE, SEGÚN EL TEXTO. Devuelve null cuando el texto no lo dice.
 *
 * `null` y lista vacía no son lo mismo y la diferencia es la que evita el
 * desastre: null es «no lo sé» y quien llama decide (y decide que abre); una
 * lista con días es una respuesta.
 */
export function diasQueAbre(texto) {
  const t = normalizar(texto);
  if (!t.trim()) return null;

  // Los tramos: punto y coma, salto de línea y barra vertical. La coma NO parte,
  // porque «Lun-Vie, Sab» es un solo tramo con un rango y un día suelto.
  const tramos = t.split(/[;|\n]+/).map((x) => x.trim()).filter(Boolean);

  const abre = new Set();
  const cierra = new Set();
  let algoDicho = false;

  for (const tramo of tramos) {
    const esDeCierre = CIERRE.some((p) => tramo.includes(p));
    const dias = diasDelTramo(tramo);

    // «Todos los días» solo cuenta en un tramo que no sea de cierre: «cerrado
    // todos los lunes» no abre toda la semana.
    if (!esDeCierre && SIEMPRE.some((p) => tramo.includes(p))) {
      for (const d of TODOS_LOS_DIAS) abre.add(d);
      algoDicho = true;
      continue;
    }

    if (!dias.size) continue;
    algoDicho = true;
    for (const d of dias) (esDeCierre ? cierra : abre).add(d);
  }

  if (!algoDicho) return null;

  // Un tramo de cierre sin ningún tramo de apertura describe las excepciones de
  // una semana que por lo demás abre: «cerrado los lunes» abre los otros seis.
  const abiertos = abre.size
    ? [...abre].filter((d) => !cierra.has(d))
    : TODOS_LOS_DIAS.filter((d) => !cierra.has(d));

  return abiertos.sort((a, b) => a - b);
}

/**
 * LOS DÍAS QUE CIERRA, que es lo que guarda la ficha. El complemento se calcula
 * AQUÍ, que es el cambio que arregla el fallo del viernes.
 */
export function diasQueCierra(texto) {
  const abre = diasQueAbre(texto);
  if (abre === null) return null;

  // LA REGLA DE ORO. Si la lectura dice que no abre ningún día, la lectura está
  // mal: ningún sitio publica un horario para decir que nunca abre. Se devuelve
  // «no lo sé» y el sitio se queda sin días de cierre, que es el lado seguro del
  // error: molesta encontrarlo cerrado, pero no lo borra del viaje.
  if (!abre.length) return null;

  return TODOS_LOS_DIAS.filter((d) => !abre.includes(d));
}

/** ¿Abre este día de la semana? `null` cuando el texto no permite saberlo. */
export function abreEl(texto, diaSemana) {
  const abre = diasQueAbre(texto);
  if (abre === null || !abre.length) return null;
  return abre.includes(Number(diaSemana));
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
