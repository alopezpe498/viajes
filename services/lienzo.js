/**
 * services/lienzo.js
 * -----------------------------------------------------------------------------
 * El lienzo: los días del viaje y lo que hay puesto en cada uno.
 *
 * TODO se calcula en una sola pasada. La pantalla puede tener quince días con
 * cuatro franjas cada uno, y hacer una consulta por franja serían sesenta viajes
 * a la base para pintar algo que cabe en cinco `SELECT`. Así que: cinco
 * consultas, y el reparto por días se hace en memoria.
 *
 * DE DÓNDE SALEN LOS DÍAS
 * De las etapas confirmadas, no de una tabla de días. El día 1 es la fecha de
 * inicio del viaje y hay tantos días como NOCHES: la última noche se duerme en
 * el último día, y ese día es cuando se vuelve. Cada día cae dentro del rango
 * de una etapa (`fecha_inicio <= dia < fecha_fin`), y como las etapas van
 * encadenadas sin huecos, cada día pertenece a una y solo una.
 */

import { todas, una, ejecutar, nochesEntre } from '../db/index.js';
import { direccionDe, claveDeCandidato } from './direcciones.js';
import { ciudadDeCasa } from './proveedores.js';

/** Las cuatro franjas, con sus horas orientativas. */
export const FRANJAS = [
  { clave: 'manana', etiqueta: 'Mañana', horas: 'hasta 13h', desde: 0, hasta: 13 },
  { clave: 'mediodia', etiqueta: 'Mediodía', horas: '13–16h', desde: 13, hasta: 16 },
  { clave: 'tarde', etiqueta: 'Tarde', horas: '16–20h', desde: 16, hasta: 20 },
  { clave: 'noche', etiqueta: 'Noche', horas: 'desde 20h', desde: 20, hasta: 24 },
];

const CLAVES_FRANJA = FRANJAS.map((f) => f.clave);

/** Colores de los chips de ciudad. Rotan por orden de etapa. */
const COLORES_CIUDAD = [
  { fondo: '#D3E8F0', texto: '#12507A' },
  { fondo: '#E1F2E7', texto: '#1E6B3C' },
  { fondo: '#FBEED6', texto: '#8A5A16' },
];

/** Los tipos que pueden estar en la mochila, con su chip. */
export const TIPOS_MOCHILA = [
  { clave: 'sitio', etiqueta: 'Sitios', icono: 'ti-map-pin' },
  { clave: 'actividad', etiqueta: 'Excursiones', icono: 'ti-ticket' },
  { clave: 'comer', etiqueta: 'Comer', icono: 'ti-tools-kitchen-2' },
];

/** "18:30" -> 'tarde'. La franja a la que pertenece una hora por sí sola. */
export function franjaNatural(hora) {
  if (!hora) return null;
  const h = Number(String(hora).split(':')[0]);
  if (!Number.isFinite(h)) return null;
  return FRANJAS.find((f) => h >= f.desde && h < f.hasta)?.clave ?? 'noche';
}

const etiquetaFranja = (clave) =>
  FRANJAS.find((f) => f.clave === clave)?.etiqueta.toLowerCase() ?? clave;

/** "2026-11-10" + 3 -> "2026-11-13". Al mediodía, para no pelearse con el huso. */
function sumarDias(iso, dias) {
  const d = new Date(`${iso}T12:00:00`);
  d.setDate(d.getDate() + Number(dias || 0));
  return d.toISOString().slice(0, 10);
}

const MESES = ['ene','feb','mar','abr','may','jun','jul','ago','sep','oct','nov','dic'];
const comoDia = (iso) => {
  const [, m, d] = iso.split('-').map(Number);
  return `${d} ${MESES[m - 1]}`;
};

// =============================================================================
// EL LIENZO ENTERO
// =============================================================================
/**
 * Todo lo que necesita la pantalla. Es también lo que devuelve la API después
 * de cada cambio, para repintar sin recargar.
 *
 * `etapaId` filtra la vista a una sola parada (los días de esa etapa y su parte
 * de mochila). Sin él, el viaje entero.
 */
export function lienzoDeViaje(viajeId, { etapaId = null } = {}) {
  const viaje = una('SELECT * FROM viajes WHERE id = ?', viajeId);
  if (!viaje) return null;

  // --- 1) Las etapas y sus días ------------------------------------------
  const etapas = todas(
    `SELECT * FROM etapas
      WHERE viaje_id = ? AND estado = 'confirmada' AND fecha_inicio IS NOT NULL
      ORDER BY orden, id`,
    viajeId
  );

  // DIAS, NO NOCHES. Un viaje del 25 al 27 son DOS noches pero TRES dias: el 25,
  // el 26 y el 27. El dia de la vuelta tambien se viaja y tiene sus horas —el
  // vuelo sale por la tarde, así que hay una mañana entera que repartir—, y sin
  // el, el vuelo de vuelta acababa cayendo en el dia anterior y el viaje entero
  // salia descuadrado.
  //
  // `nochesEntre` esta bien y se usa bien en todas partes menos aqui: lo que
  // devuelve son noches, y esta pantalla necesitaba dias.
  const totalDias = nochesEntre(viaje.fecha_inicio, viaje.fecha_fin) + 1;
  const dias = [];

  // Con fecha de ida pero sin fecha de vuelta, `nochesEntre` da 0 y esto daria
  // un dia suelto. Es correcto: un viaje de un dia es un dia.
  if (viaje.fecha_inicio && viaje.fecha_fin && etapas.length) {
    const colorDe = new Map(etapas.map((e, i) => [e.id, COLORES_CIUDAD[i % COLORES_CIUDAD.length]]));

    for (let n = 1; n <= totalDias; n++) {
      const fecha = sumarDias(viaje.fecha_inicio, n - 1);
      // La etapa del dia: aquella cuyo rango lo contiene. El fin es EXCLUSIVO
      // porque ese dia ya se duerme en la siguiente ciudad... salvo en la
      // ultima, que no tiene siguiente: ahi el dia de la vuelta es suyo.
      const etapa =
        etapas.find((e) => fecha >= e.fecha_inicio && fecha < e.fecha_fin) ??
        (fecha >= etapas.at(-1).fecha_inicio ? etapas.at(-1) : etapas[0]);
      dias.push({
        n,
        fecha,
        fechaCorta: comoDia(fecha),
        etapaId: etapa.id,
        ciudad: etapa.nombre_ciudad,
        color: colorDe.get(etapa.id),
        primeroDeEtapa: fecha === etapa.fecha_inicio,
      });
    }
  }

  const diasDeEtapa = new Map();
  for (const d of dias) {
    if (!diasDeEtapa.has(d.etapaId)) diasDeEtapa.set(d.etapaId, []);
    diasDeEtapa.get(d.etapaId).push(d.n);
  }

  // --- 2) Lo colocado -----------------------------------------------------
  const colocadas = todas(
    `SELECT i.*, c.tipo AS c_tipo, c.titulo AS c_titulo, c.precio, c.moneda,
            c.duracion, c.url, e.nombre_ciudad,
            m.tipo AS m_tipo, m.nombre AS m_nombre, m.telefono AS m_telefono,
            t.origen_texto AS t_origen, t.destino_texto AS t_destino
       FROM itinerario i
       LEFT JOIN candidatos c ON c.id = i.candidato_id
       LEFT JOIN catalogo_movilidad m ON m.id = i.movilidad_id
       LEFT JOIN traslados t ON t.id = i.traslado_id
       LEFT JOIN etapas e ON e.id = i.etapa_id
      WHERE i.viaje_id = ?
      ORDER BY i.dia, i.orden, i.id`,
    viajeId
  );

  // Si las fechas del viaje se movieron en la ruta, puede haber filas apuntando
  // a un día que ya no existe. No se borran: se avisa y vuelven a la mochila.
  const fueraDeRango = colocadas.filter((f) => f.dia < 1 || f.dia > totalDias);
  const dentro = colocadas.filter((f) => f.dia >= 1 && f.dia <= totalDias);

  const colocados = dentro.map((f) => ({
    id: f.id,
    dia: f.dia,
    franja: f.franja,
    hora: f.hora,
    etapaId: f.etapa_id,
    ciudad: f.nombre_ciudad,
    candidatoId: f.candidato_id,
    manual: f.candidato_id == null,
    // UN TRASLADO NO ES UNA ACTIVIDAD. Guarda su nombre en texto_manual —el
    // CHECK de la tabla no admite otra cosa— pero lleva movilidad_id, y por eso
    // se le puede dar su propio tipo en vez de pasar por "manual" a secas.
    tipo: esTraslado(f) ? 'traslado' : f.candidato_id == null ? 'manual' : f.c_tipo,
    nombre: f.candidato_id == null ? f.texto_manual : f.c_titulo,
    precio: f.precio,
    moneda: f.moneda,
    // La duración en minutos manda cuando la hay: la teclea uno en el propio
    // lienzo. Un traslado siempre la lleva; una comida también, porque cuánto
    // dura una cena es cosa de la cena, no del restaurante. Para lo demás vale
    // la del catálogo ("2 horas" de una excursión).
    duracion: minutosLargos(f.duracion_min) ?? (esTraslado(f) ? null : f.duracion),
    duracionMin: f.duracion_min ?? null,
    movilidadId: f.movilidad_id ?? null,
    trasladoId: f.traslado_id ?? null,
    // Dos orígenes para el medio, y no se pisan: una ficha de "Moverse" trae su
    // tipo (metro, taxi), y un traslado consultado trae el suyo (andando,
    // coche, público). La columna `medio` es la del segundo.
    medio: f.medio ?? f.m_tipo ?? null,
    telefono: f.m_telefono ?? null,
    url: f.url,
  }));

  // --- 3) La mochila ------------------------------------------------------
  // Lo apuntado en una etapa que todavía no está en ningún día. El NOT EXISTS
  // es lo que hace que una cosa colocada desaparezca de aquí.
  const enMochila = todas(
    `SELECT c.*, e.nombre_ciudad, e.orden AS etapa_orden
       FROM candidatos c
       JOIN etapas e ON e.id = c.etapa_id
      WHERE c.viaje_id = ?
        AND c.tipo IN ('sitio', 'actividad', 'comer')
        AND NOT EXISTS (SELECT 1 FROM itinerario i WHERE i.candidato_id = c.id)
      ORDER BY e.orden, c.tipo, c.id`,
    viajeId
  ).map((c) => ({
    id: c.id,
    tipo: c.tipo,
    nombre: c.titulo,
    precio: c.precio,
    moneda: c.moneda,
    duracion: c.duracion,
    etapaId: c.etapa_id,
    ciudad: c.nombre_ciudad,
  }));

  // Y los que se salieron de rango: vuelven a la mochila aunque tengan fila.
  for (const f of fueraDeRango) {
    if (f.candidato_id == null) continue;   // los manuales no tienen a dónde volver
    enMochila.push({
      id: f.candidato_id,
      tipo: f.c_tipo,
      nombre: f.c_titulo,
      precio: f.precio,
      moneda: f.moneda,
      duracion: f.duracion,
      etapaId: f.etapa_id,
      ciudad: f.nombre_ciudad,
      recolocar: true,
    });
  }

  // --- 4) Los bloques fijos de transporte ---------------------------------
  const fijos = bloquesDeTransporte(viajeId, etapas, dias, diasDeEtapa);

  // --- 5) Los avisos ------------------------------------------------------
  const avisos = calcularAvisos(dias, colocados, fijos);

  // --- Filtro por etapa ---------------------------------------------------
  const filtrar = (lista) => (etapaId ? lista.filter((x) => x.etapaId === etapaId) : lista);
  const diasVisibles = etapaId ? dias.filter((d) => d.etapaId === etapaId) : dias;
  const visibles = new Set(diasVisibles.map((d) => d.n));

  return {
    viaje: {
      id: viaje.id,
      nombre: viaje.nombre,
      fechaInicio: viaje.fecha_inicio,
      fechaFin: viaje.fecha_fin,
    },
    etapas: etapas.map((e, i) => ({
      id: e.id,
      nombre: e.nombre_ciudad,
      orden: e.orden,
      color: COLORES_CIUDAD[i % COLORES_CIUDAD.length],
      dias: diasDeEtapa.get(e.id) ?? [],
    })),
    etapaId,
    dias: diasVisibles,
    totalDias,
    colocados: colocados.filter((c) => visibles.has(c.dia)),
    mochila: filtrar(enMochila),
    fijos: fijos.filter((f) => visibles.has(f.dia)),
    avisos: avisos.filter((a) => visibles.has(a.dia)),
    porRecolocar: fueraDeRango.length,
    // Solo se enseñan los chips de tipo que de verdad hay algo.
    tiposPresentes: TIPOS_MOCHILA.filter((t) => enMochila.some((m) => m.tipo === t.clave)),
    franjas: FRANJAS,
  };
}

// =============================================================================
// LOS BLOQUES FIJOS
// =============================================================================
/**
 * Los tramos resueltos, colocados en el día y la franja que les toca.
 *
 * Los pendientes no pintan nada: un bloque ámbar que dice "aún no sé cómo vas"
 * ocuparía sitio en el día sin aportar. Para eso está la pantalla de ruta.
 */
function bloquesDeTransporte(viajeId, etapas, dias, diasDeEtapa) {
  if (!dias.length) return [];

  const casa = ciudadDeCasa();
  const tramos = todas(
    `SELECT t.*, c.titulo AS vuelo_titulo, c.datos_extra AS vuelo_extra
       FROM transportes t
       LEFT JOIN candidatos c ON c.id = t.candidato_id
      WHERE t.viaje_id = ?`,
    viajeId
  );

  const porEtapa = new Map(etapas.map((e) => [e.id, e]));
  const ultimoDia = dias.at(-1).n;
  const bloques = [];

  /**
   * El dia que le toca a una fecha.
   *
   * Se busca POR FECHA y no por posicion: el vuelo de vuelta del 27 tiene que
   * caer en el dia 27, no en "el ultimo dia que haya", que es lo que lo dejaba
   * en el 26 cuando faltaba un dia por generar.
   */
  const diaDeLaFecha = (fecha) => (fecha ? dias.find((d) => d.fecha === fecha)?.n ?? null : null);

  for (const t of tramos) {
    if (!t.candidato_id && !t.notas) continue;   // pendiente: no se pinta

    const origen = t.etapa_origen_id ? porEtapa.get(t.etapa_origen_id) : null;
    const destino = t.etapa_destino_id ? porEtapa.get(t.etapa_destino_id) : null;
    if (t.etapa_origen_id && !origen) continue;
    if (t.etapa_destino_id && !destino) continue;

    const donde = !origen ? 'ida' : !destino ? 'vuelta' : 'salto';
    const horas = horasDelVuelo(t.vuelo_extra);

    let dia;
    let hora;
    let franjaPorDefecto;
    let texto;
    let icono;

    if (donde === 'ida') {
      // Se llega el dia en que empieza la primera parada.
      dia = diaDeLaFecha(destino.fecha_inicio) ?? 1;
      hora = horas.llegada;
      franjaPorDefecto = 'manana';
      icono = 'ti-plane-arrival';
      texto = `Llegada a ${destino.nombre_ciudad}` + (hora ? ` ${hora}` : '');
    } else if (donde === 'vuelta') {
      // Se vuelve el dia en que acaba la ultima parada, que es la fecha de
      // vuelta del viaje.
      dia = diaDeLaFecha(origen.fecha_fin) ?? ultimoDia;
      hora = horas.salida;
      franjaPorDefecto = 'tarde';
      icono = 'ti-plane-departure';
      texto = `Vuelo ${origen.nombre_ciudad} → ${casa}` + (hora ? ` ${hora}` : '');
    } else {
      // Un salto se hace el dia en que empieza la etapa a la que se llega.
      dia = diaDeLaFecha(destino.fecha_inicio) ?? (diasDeEtapa.get(destino.id) ?? [])[0] ?? null;
      hora = null;
      franjaPorDefecto = 'manana';
      icono = ICONO_TIPO[t.tipo] ?? 'ti-arrow-right';
      texto = resumenDeSalto(t, origen, destino);
    }

    if (!dia) continue;

    bloques.push({
      id: t.id,
      dia,
      franja: franjaNatural(hora) ?? franjaPorDefecto,
      hora,
      donde,
      icono,
      texto,
      etapaId: dias.find((d) => d.n === dia)?.etapaId ?? null,
    });
  }

  return bloques;
}

const ICONO_TIPO = {
  tren: 'ti-train', bus: 'ti-bus', coche: 'ti-car', ferry: 'ti-ship', vuelo: 'ti-plane',
};

const ETIQUETA_TIPO = {
  tren: 'Tren', bus: 'Autobús', coche: 'Coche', ferry: 'Ferry', vuelo: 'Vuelo',
};

/** "Shinkansen Tokio → Kioto · 2h15", con lo que se sepa del tramo. */
function resumenDeSalto(t, origen, destino) {
  const trozos = [];
  if (t.notas) {
    // De las notas, lo primero: el bloque del día es estrecho.
    const corto = String(t.notas).replace(/\s+/g, ' ').split(/[,.;]/)[0].trim();
    trozos.push(corto.length > 3 && corto.length < 34 ? corto : ETIQUETA_TIPO[t.tipo] ?? t.tipo);
  } else {
    trozos.push(t.vuelo_titulo || ETIQUETA_TIPO[t.tipo] || t.tipo);
  }
  trozos.push(`${origen.nombre_ciudad} → ${destino.nombre_ciudad}`);

  // El tiempo de OSRM es EN COCHE, así que solo se enseña cuando el tramo va
  // por carretera de verdad. Poner "Shinkansen · 5h35" al lado de un tren que
  // tarda 2h15 no es un detalle: es decirle a alguien una hora que no es.
  const porCarretera = t.tipo === 'coche' || t.tipo === 'bus';
  if (t.duracion_min && t.fuente_distancia === 'carretera' && porCarretera) {
    const h = Math.floor(t.duracion_min / 60);
    const m = t.duracion_min % 60;
    trozos.push(h ? `${h}h${m ? String(m).padStart(2, '0') : ''}` : `${m} min`);
  }
  return trozos.join(' · ');
}

/**
 * Horas de llegada y de salida de un vuelo elegido.
 *
 * Una tarjeta de Kayak trae los dos trayectos en `datos_extra.tramos`: el
 * primero es la ida y el segundo la vuelta. De la ida interesa cuándo se
 * ATERRIZA (es lo que marca a qué hora empieza el viaje de verdad) y de la
 * vuelta cuándo se DESPEGA.
 */
function horasDelVuelo(datosExtra) {
  if (!datosExtra) return { llegada: null, salida: null };
  try {
    const extra = JSON.parse(datosExtra);
    const tramos = extra.tramos ?? [];

    // UN SOLO TRAYECTO = búsqueda de solo ida, que es como se buscan ahora los
    // tramos de la ruta. Ese trayecto ES el de este tramo, así que sus dos
    // horas valen: el bloque de ida usa la de llegada y el de vuelta la de
    // salida. Buscando un trayecto llamado "vuelta" —que en una tarjeta de solo
    // ida no existe— el vuelo de vuelta se quedaba sin hora y sin franja.
    if (tramos.length === 1) {
      return {
        llegada: normalizarHora(tramos[0].horaLlegada),
        salida: normalizarHora(tramos[0].horaSalida),
      };
    }

    // DOS TRAYECTOS = una tarjeta de ida y vuelta, de la búsqueda del viaje
    // entero. Cada hora sale del suyo.
    const ida = tramos.find((x) => x.tramo === 'ida') ?? tramos[0];
    const vuelta = tramos.find((x) => x.tramo === 'vuelta') ?? tramos[1];
    return {
      llegada: normalizarHora(ida?.horaLlegada),
      salida: normalizarHora(vuelta?.horaSalida),
    };
  } catch {
    return { llegada: null, salida: null };
  }
}

/** Kayak escribe "7:30"; aquí se guarda "07:30" para que ordene bien. */
function normalizarHora(h) {
  if (!h) return null;
  const m = /^(\d{1,2}):(\d{2})/.exec(String(h).trim());
  return m ? `${m[1].padStart(2, '0')}:${m[2]}` : null;
}

// =============================================================================
// LOS AVISOS
// =============================================================================
/**
 * Incoherencias del reparto. Se calculan al pintar y NO bloquean nada: son
 * para que uno se dé cuenta, no para impedirle hacer lo que quiera. Igual has
 * puesto ahí el museo a propósito porque piensas cambiar el vuelo.
 */
function calcularAvisos(dias, colocados, fijos) {
  const avisos = [];
  const indice = (clave) => CLAVES_FRANJA.indexOf(clave);

  for (const d of dias) {
    const delDia = colocados.filter((c) => c.dia === d.n);

    // 1) Cosas puestas ANTES de llegar.
    const llegada = fijos.find((f) => f.dia === d.n && f.donde === 'ida');
    if (llegada) {
      const antes = delDia.filter((c) => indice(c.franja) < indice(llegada.franja));
      if (antes.length) {
        avisos.push({
          dia: d.n,
          tipo: 'antes-de-llegar',
          idsAfectados: antes.map((c) => c.id),
          texto:
            `Llegas${llegada.hora ? ` a las ${llegada.hora}` : ''} — ` +
            `tienes ${antes.length} ${antes.length === 1 ? 'cosa' : 'cosas'} antes de llegar`,
        });
      }
    }

    // 2) Y cosas puestas DESPUÉS de irse, que es el mismo error al revés.
    const salida = fijos.find((f) => f.dia === d.n && f.donde === 'vuelta');
    if (salida) {
      const despues = delDia.filter((c) => indice(c.franja) > indice(salida.franja));
      if (despues.length) {
        avisos.push({
          dia: d.n,
          tipo: 'despues-de-irse',
          idsAfectados: despues.map((c) => c.id),
          texto:
            `Te vas${salida.hora ? ` a las ${salida.hora}` : ''} — ` +
            `tienes ${despues.length} ${despues.length === 1 ? 'cosa' : 'cosas'} después de irte`,
        });
      }
    }

    // 3) Una hora que no cuadra con la franja donde está.
    for (const c of delDia) {
      const natural = franjaNatural(c.hora);
      if (natural && natural !== c.franja) {
        avisos.push({
          dia: d.n,
          tipo: 'hora-franja',
          idsAfectados: [c.id],
          texto: `${c.nombre} empieza a las ${c.hora} (${etiquetaFranja(natural)})`,
        });
      }
    }
  }

  return avisos;
}

// =============================================================================
// COLOCAR, MOVER Y QUITAR
// =============================================================================
/** La etapa a la que pertenece un día del viaje. */
function etapaDelDia(viajeId, dia) {
  const viaje = una('SELECT fecha_inicio FROM viajes WHERE id = ?', viajeId);
  if (!viaje?.fecha_inicio) return null;

  const fecha = sumarDias(viaje.fecha_inicio, dia - 1);
  return una(
    `SELECT * FROM etapas
      WHERE viaje_id = ? AND estado = 'confirmada'
        AND fecha_inicio <= ? AND fecha_fin > ?
      ORDER BY orden LIMIT 1`,
    viajeId,
    fecha,
    fecha
  );
}

/** Pone algo en un día y una franja. Devuelve la fila creada, o null. */
export function colocar(
  viajeId,
  {
    candidatoId = null,
    textoManual = null,
    dia,
    franja,
    hora = null,
    movilidadId = null,
    trasladoId = null,
    medio = null,
    duracionMin = null,
    orden = null,
  }
) {
  if (!CLAVES_FRANJA.includes(franja)) return null;
  const n = Number(dia);
  if (!Number.isInteger(n) || n < 1) return null;

  // Una cosa o la otra, nunca las dos: lo mismo que exige el CHECK de la tabla.
  const texto = String(textoManual ?? '').trim();
  if ((candidatoId && texto) || (!candidatoId && !texto)) return null;

  const etapa = etapaDelDia(viajeId, n);

  if (candidatoId) {
    const candidato = una(
      'SELECT * FROM candidatos WHERE id = ? AND viaje_id = ?',
      candidatoId,
      viajeId
    );
    if (!candidato) return null;

    // Ya colocado: esto es un movimiento, no un duplicado.
    const yaEsta = una('SELECT * FROM itinerario WHERE candidato_id = ?', candidatoId);
    if (yaEsta) return mover(yaEsta.id, { dia: n, franja });
  }

  // Con `orden` se mete EN MEDIO, no al final: un traslado entre dos tarjetas
  // solo significa algo si queda entre esas dos. Se hace sitio empujando lo que
  // hay de ahí en adelante.
  const posicion = Number.isFinite(Number(orden))
    ? hacerSitio(viajeId, n, franja, Number(orden))
    : siguienteOrden(viajeId, n, franja);

  const r = ejecutar(
    `INSERT INTO itinerario
       (viaje_id, etapa_id, dia, franja, candidato_id, texto_manual, hora, orden,
        movilidad_id, duracion_min, traslado_id, medio)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    viajeId,
    etapa?.id ?? null,
    n,
    franja,
    candidatoId || null,
    candidatoId ? null : texto.slice(0, 300),
    normalizarHora(hora),
    posicion,
    Number(movilidadId) || null,
    Number(duracionMin) || null,
    Number(trasladoId) || null,
    medio || null
  );
  return una('SELECT * FROM itinerario WHERE id = ?', Number(r.lastInsertRowid));
}

/** Cambia de día o de franja. La etapa se recalcula: el día manda. */
export function mover(id, { dia, franja }) {
  const fila = una('SELECT * FROM itinerario WHERE id = ?', id);
  if (!fila) return null;
  if (!CLAVES_FRANJA.includes(franja)) return null;

  const n = Number(dia);
  if (!Number.isInteger(n) || n < 1) return null;

  const etapa = etapaDelDia(fila.viaje_id, n);
  ejecutar(
    'UPDATE itinerario SET dia = ?, franja = ?, etapa_id = ?, orden = ? WHERE id = ?',
    n,
    franja,
    etapa?.id ?? null,
    siguienteOrden(fila.viaje_id, n, franja),
    id
  );
  return una('SELECT * FROM itinerario WHERE id = ?', id);
}

/**
 * Cambia la hora o la duración de algo ya colocado, sin moverlo de sitio.
 *
 * Los traslados la necesitan de verdad —"el bus sale a las 9:15 y son 2 h 30"—
 * pero no se restringe a ellos: cualquier fila puede llevar hora, y una vez
 * hay dónde teclearla no tiene sentido que unas se dejen y otras no.
 */
export function retocar(id, { hora, duracionMin }) {
  const fila = una('SELECT * FROM itinerario WHERE id = ?', id);
  if (!fila) return null;

  // undefined es "no lo toques"; null o cadena vacía es "bórralo".
  if (hora !== undefined) {
    ejecutar('UPDATE itinerario SET hora = ? WHERE id = ?', normalizarHora(hora), id);
  }
  if (duracionMin !== undefined) {
    const m = Number(duracionMin);
    ejecutar(
      'UPDATE itinerario SET duracion_min = ? WHERE id = ?',
      Number.isFinite(m) && m > 0 ? Math.min(Math.round(m), 24 * 60) : null,
      id
    );
  }
  return una('SELECT * FROM itinerario WHERE id = ?', id);
}

/** 95 → "1 h 35". Lo que uno diría en voz alta, no "95 min". */
function minutosLargos(min) {
  const n = Number(min);
  if (!Number.isFinite(n) || n <= 0) return null;
  const h = Math.floor(n / 60);
  const m = n % 60;
  if (!h) return `${m} min`;
  return m ? `${h} h ${m}` : `${h} h`;
}

/** Lo saca del lienzo. Si era un candidato, vuelve solo a la mochila. */
export function quitar(id) {
  const fila = una('SELECT * FROM itinerario WHERE id = ?', id);
  if (!fila) return null;
  ejecutar('DELETE FROM itinerario WHERE id = ?', id);
  return fila;
}

/** Una fila del itinerario es un traslado si viene de una ficha o de una consulta. */
function esTraslado(f) {
  return Boolean(f.movilidad_id || f.traslado_id);
}

/**
 * Abre un hueco en `posicion` empujando hacia abajo lo que hay de ahí en
 * adelante, y devuelve el orden que le toca al recién llegado.
 */
function hacerSitio(viajeId, dia, franja, posicion) {
  ejecutar(
    `UPDATE itinerario SET orden = orden + 1
      WHERE viaje_id = ? AND dia = ? AND franja = ? AND orden >= ?`,
    viajeId,
    dia,
    franja,
    posicion
  );
  return posicion;
}

/**
 * Qué hay justo antes y justo después de un hueco del lienzo.
 *
 * Es lo que contesta el "+" que sale entre dos tarjetas. Vive en el servidor y
 * no en el navegador porque los vecinos NO siempre están en la misma franja:
 *
 *  - En medio de una franja son las tarjetas de al lado, sin más.
 *  - Al principio de la tarde, el de antes es la última tarjeta de la mañana.
 *  - En los bordes del día no hay tarjeta: es EL HOTEL. Se sale de dormir y se
 *    vuelve a dormir, y ese es justo el traslado que uno quiere calcular.
 *
 * Las tarjetas que YA SON un traslado se saltan: enlazar un traslado con otro
 * no dice nada, y saltándolo se llega a los dos sitios de verdad.
 */
export function vecinosDeHueco(viajeId, { dia, franja, indice }) {
  const n = Number(dia);
  if (!Number.isInteger(n) || !CLAVES_FRANJA.includes(franja)) return null;

  const etapa = etapaDelDia(viajeId, n);

  const delDia = todas(
    `SELECT * FROM itinerario
      WHERE viaje_id = ? AND dia = ?
      ORDER BY orden, id`,
    viajeId,
    n
  );

  const deLaFranja = delDia.filter((f) => f.franja === franja);
  const i = Math.max(0, Math.min(Number(indice) || 0, deLaFranja.length));

  // El orden que le tocará a la tarjeta nueva: el de la que está ahora en esa
  // posición, o el siguiente libre si el hueco es el final.
  const orden = i < deLaFranja.length ? deLaFranja[i].orden : siguienteOrden(viajeId, n, franja);

  // Las franjas van en un orden fijo, y "antes" y "después" del día se miden
  // con él: la mañana va antes que la tarde aunque las filas digan otra cosa.
  const posicionFranja = (f) => CLAVES_FRANJA.indexOf(f);
  const aplanado = [...delDia].sort(
    (a, b) => posicionFranja(a.franja) - posicionFranja(b.franja) || a.orden - b.orden || a.id - b.id
  );

  // Dónde cae el hueco dentro del día entero.
  const corte =
    i < deLaFranja.length
      ? aplanado.findIndex((x) => x.id === deLaFranja[i].id)
      : (() => {
          const ultima = deLaFranja[deLaFranja.length - 1];
          if (ultima) return aplanado.findIndex((x) => x.id === ultima.id) + 1;
          // Franja vacía: el corte va detrás de todo lo de las franjas anteriores.
          return aplanado.filter((x) => posicionFranja(x.franja) < posicionFranja(franja)).length;
        })();

  const antes = [...aplanado.slice(0, corte)].reverse().find((x) => !esTraslado(x)) ?? null;
  const despues = aplanado.slice(corte).find((x) => !esTraslado(x)) ?? null;

  const hotel = etapa ? lugarDelHotel(etapa.id) : null;

  return {
    viajeId,
    dia: n,
    franja,
    indice: i,
    orden,
    etapaId: etapa?.id ?? null,
    ciudad: etapa?.nombre_ciudad ?? null,
    // Sin vecino de un lado se usa el hotel: es de donde se sale por la mañana
    // y a donde se vuelve por la noche.
    origen: antes ? lugarDeFila(antes) : hotel,
    destino: despues ? lugarDeFila(despues) : hotel,
    hayHotel: Boolean(hotel),
  };
}

/**
 * Una tarjeta del lienzo, traducida a "un sitio al que se puede ir".
 *
 * La dirección no vive en la tarjeta: vive con el elemento del catálogo del que
 * la tarjeta es copia. `direccionDeCandidato` es quien sabe dar ese salto.
 */
function lugarDeFila(fila) {
  if (fila.movilidad_id) {
    const m = una('SELECT * FROM catalogo_movilidad WHERE id = ?', fila.movilidad_id);
    if (!m) return null;
    const d = direccionDe('movilidad', m.id);
    return {
      tipo: 'movilidad',
      id: m.id,
      nombre: m.nombre,
      texto: m.nombre,
      direccion: d?.direccion ?? null,
      situada: Boolean(d?.situada),
    };
  }

  if (fila.candidato_id) {
    const c = una('SELECT * FROM candidatos WHERE id = ?', fila.candidato_id);
    if (!c) return null;
    const clave = claveDeCandidato(c);
    const d = clave ? direccionDe(clave.tipo, clave.id) : null;
    return {
      tipo: clave?.tipo ?? null,
      id: clave?.id ?? null,
      nombre: c.titulo,
      texto: c.titulo,
      direccion: d?.direccion ?? null,
      situada: Boolean(d?.situada),
    };
  }

  // Una tarjeta escrita a mano no tiene dónde guardar una dirección: se ofrece
  // como texto libre y el geocodificador hará lo que pueda con ella.
  return {
    tipo: null,
    id: null,
    nombre: fila.texto_manual,
    texto: fila.texto_manual,
    direccion: null,
    // Se da por situable: el texto libre se busca al calcular.
    situada: true,
    libre: true,
  };
}

/** El hotel elegido de una parada, como sitio al que se va. */
function lugarDelHotel(etapaId) {
  const h = una(
    "SELECT * FROM candidatos WHERE etapa_id = ? AND tipo = 'hotel' AND marcado = 1",
    etapaId
  );
  if (!h) return null;

  const d = direccionDe('hotel', h.id);
  return {
    tipo: 'hotel',
    id: h.id,
    nombre: h.titulo,
    texto: h.titulo,
    direccion: d?.direccion ?? null,
    situada: Boolean(d?.situada),
    esHotel: true,
  };
}

/** Al final de su franja, que es donde uno espera que aparezca lo que suelta. */
function siguienteOrden(viajeId, dia, franja) {
  const ultimo = una(
    'SELECT MAX(orden) AS n FROM itinerario WHERE viaje_id = ? AND dia = ? AND franja = ?',
    viajeId,
    dia,
    franja
  );
  return (ultimo?.n ?? 0) + 1;
}

/**
 * Dónde está colocada cada cosa apuntada de una etapa. Lo usa la pantalla de
 * etapa para decir "Día 5 · tarde" al lado de lo ya repartido.
 */
export function colocacionesDeEtapa(etapaId) {
  const filas = todas(
    `SELECT i.id, i.candidato_id, i.dia, i.franja
       FROM itinerario i
      WHERE i.etapa_id = ? AND i.candidato_id IS NOT NULL`,
    etapaId
  );
  return new Map(
    filas.map((f) => [
      f.candidato_id,
      { id: f.id, dia: f.dia, franja: f.franja, etiqueta: `Día ${f.dia} · ${etiquetaFranja(f.franja)}` },
    ])
  );
}

/** Los días que le tocan a una etapa, para el mini-selector de su pantalla. */
export function diasDeEtapa(viajeId, etapaId) {
  const lienzo = lienzoDeViaje(viajeId, { etapaId });
  return lienzo?.dias ?? [];
}
