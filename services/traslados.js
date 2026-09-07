/**
 * services/traslados.js
 * -----------------------------------------------------------------------------
 * "¿Cuánto hay de aquí a allá?"
 *
 * Es LA pregunta que más se repite planificando un día, y hasta ahora había que
 * salir a Google Maps, mirarla y volver sin que quedara constancia de nada. A la
 * media hora ya no te acuerdas de si eran 20 minutos o 40, y la vuelves a mirar.
 *
 * LO CONSULTADO SE GUARDA, Y NO SE BORRA SOLO. Un traslado apuntado es material
 * de investigación: que del hotel al centro haya 20 minutos andando sigue siendo
 * verdad aunque ese día se decida no ir, así que la lista cuelga de la ETAPA y
 * sobrevive a que la actividad salga del lienzo.
 *
 * DOS FUENTES, Y SE NOTA CUÁL CONTESTÓ
 *
 *   1. Google Routes: andando, coche y TRANSPORTE PÚBLICO. El público es lo que
 *      justifica la clave: OSRM no sabe de líneas de metro ni de horarios.
 *   2. OSRM + estimación: solo coche y andando.
 *
 * Y aquí hay una trampa que conviene tener escrita, porque cuesta media hora
 * descubrirla: el OSRM público IGNORA el perfil. Pedirle `/route/v1/foot/...`
 * devuelve exactamente los mismos números que `/driving/...` —1,7 km en 3
 * minutos, o sea 34 km/h andando—. Así que el tiempo a pie NO se le pregunta:
 * se estima aquí, a 4,5 km/h sobre la distancia en línea recta con un margen de
 * calles, y se marca como aproximado para no vender por dato lo que es un
 * cálculo de servilleta.
 */

import { todas, una, ejecutar } from '../db/index.js';
import { encolar, trabajoActivo } from '../jobs/cola.js';
import { rutasConGoogle, MODOS, googleDisponible } from '../lib/google.js';
import { distanciaKm, comoDuracion } from './distancias.js';
import { direccionDe, TIPOS_CON_DIRECCION } from './direcciones.js';

const URL_OSRM = 'https://router.project-osrm.org/route/v1/driving';
const TIMEOUT_MS = 8_000;
const PAUSA_MS = 400;
const AGENTE = 'CreadorViajes/1.0 (uso personal)';

/** A qué velocidad anda una persona por una ciudad, con sus semáforos. */
const KMH_ANDANDO = 4.5;

/**
 * Cuánto se alarga un trayecto a pie respecto a la línea recta.
 *
 * Las calles no van en diagonal. 1,3 es el factor que se usa habitualmente para
 * trama urbana y para lo que hace falta —saber si son 10 minutos o 40— sobra.
 */
const RODEO_CALLES = 1.3;

/** Más allá de esto, "andando" deja de ser una opción y es ruido en la ficha. */
const TOPE_ANDANDO_KM = 12;

let turno = Promise.resolve();
const dormir = (ms) => new Promise((r) => setTimeout(r, ms));

function esperarTurno() {
  turno = turno.then(() => dormir(PAUSA_MS));
  return turno;
}

const punto = (p) => p && Number.isFinite(Number(p.lat)) && Number.isFinite(Number(p.lng));

// =============================================================================
// EL CÁLCULO
// =============================================================================
/**
 * Cuánto hay de `a` a `b`, por los medios que se sepan.
 *
 * Devuelve `{ resultados: [{ modo, minutos, km, fuente }], fuente }`. `fuente`
 * es la general —de dónde salió lo que se enseña— y va al log y a la ficha,
 * porque mirando "12 min en coche" no hay forma de saber quién lo dijo.
 */
export async function calcularRutas(a, b) {
  if (!punto(a) || !punto(b)) {
    return { resultados: [], fuente: null, mensaje: 'Faltan las coordenadas de algún extremo.' };
  }

  // --- 1) Google, que es el único que sabe de transporte público -----------
  const deGoogle = await rutasConGoogle(a, b);
  if (deGoogle && deGoogle.length) {
    return { resultados: deGoogle, fuente: 'google' };
  }

  // --- 2) El plan B --------------------------------------------------------
  console.log(
    googleDisponible()
      ? '[traslados] Google no dio rutas: tiro de OSRM.'
      : '[traslados] Sin Google (clave restringida o ausente): OSRM y estimación.'
  );

  const resultados = [];

  const coche = await porCarretera(a, b);
  if (coche) resultados.push(coche);

  const andando = aPie(a, b);
  if (andando) resultados.push(andando);

  if (!resultados.length) {
    return {
      resultados: [],
      fuente: null,
      mensaje: 'No se ha podido calcular la ruta entre esos dos puntos.',
    };
  }

  // Andando delante: en ciudad es lo primero que uno mira.
  resultados.sort((x, y) => orden(x.modo) - orden(y.modo));
  return { resultados, fuente: 'osrm' };
}

const ORDEN_MODOS = ['andando', 'publico', 'coche'];
const orden = (m) => {
  const i = ORDEN_MODOS.indexOf(m);
  return i === -1 ? 99 : i;
};

/** OSRM, que solo sabe de coche por mucho que se le pida otra cosa. */
async function porCarretera(a, b) {
  const url = `${URL_OSRM}/${a.lng},${a.lat};${b.lng},${b.lat}?overview=false`;
  await esperarTurno();

  const control = new AbortController();
  const reloj = setTimeout(() => control.abort(), TIMEOUT_MS);
  try {
    const r = await fetch(url, {
      signal: control.signal,
      headers: { 'User-Agent': AGENTE, Accept: 'application/json' },
    });
    if (!r.ok) return null;

    const datos = await r.json();
    if (datos.code !== 'Ok' || !datos.routes?.length) return null;

    const ruta = datos.routes[0];
    return {
      modo: 'coche',
      minutos: Math.max(1, Math.round(ruta.duration / 60)),
      km: ruta.distance / 1000,
      fuente: 'osrm',
    };
  } catch {
    return null;
  } finally {
    clearTimeout(reloj);
  }
}

/**
 * El tiempo a pie, estimado.
 *
 * No se le pregunta a OSRM porque el servidor público contesta lo mismo para
 * `foot` que para `driving` —el coche—, y dar 3 minutos para 1,7 km andando
 * sería peor que no dar nada. Sale de la línea recta con margen de calles, y va
 * marcado como aproximado.
 */
function aPie(a, b) {
  // SIN REDONDEAR: `enLineaRecta` da kilómetros enteros, y del hotel al bar de
  // la esquina hay 0,3 — que redondeados son cero y daban "1 min" para un
  // paseo de seis.
  const recta = distanciaKm({ lat: a.lat, lon: a.lng }, { lat: b.lat, lon: b.lng });
  const km = recta * RODEO_CALLES;
  if (km > TOPE_ANDANDO_KM) return null;

  return {
    modo: 'andando',
    minutos: Math.max(1, Math.round((km / KMH_ANDANDO) * 60)),
    km,
    fuente: 'estimado',
  };
}

// =============================================================================
// GUARDAR Y LEER
// =============================================================================
/**
 * Apunta un traslado y encola su cálculo.
 *
 * Los extremos se guardan CONGELADOS: el texto y las coordenadas de ahora. Si
 * mañana borro la excursión o le cambio la dirección, esta consulta sigue
 * diciendo lo que decía cuando la hice, que es lo que se espera de una nota.
 */
export function crearTraslado(etapaId, origen, destino) {
  const etapa = una('SELECT * FROM etapas WHERE id = ?', Number(etapaId));
  if (!etapa) return null;

  const a = resolverExtremo(origen);
  const b = resolverExtremo(destino);
  if (!a || !b) return { error: 'Hay que decir de dónde y adónde.' };

  // A un ELEMENTO del viaje se le exige tener dirección, y si no la tiene se
  // dice cuál es y se ofrece ponérsela: es el aviso del punto 8. Al TEXTO LIBRE
  // no se le exige nada todavía —"aeropuerto de Sarajevo" no está en el viaje ni
  // tiene por qué—: se busca al calcular, en la cola.
  for (const [extremo, lado] of [[a, 'origen'], [b, 'destino']]) {
    if (!extremo.libre && !extremo.punto) {
      return { error: `Falta la dirección de «${extremo.texto}».`, falta: { ...extremo, lado } };
    }
  }

  // El mismo traslado dos veces no aporta nada: se devuelve el que ya hay.
  const repetido = una(
    `SELECT * FROM traslados
      WHERE etapa_id = ? AND origen_texto = ? AND destino_texto = ?`,
    etapa.id,
    a.texto,
    b.texto
  );
  if (repetido) {
    pedirCalculo(repetido.id);
    return { traslado: conCara(repetido), repetido: true };
  }

  const r = ejecutar(
    `INSERT INTO traslados
       (viaje_id, etapa_id,
        origen_texto, origen_tipo, origen_id, origen_lat, origen_lng,
        destino_texto, destino_tipo, destino_id, destino_lat, destino_lng)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    etapa.viaje_id,
    etapa.id,
    a.texto,
    a.tipo,
    a.id,
    // Un extremo TECLEADO llega todavía sin coordenadas: las busca el worker
    // antes de calcular y las congela aquí. Un elemento del viaje ya las trae.
    a.punto?.lat ?? null,
    a.punto?.lng ?? null,
    b.texto,
    b.tipo,
    b.id,
    b.punto?.lat ?? null,
    b.punto?.lng ?? null
  );

  const id = Number(r.lastInsertRowid);
  pedirCalculo(id);
  return { traslado: conCara(una('SELECT * FROM traslados WHERE id = ?', id)) };
}

/**
 * Un extremo del traslado, venga de donde venga.
 *
 * Dos formas, y las dos hacen falta:
 *
 *   { tipo, id }   Un elemento del viaje: el hotel, un sitio apuntado. Coge su
 *                  dirección del almacén, así que si mañana se corrige, al
 *                  recalcular sale la buena.
 *   { texto }      Cualquier cosa tecleada: el aeropuerto, una calle. No está en
 *                  el viaje y no tiene por qué estarlo.
 *
 * El texto libre se geocodifica AL VUELO y no se guarda como dirección de nada:
 * no es de ningún elemento. Se congela en la propia fila del traslado.
 */
function resolverExtremo(extremo) {
  if (!extremo) return null;

  // a) Un elemento del viaje.
  if (extremo.tipo && extremo.id && Object.hasOwn(TIPOS_CON_DIRECCION, extremo.tipo)) {
    const d = direccionDe(extremo.tipo, Number(extremo.id));
    const nombre = nombreDelElemento(extremo.tipo, Number(extremo.id));
    return {
      tipo: extremo.tipo,
      id: Number(extremo.id),
      texto: String(extremo.texto ?? nombre ?? d?.direccion ?? '').trim() || 'Sin nombre',
      punto: d?.situada ? d.punto : null,
      direccion: d?.direccion ?? null,
    };
  }

  // b) Texto libre. Se resuelve al calcular, no ahora: geocodificar es lento y
  //    esto se llama desde una petición que tiene que contestar ya.
  const t = String(extremo.texto ?? '').trim();
  if (!t) return null;
  return {
    tipo: null,
    id: null,
    texto: t.slice(0, 200),
    // Sin punto todavía: lo pone el worker antes de calcular.
    punto: extremo.punto ?? null,
    direccion: t,
    libre: true,
  };
}

/** Cómo se llama el elemento, para que la línea del traslado se lea. */
function nombreDelElemento(tipo, id) {
  const def = TIPOS_CON_DIRECCION[tipo];
  if (!def) return null;
  const fila = una(`SELECT ${def.campoNombre} AS nombre FROM ${def.tabla} WHERE id = ?`, id);
  return fila?.nombre ?? null;
}

/** Encola el cálculo de un traslado, si no hay ya uno en marcha. */
export function pedirCalculo(trasladoId) {
  const t = una('SELECT * FROM traslados WHERE id = ?', Number(trasladoId));
  if (!t) return null;
  if (trabajoActivo(t.viaje_id, 'traslado', t.id)) return { encolado: false };

  ejecutar("UPDATE traslados SET estado = 'calculando', mensaje = NULL WHERE id = ?", t.id);
  encolar(t.viaje_id, 'traslado', t.id);
  return { encolado: true };
}

/** Hace el cálculo de verdad. Lo llama el worker. */
export async function calcularTraslado(trasladoId) {
  const t = una('SELECT * FROM traslados WHERE id = ?', Number(trasladoId));
  if (!t) return null;

  // Un extremo tecleado a mano llega sin coordenadas: se buscan ahora, una vez,
  // y se congelan en la fila para no volver a preguntarlas al recalcular.
  const ciudad = una('SELECT nombre_ciudad FROM etapas WHERE id = ?', t.etapa_id)?.nombre_ciudad;
  const a = await asegurarPunto(t, 'origen', ciudad);
  const b = await asegurarPunto(t, 'destino', ciudad);

  if (!a || !b) {
    const cual = !a ? t.origen_texto : t.destino_texto;
    ejecutar(
      `UPDATE traslados SET estado = 'error', mensaje = ?, calculado_en = datetime('now')
        WHERE id = ?`,
      `No se ha encontrado «${cual}». Prueba a escribirlo con más detalle.`,
      t.id
    );
    return conCara(una('SELECT * FROM traslados WHERE id = ?', t.id));
  }

  const { resultados, fuente, mensaje } = await calcularRutas(a, b);

  ejecutar(
    `UPDATE traslados
        SET resultados = ?, fuente = ?, estado = ?, mensaje = ?, calculado_en = datetime('now')
      WHERE id = ?`,
    JSON.stringify(resultados),
    fuente,
    resultados.length ? 'ok' : 'error',
    mensaje ?? null,
    t.id
  );

  console.log(
    `[traslados] ${t.origen_texto} → ${t.destino_texto}: ` +
      (resultados.length
        ? `${resultados.map((x) => `${x.modo} ${x.minutos} min`).join(' · ')} (${fuente})`
        : `sin resultado — ${mensaje}`)
  );
  return conCara(una('SELECT * FROM traslados WHERE id = ?', t.id));
}

/** Si a un extremo le faltan las coordenadas, se buscan y se guardan. */
async function asegurarPunto(t, lado, ciudad) {
  const lat = t[`${lado}_lat`];
  const lng = t[`${lado}_lng`];
  if (lat != null && lng != null) return { lat, lng };

  // Import perezoso: geocodificar tiene su propio turno de 1 req/s y no hace
  // falta cargarlo para leer una lista de traslados.
  const { geocodificarDireccion } = await import('./geocodificar.js');
  const { geocodificarConGoogle } = await import('../lib/google.js');

  const texto = t[`${lado}_texto`];
  let hallado = null;
  try {
    hallado = await geocodificarConGoogle(texto, { cerca: ciudad });
  } catch { /* al plan B */ }
  if (!hallado) {
    try {
      hallado = await geocodificarDireccion(texto, { cerca: ciudad });
    } catch { /* nada que hacer */ }
  }
  if (!hallado) return null;

  ejecutar(
    `UPDATE traslados SET ${lado}_lat = ?, ${lado}_lng = ? WHERE id = ?`,
    hallado.lat,
    hallado.lng,
    t.id
  );
  return { lat: hallado.lat, lng: hallado.lng };
}

// =============================================================================
// LA LISTA DE LA ETAPA
// =============================================================================
/** Los traslados consultados de una parada, los más nuevos arriba. */
export function trasladosDeEtapa(etapaId) {
  const etapa = una('SELECT * FROM etapas WHERE id = ?', Number(etapaId));
  if (!etapa) return { traslados: [], calculando: false };

  const filas = todas(
    'SELECT * FROM traslados WHERE etapa_id = ? ORDER BY id DESC',
    etapa.id
  ).map(conCara);

  return {
    traslados: filas.map((t) => ({
      ...t,
      calculando: t.estado === 'calculando' || Boolean(trabajoActivo(etapa.viaje_id, 'traslado', t.id)),
    })),
    calculando: filas.some(
      (t) => t.estado === 'calculando' || trabajoActivo(etapa.viaje_id, 'traslado', t.id)
    ),
  };
}

/**
 * La fila, con la línea ya escrita.
 *
 * "Hotel → Free tour centro: 20 min andando · 8 min coche · 12 min metro" es
 * UNA línea, y se arma aquí para que la pinten igual la etapa y el dosier.
 */
function conCara(t) {
  let resultados = [];
  try {
    resultados = t.resultados ? (JSON.parse(t.resultados) ?? []) : [];
  } catch {
    resultados = [];
  }

  return {
    id: t.id,
    viajeId: t.viaje_id,
    etapaId: t.etapa_id,
    origen: { texto: t.origen_texto, tipo: t.origen_tipo, id: t.origen_id },
    destino: { texto: t.destino_texto, tipo: t.destino_tipo, id: t.destino_id },
    resultados: resultados.map((r) => ({
      ...r,
      etiqueta: MODOS[r.modo]?.etiqueta ?? r.modo,
      icono: MODOS[r.modo]?.icono ?? 'ti-arrow-right',
      // "20 min", "1 h 10". Y el ~ cuando es una estimación nuestra, que se
      // dice porque una cosa es un dato y otra un cálculo de servilleta.
      texto: (r.fuente === 'estimado' ? '~' : '') + comoDuracion(r.minutos),
    })),
    estado: t.estado,
    fuente: t.fuente,
    mensaje: t.mensaje,
    calculadoEn: t.calculado_en,
    recorrido: `${t.origen_texto} → ${t.destino_texto}`,
  };
}

/**
 * Los traslados que tocan a un elemento concreto, mirados DESDE él.
 *
 * Es la sección "Distancias" de una ficha, y NO necesita tabla propia: un
 * traslado ya guarda de qué elemento sale cada extremo, así que preguntar
 * "¿cuáles tocan al Museo del Prado?" es una consulta, no un modelo nuevo.
 *
 * Se devuelven SIEMPRE en el sentido "desde esta ficha hacia el otro", aunque
 * la consulta se hiciera al revés: en la ficha del restaurante uno quiere leer
 * "Al hotel: 12 min", no "Del hotel: 12 min". El tiempo es el mismo en los dos
 * sentidos para lo que aquí se usa, así que darle la vuelta es solo cambiar
 * cómo se lee.
 */
export function trasladosDeElemento(tipo, elementoId) {
  const id = Number(elementoId);
  if (!tipo || !id) return [];

  return todas(
    `SELECT * FROM traslados
      WHERE (origen_tipo = ? AND origen_id = ?) OR (destino_tipo = ? AND destino_id = ?)
      ORDER BY id DESC`,
    tipo,
    id,
    tipo,
    id
  ).map((t) => {
    const salgoDeAqui = t.origen_tipo === tipo && Number(t.origen_id) === id;
    const ficha = conCara(t);
    return {
      ...ficha,
      // El otro extremo: lo que de verdad se quiere leer en la línea.
      otro: salgoDeAqui ? ficha.destino.texto : ficha.origen.texto,
      // "Al hotel: 12 min andando · 5 min coche"
      linea: `${salgoDeAqui ? 'A' : 'Desde'} ${salgoDeAqui ? ficha.destino.texto : ficha.origen.texto}`,
    };
  });
}

/** Las distancias de un montón de fichas del mismo tipo, de una vez. */
export function trasladosDeElementos(tipo, ids) {
  const lista = [...new Set((ids ?? []).map(Number).filter(Boolean))];
  if (!tipo || !lista.length) return new Map();

  const marcas = lista.map(() => '?').join(',');
  const filas = todas(
    `SELECT * FROM traslados
      WHERE (origen_tipo = ? AND origen_id IN (${marcas}))
         OR (destino_tipo = ? AND destino_id IN (${marcas}))
      ORDER BY id DESC`,
    tipo,
    ...lista,
    tipo,
    ...lista
  );

  const porElemento = new Map(lista.map((id) => [id, []]));
  for (const t of filas) {
    const ficha = conCara(t);
    for (const [lado, contrario] of [['origen', 'destino'], ['destino', 'origen']]) {
      if (t[`${lado}_tipo`] !== tipo) continue;
      const id = Number(t[`${lado}_id`]);
      if (!porElemento.has(id)) continue;
      porElemento.get(id).push({
        ...ficha,
        otro: ficha[contrario].texto,
        linea: `${lado === 'origen' ? 'A' : 'Desde'} ${ficha[contrario].texto}`,
      });
    }
  }
  return porElemento;
}

export function borrarTraslado(id) {
  const t = una('SELECT * FROM traslados WHERE id = ?', Number(id));
  if (!t) return false;
  ejecutar('DELETE FROM traslados WHERE id = ?', t.id);
  return true;
}

/**
 * Recalcular: se vuelve a preguntar, pero desde la dirección de AHORA.
 *
 * Si el extremo salió de un elemento del viaje y su dirección se ha corregido,
 * se cogen las nuevas coordenadas. Ese es justo el caso en el que uno pulsa
 * recalcular: "puse mal la calle del hotel, vuelve a mirarlo".
 */
export function recalcularTraslado(id) {
  const t = una('SELECT * FROM traslados WHERE id = ?', Number(id));
  if (!t) return null;

  for (const lado of ['origen', 'destino']) {
    const tipo = t[`${lado}_tipo`];
    const elementoId = t[`${lado}_id`];
    if (tipo && elementoId) {
      const d = direccionDe(tipo, elementoId);
      if (d?.situada) {
        ejecutar(
          `UPDATE traslados SET ${lado}_lat = ?, ${lado}_lng = ? WHERE id = ?`,
          d.punto.lat,
          d.punto.lng,
          t.id
        );
      }
    } else {
      // Texto libre: se olvida el punto para que se vuelva a buscar.
      ejecutar(`UPDATE traslados SET ${lado}_lat = NULL, ${lado}_lng = NULL WHERE id = ?`, t.id);
    }
  }

  pedirCalculo(t.id);
  return conCara(una('SELECT * FROM traslados WHERE id = ?', t.id));
}

/** Un traslado suelto, para las pantallas que lo piden por id. */
export function trasladoPorId(id) {
  const t = una('SELECT * FROM traslados WHERE id = ?', Number(id));
  return t ? conCara(t) : null;
}
