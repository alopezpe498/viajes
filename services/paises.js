/**
 * services/paises.js
 * -----------------------------------------------------------------------------
 * VIAJES DE MÁS DE UN PAÍS.
 *
 * Mecánicamente la aplicación ya sabía hacerlos casi todos: los vuelos son
 * open-jaw —entrar por una ciudad y salir por otra es lo mismo cruzando una
 * frontera—, los traslados se investigan salto a salto sin preguntar de qué
 * país es cada punta, y sitios, hoteles y excursiones trabajan por ciudad. Lo
 * que no existía era la ENTRADA: una forma de decir «Croacia y Montenegro» y
 * que eso significara algo.
 *
 * TRES PIEZAS, Y EN ESTE ORDEN:
 *
 *   1. LEER. Un paso de IA traduce el texto libre a una lista de países. Solo
 *      lee: no opina. Y si el texto es ambiguo lo dice en vez de elegir, porque
 *      preguntar cuesta un clic y adivinar mal cuesta un viaje entero montado
 *      sobre el país equivocado.
 *
 *   2. OPINAR. Con más de un país hay una decisión de verdad que tomar —¿entra
 *      Montenegro o no?— y la toma el usuario, con criterio delante. La IA
 *      propone y explica; el usuario marca y desmarca; la IA vuelve a opinar
 *      sobre lo nuevo. Las veces que haga falta.
 *
 *   3. DISTINGUIR DOS NOES. «No te lo recomiendo» es una opinión y se puede
 *      ignorar: el viaje es de quien lo hace. «No cabe» es aritmética —los
 *      traslados mínimos ya se comen los días— y ahí insistir sería mentir. El
 *      botón de insistir existe para el primero y no para el segundo.
 *
 * CON UN SOLO PAÍS NO PASA NADA DE ESTO. `esMultipais` es falso, no hay
 * diálogo, y el flujo es exactamente el de siempre. Esa es la garantía de que
 * esto no toca lo que ya funcionaba.
 */

import { todas, una, ejecutar, normalizarNombre, nochesEntre } from '../db/index.js';
import { consultarJSON } from '../lib/ia.js';
import { promptDeFase } from './orquestador.js';
import { ocupacionDe } from './proveedores.js';

/** Desde dónde se viaja. Los papeles y las fronteras se responden para esto. */
const PASAPORTE = 'España';

const texto = (v, tope = 120) => {
  const t = String(v ?? '').trim();
  return t && t !== 'null' ? t.slice(0, tope) : null;
};

/** Rellena {{HUECOS}} de una plantilla. El mismo de las fases. */
export function rellenar(plantilla, datos) {
  return plantilla.replace(/\{\{([A-Z_]+)\}\}/g, (_, c) => {
    const v = datos[c];
    return v === undefined || v === null ? '' : String(v);
  });
}

// =============================================================================
// LO QUE HAY GUARDADO
// =============================================================================
/** Los países confirmados de un viaje, o [] si es de uno solo. */
export function paisesDelViaje(viaje) {
  try {
    const l = viaje?.paises ? JSON.parse(viaje.paises) : null;
    return Array.isArray(l) ? l.filter((x) => typeof x === 'string' && x.trim()) : [];
  } catch {
    return [];
  }
}

/**
 * ¿Es un viaje de varios países?
 *
 * DOS O MÁS, no «tiene lista». Un viaje a Croacia interpretado como ["Croacia"]
 * es un viaje de un país y tiene que comportarse como tal: sin diálogo, sin
 * pestañas de más y con la regla 1 de siempre.
 */
export function esMultipais(viaje) {
  return paisesDelViaje(viaje).length > 1;
}

/** El diálogo guardado (la última opinión), o null. */
export function dialogoGuardado(viaje) {
  try {
    return viaje?.paises_dialogo ? JSON.parse(viaje.paises_dialogo) : null;
  } catch {
    return null;
  }
}

/**
 * El estado en que está la interpretación:
 *
 *   'ninguno'      · viaje de un país o sin destino: aquí no hay nada que hacer.
 *   'interpretado' · la IA ha leído el texto y espera confirmación.
 *   'confirmado'   · el usuario ha cerrado la lista; el orquestador puede ir.
 */
export function estadoDePaises(viaje) {
  if (!paisesDelViaje(viaje).length) return 'ninguno';
  return viaje.paises_estado === 'confirmado' ? 'confirmado' : 'interpretado';
}

// =============================================================================
// 1) LEER EL TEXTO
// =============================================================================
/**
 * INTERPRETA EL DESTINO ESCRITO.
 *
 * Se llama con lo que el usuario tecleó, tal cual. Devuelve la lista, si está
 * seguro, y la nota de la duda cuando no lo está.
 *
 * NO GUARDA NADA: quien llama decide qué hacer con la lectura. Separarlo así es
 * lo que permite enseñarla y pedir confirmación antes de gastar un euro.
 */
export async function interpretarDestino(textoDestino) {
  const t = String(textoDestino ?? '').trim();
  if (!t) return { paises: [], seguro: false, nota: 'No hay destino escrito.' };

  const r = await consultarJSON(rellenar(promptDeFase('paises_interpretar'), { TEXTO: t }), {
    maxTokens: 600,
    paso: `interpretar el destino «${t}»`,
    // Sacar los nombres de país de una frase es leer, no decidir.
    modelo: 'rapido',
  });

  const paises = (Array.isArray(r?.paises) ? r.paises : [])
    .map((x) => texto(x))
    .filter(Boolean);

  // SIN PAÍSES NO HAY LECTURA. Devolver una lista vacía como si fuera un
  // resultado dejaría al viaje sin ámbito y a la fase 1 sin regla contra la que
  // comparar, que es justo lo que sostiene todo lo demás.
  if (!paises.length) {
    return { paises: [], seguro: false, nota: r?.nota ?? `No he sabido leer «${t}».` };
  }

  // Sin repetidos y respetando el orden en que se escribieron.
  const vistos = new Set();
  const limpios = paises.filter((p) => {
    const k = normalizarNombre(p);
    if (vistos.has(k)) return false;
    vistos.add(k);
    return true;
  });

  return {
    paises: limpios,
    seguro: r?.seguro !== false && limpios.length > 0,
    nota: texto(r?.nota, 300),
  };
}

/**
 * Guarda la lectura en el viaje, SIN confirmar.
 *
 * El viaje queda con su lista y en estado «interpretado»: la pantalla la enseña
 * y hasta que alguien diga que sí, no se arranca nada.
 */
export function guardarInterpretacion(viajeId, paises) {
  ejecutar(
    "UPDATE viajes SET paises = ?, paises_estado = 'interpretado', paises_dialogo = NULL WHERE id = ?",
    JSON.stringify(paises),
    Number(viajeId)
  );
  return una('SELECT * FROM viajes WHERE id = ?', Number(viajeId));
}

/** Cierra la lista: a partir de aquí el orquestador trabaja con ella. */
export function confirmarPaises(viajeId, paises) {
  const limpios = (Array.isArray(paises) ? paises : []).map((x) => texto(x)).filter(Boolean);
  if (!limpios.length) return { error: 'Hay que dejar al menos un país.' };

  ejecutar(
    "UPDATE viajes SET paises = ?, paises_estado = 'confirmado' WHERE id = ?",
    JSON.stringify(limpios),
    Number(viajeId)
  );
  return { viaje: una('SELECT * FROM viajes WHERE id = ?', Number(viajeId)) };
}

// =============================================================================
// 2) EL DIÁLOGO DE CRITERIO
// =============================================================================
/**
 * QUÉ OPINA LA IA DE ESTA SELECCIÓN.
 *
 * `seleccion` son los países marcados ahora mismo; `todos` es la lista completa
 * que salió del texto, porque de los desmarcados también hay que decir por qué
 * se quedan fuera —si no, desmarcar algo lo hace desaparecer sin explicación—.
 *
 * Solo criterio: ni una búsqueda, ni un scraping. Distancias, lógica de
 * traslados y lo que el modelo sabe de geografía. Los precios y los horarios
 * llegan después, en las fases que sí buscan, y se enseñan como lo que son.
 */
export async function opinarSobreSeleccion(viaje, seleccion) {
  const todos = paisesDelViaje(viaje);
  const elegidos = (Array.isArray(seleccion) && seleccion.length ? seleccion : todos)
    .map((x) => texto(x))
    .filter(Boolean);

  const { adultos, edadesNinos } = ocupacionDe(viaje);
  const dias = nochesEntre(viaje.fecha_inicio, viaje.fecha_fin) + 1;

  const r = await consultarJSON(
    rellenar(promptDeFase('paises_criterio'), {
      SELECCION: elegidos.join(', '),
      TODOS: todos.join(', '),
      FECHA_INICIO: viaje.fecha_inicio ?? '(sin fecha)',
      FECHA_FIN: viaje.fecha_fin ?? '(sin fecha)',
      DIAS: dias,
      ORIGEN: viaje.ciudad_origen || 'España',
      VIAJEROS:
        `${adultos} adulto(s)` + (edadesNinos.length ? ` y ${edadesNinos.length} niño(s)` : ''),
      RITMO: viaje.ritmo || 'normal',
    }),
    {
      maxTokens: 1500,
      paso: `criterio sobre ${elegidos.join(' + ')}`,
      // Decir si tres países caben en nueve días y cuál quitar es la clase de
      // juicio por la que se paga el modelo grande.
      modelo: 'criterio',
    }
  );

  // EL VEREDICTO SOLO PUEDE SER UNA DE DOS COSAS, y de él depende que el botón
  // de insistir exista o no. Cualquier otra respuesta se trata como «cabe»: la
  // opción segura es dejar decidir al usuario, no bloquearle el viaje por una
  // palabra que el modelo escribió mal.
  const veredicto = r?.veredicto === 'no_cabe' ? 'no_cabe' : 'cabe';

  const porNombre = new Map(
    (Array.isArray(r?.paises) ? r.paises : []).map((x) => [normalizarNombre(x?.nombre ?? ''), x])
  );

  const dialogo = {
    veredicto,
    puedeInsistir: veredicto === 'cabe',
    porQueNoCabe: veredicto === 'no_cabe' ? texto(r?.por_que_no_cabe, 400) : null,
    opinion: texto(r?.opinion, 800),
    seleccion: elegidos,
    // Se devuelven TODOS, marcados o no: los desmarcados llevan su motivo y por
    // eso siguen en pantalla en vez de desaparecer.
    paises: todos.map((p) => {
      const d = porNombre.get(normalizarNombre(p));
      const marcado = elegidos.some((e) => normalizarNombre(e) === normalizarNombre(p));
      return {
        nombre: p,
        marcado,
        recomendado: d?.recomendado !== false,
        porQue: texto(d?.por_que, 300),
      };
    }),
    pensadoEn: new Date().toISOString().slice(0, 19).replace('T', ' '),
  };

  ejecutar(
    'UPDATE viajes SET paises_dialogo = ? WHERE id = ?',
    JSON.stringify(dialogo),
    viaje.id
  );

  return dialogo;
}

// =============================================================================
// 3) LOS CRUCES DE FRONTERA
// =============================================================================
/**
 * Los países de la ruta CONFIRMADA, en el orden en que se pisan.
 *
 * No es la lista de países del viaje: es la secuencia real. Croacia →
 * Montenegro → Croacia son tres tramos y dos cruces, y esa repetición es
 * justamente el dato que hay que ver.
 */
export function secuenciaDePaises(viajeId) {
  const etapas = todas(
    `SELECT nombre_ciudad, pais FROM etapas
      WHERE viaje_id = ? AND estado = 'confirmada' ORDER BY orden, id`,
    Number(viajeId)
  );

  const secuencia = [];
  for (const e of etapas) {
    const pais = e.pais?.trim() || null;
    if (!pais) continue;
    const ultimo = secuencia.at(-1);
    if (ultimo && normalizarNombre(ultimo.pais) === normalizarNombre(pais)) {
      ultimo.ciudades.push(e.nombre_ciudad);
      continue;
    }
    secuencia.push({ pais, ciudades: [e.nombre_ciudad] });
  }
  return secuencia;
}

/** ¿Hay algo que contar de fronteras en este viaje? */
export function hayFronteras(viajeId) {
  return secuenciaDePaises(viajeId).length > 1;
}

/** Los cruces guardados, o null si nunca se han pedido. */
export function fronterasGuardadas(viaje) {
  try {
    const f = viaje?.fronteras ? JSON.parse(viaje.fronteras) : null;
    if (!f) return null;
    return { ...f, calculadoEn: viaje.fronteras_en ?? null };
  } catch {
    return null;
  }
}

/**
 * PIDE LOS CRUCES DE FRONTERA DE LA RUTA.
 *
 * Se hace con la ruta ya decidida y no antes, porque depende del ORDEN: el
 * mismo par de países da un cruce o dos según por dónde se vuelva. Y el caso
 * que de verdad pilla a la gente —volar de vuelta desde un país por el que ya
 * se pasó— no se ve mirando la lista de países: se ve mirando la secuencia.
 */
export async function calcularFronteras(viaje) {
  const secuencia = secuenciaDePaises(viaje.id);
  if (secuencia.length < 2) {
    ejecutar(
      "UPDATE viajes SET fronteras = ?, fronteras_en = datetime('now') WHERE id = ?",
      JSON.stringify({ cruces: [], nota: null }),
      viaje.id
    );
    return { cruces: [], nota: null, calculadoEn: null };
  }

  const ruta = secuencia
    .map((t, i) => `${i + 1}. ${t.pais} — ${t.ciudades.join(', ')}`)
    .join('\n');

  const r = await consultarJSON(
    rellenar(promptDeFase('fronteras'), {
      RUTA: ruta,
      PASAPORTE,
      ORIGEN: viaje.ciudad_origen || 'España',
    }),
    {
      maxTokens: 1600,
      paso: `fronteras de ${secuencia.map((s) => s.pais).join(' → ')}`,
      // Un visado mal contado estropea el viaje entero: aquí no se ahorra.
      modelo: 'criterio',
    }
  );

  const cruces = (Array.isArray(r?.cruces) ? r.cruces : [])
    .map((c) => ({
      desde: texto(c?.desde),
      hasta: texto(c?.hasta),
      entre: texto(c?.entre, 160),
      tipo: ['terrestre', 'aereo', 'maritimo'].includes(c?.tipo) ? c.tipo : 'terrestre',
      quePide: texto(c?.que_pide, 500),
      dobleEntrada: c?.dobleEntrada === true,
    }))
    .filter((c) => c.desde && c.hasta);

  const datos = { cruces, nota: texto(r?.nota, 400) };

  ejecutar(
    "UPDATE viajes SET fronteras = ?, fronteras_en = datetime('now') WHERE id = ?",
    JSON.stringify(datos),
    viaje.id
  );

  return { ...datos, calculadoEn: una('SELECT fronteras_en f FROM viajes WHERE id = ?', viaje.id)?.f };
}

export default {
  interpretarDestino,
  guardarInterpretacion,
  confirmarPaises,
  opinarSobreSeleccion,
  paisesDelViaje,
  esMultipais,
  estadoDePaises,
  dialogoGuardado,
  secuenciaDePaises,
  hayFronteras,
  fronterasGuardadas,
  calcularFronteras,
};
