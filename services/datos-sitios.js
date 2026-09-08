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
import { consultarJSON, hayClaveIA, SIN_CLAVE } from '../lib/ia.js';
import { buscarTablaDeSitios, ErrorCaptcha } from '../providers/google-busqueda.js';

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
export function datosDeSitio(sitio) {
  if (!sitio) return null;

  const dias = diasDesde(sitio.datos_en);
  const hayAlgo = Boolean(
    sitio.precio || sitio.horarios || sitio.tiempo_visita || sitio.web || sitio.telefono
  );

  return {
    precio: sitio.precio ?? null,
    horarios: sitio.horarios ?? null,
    tiempoVisita: sitio.tiempo_visita ?? null,
    web: sitio.web ?? null,
    telefono: sitio.telefono ?? null,
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
    '4. "Gratis", "entrada libre" o "acceso gratuito" SÍ son un precio: ponlo',
    '   como "Gratis". No lo conviertas en null.',
    '5. Copia los textos casi tal cual, sin resumirlos ni redondearlos. Los',
    '   tramos de precio van juntos en el mismo campo: "12 € adultos, 5 €',
    '   niños, gratis menores de 12".',
    '',
    'Devuelve SOLO este JSON:',
    '{"sitios":[{"nombre":"…","precio":null,"horarios":null,' +
      '"tiempoVisita":null,"web":null,"telefono":null}]}',
  ].join('\n');
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
export async function buscarDatosDeSitios(punto) {
  const sitios = todas(
    'SELECT id, nombre FROM sitios_lugar WHERE punto_interes_id = ? ORDER BY orden, id',
    punto.id
  );
  if (!sitios.length) return { sitios: 0, rellenados: 0, mensaje: 'No hay sitios que consultar.' };

  const ciudad = punto.ciudad_base || punto.nombre;
  const nombres = sitios.map((s) => s.nombre);

  // --- 1) La búsqueda, una sola -------------------------------------------
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

  // --- 2) La IA ordena lo que vino, sin añadir nada ------------------------
  if (!hayClaveIA()) throw new Error(SIN_CLAVE);

  const r = await consultarJSON(prompt(ciudad, nombres, resultado.texto), {
    maxTokens: 4000,
    paso: `ordenar los datos de los sitios de ${ciudad}`,
  });

  const porNombre = new Map(
    (r?.sitios ?? []).map((s) => [normalizarNombre(s?.nombre), s])
  );

  // --- 3) Guardar, campo a campo ------------------------------------------
  const cuando = new Date().toISOString().slice(0, 19).replace('T', ' ');
  let rellenados = 0;
  let campos = 0;

  for (const s of sitios) {
    const d = porNombre.get(normalizarNombre(s.nombre)) ?? {};

    const fila = {
      precio: texto(d.precio),
      horarios: texto(d.horarios),
      tiempo_visita: texto(d.tiempoVisita),
      web: texto(d.web),
      telefono: texto(d.telefono),
    };
    const cuantos = Object.values(fila).filter(Boolean).length;
    if (cuantos) rellenados += 1;
    campos += cuantos;

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
              datos_en = ?, datos_fuente = ?
              ${cambiaElHorario ? ', cierra_dias = NULL, cierra_en = NULL' : ''}
        WHERE id = ?`,
      fila.precio,
      fila.horarios,
      fila.tiempo_visita,
      fila.web,
      fila.telefono,
      cuando,
      resultado.fuente,
      s.id
    );
  }

  const resumen =
    `${rellenados} de ${sitios.length} sitios con algún dato (${campos} campos) ` +
    `· fuente: ${resultado.fuente}`;
  console.log(`[datos-sitios] ${ciudad}: ${resumen}`);

  return { sitios: sitios.length, rellenados, campos, fuente: resultado.fuente, mensaje: resumen };
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
  if (!hayClaveIA()) throw new Error(SIN_CLAVE);

  const r = await consultarJSON(
    [
      `Este es el horario de «${s.nombre}», tal y como se publicó:`,
      '',
      s.horarios,
      '',
      '¿Qué días de la semana está CERRADO todo el día?',
      '',
      'Reglas:',
      '- Números del 0 al 6, con el domingo en el 0 y el sábado en el 6.',
      '- Solo los días que cierra ENTERO. Un día con horario reducido está',
      '  abierto y no cuenta.',
      '- Si abre todos los días, o si el texto no permite saberlo, devuelve una',
      '  lista vacía. No adivines por lo que sepas del sitio: solo cuenta lo que',
      '  diga ese texto.',
      '',
      'Devuelve SOLO: {"cierra":[1]}',
    ].join('\n'),
    { maxTokens: 200, paso: `interpretar el horario de ${s.nombre}` }
  );

  const dias = (Array.isArray(r?.cierra) ? r.cierra : [])
    .map(Number)
    .filter((n) => Number.isInteger(n) && n >= 0 && n <= 6);

  ejecutar(
    "UPDATE sitios_lugar SET cierra_dias = ?, cierra_en = datetime('now') WHERE id = ?",
    JSON.stringify([...new Set(dias)]),
    s.id
  );

  console.log(
    `[datos-sitios] ${s.nombre}: cierra ${dias.length ? dias.join(', ') : 'ningún día fijo'}` +
      ` (de «${s.horarios.slice(0, 60)}»)`
  );
  return dias;
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
