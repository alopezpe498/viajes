/**
 * services/reservas-anticipadas.js
 * -----------------------------------------------------------------------------
 * LO QUE HAY QUE SACAR CON SEMANAS DE ANTELACIÓN.
 *
 * La ficha de un sitio dice a qué hora abre y cuánto cuesta. Eso sirve para
 * decidir el día. Lo que NO dice es que las entradas de la Alhambra se agotan
 * con un mes, ni que el Museo Ghibli las vende el día 10 del mes anterior y se
 * acaban esa mañana. Ese dato tiene una propiedad fea: solo se descubre el día
 * que intentas entrar, y ese día ya no hay nada que hacer.
 *
 * DOS MOMENTOS DISTINTOS, y por eso hay dos cosas aquí:
 *
 *   1. AVERIGUARLO. Va pegado a la búsqueda de datos duros —una búsqueda, no
 *      dos— y por eso vive en `datos-sitios.js`. Aquí solo está el repaso
 *      suelto, para los sitios que se apuntaron antes de que esto existiera.
 *
 *   2. RECORDARLO A TIEMPO. Un aviso de reserva con cuatro meses de margen se
 *      lee, se olvida y estorba a los demás. Un aviso la víspera es una burla.
 *      Así que se avisa por ventana: lo imprescindible a treinta días, lo
 *      recomendable a quince, y ninguno de los dos antes.
 *
 * SOLO DE LO QUE ESTÁ EN EL VIAJE. Un sitio del catálogo que nadie se ha
 * apuntado no es asunto de nadie: se avisa de lo APUNTADO y de lo COLOCADO en el
 * lienzo, que es lo que uno va a intentar visitar de verdad.
 */
import { todas, una, ejecutar } from '../db/index.js';
import { consultarJSONConGoogle } from '../lib/ia.js';
import { parametro } from './orquestador.js';
import { nivelDeReserva } from './datos-sitios.js';

/** Los dos niveles que avisan. 'no' y null no molestan a nadie. */
const AVISAN = ['imprescindible', 'recomendada'];

/** Cuántos días faltan para el viaje. Negativo si ya empezó. */
function diasHasta(fechaInicio) {
  if (!fechaInicio) return null;
  const hoy = new Date().toISOString().slice(0, 10);
  return Math.round(
    (new Date(`${fechaInicio}T00:00:00Z`) - new Date(`${hoy}T00:00:00Z`)) / 86_400_000
  );
}

// =============================================================================
// QUÉ SITIOS DEL VIAJE PUEDEN NECESITAR RESERVA
// =============================================================================
/**
 * Los sitios que este viaje va a intentar visitar.
 *
 * Apuntados y colocados son dos listas que casi siempre coinciden, pero no
 * siempre: se puede apuntar algo y no colocarlo todavía, o colocarlo y no
 * haberlo apuntado nunca. Las dos cuentan, porque en las dos hay intención de ir.
 *
 * El enlace entre el candidato y su ficha es `datos_extra` = {de, deId}, que es
 * la misma identidad con la que la pantalla decide si algo está apuntado.
 */
export function sitiosDelViaje(viajeId) {
  const candidatos = todas(
    `SELECT c.id, c.titulo, c.etapa_id, c.datos_extra, e.nombre_ciudad,
            (SELECT COUNT(*) FROM itinerario i WHERE i.candidato_id = c.id) AS colocado
       FROM candidatos c
       LEFT JOIN etapas e ON e.id = c.etapa_id
      WHERE c.viaje_id = ? AND c.tipo = 'sitio' AND c.marcado = 1`,
    Number(viajeId)
  );

  const salida = [];
  const vistos = new Set();

  for (const c of candidatos) {
    let extra = {};
    try {
      extra = c.datos_extra ? JSON.parse(c.datos_extra) : {};
    } catch {
      continue; // sin identidad no se puede ir a buscar su ficha
    }
    // Los campos de reserva viven en `sitios_lugar`: un «punto» del catálogo es
    // una ciudad o un sitio de alto nivel, y esos no se reservan.
    if (extra.de !== 'sitio' || extra.deId == null) continue;
    if (vistos.has(extra.deId)) continue;
    vistos.add(extra.deId);

    const s = una(
      'SELECT id, nombre, reserva_anticipada, reserva_detalle, reserva_en, web FROM sitios_lugar WHERE id = ?',
      Number(extra.deId)
    );
    if (!s) continue;

    salida.push({
      sitioId: s.id,
      candidatoId: c.id,
      nombre: s.nombre || c.titulo,
      ciudad: c.nombre_ciudad ?? null,
      colocado: Boolean(c.colocado),
      nivel: s.reserva_anticipada ?? null,
      detalle: s.reserva_detalle ?? null,
      revisado: Boolean(s.reserva_en),
      web: s.web ?? null,
    });
  }

  return salida;
}

// =============================================================================
// EL AVISO DEL VIAJE
// =============================================================================
/**
 * REHACE LOS AVISOS DE RESERVA ANTICIPADA DE UN VIAJE.
 *
 * Se borran los suyos y se vuelven a escribir: así, marcar un sitio como ya no
 * apuntado, o cambiar las fechas del viaje, quita el aviso solo. Tienen su
 * propia categoría para que el trabajo que rehace los avisos del destino —clima,
 * seguridad, festivos— no se los lleve por delante.
 *
 * LA VENTANA ES LO QUE HACE ÚTIL ESTO. Sin ella el aviso saldría el día que se
 * apunta el sitio, ocho meses antes, y para cuando importa ya nadie lo mira.
 */
export function refrescarAvisosDeReserva(viaje) {
  ejecutar("DELETE FROM avisos WHERE viaje_id = ? AND categoria = 'reserva-sitio'", viaje.id);

  const faltan = diasHasta(viaje.fecha_inicio);
  if (faltan == null || faltan < 0) return { avisos: 0, faltan };

  const tope = {
    imprescindible: parametro('dias_aviso_reserva', 30),
    recomendada: parametro('dias_aviso_reserva_recomendada', 15),
  };

  const sitios = sitiosDelViaje(viaje.id).filter(
    (s) => AVISAN.includes(s.nivel) && faltan <= tope[s.nivel]
  );

  for (const s of sitios) {
    const urgente = s.nivel === 'imprescindible';
    ejecutar(
      `INSERT INTO avisos (viaje_id, categoria, severidad, titulo, texto, url)
       VALUES (?, 'reserva-sitio', ?, ?, ?, ?)`,
      viaje.id,
      urgente ? 'precaucion' : 'info',
      `${s.nombre} requiere reserva anticipada`,
      [
        s.detalle,
        urgente
          ? `Quedan ${faltan} día(s) para el viaje.`
          : `Es recomendable, no obligatorio. Quedan ${faltan} día(s).`,
      ]
        .filter(Boolean)
        .join(' '),
      s.web ?? null
    );
  }

  return { avisos: sitios.length, faltan };
}

// =============================================================================
// EL REPASO SUELTO — para lo que ya estaba apuntado
// =============================================================================
/**
 * El prompt del repaso.
 *
 * NO ES EL DE LOS DATOS DUROS RECORTADO. Aquí se pregunta UNA cosa, y eso
 * permite ser mucho más exigente con ella: el texto de la búsqueda va sobre
 * entradas y reservas, no sobre horarios, así que un «se recomienda comprar por
 * internet» que allí pasaría desapercibido aquí se ve.
 *
 * Y la regla de siempre: lo que no esté en el texto es null. Un «reserva con
 * antelación» inventado manda a alguien a comprar una entrada que no hace falta,
 * y —peor— un «no hace falta» inventado lo deja en la puerta.
 */
function promptDeRepaso(ciudad, nombres) {
  // El texto de la búsqueda lo antepone `consultarJSONConGoogle`: aquí se
  // referencia («del texto de arriba») y no se vuelve a pegar.
  return [
    `Del texto de arriba, que va sobre las entradas de varios sitios de ${ciudad}:`,
    '',
    'Para CADA UNO de estos sitios, dime si hay que sacar la entrada con días de',
    'antelación:',
    ...nombres.map((n) => `- ${n}`),
    '',
    'REGLAS:',
    '1. SOLO lo que diga ese texto. Tienes prohibido responder con lo que sepas',
    '   por tu cuenta, aunque conozcas el sitio. Un "hay que reservar" inventado',
    '   manda a alguien a comprar lo que no necesita; un "no hace falta"',
    '   inventado lo deja en la puerta con la entrada agotada.',
    '2. "nivel" es una de estas cuatro y ninguna otra:',
    '     "imprescindible"  el texto dice que se agota, que hay cupo o aforo',
    '                       limitado, o que sin reserva previa no se entra.',
    '     "recomendada"     el texto aconseja comprarla antes por las colas o',
    '                       para asegurar plaza, pero se puede entrar sin ella.',
    '     "no"              el texto dice expresamente que no hace falta.',
    '     null              el texto no habla del asunto. Es la respuesta más',
    '                       frecuente y no es un fallo.',
    '   OJO: poder comprar por internet NO es reservar con antelación. Casi todo',
    '   se vende por internet hoy; la pregunta es si hay que hacerlo con DÍAS.',
    '3. "detalle": SOLO cuánta antelación y dónde se compra, en una frase corta',
    '   y copiada del texto. NO repitas el veredicto: el "sí" o el "no" ya va en',
    '   "nivel" y encima se pinta al lado, así que un detalle que empieza por',
    '   "Sí, imprescindible…" dice dos veces lo mismo y deja menos sitio para lo',
    '   único que aporta, que es CUÁNDO hay que comprarla y DÓNDE.',
    '   Bien: "se agota con semanas; se compra en la web del museo".',
    '   Mal:  "Sí, es imprescindible reservar con antelación".',
    '   Si el texto no da una antelación concreta, null.',
    '4. Devuelve el nombre EXACTAMENTE como te lo he escrito arriba.',
    '',
    'Devuelve SOLO este JSON:',
    '{"sitios":[{"nombre":"…","nivel":null,"detalle":null}]}',
  ].join('\n');
}

const recorta = (v, tope = 300) => {
  const t = String(v ?? '').trim();
  return !t || t === 'null' ? null : t.slice(0, tope);
};

/**
 * REPASA LOS SITIOS YA APUNTADOS DE UNA PARADA.
 *
 * Es para los viajes de antes: sus fichas se generaron cuando este dato no se
 * pedía, y regenerarlas enteras costaría una búsqueda por ciudad y borraría de
 * paso los horarios que ya estaban bien. Esto pregunta SOLO por las entradas y
 * SOLO escribe las dos columnas de reserva.
 *
 * Se repasan los que no se han mirado nunca (`reserva_en` vacío). Los que ya
 * tienen veredicto se dejan como están: si dijo que no hace falta, no hace
 * falta volver a preguntarlo cada vez que se pulsa el botón.
 */
export async function revisarReservasAnticipadas(etapaId, { forzar = false } = {}) {
  const etapa = una('SELECT * FROM etapas WHERE id = ?', Number(etapaId));
  if (!etapa) return { error: 'Esa parada ya no existe.' };

  const suyos = sitiosDelViaje(etapa.viaje_id).filter(
    (s) => (s.ciudad ?? etapa.nombre_ciudad) === etapa.nombre_ciudad
  );
  const pendientes = forzar ? suyos : suyos.filter((s) => !s.revisado);

  if (!pendientes.length) {
    return {
      revisados: 0,
      conReserva: 0,
      mensaje: suyos.length
        ? 'Ya estaban todos revisados.'
        : 'No hay sitios apuntados en esta parada.',
    };
  }

  const nombres = pendientes.map((s) => s.nombre);
  const ciudad = etapa.nombre_ciudad;

  let datos;
  try {
    datos = await consultarJSONConGoogle(
      `Entradas de ${nombres.slice(0, 12).join(', ')} en ${ciudad}: hay que reservar con antelación, se agotan, dónde se compran`,
      promptDeRepaso(ciudad, nombres),
      {
        paso: `reservas anticipadas en ${ciudad}`,
        maxTokens: 2000,
        // SIN BÚSQUEDA NO HAY REPASO. Preguntarle esto de memoria devolvería
        // «la Alhambra se agota» para cualquier sitio con fama, que es
        // exactamente el dato que no se puede inventar.
        exigirContexto: true,
      }
    );
  } catch (err) {
    return { error: `No se pudo consultar: ${err.message}` };
  }

  const porNombre = new Map(
    (Array.isArray(datos?.sitios) ? datos.sitios : []).map((x) => [
      String(x?.nombre ?? '').trim().toLowerCase(),
      x,
    ])
  );

  const cuando = new Date().toISOString().slice(0, 19).replace('T', ' ');
  let conReserva = 0;

  for (const s of pendientes) {
    const d = porNombre.get(s.nombre.trim().toLowerCase()) ?? {};
    const nivel = nivelDeReserva(d.nivel);
    const detalle = recorta(d.detalle);

    // Se sella SIEMPRE la fecha del repaso, aunque no se haya averiguado nada:
    // es lo que impide preguntar otra vez por lo mismo en cada pulsación.
    ejecutar(
      `UPDATE sitios_lugar
          SET reserva_anticipada = ?, reserva_detalle = ?, reserva_en = ?
        WHERE id = ?`,
      nivel ?? 'no',
      detalle,
      cuando,
      s.sitioId
    );

    if (AVISAN.includes(nivel)) conReserva += 1;
  }

  // Los avisos se rehacen: puede que acabe de aparecer uno imprescindible.
  const viaje = una('SELECT * FROM viajes WHERE id = ?', etapa.viaje_id);
  if (viaje) refrescarAvisosDeReserva(viaje);

  return {
    revisados: pendientes.length,
    conReserva,
    mensaje:
      conReserva === 0
        ? `Revisados ${pendientes.length}; ninguno necesita reserva anticipada.`
        : `Revisados ${pendientes.length}; ${conReserva} necesitan reserva con antelación.`,
  };
}

export default {
  sitiosDelViaje,
  refrescarAvisosDeReserva,
  revisarReservasAnticipadas,
};
