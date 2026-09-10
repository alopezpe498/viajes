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
import { anotar, apuntarHueco, parametro, configAuto, ORIGENES } from '../services/orquestador.js';
import { calcularDistanciasDeLaRuta } from '../services/distancias-ciudades.js';

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
  const m = String(texto ?? '').match(/(\d+(?:[.,]\d+)?)/);
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
export function puertaAPuerta(modo, minutosTrayecto, params) {
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

  const total = acceso + antelacion + (minutosTrayecto ?? 0) + salida;
  return { acceso, antelacion, trayecto: minutosTrayecto ?? 0, salida, total };
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
      precio: aPrecio(f.precio),
      horario: f.frecuencia || null,
      nota: f.nota || null,
    }))
    // Sin duración no se puede comparar puerta a puerta, y adivinarla sería
    // inventarse el dato que decide.
    .filter((o) => o.trayecto);
}

/**
 * Los vuelos internos, y solo cuando tienen alguna posibilidad.
 *
 * Se buscan si la fase 1 estimó que ese salto se hace en avión, o si por tierra
 * se va por encima de cinco horas. En un salto de dos horas en tren, abrir el
 * navegador para mirar vuelos es tiempo tirado: el avión no puede ganar.
 */
async function opcionesEnAvion({ viaje, ciudadA, ciudadB, mejorTierra, loDijoLaFase1, auto }) {
  const mereceLaPena = loDijoLaFase1 || !mejorTierra || mejorTierra > TIERRA_LARGA_MIN;
  if (!mereceLaPena) return { opciones: [], porQue: 'por tierra se llega en menos de cinco horas' };

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
            nombre: `${v.aerolinea ?? 'Vuelo'} ${iataA}→${iataB}`,
            trayecto: aMinutos(t.duracion),
            precio: v.precio ?? null,
            horario: t.horaSalida ?? null,
            nota: t.escalas ? `${t.escalas} escala(s)` : 'directo',
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
      horario: horaSalida,
      precioReal: opcion.precio != null ? String(opcion.precio) : null,
      referencia: null,
      nota: porQue,
    });
  } else {
    const v = opcion.vuelo;
    const t = (v.tramos ?? [])[0] ?? {};
    const r = ejecutar(
      `INSERT INTO candidatos
         (viaje_id, transporte_id, tipo, titulo, precio, moneda, origen_datos, marcado, datos_extra)
       VALUES (?, ?, 'vuelo', ?, ?, ?, 'kayak', 1, ?)`,
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
  ejecutar(
    'UPDATE transportes SET datos_extra = ?, notas = ?, duracion_min = ?, precio_estimado = ? WHERE id = ?',
    JSON.stringify({ ...previo, bloque, elegidoPor: 'orquestador', porQue }),
    `${opcion.nombre}${horaSalida ? ` · sale ${horaSalida}` : ''}`,
    bloque.total,
    opcion.precio ?? null,
    tramo.id
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
  const loEstimoEnAvion = (a, b) =>
    estimados.some(
      (t) =>
        t.modo === 'vuelo' &&
        ((t.desde === a && t.hasta === b) || (t.desde === b && t.hasta === a))
    );

  di(`${etapas.length} paradas: ${etapas.length - 1} salto(s) que resolver.`);

  let resueltos = 0;

  for (let i = 0; i < etapas.length - 1; i += 1) {
    const desde = etapas[i];
    const hasta = etapas[i + 1];
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

    const mejorTierra = porTierra.length ? Math.min(...porTierra.map((o) => o.trayecto)) : null;
    const aire = await opcionesEnAvion({
      viaje,
      ciudadA: desde.nombre_ciudad,
      ciudadB: hasta.nombre_ciudad,
      mejorTierra,
      loDijoLaFase1: loEstimoEnAvion(desde.nombre_ciudad, hasta.nombre_ciudad),
      auto,
    });
    if (aire.porQue) di(`   Sin mirar vuelos: ${aire.porQue}.`);

    const opciones = [...porTierra, ...aire.opciones];

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
    const medidas = opciones.map((o, n) => {
      const bloque = puertaAPuerta(o.modo, o.trayecto, params);
      return { ...o, id: `op${n + 1}`, bloque };
    });
    medidas.sort((a, b) => a.bloque.total - b.bloque.total);

    // Duraciones y precios salen del catálogo de tramos, que se llenó con el
    // Modo IA de Google. Lo que pone el código encima son los márgenes de
    // acceso, que son constantes nuestras, no un dato del mundo.
    di(
      `   ${medidas.length} opción(es): ` +
        medidas
          .map((o) => `${o.nombre} [${comoTexto(o.bloque.total)} puerta a puerta${o.precio != null ? `, ${o.precio} €` : ''}]`)
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
            `  precio: ${o.precio != null ? `${o.precio} €` : 'no lo sé'}` +
            `${o.horario ? `\n  horarios: ${o.horario}` : ''}` +
            `${o.nota ? `\n  nota: ${o.nota}` : ''}`
        )
        .join('\n'),
      REGLA_DEL_EMPATE: reglaDelEmpate ?? 'No se cumple: gana la más rápida puerta a puerta.',
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

    guardarEleccion(tramo, eleccion.opcion, eleccion.hora, eleccion.opcion.bloque, eleccion.porQue);
    resueltos += 1;

    di(
      `${desde.nombre_ciudad} → ${hasta.nombre_ciudad}: ${eleccion.opcion.nombre}` +
        `${eleccion.hora ? ` de ${eleccion.hora}` : ''}, ` +
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

  return { saltos: etapas.length - 1, resueltos };
}

export default { ejecutarFaseTraslados, puertaAPuerta, aMinutos, aPrecio, comoTexto };
