/**
 * services/orquestador-ciudades.js
 * -----------------------------------------------------------------------------
 * FASE 1 DEL ORQUESTADOR: qué ciudades, por dónde se entra y sale, y cuántas
 * noches en cada una.
 *
 * Es la fase que decide la forma del viaje. Todas las demás cuelgan de ella: no
 * se puede buscar hotel en una ciudad que no está elegida ni colocar nada en un
 * día que no existe. Por eso es la única cuyo fallo deja el viaje sin nada que
 * enseñar, y por eso valida tanto antes de escribir.
 *
 * TRES PASOS, Y EL DE EN MEDIO ES EL QUE MANDA:
 *
 *   1. La IA propone candidatas. Son ideas: pesos, rangos de noches y una
 *      matriz de tiempos A OJO, sin llamar a Google. Aquí no se decide nada.
 *
 *   2. SE BUSCAN VUELOS DE VERDAD hacia las mejores puertas. Este paso existe
 *      porque una ruta preciosa a la que no se puede llegar no es una ruta. Lo
 *      que diga Kayak pesa más que lo que crea la IA: si a Osaka no hay vuelo
 *      directo y a Tokio sí, se entra por Tokio aunque la IA prefiriera Osaka.
 *
 *   3. La IA cierra la ruta CON LAS PUERTAS YA FIJADAS. No se le pregunta por
 *      dónde entrar —eso ya está decidido con datos reales—, sino cómo ordenar
 *      lo de en medio y cómo repartir las noches que quedan.
 *
 * TODO QUEDA NARRADO EN EL LOG. Cada decisión, con su motivo. Un viaje montado
 * solo del que no se puede saber por qué eligió Kioto y no Nara es un viaje en
 * el que no se puede confiar, y esta fase es justo la que hay que poder auditar.
 */
import { db, todas, una, ejecutar, normalizarNombre } from '../db/index.js';
import { consultarJSON, hayClaveIA, SIN_CLAVE } from '../lib/ia.js';
import { resolverIata } from '../lib/iata.js';
import { buscarVuelosKayak } from '../providers/kayak.js';
import { ocupacionDe, ciudadDeCasa } from '../services/proveedores.js';
import { asegurarDestino, destinoPorNombre } from '../services/catalogo.js';
import { recalcularRuta } from '../services/ruta.js';
import { anotar, apuntarHueco, parametro, configAuto } from '../services/orquestador.js';

/** Cuántas puertas se prueban con vuelos de verdad. Cada una son dos búsquedas. */
const MAX_PUERTAS = 3;

/** Cuántas opciones se piden a Kayak por búsqueda. No hacen falta más. */
const VUELOS_POR_BUSQUEDA = 8;

/** Las dos mitades del prompt editable, tal y como se separan en la tabla. */
const MARCA_CANDIDATAS = '=== PASO 1: CANDIDATAS ===';
const MARCA_CIERRE = '=== PASO 3: CIERRE ===';

// =============================================================================
// EL PROMPT
// =============================================================================
/**
 * Parte el prompt de la tabla en sus dos secciones.
 *
 * Un solo prompt editable y no dos filas porque las dos mitades hablan del mismo
 * problema y se corrigen juntas: si alguien afina lo que entiende por «ritmo
 * tranquilo» en la primera, la segunda tiene que decir lo mismo.
 */
export function partirPrompt(texto) {
  const i = texto.indexOf(MARCA_CANDIDATAS);
  const j = texto.indexOf(MARCA_CIERRE);
  if (i < 0 || j < 0 || j < i) {
    throw new Error(
      `El prompt de esta fase tiene que llevar las dos marcas «${MARCA_CANDIDATAS}» y ` +
        `«${MARCA_CIERRE}», en ese orden. Revísalo en el cerebro del orquestador.`
    );
  }
  return {
    candidatas: texto.slice(i + MARCA_CANDIDATAS.length, j).trim(),
    cierre: texto.slice(j + MARCA_CIERRE.length).trim(),
  };
}

/**
 * Sustituye los {{HUECOS}} del prompt por los datos del viaje.
 *
 * Se hace con marcas y no concatenando por código para que el prompt siga siendo
 * editable de verdad: quien lo abra puede mover un dato de sitio, o quitarlo, sin
 * tocar una línea de JavaScript. Un hueco que no se rellena se queda vacío en vez
 * de escribir «undefined» en mitad de la petición.
 */
export function rellenar(plantilla, datos) {
  return plantilla.replace(/\{\{([A-Z_]+)\}\}/g, (_, clave) => {
    const v = datos[clave];
    return v === undefined || v === null ? '' : String(v);
  });
}

// =============================================================================
// PASO 1: LAS CANDIDATAS
// =============================================================================
const texto = (v) => {
  const t = typeof v === 'string' ? v.trim() : '';
  return t || null;
};
const entero = (v, min, max) => {
  const n = Math.round(Number(v));
  return Number.isFinite(n) ? Math.min(Math.max(n, min), max) : null;
};

/** Sanea lo que devuelva la IA en el paso 1. Lo que venga raro se cae. */
function saneaCandidatas(respuesta, tope) {
  const crudas = Array.isArray(respuesta?.ciudades) ? respuesta.ciudades : [];

  const ciudades = crudas
    .filter((c) => c && typeof c.nombre === 'string' && c.nombre.trim())
    .slice(0, tope)
    .map((c) => {
      const min = entero(c.noches_min, 1, 30) ?? 1;
      const max = entero(c.noches_max, 1, 30) ?? min;
      return {
        nombre: c.nombre.trim(),
        peso: entero(c.peso, 1, 5) ?? 3,
        nochesMin: Math.min(min, max),
        nochesMax: Math.max(min, max),
        // Solo puede ser puerta lo que tenga aeropuerto con vuelos de fuera.
        puerta: Boolean(c.aeropuerto_internacional),
        iata: typeof c.iata === 'string' && /^[A-Z]{3}$/i.test(c.iata.trim())
          ? c.iata.trim().toUpperCase()
          : null,
        porQue: texto(c.por_que),
      };
    });

  const tiempos = (Array.isArray(respuesta?.tiempos) ? respuesta.tiempos : [])
    .filter((t) => t && t.desde && t.hasta)
    .map((t) => ({
      desde: String(t.desde).trim(),
      hasta: String(t.hasta).trim(),
      minutos: entero(t.minutos, 0, 3000),
      modo: ['tren', 'coche', 'vuelo', 'barco', 'bus'].includes(t.modo) ? t.modo : null,
    }));

  return { ciudades, tiempos };
}

// =============================================================================
// PASO 2: LAS PUERTAS, CON VUELOS DE VERDAD
// =============================================================================
/**
 * Los filtros de vuelo tal y como los espera el buscador de siempre.
 *
 * La configuración del modo automático guarda «indiferente» donde el buscador
 * espera `null`: son la misma idea dicha de dos maneras, y aquí se traduce.
 */
function filtrosDesdeConfig(auto, { sinFranja = false, sinEscalas = false } = {}) {
  const oNulo = (v) => (v && v !== 'indiferente' ? v : null);
  return {
    escalas: sinEscalas ? null : oNulo(auto.escalas),
    duracionMax: null,
    salidaIda: sinFranja ? null : oNulo(auto.franjaIda),
    salidaVuelta: sinFranja ? null : oNulo(auto.franjaVuelta),
    precioMaxPersona: null,
  };
}

/** Los minutos en el aire de una opción, sumando sus tramos. */
function minutosDe(opcion) {
  const aMin = (d) => {
    const m = String(d ?? '').match(/(?:(\d+)\s*h)?\s*(?:(\d+)\s*m)?/i);
    if (!m) return 0;
    return (Number(m[1]) || 0) * 60 + (Number(m[2]) || 0);
  };
  return (opcion.tramos ?? []).reduce((s, t) => s + aMin(t.duracion), 0);
}

/** La opción más corta de las que devolvió Kayak. */
function laMasCorta(opciones) {
  let mejor = null;
  for (const o of opciones) {
    const min = minutosDe(o);
    if (!min) continue;
    if (!mejor || min < mejor.minutos) mejor = { opcion: o, minutos: min };
  }
  return mejor;
}

/**
 * BUSCA UN VUELO, AFLOJANDO SI HACE FALTA.
 *
 * Tres intentos, y el orden no es casual: primero con todo puesto, luego sin la
 * franja horaria y por último sin la exigencia de vuelo directo. Se afloja
 * primero lo que menos duele —salir por la tarde en vez de por la mañana es una
 * molestia; hacer escala con niños es media jornada— y cada relajación queda
 * escrita en el log, porque es una condición del usuario que se está saltando.
 */
async function buscarAflojando({ viajeId, origen, destino, fecha, ocupacion, auto, comoSeLlama }) {
  const intentos = [
    { filtros: filtrosDesdeConfig(auto), nota: null },
    { filtros: filtrosDesdeConfig(auto, { sinFranja: true }), nota: 'sin la franja horaria' },
    {
      filtros: filtrosDesdeConfig(auto, { sinFranja: true, sinEscalas: true }),
      nota: 'sin la franja y aceptando escalas',
    },
  ];

  for (const [i, intento] of intentos.entries()) {
    // No se repite un intento idéntico: si el usuario no pidió franja ni
    // directos, aflojar no cambia nada y sería una búsqueda tirada.
    if (i > 0 && JSON.stringify(intento.filtros) === JSON.stringify(intentos[i - 1].filtros)) continue;

    try {
      const opciones = await buscarVuelosKayak({
        origen,
        destino,
        fechaIda: fecha,
        fechaVuelta: null,
        adultos: ocupacion.adultos,
        edadesNinos: ocupacion.edadesNinos,
        filtros: intento.filtros,
        maxResultados: VUELOS_POR_BUSQUEDA,
      });

      const mejor = laMasCorta(opciones);
      if (mejor) {
        if (intento.nota) {
          anotar(
            viajeId,
            'ciudades_y_noches',
            `   ${comoSeLlama}: no había nada con tus filtros; lo he buscado ${intento.nota}.`
          );
        }
        return { ...mejor, opciones, aflojado: intento.nota };
      }
    } catch (err) {
      anotar(viajeId, 'ciudades_y_noches', `   ${comoSeLlama}: la búsqueda falló (${err.message}).`);
      // Un fallo del buscador no se arregla aflojando filtros: se sale.
      return null;
    }
  }
  return null;
}

/**
 * ELIGE POR DÓNDE SE ENTRA Y POR DÓNDE SE SALE.
 *
 * Se prueban las mejores puertas —por peso, que es lo que la IA dice que merece
 * la pena— y se combinan entrada y salida quedándose con la de menos tiempo de
 * vuelo total.
 *
 * ENTRAR Y SALIR POR SITIOS DISTINTOS ES MEJOR y por eso se prefiere: ahorra
 * volver sobre tus pasos al final del viaje. Pero no a cualquier precio: si
 * repetir ciudad ahorra un tiempo claramente mayor que el umbral de empate, se
 * repite. Por debajo de ese umbral la diferencia no se nota y gana la ruta que
 * no obliga a desandar.
 */
async function elegirPuertas({ viaje, candidatas, auto, viajeId }) {
  const puertas = candidatas
    .filter((c) => c.puerta)
    .sort((a, b) => b.peso - a.peso)
    .slice(0, MAX_PUERTAS);

  if (!puertas.length) {
    return { error: 'La IA no propuso ninguna ciudad con aeropuerto internacional.' };
  }

  const casa = ciudadDeCasa(viaje);
  const iataCasa = await resolverIata(casa);
  if (!iataCasa) {
    return { error: `No he podido averiguar el aeropuerto de «${casa}».` };
  }

  const ocupacion = ocupacionDe(viaje);
  anotar(
    viajeId,
    'ciudades_y_noches',
    `Puertas que voy a probar con vuelos reales: ${puertas.map((p) => p.nombre).join(', ')}.`
  );

  // --- Las búsquedas, una por puerta y sentido ----------------------------
  const idas = new Map();
  const vueltas = new Map();

  for (const p of puertas) {
    const iata = p.iata ?? (await resolverIata(p.nombre));
    if (!iata) {
      anotar(viajeId, 'ciudades_y_noches', `   ${p.nombre}: sin aeropuerto que resolver; la salto.`);
      continue;
    }
    if (iata === iataCasa) {
      anotar(viajeId, 'ciudades_y_noches', `   ${p.nombre}: es el mismo aeropuerto del que sales; la salto.`);
      continue;
    }
    p.iataResuelto = iata;

    anotar(viajeId, 'ciudades_y_noches', `Buscando vuelos a ${p.nombre} (${iataCasa}→${iata})…`);
    const ida = await buscarAflojando({
      viajeId, origen: iataCasa, destino: iata, fecha: viaje.fecha_inicio,
      ocupacion, auto, comoSeLlama: `ida a ${p.nombre}`,
    });
    if (ida) idas.set(p.nombre, { ...ida, iata, ciudad: p.nombre });

    anotar(viajeId, 'ciudades_y_noches', `Buscando vuelos de vuelta desde ${p.nombre} (${iata}→${iataCasa})…`);
    const vuelta = await buscarAflojando({
      viajeId, origen: iata, destino: iataCasa, fecha: viaje.fecha_fin,
      ocupacion, auto, comoSeLlama: `vuelta desde ${p.nombre}`,
    });
    if (vuelta) vueltas.set(p.nombre, { ...vuelta, iata, ciudad: p.nombre });
  }

  if (!idas.size || !vueltas.size) {
    return { error: 'No encontré vuelos reales ni de ida ni de vuelta para ninguna puerta.' };
  }

  // --- La combinación ------------------------------------------------------
  const umbral = parametro('umbral_empate_traslado_min', 30);
  let mejorDistinta = null;
  let mejorIgual = null;

  for (const [ciudadIda, ida] of idas) {
    for (const [ciudadVuelta, vuelta] of vueltas) {
      const total = ida.minutos + vuelta.minutos;
      const donde = ciudadIda === ciudadVuelta ? 'igual' : 'distinta';
      const cand = { entrada: ida, salida: vuelta, total };
      if (donde === 'igual') {
        if (!mejorIgual || total < mejorIgual.total) mejorIgual = cand;
      } else if (!mejorDistinta || total < mejorDistinta.total) {
        mejorDistinta = cand;
      }
    }
  }

  let elegida;
  let porQue;
  if (mejorDistinta && mejorIgual) {
    const ahorro = mejorDistinta.total - mejorIgual.total;
    if (ahorro > umbral) {
      elegida = mejorIgual;
      porQue =
        `entro y salgo por ${mejorIgual.entrada.ciudad} porque hacerlo por sitios distintos ` +
        `costaba ${ahorro} min más de vuelo, por encima del umbral de ${umbral} min`;
    } else {
      elegida = mejorDistinta;
      porQue =
        `entro por ${mejorDistinta.entrada.ciudad} y salgo por ${mejorDistinta.salida.ciudad} ` +
        'para no desandar el camino ' +
        (ahorro <= 0
          ? '(no cuesta ni un minuto más de vuelo)'
          : `(solo ${ahorro} min más de vuelo, por debajo del umbral de ${umbral})`);
    }
  } else {
    elegida = mejorDistinta ?? mejorIgual;
    porQue = `es la única combinación con vuelos reales (${elegida.entrada.ciudad} → ${elegida.salida.ciudad})`;
  }

  anotar(viajeId, 'ciudades_y_noches', `Puerta elegida: ${porQue}.`);
  return { puertas: elegida, porQue };
}

// =============================================================================
// GUARDAR LOS VUELOS ELEGIDOS
// =============================================================================
/**
 * Deja el vuelo apuntado y marcado, igual que si lo hubiera elegido el usuario.
 *
 * Se guarda con `marcado = 1` y colgando del VIAJE (`transporte_id` a null), que
 * es donde el flujo manual guarda los del viaje entero. Así la pantalla de
 * vuelos lo enseña ya elegido y ninguna fase posterior vuelve a buscarlo.
 */
function guardarVueloElegido(viaje, lado, hallazgo) {
  const o = hallazgo.opcion;
  const huella = (o.tramos ?? []).map((t) => `${t.horaSalida}-${t.horaLlegada}`).join('/');

  const yaEsta = una(
    `SELECT id FROM candidatos
      WHERE viaje_id = ? AND tipo = 'vuelo' AND transporte_id IS NULL
        AND datos_extra LIKE ?`,
    viaje.id,
    `%"huella":"${huella}"%`
  );
  if (yaEsta) {
    ejecutar('UPDATE candidatos SET marcado = 1 WHERE id = ?', yaEsta.id);
    return yaEsta.id;
  }

  const aerolineas = String(o.aerolinea ?? '').trim() || 'Vuelo';
  const r = ejecutar(
    `INSERT INTO candidatos
       (viaje_id, transporte_id, tipo, titulo, precio, moneda, duracion,
        origen_datos, marcado, datos_extra)
     VALUES (?, NULL, 'vuelo', ?, ?, ?, ?, 'kayak', 1, ?)`,
    viaje.id,
    `${aerolineas} · ${lado === 'ida' ? 'ida' : 'vuelta'} (${hallazgo.iata})`,
    o.precio ?? null,
    o.moneda ?? null,
    null,
    JSON.stringify({
      huella,
      origen: lado === 'ida' ? null : hallazgo.iata,
      destino: lado === 'ida' ? hallazgo.iata : null,
      aerolineas: o.aerolinea ?? null,
      clase: o.clase ?? null,
      precioPorPersona: o.precioPorPersona ?? null,
      minutosTotales: hallazgo.minutos,
      // Lo puso el orquestador, no una persona. Sirve para poder distinguirlo
      // después y para que se sepa de dónde salió.
      elegidoPor: 'orquestador',
      tramos: (o.tramos ?? []).map((t) => ({
        tramo: lado,
        horaSalida: t.horaSalida ?? null,
        horaLlegada: t.horaLlegada ?? null,
        diasDespues: t.diasDespues ?? 0,
        duracion: t.duracion ?? null,
        escalas: t.escalas ?? null,
        escalaTexto: t.escalaTexto ?? null,
        aeropuertoOrigen: t.aeropuertoOrigen ?? null,
        aeropuertoDestino: t.aeropuertoDestino ?? null,
      })),
    })
  );
  return Number(r.lastInsertRowid);
}

// =============================================================================
// PASO 3: LA RUTA
// =============================================================================
/** Noches que caben entre dos fechas. Es lo que hay que repartir, ni una más. */
export function nochesEntre(desde, hasta) {
  if (!desde || !hasta) return 0;
  const a = new Date(`${desde}T12:00:00`);
  const b = new Date(`${hasta}T12:00:00`);
  return Math.max(0, Math.round((b - a) / 86_400_000));
}

/**
 * Comprueba que lo que ha devuelto la IA se puede convertir en un viaje.
 *
 * Devuelve el motivo del rechazo, o null si está bien. Se hace ANTES de escribir
 * nada: una ruta con una etapa de cero noches no es media ruta, es una ruta
 * rota, y arreglarla después es peor que pedirla otra vez.
 */
export function validarRuta(ruta, { nochesTotales, entrada, salida, minimoNoches }) {
  if (!Array.isArray(ruta) || !ruta.length) return 'no devolvió ninguna ciudad.';

  for (const p of ruta) {
    if (!p.ciudad) return 'hay una parada sin nombre de ciudad.';
    if (!Number.isInteger(p.noches) || p.noches < 1) {
      return `«${p.ciudad}» se queda con ${p.noches} noches, y una parada de cero noches no es una parada.`;
    }
    if (p.noches < minimoNoches && !p.motivo) {
      return (
        `«${p.ciudad}» tiene ${p.noches} noche(s), por debajo del mínimo de ${minimoNoches}, ` +
        'y no viene el campo "motivo" que lo justifique.'
      );
    }
  }

  const suma = ruta.reduce((s, p) => s + p.noches, 0);
  if (suma !== nochesTotales) {
    return `las noches suman ${suma} y el viaje tiene ${nochesTotales}.`;
  }

  const primera = normalizarNombre(ruta[0].ciudad);
  const ultima = normalizarNombre(ruta[ruta.length - 1].ciudad);
  if (primera !== normalizarNombre(entrada)) {
    return `la primera parada es «${ruta[0].ciudad}» y se entra por «${entrada}».`;
  }
  if (ultima !== normalizarNombre(salida)) {
    return `la última parada es «${ruta[ruta.length - 1].ciudad}» y se sale por «${salida}».`;
  }

  const vistas = new Set();
  for (const p of ruta) {
    const k = normalizarNombre(p.ciudad);
    // Repetir la ciudad de entrada al final es normal (ida y vuelta por el mismo
    // sitio); repetir cualquier otra en medio es un error de la IA.
    if (vistas.has(k) && k !== primera) return `«${p.ciudad}» aparece dos veces.`;
    vistas.add(k);
  }

  return null;
}

/**
 * Crea las etapas, igual que las crearía el usuario a mano.
 *
 * Cada ciudad se engancha al catálogo: su destino y su punto. No es un adorno —
 * es lo que hace que la fase de «qué ver» tenga dónde guardar los sitios. Una
 * etapa suelta, con solo un nombre escrito, deja esa fase sin sitio donde
 * escribir.
 */
function crearEtapas(viaje, ruta) {
  const destino = asegurarDestino(viaje.destino || ruta[0].ciudad);

  const meterPunto = db.prepare(
    `INSERT INTO puntos_interes (destino_id, nombre, nombre_norm, categoria, ciudad_base)
     VALUES (?, ?, ?, 'ciudad', ?)`
  );
  const meterEtapa = db.prepare(
    `INSERT INTO etapas (viaje_id, destino_id, punto_interes_id, nombre_ciudad, orden, noches, estado)
     VALUES (?, ?, ?, ?, ?, ?, 'confirmada')`
  );

  const creadas = [];
  db.exec('BEGIN');
  try {
    // Se limpia lo que hubiera: esta fase monta la ruta entera, y dejar restos
    // de un intento anterior mezclaría dos rutas distintas en la misma pantalla.
    ejecutar("DELETE FROM etapas WHERE viaje_id = ? AND tocado_a_mano = 0", viaje.id);

    ruta.forEach((p, i) => {
      let punto = una(
        'SELECT * FROM puntos_interes WHERE destino_id = ? AND nombre_norm = ?',
        destino.id,
        normalizarNombre(p.ciudad)
      );
      if (!punto) {
        const r = meterPunto.run(destino.id, p.ciudad, normalizarNombre(p.ciudad), p.ciudad);
        punto = una('SELECT * FROM puntos_interes WHERE id = ?', Number(r.lastInsertRowid));
      }
      const r = meterEtapa.run(viaje.id, destino.id, punto.id, p.ciudad, i + 1, p.noches);
      creadas.push({ id: Number(r.lastInsertRowid), ciudad: p.ciudad, noches: p.noches });
    });
    db.exec('COMMIT');
  } catch (err) {
    db.exec('ROLLBACK');
    throw err;
  }

  // Fechas en cascada y tramos entre paradas: lo mismo que pasa al confirmar
  // una etapa a mano.
  recalcularRuta(viaje.id);
  return creadas;
}

// =============================================================================
// LA FASE
// =============================================================================
/**
 * @param {object} viaje
 * @param {string} promptEntero El de la tabla, tal cual. Aquí se parte.
 */
export async function ejecutarFaseCiudades(viaje, promptEntero) {
  const viajeId = viaje.id;
  const FASE = 'ciudades_y_noches';
  const di = (t) => anotar(viajeId, FASE, t);

  if (!hayClaveIA()) throw new Error(SIN_CLAVE);
  if (!viaje.fecha_inicio || !viaje.fecha_fin) {
    throw new Error('El viaje no tiene fechas: sin ellas no hay noches que repartir.');
  }

  const partes = partirPrompt(promptEntero);
  const auto = configAuto(viaje);
  const nochesTotales = nochesEntre(viaje.fecha_inicio, viaje.fecha_fin);
  const dias = nochesTotales + 1;
  const { adultos, edadesNinos } = ocupacionDe(viaje);
  const maxCiudades = parametro('max_ciudades_candidatas', 8);
  const minimoNoches = parametro('minimo_noches_por_ciudad', 2);

  const viajeros =
    `${adultos} adulto(s)` +
    (edadesNinos.length ? ` y ${edadesNinos.length} niño(s) de ${edadesNinos.join(' y ')} años` : '');

  // QUÉ FORMA TIENE EL DESTINO, y esto cambia el viaje entero.
  //
  // «Japón» pide una ruta; «París» ES el viaje. Sin decírselo, la IA leía
  // «propón ciudades candidatas» y montaba una gira: para un viaje a París
  // llegó a proponer Amberes y Brujas, que están en Bélgica.
  //
  // El tipo sale del catálogo cuando el destino ya está en él. Cuando no está,
  // no se inventa: se le dice que lo deduzca, que para eso sabe geografía.
  const enCatalogo = viaje.destino ? destinoPorNombre(viaje.destino) : null;
  const formaDelDestino =
    enCatalogo?.tipo === 'ciudad'
      ? `«${viaje.destino}» es UNA CIUDAD: el viaje entero transcurre allí.`
      : enCatalogo?.tipo
        ? `«${viaje.destino}» es un país o una región: hay varias ciudades entre las que elegir.`
        : `Mira si «${viaje.destino}» es una ciudad o un país y actúa en consecuencia.`;

  const datos = {
    DESTINO: viaje.destino || '(sin destino)',
    FORMA_DEL_DESTINO: formaDelDestino,
    DIAS: dias,
    NOCHES: nochesTotales,
    FECHA_INICIO: viaje.fecha_inicio,
    FECHA_FIN: viaje.fecha_fin,
    ORIGEN: ciudadDeCasa(viaje),
    VIAJEROS: viajeros,
    RITMO: viaje.ritmo || 'normal',
    TIPO_VIAJE: viaje.tipo_viaje || '(sin especificar)',
    INTERESES:
      [auto.intereses, auto.categorias.join(', ')].filter(Boolean).join(' · ') || '(sin especificar)',
    MAX_CIUDADES: maxCiudades,
    MINIMO_NOCHES: minimoNoches,
  };

  // --- PASO 1 -------------------------------------------------------------
  di(`Eligiendo ciudades candidatas para ${datos.DESTINO} (${dias} días, ${viajeros})…`);

  const r1 = await consultarJSON(rellenar(partes.candidatas, datos), {
    maxTokens: 4000,
    paso: `candidatas de ${datos.DESTINO}`,
  });
  const { ciudades, tiempos } = saneaCandidatas(r1, maxCiudades);
  if (!ciudades.length) throw new Error('La IA no propuso ninguna ciudad.');

  di(
    `Candidatas (${ciudades.length}): ` +
      ciudades
        .map((c) => `${c.nombre} [peso ${c.peso}, ${c.nochesMin}-${c.nochesMax}n${c.puerta ? ', puerta' : ''}]`)
        .join(' · ')
  );
  for (const c of ciudades) if (c.porQue) di(`   ${c.nombre}: ${c.porQue}`);

  // LO QUE NO DA PARA DORMIR NO ES UNA PARADA.
  //
  // La IA cuela pueblos de excursión entre las candidatas: para un viaje a París
  // propuso Versalles, Giverny, Chartres y Fontainebleau, todos con una noche.
  // Luego, al cerrar la ruta, intentaba meterlos como parada y chocaba con el
  // mínimo de noches una y otra vez.
  //
  // Se quitan aquí, en código, y no pidiéndoselo otra vez al prompt: si una
  // ciudad no llega ni a su propio mínimo, no puede ser parada de ninguna ruta
  // válida, y dejarla en la lista es dejar la trampa puesta. Se guardan igual,
  // que son buenas excursiones y alguna fase futura las querrá.
  const deExcursion = ciudades.filter((c) => c.nochesMax < minimoNoches);
  const paraDormir = ciudades.filter((c) => c.nochesMax >= minimoNoches);

  if (deExcursion.length && paraDormir.length) {
    di(
      `Fuera de la ruta por no llegar a ${minimoNoches} noches (son excursiones de un día): ` +
        `${deExcursion.map((c) => c.nombre).join(', ')}.`
    );
  }
  // Si TODAS se caen, algo ha entendido mal y es mejor seguir con lo que hay
  // que quedarse sin ninguna candidata.
  const candidatasDeRuta = paraDormir.length ? paraDormir : ciudades;

  // --- PASO 2 -------------------------------------------------------------
  di('Buscando vuelos reales para decidir por dónde entrar y salir…');
  const conVuelos = await elegirPuertas({ viaje, candidatas: ciudades, auto, viajeId });

  let entrada;
  let salida;
  let horariosReales = 'No he podido consultar vuelos reales.';

  if (conVuelos.error) {
    // HUECO, NO ERROR. Sin vuelos se sigue montando la ruta con el criterio de
    // la IA: un viaje con las ciudades puestas y los vuelos por buscar sirve;
    // uno sin nada, no.
    apuntarHueco(viajeId, FASE, `Vuelos: ${conVuelos.error} La puerta la he elegido a ojo.`);
    di(`Sin vuelos reales: ${conVuelos.error}`);

    const puerta = [...ciudades].filter((c) => c.puerta).sort((a, b) => b.peso - a.peso)[0] ?? ciudades[0];
    entrada = puerta.nombre;
    salida = puerta.nombre;
    di(`Entro y salgo por ${entrada}, elegida solo por criterio de la IA.`);
  } else {
    entrada = conVuelos.puertas.entrada.ciudad;
    salida = conVuelos.puertas.salida.ciudad;

    const ida = guardarVueloElegido(viaje, 'ida', conVuelos.puertas.entrada);
    const vta = guardarVueloElegido(viaje, 'vuelta', conVuelos.puertas.salida);
    di(`Vuelos guardados y marcados (ida #${ida}, vuelta #${vta}). No se volverán a buscar.`);

    const t = (h) => (h?.opcion?.tramos ?? [])[0] ?? {};
    const tIda = t(conVuelos.puertas.entrada);
    const tVta = t(conVuelos.puertas.salida);
    horariosReales =
      `Llegada a ${entrada} el ${viaje.fecha_inicio} a las ${tIda.horaLlegada ?? '?'}. ` +
      `Salida desde ${salida} el ${viaje.fecha_fin} a las ${tVta.horaSalida ?? '?'}.`;
    di(horariosReales);
  }

  // --- PASO 3 -------------------------------------------------------------
  di('Montando la ruta y repartiendo las noches…');

  const datosCierre = {
    ...datos,
    ENTRADA: entrada,
    SALIDA: salida,
    HORARIOS_VUELOS: horariosReales,
    // Solo las que pueden ser parada. Las de excursión no se le enseñan
    // siquiera: si están en la lista, acaba metiéndolas.
    CANDIDATAS: candidatasDeRuta
      .map((c) => `- ${c.nombre} (peso ${c.peso}, ${c.nochesMin}-${c.nochesMax} noches)`)
      .join('\n'),
    TIEMPOS: tiempos.length
      ? tiempos.map((t) => `- ${t.desde} → ${t.hasta}: ${t.minutos} min en ${t.modo ?? 'transporte'}`).join('\n')
      : '(sin estimaciones)',
  };

  let ruta = null;
  let respuesta = null;
  let ultimoFallo = null;
  let arreglo = null;

  // DOS VUELTAS: la buena y la de «te lo explico y lo vuelves a hacer». La
  // segunda lleva el motivo exacto del rechazo, que es lo que hace que sirva de
  // algo: pedir lo mismo otra vez sin decir qué falló suele dar el mismo fallo.
  for (let intento = 1; intento <= 2 && !ruta; intento += 1) {
    // EL REINTENTO NO REPITE LA PETICIÓN: DA UNA INSTRUCCIÓN DE EDICIÓN.
    //
    // Decirle «suman 12 y tienen que sumar 11» no funciona; lo probé y volvió a
    // mandar 12. Contar es justo lo que se le da mal, así que repetírselo es
    // pedirle otra vez lo que ya ha fallado. Lo que sí funciona es convertirlo
    // en una edición concreta —quita una noche de tal ciudad—, porque eso ya no
    // hay que contarlo: se hace.
    const extra = ultimoFallo
      ? `\n\nTU RESPUESTA ANTERIOR NO VALÍA: ${ultimoFallo}` +
        (arreglo ? `\n\nHAZ EXACTAMENTE ESTO: ${arreglo}` : '') +
        '\n\nDevuelve el JSON corregido y nada más.'
      : '';

    respuesta = await consultarJSON(rellenar(partes.cierre, datosCierre) + extra, {
      maxTokens: 4000,
      paso: `ruta de ${datos.DESTINO}${intento > 1 ? ' (reintento)' : ''}`,
    });

    const propuesta = (Array.isArray(respuesta?.ruta) ? respuesta.ruta : []).map((p) => ({
      ciudad: typeof p?.ciudad === 'string' ? p.ciudad.trim() : null,
      noches: Math.round(Number(p?.noches)),
      motivo: texto(p?.motivo),
    }));

    // LO QUE MANDA ES LA RUTA, NO LA CONTABILIDAD.
    //
    // A la IA se le pide que escriba la suma que le sale, porque hacer la cuenta
    // en voz alta es lo que consigue que la haga bien. Pero ese número es un
    // apunte suyo, no el dato: si las paradas suman las noches correctas, la
    // ruta vale aunque se haya equivocado al copiar el total.
    //
    // Rechazarla por eso ya pasó una vez —una ruta buena tirada y una llamada
    // gastada—, así que el desajuste solo sirve para explicarle mejor el fallo
    // cuando además la ruta esté mal de verdad.
    const suyo = Math.round(Number(respuesta?.noches_totales));
    const real = propuesta.reduce((acc, p) => acc + (Number.isFinite(p.noches) ? p.noches : 0), 0);
    const seEquivocaAlSumar =
      Number.isFinite(suyo) && suyo !== real
        ? ` (además dices que suman ${suyo} y suman ${real}: haz la cuenta)`
        : '';

    const problema = validarRuta(propuesta, { nochesTotales, entrada, salida, minimoNoches });
    const fallo = problema ? problema + seEquivocaAlSumar : null;

    // Cuando lo que falla es la cuenta, se le dice qué quitar o qué poner y
    // dónde. Se recorta por la parada de menor peso y se añade a la de mayor,
    // que es lo que haría cualquiera con el mapa delante.
    if (fallo && real !== nochesTotales && propuesta.length) {
      const sobran = real - nochesTotales;
      const pesoDe = (nombre) =>
        candidatasDeRuta.find((c) => normalizarNombre(c.nombre) === normalizarNombre(nombre))?.peso ?? 3;
      const porPeso = [...propuesta].sort((a, b) => pesoDe(a.ciudad) - pesoDe(b.ciudad));
      const floja = porPeso[0];
      const fuerte = porPeso[porPeso.length - 1];

      arreglo =
        sobran > 0
          ? `sobran ${sobran} noche(s). Quítaselas a «${floja.ciudad}»` +
            (floja.noches - sobran < 1
              ? ', y como se quedaría sin noches, sácala de la ruta y reparte lo que sobre entre las demás.'
              : `, que se queda con ${floja.noches - sobran}. El resto no se toca.`)
          : `faltan ${-sobran} noche(s). Dáselas a «${fuerte.ciudad}», que pasa a ` +
            `${fuerte.noches - sobran}. El resto no se toca.`;
    } else {
      arreglo = null;
    }
    if (fallo) {
      ultimoFallo = fallo;
      di(`La ruta propuesta no valía: ${fallo}${intento === 1 ? ' Se lo explico y lo pido otra vez.' : ''}`);
      continue;
    }
    ruta = propuesta;
  }

  if (!ruta) {
    throw new Error(`La IA no consiguió una ruta válida en dos intentos. Último motivo: ${ultimoFallo}`);
  }

  // --- Guardar -------------------------------------------------------------
  const creadas = crearEtapas(viaje, ruta);

  // Las descartadas se guardan por si alguien las quiere recuperar: la IA las
  // pensó y descartarlas en silencio pierde trabajo ya hecho.
  const enRuta = new Set(ruta.map((p) => normalizarNombre(p.ciudad)));
  const descartadas = ciudades
    .filter((c) => !enRuta.has(normalizarNombre(c.nombre)))
    .map((c) => ({
      nombre: c.nombre,
      peso: c.peso,
      nochesMin: c.nochesMin,
      nochesMax: c.nochesMax,
      porQue: c.porQue,
      motivoDescarte:
        (Array.isArray(respuesta?.descartadas) ? respuesta.descartadas : []).find(
          (d) => normalizarNombre(d?.ciudad ?? '') === normalizarNombre(c.nombre)
        )?.por_que ?? null,
    }));

  ejecutar(
    'UPDATE viajes SET ciudades_candidatas = ? WHERE id = ?',
    JSON.stringify({ candidatas: ciudades, tiempos, descartadas, decididoEn: new Date().toISOString() }),
    viajeId
  );

  // --- El resumen, que es lo que se lee ------------------------------------
  const casa = ciudadDeCasa(viaje);
  di(
    `RUTA: ${casa} → ` +
      ruta.map((p) => `${p.ciudad} ${p.noches}n`).join(' → ') +
      ` → ${casa}`
  );
  for (const p of ruta) if (p.motivo) di(`   ${p.ciudad}: ${p.motivo}`);
  if (respuesta?.resumen) di(`Por qué esta ruta: ${respuesta.resumen}`);
  if (descartadas.length) {
    di(`Descartadas y guardadas: ${descartadas.map((d) => d.nombre).join(', ')}.`);
  }
  di(`${creadas.length} etapas creadas, ${nochesTotales} noches repartidas.`);

  return { etapas: creadas.length, noches: nochesTotales, entrada, salida };
}

export default { ejecutarFaseCiudades, partirPrompt, rellenar, validarRuta, nochesEntre };
