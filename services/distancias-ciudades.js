/**
 * services/distancias-ciudades.js
 * -----------------------------------------------------------------------------
 * Cuánto hay entre dos ciudades del catálogo, y con qué cara pintarlo.
 *
 * PARA DECIDIR LA RUTA. Mirando Italia hay que poder saber si Florencia está a
 * tiro de Roma para un fin de semana o si son tres horas de carretera. Eso se
 * decide ANTES de armar la ruta, y hasta ahora el mapa solo decoraba.
 *
 * SE CALCULA UNA VEZ Y YA. La distancia de Roma a Florencia no cambia, así que
 * vive en el CATÁLOGO (`distancias_ciudades`) y no caduca. La segunda vez que
 * alguien mire Italia —en este viaje o en otro— no se le pregunta nada a nadie.
 *
 * DE UNA EN UNA. OSRM es un servidor de demostración gratuito: `porCarretera`
 * ya serializa las peticiones con su pausa, y aquí se recorre la lista en un
 * bucle normal, no con Promise.all. Veinte peticiones a la vez a un servidor
 * que nos deja usarlo gratis es la forma de que dejen de dejarnos.
 *
 * NUNCA ROMPE LA PANTALLA. Si Google falla o tarda, la ficha se queda con un
 * guión y se reintenta la próxima vez que se abra el mapa. Una distancia que
 * falta es una molestia; una pantalla que no carga, un problema.
 */

import { todas, una, ejecutar } from '../db/index.js';
import { referenciaDeTramo, comoDuracion } from './distancias.js';
import { geocodificarConGoogle } from '../lib/google.js';
import { consultarJSON, hayClaveIA } from '../lib/ia.js';

// =============================================================================
// LOS UMBRALES
// -----------------------------------------------------------------------------
// A partir de aquí un traslado deja de ser un rato en coche y pasa a ser el plan
// del día. Los números son los del encargo, y el criterio es el mismo para km y
// para tiempo: basta con pasarse en UNO de los dos.
// =============================================================================
const AVISO_KM = 400;
const AVISO_MIN = 4 * 60;
const MUCHO_KM = 700;
const MUCHO_MIN = 7 * 60;

/** Horas de carretera al día a partir de las cuales el viaje es un traslado. */
const HORAS_POR_DIA = 1.5;

/** Verde, ámbar o rojo. Es lo que decide el color de la ficha. */
export function gravedad({ km, minutos }) {
  const k = Number(km) || 0;
  const m = Number(minutos) || 0;
  if (k > MUCHO_KM || m > MUCHO_MIN) return 'mucho';
  if (k > AVISO_KM || m > AVISO_MIN) return 'aviso';
  return 'cerca';
}

/** El par, siempre con el id menor delante: una fila sirve para los dos sentidos. */
const ordenado = (a, b) => (a < b ? [a, b] : [b, a]);

/** Lo que hay guardado de un par, o null. */
export function distanciaGuardada(ciudadA, ciudadB) {
  if (!ciudadA || !ciudadB || ciudadA === ciudadB) return null;
  const [x, y] = ordenado(Number(ciudadA), Number(ciudadB));
  return una(
    'SELECT * FROM distancias_ciudades WHERE ciudad_origen_id = ? AND ciudad_destino_id = ?',
    x,
    y
  );
}

/** Guarda (o actualiza) el par. */
function guardar(ciudadA, ciudadB, ref) {
  const [x, y] = ordenado(Number(ciudadA), Number(ciudadB));
  ejecutar(
    `INSERT INTO distancias_ciudades (ciudad_origen_id, ciudad_destino_id, km, minutos_coche, fuente)
     VALUES (?, ?, ?, ?, ?)
     ON CONFLICT (ciudad_origen_id, ciudad_destino_id) DO UPDATE SET
       km = excluded.km,
       minutos_coche = excluded.minutos_coche,
       fuente = excluded.fuente,
       fecha_calculo = datetime('now')`,
    x,
    y,
    ref.km,
    ref.minutos,
    ref.fuente
  );
}

/**
 * Situa una ciudad del catalogo que no tenga coordenadas.
 *
 * POR QUE HACE FALTA. Las ciudades que llegan del mapa vienen con lat/lon de la
 * investigacion del destino, pero el orquestador puede meter en la ruta una
 * ciudad que no estaba en esa lista (Zakopane en Polonia) y la crea a pelo, sin
 * coordenadas. Sin coordenadas no hay distancia posible, asi que "Mi ruta"
 * decia "0 km (2 tramos sin calcular)" con los dos tramos resueltos y en verde:
 * no era que fallara el calculo, es que no habia desde donde calcular.
 *
 * Se pregunta por "Ciudad, Pais" para no acabar en la Cracovia de Wisconsin.
 * Si Google no contesta se devuelve null y se reintenta la proxima vez: una
 * ciudad sin situar deja su salto sin kilometros y no rompe nada mas.
 */
async function asegurarCoordenadas(puntoId) {
  const p = una(
    'SELECT id, nombre, lat, lon, destino_id FROM puntos_interes WHERE id = ?',
    Number(puntoId)
  );
  if (!p) return null;
  if (p.lat != null && p.lon != null) return p;

  const destino = p.destino_id
    ? una('SELECT nombre, pais FROM destinos WHERE id = ?', p.destino_id)
    : null;
  const consulta = [p.nombre, destino?.pais || destino?.nombre]
    .filter(Boolean)
    .filter((t, i, xs) => xs.indexOf(t) === i)
    .join(', ');

  let hallado = null;
  try {
    hallado = await geocodificarConGoogle(consulta);
  } catch (err) {
    console.warn(`[distancias] no pude situar "${consulta}": ${err.message}`);
  }

  // SEGUNDA VIA: LA IA, que es de donde salen las coordenadas del resto del
  // catalogo. Las ciudades del mapa se guardan con el lat/lon que da el modelo
  // al investigar el destino, asi que preguntarselo aqui no es rebajar la
  // fuente: es usar la misma. Sirve ademas para cuando la clave de Google no
  // esta o esta capada por IP, que es justo cuando esto hace mas falta.
  if (!hallado && hayClaveIA()) {
    try {
      const r = await consultarJSON(
        `Dame las coordenadas del centro de esta ciudad: ${consulta}. ` +
          'Responde solo {"lat": numero, "lon": numero}. Si no sabes cual es, ' +
          'responde {"lat": null, "lon": null}: prefiero un hueco a un sitio equivocado.',
        { maxTokens: 200, paso: `situar ${consulta}` }
      );
      const lat = Number(r?.lat);
      const lon = Number(r?.lon);
      if (Number.isFinite(lat) && Number.isFinite(lon) && Math.abs(lat) <= 90 && Math.abs(lon) <= 180) {
        hallado = { lat, lng: lon };
      }
    } catch (err) {
      console.warn(`[distancias] la IA tampoco situo "${consulta}": ${err.message}`);
    }
  }

  if (!hallado) {
    console.warn(`[distancias] sin coordenadas para "${consulta}".`);
    return null;
  }

  ejecutar(
    'UPDATE puntos_interes SET lat = ?, lon = ? WHERE id = ?',
    hallado.lat,
    hallado.lng,
    p.id
  );
  console.log(`[distancias] situada "${consulta}": ${hallado.lat}, ${hallado.lng}`);
  return { ...p, lat: hallado.lat, lon: hallado.lng };
}

/** Un punto del catálogo con sus coordenadas, o null si no las tiene. */
function ciudadConCoordenadas(id) {
  const p = una('SELECT id, nombre, lat, lon FROM puntos_interes WHERE id = ?', Number(id));
  if (!p || p.lat == null || p.lon == null) return null;
  return p;
}

/**
 * La distancia entre dos ciudades, de la caché o recién calculada.
 *
 * Devuelve null cuando falta una coordenada o cuando Google no contesta: quien
 * llama pinta un guión y se vuelve a intentar la próxima vez.
 */
export async function distanciaEntre(ciudadA, ciudadB) {
  if (!ciudadA || !ciudadB || Number(ciudadA) === Number(ciudadB)) return null;

  const guardada = distanciaGuardada(ciudadA, ciudadB);
  if (guardada) {
    return { km: guardada.km, minutos: guardada.minutos_coche, fuente: guardada.fuente };
  }

  const a = ciudadConCoordenadas(ciudadA);
  const b = ciudadConCoordenadas(ciudadB);
  if (!a || !b) return null;

  const ref = await referenciaDeTramo(a, b);
  if (!ref?.km) return null;

  guardar(ciudadA, ciudadB, ref);
  return ref;
}

/**
 * Calcula lo que falte entre una ciudad y una lista, de una en una.
 *
 * Devuelve cuántas se han resuelto y cuántas se han quedado sin dato, que es lo
 * que la pantalla necesita para saber si seguir preguntando.
 */
export async function calcularDesde(ciudadReferencia, ciudades) {
  let hechas = 0;
  let fallidas = 0;

  for (const id of ciudades) {
    if (Number(id) === Number(ciudadReferencia)) continue;
    if (distanciaGuardada(ciudadReferencia, id)) continue;

    const r = await distanciaEntre(ciudadReferencia, id);
    if (r) hechas++;
    else fallidas++;
  }

  return { hechas, fallidas };
}

/**
 * Calcula los saltos de UNA RUTA: cada parada con la siguiente.
 *
 * POR QUÉ HACÍA FALTA. Lo único que llenaba la caché era el mapa, y el mapa
 * calcula desde la ciudad de entrada a las candidatas del destino: pares
 * «entrada ↔ X». Una ruta Varsovia → Gdansk → Cracovia necesita además
 * Gdansk ↔ Cracovia, que no es par de nadie, así que "Mi ruta" enseñaba
 * «0 km (2 tramos sin calcular)» con los dos tramos resueltos y en verde.
 *
 * Los pares ya calculados se saltan, así que llamar a esto de más no cuesta
 * nada: el catálogo no caduca.
 */
export async function calcularDistanciasDeLaRuta(viajeId) {
  const etapas = todas(
    `SELECT id, nombre_ciudad, punto_interes_id
       FROM etapas WHERE viaje_id = ? AND estado = 'confirmada'
      ORDER BY orden, id`,
    viajeId
  );

  let hechas = 0;
  let fallidas = 0;

  for (let i = 0; i < etapas.length - 1; i++) {
    const a = etapas[i];
    const b = etapas[i + 1];
    if (!a.punto_interes_id || !b.punto_interes_id) continue;
    if (Number(a.punto_interes_id) === Number(b.punto_interes_id)) continue;
    if (distanciaGuardada(a.punto_interes_id, b.punto_interes_id)) continue;

    // Las ciudades que mete el orquestador de su cosecha no traen coordenadas.
    // Se situan aqui, que es justo cuando se necesitan.
    await asegurarCoordenadas(a.punto_interes_id);
    await asegurarCoordenadas(b.punto_interes_id);

    const r = await distanciaEntre(a.punto_interes_id, b.punto_interes_id);
    if (r) hechas++;
    else fallidas++;
  }

  return { hechas, fallidas };
}

// =============================================================================
// CÓMO SE ESCRIBE
// =============================================================================
const conMiles = (n) => Number(n).toLocaleString('es-ES');

/**
 * "A 280 km · 3 h en coche de Roma".
 *
 * Sin tiempo cuando la fuente es la línea recta: entre islas no hay coche que
 * valga, y decir "8 h en coche" de Palermo a Nápoles sería mentira.
 */
export function comoTextoDesde(ref, nombreReferencia) {
  if (!ref?.km) return null;
  const desde = nombreReferencia ? ` de ${nombreReferencia}` : '';

  if (ref.fuente === 'recta') {
    return `A ${conMiles(Math.round(ref.km))} km en línea recta${desde}`;
  }
  const tiempo = comoDuracion(ref.minutos);
  return `A ${conMiles(Math.round(ref.km))} km` + (tiempo ? ` · ${tiempo} en coche` : '') + desde;
}

/** Lo mismo, cortito, para la etiqueta de una línea del mapa. */
export function comoEtiqueta(ref) {
  if (!ref?.km) return null;
  const tiempo = ref.fuente === 'recta' ? null : comoDuracion(ref.minutos);
  return `${conMiles(Math.round(ref.km))} km` + (tiempo ? ` · ${tiempo}` : '');
}

// =============================================================================
// EL PUNTO DE REFERENCIA DEL VIAJE
// =============================================================================
/**
 * Desde dónde se miden las distancias de un viaje.
 *
 * En este orden, que es el de "lo que ya se sabe seguro":
 *
 *   1. La PRIMERA PARADA de la ruta. Si ya hay ruta, por ahí se entra.
 *   2. La ciudad a la que LLEGA EL VUELO de ida, si ese tramo existe. Sirve
 *      cuando el viaje tiene transporte apuntado antes que ruta.
 *   3. La PRIMERA CIUDAD SELECCIONADA, aunque siga siendo candidata. Al elegir
 *      la primera en el mapa todavía no está confirmada, y esperar a que lo esté
 *      dejaría la pantalla sin distancias justo cuando más hacen falta: cuando
 *      se está decidiendo qué más cabe.
 *   4. Nada. Sin referencia no se pinta ninguna distancia, y ya está.
 */
export function referenciaDelViaje(viajeId) {
  const primera = una(
    `SELECT e.id, e.nombre_ciudad, e.punto_interes_id
       FROM etapas e
      WHERE e.viaje_id = ? AND e.estado = 'confirmada' AND e.punto_interes_id IS NOT NULL
      ORDER BY e.orden, e.id LIMIT 1`,
    viajeId
  );
  if (primera) {
    return { ciudadId: primera.punto_interes_id, nombre: primera.nombre_ciudad, de: 'ruta' };
  }

  const llegada = una(
    `SELECT e.nombre_ciudad, e.punto_interes_id
       FROM transportes t
       JOIN etapas e ON e.id = t.etapa_destino_id
      WHERE t.viaje_id = ? AND t.etapa_origen_id IS NULL AND e.punto_interes_id IS NOT NULL
      ORDER BY t.id LIMIT 1`,
    viajeId
  );
  if (llegada) {
    return { ciudadId: llegada.punto_interes_id, nombre: llegada.nombre_ciudad, de: 'vuelo' };
  }

  const candidata = una(
    `SELECT e.nombre_ciudad, e.punto_interes_id
       FROM etapas e
      WHERE e.viaje_id = ? AND e.punto_interes_id IS NOT NULL
      ORDER BY e.orden, e.id LIMIT 1`,
    viajeId
  );
  if (candidata) {
    return { ciudadId: candidata.punto_interes_id, nombre: candidata.nombre_ciudad, de: 'seleccion' };
  }

  return null;
}

/**
 * Las distancias de un destino desde la referencia del viaje, para el mapa.
 *
 * Devuelve SOLO lo que ya está en caché y dice qué falta. El cálculo va aparte,
 * en su trabajo de fondo: esta pantalla no puede quedarse esperando a OSRM.
 */
export function distanciasDelMapa(destinoId, viajeId) {
  const referencia = viajeId ? referenciaDelViaje(viajeId) : null;
  if (!referencia) return { referencia: null, distancias: {}, faltan: 0, total: 0 };

  const candidatas = todas(
    `SELECT id FROM puntos_interes
      WHERE destino_id = ? AND categoria = 'ciudad' AND lat IS NOT NULL AND lon IS NOT NULL`,
    destinoId
  ).map((p) => p.id);

  const distancias = {};
  let faltan = 0;

  for (const id of candidatas) {
    if (id === referencia.ciudadId) continue;
    const g = distanciaGuardada(referencia.ciudadId, id);
    if (!g) {
      faltan++;
      continue;
    }
    const ref = { km: g.km, minutos: g.minutos_coche, fuente: g.fuente };
    distancias[id] = {
      km: Math.round(g.km),
      minutos: g.minutos_coche,
      fuente: g.fuente,
      texto: comoTextoDesde(ref, referencia.nombre),
      etiqueta: comoEtiqueta(ref),
      gravedad: gravedad(ref),
    };
  }

  return {
    referencia,
    distancias,
    faltan,
    total: candidatas.filter((id) => id !== referencia.ciudadId).length,
  };
}

// =============================================================================
// LA RUTA: TRASLADOS Y VIABILIDAD
// =============================================================================
/**
 * Los kilómetros y las horas de los saltos de una ruta, y si son demasiados.
 *
 * SOLO LOS SALTOS DE EN MEDIO. La ida y la vuelta a casa son vuelos, y sumar sus
 * kilómetros aquí convertiría cualquier viaje a Italia en "4.000 km de coche".
 * Lo que se quiere saber es cuánta carretera hay DENTRO del viaje.
 */
export function trasladosDeLaRuta(viajeId) {
  const etapas = todas(
    `SELECT id, nombre_ciudad, punto_interes_id
       FROM etapas WHERE viaje_id = ? AND estado = 'confirmada'
      ORDER BY orden, id`,
    viajeId
  );

  const saltos = [];
  let km = 0;
  let minutos = 0;
  let incompletos = 0;

  for (let i = 0; i < etapas.length - 1; i++) {
    const a = etapas[i];
    const b = etapas[i + 1];

    const g =
      a.punto_interes_id && b.punto_interes_id
        ? distanciaGuardada(a.punto_interes_id, b.punto_interes_id)
        : null;

    if (!g) {
      incompletos++;
      saltos.push({ de: a.nombre_ciudad, a: b.nombre_ciudad, texto: null });
      continue;
    }

    const ref = { km: g.km, minutos: g.minutos_coche, fuente: g.fuente };
    km += g.km ?? 0;
    if (g.fuente === 'carretera') minutos += g.minutos_coche ?? 0;

    saltos.push({
      de: a.nombre_ciudad,
      a: b.nombre_ciudad,
      km: Math.round(g.km),
      minutos: g.minutos_coche,
      fuente: g.fuente,
      texto: comoEtiqueta(ref),
      gravedad: gravedad(ref),
    });
  }

  return { saltos, km: Math.round(km), minutos, incompletos };
}

/**
 * ¿Cuánta carretera es demasiada para este viaje?
 *
 * Hora y media al día. Es una regla de servilleta y no pretende otra cosa: solo
 * avisa, no impide nada. Un viaje de tres días con nueve horas de coche se puede
 * hacer; lo que no se puede es no haberse dado cuenta.
 */
export function avisoDeTraslados(minutos, dias) {
  if (!minutos || !dias || dias <= 0) return null;

  const horas = minutos / 60;
  const tope = HORAS_POR_DIA * dias;
  if (horas <= tope) return null;

  return {
    horas: Math.round(horas * 10) / 10,
    dias,
    texto: `Ojo: muchas horas de carretera para ${dias} ${dias === 1 ? 'día' : 'días'}`,
  };
}
