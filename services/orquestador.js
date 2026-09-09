/**
 * services/orquestador.js
 * -----------------------------------------------------------------------------
 * EL MODO AUTOMÁTICO: montar el viaje entero sin que nadie tenga que ir pantalla
 * por pantalla.
 *
 * Lo que hace es lo mismo que harías tú a mano —elegir ciudades, repartir
 * noches, mirar traslados, buscar hotel, apuntar sitios y colocarlos en el
 * lienzo—, pero seguido y en segundo plano. Y lo hace LLAMANDO A LAS MISMAS
 * FUNCIONES que usa el flujo manual: aquí no se reimplementa nada. Si el
 * buscador de hoteles cambia, el orquestador hereda el cambio.
 *
 * DE MOMENTO ESTO ES UN ESQUELETO. Las seis fases están declaradas, se ejecutan
 * en orden, registran su estado y su log, y no deciden nada: cada una espera un
 * par de segundos y anota que está pendiente de implementar. Se rellenarán una a
 * una. Lo que ya es de verdad es la estructura: el orden, los estados, el log,
 * la tabla de parámetros y la de prompts.
 *
 * TRES REGLAS QUE VALEN DESDE HOY Y NO SE NEGOCIAN DESPUÉS:
 *
 *   1. UNA FASE QUE FALLA NO PARA EL VIAJE. Si no encuentra hotel en Split, deja
 *      el hueco escrito y sigue con lo siguiente. Un viaje con seis huecos es
 *      algo que se puede repasar; un viaje que se quedó en la fase dos no es
 *      nada. Solo un error de programación corta la cadena.
 *
 *   2. LO QUE HAS TOCADO A MANO NO SE PISA. Las entidades llevan ya su
 *      `tocado_a_mano`; ninguna fase debe sobrescribir lo que lo tenga puesto.
 *
 *   3. LOS PROMPTS SE LEEN DE LA TABLA, SIEMPRE. Nunca de una constante de este
 *      archivo. Si el prompt vive en dos sitios, el que se edita no es el que se
 *      usa, y eso se descubre tarde y mal.
 */
import { todas, una, ejecutar } from '../db/index.js';
import { encolar, trabajoActivo, ultimoTrabajo } from '../jobs/cola.js';

/**
 * LAS SEIS FASES, EN ORDEN.
 *
 * El orden no es una preferencia: es una dependencia. No se puede buscar hotel
 * en una ciudad que todavía no se ha elegido, ni colocar en el lienzo lo que no
 * se ha apuntado. Esta lista es la única fuente del orden; la pantalla de
 * progreso y el worker leen de aquí.
 */
export const FASES = [
  {
    clave: 'ciudades_y_noches',
    etiqueta: 'Ciudades y noches',
    icono: 'ti-map-2',
    explica: 'Qué ciudades entran, cuántas noches en cada una y por dónde se entra y se sale.',
  },
  {
    clave: 'traslados',
    etiqueta: 'Traslados',
    icono: 'ti-arrow-right-circle',
    explica: 'Cómo se va de cada ciudad a la siguiente.',
  },
  {
    clave: 'dormir',
    etiqueta: 'Dónde dormir',
    icono: 'ti-bed',
    explica: 'Un alojamiento en cada parada, con los filtros que has puesto.',
  },
  {
    clave: 'sitios',
    etiqueta: 'Qué ver',
    icono: 'ti-map-pin',
    explica: 'Los sitios de cada parada, apuntados según tus intereses.',
  },
  {
    clave: 'excursiones',
    etiqueta: 'Excursiones',
    icono: 'ti-ticket',
    explica: 'Las excursiones que merecen la pena, repartidas sin amontonarlas.',
  },
  {
    clave: 'lienzo',
    etiqueta: 'El lienzo',
    icono: 'ti-calendar',
    explica: 'Todo colocado en sus días, respetando horarios y días de cierre.',
  },
];

/** Los estados por los que pasa una fase. */
export const ESTADOS = ['pendiente', 'en_curso', 'hecho', 'con_huecos', 'error'];

/** Cómo se dice cada estado en pantalla. */
export const NOMBRE_DE_ESTADO = {
  pendiente: 'Pendiente',
  en_curso: 'En marcha',
  hecho: 'Hecho',
  con_huecos: 'Hecho, con huecos',
  error: 'No se pudo',
};

// =============================================================================
// LA CONFIGURACIÓN DEL MODO AUTOMÁTICO
// =============================================================================
/**
 * LO QUE HAY QUE TENER DECIDIDO ANTES DE EMPEZAR.
 *
 * El orquestador trabaja solo y en segundo plano, así que no puede pararse a
 * preguntar. Todo lo que en el flujo manual decides sobre la marcha —en qué
 * barrio, con desayuno o sin él, directo o con escala— tiene que estar dicho
 * antes de arrancar.
 *
 * SON LOS MISMOS FILTROS QUE YA EXISTEN en el buscador de alojamiento y en el de
 * vuelos, solo que preguntados antes en vez de después. No se inventa un modelo
 * nuevo: se adelanta el que hay, para que las fases puedan traducirlo a los
 * filtros de siempre sin convertir nada.
 *
 * EL PRECIO SE PREGUNTA POR NIVEL Y NO POR CIFRA. «Económico» significa cosas
 * distintas en Oporto y en Zúrich, y una cifra en euros escrita en la
 * configuración obligaría a acertarla ciudad por ciudad. El nivel lo traduce
 * cada fase con lo que ve en el mercado de esa parada.
 */
export const OPCIONES_AUTO = {
  nivelPrecio: [
    { valor: 'economico', etiqueta: 'Económico' },
    { valor: 'medio', etiqueta: 'Medio' },
    { valor: 'alto', etiqueta: 'Alto' },
  ],
  zona: [
    { valor: 'centrico', etiqueta: 'Céntrico' },
    { valor: 'indiferente', etiqueta: 'Me da igual' },
  ],
  tipoAlojamiento: [
    { valor: 'hotel', etiqueta: 'Hotel' },
    { valor: 'apartamento', etiqueta: 'Apartamento' },
    { valor: 'indiferente', etiqueta: 'Me da igual' },
  ],
  notaMinima: [
    { valor: '7', etiqueta: '7 o más' },
    { valor: '8', etiqueta: '8 o más' },
    { valor: '9', etiqueta: '9 o más' },
  ],
  escalas: [
    { valor: 'directos', etiqueta: 'Solo directos' },
    { valor: 'max1', etiqueta: 'Una escala como mucho' },
    { valor: 'indiferente', etiqueta: 'Me da igual' },
  ],
  franja: [
    { valor: 'manana', etiqueta: 'Por la mañana' },
    { valor: 'tarde', etiqueta: 'Por la tarde' },
    { valor: 'noche', etiqueta: 'Por la noche' },
    { valor: 'indiferente', etiqueta: 'Me da igual' },
  ],
  siNo: [
    { valor: 'si', etiqueta: 'Sí' },
    { valor: 'no', etiqueta: 'No' },
  ],
};

/** A partir de cuántos viajeros tiene sentido preguntar por habitación familiar. */
export const VIAJEROS_PARA_FAMILIAR = 3;

/** La configuración automática de un viaje, o los huecos vacíos si no la tiene. */
export function configAuto(viaje) {
  let g = {};
  try {
    g = viaje?.config_auto ? JSON.parse(viaje.config_auto) : {};
  } catch {
    g = {}; // JSON corrupto: se pregunta de nuevo en vez de reventar
  }

  const deLaLista = (lista, v) =>
    OPCIONES_AUTO[lista].some((o) => o.valor === v) ? v : null;

  return {
    // --- Alojamiento ---
    nivelPrecio: deLaLista('nivelPrecio', g.nivelPrecio),
    zona: deLaLista('zona', g.zona),
    tipoAlojamiento: deLaLista('tipoAlojamiento', g.tipoAlojamiento),
    habitacionFamiliar: g.habitacionFamiliar === 'si' ? 'si' : g.habitacionFamiliar === 'no' ? 'no' : null,
    desayuno: g.desayuno === 'si' ? 'si' : g.desayuno === 'no' ? 'no' : null,
    cancelacionGratis: g.cancelacionGratis === 'si' ? 'si' : g.cancelacionGratis === 'no' ? 'no' : null,
    notaMinima: deLaLista('notaMinima', g.notaMinima),
    // --- Vuelos ---
    escalas: deLaLista('escalas', g.escalas),
    franjaIda: deLaLista('franja', g.franjaIda),
    franjaVuelta: deLaLista('franja', g.franjaVuelta),
    // --- Intereses ---
    intereses: typeof g.intereses === 'string' ? g.intereses.slice(0, 300) : '',
    categorias: Array.isArray(g.categorias) ? g.categorias.filter((c) => typeof c === 'string') : [],
  };
}

/**
 * Valida y limpia lo que llega del formulario.
 *
 * Con el check activado TODO es obligatorio, que es lo que se pidió: el
 * orquestador no puede preguntar a mitad de camino, así que un campo sin
 * responder sería una decisión que acabaría tomando él por su cuenta y en
 * silencio. Se devuelve el primer campo que falta para poder señalarlo.
 *
 * La habitación familiar es la única condicional: con dos viajeros no se
 * pregunta, y por tanto tampoco se exige.
 */
export function validarConfigAuto(body, { viajeros = 2, categoriasValidas = [] } = {}) {
  const dame = (k) => String(body?.[k] ?? '').trim();
  const enLista = (lista, v) => OPCIONES_AUTO[lista].some((o) => o.valor === v);

  const pide = (v, lista) => (v && enLista(lista, v) ? v : null);

  const limpia = {
    nivelPrecio: pide(dame('auto_nivel_precio'), 'nivelPrecio'),
    zona: pide(dame('auto_zona'), 'zona'),
    tipoAlojamiento: pide(dame('auto_tipo_alojamiento'), 'tipoAlojamiento'),
    habitacionFamiliar: pide(dame('auto_habitacion_familiar'), 'siNo'),
    desayuno: pide(dame('auto_desayuno'), 'siNo'),
    cancelacionGratis: pide(dame('auto_cancelacion'), 'siNo'),
    notaMinima: pide(dame('auto_nota_minima'), 'notaMinima'),
    escalas: pide(dame('auto_escalas'), 'escalas'),
    franjaIda: pide(dame('auto_franja_ida'), 'franja'),
    franjaVuelta: pide(dame('auto_franja_vuelta'), 'franja'),
    intereses: dame('auto_intereses').slice(0, 300),
    categorias: (Array.isArray(body?.auto_categorias)
      ? body.auto_categorias
      : body?.auto_categorias
        ? [body.auto_categorias]
        : []
    ).filter((c) => categoriasValidas.includes(c)),
  };

  // Qué falta, en el orden en que se ve en pantalla: quien lo lea tiene que
  // poder bajar hasta el campo sin buscarlo.
  const OBLIGATORIOS = [
    ['nivelPrecio', 'el nivel de precio del alojamiento'],
    ['zona', 'la zona del alojamiento'],
    ['tipoAlojamiento', 'el tipo de alojamiento'],
    ...(viajeros >= VIAJEROS_PARA_FAMILIAR
      ? [['habitacionFamiliar', 'si hace falta habitación familiar']]
      : []),
    ['desayuno', 'si quieres desayuno incluido'],
    ['cancelacionGratis', 'si quieres cancelación gratuita'],
    ['notaMinima', 'la valoración mínima'],
    ['escalas', 'si quieres vuelos directos'],
    ['franjaIda', 'la franja horaria de la ida'],
    ['franjaVuelta', 'la franja horaria de la vuelta'],
  ];

  for (const [campo, comoSeLlama] of OBLIGATORIOS) {
    if (!limpia[campo]) {
      return { error: `Para el viaje automático me falta ${comoSeLlama}.`, campo, limpia };
    }
  }

  if (!limpia.intereses && !limpia.categorias.length) {
    return {
      error: 'Dime qué os interesa: escríbelo o marca alguna categoría.',
      campo: 'intereses',
      limpia,
    };
  }

  // Con menos de tres viajeros la pregunta ni se hace: se guarda "no" para que
  // la fase de dormir no tenga que distinguir "no hace falta" de "sin contestar".
  if (viajeros < VIAJEROS_PARA_FAMILIAR) limpia.habitacionFamiliar = 'no';

  return { limpia };
}

// =============================================================================
// CÓMO SE ORGANIZA LA PANTALLA DE AJUSTES
// =============================================================================
/**
 * A QUÉ FASE PERTENECE CADA PARÁMETRO.
 *
 * Los parámetros y los prompts vivían en dos pantallas distintas, y para
 * entender qué hace una fase había que mirar en las dos y juntarlas mentalmente.
 * Ahora van juntos, sección por sección, en el mismo orden en que se ejecutan.
 *
 * ESTE REPARTO ES SOLO DE INTERFAZ. Las tablas no saben nada de él: un parámetro
 * sigue siendo una fila con su clave, y quien lo lee lo pide por su nombre. Si
 * mañana una fase deja de usar uno, se cambia esta lista y ya está.
 *
 * LO QUE USA MÁS DE UNA FASE VA A «GENERAL». Las antelaciones de aeropuerto las
 * necesitan los traslados para calcular puerta a puerta y el lienzo para dejar
 * el hueco del viaje; el umbral de empate lo usan la elección de puerta de la
 * fase 1 y la de traslados de la 2. Colgarlos de una sola fase sería mentir
 * sobre dónde surten efecto.
 */
export const FASE_DE_PARAMETRO = {
  antelacion_vuelo_internacional_min: 'general',
  antelacion_vuelo_europeo_min: 'general',
  antelacion_tren_min: 'general',
  // Lo usan la fase 1 (por qué puerta se entra) y la 2 (qué traslado se coge).
  umbral_empate_traslado_min: 'general',
  // Vale para el orquestador y para las fichas de sitios fuera de él.
  dias_caducidad_datos_sitios: 'general',

  minimo_noches_por_ciudad: 'ciudades_y_noches',
  max_ciudades_candidatas: 'ciudades_y_noches',

  factor_precio_traslado: 'traslados',

  max_excursiones_largas_por_dia: 'excursiones',
  max_excursiones_por_viaje: 'excursiones',

  duracion_comida_min: 'lienzo',
};

/** La sección que no es de ninguna fase, y por eso va primera. */
const GENERAL = {
  clave: 'general',
  etiqueta: 'General',
  icono: 'ti-settings',
  explica: 'Lo que usan varias fases a la vez, o lo que vale también fuera del orquestador.',
};

/**
 * LA PANTALLA ENTERA, sección por sección.
 *
 * Una sección por fase, en el orden en que se ejecutan, más «General» delante.
 * Cada una lleva sus parámetros y su prompt: es la misma información que había
 * en dos pantallas, puesta donde se entiende.
 *
 * «General» no tiene prompt porque no es una fase: no se le pide nada a la IA
 * en general, se le pide en cada paso.
 */
export function seccionesDelOrquestador() {
  const todosLosParametros = parametros();
  const todosLosPrompts = new Map(prompts().map((p) => [p.fase, p]));

  const deLaSeccion = (clave) =>
    todosLosParametros.filter((p) => (FASE_DE_PARAMETRO[p.clave] ?? 'general') === clave);

  return [GENERAL, ...FASES].map((s) => {
    const clave = s.clave;
    return {
      clave,
      etiqueta: s.etiqueta,
      icono: s.icono,
      explica: s.explica,
      parametros: deLaSeccion(clave),
      prompt: todosLosPrompts.get(clave) ?? null,
    };
  });
}

// =============================================================================
// LOS PARÁMETROS
// =============================================================================
/**
 * Todos los parámetros, para la pantalla de ajustes.
 *
 * Se devuelve el valor y el de fábrica juntos: la pantalla necesita los dos para
 * poder decir «esto lo has cambiado tú» y ofrecer el botón de restaurar.
 */
export function parametros() {
  return todas('SELECT * FROM parametros_orquestador ORDER BY orden, clave').map((p) => ({
    ...p,
    // Los valores se guardan como texto porque la tabla es genérica, pero todos
    // los de hoy son números y quien los use los quiere como números.
    numero: Number(p.valor),
    esDeFabrica: p.valor === p.valor_fabrica,
  }));
}

/**
 * Un parámetro, ya como número. Es lo que usarán las fases.
 *
 * Si la clave no existe —un typo, un parámetro que se quitó— devuelve el
 * respaldo que le pasen en vez de `undefined`: una fase no puede quedarse a
 * medias porque falte una fila de configuración.
 */
export function parametro(clave, respaldo = null) {
  const p = una('SELECT valor FROM parametros_orquestador WHERE clave = ?', clave);
  if (!p) {
    console.warn(`[orquestador] No existe el parámetro «${clave}»; uso ${respaldo}.`);
    return respaldo;
  }
  const n = Number(p.valor);
  return Number.isFinite(n) ? n : respaldo;
}

/** Guarda un parámetro. Devuelve la fila ya actualizada, o null si no existe. */
export function guardarParametro(clave, valor) {
  const p = una('SELECT * FROM parametros_orquestador WHERE clave = ?', clave);
  if (!p) return null;

  const n = Number(valor);
  if (!Number.isFinite(n) || n < 0) return { error: 'Tiene que ser un número igual o mayor que cero.' };

  ejecutar('UPDATE parametros_orquestador SET valor = ? WHERE clave = ?', String(n), clave);
  return una('SELECT * FROM parametros_orquestador WHERE clave = ?', clave);
}

/** Devuelve un parámetro a su valor de fábrica. */
export function restaurarParametro(clave) {
  ejecutar(
    'UPDATE parametros_orquestador SET valor = valor_fabrica WHERE clave = ?',
    clave
  );
  return una('SELECT * FROM parametros_orquestador WHERE clave = ?', clave);
}

// =============================================================================
// LOS PROMPTS
// =============================================================================
/** Todos los prompts, en el orden de las fases, para la pantalla del cerebro. */
export function prompts() {
  const filas = new Map(
    todas('SELECT * FROM prompts_orquestador').map((p) => [p.fase, p])
  );
  return FASES.map((f) => {
    const p = filas.get(f.clave);
    return {
      fase: f.clave,
      etiqueta: f.etiqueta,
      icono: f.icono,
      explica: f.explica,
      texto: p?.prompt_actual ?? '',
      fabrica: p?.prompt_fabrica ?? '',
      actualizadoEn: p?.actualizado_en ?? null,
      esDeFabrica: !p || p.prompt_actual === p.prompt_fabrica,
    };
  });
}

/**
 * EL PROMPT DE UNA FASE, leído de la tabla. Lo llama el worker.
 *
 * Nunca hay una versión en código a la que caer: si la fila no está, es un fallo
 * de instalación y hay que verlo, no taparlo con un prompt de emergencia que
 * nadie sabría que se está usando.
 */
export function promptDeFase(fase) {
  const p = una('SELECT prompt_actual FROM prompts_orquestador WHERE fase = ?', fase);
  if (!p) throw new Error(`No hay prompt guardado para la fase «${fase}».`);
  return p.prompt_actual;
}

/** Guarda el prompt de una fase. */
export function guardarPrompt(fase, texto) {
  const limpio = String(texto ?? '').trim();
  if (!limpio) return { error: 'El prompt no puede quedarse vacío.' };

  const p = una('SELECT fase FROM prompts_orquestador WHERE fase = ?', fase);
  if (!p) return { error: 'Esa fase no existe.' };

  ejecutar(
    "UPDATE prompts_orquestador SET prompt_actual = ?, actualizado_en = datetime('now') WHERE fase = ?",
    limpio,
    fase
  );
  return una('SELECT * FROM prompts_orquestador WHERE fase = ?', fase);
}

/** Devuelve el prompt de una fase a como venía de fábrica. */
export function restaurarPrompt(fase) {
  ejecutar(
    `UPDATE prompts_orquestador
        SET prompt_actual = prompt_fabrica, actualizado_en = datetime('now')
      WHERE fase = ?`,
    fase
  );
  return una('SELECT * FROM prompts_orquestador WHERE fase = ?', fase);
}

// =============================================================================
// EL PROGRESO DE UN VIAJE
// =============================================================================
/**
 * En qué punto va el orquestador de este viaje.
 *
 * Devuelve SIEMPRE las seis fases, existan o no sus filas: la pantalla tiene que
 * poder pintar la lista completa desde el primer segundo, con las que aún no han
 * empezado en «pendiente». Una lista que crece sola mientras miras no deja ver
 * lo que falta.
 */
export function progresoDeViaje(viajeId) {
  const filas = new Map(
    todas('SELECT * FROM orquestador_fases WHERE viaje_id = ?', viajeId).map((f) => [f.fase, f])
  );

  const fases = FASES.map((f, i) => {
    const fila = filas.get(f.clave);
    const estado = fila?.estado ?? 'pendiente';
    return {
      ...f,
      orden: i + 1,
      estado,
      nombreEstado: NOMBRE_DE_ESTADO[estado] ?? estado,
      log: fila?.log ?? null,
      huecos: fila?.huecos ? fila.huecos.split('\n').filter(Boolean) : [],
      empezadoEn: fila?.empezado_en ?? null,
      terminadoEn: fila?.terminado_en ?? null,
      trabajando: estado === 'en_curso',
      // "Resuelta" es cualquier cosa que ya no va a cambiar sola, con hueco o sin
      // él. Es lo que cuenta la barra de progreso.
      resuelta: ['hecho', 'con_huecos', 'error'].includes(estado),
    };
  });

  const activo = Boolean(trabajoActivo(viajeId, 'orquestador', viajeId));
  const ultimo = ultimoTrabajo(viajeId, 'orquestador', viajeId);
  const resueltas = fases.filter((f) => f.resuelta).length;

  return {
    fases,
    // ¿Se ha lanzado alguna vez? Sin esto la pantalla no distingue "no empezado"
    // de "terminado hace un rato".
    empezado: Boolean(ultimo) || fases.some((f) => f.estado !== 'pendiente'),
    trabajando: activo,
    terminado: !activo && resueltas === fases.length,
    resueltas,
    total: fases.length,
    porcentaje: Math.round((resueltas / fases.length) * 100),
    // Los huecos de todas las fases, juntos, que es como se leen: "qué me ha
    // quedado a medias en este viaje".
    huecos: fases.flatMap((f) => f.huecos.map((h) => ({ fase: f.etiqueta, texto: h }))),
    mensajeError: !activo && ultimo?.estado === 'error' ? ultimo.mensaje_error : null,
  };
}

// =============================================================================
// LANZAR
// =============================================================================
/**
 * Pone el viaje a montarse.
 *
 * Deja las seis fases en «pendiente» y encola el trabajo. Volver a lanzarlo
 * REINICIA las fases: si alguien le da otra vez es porque quiere que se rehaga,
 * y arrancar con la mitad en «hecho» de la vuelta anterior enseñaría un progreso
 * que no es el de ahora.
 */
export function lanzarOrquestador(viajeId) {
  if (trabajoActivo(viajeId, 'orquestador', viajeId)) {
    return { yaEstaba: true, viajeId };
  }

  ejecutar('DELETE FROM orquestador_fases WHERE viaje_id = ?', viajeId);
  const meter = FASES.map((f, i) =>
    ejecutar(
      'INSERT INTO orquestador_fases (viaje_id, fase, orden, estado) VALUES (?, ?, ?, ?)',
      viajeId,
      f.clave,
      i + 1,
      'pendiente'
    )
  );

  encolar(viajeId, 'orquestador', viajeId);
  return { viajeId, fases: meter.length };
}

// =============================================================================
// ESCRIBIR EL PROGRESO. Lo usa el worker.
// =============================================================================
/** Marca una fase como empezada y limpia lo que hubiera de una vuelta anterior. */
export function empezarFase(viajeId, fase) {
  ejecutar(
    `UPDATE orquestador_fases
        SET estado = 'en_curso', log = NULL, huecos = NULL,
            empezado_en = datetime('now'), terminado_en = NULL
      WHERE viaje_id = ? AND fase = ?`,
    viajeId,
    fase
  );
}

/**
 * Añade una línea al log de una fase.
 *
 * Se acumula en vez de sustituir: el log es lo que se lee después para entender
 * por qué el viaje quedó como quedó, y para eso hace falta el rastro entero, no
 * la última frase.
 */
export function anotar(viajeId, fase, linea) {
  const texto = String(linea ?? '').trim();
  if (!texto) return;
  ejecutar(
    `UPDATE orquestador_fases
        SET log = CASE WHEN log IS NULL OR log = '' THEN ? ELSE log || char(10) || ? END
      WHERE viaje_id = ? AND fase = ?`,
    texto,
    texto,
    viajeId,
    fase
  );
  console.log(`[orquestador] viaje ${viajeId} · ${fase}: ${texto}`);
}

/**
 * Apunta un hueco: algo que esta fase no ha conseguido.
 *
 * Un hueco NO es un error. Es la forma correcta de terminar cuando falta un
 * dato: se anota, se sigue, y al final el usuario tiene una lista de lo que hay
 * que repasar a mano.
 */
export function apuntarHueco(viajeId, fase, texto) {
  const linea = String(texto ?? '').trim();
  if (!linea) return;
  ejecutar(
    `UPDATE orquestador_fases
        SET huecos = CASE WHEN huecos IS NULL OR huecos = '' THEN ? ELSE huecos || char(10) || ? END
      WHERE viaje_id = ? AND fase = ?`,
    linea,
    linea,
    viajeId,
    fase
  );
}

/**
 * Cierra una fase.
 *
 * El estado lo decide ella misma salvo que tenga huecos: con huecos se cierra en
 * «con_huecos» aunque diga que ha terminado bien, porque enseñar «Hecho» en algo
 * que dejó tres ciudades sin hotel sería mentir en la única pantalla que el
 * usuario va a mirar.
 */
export function cerrarFase(viajeId, fase, estado = 'hecho') {
  const fila = una(
    'SELECT huecos FROM orquestador_fases WHERE viaje_id = ? AND fase = ?',
    viajeId,
    fase
  );
  const conHuecos = Boolean(fila?.huecos?.trim());
  const final = estado === 'error' ? 'error' : conHuecos ? 'con_huecos' : estado;

  ejecutar(
    `UPDATE orquestador_fases
        SET estado = ?, terminado_en = datetime('now')
      WHERE viaje_id = ? AND fase = ?`,
    final,
    viajeId,
    fase
  );
  return final;
}

export default {
  FASES,
  FASE_DE_PARAMETRO,
  seccionesDelOrquestador,
  OPCIONES_AUTO,
  VIAJEROS_PARA_FAMILIAR,
  configAuto,
  validarConfigAuto,
  ESTADOS,
  NOMBRE_DE_ESTADO,
  parametros,
  parametro,
  guardarParametro,
  restaurarParametro,
  prompts,
  promptDeFase,
  guardarPrompt,
  restaurarPrompt,
  progresoDeViaje,
  lanzarOrquestador,
  empezarFase,
  anotar,
  apuntarHueco,
  cerrarFase,
};
