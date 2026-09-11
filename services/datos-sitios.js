/**
 * services/datos-sitios.js
 * -----------------------------------------------------------------------------
 * LOS DATOS DUROS DE LOS SITIOS: precio, horarios, duración, web y teléfono.
 *
 * La ficha de un sitio se monta con tres fuentes y cada una hace lo suyo:
 *
 *   1. La IA propone QUÉ ver.            (services/descubrir.js)
 *   2. Wikipedia cuenta QUÉ ES.          (jobs/worker.js)
 *   3. Una búsqueda real trae los NÚMEROS. (esto)
 *
 * LA REGLA DE ORO: los datos duros o vienen de la búsqueda o no vienen.
 *
 * La IA participa, pero como traductora, no como fuente: se le da el texto que
 * devolvió Google y se le pide que lo ordene en campos. Tiene prohibido
 * completar lo que no esté escrito ahí. Un horario inventado no se distingue de
 * uno real hasta que te plantas delante de una puerta cerrada, y entonces ya da
 * igual de dónde salió.
 *
 * ES CATÁLOGO. El precio del Castillo de San Jorge no depende de mi viaje, así
 * que se guarda en `sitios_lugar` y lo hereda el siguiente que vaya a Lisboa.
 * Con más de treinta días se sigue enseñando, avisando de que puede haber
 * cambiado: un dato de hace cinco semanas sigue orientando, y esconderlo sería
 * dejar la ficha vacía por prudencia mal entendida.
 */
import { todas, una, ejecutar, normalizarNombre } from '../db/index.js';
import { encolar, trabajoActivo } from '../jobs/cola.js';
import { resumenDeSitio } from '../lib/resumen-sitio.js';
import { consultarJSON, hayClaveIA, SIN_CLAVE } from '../lib/ia.js';
import { buscarTablaDeSitios, ErrorCaptcha } from '../providers/google-busqueda.js';
import { diasQueCierra, horarioPorDias, TODOS_LOS_DIAS } from './horarios.js';

/** A partir de aquí, lo guardado se enseña con un "puede haber cambiado". */
export const DIAS_PARA_AVISAR = 30;

// =============================================================================
// LEER
// =============================================================================
/** Días transcurridos desde una marca de SQLite. Null si no hay marca. */
export function diasDesde(iso) {
  if (!iso) return null;
  const cuando = new Date(String(iso).replace(' ', 'T') + 'Z');
  if (Number.isNaN(cuando.getTime())) return null;
  return Math.floor((Date.now() - cuando.getTime()) / 86_400_000);
}

/**
 * Los datos duros de un sitio, listos para la ficha.
 *
 * Devuelve SIEMPRE los cinco campos, aunque estén vacíos: la ficha necesita
 * saber que un hueco es un hueco para pintar su guion, y no que el campo no
 * existe.
 */
/** Un dominio suelto no es un enlace hasta que lleva esquema delante. */
function enlaceWeb(web) {
  const limpio = String(web ?? '').trim();
  if (!limpio) return null;
  return /^https?:\/\//i.test(limpio) ? limpio : `https://${limpio.replace(/^\/+/, '')}`;
}

export function datosDeSitio(sitio) {
  if (!sitio) return null;

  const dias = diasDesde(sitio.datos_en);
  const hayAlgo = Boolean(
    sitio.precio || sitio.horarios || sitio.tiempo_visita || sitio.web || sitio.telefono
  );

  const completos = {
    precio: sitio.precio ?? null,
    horarios: sitio.horarios ?? null,
    tiempoVisita: sitio.tiempo_visita ?? null,
    web: sitio.web ?? null,
    // LA WEB, CON ESQUEMA. La búsqueda la devuelve casi siempre como dominio
    // pelado —«louvre.fr»—, y un href sin http:// lo resuelve el navegador como
    // ruta relativa: el enlace llevaba a /etapa/louvre.fr, dentro de la propia
    // aplicación. Se enseña el dominio, que se lee mejor, pero se enlaza esto.
    webUrl: enlaceWeb(sitio.web),
    telefono: sitio.telefono ?? null,
    // LO QUE HAY QUE RESERVAR CON TIEMPO. Se saca aparte del resumen porque no
    // es un dato más de la ficha: es lo único que, si se lee tarde, ya no tiene
    // arreglo. La vista lo pinta como distintivo, no como una línea más.
    reserva: sitio.reserva_anticipada ?? null,
    reservaDetalle: sitio.reserva_detalle ?? null,
    reservaAvisa: ['recomendada', 'imprescindible'].includes(sitio.reserva_anticipada),
    reservaRevisada: Boolean(sitio.reserva_en),
    // Trazabilidad: de dónde salió y cuándo. Va a la vista para poder decirlo.
    obtenidoEn: sitio.datos_en ?? null,
    fuente: sitio.datos_fuente ?? null,
    dias,
    hayAlgo,
    // "Buscado y no encontrado" no es lo mismo que "sin buscar todavía": lo
    // primero es un resultado y lo segundo, una espera.
    buscado: Boolean(sitio.datos_en),
    conviejo: hayAlgo && dias != null && dias > DIAS_PARA_AVISAR,
  };

  return {
    ...completos,
    // LA LÍNEA DE LA TARJETA: precio, horario y visita en corto, y solo lo que
    // haya. Es una vista de lo de arriba, no otro dato: nada de esto se guarda
    // ni vuelve a la base. El texto completo se enseña entero en «Ver detalle»,
    // que es donde caben los tramos de precio y los horarios día por día.
    resumen: resumenDeSitio(completos, sitio.cierra_dias),
  };
}

/** ¿Hay una búsqueda de datos en marcha para esta ciudad? */
export function buscandoDatos(viajeId, puntoId) {
  return Boolean(trabajoActivo(viajeId, 'datos_sitios', puntoId));
}

// =============================================================================
// PEDIR
// =============================================================================
/**
 * Encola la búsqueda, si hace falta.
 *
 * No se repite si ya hay una en marcha ni si TODOS los sitios tienen ya datos:
 * cada búsqueda abre un navegador de verdad y es lo más caro que hace la
 * aplicación. `forzar` salta esa comprobación, para el botón de actualizar.
 */
export function pedirDatosDeSitios(viajeId, puntoId, { forzar = false } = {}) {
  if (trabajoActivo(viajeId, 'datos_sitios', puntoId)) return null;

  if (!forzar) {
    const faltan = una(
      `SELECT COUNT(*) AS n FROM sitios_lugar
        WHERE punto_interes_id = ? AND datos_en IS NULL`,
      puntoId
    ).n;
    if (!faltan) return null;
  }

  return encolar(viajeId, 'datos_sitios', puntoId);
}

// =============================================================================
// BUSCAR Y GUARDAR
// =============================================================================
/**
 * El prompt, que es donde se juega todo esto.
 *
 * Tres cosas se repiten a propósito porque son las que un modelo se salta:
 *   · Que NO complete con lo que sepa. Sabe los horarios del Louvre, y por eso
 *     hay que prohibírselo explícitamente.
 *   · Que `null` es una respuesta válida y esperada.
 *   · Que el nombre del sitio se devuelva TAL CUAL se le dio, para poder
 *     casarlo después con su fila. Si lo "mejora", no cuadra con nada.
 */
function prompt(ciudad, sitios, texto) {
  return [
    `Este es el resultado de una búsqueda en Google sobre sitios de ${ciudad}:`,
    '',
    '--- TEXTO DE LA BÚSQUEDA ---',
    texto.slice(0, 12000),
    '--- FIN DEL TEXTO ---',
    '',
    'Extrae, PARA CADA SITIO DE ESTA LISTA, los datos que aparezcan en ese texto:',
    ...sitios.map((s) => `- ${s}`),
    '',
    'REGLAS, y son lo más importante de esta petición:',
    '',
    '1. SOLO puedes usar lo que esté escrito en el texto de arriba. Tienes',
    '   prohibido completar con lo que sepas por tu cuenta, aunque conozcas el',
    '   sitio perfectamente. Un dato tuyo aquí no se distingue de uno real y',
    '   acaba mandando a alguien a una puerta cerrada.',
    '2. Si un campo no aparece en el texto, pon null. Si un sitio entero no',
    '   aparece, pon todos sus campos a null. null es la respuesta correcta y',
    '   esperada muchas veces; no es un fallo.',
    '3. Devuelve el nombre EXACTAMENTE como te lo he escrito en la lista, sin',
    '   corregirlo ni traducirlo: es la clave para casar cada fila.',
    '   Y NO MEZCLES FILAS: si en el texto no hay datos para ese nombre, sus',
    '   campos van a null aunque haya otro sitio parecido del que sí los haya.',
    '   Prestarle a un sitio el teléfono del vecino convierte algo que no existe',
    '   en algo que parece real, que es justo lo que hay que evitar.',
    '4. "Gratis", "entrada libre" o "acceso gratuito" SÍ son un precio: ponlo',
    '   como "Gratis". No lo conviertas en null.',
    '5. Copia los textos casi tal cual, sin resumirlos ni redondearlos. Los',
    '   tramos de precio van juntos en el mismo campo: "12 € adultos, 5 €',
    '   niños, gratis menores de 12".',
    '6. "direccion" y "ciudad" son la dirección postal y la localidad TAL Y',
    '   COMO aparezcan en el texto. Si no aparecen, null.',
    `7. "estaEnLaCiudad" es lo que más me importa: según ESE TEXTO, ¿el sitio`,
    `   está en ${ciudad}?`,
    '     · true  si el texto lo sitúa ahí, aunque escriba el nombre de la',
    '             ciudad en otro idioma (Kraków es Cracovia, Warszawa es',
    '             Varsovia).',
    '     · false si el texto lo sitúa en OTRA ciudad o en otro país. Muchas',
    '             veces lo dice en una frase suelta antes de la tabla («el Museo',
    '             de la Acrópolis está en Atenas»): esa frase manda sobre',
    '             cualquier fila, y entonces sus datos tampoco son de aquí.',
    '     · null  si el texto no dice dónde está.',
    '   No lo deduzcas de lo que sepas tú: solo de lo que ponga el texto. Si',
    '   el texto habla de un sitio con ese nombre pero en otra ciudad, es',
    '   false, y eso no es un fallo: es justo lo que necesito saber.',
    '8. "reservaAnticipada" es si hay que sacar la entrada CON DÍAS DE',
    '   ANTELACIÓN, no si se puede comprar por internet. Casi ningún sitio lo',
    '   necesita: null y "no" son las respuestas normales.',
    '     · "imprescindible" solo si el texto dice que se agota, que hay cupo',
    '       limitado o que sin reserva previa no se entra.',
    '     · "recomendada"    si el texto aconseja comprar antes para evitar',
    '       colas o asegurar sitio, pero se puede entrar sin ello.',
    '     · "no"             si el texto dice expresamente que no hace falta.',
    '     · null             si el texto no dice nada del asunto. Es lo más',
    '                        frecuente con diferencia.',
    '9. "reservaDetalle": SOLO la ANTELACIÓN y DÓNDE se compra, copiado del',
    '   texto y en una frase corta. No repitas ahí el sí o el no: eso ya va en',
    '   "reservaAnticipada" y se pinta al lado, así que un detalle que empieza',
    '   por "Sí, imprescindible…" dice dos veces lo mismo.',
    '   Bien: "las entradas se agotan con semanas; se compran en',
    '         alhambra-patronato.es" o "salen a la venta el día 10 del mes',
    '         anterior".',
    '   Mal:  "Sí, hay que reservar con antelación".',
    '   Si no hay antelación concreta en el texto, null: "reserva con tiempo" no',
    '   le dice nada a nadie y es justo lo que hay que evitar.',
    '',
    'Devuelve SOLO este JSON:',
    '{"sitios":[{"nombre":"…","precio":null,"horarios":null,' +
      '"tiempoVisita":null,"web":null,"telefono":null,' +
      '"direccion":null,"ciudad":null,"estaEnLaCiudad":null,' +
      '"reservaAnticipada":null,"reservaDetalle":null}]}',
  ].join('\n');
}

/**
 * LAS TRES PALABRAS QUE VALEN, Y NINGUNA MÁS.
 *
 * El modelo contesta a veces «sí», «muy recomendable» o una frase entera. Aquí
 * eso no sirve: el nivel decide con cuánta antelación se avisa, así que o es
 * una de las tres o no es nada. Lo que no encaje se queda en null —«no se
 * sabe»—, que es distinto de 'no' —«se ha mirado y no hace falta»—.
 */
export function nivelDeReserva(v) {
  const t = String(v ?? '').trim().toLowerCase();
  if (!t || t === 'null') return null;
  if (t.startsWith('imprescindible') || t.startsWith('obligator')) return 'imprescindible';
  if (t.startsWith('recomend') || t.startsWith('aconsej')) return 'recomendada';
  if (t === 'no' || t.startsWith('no ')) return 'no';
  return null;
}

const texto = (v) => {
  const t = String(v ?? '').trim();
  if (!t || t === 'null' || t === '-' || t === '—') return null;
  return t.slice(0, 400);
};

/**
 * BUSCA Y GUARDA. La llama el worker.
 *
 * Devuelve un resumen de lo conseguido, que es lo que acaba en el registro de
 * la cola: sin él, un trabajo "hecho" que no rellenó nada es indistinguible de
 * uno que rellenó todo.
 */
/**
 * UNA TANDA: una búsqueda en Google y una pasada de la IA ordenando lo que vino.
 *
 * Devuelve los datos indexados por nombre normalizado, que es como se casan
 * después con sus filas.
 */
async function unaTanda(ciudad, nombres) {
  let resultado;
  try {
    resultado = await buscarTablaDeSitios({ ciudad, sitios: nombres });
  } catch (err) {
    // NI EL CAPTCHA NI UN FALLO DE RED TUMBAN LA ETAPA. Las fichas se quedan
    // con sus huecos y el motivo queda escrito en la cola.
    const porQue =
      err instanceof ErrorCaptcha
        ? `Google pidió verificación: ${err.message}`
        : `La búsqueda falló: ${err.message}`;
    throw new Error(`${porQue} Las fichas se quedan sin datos duros.`);
  }

  if (!hayClaveIA()) throw new Error(SIN_CLAVE);

  const r = await consultarJSON(prompt(ciudad, nombres, resultado.texto), {
    // Treinta sitios con cinco campos cada uno no caben en cuatro mil tokens, y
    // una respuesta cortada por el límite se pierde entera: no es JSON válido.
    maxTokens: 8000,
    paso: `ordenar los datos de los sitios de ${ciudad}`,
  });

  const porNombre = new Map();
  for (const s of r?.sitios ?? []) {
    if (s?.nombre) porNombre.set(normalizarNombre(s.nombre), s);
  }
  return { porNombre, fuente: resultado.fuente };
}

/**
 * OTRA VUELTA PARA LOS QUE NO APARECIERON, CON OTRO NOMBRE.
 *
 * Solo para los que nadie ha sabido encontrar. El otro motivo de descarte —«la
 * dirección apunta a otra ciudad»— no se reintenta: ahí el sitio SÍ se encontró,
 * y lo que dice la búsqueda es que está en otro sitio. Insistir con otro nombre
 * sería buscar hasta que salga lo que uno quiere.
 *
 * Devuelve el conjunto de ids que se han salvado. Los que siguen sin aparecer
 * van al filtro de siempre, ahora con el registro diciendo qué se probó.
 */
async function segundaOportunidad(ciudad, punto, sitios, sospechosos, cuando) {
  const rescatados = new Set();

  const aBuscar = sospechosos.filter((x) => !x.motivo.startsWith('la dirección'));
  if (!aBuscar.length) return rescatados;

  const porId = new Map(sitios.map((s) => [s.id, s]));
  const pais = punto?.destino_id
    ? una('SELECT nombre FROM destinos WHERE id = ?', punto.destino_id)?.nombre
    : null;

  // 1) El nombre nativo, de una sola llamada para todos: es mecánica de
  //    traducción, no criterio, así que va al modelo rápido.
  let nativos = new Map();
  if (hayClaveIA()) {
    try {
      const r = await consultarJSON(
        [
          `Estos sitios están en ${ciudad}${pais ? ` (${pais})` : ''}:`,
          ...aBuscar.map((x) => `- ${x.nombre}`),
          '',
          'Dame el nombre NATIVO y OFICIAL de cada uno: como lo llaman allí y como',
          'aparecería en un cartel o en Google Maps del país. Si el nombre que te',
          'doy ya es el nativo, repítelo. Si no sabes cuál es, pon null.',
          '',
          'Devuelve SOLO: {"nombres":[{"dado":"...","nativo":"..."}]}',
        ].join('\n'),
        { maxTokens: 800, paso: `nombre nativo de ${aBuscar.length} sitio(s) de ${ciudad}`, modelo: 'rapido' }
      );
      for (const x of r?.nombres ?? []) {
        const dado = texto(x?.dado);
        const nativo = texto(x?.nativo);
        if (dado && nativo) nativos.set(normalizarNombre(dado), nativo);
      }
    } catch (err) {
      console.warn(`[datos-sitios] ${ciudad}: no pude pedir los nombres nativos (${err.message}).`);
    }
  }

  // 2) Las variantes que se van a probar, por sitio y en orden.
  const variantes = new Map();
  for (const x of aBuscar) {
    const nativo = nativos.get(normalizarNombre(x.nombre));
    const lista = [];
    if (nativo && normalizarNombre(nativo) !== normalizarNombre(x.nombre)) lista.push(nativo);
    lista.push([x.nombre, ciudad, pais].filter(Boolean).join(', '));
    variantes.set(x.id, lista);
  }

  // 3) Una tanda por ronda: la primera con los nativos, la segunda con
  //    nombre+ciudad+país. Dos búsquedas como mucho, no una por sitio.
  for (let ronda = 0; ronda < 2; ronda += 1) {
    const ahora = aBuscar
      .filter((x) => !rescatados.has(x.id) && variantes.get(x.id)[ronda])
      .map((x) => ({ id: x.id, nombre: x.nombre, buscar: variantes.get(x.id)[ronda] }));
    if (!ahora.length) continue;

    let porNombre;
    try {
      ({ porNombre } = await unaTanda(ciudad, ahora.map((x) => x.buscar)));
    } catch (err) {
      console.warn(`[datos-sitios] ${ciudad}: la segunda búsqueda falló (${err.message}).`);
      break;
    }

    for (const x of ahora) {
      const d = porNombre.get(normalizarNombre(x.buscar));
      if (!traeAlgo(d)) {
        console.log(`[datos-sitios] ${ciudad}: «${x.nombre}» tampoco aparece como «${x.buscar}».`);
        continue;
      }

      rescatados.add(x.id);
      const fila = porId.get(x.id);
      console.log(
        `[datos-sitios] ${ciudad}: «${x.nombre}» RESCATADO buscándolo como «${x.buscar}».`
      );

      // Lo que ha traído se guarda, que para eso se ha buscado.
      ejecutar(
        `UPDATE sitios_lugar
            SET precio = COALESCE(precio, ?), horarios = COALESCE(horarios, ?),
                tiempo_visita = COALESCE(tiempo_visita, ?), web = COALESCE(web, ?),
                telefono = COALESCE(telefono, ?), datos_en = ?
          WHERE id = ?`,
        texto(d.precio),
        texto(d.horarios),
        texto(d.tiempoVisita),
        texto(d.web),
        texto(d.telefono),
        cuando,
        fila?.id ?? x.id
      );
    }
  }

  return rescatados;
}

/**
 * ¿La búsqueda ha encontrado ALGO de este sitio?
 *
 * Cualquier campo vale: un teléfono, una web, una dirección. No hace falta la
 * ficha entera; hace falta una señal de que el sitio existe y de que alguien ha
 * escrito sobre él.
 */
function traeAlgo(d) {
  return Boolean(
    d && (d.precio || d.horarios || d.tiempoVisita || d.web || d.telefono || d.direccion)
  );
}

/** Cuántos de los pedidos han vuelto con algo. Es la vara de medir del plan B. */
function cuantosTraenAlgo(nombres, porNombre) {
  return nombres.filter((n) => traeAlgo(porNombre.get(normalizarNombre(n)))).length;
}

/**
 * ¿HAY QUE CREER QUE ESTE SITIO EXISTE?
 *
 * La IA propone los sitios y de vez en cuando se inventa uno. En una ejecución
 * real salieron un «Museo de la Acrópolis de Varsovia» y un «Palacio Pitti» en
 * Cracovia —el Pitti está en Florencia—. Pedirle que no invente ya se le pide;
 * lo que faltaba era comprobarlo contra algo de fuera.
 *
 * Y ese algo ya se hacía: esta misma búsqueda. Si Google no sabe NADA de un
 * sitio —ni precio, ni horario, ni web, ni teléfono, ni dirección— o lo sitúa en
 * otra ciudad, el sitio no entra en la lista. No se busca nada más: se usa lo
 * que ya se había traído.
 *
 * DOS CAUTELAS, porque un falso negativo aquí borra un sitio bueno:
 *
 *  · Que falte un campo NO es motivo de nada, ni la foto tampoco. El motivo es
 *    que no haya NINGUNO.
 *  · Lo que ya tenía guardado cuenta como señal: un sitio verificado hace tres
 *    semanas no desaparece porque hoy Google conteste raro.
 *
 * LO QUE NO CUENTA COMO SEÑAL: la dirección que puso Places al situar el sitio.
 * Parece la prueba más obvia y es la más engañosa, porque Places contesta con lo
 * más parecido que encuentre: se le pide un «Museo del Vidrio Flotante de
 * Cracovia» que no existe y devuelve tan contento la dirección de otro museo de
 * Cracovia. Si eso valiera, todas las fichas tendrían su prueba de existencia y
 * el filtro no filtraría nada. La dirección que sí cuenta es la que aparece en
 * el texto de la búsqueda, y esa llega en `datos.direccion`.
 *
 * Devuelve null si el sitio vale, o el motivo del descarte tal y como se
 * escribirá en el registro.
 */
function porQueNoSeVerifica(fila, datos) {
  // 1) EN OTRA CIUDAD. Este es el descarte que de verdad importa: el sitio
  //    existe, pero no aquí. Lo dice la búsqueda, no nosotros.
  //
  //    Y SE EXIGE LA PRUEBA: una dirección o una ciudad escritas. Un «false»
  //    pelado, sin nada detrás, no es una dirección en otra ciudad; es no haber
  //    encontrado el sitio, y eso ya lo dice la regla de abajo con su nombre. Si
  //    no se distinguen, el registro acaba diciendo «la dirección apunta a otra
  //    ciudad: sin dirección concreta», que es una frase que se contradice sola.
  const donde = texto(datos?.direccion) ?? texto(datos?.ciudad);
  if (datos?.estaEnLaCiudad === false && donde) {
    return `la dirección apunta a otra ciudad: ${donde}`;
  }

  // 2) NADIE SABE NADA DE ÉL, ni ahora ni antes.
  const yaTenia = Boolean(
    fila.precio || fila.horarios || fila.tiempo_visita || fila.web || fila.telefono
  );
  if (traeAlgo(datos) || yaTenia) return null;

  return 'sin resultados en la búsqueda';
}

/**
 * A partir de cuántos sitios tiene sentido plantearse partir la búsqueda.
 *
 * Con diez, si vuelven pocos es que Google no sabía de ellos, y repetir en dos
 * mitades da lo mismo dos veces. Con veinte o treinta, lo más probable es que la
 * tabla se haya quedado corta.
 */
const MUCHOS_SITIOS = 14;

/** Por debajo de esto se considera que la respuesta vino incompleta. */
const COBERTURA_MINIMA = 0.7;

/**
 * Cuántos sitios caben en una tanda que funcione.
 *
 * Doce y no "la mitad de lo que sea". Medido: con diez sitios el Modo IA
 * devuelve la tabla entera y completa; con treinta devuelve dos párrafos y
 * ninguna fila. Partiendo por la mitad, esos treinta daban dos tandas de quince
 * y la segunda volvía vacía —catorce de treinta—. En trozos de doce salen tres
 * tandas y vuelven casi todos.
 *
 * Para una lista de veinte, que es el caso normal de una etapa sin niños, esto
 * son exactamente dos búsquedas.
 */
const TAMANO_TANDA = 12;

/**
 * @param {object} punto
 * @param {{ids?: number[]}} opciones `ids` limita la búsqueda a esos sitios.
 *   Lo usa «Mis búsquedas»: una ficha recién creada necesita sus datos, y
 *   rehacer la tabla de los treinta que ya los tienen sería abrir el navegador
 *   para nada.
 */
export async function buscarDatosDeSitios(punto, { ids = null } = {}) {
  const filtro = ids?.length ? ` AND id IN (${ids.map(() => '?').join(',')})` : '';
  const sitios = todas(
    `SELECT id, nombre, horarios, precio, tiempo_visita, web, telefono, datos_en, datos_fuente,
            reserva_anticipada, reserva_detalle, reserva_en
       FROM sitios_lugar
      WHERE punto_interes_id = ?${filtro} ORDER BY orden, id`,
    punto.id,
    ...(ids?.length ? ids : [])
  );
  if (!sitios.length) return { sitios: 0, rellenados: 0, mensaje: 'No hay sitios que consultar.' };

  const ciudad = punto.ciudad_base || punto.nombre;
  const nombres = sitios.map((s) => s.nombre);

  // --- 1 y 2) Una búsqueda para todos, y la IA ordenando -------------------
  let { porNombre, fuente } = await unaTanda(ciudad, nombres);

  // --- PLAN B: la misma búsqueda, en dos mitades --------------------------
  //
  // Se pide UNA tabla con todos los sitios de la etapa, que ahora pueden ser
  // treinta. Google contesta lo que le cabe, y con esa lista de la compra la
  // tabla llega a veces cortada por la mitad: las primeras filas completas y el
  // resto sin nada. No se distingue de "no lo sabe" mirando una fila, pero sí
  // mirando el conjunto —si vuelven ocho de treinta, no es que falte
  // información, es que faltan filas—.
  //
  // Entonces se repite en dos tandas más cortas y se junta. Cuesta una búsqueda
  // más y medio minuto, y solo pasa cuando hace falta.
  const cobertura = cuantosTraenAlgo(nombres, porNombre);
  if (nombres.length >= MUCHOS_SITIOS && cobertura < nombres.length * COBERTURA_MINIMA) {
    const trozos = [];
    for (let i = 0; i < nombres.length; i += TAMANO_TANDA) {
      trozos.push(nombres.slice(i, i + TAMANO_TANDA));
    }
    console.log(
      `[datos-sitios] ${ciudad}: solo ${cobertura} de ${nombres.length} en una tabla. ` +
        `La parto en ${trozos.length} y repito.`
    );

    const juntas = new Map();
    let fuentePartida = fuente;
    for (const trozo of trozos) {
      try {
        const parcial = await unaTanda(ciudad, trozo);
        for (const [k, v] of parcial.porNombre) juntas.set(k, v);
        fuentePartida = parcial.fuente;
      } catch (err) {
        console.warn(`[datos-sitios] ${ciudad}: una de las tandas falló (${err.message}).`);
      }
    }

    // Solo se cambia de caballo si el partido va mejor. Si las tandas fallaron
    // o trajeron menos, se conserva lo de la búsqueda entera.
    if (cuantosTraenAlgo(nombres, juntas) > cobertura) {
      porNombre = juntas;
      fuente = `${fuentePartida} (en ${trozos.length} tandas)`;
    }
  }

  // --- 3) Guardar, campo a campo ------------------------------------------
  const cuando = new Date().toISOString().slice(0, 19).replace('T', ' ');
  let rellenados = 0;
  let campos = 0;
  const sospechosos = [];

  for (const s of sitios) {
    const d = porNombre.get(normalizarNombre(s.nombre)) ?? {};

    // El veredicto se anota ahora, con el dato recién llegado delante, pero no
    // se ejecuta hasta el final: hay que ver el conjunto antes de borrar nada.
    const motivo = porQueNoSeVerifica(s, d);
    if (motivo) sospechosos.push({ id: s.id, nombre: s.nombre, motivo });

    const traido = {
      precio: texto(d.precio),
      horarios: texto(d.horarios),
      tiempo_visita: texto(d.tiempoVisita),
      web: texto(d.web),
      telefono: texto(d.telefono),
    };

    // La reserva anticipada va aparte porque no es texto libre: es una de tres
    // palabras, y cualquier otra cosa que conteste el modelo no vale.
    const reserva = nivelDeReserva(d.reservaAnticipada);
    const reservaDetalle = texto(d.reservaDetalle);

    // LO QUE NO VUELVE NO BORRA LO QUE HABÍA.
    //
    // Antes se escribían los cinco campos tal cual, nulls incluidos: si la
    // búsqueda de hoy no traía el teléfono que trajo la de la semana pasada, el
    // teléfono se perdía. El Modo IA no contesta igual dos veces, así que una
    // ficha completa podía quedarse vacía en una pasada floja, y con el filtro
    // de existencia detrás eso ya no es solo perder un dato: es que a la
    // siguiente el sitio parece inventado y se borra. Un dato viejo se avisa por
    // su fecha; un dato borrado no se recupera.
    const fila = {
      precio: traido.precio ?? s.precio ?? null,
      horarios: traido.horarios ?? s.horarios ?? null,
      tiempo_visita: traido.tiempo_visita ?? s.tiempo_visita ?? null,
      web: traido.web ?? s.web ?? null,
      telefono: traido.telefono ?? s.telefono ?? null,
      reserva_anticipada: reserva ?? s.reserva_anticipada ?? null,
      reserva_detalle: reservaDetalle ?? s.reserva_detalle ?? null,
    };

    const cuantos = Object.values(fila).filter(Boolean).length;
    if (cuantos) rellenados += 1;
    campos += Object.values(traido).filter(Boolean).length;

    // `datos_en` se marca SIEMPRE, se haya encontrado algo o no: es lo que
    // distingue "buscado y no había" de "todavía sin buscar", y sin esa marca
    // la ficha se quedaría diciendo "cargando…" para siempre.
    //
    // Y los horarios nuevos invalidan los días de cierre ya interpretados: si
    // cambia el horario, lo que se dedujo de él deja de valer.
    const cambiaElHorario = fila.horarios !== (s.horarios ?? null);

    ejecutar(
      `UPDATE sitios_lugar
          SET precio = ?, horarios = ?, tiempo_visita = ?, web = ?, telefono = ?,
              reserva_anticipada = ?, reserva_detalle = ?,
              reserva_en = CASE WHEN ? IS NULL THEN reserva_en ELSE ? END,
              datos_en = ?, datos_fuente = ?
              ${cambiaElHorario ? ', cierra_dias = NULL, cierra_en = NULL' : ''}
        WHERE id = ?`,
      fila.precio,
      fila.horarios,
      fila.tiempo_visita,
      fila.web,
      fila.telefono,
      fila.reserva_anticipada,
      fila.reserva_detalle,
      // `reserva_en` solo se sella cuando esta pasada ha traído un veredicto.
      // Si no vino nada, se conserva la marca vieja: decir «revisado hoy»
      // cuando hoy no se ha averiguado nada convertiría un hueco en un «no».
      reserva,
      cuando,
      cuando,
      // Si esta pasada no trajo nada, la fuente sigue siendo la que trajo lo que
      // hay guardado: decir «google-modo-ia de hoy» sobre un dato de hace un mes
      // sería falsear la trazabilidad.
      Object.values(traido).some(Boolean) ? fuente : (s.datos_fuente ?? fuente),
      s.id
    );
  }

  // --- 3 bis) SEGUNDA OPORTUNIDAD CON OTRO NOMBRE -------------------------
  //
  // EL CASO QUE ORIGINA ESTO. En Poznań se descartaron cinco sitios «por no
  // verificados», y entre ellos Stary Rynek, que es LA plaza mayor de la ciudad.
  // Existe, claro que existe: lo que no existe es «Mercado de Stary Rynek (Plaza
  // Mayor)», que es como lo había bautizado la generación. Se buscó ese nombre,
  // no salió nada, y el sitio se fue.
  //
  // Antes de tirar nada se prueba otra vez, con las dos variantes que arreglan
  // casi todos estos casos: el nombre nativo —que es como lo llaman ahí y como
  // está escrito en todas partes— y el nombre con ciudad y país detrás, que
  // desambigua los homónimos.
  const rescatados = await segundaOportunidad(ciudad, punto, sitios, sospechosos, cuando);
  const sinRescatar = sospechosos.filter((x) => !rescatados.has(x.id));

  // --- 4) EL FILTRO DE EXISTENCIA -----------------------------------------
  //
  // Lo que la búsqueda no ha podido confirmar, fuera. Se hace aquí y no antes
  // porque hasta ahora no había con qué comparar, y se hace con el conjunto
  // delante por lo que viene justo abajo.
  const descartados = filtrarNoVerificados(ciudad, punto, sitios, sinRescatar);

  const resumen =
    `${rellenados} de ${sitios.length} sitios con algún dato (${campos} campos) ` +
    `· fuente: ${fuente}` +
    (descartados.length ? ` · ${descartados.length} descartado(s) por no verificados` : '');
  console.log(`[datos-sitios] ${ciudad}: ${resumen}`);

  return {
    sitios: sitios.length,
    rellenados,
    campos,
    fuente: fuente,
    descartados,
    mensaje: resumen,
  };
}

/**
 * Borra los sitios que la búsqueda no ha podido confirmar.
 *
 * LA CAUTELA GRANDE ESTÁ AQUÍ: en una tanda GRANDE, si la búsqueda no ha traído
 * nada de NADIE, no se borra a nadie. Veinte sitios sin confirmar no son veinte
 * sitios inventados, son una búsqueda que ha salido mal —un captcha, una tabla
 * vacía, Google de mal día—, y borrar la lista entera de una ciudad por eso
 * sería mucho peor que el problema que esto viene a resolver. Con un solo sitio
 * confirmado ya sabemos que la búsqueda funcionó, y entonces sí: el que no
 * aparece, no está.
 *
 * La cautela NO aplica a las tandas cortas —«Mis búsquedas» pide una o dos
 * fichas—, porque ahí «no ha vuelto nada» no tiene un conjunto con el que
 * compararse: es la respuesta, y hay que darla. Si la búsqueda hubiera fallado
 * de verdad habría saltado antes con su excepción, sin llegar aquí.
 *
 * Los descartes por ciudad equivocada se aplican siempre, haya vuelto algo o
 * no: ahí no hay duda de que la búsqueda encontró el sitio, y lo que encontró
 * está en otra parte.
 */
const TANDA_PARA_DUDAR = 5;

function filtrarNoVerificados(ciudad, punto, sitios, sospechosos) {
  if (!sospechosos.length) return [];

  const deOtraCiudad = sospechosos.filter((x) => x.motivo.startsWith('la dirección'));
  const confirmados = sitios.length - sospechosos.length;

  if (!confirmados && sitios.length >= TANDA_PARA_DUDAR && deOtraCiudad.length !== sospechosos.length) {
    console.warn(
      `[datos-sitios] ${ciudad}: la búsqueda no encontró nada de ninguno de los ` +
        `${sitios.length} sitios. No descarto ninguno: esto es una búsqueda fallida, ` +
        'no una lista inventada.'
    );
    return deOtraCiudad.length ? borrarSitios(ciudad, punto, deOtraCiudad) : [];
  }

  return borrarSitios(ciudad, punto, sospechosos);
}

/**
 * Borra las fichas y todo lo que colgaba de ellas, y deja escrito el motivo.
 *
 * Se lleva por delante tres cosas, y las tres hacen falta:
 *
 *  · La ficha.
 *  · Su dirección, que vive en otra tabla y sin clave ajena: se quedaría
 *    colgada apuntando a una ficha que ya no existe.
 *  · Y el APUNTADO, si alguien ya lo había metido en el viaje. Esto salió en la
 *    prueba: se descartó «Puente del Dragón (Most Smoka)» —un puente que no
 *    existe en Cracovia— y la tarjeta seguía en el día, porque apuntar copia el
 *    título a `candidatos`. Un sitio que acabamos de declarar inexistente no
 *    puede quedarse en el plan del viaje.
 */
function borrarSitios(ciudad, punto, lista) {
  for (const x of lista) {
    ejecutar(
      "DELETE FROM direcciones WHERE tipo_elemento = 'sitio' AND elemento_id = ?",
      x.id
    );
    ejecutar(
      `DELETE FROM candidatos
        WHERE tipo = 'sitio' AND titulo = ?
          AND etapa_id IN (SELECT id FROM etapas WHERE punto_interes_id = ?)`,
      x.nombre,
      punto.id
    );
    ejecutar('DELETE FROM sitios_lugar WHERE id = ?', x.id);
    console.log(
      `[datos-sitios] ${ciudad}: descartado por no verificado: ${x.nombre} (${x.motivo})`
    );
  }
  return lista;
}

// =============================================================================
// QUÉ DÍAS CIERRA
// =============================================================================
/**
 * Encola la traducción del horario a días de la semana.
 *
 * La pide el lienzo la primera vez que necesita saber si un sitio cierra ese
 * día. No se hace al buscar los datos —ahí solo se guarda la frase tal cual—
 * porque la mayoría de los sitios no acaban en ningún día concreto y traducir
 * quince horarios para usar dos sería pagar por trece.
 */
export function pedirInterpretarHorario(viajeId, sitioId) {
  if (trabajoActivo(viajeId, 'horario_cierre', sitioId)) return null;
  return encolar(viajeId, 'horario_cierre', sitioId);
}

/**
 * Traduce "cerrado los lunes" a [1]. La llama el worker.
 *
 * Guarda SIEMPRE algo, aunque sea una lista vacía: sin marca, el lienzo
 * volvería a encolar el mismo trabajo en cada pintada. Una lista vacía es una
 * respuesta legítima —"no cierra ningún día fijo"— y hay que poder decirla.
 */
export async function interpretarHorario(sitioId) {
  const s = una('SELECT id, nombre, horarios FROM sitios_lugar WHERE id = ?', Number(sitioId));
  if (!s) return null;
  if (!s.horarios) return null;

  // --- PRIMERO, LEERLO ---------------------------------------------------
  //
  // La inmensa mayoría de los horarios reales se entienden sin preguntarle a
  // nadie: «Vie a Dom», «Mon-Fri 9AM-5PM», «Lun: 10-15; Mar-Dom: 9-19». Leerlos
  // aquí sale gratis, es instantáneo y —lo que importa— es lo único que se puede
  // probar con casos antes de que falle en un viaje.
  const leidos = diasQueCierra(s.horarios);
  if (leidos !== null) {
    return guardarCierres(s, leidos, 'leído del texto');
  }

  // --- Y SI NO, PREGUNTAR. PERO POR LOS DÍAS QUE ABRE ---------------------
  //
  // Aquí estaba el fallo de Asia. Se le pedía la lista de días que CIERRA, y
  // ante «abre de viernes a domingo» eso le obliga a expandir el rango, restarlo
  // de los siete y devolver el complemento. Devolvió el rango tal cual, el sitio
  // quedó marcado como cerrado en viernes —el único día que abría, y el único
  // día que la parada tenía— y se fue del viaje.
  //
  // Ahora se le pregunta lo que el texto dice, que es cuándo abre, y el
  // complemento se calcula abajo. No es que el modelo no sepa restar: es que no
  // hay ninguna razón para pedírselo.
  if (!hayClaveIA()) throw new Error(SIN_CLAVE);

  const r = await consultarJSON(
    [
      `Este es el horario de «${s.nombre}», tal y como se publicó:`,
      '',
      s.horarios,
      '',
      '¿Qué días de la semana ABRE?',
      '',
      'Reglas:',
      '- Números del 0 al 6, con el domingo en el 0 y el sábado en el 6.',
      '- La lista es de días ABIERTOS. No me des los que cierra ni me hagas',
      '  ninguna resta: de eso me encargo yo.',
      '- UN RANGO SE EXPANDE HACIA DELANTE, dando la vuelta a la semana si hace',
      '  falta. "Abre de viernes a domingo" son viernes, sábado y domingo:',
      '  {"abre":[5,6,0]}. No es lunes a jueves; esos son justo los que NO.',
      '- Un día con horario reducido está abierto y cuenta.',
      '- "Cerrado los lunes" quiere decir que abre los otros seis:',
      '  {"abre":[0,2,3,4,5,6]}.',
      '- Si el horario viene en inglés con AM/PM ("Fri-Sun 10AM-6PM"), se lee',
      '  igual: son viernes, sábado y domingo.',
      '- Si el texto no permite saberlo, devuelve {"abre":null}. No adivines por',
      '  lo que sepas del sitio: solo cuenta lo que diga ese texto.',
      '',
      'Devuelve SOLO: {"abre":[5,6,0]}',
    ].join('\n'),
    { maxTokens: 200, paso: `interpretar el horario de ${s.nombre}` }
  );

  const abre = (Array.isArray(r?.abre) ? r.abre : [])
    .map(Number)
    .filter((n) => Number.isInteger(n) && n >= 0 && n <= 6);

  // Sin días abiertos no se concluye que cierre los siete: eso no lo dice ningún
  // horario del mundo y dejaría el sitio sin un solo día en el que colocarse. Se
  // trata como «no lo sé», que es el lado seguro de equivocarse.
  const cierra = abre.length ? TODOS_LOS_DIAS.filter((d) => !abre.includes(d)) : [];

  return guardarCierres(s, cierra, abre.length ? 'preguntado a la IA' : 'la IA no supo decirlo');
}

/**
 * Guarda SIEMPRE algo, aunque sea una lista vacía: sin marca, el lienzo volvería
 * a encolar el mismo trabajo en cada pintada. Una lista vacía es una respuesta
 * legítima —«no cierra ningún día fijo»— y hay que poder decirla.
 */
function guardarCierres(sitio, dias, comoSeSupo) {
  const limpios = [...new Set(dias)].sort((a, b) => a - b);

  // EL HORARIO PARSEADO, GUARDADO JUNTO AL SITIO.
  //
  // La comprobación de «¿abre el día D?» se hace siempre leyendo el texto, que
  // es la única fuente que no se queda vieja. Esto se guarda para poder MIRARLO:
  // qué ha entendido el lector, día a día y con sus rangos. Cuando un aviso
  // vuelva a decir algo raro, aquí se ve si el fallo fue de la lectura o del
  // dato que trajo Google.
  const estructura = horarioPorDias(sitio.horarios);

  ejecutar(
    "UPDATE sitios_lugar SET cierra_dias = ?, horario_json = ?, cierra_en = datetime('now') WHERE id = ?",
    JSON.stringify(limpios),
    JSON.stringify(estructura),
    sitio.id
  );

  console.log(
    `[datos-sitios] ${sitio.nombre}: cierra ${limpios.length ? limpios.join(', ') : 'ningún día fijo'}` +
      ` (${comoSeSupo}, de «${sitio.horarios.slice(0, 60)}»)`
  );
  return limpios;
}

export default {
  datosDeSitio,
  pedirDatosDeSitios,
  buscarDatosDeSitios,
  buscandoDatos,
  pedirInterpretarHorario,
  interpretarHorario,
  DIAS_PARA_AVISAR,
};
