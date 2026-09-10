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
import { anotar, apuntarHueco, parametro, configAuto, ORIGENES } from '../services/orquestador.js';
import { fichasDeTramo } from '../services/movilidad.js';
import { distanciaEntre, distanciaGuardada } from '../services/distancias-ciudades.js';

/** Cuántas puertas se prueban con vuelos de verdad. Cada una son dos búsquedas. */
const MAX_PUERTAS = 3;

/** Cuántas opciones se piden a Kayak por búsqueda. No hacen falta más. */
const VUELOS_POR_BUSQUEDA = 8;

/** Las dos mitades del prompt editable, tal y como se separan en la tabla. */
const MARCA_CANDIDATAS = '=== PASO 1: CANDIDATAS ===';
const MARCA_PUERTA = '=== PASO 2: PUERTA DE ENTRADA Y SALIDA ===';
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
      `El prompt de esta fase tiene que llevar las marcas «${MARCA_CANDIDATAS}» y ` +
        `«${MARCA_CIERRE}», en ese orden. Revísalo en el cerebro del orquestador.`
    );
  }

  // LA SECCIÓN DE LA PUERTA PUEDE NO ESTAR, y eso no es un error.
  //
  // Se añadió después: un prompt que el usuario editara antes de ese cambio no
  // la tiene, y su versión manda sobre la de fábrica. Cuando falta, la puerta se
  // decide con la regla local de siempre —la de menos minutos de vuelo— y se
  // dice en el log, para que se sepa por qué no está razonando la ruta interna.
  const k = texto.indexOf(MARCA_PUERTA);
  const hayPuerta = k > i && k < j;

  return {
    candidatas: texto.slice(i + MARCA_CANDIDATAS.length, hayPuerta ? k : j).trim(),
    puerta: hayPuerta ? texto.slice(k + MARCA_PUERTA.length, j).trim() : null,
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

/** 175 -> "2h 55min". Para que el log se lea como habla la gente. */
function comoTexto(min) {
  if (min == null) return '—';
  const h = Math.floor(min / 60);
  const m = Math.round(min % 60);
  return h ? `${h}h ${m ? `${m}min` : ''}`.trim() : `${m}min`;
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

      // CERO CON ESTOS FILTROS TIENE ARREGLO; CERO A SECAS, NO.
      //
      // Si la web dice que hay vuelos pero ninguno pasa el filtro, aflojar es
      // exactamente lo que hay que hacer y se dice en el log. Si simplemente no
      // vino nada, aflojar tampoco va a traer nada, pero se intenta igual: sale
      // barato y a veces la diferencia está en la franja horaria.
      if (opciones.sinResultadosPorFiltros) {
        anotar(
          viajeId,
          'ciudades_y_noches',
          `   ${comoSeLlama}: hay vuelos ese día pero ninguno cumple ` +
            `${i === 0 ? 'tus filtros' : `lo pedido ${intentos[i].nota}`}. Aflojo y repito.`
        );
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
async function elegirPuertas({ viaje, candidatas, tiempos, auto, viajeId, promptPuerta }) {
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
    else anotar(viajeId, 'ciudades_y_noches', `   ${p.nombre}: sin ninguna ida utilizable.`);

    anotar(viajeId, 'ciudades_y_noches', `Buscando vuelos de vuelta desde ${p.nombre} (${iata}→${iataCasa})…`);
    const vuelta = await buscarAflojando({
      viajeId, origen: iata, destino: iataCasa, fecha: viaje.fecha_fin,
      ocupacion, auto, comoSeLlama: `vuelta desde ${p.nombre}`,
    });
    if (vuelta) vueltas.set(p.nombre, { ...vuelta, iata, ciudad: p.nombre });
    else anotar(viajeId, 'ciudades_y_noches', `   ${p.nombre}: sin ninguna vuelta utilizable.`);
  }

  if (!idas.size || !vueltas.size) {
    return { error: 'No encontré vuelos reales ni de ida ni de vuelta para ninguna puerta.' };
  }

  // --- La combinación ------------------------------------------------------
  //
  // AQUÍ NO GANA EL VUELO MÁS CORTO, Y ESE ERA EL FALLO.
  //
  // Antes se elegía la pareja entrada/salida sumando solo minutos de vuelo, y se
  // elegía ANTES de pensar la ruta interna. En Polonia salió entrar por Varsovia
  // y salir por Cracovia con Gdansk en medio: dos horas de vuelo bien elegidas y
  // una ruta que sube al norte y vuelve a bajar. Lo barato en el aire se pagaba
  // por tierra, y multiplicado.
  //
  // La puerta y la forma de la ruta son la misma decisión, así que se decide
  // junta: se le dan a la IA las combinaciones con vuelos reales, los pesos de
  // las candidatas y la matriz de tiempos que ella misma estimó, y elige la que
  // dé menos tiempo TOTAL —aire más carretera—.
  const combinaciones = [];
  for (const [, ida] of idas) {
    for (const [, vuelta] of vueltas) {
      combinaciones.push({
        id: `c${combinaciones.length + 1}`,
        entrada: ida,
        salida: vuelta,
        total: ida.minutos + vuelta.minutos,
        misma: ida.ciudad === vuelta.ciudad,
      });
    }
  }
  combinaciones.sort((a, b) => a.total - b.total);

  // QUÉ CONSIGUIÓ CADA PUERTA, dicho antes de elegir.
  //
  // Sin esto, el log saltaba de «busco vuelos a Gdansk» a «entro por Varsovia» y
  // no había forma de saber si Gdansk se cayó porque no había vuelo o porque
  // salía peor. Son dos cosas muy distintas y la segunda es una decisión que hay
  // que poder discutir.
  const loQueLogro = (m, lado) => {
    const h = m.get(lado);
    if (!h) return 'nada';
    return `${comoTexto(h.minutos)}${h.aflojado ? ` (${h.aflojado})` : ' con tus filtros'}`;
  };
  // Estos minutos salen de Kayak, tal cual: por eso van marcados como scraping.
  for (const p of puertas) {
    anotar(
      viajeId,
      'ciudades_y_noches',
      `   ${p.nombre}: mejor ida ${loQueLogro(idas, p.nombre)} · mejor vuelta ${loQueLogro(vueltas, p.nombre)}.`,
      ORIGENES.scraping
    );
  }
  anotar(
    viajeId,
    'ciudades_y_noches',
    `Combinaciones posibles, de menos a más tiempo de vuelo: ` +
      combinaciones
        .map((c) => `${c.entrada.ciudad}→${c.salida.ciudad} ${comoTexto(c.total)}`)
        .join(' · '),
    ORIGENES.scraping
  );

  /**
   * La regla de siempre, que ahora es el respaldo.
   *
   * Sigue valiendo cuando la IA no contesta o cuando el prompt editado no trae
   * la sección de la puerta: mira solo el aire, prefiere no repetir ciudad y usa
   * el umbral de empate. Es peor que razonar la ruta, pero deja el viaje montado.
   */
  const porMinutosDeVuelo = () => {
    const distinta = combinaciones.find((c) => !c.misma) ?? null;
    const igual = combinaciones.find((c) => c.misma) ?? null;

    if (distinta && igual) {
      const ahorro = distinta.total - igual.total;
      if (ahorro > umbral) {
        return {
          elegida: igual,
          porQue:
            `entro y salgo por ${igual.entrada.ciudad} porque hacerlo por sitios distintos ` +
            `costaba ${ahorro} min más de vuelo, por encima del umbral de ${umbral} min`,
        };
      }
      return {
        elegida: distinta,
        porQue:
          `entro por ${distinta.entrada.ciudad} y salgo por ${distinta.salida.ciudad} ` +
          'para no desandar el camino ' +
          (ahorro <= 0
            ? '(no cuesta ni un minuto más de vuelo)'
            : `(solo ${ahorro} min más de vuelo, por debajo del umbral de ${umbral})`),
      };
    }
    const unica = distinta ?? igual;
    return {
      elegida: unica,
      porQue: `es la única combinación con vuelos reales (${unica.entrada.ciudad} → ${unica.salida.ciudad})`,
    };
  };

  let elegida = null;
  let porQue = null;

  if (promptPuerta) {
    try {
      const r = await consultarJSON(
        rellenar(promptPuerta, {
          DESTINO: viaje.destino ?? '',
          DIAS: nochesEntre(viaje.fecha_inicio, viaje.fecha_fin) + 1,
          NOCHES: nochesEntre(viaje.fecha_inicio, viaje.fecha_fin),
          ORIGEN: casa,
          CANDIDATAS: candidatas
            .map((c) => `- ${c.nombre} (peso ${c.peso}, ${c.nochesMin}-${c.nochesMax} noches)`)
            .join('\n'),
          TIEMPOS: tiempos.length
            ? tiempos
                .map((t) => `- ${t.desde} → ${t.hasta}: ${t.minutos} min en ${t.modo ?? 'transporte'}`)
                .join('\n')
            : '(no estimaste tiempos entre ciudades)',
          COMBINACIONES: combinaciones
            .map(
              (c) =>
                `- ${c.id} · entrar por ${c.entrada.ciudad}, salir por ${c.salida.ciudad}` +
                `${c.misma ? ' (la misma ciudad)' : ''}
` +
                `  vuelos: ${c.entrada.minutos} min de ida + ${c.salida.minutos} min de vuelta = ${c.total} min en el aire`
            )
            .join('\n'),
        }),
        { maxTokens: 1200, paso: `puerta de entrada a ${viaje.destino}` }
      );
      const cual = combinaciones.find((c) => c.id === String(r?.elegida ?? '').trim());
      if (cual) {
        elegida = cual;
        porQue =
          typeof r?.por_que === 'string' && r.por_que.trim()
            ? r.por_que.trim()
            : `entro por ${cual.entrada.ciudad} y salgo por ${cual.salida.ciudad}`;
      }
    } catch (err) {
      anotar(viajeId, 'ciudades_y_noches', `   La IA no pudo elegir la puerta (${err.message}).`);
    }
  } else {
    anotar(
      viajeId,
      'ciudades_y_noches',
      '   Tu prompt no tiene la sección de la puerta: la elijo solo por minutos de vuelo.'
    );
  }

  if (!elegida) {
    const respaldo = porMinutosDeVuelo();
    elegida = respaldo.elegida;
    porQue = `${respaldo.porQue} (elegido solo por tiempo de vuelo, sin valorar la ruta interna)`;
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

  // EL TRAMO AL QUE PERTENECE ESTE VUELO.
  //
  // La ida es el tramo que no tiene etapa de origen —se sale de casa— y la
  // vuelta el que no tiene etapa de destino. Los crea `recalcularRuta` al montar
  // las paradas, así que a estas alturas ya existen.
  const yaEsta = una(
    `SELECT id FROM candidatos
      WHERE viaje_id = ? AND tipo = 'vuelo' AND datos_extra LIKE ?`,
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

/**
 * ENLAZA LOS VUELOS YA GUARDADOS CON SUS TRAMOS.
 *
 * VA DESPUÉS DE CREAR LAS ETAPAS, Y NO PUEDE IR ANTES. Los tramos —el de casa a
 * la primera parada y el de la última a casa— los crea `recalcularRuta` al
 * montar la ruta, o sea DESPUÉS de que se hayan elegido y guardado los vuelos.
 * Intentar enlazarlos al guardarlos no encontraba ningún tramo y el enlace se
 * perdía en silencio: el vuelo quedaba marcado pero «Mi ruta» lo daba por
 * pendiente, porque ella mira `transportes.candidato_id`.
 *
 * Es lo mismo que hace el círculo de «Cómo llegar»: el candidato cuelga del
 * tramo, se queda marcado, y el tramo apunta al candidato.
 */
export function enlazarVuelosConTramos(viajeId) {
  const enlazados = [];

  for (const lado of ['ida', 'vuelta']) {
    const tramo = una(
      lado === 'ida'
        ? 'SELECT * FROM transportes WHERE viaje_id = ? AND etapa_origen_id IS NULL LIMIT 1'
        : 'SELECT * FROM transportes WHERE viaje_id = ? AND etapa_destino_id IS NULL LIMIT 1',
      viajeId
    );
    if (!tramo) continue;

    const vuelo = una(
      `SELECT id FROM candidatos
        WHERE viaje_id = ? AND tipo = 'vuelo' AND marcado = 1
          AND transporte_id IS NULL AND titulo LIKE ?
        ORDER BY id DESC LIMIT 1`,
      viajeId,
      `%· ${lado} (%`
    );
    if (!vuelo) continue;

    ejecutar("UPDATE candidatos SET marcado = 0 WHERE transporte_id = ?", tramo.id);
    ejecutar('UPDATE candidatos SET transporte_id = ?, marcado = 1 WHERE id = ?', tramo.id, vuelo.id);
    ejecutar("UPDATE transportes SET candidato_id = ?, tipo = 'vuelo' WHERE id = ?", vuelo.id, tramo.id);
    enlazados.push({ lado, tramoId: tramo.id, candidatoId: vuelo.id });
  }

  return enlazados;
}

/**
 * ¿SE HA QUEDADO CORTA UNA CIUDAD DE PESO MÁXIMO, Y SIN EXPLICARLO?
 *
 * La regla está escrita en el prompt, pero pedirla no basta: en Polonia, con 6
 * noches y pesos 5-4-5, salió 4-1-1 y la justificación era un horario inventado.
 * Así que se comprueba aquí, con la aritmética, que es lo que la máquina sí sabe
 * hacer.
 *
 * Devuelve el arreglo a aplicar —de qué ciudad quitar una noche y a cuál dársela—
 * o null si el reparto está bien. Si la IA escribió un "motivo" para la parada
 * corta, se respeta: ahí está diciendo por qué, y esa era la puerta que la regla
 * dejaba abierta.
 */
export function nochePorPeso(ruta, candidatas, minimoNoches) {
  const pesoDe = (nombre) =>
    candidatas.find((c) => normalizarNombre(c.nombre) === normalizarNombre(nombre))?.peso ?? 3;

  // Las paradas de paso (0 noches en un extremo) no entran en el reparto.
  const paradas = ruta.filter((p) => p.noches > 0);
  if (paradas.length < 2) return null;

  const pesoMaximo = Math.max(...paradas.map((p) => pesoDe(p.ciudad)));

  for (const corta of paradas) {
    if (pesoDe(corta.ciudad) !== pesoMaximo) continue;
    if (corta.noches > minimoNoches) continue;
    if (corta.motivo) continue; // lo explica: es la excepción que la regla permite

    // DOS CLASES DE DONANTE, y las dos hacen falta.
    //
    // La de menor peso que tenga más noches, que es lo evidente. Y una del mismo
    // peso máximo que se haya llevado DOS noches más: el caso real de Polonia
    // fue 4-1-1 con pesos 5-4-5, o sea que las dos ciudades cortas de peso
    // máximo tenían al lado otra igual de importante con cuatro noches. Sin esta
    // segunda vía no había de dónde sacarlas y el desajuste se quedaba.
    const donantes = paradas
      .filter((p) => {
        if (p === corta) return false;
        const peso = pesoDe(p.ciudad);
        if (peso < pesoMaximo) return p.noches > corta.noches;
        return peso === pesoMaximo && p.noches >= corta.noches + 2;
      })
      .sort((a, b) => pesoDe(a.ciudad) - pesoDe(b.ciudad) || b.noches - a.noches);

    // El donante tiene que poder permitírselo: si al soltar la noche se queda
    // por debajo del mínimo, el arreglo crea el problema que quería quitar.
    const donante = donantes.find((d) => d.noches - 1 >= minimoNoches);
    if (!donante) continue;

    return { de: donante, a: corta, pesoMaximo };
  }

  return null;
}

// =============================================================================
// LOS TIEMPOS ENTRE CANDIDATAS, CON SU PROCEDENCIA
// -----------------------------------------------------------------------------
// Antes aquí solo iba la matriz que la propia IA estimaba «a ojo» en el paso 1,
// y con eso escribió esto en una ruta de Polonia:
//
//   «Cracovia absorbe solo la noche de salida porque llega de madrugada tras
//    360 min de tren»
//
// El tren de Gdansk a Cracovia sale a las 9:15 y llega sobre las 15:30. Ni 360
// minutos ni madrugada: se lo inventó, y con ese invento le quitó dos noches a
// una ciudad de peso máximo.
//
// La cura no es pedirle que no invente —eso ya se le pide—, sino DARLE EL DATO y
// decirle de dónde sale cada línea. Tres fuentes, en este orden:
//
//   1. EL CATÁLOGO de tramos: trenes y buses reales, con su duración y su
//      frecuencia, tal y como se guardaron al investigarlos.
//   2. LA CARRETERA: los kilómetros y el tiempo en coche del par de ciudades,
//      que son un suelo fiable aunque se vaya en tren.
//   3. SU PROPIA ESTIMACIÓN del paso 1, marcada como lo que es.
//
// Y si no hay nada de eso, se dice «sin dato». Un hueco declarado es lo único
// que impide que lo rellene con una hora inventada.
// =============================================================================

/** El punto del catálogo de una ciudad candidata, si está. */
function puntoDeCiudad(destinoId, nombre) {
  if (!destinoId || !nombre) return null;
  return una(
    'SELECT id, nombre, lat, lon FROM puntos_interes WHERE destino_id = ? AND nombre_norm = ?',
    destinoId,
    normalizarNombre(nombre)
  );
}

/** "2 h 20 min a 3 h · cada 30 o 60 minutos" a partir de una ficha del catálogo. */
function comoSeLeeLaFicha(f) {
  return [f.medio, f.nombre, f.duracion, f.frecuencia]
    .map((t) => (t ? String(t).trim() : ''))
    .filter(Boolean)
    .join(' · ');
}

/**
 * La tabla de tiempos que se le enseña a la IA para repartir noches.
 *
 * Se calculan también las distancias por carretera que falten: son de una en
 * una y quedan en el catálogo para siempre, así que el rato que cuestan aquí lo
 * ahorra después "Mi ruta", que las necesita para sus kilómetros.
 */
export async function tablaDeTiempos(candidatas, tiemposIA, destinoId) {
  const estimado = new Map();
  for (const t of tiemposIA) {
    const clave = [normalizarNombre(t.desde), normalizarNombre(t.hasta)].sort().join('|');
    if (!estimado.has(clave)) estimado.set(clave, t);
  }

  const lineas = [];
  for (let i = 0; i < candidatas.length; i += 1) {
    for (let j = i + 1; j < candidatas.length; j += 1) {
      const a = candidatas[i].nombre;
      const b = candidatas[j].nombre;

      // 1) El catálogo de tramos: lo mejor que hay, porque son datos que ya se
      //    investigaron para este par de ciudades.
      const fichas = fichasDeTramo(a, b).filter((f) => f.duracion);
      if (fichas.length) {
        // Tren y bus primero, que es como se va de ciudad a ciudad. Lo que no
        // esté en la lista va al final: `indexOf` devuelve -1 y sin esto un
        // medio «otro» se colaba en cabeza.
        const preferido = ['tren', 'bus', 'barco', 'coche', 'traslado', 'avion'];
        const orden = (m) => (preferido.indexOf(m) === -1 ? preferido.length : preferido.indexOf(m));
        fichas.sort((x, y) => orden(x.medio) - orden(y.medio));
        for (const f of fichas.slice(0, 2)) {
          lineas.push(`- ${a} ↔ ${b}: ${comoSeLeeLaFicha(f)} [dato real del catálogo]`);
        }
        continue;
      }

      // 2) La carretera. Si no está calculada, se calcula: queda guardada.
      const pa = puntoDeCiudad(destinoId, a);
      const pb = puntoDeCiudad(destinoId, b);
      let carretera = pa && pb ? distanciaGuardada(pa.id, pb.id) : null;
      if (!carretera && pa && pb) {
        try {
          await distanciaEntre(pa.id, pb.id);
          carretera = distanciaGuardada(pa.id, pb.id);
        } catch {
          carretera = null;
        }
      }
      if (carretera?.km) {
        const horas = carretera.minutos_coche
          ? ` (${Math.floor(carretera.minutos_coche / 60)} h ${String(carretera.minutos_coche % 60).padStart(2, '0')} en coche)`
          : '';
        lineas.push(`- ${a} ↔ ${b}: ${Math.round(carretera.km)} km${horas} [medido por carretera]`);
        continue;
      }

      // 3) Lo que estimó ella misma, dicho como lo que es.
      const suyo = estimado.get([normalizarNombre(a), normalizarNombre(b)].sort().join('|'));
      if (suyo?.minutos) {
        lineas.push(
          `- ${a} ↔ ${b}: ~${suyo.minutos} min en ${suyo.modo ?? 'transporte'} [estimación tuya, sin comprobar]`
        );
        continue;
      }

      lineas.push(`- ${a} ↔ ${b}: sin dato. No sabes cuánto se tarda ni a qué hora sale nada.`);
    }
  }

  return lineas.length ? lineas.join('\n') : '(sin datos de tiempos entre ciudades)';
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

  // ENTRAR Y SALIR POR LA MISMA CIUDAD PERMITE UNA PARADA SIN NOCHES, y solo
  // una: la del extremo que es un paso, no una estancia.
  //
  // Con vuelo de vuelta desde Cracovia a las 22:30, el último día se vuelve a
  // Cracovia desde la ciudad anterior, se pasa la tarde y se vuela. Eso es una
  // parada de cero noches perfectamente real, y prohibirla dejaba a la IA sin
  // ninguna ruta válida: lo intentó dos veces y la fase acabó en error.
  const irYVolver = normalizarNombre(entrada) === normalizarNombre(salida);
  const extremos = irYVolver ? [0, ruta.length - 1] : [];

  for (const [i, p] of ruta.entries()) {
    if (!p.ciudad) return 'hay una parada sin nombre de ciudad.';
    const puedeSerDePaso = extremos.includes(i);
    const minimoAqui = puedeSerDePaso ? 0 : 1;
    if (!Number.isInteger(p.noches) || p.noches < minimoAqui) {
      return `«${p.ciudad}» se queda con ${p.noches} noches, y una parada de cero noches no es una parada.`;
    }
    if (p.noches === 0 && !p.motivo) {
      return `«${p.ciudad}» se queda sin noches y no explica por qué en "motivo".`;
    }
    if (p.noches > 0 && p.noches < minimoNoches && !p.motivo) {
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
    // (la de entrada puede repetirse al final: es volver al aeropuerto)
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
  const di = (t, origen = null) => anotar(viajeId, FASE, t, origen);

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
  const conVuelos = await elegirPuertas({
    viaje,
    candidatas: candidatasDeRuta,
    // La matriz que ella misma estimó en el paso 1. Es lo que le permite ver
    // que entrar por Varsovia obliga a subir a Gdansk y volver a bajar.
    tiempos,
    auto,
    viajeId,
    promptPuerta: partes.puerta,
  });

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
    // Las horas son las del billete que devolvió Kayak, no una estimación.
    di(horariosReales, ORIGENES.scraping);
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
    TIEMPOS: await tablaDeTiempos(
      candidatasDeRuta,
      tiempos,
      (viaje.destino ? destinoPorNombre(viaje.destino) : null)?.id ?? null
    ),
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
    // LOS EXTREMOS, dichos como una edición y no como una regla.
    //
    // «La última parada es Gdańsk y se sale por Varsovia» es exacto y no le
    // sirve: lo intentó dos veces y la segunda movió otra ciudad. Decirle qué
    // mover y adónde sí funciona, que es lo mismo que se hizo con las noches.
    if (fallo && propuesta.length) {
      const primera = normalizarNombre(propuesta[0].ciudad ?? '');
      const ultima = normalizarNombre(propuesta[propuesta.length - 1].ciudad ?? '');
      if (primera !== normalizarNombre(entrada)) {
        arreglo = `pon «${entrada}» la PRIMERA de la lista, que es por donde se entra, y deja el resto en el mismo orden.`;
      } else if (ultima !== normalizarNombre(salida)) {
        arreglo = `pon «${salida}» la ÚLTIMA de la lista, que es por donde se sale, y deja el resto en el mismo orden.`;
      }
    }

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
    } else if (!fallo) {
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

  // EL REPARTO POR PESO SE COMPRUEBA, NO SE PIDE Y YA.
  //
  // Con 6 noches y pesos 5-4-5 lo que sale es 2-2-2. Si una ciudad de peso
  // máximo se queda en el mínimo y no dice por qué, se le pasa una noche de la
  // parada de menor peso. Se corrige aquí en vez de volver a preguntar: mover
  // una noche de una lista es aritmética, y la aritmética la hace mejor el
  // código que el modelo.
  // Hasta tres pases: cada uno mueve UNA noche y se vuelve a mirar. Más de tres
  // correcciones ya no es afinar un reparto, es rehacerlo, y eso no toca aquí.
  for (let pase = 0; pase < 3; pase += 1) {
    const desajuste = nochePorPeso(ruta, candidatasDeRuta, minimoNoches);
    if (!desajuste) break;
    desajuste.de.noches -= 1;
    desajuste.a.noches += 1;
    di(
      `Reparto corregido: «${desajuste.a.ciudad}» es de peso máximo y se quedaba con ` +
        `${desajuste.a.noches - 1} noche(s) sin explicar por qué. Le paso una noche de ` +
        `«${desajuste.de.ciudad}» (${desajuste.de.noches + 1} → ${desajuste.de.noches}).`
    );
  }

  // --- Guardar -------------------------------------------------------------
  const creadas = crearEtapas(viaje, ruta);

  // Los tramos acaban de nacer con la ruta: ahora sí se les puede colgar el
  // vuelo, que es lo que deja la ida y la vuelta en verde y le da al lienzo la
  // hora de llegada.
  const enlazados = enlazarVuelosConTramos(viajeId);
  if (enlazados.length) {
    di(`Vuelos enlazados con sus tramos (${enlazados.map((e) => e.lado).join(' y ')}): quedan elegidos.`);
  } else if (!conVuelos.error) {
    apuntarHueco(viajeId, FASE, 'Los vuelos se guardaron pero no pude engancharlos a sus tramos.');
  }

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
