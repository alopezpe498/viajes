/**
 * services/movilidad.js
 * -----------------------------------------------------------------------------
 * Cómo se va de una ciudad a otra, y cómo se mueve uno una vez allí.
 *
 * DOS COSAS QUE NO SON LA MISMA, y por eso son dos tablas:
 *
 *   A) El TRAMO entre dos ciudades. Hasta ahora el enlace del tramo llevaba
 *      siempre al buscador de vuelos, también en Sarajevo → Mostar, que se hace
 *      en bus por unos euros. Ahora cada pareja tiene sus medios.
 *   B) MOVERSE DENTRO. El metro, el bono de tres días, el teléfono del taxi. Eso
 *      no tenía sitio y acababa en una nota suelta.
 *
 * LAS DOS SON CATÁLOGO. Los buses entre Sarajevo y Mostar no dependen de mi
 * viaje: se consultan una vez y sirven para el siguiente. Por eso van por nombre
 * normalizado de ciudad y no por etapa: la etapa es de un viaje, la ciudad es del
 * mundo.
 *
 * LO ELEGIDO Y LO TECLEADO SÍ ES DEL VIAJE. Va en `transporte_datos`, una fila
 * por (tramo, ficha). Por ficha y no por tramo a propósito: así cambiar de idea
 * no borra lo que escribí de la anterior.
 *
 * SE PREGUNTA CON BÚSQUEDA WEB. Un horario o un precio de autobús cambian, y de
 * memoria un modelo se los inventa con toda la seguridad del mundo.
 */

import { todas, una, ejecutar, normalizarNombre } from '../db/index.js';
import { consultarJSONConGoogle } from '../lib/ia.js';
import { trabajoActivo, ultimoTrabajo, encolar } from '../jobs/cola.js';
import { direccionesDe } from './direcciones.js';

// =============================================================================
// LOS MEDIOS, Y SU CARA
// =============================================================================
/** Los medios que entendemos, con su icono. Lo que no encaje cae en 'otro'. */
export const MEDIOS = {
  bus: { etiqueta: 'Autobús', icono: 'ti-bus' },
  tren: { etiqueta: 'Tren', icono: 'ti-train' },
  ferry: { etiqueta: 'Ferry', icono: 'ti-ship' },
  coche: { etiqueta: 'Coche de alquiler', icono: 'ti-car' },
  traslado: { etiqueta: 'Traslado privado', icono: 'ti-car-suv' },
  avion: { etiqueta: 'Avión', icono: 'ti-plane' },
  otro: { etiqueta: 'Otro', icono: 'ti-arrow-right' },
};

/** Los tipos de movilidad urbana, con su icono. */
export const TIPOS_MOVILIDAD = {
  metro: { etiqueta: 'Metro', icono: 'ti-train-filled' },
  bus: { etiqueta: 'Bus urbano', icono: 'ti-bus' },
  taxi: { etiqueta: 'Taxi', icono: 'ti-car' },
  app: { etiqueta: 'App', icono: 'ti-device-mobile' },
  tarjeta: { etiqueta: 'Tarjeta turística', icono: 'ti-credit-card' },
  especial: { etiqueta: 'Especial', icono: 'ti-sparkles' },
  otro: { etiqueta: 'Otro', icono: 'ti-map-2' },
};

const medioValido = (m) => (Object.hasOwn(MEDIOS, m) ? m : 'otro');
const tipoValido = (t) => (Object.hasOwn(TIPOS_MOVILIDAD, t) ? t : 'otro');

/** El par de ciudades, siempre con el nombre normalizado menor delante. */
function parOrdenado(ciudadA, ciudadB) {
  const a = { nombre: ciudadA, norm: normalizarNombre(ciudadA) };
  const b = { nombre: ciudadB, norm: normalizarNombre(ciudadB) };
  return a.norm <= b.norm ? [a, b] : [b, a];
}

const texto = (v) => {
  const t = String(v ?? '').trim();
  return t || null;
};

// =============================================================================
// A) EL TRAMO ENTRE DOS CIUDADES
// =============================================================================
/** Las fichas guardadas de un par de ciudades. */
export function fichasDeTramo(ciudadA, ciudadB) {
  if (!ciudadA || !ciudadB) return [];
  const [a, b] = parOrdenado(ciudadA, ciudadB);

  return todas(
    `SELECT * FROM catalogo_transporte_tramo
      WHERE ciudad_a_norm = ? AND ciudad_b_norm = ?
      ORDER BY orden, id`,
    a.norm,
    b.norm
  ).map((f) => ({
    ...f,
    etiquetaMedio: MEDIOS[f.medio]?.etiqueta ?? MEDIOS.otro.etiqueta,
    icono: MEDIOS[f.medio]?.icono ?? MEDIOS.otro.icono,
  }));
}

/**
 * Guarda una ficha de tramo. Sirve para lo que trae la IA y para lo escrito a mano.
 *
 * NO REPITE LO QUE YA ESTÁ. Dos sitios pueden pedir investigar el mismo tramo a
 * la vez —el orquestador y el trabajo de la cola lo hicieron— y esto era un
 * INSERT a pelo: el resultado era el catálogo con cada tren, cada bus y cada
 * coche por duplicado, y una lista de ocho opciones que en realidad eran cuatro.
 *
 * La misma pareja de ciudades, el mismo medio y el mismo nombre es la misma
 * cosa. Se devuelve la que ya había en vez de crear otra.
 */
export function guardarFichaTramo(ciudadA, ciudadB, ficha, origen = 'ia') {
  const [a, b] = parOrdenado(ciudadA, ciudadB);

  const nombre = texto(ficha.nombre) ?? MEDIOS[medioValido(ficha.medio)].etiqueta;
  const yaEsta = una(
    `SELECT * FROM catalogo_transporte_tramo
      WHERE ciudad_a_norm = ? AND ciudad_b_norm = ? AND medio = ? AND lower(nombre) = lower(?)`,
    a.norm,
    b.norm,
    medioValido(ficha.medio),
    nombre
  );
  if (yaEsta) return yaEsta;

  const r = ejecutar(
    `INSERT INTO catalogo_transporte_tramo
       (ciudad_a_norm, ciudad_b_norm, ciudad_a, ciudad_b, medio, nombre,
        duracion, frecuencia, precio, nota, nota_sentido, web, orden, origen)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    a.norm,
    b.norm,
    a.nombre,
    b.nombre,
    medioValido(ficha.medio),
    texto(ficha.nombre) ?? MEDIOS[medioValido(ficha.medio)].etiqueta,
    texto(ficha.duracion),
    texto(ficha.frecuencia),
    texto(ficha.precio),
    texto(ficha.nota),
    texto(ficha.notaSentido),
    texto(ficha.web),
    Number(ficha.orden) || 0,
    origen
  );
  return una('SELECT * FROM catalogo_transporte_tramo WHERE id = ?', Number(r.lastInsertRowid));
}

export function actualizarFichaTramo(id, ficha) {
  ejecutar(
    `UPDATE catalogo_transporte_tramo
        SET medio = ?, nombre = ?, duracion = ?, frecuencia = ?, precio = ?,
            nota = ?, nota_sentido = ?, web = ?
      WHERE id = ?`,
    medioValido(ficha.medio),
    texto(ficha.nombre) ?? 'Sin nombre',
    texto(ficha.duracion),
    texto(ficha.frecuencia),
    texto(ficha.precio),
    texto(ficha.nota),
    texto(ficha.notaSentido),
    texto(ficha.web),
    Number(id)
  );
  return una('SELECT * FROM catalogo_transporte_tramo WHERE id = ?', Number(id));
}

export function borrarFichaTramo(id) {
  return ejecutar('DELETE FROM catalogo_transporte_tramo WHERE id = ?', Number(id)).changes > 0;
}

/**
 * Lo tecleado para un tramo, ficha a ficha.
 *
 * Es un mapa y no una fila porque cambiar de medio NO puede borrar lo que
 * escribí del anterior: si apunté el horario del tren y luego me decido por el
 * bus, el del tren sigue ahí cuando vuelva.
 */
export function datosDelTramo(transporteId) {
  const filas = todas('SELECT * FROM transporte_datos WHERE transporte_id = ?', Number(transporteId));
  return new Map(filas.map((f) => [f.ficha_id, f]));
}

/** Guarda (o crea) lo tecleado de una ficha en un tramo. */
export function guardarDatosDelTramo(transporteId, fichaId, datos) {
  ejecutar(
    `INSERT INTO transporte_datos (transporte_id, ficha_id, horario, precio_real, referencia, nota)
     VALUES (?, ?, ?, ?, ?, ?)
     ON CONFLICT (transporte_id, ficha_id) DO UPDATE SET
       horario = excluded.horario,
       precio_real = excluded.precio_real,
       referencia = excluded.referencia,
       nota = excluded.nota`,
    Number(transporteId),
    Number(fichaId),
    texto(datos.horario),
    texto(datos.precioReal),
    texto(datos.referencia),
    texto(datos.nota)
  );
  return una(
    'SELECT * FROM transporte_datos WHERE transporte_id = ? AND ficha_id = ?',
    Number(transporteId),
    Number(fichaId)
  );
}

/**
 * Elige (o suelta) el medio de un tramo.
 *
 * Elegir cambia también el `tipo` del tramo, que es lo que pinta su icono en la
 * ruta y en el lienzo: si voy en bus, el chip no puede seguir diciendo avión.
 */
export function elegirMedio(transporteId, fichaId) {
  const t = una('SELECT * FROM transportes WHERE id = ?', Number(transporteId));
  if (!t) return null;

  const soltar = !fichaId || Number(t.ficha_transporte_id) === Number(fichaId);
  if (soltar) {
    ejecutar('UPDATE transportes SET ficha_transporte_id = NULL WHERE id = ?', t.id);
    // `elegidaId` es lo que devuelve también `comoLlegarDeTramo`: la pantalla
    // repinta con el mismo campo venga de donde venga.
    return { elegido: false, transporteId: t.id, elegidaId: null };
  }

  const ficha = una('SELECT * FROM catalogo_transporte_tramo WHERE id = ?', Number(fichaId));
  if (!ficha) return null;

  // 'avion' no se guarda como tipo del tramo desde aquí: ese camino es el
  // buscador de vuelos, que ya pone lo suyo al elegir un vuelo concreto.
  const tipo = ficha.medio === 'avion' ? t.tipo : medioDelTramo(ficha.medio);

  ejecutar(
    'UPDATE transportes SET ficha_transporte_id = ?, tipo = ? WHERE id = ?',
    ficha.id,
    tipo,
    t.id
  );
  return { elegido: true, transporteId: t.id, elegidaId: ficha.id };
}

/** Los medios del catálogo, traducidos a los tipos que entiende `transportes`. */
function medioDelTramo(medio) {
  const equivalencias = { bus: 'bus', tren: 'tren', ferry: 'ferry', coche: 'coche', traslado: 'coche' };
  return equivalencias[medio] ?? 'coche';
}

/**
 * Todo lo que necesita la pestaña "Cómo llegar" de un tramo.
 *
 * El AVIÓN va SIEMPRE como una ficha más, aunque la IA no lo mencione: hay
 * tramos largos donde sí se vuela, y su ficha es la puerta al buscador de
 * Kayak que ya existe. No se guarda en el catálogo porque no es un dato sobre
 * el mundo, es un camino de esta aplicación.
 */
export function comoLlegarDeTramo(transporteId, ciudadA, ciudadB) {
  const t = una('SELECT * FROM transportes WHERE id = ?', Number(transporteId));
  if (!t) return null;

  const fichas = fichasDeTramo(ciudadA, ciudadB);
  const datos = datosDelTramo(t.id);

  const activo = trabajoActivo(t.viaje_id, 'transporte_tramo', t.id);
  const ultimo = ultimoTrabajo(t.viaje_id, 'transporte_tramo', t.id);

  const delCatalogo = fichas.map((f) => ({
    ...f,
    elegida: Number(t.ficha_transporte_id) === f.id,
    datos: datos.get(f.id) ?? null,
  }));

  // EL AVIÓN YA NO ES UNA FICHA DE ESTA LISTA.
  //
  // Lo fue, y era una capa de más: para buscar un vuelo había que abrir el
  // panel de medios, bajar hasta una tarjeta de avión que no tenía ni duración
  // ni precio, y pulsar ahí. Ahora "Buscar vuelo" está arriba, junto a "Buscar
  // cómo llegar" y "Añadir medio", que son las tres cosas que se pueden hacer
  // con un tramo.
  //
  // Esta lista se queda con lo que de verdad es catálogo: los medios por tierra
  // y mar de esa pareja de ciudades.
  return {
    transporteId: t.id,
    ciudadA,
    ciudadB,
    elegidaId: t.ficha_transporte_id ?? null,
    fichas: delCatalogo,
    buscando: Boolean(activo),
    mensajeError: !activo && !fichas.length && ultimo?.estado === 'error' ? ultimo.mensaje_error : null,
    consultada: Boolean(ultimo),
    // Sin contar el avión, que sale siempre: es lo que decide si la pantalla
    // dice "todavía no se ha mirado nada".
    delCatalogo: delCatalogo.length,
  };
}

/**
 * El medio elegido de un tramo, con lo tecleado debajo. Null si no hay ninguno.
 *
 * Lo usan la tarjeta del tramo y el dosier, que necesitan la misma frase.
 */
export function medioElegidoDeTramo(transporteId) {
  const t = una('SELECT * FROM transportes WHERE id = ?', Number(transporteId));
  if (!t?.ficha_transporte_id) return null;

  const f = una('SELECT * FROM catalogo_transporte_tramo WHERE id = ?', t.ficha_transporte_id);
  if (!f) return null;

  const d = una(
    'SELECT * FROM transporte_datos WHERE transporte_id = ? AND ficha_id = ?',
    t.id,
    f.id
  );

  return {
    ...f,
    etiquetaMedio: MEDIOS[f.medio]?.etiqueta ?? MEDIOS.otro.etiqueta,
    icono: MEDIOS[f.medio]?.icono ?? MEDIOS.otro.icono,
    horario: d?.horario ?? null,
    precioReal: d?.precio_real ?? null,
    referencia: d?.referencia ?? null,
    notaPropia: d?.nota ?? null,
  };
}

/** Pide a la IA los medios de un tramo, si no se ha pedido ya. */
export function pedirTransporteDeTramo(transporteId, { forzar = false } = {}) {
  const t = una('SELECT * FROM transportes WHERE id = ?', Number(transporteId));
  if (!t) return null;

  // Se pide siempre que no haya uno en marcha: esto lo lanza un botón, así que
  // si alguien lo pulsa es porque quiere preguntar otra vez. `forzar` está para
  // dejarlo explícito en quien llama.
  const activo = trabajoActivo(t.viaje_id, 'transporte_tramo', t.id);
  if (!activo) encolar(t.viaje_id, 'transporte_tramo', t.id);
  return { encolado: !activo, forzado: forzar };
}

// =============================================================================
// B) MOVERSE POR LA CIUDAD
// =============================================================================
/** Las fichas de movilidad de una ciudad. */
export function fichasDeMovilidad(ciudad) {
  if (!ciudad) return [];
  const filas = todas(
    'SELECT * FROM catalogo_movilidad WHERE ciudad_norm = ? ORDER BY orden, id',
    normalizarNombre(ciudad)
  );

  // La parada del funicular o la oficina de los taxis son sitios a los que se
  // va: tienen dirección, y por tanto pueden ser un extremo de un traslado.
  const direcciones = direccionesDe('movilidad', filas.map((f) => f.id));

  return filas.map((f) => ({
    ...f,
    etiquetaTipo: TIPOS_MOVILIDAD[f.tipo]?.etiqueta ?? TIPOS_MOVILIDAD.otro.etiqueta,
    icono: TIPOS_MOVILIDAD[f.tipo]?.icono ?? TIPOS_MOVILIDAD.otro.icono,
    // El teléfono, listo para el enlace: sin espacios ni guiones, que un tel:
    // con espacios no marca en algunos móviles.
    telefonoMarcable: f.telefono ? String(f.telefono).replace(/[^+\d]/g, '') : null,
    direccion: direcciones.get(f.id) ?? null,
  }));
}

/**
 * Guarda una ficha de transporte urbano. ACTUALIZA si ya estaba.
 *
 * Era un INSERT a secas, y por eso pulsar "Buscar otra vez" en Moverse metía
 * otra vez las mismas cinco fichas de metro y de taxi. Con el índice único por
 * (ciudad, nombre) la segunda búsqueda refresca lo que ya había en vez de
 * duplicarlo, que es lo que ya hacían las excursiones y los restaurantes.
 *
 * Lo que NO se pisa es el teléfono ni la web cuando vienen vacíos: si alguien
 * los escribió a mano, una búsqueda que no los trae no puede borrarlos.
 */
export function guardarFichaMovilidad(ciudad, ficha, origen = 'ia') {
  const r = ejecutar(
    `INSERT INTO catalogo_movilidad
       (ciudad_norm, ciudad, tipo, nombre, nombre_norm, descripcion, precio, telefono, web, nota, orden, origen)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT (ciudad_norm, nombre_norm) DO UPDATE SET
       tipo        = excluded.tipo,
       descripcion = COALESCE(excluded.descripcion, descripcion),
       precio      = COALESCE(excluded.precio, precio),
       telefono    = COALESCE(excluded.telefono, telefono),
       web         = COALESCE(excluded.web, web),
       nota        = COALESCE(excluded.nota, nota),
       orden       = excluded.orden`,
    normalizarNombre(ciudad),
    ciudad,
    tipoValido(ficha.tipo),
    texto(ficha.nombre) ?? 'Sin nombre',
    normalizarNombre(texto(ficha.nombre) ?? 'Sin nombre'),
    texto(ficha.descripcion),
    texto(ficha.precio),
    texto(ficha.telefono),
    texto(ficha.web),
    texto(ficha.nota),
    Number(ficha.orden) || 0,
    origen
  );
  // Con un upsert, `lastInsertRowid` no sirve cuando lo que ha habido es un
  // UPDATE: se busca por la clave, que es la que de verdad identifica la ficha.
  return una(
    'SELECT * FROM catalogo_movilidad WHERE ciudad_norm = ? AND nombre_norm = ?',
    normalizarNombre(ciudad),
    normalizarNombre(texto(ficha.nombre) ?? 'Sin nombre')
  ) ?? una('SELECT * FROM catalogo_movilidad WHERE id = ?', Number(r.lastInsertRowid));
}

export function actualizarFichaMovilidad(id, ficha) {
  ejecutar(
    `UPDATE catalogo_movilidad
        SET tipo = ?, nombre = ?, descripcion = ?, precio = ?, telefono = ?, web = ?, nota = ?
      WHERE id = ?`,
    tipoValido(ficha.tipo),
    texto(ficha.nombre) ?? 'Sin nombre',
    texto(ficha.descripcion),
    texto(ficha.precio),
    texto(ficha.telefono),
    texto(ficha.web),
    texto(ficha.nota),
    Number(id)
  );
  return una('SELECT * FROM catalogo_movilidad WHERE id = ?', Number(id));
}

export function borrarFichaMovilidad(id) {
  return ejecutar('DELETE FROM catalogo_movilidad WHERE id = ?', Number(id)).changes > 0;
}

/** El estado de la pestaña "Moverse" de una etapa. */
export function moverseDeEtapa(etapa) {
  const fichas = fichasDeMovilidad(etapa.nombre_ciudad);
  const activo = trabajoActivo(etapa.viaje_id, 'movilidad_ciudad', etapa.id);
  const ultimo = ultimoTrabajo(etapa.viaje_id, 'movilidad_ciudad', etapa.id);

  return {
    ciudad: etapa.nombre_ciudad,
    fichas,
    buscando: Boolean(activo),
    mensajeError: !activo && !fichas.length && ultimo?.estado === 'error' ? ultimo.mensaje_error : null,
    consultada: Boolean(ultimo),
  };
}

export function pedirMovilidadDeCiudad(etapaId) {
  const e = una('SELECT * FROM etapas WHERE id = ?', Number(etapaId));
  if (!e) return null;
  const activo = trabajoActivo(e.viaje_id, 'movilidad_ciudad', e.id);
  if (!activo) encolar(e.viaje_id, 'movilidad_ciudad', e.id);
  return { encolado: !activo };
}

// =============================================================================
// LO QUE SE LE PREGUNTA A LA IA
// =============================================================================
/**
 * El prompt del tramo.
 *
 * Se le pide EXPRESAMENTE que busque y que no invente: un horario o un precio
 * de autobús cambian, y un modelo sin buscar te los da igual de convencido.
 * Mejor un campo vacío que un dato falso con el que alguien pierda un bus.
 */
export function promptDeTramo(ciudadA, ciudadB) {
  return `Busca en la web cómo ir de ${ciudadA} a ${ciudadB} y devuelve los medios de transporte reales que existen hoy.

Un objeto por medio disponible: autobús, tren, ferry, coche de alquiler, traslado privado. NO incluyas el avión: eso lo lleva la aplicación por otro sitio.

Devuelve SOLO este JSON:
{"medios":[{
  "medio":"bus|tren|ferry|coche|traslado",
  "nombre":"nombre de la compañía o del servicio, corto",
  "duracion":"2 h 30",
  "frecuencia":"cada 2 h, 6 salidas al día",
  "precio":"8-12 €",
  "nota":"dónde se coge, si hay que reservar, qué conviene saber",
  "notaSentido":"solo si algún dato cambia según la dirección; si no, cadena vacía",
  "web":"url oficial si la hay, si no cadena vacía"
}]}

REGLAS:
- Si un dato no lo encuentras, deja la cadena VACÍA. NO te lo inventes: es peor un horario falso que un hueco.
- Entre 2 y 5 medios. Si de verdad solo hay uno, devuelve uno.
- Si entre esas dos ciudades no hay transporte terrestre razonable, devuelve {"medios":[]}.
- En español de España.`;
}

/** El prompt de moverse por una ciudad. */
export function promptDeMovilidad(ciudad) {
  return `Busca en la web cómo moverse por ${ciudad} y devuelve el transporte urbano real que hay hoy.

Devuelve SOLO este JSON:
{"opciones":[{
  "tipo":"metro|bus|taxi|app|tarjeta|especial",
  "nombre":"nombre corto",
  "descripcion":"qué es y para qué sirve, dos líneas",
  "precio":"precio del billete o del abono",
  "telefono":"teléfono con prefijo internacional, solo para taxis; si no, cadena vacía",
  "web":"url o nombre de la app; si no, cadena vacía",
  "nota":"lo práctico: dónde se compra, si vale la pena, horarios"
}]}

INCLUYE, si existen en esa ciudad:
- metro o tranvía, con las líneas útiles para un turista
- bus urbano, precio del billete y de los abonos
- tarjeta turística de transporte, si la hay
- taxis: compañías con TELÉFONO (esto es lo más útil de todo)
- apps tipo Uber, Bolt o la local, solo si operan de verdad allí
- lo peculiar del sitio: funicular, vaporetto, teleférico...

REGLAS:
- Si un dato no lo encuentras, cadena VACÍA. NO inventes teléfonos ni precios.
- Entre 3 y 8 opciones.
- En español de España.`;
}

/** Pregunta por un tramo. Devuelve las fichas ya guardadas en el catálogo. */
export async function investigarTramo(ciudadA, ciudadB) {
  // El contexto lo trae el Modo IA de Google, no la búsqueda web de la API: es
  // el mismo dato reciente y no se cobra por consulta.
  const datos = await consultarJSONConGoogle(
    `Cómo ir de ${ciudadA} a ${ciudadB}: tren, autobús, coche y ferry, con duración, precio y frecuencia`,
    promptDeTramo(ciudadA, ciudadB),
    { paso: `buscar cómo ir de ${ciudadA} a ${ciudadB}`, maxTokens: 4000 }
  );

  const medios = Array.isArray(datos?.medios) ? datos.medios : [];
  const guardadas = medios
    .filter((m) => texto(m?.nombre) || texto(m?.medio))
    .map((m, i) => guardarFichaTramo(ciudadA, ciudadB, { ...m, orden: i + 1 }, 'ia'));

  return guardadas;
}

/** Pregunta por una ciudad. Devuelve las fichas ya guardadas. */
export async function investigarMovilidad(ciudad) {
  const datos = await consultarJSONConGoogle(
    `Cómo moverse por ${ciudad}: metro, autobús, tranvía, abonos de transporte, tarjeta turística y teléfonos de taxi`,
    promptDeMovilidad(ciudad),
    { paso: `buscar cómo moverse por ${ciudad}`, maxTokens: 4000 }
  );

  const opciones = Array.isArray(datos?.opciones) ? datos.opciones : [];
  return opciones
    .filter((o) => texto(o?.nombre))
    .map((o, i) => guardarFichaMovilidad(ciudad, { ...o, orden: i + 1 }, 'ia'));
}
