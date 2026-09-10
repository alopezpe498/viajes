/**
 * services/clima.js
 * -----------------------------------------------------------------------------
 * EL TIEMPO, EN DOS CAPAS QUE NO SON LA MISMA PREGUNTA.
 *
 *   NIVEL 1 · «¿Qué ropa meto?»
 *     Qué suele hacer en esas fechas del año. Sale del ARCHIVO HISTÓRICO de
 *     Open-Meteo: mediciones reales de los últimos años, no un modelo. Se
 *     calcula una vez con la ficha del país y ya no cambia —lo que hizo en
 *     Atenas la última semana de septiembre de 2021 a 2025 no se va a mover—.
 *
 *   NIVEL 2 · «¿Qué está pasando allí ahora?»
 *     La previsión de los próximos días. No tiene nada que ver con las fechas
 *     del viaje: sirve para asomarse al destino un martes cualquiera aunque
 *     falten cuatro meses. Por eso se refresca a botón y lleva su hora de
 *     actualización a la vista.
 *
 * CADA CIUDAD CON SUS FECHAS, NO CON LAS DEL VIAJE. Una ruta de tres semanas
 * puede empezar en septiembre y acabar en octubre, y en ese caso la primera
 * parada y la última no tienen el mismo clima. Se usa el rango de cada etapa, y
 * el del viaje solo como respaldo cuando la parada aún no tiene fechas.
 *
 * OPEN-METEO ES GRATUITO Y SIN CLAVE, pero no es infinito: por eso todo lo que
 * se consulta se guarda (`clima_tipico`, `clima_ahora`) y una segunda ficha del
 * mismo sitio no vuelve a pedir nada.
 *
 * Y NADA DE ESTO TUMBA LA FICHA. Si Open-Meteo no contesta, el bloque se queda
 * vacío y los visados, las vacunas y la moneda salen igual: es la misma regla
 * que ya siguen Exteriores y los festivos.
 */
import { todas, una, ejecutar, normalizarNombre } from '../db/index.js';
import { parametro } from './orquestador.js';

/** Ni una consulta se queda colgada para siempre. */
const TIMEOUT_MS = 12_000;
const AGENTE = 'CreadorViajes/0.1 (uso personal)';

/** Petición con plazo. Devuelve el JSON, o revienta con un motivo legible. */
async function pedir(url) {
  const control = new AbortController();
  const reloj = setTimeout(() => control.abort(), TIMEOUT_MS);
  try {
    const r = await fetch(url, {
      signal: control.signal,
      headers: { 'User-Agent': AGENTE, Accept: 'application/json' },
    });
    if (!r.ok) throw new Error(`Open-Meteo respondió ${r.status}`);
    return await r.json();
  } catch (err) {
    if (err.name === 'AbortError') throw new Error('Open-Meteo tardó demasiado');
    throw err;
  } finally {
    clearTimeout(reloj);
  }
}

// =============================================================================
// LAS CIUDADES DE UN PAÍS EN ESTE VIAJE
// =============================================================================
/**
 * Las paradas de un país, con sus fechas y sus coordenadas.
 *
 * Las coordenadas se buscan primero donde ya están —el destino o el punto de
 * interés del catálogo—, y solo si no hay se geocodifica. Es la misma escalera
 * que usa `paisesDelViaje` para el código de país, y por el mismo motivo: pedir
 * lo que ya se sabe es tiempo tirado.
 */
export async function ciudadesDelPais(viajeId, paisNorm, { fechaInicio, fechaFin } = {}) {
  const etapas = todas(
    `SELECT e.id, e.nombre_ciudad, e.orden, e.pais, e.fecha_inicio, e.fecha_fin,
            d.lat AS lat_destino, d.lon AS lon_destino,
            pi.lat AS lat_punto,  pi.lon AS lon_punto
       FROM etapas e
       LEFT JOIN destinos d        ON d.id  = e.destino_id
       LEFT JOIN puntos_interes pi ON pi.id = e.punto_interes_id
      WHERE e.viaje_id = ? AND e.estado = 'confirmada'
      ORDER BY e.orden, e.id`,
    viajeId
  ).filter((e) => !paisNorm || normalizarNombre(e.pais ?? '') === paisNorm);

  const salida = [];
  const vistas = new Set();

  for (const e of etapas) {
    const norm = normalizarNombre(e.nombre_ciudad);
    if (vistas.has(norm)) continue; // una ciudad repetida en la ruta es la misma ciudad
    vistas.add(norm);

    let lat = e.lat_punto ?? e.lat_destino ?? null;
    let lon = e.lon_punto ?? e.lon_destino ?? null;

    if (lat == null || lon == null) {
      const guardada = una(
        'SELECT lat, lon FROM clima_ahora WHERE ciudad_norm = ? AND lat IS NOT NULL',
        norm
      );
      lat = guardada?.lat ?? lat;
      lon = guardada?.lon ?? lon;
    }

    if (lat == null || lon == null) {
      try {
        const sitio = await situarCiudad(e.nombre_ciudad);
        lat = sitio.lat;
        lon = sitio.lon;
      } catch (err) {
        console.warn(`[clima] no pude situar «${e.nombre_ciudad}»: ${err.message}`);
        continue; // sin coordenadas no hay nada que preguntar
      }
    }

    salida.push({
      etapaId: e.id,
      ciudad: e.nombre_ciudad,
      norm,
      lat,
      lon,
      // LAS FECHAS DE ESTA PARADA, que son las que deciden qué tiempo hace aquí.
      desde: e.fecha_inicio ?? fechaInicio ?? null,
      hasta: e.fecha_fin ?? fechaFin ?? null,
    });
  }

  return salida;
}

/** Nombre de ciudad -> coordenadas, con el geocodificador de Open-Meteo. */
async function situarCiudad(ciudad) {
  const d = await pedir(
    'https://geocoding-api.open-meteo.com/v1/search' +
      `?name=${encodeURIComponent(ciudad)}&count=1&language=es&format=json`
  );
  const s = d?.results?.[0];
  if (!s) throw new Error(`Open-Meteo no encuentra «${ciudad}»`);
  return { lat: s.latitude, lon: s.longitude };
}

// =============================================================================
// NIVEL 1 — QUÉ SUELE HACER EN ESAS FECHAS
// =============================================================================
const MESES = ['enero', 'febrero', 'marzo', 'abril', 'mayo', 'junio',
  'julio', 'agosto', 'septiembre', 'octubre', 'noviembre', 'diciembre'];

/**
 * «Finales de septiembre», que es como se habla de unas fechas.
 *
 * Un rango escrito con sus dos días completos —«del 24 al 30 de septiembre»— no
 * aporta nada aquí: el dato es estadístico y no va a distinguir el 24 del 25.
 * Lo que importa es en qué parte del mes cae.
 */
function comoEpoca(desde, hasta) {
  if (!desde) return null;
  const [, m1, d1] = desde.slice(0, 10).split('-').map(Number);
  const m2 = hasta ? Number(hasta.slice(5, 7)) : m1;

  // A caballo entre dos meses: se dicen los dos y se acabó.
  if (m2 !== m1) return `entre ${MESES[m1 - 1]} y ${MESES[m2 - 1]}`;

  const parte = d1 <= 10 ? 'principios' : d1 <= 20 ? 'mediados' : 'finales';
  return `${parte} de ${MESES[m1 - 1]}`;
}

/** Los "MM-DD" que cubre el viaje, para quedarse solo con esos días del archivo. */
function diasDelAno(desde, hasta) {
  const dias = new Set();
  const fin = new Date(`${(hasta ?? desde).slice(0, 10)}T12:00:00Z`);
  const d = new Date(`${desde.slice(0, 10)}T12:00:00Z`);

  // Tope de seguridad: un viaje de más de un año no existe, y sin él un rango
  // mal guardado daría un bucle infinito.
  for (let i = 0; d <= fin && i < 366; i++) {
    dias.add(d.toISOString().slice(5, 10));
    d.setUTCDate(d.getUTCDate() + 1);
  }
  return dias;
}

/** Cómo se cuenta la lluvia esperable, según en cuántos días de cada diez cayó. */
function comoLluvia(proporcion) {
  const pct = Math.round(proporcion * 100);
  if (pct < 15) return { texto: 'lluvia poco probable', pct };
  if (pct < 35) return { texto: 'algún chubasco suelto', pct };
  if (pct < 60) return { texto: 'llueve a menudo', pct };
  return { texto: 'llueve casi a diario', pct };
}

/**
 * QUÉ TIEMPO SUELE HACER en una ciudad en esas fechas.
 *
 * UNA SOLA PETICIÓN POR CIUDAD, no una por año. El archivo acepta un rango
 * largo, así que se piden los cinco años enteros de una vez y se filtran aquí
 * los días que caen dentro de la ventana del viaje. Son cincuenta kilobytes y
 * una llamada, en vez de cinco llamadas; y filtrar por «MM-DD» resuelve solo el
 * caso feo, que es un viaje de fin de año cruzando de diciembre a enero.
 */
export async function climaTipicoDeCiudad({ ciudad, norm, lat, lon, desde, hasta }) {
  if (!desde) return null;

  const guardado = una(
    'SELECT * FROM clima_tipico WHERE ciudad_norm = ? AND fecha_inicio IS ? AND fecha_fin IS ?',
    norm,
    desde,
    hasta ?? null
  );
  if (guardado) return leerDatos(guardado.datos);

  const anos = Math.max(1, parametro('anos_historico_clima', 5));

  // EL ARCHIVO ACABA HACE UNOS DÍAS, NO EN NOCHEVIEJA.
  //
  // La primera versión pedía «del año del viaje menos cinco al año del viaje
  // menos uno», y con un viaje de 2027 eso es pedir hasta el 31/12/2026: una
  // fecha que todavía no ha pasado. Open-Meteo contesta 400 y el bloque se
  // quedaba vacío justo en el caso normal, que es planificar con meses de
  // antelación. Se pide siempre hasta hace una semana —el archivo lleva unos
  // días de retraso— y desde ahí hacia atrás, que es un rango que existe
  // siempre y que además incluye el año en curso.
  const hasta_ = new Date(Date.now() - 6 * 86_400_000).toISOString().slice(0, 10);
  const desde_ = `${Number(hasta_.slice(0, 4)) - anos}-01-01`;

  const d = await pedir(
    'https://archive-api.open-meteo.com/v1/archive' +
      `?latitude=${lat}&longitude=${lon}` +
      `&start_date=${desde_}&end_date=${hasta_}` +
      '&daily=temperature_2m_max,temperature_2m_min,precipitation_sum&timezone=auto'
  );

  const fechas = d?.daily?.time ?? [];
  if (!fechas.length) throw new Error('el archivo histórico no devolvió datos');

  const ventana = diasDelAno(desde, hasta ?? desde);
  const maximas = [];
  const minimas = [];
  const lluvias = [];

  for (let i = 0; i < fechas.length; i++) {
    if (!ventana.has(fechas[i].slice(5, 10))) continue;
    const max = d.daily.temperature_2m_max[i];
    const min = d.daily.temperature_2m_min[i];
    const mm = d.daily.precipitation_sum[i];
    if (max != null) maximas.push(max);
    if (min != null) minimas.push(min);
    if (mm != null) lluvias.push(mm);
  }

  if (!maximas.length) throw new Error('el archivo no cubre esas fechas');

  const media = (xs) => xs.reduce((a, b) => a + b, 0) / xs.length;
  const maxMedia = Math.round(media(maximas));
  const minMedia = Math.round(media(minimas));
  const conLluvia = lluvias.filter((mm) => mm >= 1).length;
  const lluvia = comoLluvia(lluvias.length ? conLluvia / lluvias.length : 0);
  const epoca = comoEpoca(desde, hasta);

  // «-4-1°» NO SE LEE. Con una mínima bajo cero el guion del rango se pega al
  // del número y sale un jeroglífico: Reikiavik en enero salía «-4-1°». Cuando
  // hay negativos se escribe con todas las letras.
  const rango = minMedia < 0 ? `de ${minMedia}° a ${maxMedia}°` : `${minMedia}-${maxMedia}°`;

  const datos = {
    ciudad,
    epoca,
    maxMedia,
    minMedia,
    rango,
    lluviaPct: lluvia.pct,
    lluviaTexto: lluvia.texto,
    // Cuántos años de verdad hay detrás: 35 días son 7 días × 5 años.
    anos: Math.max(1, Math.round(maximas.length / Math.max(1, ventana.size))),
    dias: maximas.length,
    // LA LÍNEA, ARMADA AQUÍ Y NO EN LA PANTALLA. Es el dato, no una decoración:
    // así sale igual en el panel y el día que se meta en el dosier.
    linea: `${ciudad}${epoca ? `, ${epoca}` : ''}: ${rango}, ${lluvia.texto}`,
  };

  ejecutar(
    `INSERT INTO clima_tipico (ciudad_norm, fecha_inicio, fecha_fin, ciudad, lat, lon, datos, generado_en)
     VALUES (?, ?, ?, ?, ?, ?, ?, datetime('now'))
     ON CONFLICT (ciudad_norm, fecha_inicio, fecha_fin) DO UPDATE SET
       ciudad = excluded.ciudad, lat = excluded.lat, lon = excluded.lon,
       datos = excluded.datos, generado_en = excluded.generado_en`,
    norm,
    desde,
    hasta ?? null,
    ciudad,
    lat,
    lon,
    JSON.stringify(datos)
  );

  return datos;
}

/**
 * El nivel 1 de todas las paradas de un país. Se llama al generar la ficha.
 *
 * Una ciudad que falle no se lleva a las demás: se queda fuera de la lista y ya
 * está. Un bloque con dos de tres ciudades sigue sirviendo.
 */
export async function asegurarClimaTipico(viajeId, paisNorm, { fechaInicio, fechaFin } = {}) {
  const ciudades = await ciudadesDelPais(viajeId, paisNorm, { fechaInicio, fechaFin });
  const lineas = [];

  for (const c of ciudades) {
    try {
      const d = await climaTipicoDeCiudad(c);
      if (d) lineas.push(d);
    } catch (err) {
      console.warn(`[clima] sin histórico de ${c.ciudad}: ${err.message}`);
    }
  }

  return lineas;
}

// =============================================================================
// NIVEL 2 — QUÉ ESTÁ PASANDO ALLÍ AHORA
// =============================================================================
/**
 * Los códigos de la OMM, traducidos a lo que uno diría mirando por la ventana.
 *
 * No están todos: los que faltan caen en «—», que es mejor que inventarse un
 * nombre para un código raro. Los iconos son los de Tabler, que ya usa la app.
 */
const TIEMPO = {
  0: ['Despejado', 'ti-sun'],
  1: ['Casi despejado', 'ti-sun'],
  2: ['Nubes y claros', 'ti-cloud-filled'],
  3: ['Nublado', 'ti-cloud'],
  45: ['Niebla', 'ti-mist'],
  48: ['Niebla helada', 'ti-mist'],
  51: ['Llovizna', 'ti-cloud-rain'],
  53: ['Llovizna', 'ti-cloud-rain'],
  55: ['Llovizna fuerte', 'ti-cloud-rain'],
  61: ['Lluvia débil', 'ti-cloud-rain'],
  63: ['Lluvia', 'ti-cloud-rain'],
  65: ['Lluvia fuerte', 'ti-cloud-storm'],
  66: ['Lluvia helada', 'ti-cloud-snow'],
  67: ['Lluvia helada', 'ti-cloud-snow'],
  71: ['Nieve débil', 'ti-snowflake'],
  73: ['Nieve', 'ti-snowflake'],
  75: ['Nevada fuerte', 'ti-snowflake'],
  77: ['Aguanieve', 'ti-snowflake'],
  80: ['Chubascos', 'ti-cloud-rain'],
  81: ['Chubascos', 'ti-cloud-rain'],
  82: ['Chubascos fuertes', 'ti-cloud-storm'],
  85: ['Chubascos de nieve', 'ti-snowflake'],
  86: ['Chubascos de nieve', 'ti-snowflake'],
  95: ['Tormenta', 'ti-cloud-storm'],
  96: ['Tormenta con granizo', 'ti-cloud-storm'],
  99: ['Tormenta con granizo', 'ti-cloud-storm'],
};

const DIA_CORTO = ['dom', 'lun', 'mar', 'mié', 'jue', 'vie', 'sáb'];

/**
 * LOS UMBRALES DE LO SEVERO, leídos de los parámetros.
 *
 * Se leen en cada consulta y no al arrancar: así, cambiar el umbral en la
 * pantalla de ajustes se nota en el siguiente «Actualizar» sin reiniciar nada.
 */
function umbrales() {
  return {
    calor: parametro('calor_extremo_c', 35),
    frio: parametro('frio_extremo_c', -5),
    lluvia: parametro('lluvia_torrencial_mm', 30),
    racha: parametro('racha_viento_fuerte_kmh', 60),
  };
}

/**
 * LO QUE HAY QUE CONTAR AUNQUE NO SE PREGUNTE.
 *
 * Un bloque de previsión es una tabla de números y una tabla de números no
 * alarma a nadie: 41° en la columna del jueves se lee igual que 24°. Los avisos
 * existen para eso, para que lo grave salga del cuadro y se lea antes.
 *
 * Solo se avisa de lo que TRAEN los datos. Nada de deducir «va a hacer bochorno»
 * de una temperatura y una humedad: si Open-Meteo no lo mide, aquí no se dice.
 */
function avisosSeveros(dias, ciudad) {
  const u = umbrales();
  const avisos = [];
  const cuando = (d) => `${DIA_CORTO[new Date(`${d.fecha}T12:00:00Z`).getUTCDay()]} ${d.fecha.slice(8, 10)}`;

  const calor = dias.filter((d) => d.max != null && d.max >= u.calor);
  if (calor.length) {
    const peor = calor.reduce((a, b) => (b.max > a.max ? b : a));
    avisos.push({
      tipo: 'calor',
      icono: 'ti-temperature-sun',
      texto:
        `Calor extremo en ${ciudad}: ${Math.round(peor.max)}° el ${cuando(peor)}` +
        (calor.length > 1 ? ` y ${calor.length - 1} día(s) más por encima de ${u.calor}°.` : '.'),
    });
  }

  const frio = dias.filter((d) => d.min != null && d.min <= u.frio);
  if (frio.length) {
    const peor = frio.reduce((a, b) => (b.min < a.min ? b : a));
    avisos.push({
      tipo: 'frio',
      icono: 'ti-temperature-snow',
      texto: `Frío extremo en ${ciudad}: ${Math.round(peor.min)}° el ${cuando(peor)}.`,
    });
  }

  const torrencial = dias.filter((d) => d.mm != null && d.mm >= u.lluvia);
  if (torrencial.length) {
    const peor = torrencial.reduce((a, b) => (b.mm > a.mm ? b : a));
    avisos.push({
      tipo: 'lluvia',
      icono: 'ti-cloud-storm',
      texto: `Lluvia muy fuerte en ${ciudad}: ${Math.round(peor.mm)} mm el ${cuando(peor)}.`,
    });
  }

  const viento = dias.filter((d) => d.racha != null && d.racha >= u.racha);
  if (viento.length) {
    const peor = viento.reduce((a, b) => (b.racha > a.racha ? b : a));
    avisos.push({
      tipo: 'viento',
      icono: 'ti-wind',
      texto: `Rachas fuertes en ${ciudad}: hasta ${Math.round(peor.racha)} km/h el ${cuando(peor)}.`,
    });
  }

  return avisos;
}

/** Pide la previsión de una ciudad y la guarda. Siempre reemplaza lo anterior. */
export async function actualizarAhoraDeCiudad({ ciudad, norm, lat, lon }) {
  const cuantos = Math.min(16, Math.max(1, parametro('dias_prevision', 7)));

  const d = await pedir(
    'https://api.open-meteo.com/v1/forecast' +
      `?latitude=${lat}&longitude=${lon}` +
      '&daily=weather_code,temperature_2m_max,temperature_2m_min,precipitation_sum,' +
      'precipitation_probability_max,wind_speed_10m_max,wind_gusts_10m_max' +
      `&forecast_days=${cuantos}&timezone=auto`
  );

  const D = d?.daily;
  if (!D?.time?.length) throw new Error('la previsión no devolvió días');

  const dias = D.time.map((fecha, i) => {
    const codigo = D.weather_code?.[i] ?? null;
    const [nombre, icono] = TIEMPO[codigo] ?? ['—', 'ti-cloud'];
    return {
      fecha,
      dia: DIA_CORTO[new Date(`${fecha}T12:00:00Z`).getUTCDay()],
      numero: Number(fecha.slice(8, 10)),
      cielo: nombre,
      icono,
      max: D.temperature_2m_max?.[i] ?? null,
      min: D.temperature_2m_min?.[i] ?? null,
      mm: D.precipitation_sum?.[i] ?? null,
      probLluvia: D.precipitation_probability_max?.[i] ?? null,
      viento: D.wind_speed_10m_max?.[i] ?? null,
      racha: D.wind_gusts_10m_max?.[i] ?? null,
    };
  });

  const datos = { ciudad, dias, avisos: avisosSeveros(dias, ciudad), zona: d.timezone ?? null };

  ejecutar(
    `INSERT INTO clima_ahora (ciudad_norm, ciudad, lat, lon, datos, actualizado_en)
     VALUES (?, ?, ?, ?, ?, datetime('now'))
     ON CONFLICT (ciudad_norm) DO UPDATE SET
       ciudad = excluded.ciudad, lat = excluded.lat, lon = excluded.lon,
       datos = excluded.datos, actualizado_en = excluded.actualizado_en`,
    norm,
    ciudad,
    lat,
    lon,
    JSON.stringify(datos)
  );

  return datos;
}

/**
 * REFRESCA EL BLOQUE «AHORA» DE UN PAÍS, y solo ese bloque.
 *
 * No toca la ficha: los visados, las vacunas y la moneda se quedan exactamente
 * como estaban. Es una tabla distinta y una llamada distinta, y eso es lo que
 * hace que el botón «Actualizar» de este bloque sea barato y se pueda pulsar
 * sin miedo.
 */
export async function actualizarAhora(viajeId, paisNorm, { fechaInicio, fechaFin } = {}) {
  const ciudades = await ciudadesDelPais(viajeId, paisNorm, { fechaInicio, fechaFin });
  const problemas = [];

  for (const c of ciudades) {
    try {
      await actualizarAhoraDeCiudad(c);
    } catch (err) {
      console.warn(`[clima] sin previsión de ${c.ciudad}: ${err.message}`);
      problemas.push(`${c.ciudad}: ${err.message}`);
    }
  }

  return { ...(await climaDelPais(viajeId, paisNorm, { fechaInicio, fechaFin })), problemas };
}

// =============================================================================
// LO QUE PIDE LA PANTALLA
// =============================================================================
function leerDatos(texto) {
  try {
    return JSON.parse(texto);
  } catch {
    return null; // JSON corrupto: el bloque sale vacío y el botón lo rehace
  }
}

/** "2026-09-10 18:32:07" -> "10/09 a las 18:32", que es como se lee una hora. */
export function comoMomento(iso) {
  if (!iso) return null;
  const t = new Date(`${iso.replace(' ', 'T')}Z`);
  if (Number.isNaN(t.getTime())) return null;
  const dd = String(t.getDate()).padStart(2, '0');
  const mm = String(t.getMonth() + 1).padStart(2, '0');
  const hh = String(t.getHours()).padStart(2, '0');
  const mi = String(t.getMinutes()).padStart(2, '0');
  return `${dd}/${mm} a las ${hh}:${mi}`;
}

/**
 * LOS DOS BLOQUES DE UN PAÍS, LEYENDO Y SIN PEDIR NADA.
 *
 * Esto lo llama la pantalla al abrir, así que no puede tardar: devuelve lo que
 * haya guardado y ya está. Lo que falte lo pide la propia pantalla después, que
 * es la misma forma de trabajar que ya tiene la ficha del país.
 */
export async function climaDelPais(viajeId, paisNorm, { fechaInicio, fechaFin } = {}) {
  const ciudades = await ciudadesDelPais(viajeId, paisNorm, { fechaInicio, fechaFin });

  const tipico = [];
  const ahora = [];
  let actualizadoEn = null;

  for (const c of ciudades) {
    const t = una(
      'SELECT datos FROM clima_tipico WHERE ciudad_norm = ? AND fecha_inicio IS ? AND fecha_fin IS ?',
      c.norm,
      c.desde,
      c.hasta ?? null
    );
    const d = t ? leerDatos(t.datos) : null;
    if (d) tipico.push(d);

    const a = una('SELECT datos, actualizado_en FROM clima_ahora WHERE ciudad_norm = ?', c.norm);
    const p = a ? leerDatos(a.datos) : null;
    if (p) {
      ahora.push(p);
      // La más antigua manda: si una ciudad se quedó sin refrescar, el bloque
      // no puede presumir de estar al día.
      if (!actualizadoEn || a.actualizado_en < actualizadoEn) actualizadoEn = a.actualizado_en;
    }
  }

  return {
    ciudades: ciudades.map((c) => c.ciudad),
    tipico,
    // CUANDO EL VIAJE CAMBIA MUCHO DE UNA PARADA A OTRA, se dice.
    contraste: contrasteEntreCiudades(tipico),
    ahora: {
      ciudades: ahora,
      avisos: ahora.flatMap((c) => c.avisos ?? []),
      actualizadoEn,
      actualizadoTexto: comoMomento(actualizadoEn),
      // Si falta alguna ciudad, la pantalla sabe que tiene que pedirlo.
      completo: ahora.length > 0 && ahora.length === ciudades.length,
      vacio: ahora.length === 0,
    },
  };
}

/**
 * ¿ES EL MISMO VIAJE EN TODAS LAS PARADAS?
 *
 * Una ruta que empieza en la costa en septiembre y acaba en la montaña en
 * octubre no se hace con la misma maleta, y eso no se ve mirando dos líneas
 * seguidas: hay que decirlo. Seis grados de diferencia en la máxima media es
 * donde deja de ser el mismo viaje —una chaqueta más—, y por debajo de eso no
 * hace falta molestar a nadie.
 */
const DIFERENCIA_QUE_IMPORTA = 6;

function contrasteEntreCiudades(tipico) {
  if (tipico.length < 2) return null;

  const frio = tipico.reduce((a, b) => (b.maxMedia < a.maxMedia ? b : a));
  const calor = tipico.reduce((a, b) => (b.maxMedia > a.maxMedia ? b : a));
  const salto = calor.maxMedia - frio.maxMedia;
  if (salto < DIFERENCIA_QUE_IMPORTA) return null;

  return (
    `Entre ${calor.ciudad} y ${frio.ciudad} hay ${salto}° de diferencia en la máxima ` +
    'típica: no vas a ir igual vestido en las dos.'
  );
}

export default {
  climaDelPais,
  asegurarClimaTipico,
  actualizarAhora,
  ciudadesDelPais,
  comoMomento,
};
