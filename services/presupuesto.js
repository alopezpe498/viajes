/**
 * services/presupuesto.js
 * -----------------------------------------------------------------------------
 * CUÁNTO COSTARÍA EL VIAJE TAL Y COMO ESTÁ MONTADO.
 *
 * No es un control de gastos: eso se lleva fuera y después. Esto es la foto del
 * coste del PLAN, para decidir si es viable antes de reservar nada.
 *
 * DOS BLOQUES QUE NO SE MEZCLAN:
 *
 *   1. LO PLANIFICADO. Precios reales, de scraping o de búsqueda: los vuelos,
 *      las noches, los saltos entre ciudades, las excursiones preseleccionadas.
 *      Lo que no tiene precio NO suma y se dice cuántos son, porque un total al
 *      que le faltan tres conceptos no es un total.
 *
 *   2. LO ESTIMADO. Comer, beber y moverse por la ciudad. No lo trae ninguna
 *      búsqueda porque no se reserva, así que lo estima la IA una vez por viaje
 *      y se enseña aparte, con la palabra «estimación» delante.
 *
 * Al pie hay un total orientativo que suma los dos, marcado como orientativo. Es
 * la cifra que uno quiere ver, pero mezcla dos calidades de dato distintas y eso
 * tiene que verse.
 *
 * EL ÁMBITO ES LO QUE HACE QUE LA SUMA SEA VERDAD
 * -----------------------------------------------------------------------------
 * Cada precio guardado cuenta una cosa distinta:
 *
 *   por_grupo   · ya es de todos. Una habitación, un taxi, un coche de alquiler,
 *                 y el vuelo de Kayak, que da el total de la reserva.
 *   por_persona · hay que multiplicarlo. Un billete de tren, una entrada, una
 *                 excursión de Civitatis («desde 45 €»).
 *
 * Multiplicar lo que ya venía multiplicado dobla el viaje; no multiplicar lo que
 * era de uno lo parte por la mitad. Por eso el ámbito se guarda CON el dato en
 * el momento de capturarlo —`precio_ambito`— y aquí solo se obedece. Las reglas
 * que deciden ese ámbito viven abajo, en un único sitio, y son las que usan
 * también los seis puntos de la aplicación que guardan un precio.
 */

import { todas, una, ejecutar, nochesEntre } from '../db/index.js';
import { consultarJSONConGoogle } from '../lib/ia.js';
import { ocupacionDe } from './proveedores.js';
import { configAuto, promptDeFase } from './orquestador.js';

/** Los dos ámbitos posibles. No hay un tercero: o es de todos o es de cada uno. */
export const POR_GRUPO = 'por_grupo';
export const POR_PERSONA = 'por_persona';

/** Cómo se dice cada ámbito en pantalla. */
export const NOMBRE_DE_AMBITO = {
  [POR_GRUPO]: 'del grupo',
  [POR_PERSONA]: 'por persona',
};

// =============================================================================
// LAS REGLAS DEL ÁMBITO — el único sitio donde se decide
// =============================================================================
/**
 * EL ÁMBITO DE UN CANDIDATO, POR SU ORIGEN.
 *
 * No se mira el título ni el precio: se mira de qué receta salió, que es lo que
 * de verdad determina qué cuenta ese número.
 *
 *   kayak     · la receta busca a propósito la línea «en total» y guarda el
 *               por-persona aparte, así que `precio` es el total de la reserva.
 *   booking   · «3 noches, 2 adultos»: el total de la estancia para la ocupación
 *               que se pidió.
 *   civitatis · «desde 45 €» es lo que paga cada uno.
 *
 * Devuelve null para lo que no lleva precio (un sitio, un bar apuntado): no es
 * un hueco, es que ahí no hay nada que sumar.
 */
export function ambitoDeCandidato({ tipo, origen_datos: origen } = {}) {
  if (tipo === 'vuelo') return POR_GRUPO;
  if (tipo === 'hotel') return POR_GRUPO;
  if (tipo === 'actividad') return POR_PERSONA;
  if (tipo === 'traslado') return POR_GRUPO;
  if (tipo === 'seguro') return POR_PERSONA;
  return null;
}

/**
 * EL ÁMBITO DE UNA OPCIÓN DE TRASLADO.
 *
 * Aquí el medio no basta del todo. Un billete de tren o de autobús es de cada
 * uno; un coche de alquiler o un traslado privado es del vehículo entero, vayan
 * dos o cuatro. Pero dentro del medio «traslado» el catálogo guarda tanto un
 * privado como BlaBlaCar, y en BlaBlaCar se paga por plaza.
 *
 * Por eso el nombre manda sobre el medio en ese único caso: es la excepción, y
 * está escrita como excepción para que se vea.
 */
export function ambitoDeTramo({ medio, nombre } = {}) {
  const n = String(nombre ?? '').toLowerCase();
  if (/blablacar|compartid/.test(n)) return POR_PERSONA;

  if (['coche', 'traslado', 'taxi'].includes(medio)) return POR_GRUPO;
  return POR_PERSONA; // tren, bus, ferry, avión, otro: son billetes
}

// =============================================================================
// LOS VIAJEROS
// =============================================================================
/**
 * QUIÉN PAGA CADA COSA.
 *
 * Un vuelo y un billete de tren los pagan todos, niños incluidos. Una excursión
 * también, pero a veces con tarifa infantil; cuando la fuente no la da, la línea
 * cuenta al niño a precio de adulto y lo dice en su nota. Es una imprecisión
 * conocida, y una imprecisión dicha no engaña a nadie.
 */
export function viajerosDe(viaje) {
  const { adultos, edadesNinos } = ocupacionDe(viaje);
  return { adultos, ninos: edadesNinos.length, total: adultos + edadesNinos.length };
}

/** Días del viaje: del 10 al 16 son SIETE días, no seis. */
export function diasDeViaje(viaje) {
  if (!viaje?.fecha_inicio || !viaje?.fecha_fin) return 0;
  return nochesEntre(viaje.fecha_inicio, viaje.fecha_fin) + 1;
}

// =============================================================================
// UNA LÍNEA DEL PRESUPUESTO
// =============================================================================
/**
 * Construye una línea con su cuenta hecha.
 *
 * `importe` es lo que dice la fuente y `total` lo que cuesta de verdad: la
 * multiplicación pasa AQUÍ y una sola vez, mirando el ámbito. Si no hay importe
 * la línea existe igual —el concepto está en el viaje— pero con `total` a null,
 * y quien sume ya sabe que ese no cuenta.
 */
function linea({
  titulo,
  detalle = null,
  importe,
  ambito,
  personas = 1,
  moneda = 'EUR',
  reservado = false,
  nota = null,
  url = null,
}) {
  const hay = Number.isFinite(Number(importe)) && Number(importe) > 0;
  const unitario = hay ? Number(importe) : null;
  const cuantos = ambito === POR_PERSONA ? Math.max(1, personas) : 1;

  return {
    titulo,
    detalle,
    importe: unitario,
    ambito: ambito ?? POR_GRUPO,
    ambitoTexto: NOMBRE_DE_AMBITO[ambito ?? POR_GRUPO],
    // Solo se enseña la multiplicación cuando de verdad multiplica.
    multiplica: ambito === POR_PERSONA && cuantos > 1 ? cuantos : null,
    total: unitario == null ? null : Math.round(unitario * cuantos * 100) / 100,
    moneda,
    reservado: Boolean(reservado),
    nota,
    url,
  };
}

/** Un concepto: su etiqueta, sus líneas y el total de lo que sí tiene precio. */
function concepto(clave, etiqueta, icono, lineas) {
  const conPrecio = lineas.filter((l) => l.total != null);
  return {
    clave,
    etiqueta,
    icono,
    lineas,
    total: Math.round(conPrecio.reduce((s, l) => s + l.total, 0) * 100) / 100,
    cuantas: lineas.length,
    sinPrecio: lineas.length - conPrecio.length,
  };
}

// =============================================================================
// BLOQUE 1 — LO PLANIFICADO
// =============================================================================
/** `datos_extra` sin que un JSON roto tumbe la pantalla. */
function extra(fila) {
  try {
    return fila?.datos_extra ? JSON.parse(fila.datos_extra) : {};
  } catch {
    return {};
  }
}

/** El nombre de la ciudad de una etapa, para situar cada línea. */
function ciudadDe(etapaId, etapas) {
  return etapas.get(etapaId)?.nombre_ciudad ?? null;
}

/**
 * Los vuelos: los elegidos y los que faltan por elegir.
 *
 * Un tramo declarado como vuelo y todavía sin resolver entra aquí SIN precio, y
 * no en traslados. Es un vuelo, y su hueco tiene que verse en la fila de los
 * vuelos: es lo que explica por qué el total está incompleto.
 */
function conceptoVuelos(viaje, viajeros, etapas) {
  const vuelos = todas(
    `SELECT * FROM candidatos
      WHERE viaje_id = ? AND tipo = 'vuelo' AND marcado = 1
      ORDER BY id`,
    viaje.id
  );

  const pendientes = todas(
    "SELECT * FROM transportes WHERE viaje_id = ? AND tipo = 'vuelo' AND candidato_id IS NULL ORDER BY id",
    viaje.id
  ).map((t) =>
    linea({
      titulo: `${ciudadDe(t.etapa_origen_id, etapas) ?? 'casa'} → ${
        ciudadDe(t.etapa_destino_id, etapas) ?? 'casa'
      }`,
      detalle: 'sin vuelo elegido',
      importe: t.precio_estimado,
      ambito: t.precio_ambito ?? POR_GRUPO,
      personas: viajeros.total,
    })
  );

  const lineas = vuelos.map((v) => {
    const e = extra(v);
    const porPersona = Number(e.precioPorPersona) || null;

    // EL DESGLOSE SE ENSEÑA, NO SE APLICA. El precio guardado ya es el total de
    // la reserva; el por-persona solo sirve para que se vea de dónde sale.
    const detalle = porPersona
      ? `${porPersona} € por persona × ${viajeros.total}`
      : (e.aerolineas ?? null);

    return linea({
      titulo: v.titulo,
      detalle,
      importe: v.precio,
      ambito: v.precio_ambito ?? ambitoDeCandidato(v),
      personas: viajeros.total,
      moneda: v.moneda ?? 'EUR',
      reservado: Boolean(v.reservado),
      url: v.url,
    });
  });

  return concepto('vuelos', 'Vuelos', 'ti-plane', [...lineas, ...pendientes]);
}

/** Las noches: un alojamiento por parada, con lo que cuesta la estancia entera. */
function conceptoDormir(viaje, viajeros, etapas) {
  const hoteles = todas(
    `SELECT c.* FROM candidatos c
      WHERE c.viaje_id = ? AND c.tipo = 'hotel' AND c.marcado = 1
      ORDER BY c.id`,
    viaje.id
  );

  const lineas = hoteles.map((h) => {
    const etapa = etapas.get(h.etapa_id);
    const noches = etapa ? Math.max(1, Number(etapa.noches) || 1) : null;
    const porNoche = h.precio && noches ? Math.round(h.precio / noches) : null;

    return linea({
      titulo: h.titulo,
      detalle: [
        ciudadDe(h.etapa_id, etapas),
        noches ? `${noches} noche${noches === 1 ? '' : 's'}` : null,
        porNoche ? `${porNoche} €/noche` : null,
      ]
        .filter(Boolean)
        .join(' · '),
      importe: h.precio,
      ambito: h.precio_ambito ?? ambitoDeCandidato(h),
      personas: viajeros.total,
      moneda: h.moneda ?? 'EUR',
      reservado: Boolean(h.reservado),
      url: h.url,
    });
  });

  return concepto('dormir', 'Dormir', 'ti-bed', lineas);
}

/**
 * Los traslados entre ciudades, los que no son un vuelo.
 *
 * Fuera los dos casos que ya están contados en «Vuelos»: los resueltos con un
 * billete —llevan candidato— y los que son un vuelo todavía sin elegir. Aquí
 * queda lo que se hace por tierra, que es lo que lleva su precio en el propio
 * tramo.
 */
function conceptoTraslados(viaje, viajeros, etapas) {
  const tramos = todas(
    "SELECT * FROM transportes WHERE viaje_id = ? AND tipo <> 'vuelo' ORDER BY id",
    viaje.id
  ).filter((t) => !t.candidato_id);

  const lineas = tramos.map((t) => {
    const desde = ciudadDe(t.etapa_origen_id, etapas) ?? 'casa';
    const hasta = ciudadDe(t.etapa_destino_id, etapas) ?? 'casa';
    const ficha = t.ficha_transporte_id
      ? una('SELECT * FROM catalogo_transporte_tramo WHERE id = ?', t.ficha_transporte_id)
      : null;

    return linea({
      titulo: `${desde} → ${hasta}`,
      detalle: t.notas ?? ficha?.nombre ?? t.tipo,
      importe: t.precio_estimado,
      ambito: t.precio_ambito ?? (ficha ? ambitoDeTramo(ficha) : ambitoDeTramo({ medio: t.tipo })),
      personas: viajeros.total,
      reservado: false,
    });
  });

  return concepto('traslados', 'Traslados', 'ti-arrow-right-circle', lineas);
}

/**
 * Las excursiones preseleccionadas.
 *
 * CON NIÑOS, TARIFA INFANTIL SI LA HAY. Civitatis a veces la publica; cuando no
 * está, se cuenta la de adulto y la línea lo dice, porque un presupuesto que se
 * queda corto en silencio es peor que uno que avisa.
 */
function conceptoExcursiones(viaje, viajeros, etapas) {
  const excursiones = todas(
    `SELECT * FROM candidatos
      WHERE viaje_id = ? AND tipo = 'actividad' AND marcado = 1
      ORDER BY id`,
    viaje.id
  );

  const lineas = excursiones.map((a) => {
    const e = extra(a);
    const precioNino = Number(e.precioNino) || null;
    const ambito = a.precio_ambito ?? ambitoDeCandidato(a);

    // Con tarifa infantil la cuenta deja de ser una multiplicación y hay que
    // hacerla a mano: adultos a un precio y niños a otro.
    if (ambito === POR_PERSONA && viajeros.ninos && precioNino && a.precio) {
      const total = a.precio * viajeros.adultos + precioNino * viajeros.ninos;
      return {
        ...linea({
          titulo: a.titulo,
          detalle: ciudadDe(a.etapa_id, etapas),
          importe: a.precio,
          ambito,
          personas: viajeros.adultos,
          moneda: a.moneda ?? 'EUR',
          reservado: Boolean(a.reservado),
          url: a.url,
        }),
        total: Math.round(total * 100) / 100,
        multiplica: null,
        nota:
          `${viajeros.adultos} × ${a.precio} € y ${viajeros.ninos} × ${precioNino} € ` +
          '(tarifa infantil)',
      };
    }

    return linea({
      titulo: a.titulo,
      detalle: ciudadDe(a.etapa_id, etapas),
      importe: a.precio,
      ambito,
      personas: viajeros.total,
      moneda: a.moneda ?? 'EUR',
      reservado: Boolean(a.reservado),
      url: a.url,
      nota:
        viajeros.ninos && !precioNino && a.precio
          ? 'Sin tarifa infantil en la fuente: los niños van a precio de adulto.'
          : null,
    });
  });

  return concepto('excursiones', 'Excursiones', 'ti-ticket', lineas);
}

/**
 * El seguro, CUANDO EXISTE.
 *
 * Hoy ninguna fase lo crea —el catálogo descarta a propósito el «Seguro de viaje
 * Civitatis» de la lista de excursiones, porque no es una excursión—, así que
 * este concepto sale vacío y la pantalla no lo pinta. Está escrito para el día
 * que se pueda apuntar uno: no hace falta volver a tocar la suma.
 */
function conceptoSeguro(viaje, viajeros) {
  const seguros = todas(
    `SELECT * FROM candidatos
      WHERE viaje_id = ? AND tipo = 'seguro' AND marcado = 1
      ORDER BY id`,
    viaje.id
  );

  const lineas = seguros.map((s) =>
    linea({
      titulo: s.titulo,
      importe: s.precio,
      ambito: s.precio_ambito ?? ambitoDeCandidato(s),
      personas: viajeros.total,
      moneda: s.moneda ?? 'EUR',
      reservado: Boolean(s.reservado),
      url: s.url,
    })
  );

  return concepto('seguro', 'Seguro', 'ti-shield-check', lineas);
}

// =============================================================================
// BLOQUE 2 — LO ESTIMADO
// =============================================================================
/** Cómo se le cuenta al modelo el nivel de precio del viaje. */
const NIVEL_EN_PALABRAS = {
  economico: 'sencillo',
  medio: 'normal',
  alto: 'con caprichos',
};

/** El nivel del viaje. Sin configuración automática, el del medio. */
export function nivelDelViaje(viaje) {
  return configAuto(viaje).nivelPrecio ?? 'medio';
}

/** La estimación guardada de un viaje, o null si nunca se ha calculado. */
export function estimacionGuardada(viajeId) {
  const f = una('SELECT * FROM presupuesto_diario WHERE viaje_id = ?', Number(viajeId));
  if (!f) return null;
  return {
    importe: f.importe == null ? null : Number(f.importe),
    porque: f.porque ?? null,
    nivel: f.nivel ?? null,
    tocadoAMano: Boolean(f.tocado_a_mano),
    calculadoEn: f.calculado_en ?? null,
  };
}

/**
 * Pregunta a la IA cuánto se gasta al día en destino.
 *
 * El prompt sale de la tabla, como los de las fases: es un juicio y tiene que
 * poder revisarse sin tocar código.
 *
 * VA CON EL CONTEXTO DE GOOGLE pero SIN exigirlo. En los precios de un billete
 * se exige, porque ahí el único trabajo es copiar una cifra de un texto y sin
 * texto no hay cifra. Aquí no: lo que se pide es una estimación, se enseña
 * como estimación y en su propio bloque, así que un número de lo que el modelo
 * sabe del país es exactamente lo que se ha pedido. El contexto, si lo hay,
 * solo lo mejora.
 */
export async function estimarGastoDiario(viaje) {
  const viajeros = viajerosDe(viaje);
  const dias = diasDeViaje(viaje);
  const nivel = nivelDelViaje(viaje);

  const ciudades = todas(
    "SELECT nombre_ciudad FROM etapas WHERE viaje_id = ? AND estado = 'confirmada' ORDER BY orden, id",
    viaje.id
  ).map((e) => e.nombre_ciudad);

  const destino = viaje.destino || ciudades[0] || 'el destino';
  const donde = ciudades.length ? ciudades.join(', ') : destino;

  const datos = {
    DESTINO: destino,
    CIUDADES: donde,
    NIVEL: NIVEL_EN_PALABRAS[nivel] ?? 'normal',
    VIAJEROS:
      `${viajeros.adultos} adulto(s)` + (viajeros.ninos ? ` y ${viajeros.ninos} niño(s)` : ''),
    DIAS: String(dias || 1),
  };

  const plantilla = promptDeFase('gasto_diario');
  const prompt = plantilla.replace(/\{\{([A-Z_]+)\}\}/g, (_, c) =>
    datos[c] === undefined ? '' : String(datos[c])
  );

  const r = await consultarJSONConGoogle(
    `Cuánto se gasta al día por persona en comida y transporte urbano en ${donde}`,
    prompt,
    { paso: `el gasto diario en ${destino}`, maxTokens: 800 }
  );

  const importe = Number(r?.importe);
  if (!Number.isFinite(importe) || importe <= 0) {
    throw new Error('La estimación no ha traído un importe utilizable.');
  }

  return {
    importe: Math.round(importe * 100) / 100,
    porque: String(r?.porque ?? '').trim().slice(0, 300) || null,
    nivel,
  };
}

/** Guarda la estimación. `tocadoAMano` decide si vuelve a recalcularse o no. */
export function guardarEstimacion(viajeId, { importe, porque, nivel, tocadoAMano = false }) {
  ejecutar(
    `INSERT INTO presupuesto_diario (viaje_id, importe, porque, nivel, tocado_a_mano, calculado_en)
     VALUES (?, ?, ?, ?, ?, datetime('now'))
     ON CONFLICT (viaje_id) DO UPDATE SET
       importe = excluded.importe,
       porque = excluded.porque,
       nivel = excluded.nivel,
       tocado_a_mano = excluded.tocado_a_mano,
       calculado_en = excluded.calculado_en`,
    Number(viajeId),
    importe == null ? null : Number(importe),
    porque ?? null,
    nivel ?? null,
    tocadoAMano ? 1 : 0
  );
  return estimacionGuardada(viajeId);
}

/**
 * LO QUE ESCRIBE EL USUARIO MANDA Y NO SE RECALCULA.
 *
 * En cuanto toca la cifra deja de ser una estimación de la máquina y pasa a ser
 * suya: puede saber lo que cuesta comer allí mejor que nadie. Se marca como
 * tocada a mano y ningún recálculo posterior la pisa.
 */
export function guardarImporteAMano(viajeId, importe) {
  const n = Number(importe);
  if (!Number.isFinite(n) || n < 0) return { error: 'Eso no es un importe.' };

  const previa = estimacionGuardada(viajeId);
  return {
    estimacion: guardarEstimacion(viajeId, {
      importe: Math.round(n * 100) / 100,
      porque: 'Lo has puesto tú.',
      nivel: previa?.nivel ?? null,
      tocadoAMano: true,
    }),
  };
}

/**
 * Calcula la estimación si hace falta. Nunca revienta al que la llama.
 *
 * `forzar` es el botón de recalcular. Ni siquiera él pisa una cifra escrita a
 * mano: para eso hay que volver a escribirla.
 */
export async function asegurarEstimacion(viaje, { forzar = false } = {}) {
  const previa = estimacionGuardada(viaje.id);
  if (previa?.tocadoAMano) return { estimacion: previa, motivo: 'la has puesto tú' };
  if (previa?.importe != null && !forzar) return { estimacion: previa, motivo: 'ya estaba' };

  try {
    const nueva = await estimarGastoDiario(viaje);
    return { estimacion: guardarEstimacion(viaje.id, nueva), motivo: 'calculada' };
  } catch (err) {
    console.warn(`[presupuesto] sin estimación de gasto diario: ${err.message}`);
    return { estimacion: previa, error: err.message };
  }
}

// =============================================================================
// EL PRESUPUESTO ENTERO
// =============================================================================
/**
 * La foto completa: los dos bloques, sus totales y el orientativo.
 *
 * Los conceptos vacíos no se devuelven: un viaje sin excursiones no necesita una
 * fila de excursiones a cero, y el seguro solo aparece cuando existe.
 */
export function presupuestoDelViaje(viajeId) {
  const viaje = una('SELECT * FROM viajes WHERE id = ?', Number(viajeId));
  if (!viaje) return null;

  const viajeros = viajerosDe(viaje);
  const dias = diasDeViaje(viaje);
  const etapas = new Map(
    todas('SELECT * FROM etapas WHERE viaje_id = ? ORDER BY orden, id', viaje.id).map((e) => [
      e.id,
      e,
    ])
  );

  const conceptos = [
    conceptoVuelos(viaje, viajeros, etapas),
    conceptoDormir(viaje, viajeros, etapas),
    conceptoTraslados(viaje, viajeros, etapas),
    conceptoExcursiones(viaje, viajeros, etapas),
    conceptoSeguro(viaje, viajeros),
  ].filter((c) => c.cuantas > 0);

  const total = Math.round(conceptos.reduce((s, c) => s + c.total, 0) * 100) / 100;
  const sinPrecio = conceptos.reduce((s, c) => s + c.sinPrecio, 0);

  const estimacion = estimacionGuardada(viaje.id);
  const totalEstimado =
    estimacion?.importe != null && dias && viajeros.total
      ? Math.round(estimacion.importe * dias * viajeros.total * 100) / 100
      : null;

  return {
    viaje,
    viajeros,
    dias,
    noches: viaje.fecha_inicio && viaje.fecha_fin ? nochesEntre(viaje.fecha_inicio, viaje.fecha_fin) : 0,
    planificado: {
      conceptos,
      total,
      sinPrecio,
      porPersona: viajeros.total ? Math.round((total / viajeros.total) * 100) / 100 : null,
    },
    estimado: {
      ...(estimacion ?? { importe: null, porque: null, nivel: null, tocadoAMano: false, calculadoEn: null }),
      nivel: estimacion?.nivel ?? nivelDelViaje(viaje),
      total: totalEstimado,
      porPersona:
        estimacion?.importe != null && dias
          ? Math.round(estimacion.importe * dias * 100) / 100
          : null,
    },
    // ORIENTATIVO Y DICHO ASÍ. Suma dos cosas de calidad distinta —precios
    // reales y una estimación— y quien la lee tiene que saberlo.
    orientativo: {
      total: totalEstimado == null ? total : Math.round((total + totalEstimado) * 100) / 100,
      porPersona:
        viajeros.total
          ? Math.round(((total + (totalEstimado ?? 0)) / viajeros.total) * 100) / 100
          : null,
      completo: totalEstimado != null && sinPrecio === 0,
    },
  };
}

export default {
  presupuestoDelViaje,
  asegurarEstimacion,
  estimarGastoDiario,
  guardarImporteAMano,
  ambitoDeCandidato,
  ambitoDeTramo,
  POR_GRUPO,
  POR_PERSONA,
};
