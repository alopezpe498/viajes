/**
 * services/busquedas-sitios.js
 * -----------------------------------------------------------------------------
 * LO QUE EL USUARIO SE BUSCA POR SU CUENTA, en la pestaña «Mis búsquedas».
 *
 * Las otras tres pestañas las llena la aplicación: pregunta a la IA qué hay que
 * ver y reparte. Esta la llena el usuario escribiendo, y por eso es la única que
 * empieza vacía.
 *
 * DOS FORMAS DE ESCRIBIR Y LA IA DECIDE CUÁL ES:
 *
 *   · «Búnker de la calle Pallars» es UN SITIO. Se genera su ficha y punto.
 *   · «búnkers de Berlín» es UN TEMA. No se puede hacer una ficha de un tema,
 *     así que primero se proponen hasta seis con una línea cada uno y el usuario
 *     marca los que quiere. Solo de esos se hacen fichas.
 *
 * Distinguirlo a ojo desde el código —contar palabras, buscar plurales— es una
 * heurística que falla con «Sagrada Familia» y con «museos del Prado». Lo decide
 * la IA en la misma llamada en la que ya está leyendo el texto, que le sale
 * gratis y acierta.
 *
 * LO QUE SE GENERA AQUÍ ES UNA FICHA COMPLETA, igual que las de los otros
 * bloques: descripción de la IA, foto y enlace de Wikipedia, y los datos duros
 * de una búsqueda de Google propia. Va al catálogo con su fecha y su fuente.
 *
 * NO SE DUPLICA NADA. Si lo que se pide ya está en «Imprescindibles», se avisa y
 * no se vuelve a generar: sale más barato mirar la tabla que repetir el trabajo,
 * y ver la misma tarjeta dos veces en dos pestañas confunde.
 */
import { db, todas, una, ejecutar, normalizarNombre } from '../db/index.js';
import { encolar, trabajoActivo } from '../jobs/cola.js';
import { consultarJSON, hayClaveIA, SIN_CLAVE } from '../lib/ia.js';
import { CATEGORIAS_SITIO, NOMBRE_DE_BLOQUE, ponerFotosDeWikipedia } from './descubrir.js';

/** Cuántos nombres se proponen como mucho para un tema. */
const MAXIMO_PROPUESTAS = 6;

/** Lo que se le deja escribir. Ni vacío ni una novela. */
const LARGO_MAXIMO = 120;

// =============================================================================
// LEER
// =============================================================================
/** Las propuestas viajan como JSON; una fila corrupta no puede tumbar la pantalla. */
function propuestasDe(fila) {
  if (!fila?.propuestas) return [];
  try {
    const lista = JSON.parse(fila.propuestas);
    return Array.isArray(lista) ? lista : [];
  } catch {
    return [];
  }
}

/**
 * Todo lo de la pestaña «Mis búsquedas» de una etapa.
 *
 * Devuelve las búsquedas de más nueva a más vieja, cada una con sus fichas ya
 * colgando. Las fichas se piden de una vez y se reparten en memoria, que es lo
 * mismo que hace la pestaña de sitios: una consulta por búsqueda serían diez
 * consultas para pintar una pestaña.
 */
export function busquedasDeEtapa(etapa) {
  const filas = todas(
    'SELECT * FROM busquedas_sitios WHERE etapa_id = ? ORDER BY id DESC',
    etapa.id
  );

  return {
    busquedas: filas.map((f) => ({
      id: f.id,
      texto: f.texto,
      tipo: f.tipo,
      estado: f.estado,
      propuestas: propuestasDe(f),
      fichas: f.fichas,
      mensajeError: f.mensaje_error,
      nota: f.nota ?? null,
      creadoEn: f.creado_en,
      // Una búsqueda «esperando» es la única que pide algo al usuario: hay que
      // poder distinguirla para pintarle sus casillas.
      esperando: f.estado === 'esperando',
      trabajando: f.estado === 'pendiente' || f.estado === 'proponiendo' || f.estado === 'generando',
    })),
    // ¿Hay alguna en marcha? Lo necesita el sondeo de la pantalla para saber si
    // tiene que seguir mirando.
    trabajando: filas.some((f) =>
      ['pendiente', 'proponiendo', 'generando'].includes(f.estado)
    ),
  };
}

// =============================================================================
// PEDIR
// =============================================================================
/**
 * Apunta una búsqueda nueva y la encola.
 *
 * Devuelve la fila creada, o un error con motivo si el texto no vale. Lo que no
 * hace es trabajar: aquí solo se toma nota y se vuelve, que quien escribe está
 * esperando una respuesta de la pantalla.
 */
export function pedirBusqueda(viaje, etapa, textoCrudo) {
  const texto = String(textoCrudo ?? '').trim().slice(0, LARGO_MAXIMO);
  if (!texto) return { error: 'Escribe qué quieres buscar.' };

  // La misma búsqueda dos veces seguidas es casi siempre un doble clic.
  const repetida = una(
    `SELECT id FROM busquedas_sitios
      WHERE etapa_id = ? AND lower(texto) = lower(?) AND estado <> 'error'`,
    etapa.id,
    texto
  );
  if (repetida) return { error: 'Eso ya lo has buscado; lo tienes más abajo.', id: repetida.id };

  const r = ejecutar(
    'INSERT INTO busquedas_sitios (viaje_id, etapa_id, texto) VALUES (?, ?, ?)',
    viaje.id,
    etapa.id,
    texto
  );
  const id = Number(r.lastInsertRowid);
  encolar(viaje.id, 'busqueda_sitios', id);
  return { id, texto };
}

/**
 * El usuario ha marcado cuáles de las propuestas quiere. Se encolan esas.
 *
 * Los nombres se validan contra lo que se propuso: lo que llegue de fuera de esa
 * lista se ignora, para que nadie pueda colar una ficha por la puerta de atrás.
 */
export function elegirPropuestas(busquedaId, nombres) {
  const fila = una('SELECT * FROM busquedas_sitios WHERE id = ?', busquedaId);
  if (!fila) return { error: 'Esa búsqueda ya no existe.' };
  if (fila.estado !== 'esperando') return { error: 'Esa búsqueda ya no está esperando.' };

  const propuestas = propuestasDe(fila);
  const validos = new Set(propuestas.map((p) => normalizarNombre(p.nombre)));
  const elegidos = (Array.isArray(nombres) ? nombres : [])
    .map((n) => String(n ?? '').trim())
    .filter((n) => validos.has(normalizarNombre(n)));

  if (!elegidos.length) return { error: 'No has marcado ninguno.' };

  // Se guarda la elección EN las propuestas y se vuelve a encolar. El worker
  // sabrá que esta vuelta ya no toca proponer, sino generar.
  ejecutar(
    "UPDATE busquedas_sitios SET propuestas = ?, estado = 'generando' WHERE id = ?",
    JSON.stringify(
      propuestas.map((p) => ({
        ...p,
        elegido: elegidos.some((e) => normalizarNombre(e) === normalizarNombre(p.nombre)),
      }))
    ),
    busquedaId
  );
  encolar(fila.viaje_id, 'busqueda_sitios', busquedaId);
  return { id: busquedaId, elegidos: elegidos.length };
}

/** Borrar una búsqueda no borra sus fichas: ya son catálogo. */
export function borrarBusqueda(busquedaId) {
  ejecutar('DELETE FROM busquedas_sitios WHERE id = ?', busquedaId);
  return true;
}

/** ¿Está esta búsqueda en la cola ahora mismo? */
export function busquedaActiva(viajeId, busquedaId) {
  return Boolean(trabajoActivo(viajeId, 'busqueda_sitios', busquedaId));
}

// =============================================================================
// LOS PROMPTS
// =============================================================================
/**
 * La primera llamada: qué me han pedido, y si es un sitio, su ficha ya hecha.
 *
 * Se piden las dos cosas juntas —la clasificación y el contenido— porque si es
 * un sitio concreto, esperar a una segunda llamada para pedir lo mismo que ya
 * podría haber contestado es medio minuto tirado. Cuando es un tema, la parte
 * de la ficha viene vacía y no estorba.
 */
function promptDeBusqueda(ciudad, texto) {
  return `Un viajero que está preparando su visita a ${ciudad} ha escrito esto en un buscador de sitios:

"${texto}"

Primero decide QUÉ TE HA PEDIDO:

- "concreto": un lugar identificable y único, del que se puede hacer una ficha.
  Ejemplos: "Sagrada Familia", "el búnker del Carmel", "mercado de San Miguel".
- "generico": un tema, una categoría o un plural del que salen varios lugares.
  Ejemplos: "búnkers de Berlín", "museos de arte moderno", "miradores".

Si es CONCRETO, devuelve la ficha del sitio en "sitio" y deja "propuestas" vacío.
Si es GENERICO, devuelve hasta ${MAXIMO_PROPUESTAS} lugares en "propuestas", con una sola
frase cada uno, y deja "sitio" a null. No hagas la ficha completa de ninguno todavía.

Devuelve SOLO este JSON:

{
  "tipo": "concreto" | "generico",
  "sitio": {
    "nombre": "nombre en español del lugar",
    "descripcion": "3-4 frases. Qué es, y CONSEJO PRÁCTICO: a qué hora ir, qué no perderse, cuánto tiempo hace falta.",
    "categoria": "una sola de esta lista, copiada tal cual: ${CATEGORIAS_SITIO.join(' | ')}",
    "lat": número, "lon": número,
    "titulo_wikipedia": "título EXACTO del artículo en la Wikipedia en español",
    "titulo_wikipedia_local": "título EXACTO del mismo artículo en la Wikipedia del idioma del país (vacío si dudas)",
    "idioma_wikipedia_local": "código de ese idioma: pl, it, ja, de…"
  },
  "propuestas": [
    { "nombre": "nombre del lugar", "descripcion": "una sola frase, qué es y por qué está en la lista" }
  ]
}

Reglas:
- Lugares CONCRETOS y REALES que se pueden visitar en ${ciudad} o cerca. Si lo que
  te piden no existe ahí, devuelve "propuestas" vacío y "sitio" a null: es una
  respuesta correcta, y es mejor que inventarse algo.
- "categoria" tiene que ser UNA de las de la lista, escrita igual.
- lat y lon son las coordenadas reales del sitio.
- No inventes URLs: las busco yo aparte.`;
}

/** La segunda llamada: las fichas de los que el usuario marcó. */
function promptDeFichas(ciudad, nombres) {
  return `Eres un guía de viajes con experiencia real en ${ciudad}.

Hazme la ficha de cada uno de estos lugares:
${nombres.map((n) => `- ${n}`).join('\n')}

Devuelve SOLO este JSON:

{
  "sitios": [
    {
      "nombre": "el nombre tal y como te lo he escrito",
      "descripcion": "3-4 frases. Qué es, y CONSEJO PRÁCTICO: a qué hora ir, qué no perderse, cuánto tiempo hace falta.",
      "categoria": "una sola de esta lista, copiada tal cual: ${CATEGORIAS_SITIO.join(' | ')}",
      "lat": número, "lon": número,
      "titulo_wikipedia": "título EXACTO del artículo en la Wikipedia en español",
      "titulo_wikipedia_local": "título EXACTO del mismo artículo en la Wikipedia del idioma del país (vacío si dudas)",
      "idioma_wikipedia_local": "código de ese idioma: pl, it, ja, de…"
    }
  ]
}

Reglas:
- Devuelve el nombre EXACTAMENTE como te lo he escrito: es la clave para casarlo.
- "categoria" tiene que ser UNA de las de la lista, escrita igual.
- lat y lon son las coordenadas reales del sitio.
- No inventes URLs: las busco yo aparte.`;
}

// =============================================================================
// EJECUTAR. Lo llama el worker.
// =============================================================================
/** La categoría solo vale si es una de las de la lista cerrada. */
function categoriaValida(v) {
  const t = String(v ?? '').trim().toLowerCase();
  return CATEGORIAS_SITIO.includes(t) ? t : null;
}

const textoONulo = (v) => {
  const t = typeof v === 'string' ? v.trim() : '';
  return t || null;
};

const numeroONulo = (v) => (typeof v === 'number' && Number.isFinite(v) ? v : null);

/**
 * ¿Está ya este sitio en la etapa, en cualquier bloque?
 *
 * Es la regla de no duplicar. Se mira por nombre normalizado contra el catálogo
 * del punto, que es donde viven las cuatro pestañas.
 */
function yaExiste(puntoId, nombre) {
  return una(
    'SELECT id, nombre, bloque FROM sitios_lugar WHERE punto_interes_id = ? AND nombre_norm = ?',
    puntoId,
    normalizarNombre(nombre)
  );
}

/**
 * Guarda las fichas de una búsqueda y devuelve cuántas entraron de verdad.
 *
 * Las que ya existieran en otro bloque no se tocan ni se regeneran: se cuentan
 * aparte para poder decírselo al usuario con su nombre.
 */
function guardarFichas(punto, busquedaId, texto, sitios) {
  const insertar = db.prepare(
    `INSERT INTO sitios_lugar
       (punto_interes_id, nombre, nombre_norm, descripcion, imagen_url, wikipedia_url,
        lat, lon, orden, bloque, categoria, busqueda)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 'busqueda', ?, ?)`
  );

  // Detrás de lo que ya haya: estas tarjetas se leen en el orden en que se
  // pidieron, no por importancia.
  const desde =
    una('SELECT COALESCE(MAX(orden), 0) AS n FROM sitios_lugar WHERE punto_interes_id = ?', punto.id)
      .n ?? 0;

  const nuevos = [];
  const repetidos = [];

  db.exec('BEGIN');
  try {
    for (const s of sitios) {
      const previo = yaExiste(punto.id, s.nombre);
      if (previo) {
        repetidos.push({ nombre: previo.nombre, bloque: previo.bloque });
        continue;
      }
      const r = insertar.run(
        punto.id,
        s.nombre,
        normalizarNombre(s.nombre),
        s.descripcion,
        s.imagen_url ?? null,
        s.wikipedia_url ?? null,
        s.lat,
        s.lon,
        desde + nuevos.length + 1,
        s.categoria,
        texto
      );
      nuevos.push({ id: Number(r.lastInsertRowid), nombre: s.nombre });
    }
    db.exec('COMMIT');
  } catch (err) {
    db.exec('ROLLBACK');
    throw err;
  }

  return { nuevos, repetidos };
}

/** Saneado común a las dos llamadas: lo que venga con forma rara se cae. */
function comoFicha(s) {
  if (!s || typeof s.nombre !== 'string' || !s.nombre.trim()) return null;
  return {
    nombre: s.nombre.trim(),
    descripcion: textoONulo(s.descripcion),
    categoria: categoriaValida(s.categoria),
    lat: numeroONulo(s.lat),
    lon: numeroONulo(s.lon),
    titulo_wikipedia: s.titulo_wikipedia ? String(s.titulo_wikipedia).trim() : s.nombre.trim(),
    // El titulo en el idioma del pais es de donde sale la foto cuando la
    // Wikipedia en espanol no tiene el articulo, que fuera de los sitios muy
    // famosos es lo normal.
    titulo_wikipedia_local: textoONulo(s.titulo_wikipedia_local),
    idioma_wikipedia_local: textoONulo(s.idioma_wikipedia_local),
  };
}

const marcar = (id, campos) => {
  const trozos = Object.keys(campos).map((k) => `${k} = ?`).join(', ');
  ejecutar(`UPDATE busquedas_sitios SET ${trozos} WHERE id = ?`, ...Object.values(campos), id);
};

/**
 * EJECUTA UNA BÚSQUEDA. Es lo que hace el trabajo de la cola.
 *
 * Entra dos veces por la misma puerta y hace cosas distintas según el estado:
 *
 *   pendiente  → pregunta a la IA qué le han pedido. Si era un sitio, lo genera
 *                entero. Si era un tema, deja las propuestas y se para.
 *   generando  → el usuario ya ha marcado cuáles quiere: genera esas.
 *
 * Un solo tipo de trabajo para las dos vueltas, porque para la pantalla es la
 * misma búsqueda avanzando, y el sondeo que ya existe no tiene que aprender
 * ningún tipo nuevo.
 */
export async function ejecutarBusqueda(busquedaId, { alGenerar = null } = {}) {
  const fila = una('SELECT * FROM busquedas_sitios WHERE id = ?', busquedaId);
  if (!fila) throw new Error('Esa búsqueda ya no existe.');

  const etapa = una('SELECT * FROM etapas WHERE id = ?', fila.etapa_id);
  if (!etapa) throw new Error('Esa parada ya no existe.');

  const punto = etapa.punto_interes_id
    ? una('SELECT * FROM puntos_interes WHERE id = ?', etapa.punto_interes_id)
    : null;
  if (!punto) {
    throw new Error(
      'Esta parada todavía no tiene ficha propia, así que no hay dónde guardar lo que busques.'
    );
  }

  if (!hayClaveIA()) throw new Error(SIN_CLAVE);
  const ciudad = etapa.nombre_ciudad || punto.nombre;

  // --- Vuelta 1: qué me han pedido ----------------------------------------
  let aGenerar = [];
  if (fila.estado !== 'generando') {
    marcar(busquedaId, { estado: 'proponiendo' });

    const r = await consultarJSON(promptDeBusqueda(ciudad, fila.texto), {
      maxTokens: 3000,
      paso: `buscar «${fila.texto}» en ${ciudad}`,
    });

    const tipo = r?.tipo === 'concreto' ? 'concreto' : 'generico';

    if (tipo === 'generico') {
      const propuestas = (Array.isArray(r?.propuestas) ? r.propuestas : [])
        .filter((p) => p && typeof p.nombre === 'string' && p.nombre.trim())
        .slice(0, MAXIMO_PROPUESTAS)
        .map((p) => ({ nombre: p.nombre.trim(), descripcion: textoONulo(p.descripcion) }));

      if (!propuestas.length) {
        marcar(busquedaId, {
          tipo,
          estado: 'hecha',
          propuestas: '[]',
          terminado_en: new Date().toISOString().slice(0, 19).replace('T', ' '),
        });
        return { tipo, propuestas: 0, fichas: 0, mensaje: `Sin resultados para «${fila.texto}».` };
      }

      // Aquí se para y se espera al usuario. No es un trabajo a medias: es un
      // trabajo terminado cuya salida es una pregunta.
      marcar(busquedaId, { tipo, estado: 'esperando', propuestas: JSON.stringify(propuestas) });
      return {
        tipo,
        propuestas: propuestas.length,
        fichas: 0,
        mensaje: `${propuestas.length} propuestas para «${fila.texto}»; esperando a que elijas.`,
      };
    }

    const ficha = comoFicha(r?.sitio);
    if (!ficha) {
      marcar(busquedaId, {
        tipo,
        estado: 'hecha',
        terminado_en: new Date().toISOString().slice(0, 19).replace('T', ' '),
      });
      return { tipo, propuestas: 0, fichas: 0, mensaje: `Sin resultados para «${fila.texto}».` };
    }

    marcar(busquedaId, { tipo, estado: 'generando' });
    aGenerar = [ficha];
  } else {
    // --- Vuelta 2: las que el usuario marcó -------------------------------
    const nombres = propuestasDe(fila).filter((p) => p.elegido).map((p) => p.nombre);
    if (!nombres.length) throw new Error('No quedó ninguna propuesta marcada.');

    const r = await consultarJSON(promptDeFichas(ciudad, nombres), {
      maxTokens: 4000,
      paso: `fichas de ${nombres.length} sitios de ${ciudad}`,
    });
    aGenerar = (Array.isArray(r?.sitios) ? r.sitios : []).map(comoFicha).filter(Boolean);
  }

  // --- Foto y enlace, igual que en los otros bloques -----------------------
  await ponerFotosDeWikipedia(aGenerar);

  const { nuevos, repetidos } = guardarFichas(punto, busquedaId, fila.texto, aGenerar);

  // --- Los datos duros, en SU PROPIA búsqueda ------------------------------
  //
  // No se puede colgar de la búsqueda grande de la etapa: esa ya se hizo, y
  // rehacerla entera por dos fichas nuevas sería abrir el navegador para
  // treinta sitios que ya tienen sus datos.
  //
  // Y ESA MISMA BÚSQUEDA DECIDE SI LA FICHA SE QUEDA.
  //
  // Si no encuentra nada del sitio, o lo que encuentra está en otra ciudad, la
  // ficha se borra ahí dentro y vuelve en `descartados`. Aquí solo hay que
  // contarlo y decírselo a quien buscó: es peor darle por buena una ficha de un
  // sitio que no existe que decirle que no se ha encontrado.
  let descartados = [];
  if (nuevos.length && alGenerar) {
    try {
      const r = await alGenerar(punto, nuevos.map((n) => n.id));
      descartados = r?.descartados ?? [];
    } catch (err) {
      // Las fichas ya están. Que Google no conteste no las borra.
      console.warn(`[busquedas] sin datos duros para «${fila.texto}» (${err.message}).`);
    }
  }

  const tirados = new Set(descartados.map((x) => x.id));
  const quedan = nuevos.filter((n) => !tirados.has(n.id));

  // El aviso de lo que ya estaba. No es un error —no ha fallado nada— pero sin
  // decirlo la pantalla se queda en "0 fichas" y parece que se ha roto algo.
  const avisos = [];

  if (repetidos.length) {
    avisos.push(
      repetidos.length === 1
        ? `«${repetidos[0].nombre}» ya lo tenías en ${NOMBRE_DE_BLOQUE[repetidos[0].bloque] ?? 'otra pestaña'}, así que no lo he repetido.`
        : `Estos ya los tenías y no los he repetido: ${repetidos.map((r) => r.nombre).join(', ')}.`
    );
  }

  // El descarte se cuenta con sus palabras, no con un «0 fichas» a secas: quien
  // ha buscado tiene derecho a saber si el sitio no existe o si existe pero está
  // en otra ciudad.
  for (const x of descartados) {
    avisos.push(
      x.motivo.startsWith('la dirección')
        ? `No he creado la ficha de «${x.nombre}»: lo que hay con ese nombre no está en ${ciudad} (${x.motivo}).`
        : `No he encontrado «${x.nombre}» en ${ciudad}: la búsqueda no ha dado ningún dato de ese sitio, así que no creo la ficha.`
    );
    console.log(`[busquedas] ${ciudad}: descartado por no verificado: ${x.nombre} (${x.motivo})`);
  }

  const nota = avisos.length ? avisos.join(' ') : null;

  ejecutar(
    `UPDATE busquedas_sitios
        SET estado = 'hecha', fichas = fichas + ?, nota = ?, terminado_en = datetime('now')
      WHERE id = ?`,
    quedan.length,
    nota,
    busquedaId
  );

  const mensaje =
    `${quedan.length} ficha${quedan.length === 1 ? '' : 's'} de «${fila.texto}»` +
    (repetidos.length
      ? ` · ${repetidos.length} ya estaban: ${repetidos.map((r) => r.nombre).join(', ')}`
      : '') +
    (descartados.length
      ? ` · ${descartados.length} sin verificar: ${descartados.map((d) => d.nombre).join(', ')}`
      : '');
  console.log(`[busquedas] ${ciudad}: ${mensaje}`);

  return {
    tipo: fila.tipo,
    propuestas: 0,
    fichas: quedan.length,
    repetidos,
    descartados,
    mensaje,
  };
}

export default {
  busquedasDeEtapa,
  pedirBusqueda,
  elegirPropuestas,
  borrarBusqueda,
  busquedaActiva,
  ejecutarBusqueda,
  MAXIMO_PROPUESTAS,
};
