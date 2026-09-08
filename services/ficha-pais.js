/**
 * services/ficha-pais.js
 * -----------------------------------------------------------------------------
 * ANTES DE VIAJAR: qué necesito para entrar y qué me tengo que llevar.
 *
 * Es la información que se mira MIENTRAS SE ORGANIZA, no estando allí. Un
 * visado se tramita con semanas de antelación, una vacuna con más, y enterarse
 * de que el día 1 es festivo nacional cuando ya tienes el museo en el lienzo no
 * sirve de nada. Por eso vive en "Mi ruta", que es la pantalla donde se decide.
 *
 * DE DÓNDE SALE CADA COSA:
 *   · Festivos              Nager.Date, vía services/avisos.js
 *   · Avisos de Exteriores  exteriores.gob.es, vía services/avisos.js
 *   · Papeles, salud, dinero  la IA configurada
 *
 * Lo de la IA se genera UNA vez por país + fechas y se guarda. Cada llamada
 * cuesta, y la respuesta no cambia de un día para otro: lo que cambia es al
 * cabo de semanas, y para eso está `generado_en` y el aviso de "conviene
 * actualizar".
 *
 * SE GUARDA POR PAÍS + FECHAS, NO POR VIAJE. Los festivos y los avisos dependen
 * de cuándo se va, pero dos viajes a Portugal la misma semana comparten ficha.
 */
import { todas, una, ejecutar, normalizarNombre } from '../db/index.js';
import { consultarJSON, hayClaveIA, SIN_CLAVE } from '../lib/ia.js';
import { situarDestino, textoDeExteriores, festivosEntre } from './avisos.js';

/** Desde dónde se viaja. Todo lo de papeles se responde para este pasaporte. */
const PASAPORTE = 'España';

/**
 * A partir de cuántos días lo generado empieza a oler a viejo.
 *
 * Treinta no es un número mágico, es un juicio: los requisitos de entrada no
 * cambian todas las semanas, pero tampoco aguantan un trimestre sin mirar.
 */
export const DIAS_PARA_CADUCAR = 30;

// =============================================================================
// QUÉ PAÍSES PISA EL VIAJE
// =============================================================================
/**
 * Los países de la ruta, deducidos solos.
 *
 * Se sacan de las etapas, en el orden en que se visitan y sin repetir. Si el
 * viaje cruza a otro país, aparece su pestaña sin que nadie tenga que decir
 * nada; y si es a uno solo, hay una pestaña y no se nota que esto existe.
 *
 * Dos caminos para averiguar el país de una parada, en este orden:
 *
 *   1. `destinos.pais`, que es lo que ya sabemos y no cuesta nada.
 *   2. Geocodificar la ciudad con Open-Meteo, que además devuelve el código
 *      ISO-2 que necesitan Nager y Exteriores.
 *
 * El segundo hace falta de verdad: Sarajevo y Mostar están en el catálogo con
 * `pais` a null, así que sin esto un viaje a Bosnia no tendría ficha.
 */
export async function paisesDelViaje(viajeId) {
  const etapas = todas(
    `SELECT e.id, e.nombre_ciudad, e.orden, e.pais, e.codigo_pais,
            d.pais AS pais_destino
       FROM etapas e
       LEFT JOIN destinos d ON d.id = e.destino_id
      WHERE e.viaje_id = ?
      ORDER BY e.orden, e.id`,
    viajeId
  );

  const paises = [];
  const vistos = new Set();

  for (const etapa of etapas) {
    let pais = etapa.pais?.trim() || etapa.pais_destino?.trim() || null;
    let codigo = etapa.codigo_pais?.trim() || null;

    // SE GEOCODIFICA UNA VEZ EN LA VIDA DE LA PARADA, no en cada apertura.
    //
    // Hace falta el código ISO-2 para Nager y para Exteriores, y averiguarlo es
    // una petición a Open-Meteo por ciudad. Repetirlas cada vez que alguien
    // abre el panel era gratis en dinero pero no en tiempo, y sobre todo dejaba
    // al dosier sin nada de donde tirar: se genera sin red y de forma síncrona.
    if (!pais || !codigo) {
      try {
        const sitio = await situarDestino(etapa.nombre_ciudad);
        pais = pais ?? sitio.pais;
        codigo = codigo ?? sitio.codigoPais ?? null;
        if (pais) {
          ejecutar(
            'UPDATE etapas SET pais = ?, codigo_pais = ? WHERE id = ?',
            pais,
            codigo,
            etapa.id
          );
        }
      } catch (err) {
        console.warn(`[ficha] no pude situar «${etapa.nombre_ciudad}»: ${err.message}`);
      }
    }

    if (!pais) continue;

    const norm = normalizarNombre(pais);
    if (vistos.has(norm)) {
      // Ya estaba, pero puede que ahora sí tengamos su código.
      const ya = paises.find((p) => p.norm === norm);
      if (ya && !ya.codigoPais && codigo) ya.codigoPais = codigo;
      continue;
    }

    vistos.add(norm);
    paises.push({ pais, norm, codigoPais: codigo, primeraCiudad: etapa.nombre_ciudad });
  }

  return paises;
}

// =============================================================================
// LO QUE HAY GUARDADO
// =============================================================================
/** Días transcurridos desde una marca de tiempo de SQLite. */
function diasDesde(iso) {
  if (!iso) return null;
  const cuando = new Date(iso.replace(' ', 'T') + 'Z');
  if (Number.isNaN(cuando.getTime())) return null;
  return Math.floor((Date.now() - cuando.getTime()) / 86_400_000);
}

/** "2026-09-20" -> "20 de septiembre de 2026". */
const MESES = ['enero', 'febrero', 'marzo', 'abril', 'mayo', 'junio',
  'julio', 'agosto', 'septiembre', 'octubre', 'noviembre', 'diciembre'];

function enLargo(iso) {
  if (!iso) return null;
  const [a, m, d] = iso.slice(0, 10).split('-').map(Number);
  return `${d} de ${MESES[m - 1]} de ${a}`;
}

/** Cuántos días faltan para el viaje. Negativo si ya empezó. */
function diasHasta(fechaInicio) {
  if (!fechaInicio) return null;
  const hoy = new Date().toISOString().slice(0, 10);
  return Math.round(
    (new Date(fechaInicio + 'T00:00:00Z') - new Date(hoy + 'T00:00:00Z')) / 86_400_000
  );
}

function filaGuardada(paisNorm, fechaInicio, fechaFin) {
  return (
    una(
      `SELECT * FROM fichas_pais
        WHERE pais_norm = ? AND fecha_inicio IS ? AND fecha_fin IS ?`,
      paisNorm,
      fechaInicio ?? null,
      fechaFin ?? null
    ) ?? null
  );
}

/**
 * ¿Conviene actualizar esto?
 *
 * Dos condiciones a la vez, y las dos importan: que lo generado tenga ya sus
 * días Y que el viaje se acerque. Un dato de hace dos meses para un viaje que
 * es dentro de un año no urge; el mismo dato a dos semanas de salir, sí.
 */
function convieneActualizar(generadoEn, fechaInicio) {
  const dias = diasDesde(generadoEn);
  if (dias == null) return false;
  if (dias < DIAS_PARA_CADUCAR) return false;

  const faltan = diasHasta(fechaInicio);
  // Sin fechas no hay "se acerca" que valga: se avisa solo por antigüedad.
  if (faltan == null) return true;
  return faltan <= 90;
}

/** Le da la vuelta a una fila de la tabla para dejarla como la quiere la vista. */
function comoFicha(fila, fechaInicio) {
  let datos = {};
  try {
    datos = JSON.parse(fila.datos) ?? {};
  } catch {
    /* JSON corrupto: se enseña vacía y el botón de actualizar la rehace */
  }

  return {
    pais: fila.pais,
    codigoPais: fila.codigo_pais,
    generadoEn: fila.generado_en,
    generadoEnLargo: enLargo(fila.generado_en),
    diasDesdeGeneracion: diasDesde(fila.generado_en),
    convieneActualizar: convieneActualizar(fila.generado_en, fechaInicio),
    ...datos,
  };
}

// =============================================================================
// GENERAR
// =============================================================================
/**
 * Lo que solo sabe la IA: papeles, salud y dinero.
 *
 * El prompt es explícito en tres cosas que, si no se dicen, salen mal:
 *
 *   · DESDE DÓNDE se viaja. "¿Hace falta visado para Japón?" no tiene una sola
 *     respuesta; depende del pasaporte. Aquí siempre es el español.
 *   · Que diga "no hace falta" cuando no hace falta. Un modelo al que se le
 *     pregunta por visados tiende a rellenar el hueco con trámites.
 *   · Que no invente. Más vale un campo vacío que una vacuna que no existe:
 *     esto se lee para tomar decisiones con semanas de antelación.
 */
async function preguntarALaIA(pais, fechaInicio, fechaFin) {
  if (!hayClaveIA()) throw new Error(SIN_CLAVE);

  const cuando =
    fechaInicio && fechaFin
      ? `El viaje es del ${enLargo(fechaInicio)} al ${enLargo(fechaFin)}.`
      : 'No hay fechas cerradas todavía.';

  const prompt = [
    `Necesito la información práctica para viajar a ${pais} con pasaporte de ${PASAPORTE}.`,
    cuando,
    '',
    'Reglas:',
    `- Responde SIEMPRE para un viajero con nacionalidad y pasaporte de ${PASAPORTE}.`,
    '- Si algo NO hace falta, dilo claramente en vez de describir un trámite',
    '  que nadie tiene que hacer. "No se necesita visado" es una respuesta.',
    '- No inventes. Si no estás seguro de un dato, deja el campo en null.',
    '  Esto se lee para decidir con semanas de antelación: un dato inventado',
    '  hace más daño que un hueco.',
    '- En español, y en frases cortas y llanas. Nada de lenguaje de folleto.',
    '- Nada de precios concretos ni tipos de cambio numéricos: cambian a diario',
    '  y esto se guarda durante semanas.',
    '',
    'Devuelve SOLO este JSON, sin nada más:',
    '{',
    '  "papeles": {',
    '    "documento": "qué documento se exige para entrar (DNI, pasaporte…)",',
    '    "vigenciaMinima": "vigencia mínima exigida, o null si no hay",',
    '    "visado": { "haceFalta": true|false, "texto": "una frase", "tramite": "cómo se pide, o null" },',
    '    "seguro": { "obligatorio": true|false, "texto": "una o dos frases" }',
    '  },',
    '  "salud": {',
    '    "vacunasObligatorias": ["…"],',
    '    "vacunasRecomendadas": ["…"],',
    '    "nota": "lo que convenga saber (agua, tarjeta sanitaria europea…), o null"',
    '  },',
    '  "dinero": {',
    '    "moneda": "nombre y código, p. ej. Zloty polaco (PLN)",',
    '    "esEuro": true|false,',
    '    "dondeCambiar": "dónde y cuándo conviene cambiar, o null si es euro",',
    '    "consejos": ["consejos cortos sobre pagos, tarjetas, efectivo, propinas"]',
    '  }',
    '}',
  ].join('\n');

  const r = await consultarJSON(prompt, {
    maxTokens: 1600,
    paso: `preparar la ficha de ${pais}`,
  });

  return {
    papeles: r?.papeles ?? null,
    salud: r?.salud ?? null,
    dinero: r?.dinero ?? null,
  };
}

/**
 * GENERA (O REGENERA) LA FICHA DE UN PAÍS y la guarda.
 *
 * Cada fuente va por su cuenta: si Exteriores está caído —que se cae, durante
 * las pruebas devolvió 503 desde su WAF— la ficha sale igual con lo demás y con
 * su nota de que esa parte no se pudo consultar. Callar que falta algo sería
 * peor que decirlo.
 */
export async function generarFicha({ pais, codigoPais, fechaInicio = null, fechaFin = null }) {
  const norm = normalizarNombre(pais);
  const fuentes = { ia: false, festivos: false, exteriores: false };
  const problemas = [];

  // LAS TRES FUENTES A LA VEZ, no una detrás de otra.
  //
  // En fila esto tardaba diecisiete segundos, y no porque hubiera mucho que
  // hacer: la página de Exteriores se agotaba en su plazo de doce mientras las
  // otras dos esperaban su turno sin motivo. No dependen entre sí, así que van
  // juntas y lo que tarda es la más lenta.
  //
  // `allSettled` y no `all`: aquí el objetivo es justo el contrario de "si una
  // falla, aborta". Si una falla, las otras dos tienen que llegar igual.
  const [resIA, resFestivos, resExteriores] = await Promise.allSettled([
    preguntarALaIA(pais, fechaInicio, fechaFin),
    festivosEntre(codigoPais, fechaInicio, fechaFin),
    textoDeExteriores({ pais, codigoPais }),
  ]);

  let deLaIA = { papeles: null, salud: null, dinero: null };
  if (resIA.status === 'fulfilled') {
    deLaIA = resIA.value;
    fuentes.ia = true;
  } else {
    console.warn(`[ficha] la IA no pudo con ${pais}: ${resIA.reason?.message}`);
    problemas.push(`No se pudieron generar los papeles y el dinero (${resIA.reason?.message}).`);
  }

  let festivos = [];
  if (resFestivos.status === 'fulfilled') {
    festivos = resFestivos.value;
    fuentes.festivos = true;
  } else {
    console.warn(`[ficha] sin festivos de ${pais}: ${resFestivos.reason?.message}`);
    problemas.push('No se pudieron consultar los festivos.');
  }

  let exteriores = null;
  if (resExteriores.status === 'fulfilled') {
    exteriores = resExteriores.value;
    fuentes.exteriores = exteriores !== null;
  } else {
    console.warn(`[ficha] Exteriores falló para ${pais}: ${resExteriores.reason?.message}`);
  }
  // España no tiene ficha en Exteriores —es el país del que se sale— y eso no
  // es un problema que haya que contar.
  if (!exteriores && codigoPais !== 'ES') {
    problemas.push('No se pudo leer la recomendación de Exteriores.');
  }

  const datos = { ...deLaIA, festivos, exteriores, fuentes, problemas };

  ejecutar(
    `INSERT INTO fichas_pais (pais_norm, pais, codigo_pais, fecha_inicio, fecha_fin, datos, generado_en)
     VALUES (?, ?, ?, ?, ?, ?, datetime('now'))
     ON CONFLICT (pais_norm, fecha_inicio, fecha_fin) DO UPDATE SET
       pais        = excluded.pais,
       codigo_pais = excluded.codigo_pais,
       datos       = excluded.datos,
       generado_en = excluded.generado_en`,
    norm,
    pais,
    codigoPais ?? null,
    fechaInicio,
    fechaFin,
    JSON.stringify(datos)
  );

  console.log(
    `[ficha] ${pais}: generada` +
      ` · IA ${fuentes.ia ? 'sí' : 'no'}` +
      ` · ${festivos.length} festivos` +
      ` · Exteriores ${fuentes.exteriores ? 'sí' : 'no'}`
  );

  return comoFicha(filaGuardada(norm, fechaInicio, fechaFin), fechaInicio);
}

// =============================================================================
// LO QUE PIDE LA PANTALLA
// =============================================================================
/**
 * Las fichas del viaje: una por país, con lo que haya guardado.
 *
 * NO GENERA NADA. La pantalla abre al instante con lo que hay y pide lo que
 * falte por su cuenta, para que abrir el panel nunca se quede esperando a una
 * llamada a la IA.
 */
export async function fichasDelViaje(viajeId) {
  const viaje = una('SELECT * FROM viajes WHERE id = ?', viajeId);
  if (!viaje) return null;

  const paises = await paisesDelViaje(viajeId);
  const { fecha_inicio: inicio, fecha_fin: fin } = viaje;

  const fichas = paises.map((p) => {
    const fila = filaGuardada(p.norm, inicio, fin);
    return {
      pais: p.pais,
      norm: p.norm,
      codigoPais: p.codigoPais,
      ficha: fila ? comoFicha(fila, inicio) : null,
    };
  });

  return {
    viajeId,
    fechaInicio: inicio,
    fechaFin: fin,
    rango: inicio && fin ? `${enLargo(inicio)} — ${enLargo(fin)}` : null,
    paises: fichas,
    // Para el botón de la pantalla: si algo pide atención, se nota desde fuera.
    algoQueActualizar: fichas.some((f) => f.ficha?.convieneActualizar),
    faltaAlguna: fichas.some((f) => !f.ficha),
  };
}

/** Lo mismo, pero para el dosier: sin generar y en plano. */
export function fichasParaElDosier(viajeId) {
  const viaje = una('SELECT * FROM viajes WHERE id = ?', viajeId);
  if (!viaje) return [];

  const filas = todas(
    `SELECT * FROM fichas_pais
      WHERE fecha_inicio IS ? AND fecha_fin IS ?
      ORDER BY pais`,
    viaje.fecha_inicio ?? null,
    viaje.fecha_fin ?? null
  );

  // SOLO LOS PAÍSES DE ESTE VIAJE. La tabla se comparte entre viajes con las
  // mismas fechas, así que sin filtrar aquí el dosier de un viaje a Polonia
  // podía acabar con la ficha de Chequia de otro. Pasó en las pruebas.
  //
  // Se lee de `etapas.pais`, que es donde lo dejó `paisesDelViaje`. Si está
  // vacío —nadie ha abierto el panel todavía— no se enseña nada en vez de
  // enseñarlo todo: un dosier sin la ficha se nota y se arregla abriéndola;
  // uno con la ficha del país equivocado no se nota y engaña.
  const suyos = new Set(
    todas(
      'SELECT DISTINCT pais FROM etapas WHERE viaje_id = ? AND pais IS NOT NULL',
      viajeId
    ).map((r) => normalizarNombre(r.pais))
  );

  return filas
    .filter((f) => suyos.has(f.pais_norm))
    .map((f) => comoFicha(f, viaje.fecha_inicio));
}

export default { paisesDelViaje, fichasDelViaje, generarFicha, fichasParaElDosier };
