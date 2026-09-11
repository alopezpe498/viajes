/**
 * services/descubrir.js
 * -----------------------------------------------------------------------------
 * Investigar un destino: qué hay que ver en Japón, y con qué foto se enseña.
 *
 * Son dos fuentes muy distintas y por eso van en dos pasos separados:
 *
 *   1. LA IA dice QUÉ. Los 12-15 imprescindibles, con su categoría, sus
 *      coordenadas y por qué merecen la pena. Es una opinión ordenada, que es
 *      justo lo que se le pide.
 *
 *   2. WIKIPEDIA dice CÓMO SE VE. La foto y el enlace al artículo. Esto NO se
 *      le pide a la IA a propósito: una URL de imagen inventada es una imagen
 *      rota, y un modelo no tiene forma de saber si un fichero existe. Wikipedia
 *      sí, porque se le pregunta.
 *
 * El paso 2 es tolerante a todo: un punto sin artículo o sin foto se queda sin
 * imagen y la tarjeta pinta el placeholder de color. Nunca tumba la
 * investigación entera.
 */

import { db, todas, una, ejecutar, normalizarNombre } from '../db/index.js';
import { consultarJSON } from '../lib/ia.js';
import { direccionDe, guardarDireccion } from './direcciones.js';
import { actividadesDeCiudad } from './catalogo.js';

/** Cuántos imprescindibles se piden. Suficientes para una ruta, pocos para no agobiar. */
const CUANTOS_PUNTOS = { min: 12, max: 15 };

/** Las peticiones a Wikipedia son pequeñas; si una tarda mucho, no vale la pena esperarla. */
const TIMEOUT_WIKI_MS = 8_000;

/** Cabecera honesta: quién soy y para qué pido, como pide la etiqueta de Wikipedia. */
const AGENTE = 'CreadorViajes/0.1 (generador de viajes personal)';

/**
 * Pausa entre peticiones sueltas a Wikipedia.
 *
 * Ya casi no se usa: las fotos se piden en lotes de 50 títulos con una sola
 * llamada (`loteDeWikipedia`), que era la forma de dejar de comerse los 429
 * —"estás pidiendo demasiado"— al encadenar ciudades. Queda para las consultas
 * de una en una, que son las menos.
 */

/** Si aun así nos frenan, se espera esto y se prueba UNA vez más. */
const ESPERA_TRAS_429_MS = 2_000;

/** Cuantos titulos caben en una peticion de la API de accion. */
const TOPE_LOTE = 50;

const dormir = (ms) => new Promise((r) => setTimeout(r, ms));

// =============================================================================
// PASO 1 — la IA
// =============================================================================
/**
 * El prompt de un PAÍS o una REGIÓN.
 *
 * Aquí está la corrección más importante de todo el módulo: el NIVEL DEL
 * DESTINO manda sobre lo que se pide. Investigando España salían mezcladas
 * Barcelona, el Parque Güell y la Sagrada Familia, y eso es un error de
 * jerarquía, no de gusto: el Parque Güell no compite con Barcelona, está DENTRO
 * de Barcelona. Mezclarlos rompe el modelo entero, porque de una etapa se
 * duerme y de un monumento no.
 *
 * Así que a nivel de país se piden SOLO sitios donde se pueda hacer base, y se
 * prohíbe explícitamente lo que pertenece a la ficha de cada ciudad. La
 * prohibición va con ejemplos: decir "nada de monumentos" a secas se cumple a
 * medias; decir "nada de Sagrada Familia ni Parque Güell" se entiende a la
 * primera.
 */
function promptDeAmbito(destino, tipo) {
  // Con un país no se dice "la región de", y sin esto quedaba un doble espacio.
  const queEs = tipo === 'region' ? `la región de ${destino}` : destino;

  return `Eres un guía de viajes con experiencia real en ${destino}.

Estoy planeando una RUTA por ${queEs} y necesito decidir DÓNDE VOY A DORMIR.

Dame los ${CUANTOS_PUNTOS.min}-${CUANTOS_PUNTOS.max} lugares imprescindibles de ${destino} entendidos como PARADAS DE UNA RUTA: ciudades, pueblos, comarcas, islas o valles donde se pasan noches o que sirven de base para moverse por la zona.

REGLA QUE NO SE PUEDE SALTAR:
Cada resultado tiene que ser un sitio DONDE SE PUEDA DORMIR o que sirva de BASE.

PROHIBIDO devolver cosas que están DENTRO de una ciudad. Nada de monumentos, museos, templos, catedrales, parques, playas concretas, miradores, barrios ni atracciones. Eso pertenece a la ficha de cada ciudad y aquí sobra.

Ejemplos de lo que NO quiero si el destino fuera España:
  - "Sagrada Familia" NO (está dentro de Barcelona)
  - "Parque Güell" NO (está dentro de Barcelona)
  - "Museo del Prado" NO (está dentro de Madrid)
  - "Alhambra" NO (está dentro de Granada)
Y lo que SÍ: "Barcelona", "Granada", "San Sebastián", "Ribeira Sacra", "Menorca", "Picos de Europa".

Devuelve un objeto JSON con esta forma exacta:

{
  "destino": {
    "nombre": "${destino}",
    "tipo": "${tipo}",
    "pais": "nombre del país en español",
    "lat": número, "lon": número,
    "resumen": "2-3 frases sobre qué tipo de viaje es este destino"
  },
  "puntos": [
    {
      "nombre": "nombre en español de la ciudad, pueblo, comarca, isla o valle",
      "categoria": "ciudad" | "sitio",
      "ciudad_base": "dónde se duerme; para una ciudad, ella misma",
      "lat": número, "lon": número,
      "descripcion_corta": "2-3 líneas describiendo qué es y cómo es estar ahí",
      "por_que": "UNA frase: qué aporta esta parada a la ruta y por qué merece dormir aquí",
      "dias_recomendados_min": número entero,
      "dias_recomendados_max": número entero,
      "direccion": "calle y número si es un sitio concreto; vacío si es una ciudad o una región",
      "titulo_wikipedia": "título EXACTO del artículo en la Wikipedia en español",
      "titulo_wikipedia_local": "título EXACTO del mismo artículo en la Wikipedia del idioma del país",
      "idioma_wikipedia_local": "código de ese idioma: pl, it, ja, de…"
    }
  ]
}

Reglas:
- Ordena "puntos" por importancia: el primero es la parada que no te puedes perder.
- "categoria" es "ciudad" para ciudades y pueblos, y "sitio" para comarcas, islas, valles o parques naturales grandes que se recorren durmiendo en ellos.
- lat y lon son obligatorios y tienen que ser las coordenadas reales del lugar.
- "direccion" solo si el punto es un sitio concreto con dirección postal (un monasterio, un castillo): la calle, SIN ciudad ni país. Para una ciudad o una región entera, deja la cadena VACÍA. NO te la inventes.
- "titulo_wikipedia" es el título del artículo en es.wikipedia.org, tal cual, con sus tildes.
- "titulo_wikipedia_local" es el mismo artículo en la Wikipedia del país, escrito EXACTO y
  con sus caracteres propios. Muchos sitios solo tienen artículo ahí, y es de donde sale la foto.
  Si no estás seguro del título, deja la cadena VACÍA: un título inventado no encuentra nada.
- No inventes URLs de imágenes ni de páginas web: eso lo busco yo aparte.`;
}

/**
 * El prompt de una CIUDAD.
 *
 * Aquí sí toca lo de dentro: los sitios concretos que se visitan, más alguna
 * excursión de día si la ciudad se presta. Es el mismo nivel de detalle que la
 * ficha profunda, pero desde fuera: esto es lo que se ve en el mapa antes de
 * decidir si la ciudad entra en la ruta.
 */
function promptDeCiudadComoDestino(destino) {
  return `Eres un guía de viajes con experiencia real en ${destino}.

Dame los ${CUANTOS_PUNTOS.min}-${CUANTOS_PUNTOS.max} sitios IMPRESCINDIBLES de ${destino}: lugares concretos que se visitan DENTRO de la ciudad (barrios, monumentos, museos, mercados, parques, miradores) y, si la ciudad se presta, alguna excursión de un día desde ella.

Devuelve un objeto JSON con esta forma exacta:

{
  "destino": {
    "nombre": "${destino}",
    "tipo": "ciudad",
    "pais": "nombre del país en español",
    "lat": número, "lon": número,
    "resumen": "2-3 frases sobre qué tipo de viaje es esta ciudad"
  },
  "puntos": [
    {
      "nombre": "nombre en español del lugar",
      "categoria": "ciudad" | "sitio",
      "ciudad_base": "desde qué ciudad se visita; normalmente ${destino}",
      "lat": número, "lon": número,
      "descripcion_corta": "2-3 líneas describiendo qué es",
      "por_que": "una frase: por qué merece la pena ir",
      "dias_recomendados_min": número entero,
      "dias_recomendados_max": número entero,
      "direccion": "calle y número, o la plaza donde está",
      "titulo_wikipedia": "título EXACTO del artículo en la Wikipedia en español",
      "titulo_wikipedia_local": "título EXACTO del mismo artículo en la Wikipedia del idioma del país",
      "idioma_wikipedia_local": "código de ese idioma: pl, it, ja, de…"
    }
  ]
}

Reglas:
- Ordena "puntos" por importancia: el primero es el que no te puedes perder.
- "categoria" es "sitio" para lo que está dentro de la ciudad, y "ciudad" solo para una excursión de día a otra población.
- lat y lon son obligatorios y tienen que ser las coordenadas reales del sitio.
- "direccion" es la dirección postal, SIN la ciudad ni el país: "Calle de Ruiz de Alarcón 23", "Plaza de Oriente". Para un barrio o un parque grande, la entrada principal. Si el sitio no tiene una dirección con sentido —una sierra, una isla—, deja la cadena VACÍA. NO te la inventes: una calle equivocada manda a la otra punta.
- "titulo_wikipedia" es el título del artículo en es.wikipedia.org, tal cual, con sus tildes.
- No inventes URLs de imágenes ni de páginas web: eso lo busco yo aparte.`;
}

/**
 * Elige el prompt según el nivel del destino.
 *
 * El nivel lo sabemos desde el mapamundi: al tocar el mapa, Google contesta
 * país o ciudad según el zoom, y eso se guarda en `destinos.tipo`. Si un destino
 * viejo no lo tiene, se trata como ámbito, que es lo más habitual y el caso en
 * el que la mezcla hacía más daño.
 */
function promptDeDestino(destino, tipo = 'pais') {
  return tipo === 'ciudad' ? promptDeCiudadComoDestino(destino) : promptDeAmbito(destino, tipo);
}

/**
 * Le pregunta a la IA por un destino y devuelve { destino, puntos } ya saneado.
 * Todo lo que venga con una forma rara se descarta aquí y no llega a la base.
 */
export async function investigarDestinoConIA(nombreDestino, tipo = 'pais') {
  const respuesta = await consultarJSON(promptDeDestino(nombreDestino, tipo), {
    paso: `investigar «${nombreDestino}»`,
    maxTokens: 8000,
  });

  const cabecera = respuesta?.destino ?? {};
  const crudos = Array.isArray(respuesta?.puntos) ? respuesta.puntos : [];

  const puntos = crudos
    .filter((p) => p && typeof p.nombre === 'string' && p.nombre.trim())
    .map((p, i) => ({
      nombre: String(p.nombre).trim(),
      // Cualquier cosa que no sea exactamente 'sitio' se trata como ciudad:
      // es lo más común y lo que mejor se comporta en la pantalla.
      categoria: p.categoria === 'sitio' ? 'sitio' : 'ciudad',
      ciudad_base: p.ciudad_base ? String(p.ciudad_base).trim() : String(p.nombre).trim(),
      lat: numeroONulo(p.lat),
      lon: numeroONulo(p.lon),
      descripcion_corta: textoONulo(p.descripcion_corta),
      por_que: textoONulo(p.por_que),
      // La dirección postal, para el campo de la ficha. Puede venir vacía y es
      // lo correcto: una sierra no tiene calle, y preferimos el hueco a una
      // dirección inventada que mandaría el traslado a la otra punta.
      direccion: textoONulo(p.direccion),
      dias_recomendados_min: enteroONulo(p.dias_recomendados_min),
      dias_recomendados_max: enteroONulo(p.dias_recomendados_max),
      titulo_wikipedia: p.titulo_wikipedia ? String(p.titulo_wikipedia).trim() : String(p.nombre).trim(),
      titulo_wikipedia_local: textoONulo(p.titulo_wikipedia_local),
      idioma_wikipedia_local: textoONulo(p.idioma_wikipedia_local),
      orden: i + 1,
    }));

  if (!puntos.length) {
    throw new Error(`La IA no devolvió ningún sitio para «${nombreDestino}».`);
  }

  return {
    destino: {
      nombre: textoONulo(cabecera.nombre) ?? nombreDestino,
      // El nivel lo sabemos nosotros (viene del mapamundi): no se acepta el que
      // devuelva el modelo, que a veces contesta "ciudad" para un país entero y
      // eso volvería a mezclar monumentos con ciudades.
      tipo,
      pais: textoONulo(cabecera.pais),
      lat: numeroONulo(cabecera.lat),
      lon: numeroONulo(cabecera.lon),
      resumen: textoONulo(cabecera.resumen),
    },
    puntos,
  };
}

// =============================================================================
// PASO 2 — Wikipedia
// =============================================================================
/**
 * Foto y enlace de un sitio, de la API de resúmenes de la Wikipedia en español.
 *
 * Devuelve null si no hay artículo, si no responde o si tarda demasiado. Que un
 * sitio no tenga foto es un detalle estético; que la investigación se caiga por
 * eso, no.
 */
export async function fichaDeWikipedia(titulo, { reintentar = true } = {}) {
  const url =
    'https://es.wikipedia.org/api/rest_v1/page/summary/' +
    encodeURIComponent(String(titulo).replace(/ /g, '_'));

  const control = new AbortController();
  const reloj = setTimeout(() => control.abort(), TIMEOUT_WIKI_MS);

  try {
    const respuesta = await fetch(url, {
      signal: control.signal,
      headers: { 'User-Agent': AGENTE, Accept: 'application/json' },
    });

    // 429 no es "no existe", es "vas muy rápido". Merece una segunda
    // oportunidad; un 404 no, porque el artículo no va a aparecer solo.
    if (respuesta.status === 429 && reintentar) {
      await dormir(ESPERA_TRAS_429_MS);
      return fichaDeWikipedia(titulo, { reintentar: false });
    }
    if (!respuesta.ok) return null; // 404: no hay artículo con ese título

    const datos = await respuesta.json();
    if (datos.type === 'disambiguation') return null; // página de desambiguación: no sirve

    return {
      wikipediaUrl: datos.content_urls?.desktop?.page ?? null,
      // thumbnail es la versión pequeña; originalimage suele ser enorme y aquí
      // solo se pinta una tarjeta.
      imagenUrl: datos.thumbnail?.source ?? null,
      extracto: datos.extract ?? null,
    };
  } catch {
    return null; // sin red, timeout o JSON raro: seguimos sin foto
  } finally {
    clearTimeout(reloj);
  }
}

/**
 * UNA SOLA PETICIÓN PARA TODOS LOS TÍTULOS DE UN IDIOMA.
 *
 * La API de resúmenes (`rest_v1/page/summary`) va de uno en uno: veinte sitios
 * eran veinte peticiones con su pausa, y encadenando tres ciudades seguidas
 * Wikipedia empieza a contestar 429 ("vas muy rápido"). La API de acción acepta
 * hasta 50 títulos de golpe y devuelve la miniatura y la URL de cada uno, así
 * que una ciudad entera cabe en una petición de tres décimas.
 *
 * `redirects=1` resuelve los títulos que solo fallan por poco, y las páginas de
 * desambiguación se descartan: "Basílica de Santa María" a secas es una lista de
 * basílicas, no un sitio.
 *
 * Devuelve un Map de título pedido -> { imagenUrl, wikipediaUrl }. El Map lleva
 * también los títulos normalizados y los redirigidos, porque la API responde con
 * el título final y hay que saber a quién corresponde.
 */
async function loteDeWikipedia(idioma, titulos) {
  if (!titulos.length) return new Map();

  const url = new URL(`https://${idioma}.wikipedia.org/w/api.php`);
  url.searchParams.set('action', 'query');
  url.searchParams.set('prop', 'pageimages|info|pageprops');
  url.searchParams.set('inprop', 'url');
  url.searchParams.set('ppprop', 'disambiguation');
  url.searchParams.set('piprop', 'thumbnail');
  url.searchParams.set('pithumbsize', '400');
  url.searchParams.set('pilimit', '50');
  url.searchParams.set('redirects', '1');
  url.searchParams.set('format', 'json');
  url.searchParams.set('formatversion', '2');
  url.searchParams.set('titles', titulos.join('|'));

  const control = new AbortController();
  const reloj = setTimeout(() => control.abort(), TIMEOUT_WIKI_MS);

  try {
    const respuesta = await fetch(url, {
      signal: control.signal,
      headers: { 'User-Agent': AGENTE, Accept: 'application/json' },
    });
    if (respuesta.status === 429) {
      await dormir(ESPERA_TRAS_429_MS);
      return new Map();
    }
    if (!respuesta.ok) return new Map();

    const datos = await respuesta.json();
    const paginas = datos.query?.pages ?? [];

    // De título final a ficha.
    const porTitulo = new Map();
    for (const pagina of paginas) {
      if (pagina.missing) continue;
      if (pagina.pageprops && 'disambiguation' in pagina.pageprops) continue;
      porTitulo.set(pagina.title, {
        imagenUrl: pagina.thumbnail?.source ?? null,
        wikipediaUrl: pagina.fullurl ?? null,
      });
    }

    // La API cuenta aparte lo que ha normalizado y lo que ha redirigido: hay que
    // deshacer ese camino para responder por el título que se pidió.
    const puente = new Map();
    for (const n of datos.query?.normalized ?? []) puente.set(n.from, n.to);
    for (const r of datos.query?.redirects ?? []) puente.set(r.from, r.to);

    const salida = new Map();
    for (const pedido of titulos) {
      let t = pedido;
      // Como mucho dos saltos: normalizado y luego redirigido.
      for (let vuelta = 0; vuelta < 3 && puente.has(t); vuelta += 1) t = puente.get(t);
      const ficha = porTitulo.get(t);
      if (ficha) salida.set(pedido, ficha);
    }
    return salida;
  } catch {
    return new Map();
  } finally {
    clearTimeout(reloj);
  }
}

/**
 * Pone foto y enlace a una lista de puntos.
 *
 * DOS WIKIPEDIAS, Y EN ESE ORDEN. Primero la española, que es la que se quiere
 * leer. Si el artículo no existe ahí, se prueba con el título en el idioma del
 * país, que es donde están los sitios que no son de primera fila: de veinte
 * sitios de Gdańsk, es.wikipedia tenía cero y pl.wikipedia trece. La foto es la
 * misma foto, y el enlace lleva al artículo que de verdad existe.
 *
 * Se piden en LOTES de 50, no de uno en uno: además de tardar veinte veces
 * menos, es lo que evita el 429 al encadenar tres ciudades seguidas.
 */
export async function ponerFotosDeWikipedia(puntos, alAvanzar = null) {
  if (!puntos.length) return 0;

  for (const punto of puntos) {
    punto.wikipedia_url = null;
    punto.imagen_url = null;
  }

  // Primera vuelta: español.
  const enEspanol = puntos.map((p) => p.titulo_wikipedia || p.nombre);
  const fichasEs = await loteDeWikipedia('es', [...new Set(enEspanol)].slice(0, TOPE_LOTE));
  puntos.forEach((punto, i) => {
    const ficha = fichasEs.get(enEspanol[i]);
    if (!ficha) return;
    punto.wikipedia_url = ficha.wikipediaUrl;
    punto.imagen_url = ficha.imagenUrl;
  });

  // Segunda vuelta: los que se han quedado sin foto, en el idioma del país.
  const pendientes = puntos.filter((p) => !p.imagen_url && p.titulo_wikipedia_local);
  const porIdioma = new Map();
  for (const punto of pendientes) {
    const idioma = String(punto.idioma_wikipedia_local || '').trim().toLowerCase();
    if (!/^[a-z]{2,3}$/.test(idioma) || idioma === 'es') continue;
    if (!porIdioma.has(idioma)) porIdioma.set(idioma, []);
    porIdioma.get(idioma).push(punto);
  }

  for (const [idioma, delIdioma] of porIdioma) {
    const titulos = delIdioma.map((p) => p.titulo_wikipedia_local);
    const fichas = await loteDeWikipedia(idioma, [...new Set(titulos)].slice(0, TOPE_LOTE));
    delIdioma.forEach((punto, i) => {
      const ficha = fichas.get(titulos[i]);
      if (!ficha?.imagenUrl) return;
      punto.imagen_url = ficha.imagenUrl;
      // El enlace español, si lo había, se respeta: se lee mejor.
      punto.wikipedia_url = punto.wikipedia_url ?? ficha.wikipediaUrl;
    });
  }

  const conFoto = puntos.filter((p) => p.imagen_url).length;
  alAvanzar?.(puntos.length, puntos.length);
  return conFoto;
}

/**
 * REPASO DE FOTOS DE SITIOS YA GUARDADOS.
 *
 * Las fichas que se generaron antes de que existiera el título en el idioma del
 * país se quedaron sin foto —de veinte sitios de Gdansk tenían tres— y como una
 * ciudad con sitios ya no se regenera, ahí se iban a quedar. Esto las repasa sin
 * tocar nada más: se le piden a la IA los títulos de Wikipedia de los que están
 * sin foto, se buscan en un lote y SOLO se rellena `imagen_url` donde estaba
 * vacía. No se borra ni se reescribe ninguna ficha.
 *
 * Devuelve cuántas fotos se han conseguido.
 */
export async function repasarFotosDeSitios(punto, nombrePais) {
  const sinFoto = todas(
    `SELECT id, nombre FROM sitios_lugar
      WHERE punto_interes_id = ? AND (imagen_url IS NULL OR imagen_url = '')`,
    punto.id
  );
  if (!sinFoto.length) return 0;

  let titulos = [];
  try {
    const r = await consultarJSON(
      `Estos lugares están en ${punto.nombre}${nombrePais ? ` (${nombrePais})` : ''}:\n` +
        sinFoto.map((s) => `- ${s.nombre}`).join('\n') +
        '\n\nPara cada uno dime el título EXACTO de su artículo en la Wikipedia en ' +
        'español y en la Wikipedia del idioma del país. Devuelve SOLO este JSON:\n' +
        '{"sitios": [{"nombre": "el nombre tal cual te lo he escrito", ' +
        '"titulo_wikipedia": "título en español o cadena vacía", ' +
        '"titulo_wikipedia_local": "título en el idioma del país o cadena vacía", ' +
        '"idioma_wikipedia_local": "código del idioma: pl, it, ja…"}]}\n' +
        'Si no estás seguro de un título, deja la cadena VACÍA: un título inventado ' +
        'no encuentra nada y es peor que el hueco.',
      { maxTokens: 3000, paso: `títulos de Wikipedia de ${punto.nombre}` }
    );
    titulos = Array.isArray(r?.sitios) ? r.sitios : [];
  } catch {
    return 0; // sin títulos no hay nada que buscar; se reintentará otro día
  }

  const porNombre = new Map(
    titulos
      .filter((t) => t && typeof t.nombre === 'string')
      .map((t) => [t.nombre.trim().toLowerCase(), t])
  );

  const puntos = sinFoto.map((s) => {
    const t = porNombre.get(s.nombre.trim().toLowerCase());
    return {
      id: s.id,
      nombre: s.nombre,
      titulo_wikipedia: textoONulo(t?.titulo_wikipedia) ?? s.nombre,
      titulo_wikipedia_local: textoONulo(t?.titulo_wikipedia_local),
      idioma_wikipedia_local: textoONulo(t?.idioma_wikipedia_local),
    };
  });

  await ponerFotosDeWikipedia(puntos);

  let puestas = 0;
  for (const s of puntos) {
    if (!s.imagen_url) continue;
    ejecutar(
      `UPDATE sitios_lugar
          SET imagen_url = ?, wikipedia_url = COALESCE(wikipedia_url, ?)
        WHERE id = ? AND (imagen_url IS NULL OR imagen_url = '')`,
      s.imagen_url,
      s.wikipedia_url ?? null,
      s.id
    );
    puestas += 1;
  }
  return puestas;
}

// =============================================================================
// GUARDAR
// =============================================================================
/**
 * Mete el destino y sus puntos en el catálogo.
 *
 * Es un upsert por (destino_id, nombre_norm), que es lo que hace que
 * "Actualizar" refresque la lista en vez de duplicarla: el Kioto de hoy es el
 * Kioto de la semana pasada, con los datos al día.
 *
 * Ojo con `investigado_en` de los PUNTOS: no se toca aquí. Ese campo dice si el
 * punto tiene ficha profunda (sus templos y barrios), y reinvestigar el país no
 * investiga cada ciudad. Se pisaría trabajo ya hecho.
 */
export function guardarInvestigacion(destinoId, { destino, puntos }) {
  const insertar = db.prepare(
    `INSERT INTO puntos_interes
       (destino_id, nombre, nombre_norm, categoria, ciudad_base, lat, lon,
        descripcion_corta, por_que, dias_recomendados_min, dias_recomendados_max,
        imagen_url, wikipedia_url, orden, datos_extra)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT (destino_id, nombre_norm) DO UPDATE SET
       nombre                = excluded.nombre,
       categoria             = excluded.categoria,
       ciudad_base           = excluded.ciudad_base,
       lat                   = excluded.lat,
       lon                   = excluded.lon,
       descripcion_corta     = excluded.descripcion_corta,
       por_que               = excluded.por_que,
       dias_recomendados_min = excluded.dias_recomendados_min,
       dias_recomendados_max = excluded.dias_recomendados_max,
       imagen_url            = excluded.imagen_url,
       wikipedia_url         = excluded.wikipedia_url,
       orden                 = excluded.orden,
       datos_extra           = excluded.datos_extra`
  );

  db.exec('BEGIN');
  try {
    ejecutar(
      `UPDATE destinos
          SET tipo = ?, pais = ?, lat = ?, lon = ?, resumen = ?, investigado_en = datetime('now')
        WHERE id = ?`,
      destino.tipo,
      destino.pais,
      destino.lat,
      destino.lon,
      destino.resumen,
      destinoId
    );

    for (const p of puntos) {
      insertar.run(
        destinoId,
        p.nombre,
        normalizarNombre(p.nombre),
        p.categoria,
        p.ciudad_base,
        p.lat,
        p.lon,
        p.descripcion_corta,
        p.por_que,
        p.dias_recomendados_min,
        p.dias_recomendados_max,
        p.imagen_url ?? null,
        p.wikipedia_url ?? null,
        p.orden,
        JSON.stringify({ tituloWikipedia: p.titulo_wikipedia ?? null })
      );
    }
    db.exec('COMMIT');
  } catch (err) {
    db.exec('ROLLBACK');
    throw err;
  }

  volcarDirecciones(destinoId, puntos);
  return puntos.length;
}

/**
 * Mete en el campo "dirección" de cada ficha la que haya dado la IA.
 *
 * PRE-RELLENADA Y EDITABLE, que es lo que se pedía: llega escrita para no tener
 * que teclearla, y se corrige a mano si viene mal.
 *
 * NO PISA NADA. Solo se rellenan las fichas que no tienen ninguna dirección
 * todavía. Volver a investigar un destino no puede borrar una calle que alguien
 * corrigió a mano; eso convertiría "Actualizar" en una trampa.
 *
 * Y no hay migración de lo viejo: las fichas de antes se quedan como están, con
 * su campo vacío y su botón de ponerla. Las nuevas generaciones ya la traen.
 *
 * Va fuera de la transacción a propósito: guardar una dirección encola su
 * geocodificación, y eso no tiene por qué estar dentro del BEGIN de los puntos.
 */
function volcarDirecciones(destinoId, puntos) {
  const conDireccion = puntos.filter((p) => p.direccion);
  if (!conDireccion.length) return;

  let puestas = 0;
  for (const p of conDireccion) {
    const fila = una(
      'SELECT id FROM puntos_interes WHERE destino_id = ? AND nombre_norm = ?',
      destinoId,
      normalizarNombre(p.nombre)
    );
    if (!fila) continue;
    if (direccionDe('punto', fila.id)) continue;   // ya tiene una: manda la suya

    guardarDireccion('punto', fila.id, p.direccion);
    puestas += 1;
  }

  if (puestas) {
    console.log(`[descubrir] ${puestas} dirección/es de la IA volcadas a las fichas.`);
  }
}

/** Números que llegan como texto, o como cualquier otra cosa. */
function numeroONulo(v) {
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
}

function enteroONulo(v) {
  const n = Number(v);
  return Number.isFinite(n) ? Math.max(0, Math.round(n)) : null;
}

function textoONulo(v) {
  const t = typeof v === 'string' ? v.trim() : '';
  return t || null;
}


// =============================================================================
// FICHA PROFUNDA de una ciudad o un sitio
// =============================================================================
/** Cuántos lugares se piden dentro de una ciudad. */
const CUANTOS_SITIOS = { min: 6, max: 10 };

/**
 * LAS CATEGORÍAS, y son una lista cerrada a propósito.
 *
 * Si se le deja inventar la etiqueta, la IA devuelve «museo», «museos», «Museos»
 * y «arte y cultura» para las mismas cuatro salas, y con eso no se puede filtrar
 * nada el día que haya filtros. Se le da la lista y lo que no esté en ella se
 * tira: mejor un sitio sin categoría que una categoría que no existe.
 */
export const CATEGORIAS_SITIO = [
  'monumentos',
  'museos',
  'naturaleza',
  'miradores',
  'barrios y paseos',
  'gastronomía',
  'ocio y parques',
  'compras y mercados',
];

/**
 * LOS BLOQUES, EN ORDEN DE PRIORIDAD.
 *
 * El orden no es decorativo: es el desempate. Un sitio no puede estar en dos
 * cajones, y cuando la IA repite —y repite, porque el Retiro es imprescindible
 * y además es un parque para niños— se queda en el primero de esta lista y se
 * cae de los demás.
 */
export const BLOQUES = ['imprescindibles', 'otros', 'ninos'];

/** Los nombres con los que se enseñan. La clave es fea a propósito: va en URLs. */
export const NOMBRE_DE_BLOQUE = {
  imprescindibles: 'Imprescindibles',
  otros: 'Otros sitios',
  ninos: 'Para niños',
  busqueda: 'Mis búsquedas',
};

/**
 * El prompt de la ficha profunda.
 *
 * Lo importante aquí es lo que se pide en `descripcion`: no un resumen de
 * enciclopedia — para eso ya está Wikipedia y el enlace — sino lo que te diría
 * alguien que ha estado: a qué hora ir, qué no perderse, dónde está la trampa.
 */
function promptDeCiudad(punto, nombreDestino, bloque, { excluir = [], edades = [], sesgo = null } = {}) {
  const queEs =
    punto.categoria === 'sitio'
      ? `${punto.nombre}, que se visita desde ${punto.ciudad_base || 'la ciudad más cercana'}`
      : `la ciudad de ${punto.nombre}`;

  // QUÉ SE PIDE EN CADA PASADA. Lo único que cambia entre los tres bloques es
  // este encargo y la cabecera; el formato y las reglas son los mismos, y así
  // el saneado de la respuesta es uno solo.
  const encargos = {
    imprescindibles:
      `Dame los ${CUANTOS_SITIOS.max} sitios que NO te puedes perder, los que justifican el viaje, ` +
      'ordenados de más a menos imprescindible.',
    otros:
      `Dame otros ${CUANTOS_SITIOS.max} sitios de SEGUNDO NIVEL: los que merecen la pena cuando ya ` +
      'has visto lo principal o tienes un día más. Nada de rellenar con lo obvio ni con sitios menores ' +
      'que no visitaría nadie: si no llegas a diez buenos, dame menos.',
    ninos:
      `Dame hasta ${CUANTOS_SITIOS.max} sitios PARA NIÑOS` +
      (edades.length ? ` de ${edades.join(' y ')} años` : '') +
      '. Y esto es lo importante: cosas PENSADAS para niños —zoo, acuario, parque de atracciones, ' +
      'museo de la ciencia con cosas que se tocan, parque con juegos, tren turístico, taller infantil—, ' +
      'no monumentos que un niño puede ver sin quejarse. Una catedral no es un sitio para niños. ' +
      'Si en esta ciudad no hay diez de verdad, dame los que haya.',
  };

  const evitar = excluir.length
    ? [
        '',
        'NO REPITAS ninguno de estos, que ya te he cogido antes:',
        ...excluir.map((n) => `- ${n}`),
        'Si el mejor candidato ya está en esa lista, salta al siguiente.',
      ].join('\n')
    : '';

  const conNinos =
    bloque === 'ninos' && edades.length
      ? `\nLos niños del viaje tienen ${edades.join(' y ')} años: ajusta lo que propongas a esas edades.`
      : '';

  return `Eres un guía de viajes con experiencia real en ${nombreDestino}.

Háblame de ${queEs}.

${encargos[bloque]}${conNinos}
${evitar}

Devuelve un objeto JSON con esta forma exacta:

{${
    bloque === 'imprescindibles'
      ? `
  "parrafo_por_que": "4-5 frases sobre por qué merece la pena venir aquí. Concreto, nada de tópicos de folleto.",
  "como_moverse": "1-2 frases: cómo se mueve uno por aquí (metro, a pie, autobús, bici, coche de alquiler).",`
      : ''
  }
  "sitios": [
    {
      "nombre": "nombre en español del lugar concreto",
      "descripcion": "3-4 frases. Qué es, y CONSEJO PRÁCTICO: a qué hora ir para evitar colas o pillar buena luz, qué es lo que no te puedes perder de dentro, cuánto tiempo hace falta.",
      "categoria": "una sola de esta lista, copiada tal cual: ${CATEGORIAS_SITIO.join(' | ')}",
      "lat": número, "lon": número,
      "titulo_wikipedia": "título EXACTO del artículo en la Wikipedia en español",
      "titulo_wikipedia_local": "título EXACTO del mismo artículo en la Wikipedia del idioma del país",
      "idioma_wikipedia_local": "código de ese idioma: pl, it, ja, de…"
    }
  ]
}

${sesgo ? `
${sesgo}
` : ''}
Reglas:
- TODO tiene que estar en ${punto.nombre} o a menos de una hora de viaje. Nada de
  otras ciudades del país por muy conocidas que sean: quien lee esto se aloja en
  ${punto.nombre} y tiene tres días. Si un sitio famoso queda a media jornada de
  distancia, déjalo fuera.
- Sitios CONCRETOS que se visitan: templos, barrios, mercados, miradores, museos, parques. Nada de "la gastronomía" ni "el ambiente".
- Los nombres, EN ESPAÑOL siempre que exista la forma española ("Museo del Louvre", no "Musée du Louvre").
- UN NOMBRE ES UN SITIO. El nombre del lugar y nada más: sin coletillas de
  ciudad y sin alternativas entre paréntesis. "Odeón de Herodes Ático", no
  "Teatro de Epidauro en Atenas (Odeón de Herodes Ático)". Si al escribirlo te
  das cuenta de que el sitio que tenías en la cabeza está en otra ciudad, NO lo
  rebautices con el de aquí: quítalo y pon otro. Y no añadas "en ${punto.nombre}",
  que ya sé dónde estamos: todo lo de esta lista está ahí.
- "categoria" tiene que ser UNA de las de la lista, escrita igual. Si dudas, elige la que más se acerque; no te inventes otra.
- lat y lon son obligatorios y tienen que ser las coordenadas reales del sitio.
- "titulo_wikipedia_local" es el mismo artículo en la Wikipedia del país, escrito EXACTO.
  De ahí sale la foto de la ficha: fuera de los sitios muy famosos, la Wikipedia en
  español no los tiene y la del país sí. Si no estás seguro del título, deja la cadena VACÍA.
- No inventes URLs: las busco yo aparte.`;
}

/**
 * Le pregunta a la IA por el interior de una ciudad y devuelve la ficha ya
 * saneada. Lo que venga con una forma rara se queda fuera.
 */
/** La categoría solo vale si es una de las de la lista. Lo demás, a null. */
function categoriaValida(v) {
  const t = String(v ?? '').trim().toLowerCase();
  return CATEGORIAS_SITIO.includes(t) ? t : null;
}

/**
 * UN NOMBRE, UN SITIO.
 *
 * En la Grecia del correctivo salió «Teatro de Epidauro en Atenas (Odeón de
 * Herodes Ático)». Lo que pasó se lee en el propio nombre: la IA pensó en un
 * sitio que está a dos horas, chocó con la regla de la hora, y en vez de quitarlo
 * lo rebautizó con el equivalente de aquí sin borrar el nombre viejo. Eso no es
 * un sitio, son dos pegados.
 *
 * NO se toca el nombre: decidir cuál de los dos es el bueno sería adivinar, y
 * adivinar es justo lo que produjo el nombre. Pero se deja dicho en el registro,
 * que es lo único que faltó para verlo cuando pasó.
 */
function avisarDeNombresMezclados(sitios, ciudad) {
  const cola = ` en ${ciudad}`.toLowerCase();
  for (const s of sitios) {
    if (!s.nombre.toLowerCase().includes(cola)) continue;
    console.warn(
      `[descubrir] Nombre sospechoso en ${ciudad}: «${s.nombre}»` +
        (s.nombre.includes('(') ? ' — parece dos sitios pegados.' : ' — le sobra la coletilla de ciudad.')
    );
  }
}

/** Una pasada: se le pide un bloque y se sanea lo que conteste. */
async function pedirUnBloque(punto, nombreDestino, bloque, opciones) {
  const respuesta = await consultarJSON(promptDeCiudad(punto, nombreDestino, bloque, opciones), {
    paso: `investigar «${punto.nombre}» · ${bloque}`,
    maxTokens: 6000,
  });

  const crudos = Array.isArray(respuesta?.sitios) ? respuesta.sitios : [];
  const limpios = crudos
    .filter((s) => s && typeof s.nombre === 'string' && s.nombre.trim())
    .map((s) => ({
      nombre: String(s.nombre).trim(),
      descripcion: textoONulo(s.descripcion),
      categoria: categoriaValida(s.categoria),
      lat: numeroONulo(s.lat),
      lon: numeroONulo(s.lon),
      titulo_wikipedia: s.titulo_wikipedia
        ? String(s.titulo_wikipedia).trim()
        : String(s.nombre).trim(),
      titulo_wikipedia_local: textoONulo(s.titulo_wikipedia_local),
      idioma_wikipedia_local: textoONulo(s.idioma_wikipedia_local),
      bloque,
    }));

  avisarDeNombresMezclados(limpios, punto.nombre);

  return {
    parrafoPorQue: textoONulo(respuesta?.parrafo_por_que),
    comoMoverse: textoONulo(respuesta?.como_moverse),
    sitios: limpios,
  };
}

/**
 * Le pregunta a la IA por el interior de una ciudad y devuelve la ficha ya
 * saneada. Lo que venga con una forma rara se queda fuera.
 *
 * TRES LLAMADAS Y NO UNA. Se le podría pedir todo de golpe, y sería una llamada
 * menos, pero pidiendo veinte o treinta sitios repartidos en cajones en una sola
 * respuesta pasan dos cosas: la respuesta se corta por el límite de tokens justo
 * en el último bloque —que casualmente es el de niños—, y los bloques se
 * contaminan entre ellos. Encadenadas se puede además DECIRLE lo que ya se ha
 * cogido, que es la única forma de que no repita.
 *
 * Y aun diciéndoselo repite, así que la regla dura no se delega: se aplica aquí
 * con `nombre_norm`, y el duplicado cae del bloque menos prioritario.
 *
 * Si falla una pasada que no sea la primera, se sigue con lo que haya. Quedarse
 * sin "otros sitios" es una pena; quedarse sin ficha por eso, una tontería.
 */
export async function investigarCiudadConIA(
  punto,
  nombreDestino,
  { edadesNinos = [], sesgo = null } = {}
) {
  const quiero = ['imprescindibles', 'otros'];
  if (edadesNinos.length) quiero.push('ninos');

  const vistos = new Set();
  const sitios = [];
  let parrafoPorQue = null;
  let comoMoverse = null;

  for (const bloque of quiero) {
    let tanda;
    try {
      tanda = await pedirUnBloque(punto, nombreDestino, bloque, {
        excluir: sitios.map((s) => s.nombre),
        edades: edadesNinos,
        // Lo que le interesa a quien viaja. Llega solo desde el orquestador: en
        // el flujo manual nadie ha declarado intereses todavía, y va vacío.
        sesgo,
      });
    } catch (err) {
      // El primero es obligatorio: sin imprescindibles no hay ficha. Los otros
      // dos son mejoras, y una mejora que falla no tumba lo que ya funciona.
      if (bloque === 'imprescindibles') throw err;
      console.warn(`[descubrir] «${punto.nombre}»: sin bloque «${bloque}» (${err.message}).`);
      continue;
    }

    if (bloque === 'imprescindibles') {
      parrafoPorQue = tanda.parrafoPorQue;
      comoMoverse = tanda.comoMoverse;
    }

    // El tope se aplica aquí y no en el prompt: pedir diez y quedarse con los
    // diez primeros es más fiable que confiar en que cuente, que a veces devuelve
    // once y a veces trece. Se cuentan DESPUÉS de descartar duplicados, para que
    // un repetido no le robe la plaza a un sitio bueno.
    let puestos = 0;
    for (const s of tanda.sitios) {
      if (puestos >= CUANTOS_SITIOS.max) break;
      const clave = normalizarNombre(s.nombre);
      if (vistos.has(clave)) {
        console.log(`[descubrir] «${s.nombre}» repetido en «${bloque}»: se queda donde estaba.`);
        continue;
      }
      vistos.add(clave);
      sitios.push({ ...s, orden: sitios.length + 1 });
      puestos += 1;
    }
  }

  if (!sitios.length) {
    throw new Error(`La IA no devolvió ningún lugar dentro de «${punto.nombre}».`);
  }

  return { parrafoPorQue, comoMoverse, sitios };
}

/**
 * Guarda la ficha profunda.
 *
 * Los sitios van por upsert con clave (punto_interes_id, nombre_norm), igual
 * que los puntos con su destino: reinvestigar refresca, no duplica.
 *
 * El párrafo y el "cómo moverse" van a `datos_extra` del punto y no a columnas
 * propias porque son texto suelto de una sola ficha, y añadir una columna por
 * cada cosa que se le ocurra pedirle a la IA acabaría en una tabla de treinta
 * columnas medio vacías.
 *
 * OJO: se conserva lo que ya hubiera en datos_extra (el tituloWikipedia que
 * guardó la investigación del destino), no se pisa entero.
 */
export function guardarFichaProfunda(punto, ficha) {
  const insertar = db.prepare(
    `INSERT INTO sitios_lugar
       (punto_interes_id, nombre, nombre_norm, descripcion, imagen_url, wikipedia_url,
        lat, lon, orden, bloque, categoria)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT (punto_interes_id, nombre_norm) DO UPDATE SET
       nombre        = excluded.nombre,
       descripcion   = excluded.descripcion,
       imagen_url    = excluded.imagen_url,
       wikipedia_url = excluded.wikipedia_url,
       lat           = excluded.lat,
       lon           = excluded.lon,
       orden         = excluded.orden,
       bloque        = excluded.bloque,
       -- La categoría solo se pisa si viene una nueva: una respuesta sin
       -- categoría no debe borrar la que ya estaba bien puesta.
       categoria     = COALESCE(excluded.categoria, sitios_lugar.categoria)`
  );

  const anterior = punto.datos_extra ? seguroJSON(punto.datos_extra) : {};

  db.exec('BEGIN');
  try {
    ejecutar(
      'UPDATE puntos_interes SET datos_extra = ? WHERE id = ?',
      JSON.stringify({
        ...anterior,
        parrafoPorQue: ficha.parrafoPorQue,
        comoMoverse: ficha.comoMoverse,
      }),
      punto.id
    );

    for (const s of ficha.sitios) {
      insertar.run(
        punto.id,
        s.nombre,
        normalizarNombre(s.nombre),
        s.descripcion,
        s.imagen_url ?? null,
        s.wikipedia_url ?? null,
        s.lat,
        s.lon,
        s.orden,
        s.bloque ?? 'imprescindibles',
        s.categoria ?? null
      );
    }
    db.exec('COMMIT');
  } catch (err) {
    db.exec('ROLLBACK');
    throw err;
  }

  return ficha.sitios.length;
}

/**
 * Todo lo que necesita la pantalla de la ficha, de una vez.
 *
 * Devuelve null si el punto no existe. `estado` dice si la ficha está completa,
 * completándose o sin empezar: la pantalla enseña lo que haya en los tres
 * casos, que es la gracia.
 */
export function fichaDeUnPunto(puntoId, viajeId = null) {
  const punto = una('SELECT * FROM puntos_interes WHERE id = ?', puntoId);
  if (!punto) return null;

  const destino = una('SELECT * FROM destinos WHERE id = ?', punto.destino_id);
  const sitios = todas(
    'SELECT * FROM sitios_lugar WHERE punto_interes_id = ? ORDER BY orden, id',
    puntoId
  );

  const extra = punto.datos_extra ? seguroJSON(punto.datos_extra) : {};

  // Las excursiones solo tienen sentido para una ciudad: de un mirador no hay
  // free tours. Y se leen del CATÁLOGO, no del viaje: son de la ciudad.
  const ciudadDeExcursiones =
    punto.categoria === 'ciudad' ? punto.nombre : punto.ciudad_base || null;
  const excursiones =
    punto.categoria === 'ciudad' && ciudadDeExcursiones
      ? actividadesDeCiudad(ciudadDeExcursiones)
      : [];

  const enCurso = una(
    `SELECT * FROM trabajos
      WHERE tipo = 'investigar_ciudad' AND referencia_id = ? AND estado IN ('pendiente','en_curso')
      ORDER BY id DESC LIMIT 1`,
    puntoId
  );
  const ultimo = una(
    `SELECT * FROM trabajos WHERE tipo = 'investigar_ciudad' AND referencia_id = ? ORDER BY id DESC LIMIT 1`,
    puntoId
  );

  // Igual que en el mapa: de una ciudad, "estar añadido" es estar APUNTADO
  // dentro de su parada, no ser una parada.
  const esCiudad = destino?.tipo === 'ciudad';

  const enRuta = viajeId
    ? esCiudad
      ? una(
          `SELECT c.id FROM candidatos c
             JOIN etapas e ON e.id = c.etapa_id
            WHERE c.viaje_id = ? AND c.tipo = 'sitio' AND e.destino_id = ?
              AND ((c.url IS NOT NULL AND c.url = ?) OR (c.url IS NULL AND c.titulo = ?))`,
          viajeId,
          destino.id,
          punto.wikipedia_url,
          punto.nombre
        )
      : una('SELECT * FROM etapas WHERE viaje_id = ? AND punto_interes_id = ?', viajeId, puntoId)
    : null;

  return {
    punto,
    destino,
    sitios,
    excursiones,
    parrafoPorQue: extra.parrafoPorQue ?? null,
    comoMoverse: extra.comoMoverse ?? null,
    estado: enCurso
      ? 'completando'
      : punto.investigado_en
        ? 'hecha'
        : ultimo?.estado === 'error'
          ? 'error'
          : 'sin_investigar',
    mensajeError: !enCurso && ultimo?.estado === 'error' ? ultimo.mensaje_error : null,
    enRuta: Boolean(enRuta),
    esCiudad,
  };
}

/** JSON.parse que no revienta la pantalla si un datos_extra viejo viene raro. */
function seguroJSON(texto) {
  try {
    return JSON.parse(texto) ?? {};
  } catch {
    return {};
  }
}

// =============================================================================
// LECTURA para la pantalla
// =============================================================================
/**
 * Borra lo que sabemos de un destino para volver a investigarlo desde cero.
 *
 * "Actualizar" hace un upsert: refresca lo que hay y deja lo demás. Esto es
 * distinto: borra los puntos, y por eso existe. Un destino investigado cuando
 * el prompt mezclaba ciudades con monumentos no se arregla refrescando, porque
 * la Sagrada Familia seguiría ahí; hay que tirarlo y empezar otra vez.
 *
 * Se lleva por delante también las fichas profundas de esos puntos
 * (`sitios_lugar` cuelga de ellos con ON DELETE CASCADE) y las etapas que los
 * usaran quedan con `punto_interes_id` a null, no se borran: la parada del
 * viaje sigue siendo tuya aunque el catálogo se rehaga.
 */
export function olvidarInvestigacion(destinoId) {
  const cuantos = una(
    'SELECT COUNT(*) AS n FROM puntos_interes WHERE destino_id = ?',
    destinoId
  ).n;

  ejecutar('DELETE FROM puntos_interes WHERE destino_id = ?', destinoId);
  ejecutar('UPDATE destinos SET investigado_en = NULL WHERE id = ?', destinoId);
  return { borrados: cuantos };
}

/**
 * Todo lo que necesita la pantalla de descubrir, en una llamada.
 * Cada punto viene ya con su estado ('sin_investigar' | 'investigando' |
 * 'investigada'), que es lo que decide el color del marcador y el botón de la
 * tarjeta.
 */
export function panoramaDeDestino(destinoId, viajeId = null) {
  const destino = una('SELECT * FROM destinos WHERE id = ?', destinoId);
  if (!destino) return null;

  const puntos = todas(
    'SELECT * FROM puntos_interes WHERE destino_id = ? ORDER BY orden, id',
    destinoId
  );

  // Qué puntos se están investigando ahora mismo.
  const enCurso = new Set(
    todas(
      `SELECT referencia_id FROM trabajos
        WHERE tipo = 'investigar_ciudad' AND estado IN ('pendiente','en_curso')`
    ).map((t) => t.referencia_id)
  );

  // QUÉ SIGNIFICA "AÑADIR" AQUÍ DEPENDE DEL NIVEL DEL DESTINO.
  //
  // De un país, los resultados son ciudades: cada una puede ser una PARADA, y
  // "estar añadido" quiere decir que hay una etapa suya.
  //
  // De una ciudad, los resultados son sitios de dentro (el Prado, el Retiro):
  // ninguno es una parada, la parada es la ciudad. Ahí "estar añadido" quiere
  // decir que el sitio está APUNTADO como candidato dentro de la etapa de esa
  // ciudad. Confundir las dos cosas es lo que llenaba la ruta de candidatos
  // llamados "Madrid, Madrid, Madrid".
  const esCiudad = destino.tipo === 'ciudad';

  const enRuta = new Set(
    viajeId && !esCiudad
      ? todas(
          'SELECT punto_interes_id FROM etapas WHERE viaje_id = ? AND punto_interes_id IS NOT NULL',
          viajeId
        ).map((e) => e.punto_interes_id)
      : []
  );

  // Para una ciudad: lo ya apuntado dentro de su etapa. La clave es la misma
  // que usa "me lo apunto": la url si la hay, y el título si no.
  const apuntados = new Set(
    viajeId && esCiudad
      ? todas(
          `SELECT c.url, c.titulo FROM candidatos c
             JOIN etapas e ON e.id = c.etapa_id
            WHERE c.viaje_id = ? AND c.tipo = 'sitio' AND e.destino_id = ?`,
          viajeId,
          destino.id
        ).map((c) => c.url || `titulo:${c.titulo}`)
      : []
  );

  return {
    destino,
    // `esCiudad` es lo que decide el texto y la acción del botón de la tarjeta.
    esCiudad,
    puntos: puntos.map((p) => ({
      ...p,
      estado: enCurso.has(p.id) ? 'investigando' : p.investigado_en ? 'investigada' : 'sin_investigar',
      enRuta: esCiudad
        ? apuntados.has(p.wikipedia_url || `titulo:${p.nombre}`)
        : enRuta.has(p.id),
    })),
  };
}
