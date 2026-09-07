/**
 * services/comer.js
 * -----------------------------------------------------------------------------
 * Dónde comer y dónde tomar algo.
 *
 * ES CATÁLOGO, COMO LAS EXCURSIONES. Que Casa Botín esté en Cuchilleros 17 y
 * tenga 4,3 no depende de mi viaje: se busca una vez por ciudad y sirve para el
 * siguiente. Por eso va por ciudad normalizada y no por etapa.
 *
 * Y AQUÍ ESO IMPORTA MÁS QUE EN NINGÚN OTRO SITIO, porque la fuente buena es
 * Google Places, que es la API CARA de las tres que usamos. La disciplina es la
 * misma que con las fichas de Civitatis, que ya la tenemos probada:
 *
 *   1. Se busca con la máscara de campos MÍNIMA.
 *   2. Lo que vuelve se guarda ENTERO.
 *   3. Un sitio ya guardado NO se vuelve a pedir.
 *   4. El teléfono, la web y los horarios solo BAJO DEMANDA, al abrir la ficha.
 *      De veinte resultados se abren dos: pedir los detalles de los veinte sería
 *      pagar diez veces por nada.
 *
 * DOS FUENTES, Y SE NOTA CUÁL CONTESTÓ
 *
 *   1. Places (New), con la clave de servidor.
 *   2. La IA con BÚSQUEDA WEB, que devuelve los mismos campos. La puntuación
 *      que da NO es fiable —no está contando opiniones, está recordando— y por
 *      eso las fichas que vienen de ahí lo dicen en pantalla en vez de fingir un
 *      número que no lo es.
 *
 * En local Places falla siempre (clave restringida por IP) y se desarrolla
 * contra la IA. En el servidor entra Places y se nota porque aparecen las
 * puntuaciones y el número de opiniones de verdad.
 */

import { todas, una, ejecutar, db, normalizarNombre } from '../db/index.js';
import { trabajoActivo, ultimoTrabajo, encolar } from '../jobs/cola.js';
import { buscarSitiosConGoogle, detallesDeSitioConGoogle, googleDisponible } from '../lib/google.js';
import { consultarJSON } from '../lib/ia.js';
import { notaPonderada } from './proveedores.js';
import { direccionesDe, direccionDe, guardarDireccion } from './direcciones.js';

/** Los símbolos de precio, que se leen de un vistazo mejor que un número. */
const SIMBOLO_PRECIO = ['gratis', '€', '€€', '€€€', '€€€€'];

const texto = (v) => {
  const t = String(v ?? '').trim();
  return t || null;
};

// =============================================================================
// LEER DEL CATÁLOGO
// =============================================================================
/**
 * Los sitios de comer de una ciudad, listos para pintar.
 *
 * La nota que manda es la PONDERADA, la misma fórmula que ya usan los hoteles y
 * las excursiones: un 5,0 con tres opiniones no puede ganarle a un 4,6 con
 * ochocientas, y sin ponderar le gana siempre.
 */
export function fichasDeComer(ciudad) {
  if (!ciudad) return [];

  const filas = todas(
    'SELECT * FROM catalogo_comer WHERE ciudad_norm = ? ORDER BY id',
    normalizarNombre(ciudad)
  );
  const direcciones = direccionesDe('comer', filas.map((f) => f.id));

  return filas
    .map((f) => conCara(f, direcciones.get(f.id) ?? null))
    .sort((a, b) => (b.ponderada ?? -1) - (a.ponderada ?? -1));
}

/** Una ficha suelta, por id. */
export function fichaDeComer(id) {
  const f = una('SELECT * FROM catalogo_comer WHERE id = ?', Number(id));
  return f ? conCara(f, direccionDe('comer', f.id)) : null;
}

function conCara(f, direccion) {
  return {
    id: f.id,
    ciudad: f.ciudad,
    nombre: f.nombre,
    cocina: f.cocina,
    precioNivel: f.precio_nivel,
    precioSimbolo: f.precio_nivel != null ? SIMBOLO_PRECIO[f.precio_nivel] ?? null : null,
    precioTexto: f.precio_texto,
    valoracion: f.valoracion,
    numOpiniones: f.num_opiniones,
    ponderada: notaPonderada(f.valoracion, f.num_opiniones),
    // La dirección que dio la fuente es la que se enseña; si alguien la corrige
    // a mano, manda la corregida, que para eso se corrigió.
    direccion: direccion?.direccion ?? f.direccion,
    direccionFicha: direccion,
    telefono: f.telefono,
    // El teléfono, listo para el enlace: sin espacios ni guiones, que un tel:
    // con espacios no marca en algunos móviles.
    telefonoMarcable: f.telefono ? String(f.telefono).replace(/[^+\d]/g, '') : null,
    web: f.web,
    urlMapa: f.url_mapa,
    horarios: f.horarios,
    nota: f.nota,
    origen: f.origen,
    // La marca de "los detalles ya se pidieron". Sin ella no se distinguiría un
    // bar sin teléfono de uno que nadie ha mirado.
    tieneDetalles: Boolean(f.detalles_en),
    claveUnica: f.clave_unica,
    // Solo para el cálculo; la vista no lo usa.
    punto: f.lat != null && f.lng != null ? { lat: f.lat, lng: f.lng } : (direccion?.punto ?? null),
  };
}

// =============================================================================
// ESCRIBIR EN EL CATÁLOGO
// =============================================================================
/**
 * Guarda lo que devolvió una búsqueda. Actualiza lo que ya estaba en vez de
 * duplicarlo: la misma búsqueda repetida no debe llenar la lista de clones.
 *
 * NO PISA LOS DETALLES. Si un sitio ya tenía teléfono y horarios (porque
 * alguien abrió su ficha) y vuelve a salir en otra búsqueda, la búsqueda no los
 * trae —no los pide— y no puede borrarlos.
 */
export function guardarFichasDeComer(ciudad, lista, origen = 'places') {
  if (!ciudad || !lista?.length) return [];

  const ciudadNorm = normalizarNombre(ciudad);
  const sentencia = db.prepare(
    `INSERT INTO catalogo_comer
       (ciudad, ciudad_norm, clave_unica, nombre, cocina, precio_nivel, precio_texto,
        valoracion, num_opiniones, direccion, lat, lng, nota, origen, visto_en)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, datetime('now'))
     ON CONFLICT (ciudad_norm, clave_unica) DO UPDATE SET
       nombre        = excluded.nombre,
       cocina        = COALESCE(excluded.cocina, cocina),
       precio_nivel  = COALESCE(excluded.precio_nivel, precio_nivel),
       precio_texto  = COALESCE(excluded.precio_texto, precio_texto),
       valoracion    = COALESCE(excluded.valoracion, valoracion),
       num_opiniones = COALESCE(excluded.num_opiniones, num_opiniones),
       direccion     = COALESCE(excluded.direccion, direccion),
       lat           = COALESCE(excluded.lat, lat),
       lng           = COALESCE(excluded.lng, lng),
       nota          = COALESCE(excluded.nota, nota),
       visto_en      = datetime('now')`
  );

  const guardadas = [];
  try {
    db.exec('BEGIN');
    for (const s of lista) {
      const clave = texto(s.claveUnica) ?? `nombre:${normalizarNombre(s.nombre)}`;
      sentencia.run(
        ciudad,
        ciudadNorm,
        clave,
        texto(s.nombre) ?? '(sin nombre)',
        texto(s.cocina),
        s.precioNivel != null ? Number(s.precioNivel) : null,
        texto(s.precioTexto),
        s.valoracion != null ? Number(s.valoracion) : null,
        s.numOpiniones != null ? Number(s.numOpiniones) : null,
        texto(s.direccion),
        s.lat != null ? Number(s.lat) : null,
        s.lng != null ? Number(s.lng) : null,
        texto(s.nota),
        origen
      );
      guardadas.push(clave);
    }
    db.exec('COMMIT');
  } catch (err) {
    try { db.exec('ROLLBACK'); } catch { /* ya estaba cerrada */ }
    console.warn('[comer] no se pudo guardar el catálogo:', err.message);
    return [];
  }

  // La dirección va también al almacén común, que es de donde la leen los
  // traslados. Un sitio de Places viene con coordenadas: se apuntan tal cual y
  // NO se encola geocodificación, que sería pagar por saber lo que ya sabemos.
  for (const clave of guardadas) {
    const fila = una(
      'SELECT * FROM catalogo_comer WHERE ciudad_norm = ? AND clave_unica = ?',
      ciudadNorm,
      clave
    );
    if (fila?.direccion) sincronizarDireccion(fila);
  }

  return guardadas;
}

/**
 * Pone la dirección de un restaurante en el almacén común de direcciones.
 *
 * Si ya vienen las coordenadas —Places siempre las manda— se marca como situada
 * sin pasar por la cola. Si no (la IA a veces solo da la calle, y lo escrito a
 * mano nunca las trae), se guarda por el camino normal y se geocodifica.
 */
function sincronizarDireccion(fila) {
  const ya = una(
    "SELECT * FROM direcciones WHERE tipo_elemento = 'comer' AND elemento_id = ?",
    fila.id
  );

  if (fila.lat != null && fila.lng != null) {
    if (ya) {
      // Solo se rellenan las coordenadas si faltaban: si alguien corrigió la
      // dirección a mano, la suya manda y no se le pisa.
      if (ya.lat == null || ya.lng == null) {
        ejecutar(
          `UPDATE direcciones
              SET lat = ?, lng = ?, estado = 'ok', fuente = ?, actualizado_en = datetime('now')
            WHERE id = ?`,
          fila.lat,
          fila.lng,
          fila.origen,
          ya.id
        );
      }
      return;
    }
    ejecutar(
      `INSERT INTO direcciones
         (tipo_elemento, elemento_id, direccion, lat, lng, estado, fuente, buscada_en)
       VALUES ('comer', ?, ?, ?, ?, 'ok', ?, datetime('now'))`,
      fila.id,
      fila.direccion,
      fila.lat,
      fila.lng,
      fila.origen
    );
    return;
  }

  if (!ya) guardarDireccion('comer', fila.id, fila.direccion);
}

/** Una ficha escrita a mano: el bar que te recomendó un amigo. */
export function guardarFichaManual(ciudad, ficha) {
  const claves = guardarFichasDeComer(ciudad, [{ ...ficha, claveUnica: null }], 'manual');
  if (!claves.length) return null;

  const fila = una(
    'SELECT * FROM catalogo_comer WHERE ciudad_norm = ? AND clave_unica = ?',
    normalizarNombre(ciudad),
    claves[0]
  );
  // Lo escrito a mano nunca trae coordenadas: se busca su dirección como la de
  // cualquier otra cosa.
  if (fila && ficha.direccion) guardarDireccion('comer', fila.id, ficha.direccion);
  if (fila && (ficha.telefono || ficha.web)) {
    ejecutar(
      'UPDATE catalogo_comer SET telefono = ?, web = ?, detalles_en = datetime(\'now\') WHERE id = ?',
      texto(ficha.telefono),
      texto(ficha.web),
      fila.id
    );
  }
  return fichaDeComer(fila.id);
}

export function actualizarFichaDeComer(id, ficha) {
  const f = una('SELECT * FROM catalogo_comer WHERE id = ?', Number(id));
  if (!f) return null;

  ejecutar(
    `UPDATE catalogo_comer
        SET nombre = ?, cocina = ?, precio_texto = ?, direccion = ?, telefono = ?,
            web = ?, nota = ?, horarios = ?
      WHERE id = ?`,
    texto(ficha.nombre) ?? f.nombre,
    texto(ficha.cocina),
    texto(ficha.precioTexto),
    texto(ficha.direccion),
    texto(ficha.telefono),
    texto(ficha.web),
    texto(ficha.nota),
    texto(ficha.horarios),
    f.id
  );

  // Si al corregir se escribe el teléfono o la web, los detalles ya están: no
  // tiene sentido seguir ofreciendo "Teléfono y horarios" —y pagar por
  // pedirlos— cuando la ficha los enseña delante.
  if (texto(ficha.telefono) || texto(ficha.web) || texto(ficha.horarios)) {
    ejecutar("UPDATE catalogo_comer SET detalles_en = datetime('now') WHERE id = ?", f.id);
  }

  // Corregir la dirección la vuelve a situar: es lo que se espera al corregirla.
  if (texto(ficha.direccion) && texto(ficha.direccion) !== f.direccion) {
    guardarDireccion('comer', f.id, ficha.direccion);
  }
  return fichaDeComer(f.id);
}

export function borrarFichaDeComer(id) {
  const f = una('SELECT * FROM catalogo_comer WHERE id = ?', Number(id));
  if (!f) return false;
  ejecutar('DELETE FROM catalogo_comer WHERE id = ?', f.id);
  ejecutar("DELETE FROM direcciones WHERE tipo_elemento = 'comer' AND elemento_id = ?", f.id);
  return true;
}

// =============================================================================
// BUSCAR
// =============================================================================
/**
 * Todo lo que necesita la pestaña "Comer".
 *
 * `apuntados` son los que ya están en el viaje. Se cruzan por id de catálogo,
 * que es lo que guarda `datos_extra` del candidato.
 */
export function comerDeEtapa(etapa) {
  const fichas = fichasDeComer(etapa.nombre_ciudad);

  const apuntados = todas(
    "SELECT * FROM candidatos WHERE etapa_id = ? AND tipo = 'comer'",
    etapa.id
  );
  const porFicha = new Map();
  for (const c of apuntados) {
    try {
      const extra = c.datos_extra ? JSON.parse(c.datos_extra) : null;
      if (extra?.deId) porFicha.set(Number(extra.deId), c);
    } catch { /* datos_extra corrupto: se ignora, no se cae la pantalla */ }
  }

  const activo = trabajoActivo(etapa.viaje_id, 'comer_buscar', etapa.id);
  const ultimo = ultimoTrabajo(etapa.viaje_id, 'comer_buscar', etapa.id);

  return {
    ciudad: etapa.nombre_ciudad,
    fichas: fichas.map((f) => ({
      ...f,
      apuntado: porFicha.has(f.id),
      candidatoId: porFicha.get(f.id)?.id ?? null,
    })),
    buscando: Boolean(activo),
    mensajeError:
      !activo && !fichas.length && ultimo?.estado === 'error' ? ultimo.mensaje_error : null,
    consultada: Boolean(ultimo),
    // Para que la pantalla pueda decir de dónde salió lo que se ve.
    fuenteQueSeUsara: googleDisponible() ? 'places' : 'ia',
  };
}

/** Encola una búsqueda. El texto libre es el matiz: "cenar tranquilo y barato". */
export function pedirBusquedaDeComer(etapaId, consulta) {
  const etapa = una('SELECT * FROM etapas WHERE id = ?', Number(etapaId));
  if (!etapa) return null;

  const activo = trabajoActivo(etapa.viaje_id, 'comer_buscar', etapa.id);
  if (activo) return { encolado: false };

  encolar(etapa.viaje_id, 'comer_buscar', etapa.id);
  // La consulta viaja aparte: la cola solo guarda tipo y referencia, y meterle
  // una columna nueva por esto sería desproporcionado.
  consultasPendientes.set(etapa.id, texto(consulta));
  return { encolado: true };
}

/**
 * Lo que se tecleó en el buscador, esperando a que el worker lo recoja.
 *
 * En memoria y no en la base: es un dato que vive treinta segundos, entre que
 * se pulsa el botón y el worker coge el trabajo. Si el servidor se reinicia en
 * ese hueco se busca "los mejores de {ciudad}", que es exactamente lo que hace
 * el botón sin texto y un resultado perfectamente razonable.
 */
const consultasPendientes = new Map();

export function consultaPendiente(etapaId) {
  const c = consultasPendientes.get(Number(etapaId)) ?? null;
  consultasPendientes.delete(Number(etapaId));
  return c;
}

/**
 * La búsqueda de verdad. La llama el worker.
 *
 * `centro` y `radio` sesgan hacia una zona: es lo que usa el "+" del lienzo
 * para buscar entre dos puntos.
 */
export async function investigarComer(ciudad, consulta, { centro = null, radio = null } = {}) {
  const pregunta = texto(consulta) || `los mejores sitios para comer de ${ciudad}`;

  // --- 1) Places, que es quien tiene notas y opiniones de verdad -----------
  const dePlaces = await buscarSitiosConGoogle(`${pregunta} en ${ciudad}`, { centro, radio });
  if (dePlaces && dePlaces.length) {
    guardarFichasDeComer(ciudad, dePlaces, 'places');
    console.log(`[comer] ${dePlaces.length} sitio/s de Places para «${pregunta}» en ${ciudad}.`);
    return { sitios: dePlaces, fuente: 'places' };
  }

  // --- 2) La IA con búsqueda web -------------------------------------------
  console.log(
    googleDisponible()
      ? '[comer] Places no dio resultados: pregunto a la IA con búsqueda web.'
      : '[comer] Sin Places (clave restringida o ausente): IA con búsqueda web.'
  );

  const respuesta = await consultarJSON(promptDeComer(ciudad, pregunta), {
    paso: `buscar dónde comer en ${ciudad}`,
    conWeb: true,
    maxTokens: 6000,
  });

  const sitios = (Array.isArray(respuesta) ? respuesta : respuesta?.sitios ?? [])
    .filter((s) => texto(s?.nombre))
    .slice(0, 15)
    .map((s) => ({
      claveUnica: null,
      nombre: texto(s.nombre),
      cocina: texto(s.cocina),
      direccion: texto(s.direccion),
      precioTexto: texto(s.precio),
      precioNivel: nivelDePrecio(s.precio),
      // La IA NO cuenta opiniones: recuerda. Guardar su número como si fuera
      // una nota medida sería mentir con dos decimales, así que no se guarda.
      valoracion: null,
      numOpiniones: null,
      nota: texto(s.porQue) ?? texto(s.nota),
      lat: null,
      lng: null,
    }));

  if (!sitios.length) {
    throw new Error(`No se ha encontrado nada para comer en ${ciudad} con «${pregunta}».`);
  }

  guardarFichasDeComer(ciudad, sitios, 'ia');
  console.log(`[comer] ${sitios.length} sitio/s de la IA para «${pregunta}» en ${ciudad}.`);
  return { sitios, fuente: 'ia' };
}

/** "20-30 €" o "€€" -> 2. A ojo, pero es lo que se lee de un vistazo. */
function nivelDePrecio(precio) {
  const t = String(precio ?? '').trim();
  if (!t) return null;

  const euros = (t.match(/€/g) ?? []).length;
  if (euros >= 1 && !/\d/.test(t)) return Math.min(euros, 4);

  const numeros = (t.match(/\d+/g) ?? []).map(Number);
  if (!numeros.length) return null;
  const medio = numeros.reduce((a, b) => a + b, 0) / numeros.length;
  if (medio < 15) return 1;
  if (medio < 35) return 2;
  if (medio < 70) return 3;
  return 4;
}

export function promptDeComer(ciudad, consulta) {
  return `Eres alguien que conoce bien la restauración de ${ciudad}.

BUSCA EN LA WEB sitios para comer o tomar algo en ${ciudad} que respondan a esto:
"${consulta}"

Dame entre 8 y 12 sitios que existan DE VERDAD y estén abiertos. Nada de
inventar nombres ni direcciones: si no encuentras la calle exacta, deja
"direccion" con lo que sepas ("barrio de Malasaña") o vacío, pero NO te la
inventes.

Responde SOLO con este JSON:
{
  "sitios": [
    {
      "nombre": "Casa Botín",
      "cocina": "castellano, asador",
      "direccion": "Calle de Cuchilleros 17",
      "precio": "40-55 €",
      "porQue": "Una frase corta: por qué merece la pena y para qué momento es."
    }
  ]
}

Reglas:
- "precio" es lo que cuesta comer por persona, con bebida. Si no lo sabes, deja
  la cadena vacía.
- "porQue" en español de España, una frase, sin superlativos vacíos.
- Variedad: no doce sitios del mismo estilo ni todos en la misma calle.
- Si un dato no lo encuentras, deja la cadena VACÍA. NO te lo inventes.`;
}

// =============================================================================
// LOS DETALLES DE UNA FICHA
// =============================================================================
/**
 * Teléfono, web y horarios. SOLO BAJO DEMANDA y SOLO UNA VEZ.
 *
 * Es la parte cara de Places, así que se pide al abrir la ficha —no al
 * buscar— y se guarda para siempre. Un sitio con `detalles_en` no se vuelve a
 * preguntar aunque se abra veinte veces.
 */
export function pedirDetallesDeComer(fichaId, viajeId) {
  const f = una('SELECT * FROM catalogo_comer WHERE id = ?', Number(fichaId));
  if (!f) return null;
  if (f.detalles_en) return { estado: 'hecho', ficha: fichaDeComer(f.id) };

  const viaje = Number(viajeId) || una('SELECT id FROM viajes ORDER BY id LIMIT 1')?.id;
  if (!viaje) return { estado: 'error' };

  if (trabajoActivo(viaje, 'comer_detalles', f.id)) return { estado: 'buscando' };
  encolar(viaje, 'comer_detalles', f.id);
  return { estado: 'buscando' };
}

/** El estado de los detalles de una ficha, para el sondeo de la pantalla. */
export function estadoDetallesDeComer(fichaId, viajeId) {
  const f = una('SELECT * FROM catalogo_comer WHERE id = ?', Number(fichaId));
  if (!f) return { estado: 'no_existe' };
  if (f.detalles_en) return { estado: 'hecho', ficha: fichaDeComer(f.id) };

  const viaje = Number(viajeId) || f.id;
  if (trabajoActivo(viaje, 'comer_detalles', f.id)) return { estado: 'buscando' };

  const ultimo = ultimoTrabajo(viaje, 'comer_detalles', f.id);
  if (ultimo?.estado === 'error') return { estado: 'error', mensaje: ultimo.mensaje_error };
  return { estado: 'pendiente' };
}

/** Los busca de verdad. Lo llama el worker. */
export async function investigarDetallesDeComer(fichaId) {
  const f = una('SELECT * FROM catalogo_comer WHERE id = ?', Number(fichaId));
  if (!f) return null;
  if (f.detalles_en) return fichaDeComer(f.id);

  let detalles = null;

  // Solo Places sabe contestar por `place_id`. Una ficha de la IA o escrita a
  // mano no tiene ese identificador y no hay a quién preguntarle.
  if (f.clave_unica && !f.clave_unica.startsWith('nombre:')) {
    detalles = await detallesDeSitioConGoogle(f.clave_unica);
  }

  if (!detalles) {
    console.log(`[comer] sin detalles de Places para «${f.nombre}»: pregunto a la IA.`);
    detalles = await detallesPorIA(f);
  }

  // Aunque no se haya sacado nada, se marca como pedido: si no, cada vez que
  // se abriera la ficha se volvería a pagar por el mismo silencio.
  ejecutar(
    `UPDATE catalogo_comer
        SET telefono = COALESCE(?, telefono),
            web      = COALESCE(?, web),
            url_mapa = COALESCE(?, url_mapa),
            horarios = COALESCE(?, horarios),
            detalles_en = datetime('now')
      WHERE id = ?`,
    detalles?.telefono ?? null,
    detalles?.web ?? null,
    detalles?.urlMapa ?? null,
    detalles?.horarios ?? null,
    f.id
  );

  console.log(
    `[comer] detalles de «${f.nombre}» (${detalles?.fuente ?? 'sin fuente'}): ` +
      [detalles?.telefono && 'teléfono', detalles?.web && 'web', detalles?.horarios && 'horarios']
        .filter(Boolean)
        .join(', ') || 'nada'
  );
  return fichaDeComer(f.id);
}

async function detallesPorIA(f) {
  try {
    const r = await consultarJSON(
      `BUSCA EN LA WEB los datos de contacto de este sitio para comer:

"${f.nombre}"${f.direccion ? `, ${f.direccion}` : ''}, en ${f.ciudad}.

Responde SOLO con este JSON:
{ "telefono": "+34 913 66 42 17", "web": "https://...", "horarios": "L-D 13:00-16:00 y 20:00-24:00" }

Si un dato no lo encuentras, deja la cadena VACÍA. NO te lo inventes: un
teléfono equivocado es peor que ninguno.`,
      { paso: `datos de «${f.nombre}»`, conWeb: true, maxTokens: 1500 }
    );
    return {
      telefono: texto(r?.telefono),
      web: texto(r?.web),
      urlMapa: null,
      horarios: texto(r?.horarios),
      fuente: 'ia',
    };
  } catch (err) {
    console.warn(`[comer] la IA tampoco pudo con «${f.nombre}»:`, err.message);
    return null;
  }
}

// =============================================================================
// BUSCAR ENTRE DOS PUNTOS (el "+" del lienzo)
// =============================================================================
/**
 * Sitios para comer que pillen de paso entre dos puntos.
 *
 * SE BUSCA ALREDEDOR DEL PUNTO MEDIO, con un radio proporcional a lo que hay
 * entre los dos extremos: si están a 400 m, un radio de 400 m; si están a 6 km,
 * uno de 3,5. Buscar con radio fijo daría lo mismo para dos sitios pegados que
 * para dos que están en barrios opuestos, y en el segundo caso "de paso" no
 * significa nada.
 *
 * Y cada resultado dice SU DESVÍO —cuánto hay de él a cada extremo—, que es lo
 * que de verdad se mira: un sitio buenísimo a 15 minutos del camino no pilla de
 * paso por muy céntrico que sea el punto medio.
 */
export async function buscarEntre(ciudad, a, b, { consulta = null, entre = null } = {}) {
  const medio = {
    lat: (Number(a.lat) + Number(b.lat)) / 2,
    lng: (Number(a.lng) + Number(b.lng)) / 2,
  };

  const { distanciaKm } = await import('./distancias.js');
  const separacionKm = distanciaKm({ lat: a.lat, lon: a.lng }, { lat: b.lat, lon: b.lng });

  // La mitad de lo que hay entre ellos, con un suelo de 400 m —dos puntos casi
  // pegados no dejarían sitio a nada— y un techo de 3 km, que es lo que uno
  // acepta desviarse para comer.
  const radio = Math.min(Math.max((separacionKm * 1000) / 2, 400), 3000);

  // A PLACES SE LE DICE LA ZONA CON COORDENADAS; A LA IA HAY QUE CONTÁRSELO.
  // El `locationBias` solo lo entiende Google. La IA necesita que la consulta
  // mencione entre qué está buscando, y con los nombres de los dos extremos ya
  // sabe de qué barrio se habla.
  const pregunta = entre
    ? `${consulta || 'dónde comer'}, por la zona entre ${entre.origen} y ${entre.destino}`
    : consulta;

  const { sitios, fuente } = await investigarComer(ciudad, pregunta, { centro: medio, radio });

  // EL DESVÍO ES EL DATO. Sin él, "entre estos dos puntos" no significa nada:
  // la IA devuelve buenos sitios de toda la ciudad y hay que poder ver cuáles
  // pillan de paso. Los suyos llegan sin coordenadas, así que se sitúan AQUÍ,
  // antes de contestar, en vez de dejarlo para la cola.
  //
  // Cuesta unos segundos —Nominatim va a una petición por segundo— y se paga
  // una sola vez por sitio: la siguiente búsqueda ya los encuentra situados.
  await situarLosQueFalten(ciudad, sitios);

  const conDesvio = fichasDeComer(ciudad)
    .filter((f) => sitios.some((s) => f.nombre === s.nombre))
    .map((f) => ({
      ...f,
      desvio: f.punto
        ? {
            aOrigen: distanciaKm({ lat: a.lat, lon: a.lng }, { lat: f.punto.lat, lon: f.punto.lng }),
            aDestino: distanciaKm({ lat: b.lat, lon: b.lng }, { lat: f.punto.lat, lon: f.punto.lng }),
          }
        : null,
    }))
    // Primero los que menos desvían: es el orden en el que se quieren leer.
    .sort((x, y) => sumaDesvio(x) - sumaDesvio(y));

  return { sitios: conDesvio, fuente, separacionKm, radio };
}

/**
 * Sitúa en el mapa los que todavía no lo están, de uno en uno.
 *
 * Solo los que hacen falta para contestar —los primeros—: geocodificar quince
 * son quince segundos de espera, y de quince se miran seis. Los demás se sitúan
 * solos por la cola cuando alguien abra su ficha.
 */
async function situarLosQueFalten(ciudad, sitios, cuantos = 8) {
  const { geocodificarFila } = await import('./direcciones.js');

  const pendientes = fichasDeComer(ciudad)
    .filter((f) => sitios.some((s) => f.nombre === s.nombre))
    .filter((f) => !f.punto && f.direccionFicha)
    .slice(0, cuantos);

  for (const f of pendientes) {
    try {
      await geocodificarFila(f.direccionFicha.id, { cerca: ciudad });
    } catch (err) {
      console.warn(`[comer] no se pudo situar «${f.nombre}»:`, err.message);
    }
  }
}

const sumaDesvio = (f) =>
  f.desvio ? f.desvio.aOrigen + f.desvio.aDestino : Number.POSITIVE_INFINITY;
