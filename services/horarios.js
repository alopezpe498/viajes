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
 */
function tramosDe(t) {
  const notas = [];
  // Los paréntesis, fuera y cada uno por su cuenta.
  const sinParentesis = t.replace(/\(([^)]*)\)/g, (_, dentro) => {
    notas.push(dentro.trim());
    return ' ; ';
  });

  return [...sinParentesis.split(/[;|\n]+/), ...notas]
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
    const hasta = enMinutos(m[4], m[5], m[6] ?? m[3]);
    if (desde == null || hasta == null || hasta <= desde) continue;
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
  let temporadaDudosa = false;

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
      const suyos = conTemporada.filter((x) => x.meses?.includes(Number(mes)));
      tramos = suyos.length
        ? [...suyos.map((x) => x.tramo), ...conTemporada.filter((x) => !x.meses).map((x) => x.tramo)]
        : todos;
      if (!suyos.length) temporadaDudosa = true;
    }
  }

  const exclusivo =
    /\b(solo|unicamente|only|exclusivamente)\b/.test(t) || /\babre\s+(de|los|el)\b/.test(t);

  for (const tramo of tramos) {
    const esDeCierre = CIERRE.some((p2) => tramo.includes(p2));
    const dias = diasDelTramo(tramo);
    const rangos = rangosDelTramo(tramo);

    if (!esDeCierre && SIEMPRE.some((p2) => tramo.includes(p2))) {
      for (const d of TODOS_LOS_DIAS) porDia[d] = { estado: 'abierto', rangos };
      huboApertura = true;
      continue;
    }

    if (!dias.size) {
      // Unas horas sin día delante valen para los días que no digan otra cosa.
      if (!esDeCierre && rangos.length) porDefecto = rangos;
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
    if (huboApertura) {
      porDia[d] = { estado: 'cerrado', rangos: [] };
      continue;
    }
    // 3. Y si lo único que dice el texto son excepciones —«cerrado los
    //    lunes»—, el resto de la semana abre.
    if (huboCierre) porDia[d] = { estado: 'abierto', rangos: [] };
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
