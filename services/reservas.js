/**
 * services/reservas.js
 * -----------------------------------------------------------------------------
 * LO QUE EL USUARIO CIERRA DE VERDAD: localizadores, bonos y billetes.
 *
 * La aplicación decide el viaje —qué vuelo, qué hotel, qué excursión— y ahí se
 * paraba. Lo que pasa después ocurre fuera: uno entra en la web de la aerolínea,
 * paga, y le llega un correo con un código. Ese código es el que hace falta en
 * el mostrador, y hasta ahora vivía en la bandeja de entrada.
 *
 * UNA RESERVA CUELGA DE UN CANDIDATO, que es la cosa concreta que se ha
 * reservado: el vuelo elegido, el hotel de esa parada, la excursión apuntada.
 * Uno a uno. Por eso no hace falta preguntarle a la reserva de qué es: se lo
 * pregunta al candidato, que ya lo sabe.
 *
 * Y DOS COSAS SEPARADAS QUE PARECEN UNA:
 *
 *   · `candidatos.reservado` es el estado: esto está cerrado o no lo está.
 *   · La fila de `reservas` son los datos: el código, la nota, el enlace.
 *
 * Están separadas porque desmarcar «reservado» no puede llevarse por delante un
 * localizador que costó encontrar. Se apaga la luz, no se tira el papel.
 *
 * NO LO TOCA EL ORQUESTADOR. Una reserva es siempre una decisión del usuario:
 * ninguna fase la escribe, ninguna la marca. Aquí solo se guarda lo que él pone.
 */

import { todas, una, ejecutar } from '../db/index.js';
import { adjuntosDe, cuentaDeAdjuntos } from './adjuntos.js';
import { parametro } from './orquestador.js';

/** Los tipos de candidato que se pueden reservar. Un sitio no se reserva. */
export const TIPOS_RESERVABLES = ['vuelo', 'hotel', 'actividad', 'traslado'];

/** Cómo se llama cada uno en pantalla. */
export const NOMBRE_DE_TIPO = {
  vuelo: 'Vuelo',
  hotel: 'Alojamiento',
  actividad: 'Excursión',
  traslado: 'Traslado',
};

const ICONO_DE_TIPO = {
  vuelo: 'ti-plane',
  hotel: 'ti-bed',
  actividad: 'ti-ticket',
  traslado: 'ti-arrow-right-circle',
};

const texto = (v, tope = 400) => {
  const t = String(v ?? '').trim();
  return t ? t.slice(0, tope) : null;
};

/**
 * Un enlace que se pueda pulsar.
 *
 * Lo que uno copia de un correo viene tal cual («booking.com/xyz») y un href sin
 * esquema lo resuelve el navegador como ruta relativa: acabaría en una página de
 * esta misma aplicación. Es el mismo cuidado que ya se tiene con la web de los
 * sitios.
 */
export function enlaceUtil(url) {
  const limpio = texto(url, 500);
  if (!limpio) return null;
  return /^https?:\/\//i.test(limpio) ? limpio : `https://${limpio.replace(/^\/+/, '')}`;
}

// =============================================================================
// LEER
// =============================================================================
/**
 * LA FECHA DE UNA COSA RESERVADA, que es por lo que se ordenan.
 *
 * Cada tipo la tiene en un sitio distinto y ninguno es el mismo campo: el vuelo
 * la lleva dentro de sus datos, el hotel es la entrada de su parada y la
 * excursión es el día en que está colocada en el lienzo. Se busca donde esté y
 * se devuelve en ISO para poder comparar.
 *
 * Null si no se sabe: eso va al final de la lista, no al principio.
 */
export function fechaDeLoReservado(candidato) {
  // 1) El vuelo y el traslado: la fecha de la etapa a la que llevan, o la del
  //    viaje si es la ida o la vuelta.
  if (candidato.transporte_id) {
    const t = una('SELECT * FROM transportes WHERE id = ?', candidato.transporte_id);
    const destino = t?.etapa_destino_id
      ? una('SELECT fecha_inicio FROM etapas WHERE id = ?', t.etapa_destino_id)
      : null;
    const origen = t?.etapa_origen_id
      ? una('SELECT fecha_fin FROM etapas WHERE id = ?', t.etapa_origen_id)
      : null;
    // La ida llega a una etapa; la vuelta sale de una.
    if (destino?.fecha_inicio) return destino.fecha_inicio;
    if (origen?.fecha_fin) return origen.fecha_fin;
  }

  // 2) Lo que cuelga de una etapa: el hotel entra el día que empieza la parada.
  if (candidato.etapa_id) {
    const e = una('SELECT fecha_inicio FROM etapas WHERE id = ?', candidato.etapa_id);
    if (candidato.tipo === 'hotel' && e?.fecha_inicio) return e.fecha_inicio;

    // 3) Una excursión, el día en que está colocada en el lienzo.
    const enElLienzo = una(
      `SELECT i.dia, v.fecha_inicio
         FROM itinerario i
         JOIN viajes v ON v.id = i.viaje_id
        WHERE i.candidato_id = ?`,
      candidato.id
    );
    if (enElLienzo?.fecha_inicio && enElLienzo.dia) {
      const d = new Date(`${enElLienzo.fecha_inicio}T12:00:00`);
      d.setDate(d.getDate() + (Number(enElLienzo.dia) - 1));
      return d.toISOString().slice(0, 10);
    }
    if (e?.fecha_inicio) return e.fecha_inicio;
  }

  // 4) Un vuelo del viaje entero (sin tramo): la fecha del viaje.
  const v = una('SELECT fecha_inicio, fecha_fin FROM viajes WHERE id = ?', candidato.viaje_id);
  if (candidato.tipo === 'vuelo') {
    const extra = leerExtra(candidato);
    const lado = (extra?.tramos ?? [])[0]?.tramo;
    if (lado === 'vuelta') return v?.fecha_fin ?? null;
    return v?.fecha_inicio ?? null;
  }

  return null;
}

/** `datos_extra` sin que un JSON roto tumbe la pantalla. */
function leerExtra(candidato) {
  try {
    return candidato?.datos_extra ? JSON.parse(candidato.datos_extra) : null;
  } catch {
    return null;
  }
}

/** Dónde está esto: la ciudad de su parada, para situarlo en la lista. */
function dondeEsta(candidato) {
  if (candidato.etapa_id) {
    const e = una('SELECT nombre_ciudad FROM etapas WHERE id = ?', candidato.etapa_id);
    if (e?.nombre_ciudad) return e.nombre_ciudad;
  }
  if (candidato.transporte_id) {
    const t = una('SELECT * FROM transportes WHERE id = ?', candidato.transporte_id);
    const a = t?.etapa_origen_id
      ? una('SELECT nombre_ciudad FROM etapas WHERE id = ?', t.etapa_origen_id)
      : null;
    const b = t?.etapa_destino_id
      ? una('SELECT nombre_ciudad FROM etapas WHERE id = ?', t.etapa_destino_id)
      : null;
    if (a || b) return `${a?.nombre_ciudad ?? 'casa'} → ${b?.nombre_ciudad ?? 'casa'}`;
  }
  return null;
}

/** La reserva de un candidato, con sus adjuntos. Siempre devuelve algo. */
export function reservaDeCandidato(candidatoId) {
  const c = una('SELECT * FROM candidatos WHERE id = ?', Number(candidatoId));
  if (!c) return null;

  const r = una('SELECT * FROM reservas WHERE candidato_id = ?', c.id);

  return {
    candidatoId: c.id,
    viajeId: c.viaje_id,
    tipo: c.tipo,
    titulo: c.titulo,
    reservado: Boolean(c.reservado),
    reservable: TIPOS_RESERVABLES.includes(c.tipo),
    localizador: r?.localizador ?? null,
    notas: r?.notas ?? null,
    enlace: r?.enlace ?? null,
    enlaceUrl: enlaceUtil(r?.enlace),
    adjuntos: adjuntosDe('reserva', c.id),
    // Si hay datos guardados, se enseñan aunque esté desmarcado: es lo que
    // permite desmarcar sin miedo.
    hayDatos: Boolean(r?.localizador || r?.notas || r?.enlace) || adjuntosDe('reserva', c.id).length > 0,
  };
}

/**
 * TODO LO RESERVABLE DEL VIAJE, ordenado por fecha.
 *
 * Devuelve las dos mitades que pide la pantalla: lo que ya está reservado y lo
 * que se eligió y sigue pendiente. La segunda es la útil de verdad —es la lista
 * de lo que queda por hacer— y por eso no se esconde en ninguna pestaña aparte.
 */
export function reservasDelViaje(viajeId) {
  const marcados = todas(
    `SELECT * FROM candidatos
      WHERE viaje_id = ? AND marcado = 1 AND tipo IN (${TIPOS_RESERVABLES.map(() => '?').join(',')})
      ORDER BY id`,
    Number(viajeId),
    ...TIPOS_RESERVABLES
  );

  const conAdjuntos = cuentaDeAdjuntos('reserva', marcados.map((c) => c.id));
  const porCandidato = new Map(
    todas('SELECT * FROM reservas WHERE viaje_id = ?', Number(viajeId)).map((r) => [r.candidato_id, r])
  );

  const fichas = marcados.map((c) => {
    const r = porCandidato.get(c.id);
    return {
      candidatoId: c.id,
      tipo: c.tipo,
      nombreTipo: NOMBRE_DE_TIPO[c.tipo] ?? c.tipo,
      icono: ICONO_DE_TIPO[c.tipo] ?? 'ti-bookmark',
      titulo: c.titulo,
      donde: dondeEsta(c),
      fecha: fechaDeLoReservado(c),
      precio: c.precio ?? null,
      moneda: c.moneda ?? null,
      reservado: Boolean(c.reservado),
      localizador: r?.localizador ?? null,
      notas: r?.notas ?? null,
      enlace: r?.enlace ?? null,
      enlaceUrl: enlaceUtil(r?.enlace),
      cuantosAdjuntos: conAdjuntos.get(c.id) ?? 0,
      adjuntos: adjuntosDe('reserva', c.id),
    };
  });

  // Sin fecha, al final: no se sabe cuándo es, así que no puede ir el primero.
  const porFecha = (a, b) => {
    if (a.fecha && b.fecha) return a.fecha.localeCompare(b.fecha);
    if (a.fecha) return -1;
    if (b.fecha) return 1;
    return 0;
  };

  return {
    reservadas: fichas.filter((f) => f.reservado).sort(porFecha),
    pendientes: fichas.filter((f) => !f.reservado).sort(porFecha),
    total: fichas.length,
  };
}

// =============================================================================
// ESCRIBIR
// =============================================================================
/**
 * Guarda la reserva de un candidato.
 *
 * Se acepta cada campo por separado: la pantalla manda solo lo que cambia, y
 * `undefined` significa «no lo toques» —distinto de la cadena vacía, que es
 * «bórralo»—. Es el mismo criterio que ya usa `retocar` en el lienzo.
 */
export function guardarReserva(candidatoId, { reservado, localizador, notas, enlace } = {}) {
  const c = una('SELECT * FROM candidatos WHERE id = ?', Number(candidatoId));
  if (!c) return { error: 'Eso ya no está en el viaje.' };
  if (!TIPOS_RESERVABLES.includes(c.tipo)) {
    return { error: 'Esto no es de las cosas que se reservan.' };
  }

  if (reservado !== undefined) {
    ejecutar('UPDATE candidatos SET reservado = ? WHERE id = ?', reservado ? 1 : 0, c.id);
  }

  const hayCampos = [localizador, notas, enlace].some((x) => x !== undefined);
  if (hayCampos) {
    const previa = una('SELECT * FROM reservas WHERE candidato_id = ?', c.id);
    const valor = (nuevo, anterior, tope) =>
      nuevo === undefined ? (anterior ?? null) : texto(nuevo, tope);

    ejecutar(
      `INSERT INTO reservas (viaje_id, candidato_id, localizador, notas, enlace, actualizado_en)
       VALUES (?, ?, ?, ?, ?, datetime('now'))
       ON CONFLICT (candidato_id) DO UPDATE SET
         localizador = excluded.localizador,
         notas = excluded.notas,
         enlace = excluded.enlace,
         actualizado_en = datetime('now')`,
      c.viaje_id,
      c.id,
      valor(localizador, previa?.localizador, 80),
      valor(notas, previa?.notas, 1000),
      valor(enlace, previa?.enlace, 500)
    );
  }

  return { reserva: reservaDeCandidato(c.id) };
}

// =============================================================================
// EL AVISO
// =============================================================================
/**
 * ¿HAY QUE DAR LA VOZ DE ALARMA CON LO QUE FALTA POR RESERVAR?
 *
 * Solo cuando el viaje se acerca: a tres meses vista, tener el hotel sin reservar
 * es normal; a tres semanas, es lo que hay que hacer esta tarde. El plazo es un
 * parámetro porque cada uno vive esto de una manera.
 *
 * Devuelve el aviso listo para la tabla de siempre, o null si no toca.
 */
export function avisoDeLoQueFalta(viaje) {
  if (!viaje?.fecha_inicio) return null;

  const dias = Math.round(
    (new Date(`${viaje.fecha_inicio}T12:00:00`) - new Date()) / 86_400_000
  );
  const plazo = parametro('dias_aviso_sin_reservar', 21);
  if (dias < 0 || dias > plazo) return null;

  const { pendientes } = reservasDelViaje(viaje.id);
  if (!pendientes.length) return null;

  const lista = pendientes.map((p) => p.titulo).filter(Boolean);
  const corta = lista.slice(0, 4).join(', ');

  return {
    categoria: 'reservas',
    severidad: dias <= 7 ? 'aviso' : 'info',
    titulo: `Te faltan por reservar: ${corta}${lista.length > 4 ? ` y ${lista.length - 4} más` : ''}`,
    texto:
      `Salís en ${dias} ${dias === 1 ? 'día' : 'días'} y ${pendientes.length} ` +
      `${pendientes.length === 1 ? 'cosa elegida sigue' : 'cosas elegidas siguen'} sin reservar. ` +
      'Las tienes todas juntas en «Mis reservas».',
    url: `/viaje/${viaje.id}/reservas`,
  };
}

/**
 * Deja ese aviso en la tabla, o lo quita si ya no toca.
 *
 * Se escribe en su propia categoría para que el trabajo de avisos —que rehace
 * los suyos enteros cada vez— no se lo lleve por delante, igual que el del vuelo
 * de madrugada.
 */
export function refrescarAvisoDeReservas(viaje) {
  ejecutar("DELETE FROM avisos WHERE viaje_id = ? AND categoria = 'reservas'", viaje.id);

  const aviso = avisoDeLoQueFalta(viaje);
  if (!aviso) return null;

  ejecutar(
    `INSERT INTO avisos (viaje_id, categoria, severidad, titulo, texto, url)
     VALUES (?, ?, ?, ?, ?, ?)`,
    viaje.id,
    aviso.categoria,
    aviso.severidad,
    aviso.titulo,
    aviso.texto,
    aviso.url
  );
  return aviso;
}

export default {
  reservaDeCandidato,
  reservasDelViaje,
  guardarReserva,
  avisoDeLoQueFalta,
  refrescarAvisoDeReservas,
  TIPOS_RESERVABLES,
  NOMBRE_DE_TIPO,
};
