/**
 * services/orquestador-traslados.js
 * -----------------------------------------------------------------------------
 * FASE 2 DEL ORQUESTADOR: cómo se va de cada ciudad a la siguiente.
 *
 * La fase 1 dejó las paradas en orden y con fechas. Con N paradas hay N-1 saltos
 * que resolver, y cada uno se resuelve solo: si el de Cracovia a Varsovia falla,
 * el de Varsovia a Gdansk se sigue buscando igual.
 *
 * SE COMPARA PUERTA A PUERTA, Y ESTO ES TODA LA FASE.
 *
 * Un vuelo de 55 minutos entre dos ciudades de un mismo país no gana a un tren
 * de 2h30 casi nunca, y el motivo no está en el aire: está en el trayecto hasta
 * el aeropuerto, en la hora larga de antelación y en el otro trayecto al llegar.
 * Comparar duraciones de trayecto —que es lo que enseñan los buscadores— manda a
 * la gente al aeropuerto a perder la mañana. Aquí se suma todo el bloque:
 *
 *     ir a la estación/aeropuerto + antelación + trayecto + salir en destino
 *
 * y ese total es el que compite. Los números salen de `parametros_orquestador`,
 * no de aquí: es lo que hace que se puedan afinar sin tocar código.
 *
 * Y HAY UN EMPATE QUE NO ES EMPATE. Cuando dos opciones se llevan pocos minutos
 * pero una cuesta el triple, la rápida deja de ser la buena: el umbral y el
 * factor de precio están en los parámetros y deciden ese caso.
 *
 * LA ÚLTIMA PALABRA LA TIENE LA IA, con las opciones ya medidas delante. No se
 * le pide que calcule —los números ya están hechos y bien hechos— sino que elija
 * con criterio de viajero: qué hora de salida no destroza la mañana, si un
 * transbordo con niños compensa, cuándo vale la pena pagar por dormir una hora
 * más. Y que lo justifique en una línea, que es lo que se lee en el log.
 */
import { db, todas, una, ejecutar } from '../db/index.js';
import { consultarJSON, hayClaveIA, SIN_CLAVE } from '../lib/ia.js';
import { resolverIata } from '../lib/iata.js';
import { buscarVuelosKayak } from '../providers/kayak.js';
import { ocupacionDe } from '../services/proveedores.js';
import {
  fichasDeTramo,
  guardarFichaTramo,
  investigarTramo,
  elegirMedio,
  guardarDatosDelTramo,
} from '../services/movilidad.js';
import {
  anotar,
  apuntarHueco,
  parametro,
  parametroTexto,
  configAuto,
  ORIGENES,
} from '../services/orquestador.js';
import { calcularDistanciasDeLaRuta, distanciaGuardada } from '../services/distancias-ciudades.js';
import { ambitoDeTramo, POR_GRUPO } from '../services/presupuesto.js';
import { hayQueParar } from '../services/orquestador-parada.js';

const FASE = 'traslados';

/** Cuántas opciones de vuelo se piden. Para elegir no hacen falta más. */
const VUELOS_POR_SALTO = 6;

/**
 * A partir de cuánto tiempo por tierra tiene sentido mirar si hay avión.
 *
 * Por debajo de esto el avión no gana nunca puerta a puerta —se lo comen los dos
 * trayectos y la antelación—, así que buscarlo es abrir un navegador para nada.
 * No es un parámetro afinable porque no es una preferencia: es aritmética de la
 * suma de arriba.
 */
const TIERRA_LARGA_MIN = 5 * 60;

// =============================================================================
// EL PROMPT
// =============================================================================
export function rellenar(plantilla, datos) {
  return plantilla.replace(/\{\{([A-Z_]+)\}\}/g, (_, clave) => {
    const v = datos[clave];
    return v === undefined || v === null ? '' : String(v);
  });
}

// =============================================================================
// PUERTA A PUERTA
// =============================================================================
/** "2h 30m", "2 h 30", "150 min" -> 150. Null si no se entiende. */
export function aMinutos(texto) {
  const t = String(texto ?? '').toLowerCase();
  if (!t.trim()) return null;

  const horasYmin = t.match(/(\d+)\s*h(?:oras?)?\s*(\d+)?/);
  if (horasYmin) return Number(horasYmin[1]) * 60 + (Number(horasYmin[2]) || 0);

  const soloMin = t.match(/(\d+)\s*m(?:in)?/);
  if (soloMin) return Number(soloMin[1]);

  const suelto = t.match(/^\s*(\d+([.,]\d+)?)\s*$/);
  if (suelto) return Math.round(Number(suelto[1].replace(',', '.')) * 60);

  return null;
}

/** "89 €", "unos 30-40 EUR" -> 89 / 30. El suelo, que es lo que se compara. */
export function aPrecio(texto) {
  const t = String(texto ?? '');

  // SOLO EUROS, Y SI NO SE SABE LA MONEDA NO HAY NUMERO.
  //
  // Desde que los precios los trae la busqueda, vienen como los escribe la
  // fuente: "Entre 40 PLN y 94 PLN (~9 EUR a 22 EUR)". Leer el primer numero
  // daba 40 y lo comparaba con euros, o sea que un tren de 9 EUR entraba en la
  // regla del empate como si costara 40. Se busca el primer numero que este
  // en euros y se ignoran los que llevan otra moneda pegada.
  if (!/€|\beur/i.test(t)) return null;

  // El numero entero, no un trozo suyo: sin los bordes, al descartar "40 PLN"
  // el buscador se quedaba con el "0" de al lado y devolvia 4.
  const m = t.match(
    /(?<![\d.,])(\d+(?:[.,]\d+)?)(?![\d.,])(?!\s*(?:PLN|z\u0142|CZK|HUF|RON|GBP|USD|CHF|SEK|NOK|DKK|K\u010d))/i
  );
  return m ? Number(m[1].replace(',', '.')) : null;
}

/**
 * EL BLOQUE COMPLETO DE UN TRASLADO.
 *
 * Devuelve los cuatro tramos por separado y su suma. Se guardan separados y no
 * solo el total porque la fase del lienzo necesita saber a qué hora se sale del
 * hotel, no cuánto dura la cosa: con la hora de salida del tren y la antelación
 * puede dejar la mañana libre de verdad.
 */
export function puertaAPuerta(modo, minutosTrayecto, params, posicionamiento = 0) {
  const esVuelo = modo === 'vuelo' || modo === 'avion';
  // Un coche de alquiler y un viaje compartido te llevan de puerta a puerta: no
  // hay estación a la que ir. Pero eso NO los hace más rápidos, y en la primera
  // versión sí lo eran: quitarles el acceso les regalaba cincuenta minutos, y el
  // coche pasó de 3h50 a 3h30 justo cuando lo que se buscaba era lo contrario.
  // Lo que ahorran en trayecto lo gastan en gestión, y ahí va.
  const sinEstacion = modo === 'coche' || modo === 'traslado';

  const acceso = esVuelo ? params.accesoAeropuerto : sinEstacion ? 0 : params.accesoEstacion;

  // LA ANTELACIÓN DE UN COCHE NO ES CERO, aunque no haya que facturar.
  //
  // Un alquiler hay que recogerlo, revisarlo, devolverlo con gasolina y aparcar
  // al llegar; un viaje compartido es esperar a alguien que puede no aparecer.
  // Nada de eso está en la duración del trayecto, y sin contarlo el coche ganaba
  // saltos entre ciudades por veinte minutos frente a un tren directo —que es
  // justo lo que pasó en la primera prueba con Polonia—.
  //
  // Se le pide a la IA que lo tuviera en cuenta y no lo hizo: dijo que veinte
  // minutos justificaban el alquiler. Contarlo aquí es más honesto que pedirlo:
  // así los números que compara ya dicen la verdad.
  // Y no es lo mismo un alquiler que un viaje compartido: uno hay que recogerlo,
  // revisarlo, devolverlo con gasolina y aparcarlo; el otro es esperar a alguien
  // en un punto de encuentro. Se separan porque la diferencia son horas.
  const antelacion = esVuelo
    ? params.antelacionVuelo
    : modo === 'coche'
      ? params.margenCoche
      : modo === 'traslado'
        ? params.margenCompartido
        : params.antelacionTren;

  // Salir de una estación es inmediato; de un aeropuerto, no: hay que recoger
  // maleta y llegar al centro. Se usa el mismo acceso, que es el mismo trayecto
  // al revés.
  const salida = acceso;

  // EL POSICIONAMIENTO: llegar hasta donde de verdad sale eso.
  //
  // Un vuelo SKG→ATH para salir de Meteora no empieza en Meteora: empieza tres
  // horas antes, en la carretera a Tesalónica. Sin contarlo, la opción decía
  // «3h 25min puerta a puerta» cuando eran seis y media, y con ese número se
  // eligió. No se prohíbe retroceder —a veces compensa—: se deja de esconder.
  const posicion = Math.max(0, Number(posicionamiento) || 0);

  const total = posicion + acceso + antelacion + (minutosTrayecto ?? 0) + salida;
  return {
    posicion,
    acceso,
    antelacion,
    trayecto: minutosTrayecto ?? 0,
    salida,
    total,
  };
}

/** "2h 50min" a partir de minutos. */
export function comoTexto(min) {
  if (min == null) return '—';
  const h = Math.floor(min / 60);
  const m = Math.round(min % 60);
  return h ? `${h}h ${m ? `${m}min` : ''}`.trim() : `${m}min`;
}

// =============================================================================
// BUSCAR LAS OPCIONES DE UN SALTO
// =============================================================================
/**
 * Las opciones por tierra, del catálogo, investigándolo si está vacío.
 *
 * El catálogo es de la casa: los trenes entre Cracovia y Varsovia no dependen de
 * mi viaje, así que si otro viaje ya los miró, no se vuelve a preguntar.
 */
async function opcionesPorTierra(ciudadA, ciudadB, viajeId) {
  let fichas = fichasDeTramo(ciudadA, ciudadB);

  if (!fichas.length) {
    anotar(viajeId, FASE, `   ${ciudadA} → ${ciudadB}: no había nada en el catálogo; lo investigo.`);
    const investigadas = await investigarTramo(ciudadA, ciudadB);
    for (const f of investigadas) guardarFichaTramo(ciudadA, ciudadB, f, 'ia');
    fichas = fichasDeTramo(ciudadA, ciudadB);
  }

  return fichas
    .filter((f) => f.medio !== 'avion')
    .map((f) => ({
      clase: 'tierra',
      fichaId: f.id,
      modo: f.medio,
      nombre: f.nombre,
      trayecto: aMinutos(f.duracion),
      // EL PRECIO SOLO CUENTA SI SE SABE DE DÓNDE SALE.
      //
      // Las fichas viejas llevan precios que escribió el modelo de memoria —el
      // Pendolino a 120 € cuando cuesta 25, un alquiler de coche a 1 €— y
      // entraban en la regla del empate como si fueran ciertos. Ahora solo se
      // usa el que trajo la búsqueda o el que escribiste tú; el resto es un
      // hueco declarado, que es la verdad.
      precio: ['busqueda', 'manual'].includes(f.precio_origen) ? aPrecio(f.precio) : null,
      horario: f.frecuencia || null,
      nota: f.nota || null,
    }))
    // Sin duración no se puede comparar puerta a puerta, y adivinarla sería
    // inventarse el dato que decide.
    .filter((o) => o.trayecto);
}

/**
 * ¿ESTÁ ESE AEROPUERTO EN LA CIUDAD DE LA QUE SALIMOS?
 *
 * `resolverIata` devuelve el aeropuerto que sirve a una ciudad, y eso no es lo
 * mismo que un aeropuerto EN esa ciudad: para Kalambaka (Meteora) devuelve SKG,
 * que está en Tesalónica, a tres horas por carretera. El puerta a puerta lo daba
 * por gratis, y con ese número —«3h 25min»— se eligió volar desde un sitio al
 * que había que volver primero.
 *
 * Se pregunta por los DOS extremos del salto: volver al aeropuerto de origen
 * cuesta tiempo, y aterrizar lejos del destino también.
 *
 * Devuelve 0 cuando el aeropuerto es de la propia ciudad, que es el caso normal
 * y no cuesta nada. Si la consulta falla se devuelve 0 y se dice: es lo mismo
 * que había antes, no una regresión nueva.
 */
async function posicionamientoHasta(ciudad, iata) {
  if (!ciudad || !iata) return { minutos: 0, ciudad: null };

  try {
    const r = await consultarJSON(
      [
        `¿El aeropuerto ${iata} está en ${ciudad} o en otra ciudad?`,
        '',
        'REGLAS:',
        '1. "mismaCiudad" es true si el aeropuerto sirve a esa ciudad y está en',
        `   ella o en su área metropolitana —el trayecto normal al aeropuerto—.`,
        '2. Es false si hay que desplazarse a OTRA ciudad para cogerlo. Ejemplo:',
        '   para Kalambaka el aeropuerto es SKG, que está en Tesalónica.',
        '3. "minutos" es el tiempo POR CARRETERA de esa ciudad al aeropuerto,',
        '   solo cuando mismaCiudad es false. Si es true, 0.',
        '4. Si no lo sabes con seguridad, pon mismaCiudad true y minutos 0: es',
        '   preferible quedarse como estábamos a inventarse tres horas.',
        '',
        'Devuelve SOLO este JSON:',
        '{"mismaCiudad": false, "ciudadDelAeropuerto": "Tesalónica", "minutos": 180}',
      ].join('\n'),
      { maxTokens: 300, paso: `situar el aeropuerto ${iata} respecto a ${ciudad}` }
    );

    if (r?.mismaCiudad !== false) return { minutos: 0, ciudad: null };

    const minutos = Number(r?.minutos);
    if (!Number.isFinite(minutos) || minutos <= 0) return { minutos: 0, ciudad: null };

    return {
      minutos: Math.min(minutos, 8 * 60), // un tope de cordura
      ciudad: String(r?.ciudadDelAeropuerto ?? '').trim() || null,
    };
  } catch (err) {
    console.warn(`[traslados] no pude situar ${iata} respecto a ${ciudad}: ${err.message}`);
    return { minutos: 0, ciudad: null };
  }
}

/**
 * Los vuelos internos, y solo cuando tienen alguna posibilidad.
 *
 * Se buscan si la fase 1 estimó que ese salto se hace en avión, o si por tierra
 * se va por encima de cinco horas. En un salto de dos horas en tren, abrir el
 * navegador para mirar vuelos es tiempo tirado: el avión no puede ganar.
 *
 * `mejorTierra` ES EL TIEMPO REAL PUERTA A PUERTA de la mejor opción terrestre,
 * no la estimación de la fase 1 ni el tiempo dentro del vagón. Esa distinción
 * costó un vuelo sin mirar: en Polonia la estimación dijo «menos de cinco horas»
 * para Gdansk → Cracovia, que puerta a puerta son más de seis, y el avión ni se
 * consultó. La matriz estimada sirve para descartar candidatas lejísimas sin
 * gastar búsquedas; nunca para decidir tierra contra aire en la ruta ya elegida.
 */
async function opcionesEnAvion({ viaje, ciudadA, ciudadB, mejorTierra, loDijoLaFase1, auto }) {
  const mereceLaPena = loDijoLaFase1 || !mejorTierra || mejorTierra > TIERRA_LARGA_MIN;
  if (!mereceLaPena) {
    return { opciones: [], porQue: 'por tierra se llega en menos de cinco horas puerta a puerta' };
  }

  const iataA = await resolverIata(ciudadA);
  const iataB = await resolverIata(ciudadB);
  if (!iataA || !iataB || iataA === iataB) {
    return { opciones: [], porQue: 'no hay dos aeropuertos distintos que consultar' };
  }

  const etapa = una(
    'SELECT fecha_fin FROM etapas WHERE viaje_id = ? AND nombre_ciudad = ? ORDER BY orden LIMIT 1',
    viaje.id,
    ciudadA
  );
  const fecha = etapa?.fecha_fin;
  if (!fecha) return { opciones: [], porQue: 'ese salto no tiene fecha' };

  // DÓNDE ESTÁN DE VERDAD ESOS AEROPUERTOS. Se pregunta una vez por salto, y
  // solo cuando ya se ha decidido que merece la pena mirar vuelos.
  const [salida, llegada] = await Promise.all([
    posicionamientoHasta(ciudadA, iataA),
    posicionamientoHasta(ciudadB, iataB),
  ]);
  const posicionamiento = salida.minutos + llegada.minutos;

  const nota = [
    salida.minutos ? `${comoTexto(salida.minutos)} hasta ${salida.ciudad ?? iataA}` : null,
    llegada.minutos ? `${comoTexto(llegada.minutos)} desde ${llegada.ciudad ?? iataB}` : null,
  ].filter(Boolean);

  const { adultos, edadesNinos } = ocupacionDe(viaje);
  const oNulo = (v) => (v && v !== 'indiferente' ? v : null);

  try {
    const vuelos = await buscarVuelosKayak({
      origen: iataA,
      destino: iataB,
      fechaIda: fecha,
      fechaVuelta: null,
      adultos,
      edadesNinos,
      // Dentro de un país, la franja de la ida del viaje no pinta nada; las
      // escalas sí, que es una preferencia sobre cómo se vuela.
      filtros: { escalas: oNulo(auto.escalas), duracionMax: null, salidaIda: null, salidaVuelta: null, precioMaxPersona: null },
      maxResultados: VUELOS_POR_SALTO,
    });

    return {
      opciones: vuelos
        .map((v, i) => {
          const t = (v.tramos ?? [])[0] ?? {};
          return {
            clase: 'vuelo',
            vuelo: v,
            indice: i,
            modo: 'vuelo',
            // EL NOMBRE DICE LO QUE CUESTA LLEGAR. Sin esto, «Vuelo SKG→ATH»
            // parece salir de donde estás, y no: salía de tres horas más allá.
            nombre:
              `${v.aerolinea ?? 'Vuelo'} ${iataA}→${iataB}` +
              (nota.length ? ` (incluye ${nota.join(' y ')})` : ''),
            trayecto: aMinutos(t.duracion),
            precio: v.precio ?? null,
            horario: t.horaSalida ?? null,
            nota: [t.escalas ? `${t.escalas} escala(s)` : 'directo', ...nota].join(' · '),
            // Viaja con la opción para que el bloque puerta a puerta lo sume.
            posicionamiento,
          };
        })
        .filter((o) => o.trayecto),
      porQue: null,
    };
  } catch (err) {
    return { opciones: [], porQue: `la búsqueda de vuelos falló (${err.message})` };
  }
}

// =============================================================================
// GUARDAR
// =============================================================================
/**
 * Deja el salto resuelto, igual que si lo hubiera elegido el usuario a mano.
 *
 * Por tierra se usa `elegirMedio`, que es la misma función del botón de la
 * pantalla, y se guarda el horario con `guardarDatosDelTramo`, que es el mismo
 * formulario. En avión se apunta el vuelo como candidato del tramo y marcado,
 * que es lo que hace el buscador al elegir uno.
 *
 * Y en los dos casos se escribe el BLOQUE en `datos_extra`: a qué hora hay que
 * salir del hotel y hasta cuándo dura el lío. Es lo que va a leer la fase del
 * lienzo para no colocar nada encima.
 */
/**
 * QUÉ CUENTA EL PRECIO DE LA OPCIÓN ELEGIDA.
 *
 * Por tierra, lo que ya dijo la búsqueda cuando se guardó la ficha; si aquella
 * no lo dijo, la regla del medio. En avión no se llega aquí con precio: el vuelo
 * se guarda como candidato y su ámbito va con él.
 */
function ambitoDeLaOpcion(opcion) {
  if (opcion.clase !== 'tierra') return POR_GRUPO; // Kayak da el total de la reserva

  const ficha = opcion.fichaId
    ? una('SELECT medio, nombre, precio_ambito FROM catalogo_transporte_tramo WHERE id = ?', opcion.fichaId)
    : null;

  return ficha?.precio_ambito ?? ambitoDeTramo({ medio: opcion.modo, nombre: opcion.nombre });
}

function guardarEleccion(tramo, opcion, horaSalida, bloque, porQue) {
  const previo = (() => {
    try {
      return tramo.datos_extra ? JSON.parse(tramo.datos_extra) : {};
    } catch {
      return {};
    }
  })();

  if (opcion.clase === 'tierra') {
    elegirMedio(tramo.id, opcion.fichaId);
    guardarDatosDelTramo(tramo.id, opcion.fichaId, {
      // LA HORA ES UN PLAN, NO UN HORARIO PUBLICADO.
      //
      // El catálogo guarda frecuencias («cada 30 minutos»), no salidas
      // concretas: esta hora la elige la IA para que el día cuadre. Guardarla a
      // secas la convertía en «sale 09:00» en Mi ruta, que se lee como el
      // horario del billete. Con «sobre las» sigue sirviendo para colocar el
      // traslado en el lienzo sin fingir un dato que nadie ha consultado.
      horario: horaSalida ? `sobre las ${horaSalida}` : null,
      precioReal: opcion.precio != null ? String(opcion.precio) : null,
      referencia: null,
      nota: porQue,
    });
  } else {
    const v = opcion.vuelo;
    const t = (v.tramos ?? [])[0] ?? {};
    const r = ejecutar(
      // El precio de Kayak es el total de la reserva, no el de cada billete.
      `INSERT INTO candidatos
         (viaje_id, transporte_id, tipo, titulo, precio, moneda, origen_datos, marcado, datos_extra, precio_ambito)
       VALUES (?, ?, 'vuelo', ?, ?, ?, 'kayak', 1, ?, 'por_grupo')`,
      tramo.viaje_id,
      tramo.id,
      opcion.nombre,
      v.precio ?? null,
      v.moneda ?? null,
      JSON.stringify({
        huella: `${t.horaSalida}-${t.horaLlegada}`,
        aerolineas: v.aerolinea ?? null,
        minutosTotales: opcion.trayecto,
        elegidoPor: 'orquestador',
        tramos: [{ tramo: 'ida', horaSalida: t.horaSalida ?? null, horaLlegada: t.horaLlegada ?? null, duracion: t.duracion ?? null, escalas: t.escalas ?? null }],
      })
    );
    ejecutar(
      "UPDATE transportes SET candidato_id = ?, tipo = 'vuelo' WHERE id = ?",
      Number(r.lastInsertRowid),
      tramo.id
    );
  }

  // El bloque, y las notas, que son lo que enseña la ruta y el lienzo de un
  // vistazo. `notas` la lee `resumenDeSalto` para el chip del día.
  // EL ÁMBITO VIAJA CON EL PRECIO. Un billete de tren es de cada uno y un
  // traslado privado es del coche entero: si el presupuesto tuviera que
  // deducirlo después, un taxi de 90 € se convertiría en 180 € para dos. Se
  // guarda aquí, en el momento de elegir, con lo que dijo la búsqueda de esa
  // opción (services/presupuesto.js tiene la regla).
  ejecutar(
    `UPDATE transportes
        SET datos_extra = ?, notas = ?, duracion_min = ?, precio_estimado = ?, precio_ambito = ?
      WHERE id = ?`,
    JSON.stringify({ ...previo, bloque, elegidoPor: 'orquestador', porQue }),
    `${opcion.nombre}${horaSalida ? ` · sale ${horaSalida}` : ''}`,
    bloque.total,
    opcion.precio ?? null,
    opcion.precio == null ? null : ambitoDeLaOpcion(opcion),
    tramo.id
  );
}

/**
 * DEJA DICHO EN EL VIAJE QUE ESE TRASLADO ES UN MADRUGÓN.
 *
 * No cambia la decisión: cuando no hay alternativa razonable, el vuelo de las
 * siete es el que hay. Lo que no puede pasar es que aparezca en el itinerario
 * como si fuera una hora normal y uno se entere la víspera.
 *
 * Va a los avisos del viaje, en su propia categoría, para que el trabajo que los
 * rehace no se lo lleve por delante.
 */
function avisarDeMadrugon(viaje, desde, hasta, eleccion, limite, di) {
  ejecutar(
    "DELETE FROM avisos WHERE viaje_id = ? AND categoria = 'traslado' AND titulo LIKE ?",
    viaje.id,
    `%${desde} → ${hasta}%`
  );

  ejecutar(
    `INSERT INTO avisos (viaje_id, categoria, severidad, titulo, texto)
     VALUES (?, 'traslado', 'aviso', ?, ?)`,
    viaje.id,
    `El traslado ${desde} → ${hasta} sale a las ${eleccion.hora}`,
    `Es antes del límite de tu ritmo (${limite}): madrugón a la vista. Miré las otras ` +
      'opciones del día y ninguna respeta la hora sin costar bastante más tiempo, así que ' +
      'se queda esta. Si prefieres dormir, hay que cambiarlo a mano.'
  );

  di(
    `   Aviso para el viaje: ${desde} → ${hasta} sale a las ${eleccion.hora}, ` +
      'antes del límite de tu ritmo; no hay alternativa que lo respete.',
    ORIGENES.scraping
  );
}

/**
 * LA HORA A PARTIR DE LA CUAL UN TRASLADO NO ES UN MADRUGÓN.
 *
 * Depende de dos cosas: de en qué se viaja —un avión pide dos horas de
 * antelación y un tren media— y del ritmo del viaje. Con ritmo intenso se
 * adelanta una hora, que es lo que significa apretar.
 */
export function horaMinimaDeSalida(modo, ritmo) {
  const esVuelo = modo === 'vuelo' || modo === 'avion';
  const base = parametroTexto(esVuelo ? 'hora_minima_avion' : 'hora_minima_tren', esVuelo ? '10:00' : '09:00');

  const minutos = enMinutosDelDia(base);
  if (minutos == null) return null;

  // Con ritmo intenso se puede madrugar una hora más. Con el resto, no.
  return ritmo === 'intenso' ? Math.max(0, minutos - 60) : minutos;
}

/** "07:00" -> 420. Los minutos desde medianoche. */
export function enMinutosDelDia(hora) {
  const m = String(hora ?? '').match(/(\d{1,2}):(\d{2})/);
  return m ? Number(m[1]) * 60 + Number(m[2]) : null;
}

/** 545 -> "09:05". */
export function comoHoraDelDia(minutos) {
  const m = Math.max(0, Math.min(Math.round(minutos), 24 * 60 - 1));
  return `${String(Math.floor(m / 60)).padStart(2, '0')}:${String(m % 60).padStart(2, '0')}`;
}

/**
 * ¿LA HORA ELEGIDA RESPETA EL RITMO DEL VIAJE?
 *
 * El prompt lo dice desde el principio —«nada de coger avión antes de las 10:00
 * con ritmo tranquilo o normal»— y la IA lo entendió tan bien que lo escribió en
 * su justificación: «exige salir del hotel a las 6:15, lo cual es apretado». Y
 * eligió ese vuelo igual, porque las alternativas eran peores.
 *
 * Una regla que se enuncia y no se comprueba no es una regla. Aquí se comprueba.
 */
export function respetaElRitmo(opcion, hora, ritmo) {
  const limite = horaMinimaDeSalida(opcion?.modo, ritmo);
  const sale = enMinutosDelDia(hora);
  if (limite == null || sale == null) return true; // sin hora no hay nada que juzgar
  return sale >= limite;
}

/**
 * EL AHORRO GRANDE: el segundo escalón de la regla del precio.
 *
 * El empate de siempre mira diferencias pequeñas de tiempo. Pero en Nafplio →
 * Atenas el traslado privado costaba 160 € contra 15,70 € del autobús y ganaba
 * por exactamente una hora: la diferencia de tiempo se quedaba justo fuera del
 * umbral del empate, así que nadie evaluó que la hora costaba 144 € para dos.
 *
 * Cuando algo es mucho más barato y pierde poco tiempo, la cuenta se le da hecha
 * a la IA. La decisión sigue siendo suya —con niños y maletas, una hora puede
 * valer 144 €—, pero ya no la toma sin mirar el dinero.
 */
export function reglaDelAhorroGrande(medidas, params) {
  const cumplen = ahorrosQueCumplen(medidas, params);
  if (!cumplen.length) return null;

  // Se propone la MÁS BARATA de las que cumplen: si varias pasan el listón, la
  // pregunta ya no es cuánto se ahorra sino cuánto cuesta, y eso lo decide el
  // precio. Las demás se enumeran igualmente para que la decisión se tome con
  // todas delante.
  const elegida = [...cumplen].sort((a, b) => a.barata.precio - b.barata.precio)[0];
  const otras = cumplen.filter((x) => x.barata.id !== elegida.barata.id);

  return (
    `Se cumple la regla del ahorro grande frente a «${elegida.ganadora.nombre}» ` +
    `(${elegida.ganadora.precio} €): «${elegida.barata.nombre}» cuesta ${elegida.barata.precio} € ` +
    `(${elegida.veces.toFixed(1)} veces menos) y solo pierde ${comoTexto(Math.max(0, elegida.pierde))}.` +
    (otras.length
      ? ` También cumplen: ${otras
          .map(
            (o) =>
              `${o.barata.nombre} (${o.barata.precio} €, ${o.veces.toFixed(1)}x, ` +
              `+${comoTexto(Math.max(0, o.pierde))})`
          )
          .join('; ')}.`
      : '') +
    ' Elige una salvo que haya un motivo de peso (niños, equipaje, horario).'
  );
}

/**
 * TODAS LAS OPCIONES QUE CUMPLEN EL AHORRO GRANDE, no solo la más barata.
 *
 * AQUÍ ESTABA EL SEGUNDO FALLO DE ESTA REGLA. La versión anterior cogía la
 * opción MÁS BARATA y la comparaba contra las más rápidas; si esa no cumplía, se
 * acababa la evaluación. En Nafplio → Atenas la más barata era el tren (13,80 €)
 * y perdía 2h50 sobre el taxi, así que se descartaba... y ahí paraba todo. El
 * KTEL —15,70 €, ocho veces más barato que el taxi y solo una hora más lento—
 * nunca llegó a mirarse, y se eligió un taxi de 140 €.
 *
 * Ahora se compara CADA opción con precio contra la candidata a ganar, que es la
 * más rápida que tiene precio. La lista de las que cumplen es lo que se le pone
 * delante a la IA.
 */
export function ahorrosQueCumplen(medidas, params) {
  const conPrecio = medidas.filter((o) => o.precio != null && o.precio > 0);
  if (conPrecio.length < 2) return [];

  // La candidata a ganar: la más rápida DE LAS QUE TIENEN PRECIO. Sin precio no
  // se puede comparar dinero, y anclarse en la más rápida a secas fue el primer
  // fallo de esta misma regla.
  const ganadora = [...conPrecio].sort((a, b) => a.bloque.total - b.bloque.total)[0];

  return conPrecio
    .filter((o) => o.id !== ganadora.id)
    .map((barata) => ({
      ganadora,
      barata,
      veces: ganadora.precio / barata.precio,
      pierde: barata.bloque.total - ganadora.bloque.total,
    }))
    .filter((x) => x.veces >= params.factorAhorro && x.pierde <= params.maxExtraAhorro)
    .sort((a, b) => b.veces - a.veces);
}

export function porQueNoHayAhorroGrande(medidas, params) {
  const conPrecio = medidas.filter((o) => o.precio != null && o.precio > 0);
  if (conPrecio.length < 2) {
    return `Ahorro grande no evaluable: solo ${conPrecio.length} opción(es) con precio.`;
  }

  const ganadora = [...conPrecio].sort((a, b) => a.bloque.total - b.bloque.total)[0];
  const resto = conPrecio.filter((o) => o.id !== ganadora.id);
  if (!resto.length) {
    return `Ahorro grande no aplica: «${ganadora.nombre}» es la única con precio.`;
  }

  // Se enseña la que MÁS CERCA se quedó, para que se vea que se miraron todas.
  const cerca = resto
    .map((o) => ({
      nombre: o.nombre,
      precio: o.precio,
      veces: ganadora.precio / o.precio,
      pierde: o.bloque.total - ganadora.bloque.total,
    }))
    .sort((a, b) => b.veces - a.veces)[0];

  return (
    `Ahorro grande no llega con ${resto.length === 1 ? 'la única alternativa' : `ninguna de las ${resto.length} alternativas`} a ` +
    `«${ganadora.nombre}» (${ganadora.precio} €). La más cerca: «${cerca.nombre}» ` +
    `(${cerca.veces.toFixed(1)} veces más barata, hacen falta ${params.factorAhorro}; ` +
    `pierde ${comoTexto(Math.max(0, cerca.pierde))}, el tope son ${comoTexto(params.maxExtraAhorro)}).`
  );
}

// =============================================================================
// LA FASE
// =============================================================================
export async function ejecutarFaseTraslados(viaje, prompt) {
  const viajeId = viaje.id;
  const di = (t, origen = null) => anotar(viajeId, FASE, t, origen);

  if (!hayClaveIA()) throw new Error(SIN_CLAVE);

  const etapas = todas(
    "SELECT * FROM etapas WHERE viaje_id = ? AND estado = 'confirmada' ORDER BY orden, id",
    viajeId
  );
  if (etapas.length < 2) {
    di('El viaje tiene una sola parada: no hay ningún salto que resolver.');
    return { saltos: 0 };
  }

  const params = {
    accesoAeropuerto: parametro('acceso_aeropuerto_min', 45),
    accesoEstacion: parametro('acceso_estacion_min', 25),
    antelacionVuelo: parametro('antelacion_vuelo_europeo_min', 60),
    antelacionTren: parametro('antelacion_tren_min', 30),
    margenCoche: parametro('margen_coche_min', 120),
    margenCompartido: parametro('margen_viaje_compartido_min', 45),
    umbral: parametro('umbral_empate_traslado_min', 30),
    factorPrecio: parametro('factor_precio_traslado', 3),
    factorAhorro: parametro('factor_ahorro_traslado', 4),
    maxExtraAhorro: parametro('max_tiempo_extra_ahorro_min', 75),
    maxPenalizacionHorario: parametro('max_penalizacion_horario_min', 90),
  };
  const auto = configAuto(viaje);

  // Lo que la fase 1 estimó sobre cada salto. Si dijo que se va en avión, se
  // mira el avión aunque por tierra parezca razonable.
  const estimados = (() => {
    try {
      return JSON.parse(viaje.ciudades_candidatas ?? '{}').tiempos ?? [];
    } catch {
      return [];
    }
  })();
  const delPar = (a, b) =>
    estimados.find(
      (t) => (t.desde === a && t.hasta === b) || (t.desde === b && t.hasta === a)
    ) ?? null;

  const loEstimoEnAvion = (a, b) => delPar(a, b)?.modo === 'vuelo';

  /** Los minutos que la fase 1 se imaginó para ese salto, si se imaginó alguno. */
  const minutosEstimados = (a, b) => {
    const n = Number(delPar(a, b)?.minutos);
    return Number.isFinite(n) && n > 0 ? n : null;
  };

  di(`${etapas.length} paradas: ${etapas.length - 1} salto(s) que resolver.`);

  let resueltos = 0;

  for (let i = 0; i < etapas.length - 1; i += 1) {
    const desde = etapas[i];
    const hasta = etapas[i + 1];

    // Entre salto y salto no hay nada a medias: el anterior está guardado y del
    // siguiente no se ha tocado nada. Ver el punto de control de la fase 4.
    if (hayQueParar(viajeId, FASE, `${desde.nombre_ciudad} → ${hasta.nombre_ciudad}`)) {
      di(
        `Parada pedida: lo dejo antes de ${desde.nombre_ciudad} → ${hasta.nombre_ciudad}.`,
        ORIGENES.ninguno
      );
      break;
    }
    const tramo = una(
      'SELECT * FROM transportes WHERE viaje_id = ? AND etapa_origen_id = ? AND etapa_destino_id = ?',
      viajeId,
      desde.id,
      hasta.id
    );

    if (!tramo) {
      apuntarHueco(viajeId, FASE, `No encuentro el tramo de ${desde.nombre_ciudad} a ${hasta.nombre_ciudad}.`);
      continue;
    }
    if (tramo.tocado_a_mano) {
      di(`${desde.nombre_ciudad} → ${hasta.nombre_ciudad}: lo has decidido tú; no lo toco.`);
      continue;
    }

    di(`Buscando cómo ir de ${desde.nombre_ciudad} a ${hasta.nombre_ciudad}…`);

    // --- Las opciones -----------------------------------------------------
    let porTierra = [];
    try {
      porTierra = await opcionesPorTierra(desde.nombre_ciudad, hasta.nombre_ciudad, viajeId);
    } catch (err) {
      di(`   No pude mirar por tierra: ${err.message}`);
    }

    // LA TIERRA SE MIDE PUERTA A PUERTA ANTES DE DECIDIR NADA.
    //
    // Antes se comparaba con el umbral el tiempo del trayecto —lo que dura el
    // tren— y, encima, la estimación de la fase 1 podía dar el salto por corto
    // sin haber mirado ninguna opción real. Así se quedó sin consultar el vuelo
    // de Gdansk a Cracovia: «menos de cinco horas» decía la estimación, y son
    // seis y cuarto puerta a puerta contando ir a la estación y la antelación.
    //
    // El bloque puerta a puerta se calcula aquí una sola vez y viaja con la
    // opción hasta el final: es el número que decide si se mira el avión y
    // también el que compite después.
    const medidasTierra = porTierra.map((o) => ({
      ...o,
      bloque: puertaAPuerta(o.modo, o.trayecto, params),
    }));
    const mejorTierra = medidasTierra.length
      ? Math.min(...medidasTierra.map((o) => o.bloque.total))
      : null;

    const estimado = minutosEstimados(desde.nombre_ciudad, hasta.nombre_ciudad);
    if (estimado != null && estimado <= TIERRA_LARGA_MIN && mejorTierra > TIERRA_LARGA_MIN) {
      di(
        `   La estimación decía ${comoTexto(estimado)}, pero la mejor opción real son ` +
          `${comoTexto(mejorTierra)}: miro también vuelo interno.`,
        ORIGENES.busqueda
      );
    }

    const aire = await opcionesEnAvion({
      viaje,
      ciudadA: desde.nombre_ciudad,
      ciudadB: hasta.nombre_ciudad,
      mejorTierra,
      loDijoLaFase1: loEstimoEnAvion(desde.nombre_ciudad, hasta.nombre_ciudad),
      auto,
    });
    if (aire.porQue) di(`   Sin mirar vuelos: ${aire.porQue}.`);

    const opciones = [...medidasTierra, ...aire.opciones];

    if (!opciones.length) {
      apuntarHueco(
        viajeId,
        FASE,
        `${desde.nombre_ciudad} → ${hasta.nombre_ciudad}: no encontré ninguna opción. Tendrás que mirarlo tú.`
      );
      di(`   ${desde.nombre_ciudad} → ${hasta.nombre_ciudad}: sin opciones. Lo dejo como hueco y sigo.`);
      continue;
    }

    // --- Puerta a puerta, que es lo que compite --------------------------
    //
    // Las terrestres ya vienen medidas de arriba —con ese número se decidió si
    // mirar vuelos—, así que aquí solo les falta el bloque a las de avión.
    const medidas = opciones.map((o, n) => ({
      ...o,
      id: `op${n + 1}`,
      bloque: o.bloque ?? puertaAPuerta(o.modo, o.trayecto, params, o.posicionamiento ?? 0),
    }));
    medidas.sort((a, b) => a.bloque.total - b.bloque.total);

    // Duraciones y precios salen del catálogo de tramos, que se llenó con el
    // Modo IA de Google. Lo que pone el código encima son los márgenes de
    // acceso, que son constantes nuestras, no un dato del mundo.
    di(
      `   ${medidas.length} opción(es): ` +
        medidas
          .map(
            (o) =>
              `${o.nombre} [${comoTexto(o.bloque.total)} puerta a puerta` +
              `${o.bloque.posicion ? `, ${comoTexto(o.bloque.posicion)} de ellos solo en llegar al aeropuerto` : ''}` +
              `${o.precio != null ? `, ${o.precio} €` : ', precio no encontrado'}]`
          )
          .join(' · '),
      ORIGENES.busqueda
    );

    // --- El empate que no es empate --------------------------------------
    //
    // Se calcula aquí y se le DICE a la IA, en vez de dejar que lo deduzca: es
    // una regla con números, y las reglas con números no se delegan a quien no
    // sabe sumar.
    const rapida = medidas[0];
    const barata = [...medidas].sort((a, b) => (a.precio ?? 1e9) - (b.precio ?? 1e9))[0];
    let reglaDelEmpate = null;

    // SIN LOS DOS PRECIOS NO HAY REGLA, Y SE DICE.
    //
    // La regla compara «cuánto más tarda» contra «cuántas veces más cuesta».
    // Con un precio a medias la comparación no existe, y antes eso pasaba en
    // silencio: ahora gana la más rápida, como siempre, pero queda escrito por
    // qué no se ha mirado el dinero. Sin el aviso, un empate que no se evalúa se
    // confunde con un empate que se evaluó y no salió.
    // Se mira sobre TODAS las opciones y no solo sobre la rápida y la barata: si
    // no hay ningún precio, la «barata» acaba siendo la propia rápida y el aviso
    // no llegaba a saltar justo en el caso en que menos se sabe.
    const sinPrecio = medidas.filter((o) => o.precio == null);
    if (medidas.length > 1 && sinPrecio.length) {
      di(
        `   Empate por precio no aplicable: falta el precio de ` +
          `${sinPrecio.map((o) => `${o.id} (${o.nombre})`).join(', ')}. ` +
          'Gana la más rápida puerta a puerta.',
        ORIGENES.ninguno
      );
    }

    if (
      barata.id !== rapida.id &&
      rapida.precio != null &&
      barata.precio != null &&
      barata.precio > 0
    ) {
      const diferencia = rapida.bloque.total - barata.bloque.total;
      const cuantasVeces = rapida.precio / barata.precio;
      if (Math.abs(diferencia) < params.umbral && cuantasVeces > params.factorPrecio) {
        reglaDelEmpate =
          `«${barata.nombre}» solo tarda ${Math.abs(diferencia)} min más (por debajo del umbral de ` +
          `${params.umbral}) y «${rapida.nombre}» cuesta ${cuantasVeces.toFixed(1)} veces más ` +
          `(por encima del factor ${params.factorPrecio}): por regla, gana la barata.`;
        di(`   Regla de empate: ${reglaDelEmpate}`);
      }
    }

    // --- Y el ahorro grande, que es el otro escalón de la misma idea ------
    const reglaDelAhorro = reglaDelAhorroGrande(medidas, params);
    if (reglaDelAhorro) {
      di(`   ${reglaDelAhorro}`, ORIGENES.busqueda);
    } else {
      // SE DICE TAMBIÉN CUANDO NO SE ACTIVA. Un silencio no distingue «la regla
      // se miró y no salía» de «la regla no llegó a correr», y esa diferencia es
      // justo la que dejó pasar una regresión durante toda una ejecución.
      di(`   ${porQueNoHayAhorroGrande(medidas, params)}`, ORIGENES.busqueda);
    }

    // --- La elección ------------------------------------------------------
    const datos = {
      DESDE: desde.nombre_ciudad,
      HASTA: hasta.nombre_ciudad,
      DIA: hasta.fecha_inicio ?? desde.fecha_fin ?? '',
      RITMO: viaje.ritmo || 'normal',
      VIAJEROS: (() => {
        const { adultos, edadesNinos } = ocupacionDe(viaje);
        return `${adultos} adulto(s)` + (edadesNinos.length ? ` y niños de ${edadesNinos.join(' y ')} años` : '');
      })(),
      OPCIONES: medidas
        .map(
          (o) =>
            `- ${o.id} · ${o.nombre} (${o.modo})\n` +
            `  puerta a puerta: ${comoTexto(o.bloque.total)} = ${o.bloque.acceso} ir + ` +
            `${o.bloque.antelacion} de antelación + ${o.bloque.trayecto} de trayecto + ${o.bloque.salida} al llegar\n` +
            `  precio: ${o.precio != null ? `${o.precio} €` : 'precio no encontrado'}` +
            `${o.horario ? `\n  horarios: ${o.horario}` : ''}` +
            `${o.nota ? `\n  nota: ${o.nota}` : ''}`
        )
        .join('\n'),
      REGLA_DEL_EMPATE:
        [reglaDelEmpate, reglaDelAhorro].filter(Boolean).join('\n') ||
        'No se cumple: gana la más rápida puerta a puerta.',

      // LOS DOS UMBRALES DE LA REGLA 3, LEÍDOS DE DONDE VIVEN.
      //
      // Estaban escritos a fuego dentro del texto del prompt, y son los mismos
      // que aplica `horaMinimaDeSalida()` unas líneas más arriba. Con el número
      // en los dos sitios, cambiar el parámetro dejaba al modelo eligiendo con
      // el valor viejo y al código corrigiéndole con el nuevo: el modelo no se
      // equivocaba, es que le habíamos dado mal la regla.
      //
      // Van SIN el ajuste del ritmo intenso a propósito: el prompt dice justo
      // después que con ese ritmo se puede apretar una hora, que es lo que
      // `horaMinimaDeSalida()` hace con estos mismos valores.
      HORA_MINIMA_TREN: parametroTexto('hora_minima_tren', '09:00'),
      HORA_MINIMA_AVION: parametroTexto('hora_minima_avion', '10:00'),
    };

    let eleccion = null;
    try {
      const r = await consultarJSON(rellenar(prompt, datos), {
        maxTokens: 1500,
        paso: `traslado ${desde.nombre_ciudad} → ${hasta.nombre_ciudad}`,
      });
      const elegida = medidas.find((o) => o.id === String(r?.elegida ?? '').trim());
      if (elegida) {
        eleccion = {
          opcion: elegida,
          hora: typeof r?.hora_salida === 'string' ? r.hora_salida.trim() : null,
          porQue: typeof r?.por_que === 'string' ? r.por_que.trim() : null,
        };
      }
    } catch (err) {
      di(`   La IA no pudo elegir (${err.message}).`);
    }

    // SI LA IA NO CONTESTA, EL SALTO NO SE QUEDA SIN RESOLVER. Se aplica la
    // regla base —la más rápida, o la barata si el empate lo dice— que es la
    // misma que ella tenía que seguir. Perder el matiz es mejor que perder el
    // traslado.
    if (!eleccion) {
      const porDefecto = reglaDelEmpate ? barata : rapida;
      eleccion = {
        opcion: porDefecto,
        hora: null,
        porQue: reglaDelEmpate
          ? 'la regla de empate por precio, aplicada sin la IA'
          : 'la más rápida puerta a puerta, aplicada sin la IA',
      };
      di('   Elijo yo con la regla base.');
    }

    // --- LA REGLA DEL RITMO SE COMPRUEBA, NO SE PIDE Y YA ------------------
    //
    // El prompt lleva desde el principio diciendo «nada de coger avión antes de
    // las 10:00 con ritmo tranquilo o normal». En Grecia la IA eligió un vuelo
    // de las 07:00 y lo explicó ella misma: «exige salir del hotel a las 6:15,
    // lo cual es apretado». Lo sabía y lo eligió igual, porque el resto era peor.
    //
    // Así que se comprueba aquí. Si hay otra opción que respete la hora y no
    // cueste demasiado tiempo de más, se vuelve a elegir sin las que incumplen.
    // Y si no la hay, se respeta la decisión —a veces el madrugón es lo único
    // que existe— pero se avisa al viaje: quien lo sufre tiene que saberlo.
    const ritmo = viaje.ritmo || 'normal';
    if (eleccion.hora && !respetaElRitmo(eleccion.opcion, eleccion.hora, ritmo)) {
      const limite = comoHoraDelDia(horaMinimaDeSalida(eleccion.opcion.modo, ritmo));
      di(
        `   La elegida sale a las ${eleccion.hora}, antes del límite de tu ritmo (${limite}).`,
        ORIGENES.ninguno
      );

      // Las que sí cumplirían, si saliesen a su hora más temprana permitida, y
      // que no pierdan más de lo que se está dispuesto a perder.
      const alcanzables = medidas.filter(
        (o) =>
          o.id !== eleccion.opcion.id &&
          o.bloque.total - eleccion.opcion.bloque.total <= params.maxPenalizacionHorario
      );

      if (alcanzables.length) {
        const sustituta = alcanzables[0];
        const cuesta = sustituta.bloque.total - eleccion.opcion.bloque.total;
        const nuevaHora = comoHoraDelDia(horaMinimaDeSalida(sustituta.modo, ritmo));

        di(
          `   Cambio a «${sustituta.nombre}» saliendo a las ${nuevaHora}: respeta tu ritmo y ` +
            `cuesta ${comoTexto(Math.max(0, cuesta))} más puerta a puerta.`,
          ORIGENES.busqueda
        );
        eleccion = {
          opcion: sustituta,
          hora: nuevaHora,
          porQue:
            `${eleccion.porQue ? `${eleccion.porQue} ` : ''}Cambiada por horario: la anterior salía ` +
            `a las ${eleccion.hora}, antes del límite de tu ritmo.`,
        };
      } else {
        avisarDeMadrugon(viaje, desde.nombre_ciudad, hasta.nombre_ciudad, eleccion, limite, di);
      }
    }

    guardarEleccion(tramo, eleccion.opcion, eleccion.hora, eleccion.opcion.bloque, eleccion.porQue);
    resueltos += 1;

    di(
      `${desde.nombre_ciudad} → ${hasta.nombre_ciudad}: ${eleccion.opcion.nombre}` +
        `${eleccion.hora ? ` sobre las ${eleccion.hora}` : ''}, ` +
        `${comoTexto(eleccion.opcion.bloque.total)} puerta a puerta.`
    );
    if (eleccion.porQue) di(`   Por qué: ${eleccion.porQue}`);
  }

  di(`${resueltos} de ${etapas.length - 1} salto(s) resueltos.`);

  // LOS KILOMETROS DE LA RUTA, AQUI MISMO.
  //
  // "Mi ruta" suma los km de cada salto de una cache que solo llenaba el mapa,
  // y el mapa mide desde la ciudad de entrada a las candidatas: el salto de en
  // medio (Gdansk -> Cracovia) no era par de nadie y la ruta decia "0 km (2
  // tramos sin calcular)" con los dos tramos resueltos y en verde. Se calcula
  // ahora, que es cuando la ruta ya esta montada. Los pares ya calculados se
  // saltan solos, asi que no cuesta nada.
  try {
    const { hechas, fallidas } = await calcularDistanciasDeLaRuta(viajeId);
    if (hechas || fallidas) {
      di(
        `Kilometros de la ruta: ${hechas} salto(s) calculado(s)` +
          (fallidas ? `, ${fallidas} sin dato.` : '.')
      );
    }
  } catch (err) {
    di(`No pude calcular los kilometros de la ruta (${err.message}).`);
  }

  avisarDeSaltosQueNoCuadran(viajeId, etapas, di);
  avisarDeLoQueCuestanLosSaltos(viaje, di);

  return { saltos: etapas.length - 1, resueltos };
}

/**
 * LO QUE CUESTAN DE VERDAD LOS SALTOS DE DENTRO, CUANDO YA SE SABE.
 *
 * EL FALLO QUE ORIGINA ESTO. Polonia salió con un vuelo de LOT de Cracovia a
 * Gdansk a 176 € por persona y el aviso de traslados internos no apareció por
 * ningún lado. No estaba sin implementar: `avisarDeTrasladosCaros` existe en la
 * fase 1 y funciona. Lo que pasa es que suma con el `modo` de la matriz de
 * tiempos de ESA fase, que para Cracovia → Gdansk dice tren —porque hay tren, y
 * lo hay— así que sumaba 0 €, no llegaba al umbral y no podía dispararse nunca.
 * El vuelo aparece después, aquí, cuando esta fase mira las opciones reales y
 * elige.
 *
 * Son dos avisos distintos y los dos hacen falta. El de la fase 1 es una
 * ESTIMACIÓN GRUESA por tipo de salto, y sirve para lo suyo: comparar puertas
 * antes de que exista ningún precio; se queda en el registro, que es donde se
 * lee mientras se decide la ruta. Este es el DEFINITIVO, con lo que cuesta el
 * billete elegido, y es el que va además a los avisos del viaje: al final tiene
 * que quedar el número real donde se ve sin abrir el registro.
 *
 * NO INVENTA EL QUE FALTA. Si un salto se quedó sin precio, no se estima: se
 * suma lo que hay y se dice cuántos faltan, que es distinto de decir que la ruta
 * cuesta eso. Y por eso también se avisa aunque falten precios: 176 € de uno
 * solo ya pasan el umbral, y que el otro no se sepa no lo hace más barato.
 *
 * Exportada para poder probarla contra un viaje real sin arrancar la fase
 * entera, que es la única forma de saber si el número que saca es el bueno.
 */
export function avisarDeLoQueCuestanLosSaltos(viaje, di) {
  const umbral = parametro('umbral_traslados_internos', 150);
  const personas = Math.max(1, (Number(viaje.adultos) || 0) + (Number(viaje.ninos) || 0));

  // SOLO LOS SALTOS DE DENTRO. Los vuelos de ida y vuelta tienen las dos puntas
  // fuera —una es casa— y ya se ven en el presupuesto por su cuenta.
  const saltos = todas(
    `SELECT t.id, t.tipo, t.precio_estimado, t.precio_ambito, t.notas,
            o.nombre_ciudad AS desde, d.nombre_ciudad AS hasta
       FROM transportes t
       JOIN etapas o ON o.id = t.etapa_origen_id
       JOIN etapas d ON d.id = t.etapa_destino_id
      WHERE t.viaje_id = ?
      ORDER BY t.id`,
    viaje.id
  );
  if (!saltos.length) return;

  let total = 0;
  let sinPrecio = 0;
  const detalle = [];

  for (const t of saltos) {
    const precio = Number(t.precio_estimado);
    if (!Number.isFinite(precio) || precio <= 0) {
      sinPrecio += 1;
      continue;
    }
    // El precio se guardó con su ámbito: un billete es de cada uno, un taxi es
    // del coche entero. El umbral está en euros POR PERSONA, así que se traduce.
    const porPersona = t.precio_ambito === POR_GRUPO ? precio / personas : precio;
    total += porPersona;
    detalle.push(
      `${t.desde} → ${t.hasta} ${Math.round(porPersona)} €` +
        (t.tipo === 'vuelo' ? ' en avión' : '')
    );
  }

  if (total < umbral) return;

  const redondo = Math.round(total);
  const cuerpo =
    `Los saltos de dentro del viaje suman unos ${redondo} € por persona: ` +
    `${detalle.join(', ')}.` +
    (sinPrecio
      ? ` Y ${sinPrecio} salto(s) más sin precio encontrado, así que puede ser más.`
      : '') +
    ' Son los precios de las opciones elegidas, no una estimación. Si te parece ' +
    'mucho, el sitio donde se cambia es la ruta: otra puerta de entrada o una ' +
    'ciudad menos se nota aquí más que en ninguna otra parte.';

  // AL VIAJE, Y BORRANDO EL DE LA ESTIMACIÓN. Mismo título para que una segunda
  // pasada actualice el aviso en vez de dejar dos con números distintos.
  const titulo = `Los traslados internos salen por unos ${redondo} € por persona`;
  ejecutar(
    "DELETE FROM avisos WHERE viaje_id = ? AND categoria = 'traslado' AND titulo LIKE '%traslados internos%'",
    viaje.id
  );
  ejecutar(
    `INSERT INTO avisos (viaje_id, categoria, severidad, titulo, texto)
     VALUES (?, 'traslado', 'aviso', ?, ?)`,
    viaje.id,
    titulo,
    cuerpo
  );

  di(`OJO con el bolsillo: ${cuerpo}`, ORIGENES.busqueda);
}

/**
 * ¿DICEN LO MISMO LOS KILÓMETROS DE LA RUTA Y EL TRASLADO QUE SE ELIGIÓ?
 *
 * EL FALLO QUE ORIGINA ESTO. En el viaje de Asia, dos saltos por carretera
 * aparecían en la ruta confirmada con el doble de kilómetros y de tiempo de los
 * reales, contradiciendo la duración puerta a puerta que esta misma fase había
 * medido y elegido. Nadie lo vio hasta que alguien miró el mapa y le extrañó.
 *
 * Son dos medidas del mismo trayecto por caminos distintos: una sale de las
 * coordenadas de las dos ciudades y Google Routes, la otra del horario real del
 * transporte elegido. Pueden y deben diferir un poco —un tren no va por la
 * carretera— pero no pueden ir al doble. Cuando lo hacen, casi siempre es que
 * una de las dos ciudades está mal situada.
 *
 * No se corrige nada: no hay forma de saber cuál de las dos miente sin mirarlo.
 * Se deja dicho, que es lo que faltaba.
 */
function avisarDeSaltosQueNoCuadran(viajeId, etapas, di) {
  const factor = Math.max(1.1, parametro('factor_discrepancia_traslado', 1.5));
  let raros = 0;

  for (let i = 0; i < etapas.length - 1; i += 1) {
    const a = etapas[i];
    const b = etapas[i + 1];
    if (!a.punto_interes_id || !b.punto_interes_id) continue;

    const ref = distanciaGuardada(a.punto_interes_id, b.punto_interes_id);
    const porCarretera = Number(ref?.minutos_coche);
    if (!Number.isFinite(porCarretera) || porCarretera <= 0) continue;

    // Lo que se eligió, con su puerta a puerta ya medido.
    const tramo = una(
      `SELECT duracion_min, tipo, notas FROM transportes
        WHERE viaje_id = ? AND etapa_origen_id = ? AND etapa_destino_id = ?`,
      viajeId,
      a.id,
      b.id
    );
    const elegido = Number(tramo?.duracion_min);
    if (!Number.isFinite(elegido) || elegido <= 0) continue;

    // COMPARAR UN FERRY CON UNA RUTA EN COCHE NO DICE NADA.
    //
    // «OJO en Heraclión → Santorini: la ruta del mapa dice 5h 48min en coche y el
    // traslado elegido 2h 55min». Entre dos islas no hay coche que valga: el
    // mapa está midiendo un rodeo por tierra que nadie va a hacer, y el aviso
    // —que existe para cazar ciudades mal situadas— se convierte en ruido que
    // enseña a ignorar los avisos.
    //
    // Solo tiene sentido cuando lo elegido va por carretera o por vía: ahí las
    // dos medidas hablan del mismo camino.
    const porTierra = /tren|bus|autob|coche|taxi|furgo|traslado/i.test(
      `${tramo.tipo ?? ''} ${tramo.notas ?? ''}`
    );
    if (!porTierra) continue;

    const veces = Math.max(porCarretera / elegido, elegido / porCarretera);
    if (veces < factor) continue;

    raros += 1;
    di(
      `OJO en ${a.nombre_ciudad} → ${b.nombre_ciudad}: la ruta del mapa dice ` +
        `${comoTexto(porCarretera)} en coche y el traslado elegido ${comoTexto(elegido)} ` +
        `puerta a puerta (${veces.toFixed(1)} veces). Suele ser que una de las dos ciudades ` +
        'está mal situada: mira sus coordenadas antes de fiarte de los kilómetros.',
      ORIGENES.ninguno
    );
  }

  if (raros) {
    apuntarHueco(
      viajeId,
      FASE,
      `${raros} salto(s) donde los kilómetros del mapa no cuadran con el traslado elegido.`
    );
  }
}

export default { ejecutarFaseTraslados, puertaAPuerta, aMinutos, aPrecio, comoTexto };
