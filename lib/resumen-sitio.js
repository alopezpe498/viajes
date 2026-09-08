/**
 * lib/resumen-sitio.js
 * -----------------------------------------------------------------------------
 * RESUMIR LOS DATOS DUROS PARA QUE QUEPAN EN UNA LÍNEA.
 *
 * La tarjeta de un sitio enseña una foto, un nombre y una descripción. Cuando se
 * le añadieron el precio, el horario, la duración, el teléfono y la web en dos
 * columnas, los datos ocupaban media tarjeta y la lista dejó de poder recorrerse
 * de un vistazo. Aquí se reducen a tres piezas cortas: precio, horario y visita.
 *
 * ESTO NO GUARDA NADA NI CONSULTA NADA. Recibe el texto tal y como lo devolvió la
 * búsqueda y devuelve una versión corta para pintar. El texto completo sigue
 * intacto donde estaba, y se enseña entero en «Ver detalle»: aquí no se pierde
 * información, solo se elige qué cabe en la primera mirada.
 *
 * Y SE RESUME SIN INVENTAR. Si de un texto no se reconoce un precio o una hora,
 * no se adivina: se recorta el propio texto. Prefiero un resumen feo y fiel a uno
 * bonito que diga algo que la búsqueda no dijo.
 */

/** Los días como los cuenta JavaScript: 0 es domingo. */
const DIAS_CORTOS = ['do', 'lu', 'ma', 'mi', 'ju', 'vi', 'sá'];

const DIAS_LARGOS = [
  'domingo',
  'lunes',
  'martes',
  'miércoles',
  'jueves',
  'viernes',
  'sábado',
];

/** Lo que se pinta cuando no se reconoce el formato: el texto, pero corto. */
function recorte(texto, tope = 28) {
  const limpio = String(texto ?? '')
    .replace(/\s+/g, ' ')
    .trim();
  if (!limpio) return null;
  // Se corta por donde el texto ya se corta solo: un paréntesis o un punto
  // suelen abrir el matiz, y el matiz es justo lo que aquí sobra.
  const corto = limpio.split(/\s*[(.]/)[0].trim() || limpio;
  return corto.length > tope ? corto.slice(0, tope - 1).trimEnd() + '…' : corto;
}

/** Un importe tal y como se escribe aquí: 22 €, 14,80 €, €22, 22€. */
const IMPORTE = /(\d{1,3}(?:[.,]\d{1,2})?)\s*€|€\s*(\d{1,3}(?:[.,]\d{1,2})?)/g;

/**
 * EL PRECIO, sin tramos.
 *
 * «Entre 15 € y 37 € (varía según el piso)» es exacto y no cabe. En la tarjeta
 * interesa el suelo —lo que cuesta entrar— y que se note que hay más detrás:
 * «desde 15 €». El desglose completo está a un clic, en el detalle.
 */
export function resumirPrecio(texto) {
  if (!texto) return null;
  // EL PARÉNTESIS FUERA, Y LO PRIMERO DE TODO. Ahí es donde la búsqueda mete las
  // excepciones, y casi todas hablan de dinero: «(gratis menores de 18 años)»,
  // «(acceso gratuito para la base, pago para subir)», «(14 € en taquilla si hay
  // poca afluencia)». Leyendo el texto entero, el Louvre salía «Gratis» y Orsay
  // «desde 14 €»: las dos, falsas. Lo que cuesta entrar va siempre delante.
  const crudo = String(texto).replace(/\([^)]*\)/g, ' ').replace(/\s+/g, ' ').trim();
  if (!crudo) return recorte(texto, 22);

  if (/\b(gratis|gratuit|entrada libre|sin coste|acceso libre)/i.test(crudo)) return 'Gratis';

  const importes = [...crudo.matchAll(IMPORTE)].map((m) => m[1] ?? m[2]);
  if (!importes.length) return recorte(crudo, 22);

  const enNumero = (s) => Number(String(s).replace(',', '.'));
  const menor = importes.reduce((a, b) => (enNumero(a) <= enNumero(b) ? a : b));
  const bonito = `${String(menor).replace('.', ',')} €`;

  // Hay tramo si lo dice con todas las letras o si quedan varios importes.
  const hayTramo = importes.length > 1 || /\bdesde\b|\ba partir de\b|\bentre\b/i.test(crudo);
  return hayTramo ? `desde ${bonito}` : bonito;
}

/** Una franja horaria: «09:30 a 22:45», «9.30-22.45», «09:30 – 22:45». */
const FRANJA = /(\d{1,2})[:.h](\d{2})\s*(?:a|-|–|—|hasta(?:\s+las)?)\s*(\d{1,2})[:.h](\d{2})/i;

/** Sin el cero de delante, que en una línea apretada estorba. */
const hora = (h, m) => `${Number(h)}:${m}`;

/**
 * EL HORARIO: la franja del día normal y, si cierra algún día, cuál.
 *
 * De «Lun, Jue, Sáb y Dom: 09:00 a 18:00. Mié y Vie: 09:00 a 21:00» se queda la
 * primera franja. No es la verdad completa —hay días que abre más— pero es la
 * que orienta, y la completa está en el detalle.
 *
 * El día de cierre es lo único que se añade, porque es el único dato del horario
 * que puede arruinar una mañana.
 */
export function resumirHorario(texto, cierraDias = null) {
  const crudo = String(texto ?? '');
  const m = crudo.match(FRANJA);
  const franja = m ? `${hora(m[1], m[2])}–${hora(m[3], m[4])}` : franjaSuelta(crudo) ?? recorte(crudo, 24);

  const cierre = diasDeCierre(crudo, cierraDias);
  if (!franja) return cierre ? `Cerrado ${cierre}` : null;
  return cierre ? `${franja} · Cerrado ${cierre}` : franja;
}

/**
 * DE LA PRIMERA HORA A LA ÚLTIMA, cuando no hay una franja que reconocer.
 *
 * Hay horarios que no se escriben como una franja: «abre entre 06:30 y 08:15 y
 * cierra entre 16:30 y 21:30» —un parque, que cambia con la estación— tiene
 * cuatro horas y ninguna pareja. Lo honesto y lo útil coinciden: de la primera
 * hora a la última, que es cuando ese sitio puede estar abierto.
 */
function franjaSuelta(texto) {
  const horas = [...String(texto).matchAll(/(\d{1,2})[:.](\d{2})/g)];
  if (horas.length < 2) return null;
  const primera = horas[0];
  const ultima = horas[horas.length - 1];
  return `${hora(primera[1], primera[2])}–${hora(ultima[1], ultima[2])}`;
}

/**
 * Qué días cierra, en corto.
 *
 * Primero lo que ya se interpretó y quedó guardado, que es lo que usa el lienzo
 * para avisar. Si no está —se interpreta a su ritmo, no al abrir la ficha—, se
 * busca en el propio texto, que suele decirlo.
 */
function diasDeCierre(texto, cierraDias) {
  const guardados = normalizarDias(cierraDias);
  if (guardados) return guardados.map((d) => DIAS_CORTOS[d]).join(', ');

  const encontrados = [];
  for (let i = 0; i < DIAS_LARGOS.length; i += 1) {
    // "Cerrado los martes", "cierra martes", "Cerrado: martes y miércoles".
    const patron = new RegExp(`cerrad[oa]s?[^.]{0,20}\b${DIAS_LARGOS[i]}`, 'i');
    if (patron.test(texto)) encontrados.push(i);
  }
  return encontrados.length ? encontrados.map((d) => DIAS_CORTOS[d]).join(', ') : null;
}

/** `cierra_dias` viaja como texto JSON. Un array vacío es «no cierra», no «no se sabe». */
function normalizarDias(valor) {
  if (valor == null) return null;
  let lista = valor;
  if (typeof valor === 'string') {
    try {
      lista = JSON.parse(valor);
    } catch {
      return null;
    }
  }
  if (!Array.isArray(lista) || !lista.length) return null;
  return lista.filter((d) => Number.isInteger(d) && d >= 0 && d <= 6);
}

/** Números con coma o punto: 1, 1.5, 1,5. */
const CANTIDAD = /\d+(?:[.,]\d+)?/g;

/**
 * EL TIEMPO DE VISITA, en formato corto.
 *
 * «2 - 3 horas» cabe de sobra como «2–3 h», y «1 - 1.5 horas» como «1–1,5 h»,
 * que además se lee como se escribe en español.
 */
export function resumirVisita(texto) {
  if (!texto) return null;
  const crudo = String(texto);
  const cantidades = (crudo.match(CANTIDAD) ?? []).map((n) => n.replace('.', ','));
  if (!cantidades.length) return recorte(crudo, 18);

  const unidad = /\bmin\b|minuto/i.test(crudo) && !/\bhora|\bh\b/i.test(crudo) ? 'min' : 'h';
  const [a, b] = cantidades;
  return b && b !== a ? `${a}–${b} ${unidad}` : `${a} ${unidad}`;
}

/**
 * Las tres piezas de la línea de la tarjeta.
 *
 * Un campo sin datos no sale: la línea es un vistazo, no un formulario, y un
 * guion suelto en medio no informa de nada. Que falte se ve en el detalle, que
 * sí los enseña todos.
 *
 * `flexible` marca quién cede cuando la línea no cabe. Cede el horario, que es
 * el largo —puede llevar franja y día de cierre—, y así «22 €» y «2–3 h» se leen
 * enteros en una tarjeta estrecha en vez de quedar los tres a medias.
 */
export function resumenDeSitio(datos, cierraDias = null) {
  if (!datos) return null;

  const precio = resumirPrecio(datos.precio);
  const horario = resumirHorario(datos.horarios, cierraDias);
  const visita = resumirVisita(datos.tiempoVisita);

  const piezas = [
    precio ? { icono: 'ti-ticket', valor: precio, flexible: false } : null,
    horario ? { icono: 'ti-clock', valor: horario, flexible: true } : null,
    visita ? { icono: 'ti-hourglass', valor: visita, flexible: false } : null,
  ].filter(Boolean);

  return piezas.length ? piezas : null;
}

export default { resumirPrecio, resumirHorario, resumirVisita, resumenDeSitio };
