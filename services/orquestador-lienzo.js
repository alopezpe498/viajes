/**
 * services/orquestador-lienzo.js
 * -----------------------------------------------------------------------------
 * FASE 6 DEL ORQUESTADOR: repartir los días.
 *
 * Es la última y la que más criterio pide. Las cinco anteriores han ido dejando
 * material —paradas, traslados con hora, hotel, sitios con horarios y días de
 * cierre, excursiones con su punto de encuentro— y aquí hay que convertir todo
 * eso en «el martes por la mañana, esto».
 *
 * LO QUE HACE EL CÓDIGO Y LO QUE HACE LA IA, que no es lo mismo:
 *
 *   · El código monta el TABLERO: qué días tiene cada etapa, qué bloques fijos
 *     ya ocupan sitio (el vuelo que llega, el tren que sale) y qué piezas hay
 *     para colocar, con sus horarios reales y sus días de cierre.
 *
 *   · La IA hace el REPARTO. Es lo único que no se puede escribir como regla:
 *     que el casco viejo se ve de una tacada, que a Auschwitz se va por la
 *     mañana, que después de dos museos hace falta un parque. Una llamada por
 *     etapa, con sus días delante.
 *
 * TRES COSAS QUE NO SE NEGOCIAN:
 *
 *   1. NO HAY QUE COLOCARLO TODO. Lo que no quepa se queda apuntado en su
 *      pestaña. Un día con hueco se arregla sobre la marcha; un día imposible se
 *      descubre en la calle, con las maletas puestas.
 *
 *   2. EL MARGEN NO ES RELLENO. El aire entre dos visitas es lo que hace que un
 *      plan sobreviva a una cola inesperada. El ritmo decide cuánto se aprieta,
 *      nunca si hay margen o no.
 *
 *   3. LOS AVISOS DEL LIENZO TIENEN QUE QUEDAR EN VERDE. Si al terminar salta
 *      uno —algo antes de llegar, un sitio cerrado ese día, dos cosas sin tiempo
 *      entre medias— es un fallo de esta fase, no del aviso. Por eso se
 *      comprueban al final y se cuentan en el log en vez de dejarlos ahí.
 */
import { todas, una, ejecutar } from '../db/index.js';
import { consultarJSON, hayClaveIA, SIN_CLAVE } from '../lib/ia.js';
import {
  lienzoDeViaje,
  colocar,
  mover,
  retocar,
  quitar,
  duracionDeLoColocado,
  horaLibreEn,
  cierraALasMinutos,
  enMinutos,
  comoHora,
  diaDeAclimatacion,
  FRANJAS,
} from '../services/lienzo.js';
import { datosDeSitio, interpretarHorario } from '../services/datos-sitios.js';
import { ocupacionDe } from '../services/proveedores.js';
import { alternarApuntado } from '../services/etapa.js';
import {
  anotar,
  apuntarHueco,
  parametro,
  parametroTexto,
  configAuto,
  ORIGENES,
} from '../services/orquestador.js';
import { enMinutosDelDia } from '../services/orquestador-traslados.js';
import { hayQueParar } from '../services/orquestador-parada.js';
import { horasDeSesion, soloAUltimaHora, abreEl } from '../services/horarios.js';
import {
  avisarDeParadasQueNoCaben,
  avisarDeParadasSinSusImprescindibles,
  imprescindiblesDeParada,
} from '../services/orquestador-paradas-cortas.js';

const FASE = 'lienzo';

const CLAVES_FRANJA = FRANJAS.map((f) => f.clave);

/** Los días de la semana como los cuenta JavaScript: 0 es domingo. */
const DIAS_SEMANA = ['domingo', 'lunes', 'martes', 'miércoles', 'jueves', 'viernes', 'sábado'];

export function rellenar(plantilla, datos) {
  return plantilla.replace(/\{\{([A-Z_]+)\}\}/g, (_, clave) => {
    const v = datos[clave];
    return v === undefined || v === null ? '' : String(v);
  });
}

/** `cierra_dias` viaja como JSON de números. Vacío es «no cierra», no «no se sabe». */
function diasDeCierre(valor) {
  if (!valor) return [];
  try {
    const lista = JSON.parse(valor);
    return Array.isArray(lista) ? lista.filter((d) => Number.isInteger(d)) : [];
  } catch {
    return [];
  }
}

// =============================================================================
// EL TABLERO
// =============================================================================
/**
 * Los días de una etapa con lo que ya está ocupado.
 *
 * Los bloques fijos salen del lienzo que ya existe: son los mismos que pinta la
 * pantalla, así que lo que aquí se considera intocable es exactamente lo que el
 * usuario ve como intocable.
 */
export function diasDeLaEtapa(lienzo, etapaId) {
  return lienzo.dias
    .filter((d) => d.etapaId === etapaId)
    .map((d) => ({
      n: d.n,
      fecha: d.fecha,
      diaSemana: d.fecha ? DIAS_SEMANA[new Date(`${d.fecha}T12:00:00`).getDay()] : null,
      fijos: lienzo.fijos.filter((f) => f.dia === d.n),
    }));
}

/**
 * LO QUE SE PUEDE COLOCAR EN UNA ETAPA.
 *
 * AQUÍ ESTABA EL FALLO QUE DEJABA EL LIENZO VACÍO. Esto leía `candidatos` con
 * `marcado = 1`, o sea lo que alguien hubiera pulsado «Me lo apunto». Pero
 * ninguna fase apunta sitios —la 4 los genera y se dice expresamente que no los
 * apunte— así que la lista salía vacía y no había nada que repartir.
 *
 * Ahora se trabaja con LAS FICHAS GENERADAS, que es lo que de verdad hay: los
 * imprescindibles primero y los de segundo nivel después, sin los que ya cubre
 * una excursión. Las excursiones sí vienen de `candidatos`, porque la fase 5 las
 * preseleccionó apuntándolas de verdad.
 *
 * Y el «Me lo apunto» se hace AL COLOCAR, no antes: apuntar treinta sitios para
 * colocar ocho dejaría veintidós apuntados que nadie va a ver. Lo que no cabe se
 * queda generado y sin apuntar, que es exactamente lo que significa.
 */
export function colocablesDeEtapa(etapa, lienzo) {
  const yaColocados = new Set(lienzo.colocados.map((c) => c.candidatoId).filter(Boolean));

  // --- Las excursiones, que ya son candidatos y son anclas ----------------
  const excursiones = todas(
    `SELECT * FROM candidatos
      WHERE etapa_id = ? AND tipo = 'actividad' AND marcado = 1`,
    etapa.id
  )
    .filter((c) => !yaColocados.has(c.id))
    .map((c) => ({
      clase: 'excursion',
      candidatoId: c.id,
      sitioId: null,
      tipo: 'actividad',
      nombre: c.titulo,
      categoria: null,
      duracion: c.duracion ?? null,
      horarios: null,
      cierraDias: [],
      cierraTexto: null,
    }));

  // --- Y los sitios generados, en el orden de sus bloques -----------------
  const sitios = etapa.punto_interes_id
    ? todas(
        `SELECT * FROM sitios_lugar
          WHERE punto_interes_id = ?
            AND bloque IN ('imprescindibles', 'otros', 'ninos')
            AND cubierto_por IS NULL
          ORDER BY CASE bloque
                     WHEN 'imprescindibles' THEN 1
                     WHEN 'ninos' THEN 2
                     ELSE 3
                   END, orden, id`,
        etapa.punto_interes_id
      )
    : [];

  // Un sitio ya apuntado y colocado no se ofrece otra vez.
  const apuntados = new Map(
    todas(
      "SELECT id, datos_extra FROM candidatos WHERE etapa_id = ? AND tipo = 'sitio'",
      etapa.id
    ).map((c) => {
      let deId = null;
      try {
        deId = JSON.parse(c.datos_extra ?? '{}').deId ?? null;
      } catch {
        deId = null;
      }
      return [deId, c.id];
    })
  );

  const delCatalogo = sitios
    .filter((s) => {
      const cand = apuntados.get(s.id);
      return !cand || !yaColocados.has(cand);
    })
    .map((s) => {
      const datos = datosDeSitio(s);
      const cierres = diasDeCierre(s.cierra_dias);
      return {
        clase: 'sitio',
        candidatoId: apuntados.get(s.id) ?? null,
        sitioId: s.id,
        tipo: 'sitio',
        nombre: s.nombre,
        categoria: s.categoria ?? null,
        bloque: s.bloque,
        duracion: datos?.tiempoVisita ?? null,
        horarios: datos?.horarios ?? null,
        cierraDias: cierres,
        cierraTexto: cierres.length ? cierres.map((d) => DIAS_SEMANA[d]).join(' y ') : null,
      };
    });

  // Las excursiones primero: son las anclas y quien lee la lista tiene que
  // verlas antes de repartir lo demás.
  return [...excursiones, ...delCatalogo];
}

/**
 * Apunta un sitio del catálogo y devuelve su candidato.
 *
 * Es el mismo «Me lo apunto» del botón. Se hace justo antes de colocarlo, para
 * que el estado quede como si lo hubiera apuntado una persona: si mañana se
 * quita del lienzo, vuelve a la mochila como cualquier otro.
 */
function apuntarYObtener(etapaId, sitioId) {
  const r = alternarApuntado(etapaId, 'sitio', sitioId);
  if (!r?.apuntado) return null;

  const c = una(
    `SELECT id FROM candidatos
      WHERE etapa_id = ? AND tipo = 'sitio' AND datos_extra LIKE ?
      ORDER BY id DESC LIMIT 1`,
    etapaId,
    `%"deId":${sitioId}%`
  );
  return c?.id ?? null;
}

// =============================================================================
// LA REVISIÓN FINAL
// -----------------------------------------------------------------------------
// La fase no puede terminar diciendo «todo cuadra» sin haber mirado. Y mirar es
// preguntarle al MISMO validador que ve el usuario en su pantalla, no a una
// comprobación propia que se cree lo que quiera.
//
// Se corrige en CÓDIGO y no pidiéndoselo otra vez a la IA. Cada aviso tiene un
// arreglo evidente —lo que cae dentro del viaje se va detrás del viaje, lo que
// está en su día de cierre se va a otro día, el día sin comer recibe su bloque—
// y son movimientos de calendario, no decisiones de gusto. Es la misma regla de
// siempre en esta casa: la aritmética la hace el código.
// =============================================================================

/**
 * ANTES DE VALIDAR, QUE EL TABLERO ESTÉ COMPLETO.
 *
 * El aviso de «cierra ese día» necesita `cierra_dias`, que se calcula en un
 * trabajo aparte y en diferido. Al terminar la fase todavía no está, así que el
 * validador no tenía nada que decir y la fase escribía «todo cuadra» sobre un
 * museo colocado un martes. Se traducen aquí los horarios de lo que se ha
 * colocado —solo eso, no el catálogo entero— y entonces se pregunta.
 */
async function asegurarCierres(viajeId, di) {
  const pendientes = todas(
    `SELECT DISTINCT s.id, s.nombre
       FROM itinerario i
       JOIN candidatos c ON c.id = i.candidato_id
       JOIN sitios_lugar s
         ON s.id = CAST(json_extract(c.datos_extra, '$.deId') AS INTEGER)
      WHERE i.viaje_id = ?
        AND json_extract(c.datos_extra, '$.de') = 'sitio'
        AND s.horarios IS NOT NULL
        AND s.cierra_dias IS NULL`,
    viajeId
  );
  if (!pendientes.length) return 0;

  di(`   Traduzco el horario de ${pendientes.length} sitio(s) para poder ver si cierran.`);
  let hechos = 0;
  for (const s of pendientes) {
    try {
      await interpretarHorario(s.id);
      hechos += 1;
    } catch (err) {
      di(`   No pude interpretar el horario de ${s.nombre} (${err.message}).`);
    }
  }
  return hechos;
}

/** La franja que empieza a esa hora o después. Null si ya no queda día. */
function franjaDesde(hora) {
  const h = Number(String(hora ?? '').split(':')[0]);
  if (!Number.isFinite(h)) return null;
  return FRANJAS.find((f) => f.hasta > h)?.clave ?? null;
}

/** El sitio de catálogo y la etapa de una tarjeta colocada, para desapuntarla. */
function deQuienEs(colocado) {
  if (!colocado?.candidatoId) return null;
  const c = una('SELECT * FROM candidatos WHERE id = ?', colocado.candidatoId);
  if (!c) return null;
  try {
    const e = c.datos_extra ? JSON.parse(c.datos_extra) : null;
    return { candidato: c, de: e?.de ?? null, deId: e?.deId ?? null, etapaId: c.etapa_id };
  } catch {
    return { candidato: c, de: null, deId: null, etapaId: c.etapa_id };
  }
}

/**
 * Saca algo del plan: la colocación Y el apuntado, por el mismo mecanismo que el
 * botón de la pantalla. Las dos cosas van juntas en los dos sentidos: si al
 * colocar se apunta, al sacar se desapunta.
 */
function sacarDelPlan(colocado, di, motivo) {
  const quien = deQuienEs(colocado);

  if (quien?.de && quien.deId && quien.etapaId) {
    alternarApuntado(quien.etapaId, quien.de, quien.deId); // borra el candidato y, en cascada, su colocación
  } else {
    quitar(colocado.id);
  }
  di(`   Fuera del plan: ${colocado.nombre} (${motivo}).`);
  return { nombre: colocado.nombre, motivo };
}

/**
 * NINGÚN BLOQUE DEL ORQUESTADOR SE QUEDA SIN HORA.
 *
 * Un «--:--» no es un plan: es un hueco que además vuelve invisible el bloque
 * para el validador —sin hora no se solapa con nada— y así los avisos
 * desaparecían sin haberse resuelto.
 *
 * Si la IA no dio hora, se busca el primer hueco real de su franja. Y si ahí no
 * cabe, se le pone igualmente la hora en que empieza su franja: es preferible un
 * conflicto VISIBLE, que la revisión sabrá resolver, a un bloque escondido.
 *
 * Los «--:--» que pone el usuario a mano son asunto suyo y no se tocan: esto
 * solo mira lo que acaba de colocar la fase.
 */
function ponerHorasQueFalten(viajeId, di) {
  let lienzo = lienzoDeViaje(viajeId);
  const sinHora = lienzo.colocados.filter((c) => !c.hora);
  if (!sinHora.length) return 0;

  let puestas = 0;
  for (const c of sinHora) {
    const duracion = Number(c.duracionMin) || 60;
    const quien = deQuienEs(c);
    const sitio =
      quien?.de === 'sitio' && quien.deId
        ? una('SELECT horarios, categoria FROM sitios_lugar WHERE id = ?', quien.deId)
        : null;
    const cierre = sitio ? cierraALasMinutos(sitio) : null;

    const hueco =
      horaLibreEn(lienzo, { dia: c.dia, franja: c.franja, duracion, cierraA: cierre }) ??
      CLAVES_FRANJA.map((f) =>
        horaLibreEn(lienzo, { dia: c.dia, franja: f, duracion, cierraA: cierre })
      ).find(Boolean);

    // El borde de su franja como último recurso: con hora, aunque chirríe.
    const borde = FRANJAS.find((f) => f.clave === c.franja);
    const hora =
      hueco ?? `${String(Math.max(9, borde?.desde ?? 9)).padStart(2, '0')}:00`;

    retocar(c.id, { hora });
    if (!hueco) {
      di(`   ${c.nombre} se queda a las ${hora}: no había hueco limpio y prefiero que se vea.`);
    }
    puestas += 1;
    lienzo = lienzoDeViaje(viajeId);
  }

  return puestas;
}

/**
 * RECOLOCAR ALGO CON HORA, O SACARLO. No hay tercera opción.
 *
 * La revisión movía los bloques de franja sin darles hora, y un bloque sin hora
 * no se solapa con nada: el aviso desaparecía y el problema se quedaba dentro.
 * Eso es esconderlo del validador, no resolverlo.
 *
 * Aquí se busca un hueco DE VERDAD —con su hora, sin pisar nada, antes de que
 * cierre el sitio— probando las franjas que quedan de ese día y después los
 * otros días de la misma parada. Si no lo hay, el bloque sale del plan con su
 * motivo, que también es resolver.
 *
 * Devuelve true si lo ha recolocado.
 */
/**
 * ¿ES ESTE UN DÍA EN EL QUE NO SE PLANIFICA NADA?
 *
 * Los días de llegada y de salida no son días normales con menos horas: son días
 * cuyo plan es el viaje. El lienzo lo dice en su propio resumen —«salida: solo
 * tiempo para maletas y aeropuerto»— y luego la revisión le metía el Museo de la
 * Acrópolis a las 9:00 porque, contando minutos, cabía: acababa a las 11:00 y la
 * presentación era a las 12:25. Cabía y contradecía el criterio, dejando el
 * margen a cero.
 *
 * La cuenta es simple: cuánto tiempo queda de verdad entre que se sale del
 * aeropuerto al llegar y que hay que estar en él para irse. Por debajo de
 * `minutos_utiles_dia_de_viaje` ese día no admite nada de la revisión, y lo que
 * no quepa en otro sitio sale del lienzo con su motivo, que ya se sabe hacer.
 *
 * Lo que la IA colocara ahí a propósito no se toca: esto solo frena a la
 * revisión, que es quien movía cosas sin mirar el criterio del día.
 */
export function esDiaDeViaje(lienzo, dia) {
  const fijos = (lienzo.fijos ?? []).filter((f) => f.dia === dia);
  if (!fijos.length) return false;

  const llegada = fijos.find((f) => f.donde === 'ida');
  const salida = fijos.find((f) => f.donde === 'vuelta');
  const salto = fijos.find((f) => f.donde === 'salto');
  if (!llegada && !salida && !salto) return false;

  const minimo = parametro('minutos_utiles_dia_de_viaje', 240);

  // Desde cuándo se puede empezar: al salir del aeropuerto o del traslado.
  const empieza = Math.max(
    enMinutosDelDia(llegada?.horaFin ?? llegada?.hora) ?? 0,
    enMinutosDelDia(salto?.horaFin) ?? 0,
    9 * 60
  );

  // Hasta cuándo: cuando arranca el bloque de la salida, si lo hay.
  const acaba = Math.min(
    enMinutosDelDia(salida?.hora) ?? 24 * 60,
    enMinutosDelDia(salto?.hora) ?? 24 * 60,
    22 * 60
  );

  return acaba - empieza < minimo;
}

/** ¿Es este bloque la comida del día? */
function esComida(colocado) {
  return /^comer\b/i.test(String(colocado?.nombre ?? ''));
}

/**
 * A qué hora tiene que haber TERMINADO esto, si es un sitio con cierre.
 *
 * CON PASES NO HAY HORA DE CIERRE QUE VALGA, y esto lo descubrió la prueba.
 * `cierraALasMinutos` busca horas en el texto y se queda con la más temprana de
 * la tarde; ante «Pases a las 20:00 y 21:30» concluye que el sitio cierra a las
 * 20:00, así que un espectáculo de hora y media no cabe en su propio pase y el
 * plan se queda sin él. Una lista de pases no es un horario de apertura: son
 * cosas distintas escritas en el mismo campo, y la hora de cada pase ya es toda
 * la restricción que hace falta.
 */
function cierreDe(colocado) {
  const quien = deQuienEs(colocado);
  if (quien?.de !== 'sitio' || !quien.deId) return null;
  const sitio = una('SELECT horarios FROM sitios_lugar WHERE id = ?', quien.deId);
  if (!sitio) return null;
  if (horasDeSesion(sitio.horarios)?.length) return null;
  return cierraALasMinutos(sitio);
}

/**
 * CUÁNTO PESA CADA COSA DEL LIENZO.
 *
 * Hasta ahora la revisión no se lo preguntaba: ante un solape expulsaba «el
 * último», que es una propiedad del aviso, no del viaje. Así es como una comida
 * de 90 minutos echó del plan a la Plaza del Mercado de Cracovia, que es el
 * sitio número uno de la ciudad. El mundo al revés.
 *
 * El peso no se inventa, ya estaba guardado:
 *
 *   · `bloque` de la ficha del sitio — «imprescindibles» es el primer nivel,
 *     «otros» el segundo, que es exactamente la escala que hacía falta.
 *   · `orden` dentro de ese bloque — la Plaza del Mercado es el #1.
 *   · una excursión pesa como un imprescindible Y ADEMÁS es rígida: tiene hora
 *     de encuentro y no se negocia.
 *   · la comida es lo más flexible del día. Se come antes o después; no se deja
 *     de ver el sitio número uno de la ciudad.
 *
 * `rigido` decide los empates: entre dos cosas del mismo nivel se queda la que
 * tiene el horario que no se puede mover y se busca hueco para la otra.
 */
function importanciaDe(colocado) {
  if (esComida(colocado)) {
    return { nivel: 1, orden: 99, rigido: false, que: 'la comida' };
  }

  const quien = deQuienEs(colocado);

  if (quien?.de === 'sitio' && quien.deId) {
    const sitio = una(
      'SELECT bloque, orden, horarios FROM sitios_lugar WHERE id = ?',
      quien.deId
    );
    const puesto = Number(sitio?.orden) || 99;
    const esImprescindible = sitio?.bloque === 'imprescindibles';
    const intocable = esImprescindible && puesto <= parametro('puestos_intocables_del_sitio', 3);

    return {
      nivel: intocable ? 5 : esImprescindible ? 4 : 3,
      orden: puesto,
      rigido: /\d{1,2}:\d{2}/.test(String(sitio?.horarios ?? '')),
      que: intocable
        ? `imprescindible #${puesto} de la ciudad`
        : esImprescindible
          ? `imprescindible #${puesto}`
          : 'sitio de segundo nivel',
    };
  }

  // UNA EXCURSIÓN OPCIONAL CEDE ANTES QUE UN SITIO DE SEGUNDO NIVEL.
  //
  // Y esto es lo contrario de lo que hacía. Una excursión valía tanto como un
  // imprescindible, así que en Polonia el día completo de Zakopane —opcional, de
  // catálogo, sin pagar— ocupó el día 3 y el Castillo de Wawel, que es EL sitio
  // de Cracovia, se quedó fuera del viaje. Nadie viaja a Cracovia a no ver
  // Wawel.
  //
  // La excepción es la que se paga: una excursión ya RESERVADA tiene hora,
  // billete y dinero dentro, y esa no cede ante nada.
  if (quien?.candidato?.tipo === 'actividad') {
    const reservada = Number(quien.candidato.reservado) === 1;
    return reservada
      ? { nivel: 5, orden: 0, rigido: true, que: 'una excursión ya reservada' }
      : { nivel: 2, orden: 50, rigido: true, que: 'una excursión opcional' };
  }

  return { nivel: 3, orden: 50, rigido: false, que: 'un bloque suelto' };
}

/**
 * DE DOS COSAS QUE CHOCAN, ¿CUÁL SE QUEDA?
 *
 * Devuelve `{ mas, menos }`. El orden de desempate es el que se declaró: nivel,
 * después rigidez —el de horario rígido se queda y el flexible se mueve—, y al
 * final el número de orden dentro de su bloque.
 */
function quienPesaMas(a, b) {
  const ia = importanciaDe(a);
  const ib = importanciaDe(b);

  const gana = (() => {
    if (ia.nivel !== ib.nivel) return ia.nivel > ib.nivel;
    if (ia.rigido !== ib.rigido) return ia.rigido;
    if (ia.orden !== ib.orden) return ia.orden < ib.orden;
    return true; // empate perfecto: se queda el primero del día
  })();

  return gana
    ? { mas: a, menos: b, impMas: ia, impMenos: ib }
    : { mas: b, menos: a, impMas: ib, impMenos: ia };
}

/**
 * EL MISMO LIENZO PERO SIN UNA TARJETA.
 *
 * Para buscarle hueco a algo hay que dejar de contar el hueco que ocupa ello
 * mismo. Sin esto, `horaLibreEn` veía su propio bloque como ocupado y decía que
 * no cabía justo donde estaba: la revisión se daba por vencida y expulsaba.
 */
function sinEl(lienzo, id) {
  return { ...lienzo, colocados: lienzo.colocados.filter((c) => c.id !== id) };
}

/**
 * LO QUE UNA COSA ES, ADEMÁS DE CUÁNTO PESA.
 *
 * EL FALLO QUE ORIGINA ESTO. La revisión movió un espectáculo nocturno de luces
 * —con pases a horas fijas— a las 09:00 de la mañana de otro día para deshacer
 * un solape. Comprobó el cierre del sitio y el tope del día, que era todo lo que
 * sabía comprobar, y no comprobó lo único que importaba: que a esa hora ese
 * espectáculo no existe.
 *
 * `importanciaDe` dice si algo se puede mover antes que otra cosa. Esto dice si
 * se puede mover A DONDE SEA, que es una pregunta distinta y hasta ahora nadie
 * la hacía.
 *
 *   sesiones    · las horas exactas a las que existe, si el dato está.
 *   soloDeNoche · la red cuando no lo está: un espectáculo nocturno no puede
 *                 acabar en una mañana aunque no sepamos a qué hora empieza.
 */
function naturalezaDe(colocado) {
  const quien = deQuienEs(colocado);
  let horarios = null;
  let descripcion = null;

  if (quien?.de === 'sitio' && quien.deId) {
    const sitio = una('SELECT descripcion, horarios FROM sitios_lugar WHERE id = ?', quien.deId);
    horarios = sitio?.horarios ?? null;
    descripcion = sitio?.descripcion ?? null;
  } else if (quien?.candidato?.tipo === 'actividad' && quien.deId) {
    const act = una(
      'SELECT horarios, descripcion_larga FROM catalogo_actividades WHERE id = ?',
      quien.deId
    );
    horarios = act?.horarios ?? null;
    descripcion = act?.descripcion_larga ?? null;
  }

  return {
    sesiones: horasDeSesion(horarios),
    // LA DESCRIPCIÓN NO DECIDE SI ALGO ES NOCTURNO, Y AQUÍ ESTABA MEDIO FALLO.
    //
    // Se le pasaba la descripción de la ficha, y la descripción de cualquier
    // casco antiguo dice cosas como «al atardecer las terrazas se llenan» o «por
    // la noche es cuando más ambiente tiene». Eso marcaba como nocturnos el
    // Casco Viejo de Varsovia y la Plaza Mayor de Cracovia —comprobado con sus
    // descripciones reales— y de ahí salían expulsados como «cosa de última
    // hora». Una plaza no es un espectáculo de luces porque su folleto sea
    // bonito.
    //
    // Lo que sí decide: cómo se LLAMA y qué dice su HORARIO. Un «espectáculo
    // nocturno de luces» lo lleva en el nombre; un pase de las 21:30 lo lleva en
    // el horario. Las dos son afirmaciones, no prosa.
    soloDeNoche: soloAUltimaHora(colocado.nombre, horarios),
  };
}

/** Las franjas en las que algo puede estar, según lo que es. */
function franjasQueAdmite(naturaleza) {
  // Con pases, la franja la deciden las horas y no al revés.
  if (naturaleza.sesiones?.length) {
    return [...new Set(naturaleza.sesiones.map((h) => franjaDesde(h)).filter(Boolean))];
  }
  // Sin dato de pases, lo nocturno al menos no se va a la mañana.
  if (naturaleza.soloDeNoche) return ['tarde', 'noche'];
  return CLAVES_FRANJA;
}

/**
 * ¿PUEDE ESTA COSA EMPEZAR A ESTA HORA?
 *
 * La comprobación que faltaba. Se aplica igual que la del cierre: un movimiento
 * que no la pasa no es una solución, es el mismo problema en otro sitio.
 */
function horaLegitima(naturaleza, hora) {
  if (!hora) return false;
  if (naturaleza.sesiones?.length) return naturaleza.sesiones.includes(hora);
  if (naturaleza.soloDeNoche) return ['tarde', 'noche'].includes(franjaDesde(hora));
  return true;
}

/**
 * LOS DÍAS EN QUE UN SITIO CIERRA, leídos de su horario publicado.
 *
 * La misma fuente que usa el aviso, y por el mismo motivo: si el aviso dice una
 * cosa y la recolocación otra, el sitio acaba rebotando entre días o saliendo
 * del plan por un cierre que solo existía en una lista vieja.
 *
 * Un día que el horario no aclara NO cuenta como cierre: aquí se devuelven solo
 * los que el texto dice, y la duda se queda en el aviso flojito.
 */
function diasDeCierreDe(colocado) {
  const quien = deQuienEs(colocado);
  if (quien?.de !== 'sitio' || !quien.deId) return [];
  const ficha = una('SELECT horarios FROM sitios_lugar WHERE id = ?', quien.deId);
  if (!ficha?.horarios) return [];
  return [0, 1, 2, 3, 4, 5, 6].filter((d) => abreEl(ficha.horarios, d) === false);
}

/** El día de la semana de una fecha «2026-10-16». */
function diaDeLaSemana(fecha) {
  return fecha ? new Date(`${fecha}T12:00:00`).getDay() : null;
}

/**
 * UN HUECO VÁLIDO PARA ESTA COSA EN ESTE DÍA, o null.
 *
 * Junta en un solo sitio las cuatro comprobaciones: el hueco libre, el cierre
 * del sitio, el tope del día y —la nueva— la naturaleza de lo que se coloca.
 */
function huecoValido(tablero, { dia, colocado, naturaleza, cierre, duracion, noAntesDe = null }) {
  // EL DÍA DE ACLIMATACIÓN NO ADMITE NADA CON HORA COMPRADA.
  //
  // El medio día lo impone ya `horaLibreEn`, que acorta el día. Lo que no puede
  // imponer es esto: una excursión o un pase con hora fija obliga a estar en un
  // sitio concreto a una hora concreta, y eso es exactamente lo que no se le
  // pide a alguien que acaba de bajar de un vuelo de doce horas. Si pierde el
  // pase, además, lo ha pagado.
  const aclimatacion = diaDeAclimatacion(tablero);
  if (aclimatacion && dia === aclimatacion.dia && naturaleza.sesiones?.length) return null;

  // Con pases, no se busca «el primer hueco»: se prueban SUS horas.
  if (naturaleza.sesiones?.length) {
    for (const hora of naturaleza.sesiones) {
      const franja = franjaDesde(hora);
      if (!franja) continue;
      if (noAntesDe && hora < noAntesDe) continue;
      const libre = horaLibreEn(tablero, { dia, franja, duracion, noAntesDe: hora, cierraA: cierre });
      if (libre === hora) return hora;
    }
    return null;
  }

  for (const franja of franjasQueAdmite(naturaleza)) {
    const hora = horaLibreEn(tablero, { dia, franja, duracion, noAntesDe, cierraA: cierre });
    if (hora && horaLegitima(naturaleza, hora)) return hora;
  }
  return null;
}

function recolocarConHora(
  viajeId,
  lienzo,
  colocado,
  { desde = null, mismoDia = false, soloOtroDia = false } = {}
) {
  const cierre = cierreDe(colocado);
  const naturaleza = naturalezaDe(colocado);
  const duracion = Number(colocado.duracionMin) || 60;
  const cierra = diasDeCierreDe(colocado);

  // EL TABLERO SIN ESTA TARJETA.
  //
  // Buscarle hueco contando el hueco que ella misma ocupa es buscar donde no
  // hay: `horaLibreEn` empujaba la candidata detrás de su propio bloque y
  // devolvía null. Ese null se leía como «no cabe en ningún sitio» y acababa en
  // una expulsión que no hacía falta.
  const tablero = sinEl(lienzo, colocado.id);

  const puedeEnEsteDia = (d) =>
    !esDiaDeViaje(lienzo, d.n) && !cierra.includes(diaDeLaSemana(d.fecha));

  // 1) Su propio día, incluida su propia franja.
  //
  // Retrasar una visita de las 16:00 a las 16:40 es la solución más barata que
  // existe y la versión anterior ni la consideraba: empezaba a mirar en la
  // franja de después, y de ahí saltaba a otro día o a la calle.
  const diaActual = lienzo.dias.find((d) => d.n === colocado.dia);
  if (!soloOtroDia && diaActual && puedeEnEsteDia(diaActual)) {
    const hora = huecoValido(tablero, {
      dia: colocado.dia,
      colocado,
      naturaleza,
      cierre,
      duracion,
      noAntesDe: desde,
    });
    if (hora) {
      const franja = franjaDesde(hora) ?? colocado.franja;
      if (!mover(colocado.id, { dia: colocado.dia, franja })) return { movido: false };
      retocar(colocado.id, { hora });
      return { movido: true, dia: colocado.dia, franja, hora };
    }
  }

  if (mismoDia) return { movido: false };

  // 2) Otro día de la misma parada, empezando por el primero. EL DÍA DE
  //    ACLIMATACIÓN VA EL ÚLTIMO: el medio día que tiene es para descansar, no
  //    para recoger lo que no cupo en los demás.
  const aclimatacion = diaDeAclimatacion(lienzo);
  const candidatos = lienzo.dias
    .filter((x) => x.etapaId === diaActual?.etapaId && x.n !== colocado.dia && puedeEnEsteDia(x))
    .sort((a, b) => (a.n === aclimatacion?.dia ? 1 : 0) - (b.n === aclimatacion?.dia ? 1 : 0));

  for (const d of candidatos) {
    const hora = huecoValido(tablero, { dia: d.n, colocado, naturaleza, cierre, duracion });
    if (hora) {
      const franja = franjaDesde(hora) ?? colocado.franja;
      if (!mover(colocado.id, { dia: d.n, franja })) return { movido: false };
      retocar(colocado.id, { hora });
      return { movido: true, dia: d.n, franja, hora };
    }
  }

  return { movido: false };
}

/**
 * LO QUE ESTÁ A UNA HORA A LA QUE NO EXISTE.
 *
 * EL FALLO QUE ORIGINA ESTO. Un espectáculo nocturno de luces, con pases a las
 * 20:00 y las 21:30, acabó a las 09:00 de la mañana. La comprobación de cierres
 * lo dejaba pasar porque el sitio «abre» a esa hora: lo que no hay a esa hora es
 * el espectáculo.
 *
 * Se mira TODO lo colocado, no solo lo que la revisión vaya a mover, porque el
 * reparto también se equivoca y su error no lo cazaba nadie. Lo que está a una
 * hora imposible se lleva a una de las suyas; si no cabe en ninguna, sale del
 * plan diciendo por qué, que es mejor que un plan con una cita a la que nadie
 * puede acudir.
 */
function enderezarHorasImposibles(viajeId, lienzo, di, sacar, idos) {
  let tocados = 0;

  for (const c of lienzo.colocados) {
    if (idos.has(c.id)) continue;
    if (esComida(c)) continue;

    const naturaleza = naturalezaDe(c);
    if (!naturaleza.sesiones?.length && !naturaleza.soloDeNoche) continue;
    if (horaLegitima(naturaleza, c.hora)) continue;

    const comoEs = naturaleza.sesiones?.length
      ? `solo tiene pases a las ${naturaleza.sesiones.join(' y ')}`
      : 'es cosa de última hora';

    const r = recolocarConHora(viajeId, lienzo, c);
    if (r.movido) {
      di(`   ${c.nombre} estaba a las ${c.hora} y ${comoEs}: lo paso al día ${r.dia} a las ${r.hora}.`);
      tocados += 1;
      continue;
    }

    // Y LA OTRA MITAD DEL FALLO: esta ruta expulsaba directamente.
    //
    // La jerarquía existía desde el correctivo anterior, pero vivía en la rama
    // de los choques y en la de «muy tarde». Esta —que es la que de verdad puso
    // la etiqueta— llamaba a `sacar` sin preguntarle a nadie. Toda expulsión
    // pasa por el mismo sitio o la regla no sirve de nada.
    if (esDeLosQueNoSePuedenPerder(c)) {
      const ultimo = agotarLaParada(viajeId, lienzo, c, di);
      if (ultimo.movido) {
        di(
          `   ${c.nombre} no se pierde: lo llevo al día ${ultimo.dia} a las ${ultimo.hora}` +
            (ultimo.aparte ? ` (aparté ${ultimo.aparte}).` : '.')
        );
        tocados += 1;
        continue;
      }
      sacar(
        c,
        `${comoEs} y no cabe en ninguna de sus horas en ningún día de la parada — ` +
          `${ultimo.porQueNo.join('; ') || 'sin días alternativos'}`
      );
      tocados += 1;
      continue;
    }

    sacar(c, `estaba a las ${c.hora} y ${comoEs}; no encontré ninguna de sus horas libre`);
    tocados += 1;
  }

  return tocados;
}

/**
 * UNA EXCURSIÓN OPCIONAL NO SE COME EL DÍA DE LO ESENCIAL.
 *
 * EL CASO, Y SALIÓ EN LOS DOS PAÍSES SEGUIDOS:
 *
 *   · Varsovia, 2 noches. La excursión a Majdanek y Lublin —nueve horas, y ni
 *     siquiera es Varsovia— ocupó el único día completo. Fuera: Casco Viejo,
 *     Museo del Levantamiento, POLIN, Palacio Real y Łazienki.
 *   · Atenas, 2 noches. Delfos, diez horas, el único día completo. Fuera: Museo
 *     de la Acrópolis, Ágora Antigua y Museo Arqueológico Nacional.
 *
 * La jerarquía no lo cazaba porque NO HAY CHOQUE que resolver: la excursión
 * ocupa el día y los imprescindibles sencillamente no llegan a colocarse nunca.
 * No hay dos bloques peleando por una hora; hay uno que nunca entró.
 *
 * Así que se mira al revés: si han quedado imprescindibles de los primeros
 * puestos SIN COLOCAR y hay una excursión opcional de día completo ocupando un
 * día de esa parada, la excursión se va a la mochila y los sitios ocupan el día
 * que ella tenía. Una excursión opcional se puede hacer en otro viaje; el motivo
 * por el que uno duerme en esa ciudad, no.
 *
 * NO SE TOCA una excursión ya reservada: esa tiene billete y dinero dentro.
 */
function liberarLoQueSeComeLaExcursion(viajeId, viaje, lienzo, di) {
  const etapas = todas(
    "SELECT * FROM etapas WHERE viaje_id = ? AND estado = 'confirmada' ORDER BY orden",
    viajeId
  );
  const diaCompleto = parametro('excursion_dia_completo_min', 480);
  let tocado = false;

  for (const etapa of etapas) {
    const suyos = imprescindiblesDeParada(etapa).slice(
      0,
      parametro('puestos_intocables_del_sitio', 3)
    );
    if (!suyos.length) continue;

    const estaColocado = (sitioId) =>
      Boolean(
        una(
          `SELECT 1 FROM itinerario i JOIN candidatos c ON c.id = i.candidato_id
            WHERE i.viaje_id = ? AND c.tipo = 'sitio' AND c.datos_extra LIKE ?`,
          viajeId,
          `%"deId":${sitioId}%`
        )
      );

    const sinColocar = suyos.filter((x) => !estaColocado(x.id));
    if (!sinColocar.length) continue;

    // ¿Hay una excursión opcional de día completo comiéndose un día de aquí?
    const diasDeLaEtapa = lienzo.dias.filter((d) => d.etapaId === etapa.id).map((d) => d.n);
    const culpables = lienzo.colocados.filter((c) => {
      if (!diasDeLaEtapa.includes(c.dia)) return false;
      const quien = deQuienEs(c);
      if (quien?.candidato?.tipo !== 'actividad') return false;
      if (Number(quien.candidato.reservado) === 1) return false;
      return (Number(c.duracionMin) || 0) >= diaCompleto;
    });

    if (!culpables.length) continue;

    for (const c of culpables) {
      di(
        `   AVISO GRAVE · ${etapa.nombre_ciudad}: «${c.nombre}» ocupa un día entero y deja fuera ` +
          `${sinColocar.length} imprescindible(s) de la ciudad (${sinColocar.map((x) => x.nombre).join(', ')}).`,
        ORIGENES.ninguno
      );
      sacarDelPlan(c, di, `no cabe sin sacrificar lo esencial de ${etapa.nombre_ciudad}`);
      apuntarHueco(
        viajeId,
        FASE,
        `${etapa.nombre_ciudad}: «${c.nombre}» a la mochila — no cabía sin dejar fuera lo esencial.`
      );
      tocado = true;
    }

    // Y el día que ha quedado libre se usa para lo que de verdad era el motivo.
    const fresco = lienzoDeViaje(viajeId);
    const diasLibres = [...new Set(culpables.map((c) => c.dia))];
    const liberados = diasLibres.join(', ');
    di(
      `   Día ${liberados} liberado: repesco ${sinColocar.map((x) => x.nombre).join(', ')}.`,
      ORIGENES.ninguno
    );

    // EL TABLERO SE RELEE ENTRE UNA Y OTRA.
    //
    // Con la foto de antes, los tres vieron el mismo hueco de las 09:00 y los
    // tres se colocaron ahí, encimados. Un hueco deja de estarlo en cuanto lo
    // ocupa el primero.
    const repescados = [];
    let tablero = fresco;
    for (const x of sinColocar) {
      if (colocarImprescindible(viajeId, tablero, etapa, x, di, diasLibres)) {
        repescados.push(x.nombre);
        tocado = true;
        tablero = lienzoDeViaje(viajeId);
      }
    }
    di(
      repescados.length
        ? `   ${etapa.nombre_ciudad}: repescados ${repescados.join(', ')}.`
        : `   ${etapa.nombre_ciudad}: no cupo ninguno ni con el día libre.`,
      ORIGENES.ninguno
    );
  }

  return tocado ? lienzoDeViaje(viajeId) : lienzo;
}

/**
 * Coloca un imprescindible que se había quedado fuera, en el primer hueco válido
 * de su parada. Devuelve true si lo ha conseguido.
 */
function colocarImprescindible(viajeId, lienzo, etapa, sitio, di, diasLibres = []) {
  let candidato = una(
    `SELECT id FROM candidatos
      WHERE viaje_id = ? AND etapa_id = ? AND tipo = 'sitio' AND datos_extra LIKE ?`,
    viajeId,
    etapa.id,
    `%"deId":${sitio.id}%`
  );
  // LA REPESCA. Y aquí estaba el hueco que dejó Tesalónica vacía.
  //
  // El aviso grave hizo bien su trabajo: echó la excursión a Pozar y Édessa
  // porque se comía el día de los imprescindientes. Pero los tres que liberaba
  // —Santa Sofía, los Santos Demetrio y el Museo Arqueológico— ya no eran ni
  // candidatos: la colocación inicial los había descartado por falta de hueco,
  // cuando la excursión todavía ocupaba el día. Esta función se encontró sin
  // candidato al que agarrarse y dijo «no lo coloco yo». Resultado: dos noches
  // en Tesalónica para un free tour.
  //
  // Liberar un día y no repescar lo que ese día impedía es quedarse a medias. Se
  // vuelve a apuntar —`alternarApuntado` crea el candidato cuando no lo hay— y
  // se coloca con la misma lógica de siempre.
  if (!candidato) {
    const r = alternarApuntado(etapa.id, 'sitio', sitio.id);
    if (!r) {
      di(`   ${sitio.nombre} no se pudo volver a apuntar en ${etapa.nombre_ciudad}.`);
      return false;
    }
    candidato = una(
      `SELECT id FROM candidatos
        WHERE viaje_id = ? AND etapa_id = ? AND tipo = 'sitio' AND datos_extra LIKE ?`,
      viajeId,
      etapa.id,
      `%"deId":${sitio.id}%`
    );
    if (!candidato) {
      di(`   ${sitio.nombre}: lo apunté pero no lo encuentro de vuelta; lo dejo.`);
      return false;
    }
  }

  const falso = {
    id: null,
    candidatoId: candidato.id,
    nombre: sitio.nombre,
    duracionMin: sitio.minutos,
    dia: lienzo.dias.find((d) => d.etapaId === etapa.id)?.n ?? 1,
    franja: 'manana',
  };
  const naturaleza = naturalezaDe(falso);
  const cierre = cierreDe(falso);
  const cierra = diasDeCierreDe(falso);

  // EL DÍA QUE HA QUEDADO LIBRE VA PRIMERO: es el que la excursión ocupaba y el
  // que se ha vaciado para esto. Repescar y mandarlo a otro día sería dejar el
  // día vacío igual, que es justo lo que se quería evitar.
  const dias = lienzo.dias
    .filter((x) => x.etapaId === etapa.id)
    .sort((a, b) => (diasLibres.includes(b.n) ? 1 : 0) - (diasLibres.includes(a.n) ? 1 : 0));

  for (const d of dias) {
    if (esDiaDeViaje(lienzo, d.n)) continue;
    if (cierra.includes(diaDeLaSemana(d.fecha))) continue;

    const hora = huecoValido(lienzo, {
      dia: d.n,
      colocado: falso,
      naturaleza,
      cierre,
      duracion: sitio.minutos,
    });
    if (!hora) continue;

    colocar(viajeId, {
      candidatoId: candidato.id,
      dia: d.n,
      franja: franjaDesde(hora) ?? 'manana',
      hora,
      duracionMin: sitio.minutos,
    });
    di(`   ${sitio.nombre} entra en el día ${d.n} a las ${hora}, en el hueco que deja la excursión.`);
    return true;
  }

  di(`   ${sitio.nombre} sigue sin hueco en ${etapa.nombre_ciudad} ni quitando la excursión.`);
  return false;
}

/** «Hotel Alkyon, en Oia · a 3,2 km del centro», o lo que se sepa de él. */
function dondeSeDuerme(etapa) {
  const h = una(
    "SELECT titulo, datos_extra FROM candidatos WHERE etapa_id = ? AND tipo = 'hotel' AND marcado = 1",
    etapa.id
  );
  if (!h) return '(todavía sin alojamiento elegido)';

  let extra = {};
  try {
    extra = h.datos_extra ? JSON.parse(h.datos_extra) : {};
  } catch {
    extra = {};
  }

  const donde = [extra.zona, extra.direccion].filter(Boolean)[0] ?? null;
  return (
    `${h.titulo}` +
    (donde ? ` · zona: ${donde}` : '') +
    (extra.distanciaCentro ? ` · ${extra.distanciaCentro}` : '')
  );
}

/**
 * DEJA DICHO POR QUÉ EL PRIMER DÍA VA MEDIO VACÍO.
 *
 * EL FALLO QUE ORIGINA ESTO. Tras un vuelo nocturno de más de doce horas y con
 * un cambio horario grande, el día de llegada se montó con actividades desde
 * primera hora y carga completa, como si fuera una llegada europea de dos horas.
 *
 * La regla la aplica `horaLibreEn`, que ese día acorta el día a la mitad y el
 * siguiente no lo deja empezar temprano. Pero una regla que actúa en silencio se
 * lee como un hueco sin explicar: quien mire el plan verá el primer día flojo y
 * pensará que falta algo. Aquí se dice el motivo, que es la mitad del arreglo.
 *
 * Y se comprueba lo que quedó puesto: si la IA colocó ahí algo con hora
 * comprada, la revisión ya no lo mueve —lo suyo es no ponerlo— pero tiene que
 * salir en los avisos.
 */
function contarLoDeLaAclimatacion(viajeId, lienzo, di) {
  const a = diaDeAclimatacion(lienzo);
  if (!a) return;

  di(
    `Día ${a.dia}: ${a.porQue}. Lo dejo a medio gas y cerca del hotel, y el día ` +
      `${a.dia + 1} no empieza antes de las ${parametroTexto('hora_inicio_tras_jetlag', '10:00')}.`,
    ORIGENES.ninguno
  );

  const conHora = lienzo.colocados.filter(
    (c) => c.dia === a.dia && naturalezaDe(c).sesiones?.length
  );
  if (conHora.length) {
    for (const c of conHora) {
      di(`   OJO: ${c.nombre} tiene hora fija y cae el día de aclimatación.`, ORIGENES.ninguno);
    }
    apuntarHueco(
      viajeId,
      FASE,
      `El día ${a.dia} es de aclimatación y lleva ${conHora.length} cosa(s) con hora fija.`
    );
  }
}

/**
 * ¿ES ESTO DE LO QUE NO SE PUEDE PRESCINDIR?
 *
 * Un imprescindible de los primeros puestos de la ciudad. No todos los
 * imprescindibles son iguales: el #1 de Cracovia es la Plaza del Mercado y el
 * #7 es una sinagoga que mucha gente se salta. El corte sale de un parámetro
 * porque es una decisión de gusto, no una verdad.
 */
function esDeLosQueNoSePuedenPerder(colocado) {
  return importanciaDe(colocado).nivel >= 5;
}

/**
 * ANTES DE ECHAR UN IMPRESCINDIBLE, AGOTAR LA PARADA ENTERA.
 *
 * EL FALLO QUE ORIGINA ESTO. El sitio más icónico de una ciudad se quedó fuera
 * del viaje con el motivo «el otro día no tiene hueco dentro de su horario»,
 * cuando la parada tenía más días y alguno con la mañana libre. La búsqueda
 * miraba UN día alternativo, el primero que encontraba, y con lo que ya hubiera
 * puesto encima.
 *
 * Un sitio del primer nivel no se va del viaje porque un museo de segundo nivel
 * le esté ocupando la mañana: la jerarquía ya existe y aquí se usa también,
 * apartando al que menos pesa de cada día antes de darse por vencido.
 *
 * Y si al final no cabe, el motivo dice QUÉ PASÓ CADA DÍA. «No había hueco» es
 * lo que se escribió la primera vez y no permite saber si el fallo fue del
 * reparto o del dato.
 */
function agotarLaParada(viajeId, lienzo, colocado, di) {
  const naturaleza = naturalezaDe(colocado);
  const cierre = cierreDe(colocado);
  const cierra = diasDeCierreDe(colocado);
  const duracion = Number(colocado.duracionMin) || 60;

  const diaActual = lienzo.dias.find((d) => d.n === colocado.dia);
  const aclimatacion = diaDeAclimatacion(lienzo);
  const dias = lienzo.dias
    .filter((d) => d.etapaId === diaActual?.etapaId)
    .sort((a, b) => (a.n === aclimatacion?.dia ? 1 : 0) - (b.n === aclimatacion?.dia ? 1 : 0));

  const porQueNo = [];
  let tablero = lienzo;

  for (const d of dias) {
    if (esDiaDeViaje(lienzo, d.n)) {
      porQueNo.push(`día ${d.n}: es día de viaje`);
      continue;
    }
    if (cierra.includes(diaDeLaSemana(d.fecha))) {
      porQueNo.push(`día ${d.n}: el sitio cierra ese día`);
      continue;
    }

    // 1) ¿Cabe tal cual?
    const hora = huecoValido(sinEl(tablero, colocado.id), {
      dia: d.n,
      colocado,
      naturaleza,
      cierre,
      duracion,
    });
    if (hora) {
      const franja = franjaDesde(hora) ?? colocado.franja;
      if (mover(colocado.id, { dia: d.n, franja })) {
        retocar(colocado.id, { hora });
        return { movido: true, dia: d.n, franja, hora, porQueNo };
      }
    }

    // 2) ¿Y si aparto lo que menos pesa de ese día?
    const apartado = apartarAlMasLigero(viajeId, tablero, colocado, d.n, di);
    if (!apartado) {
      porQueNo.push(`día ${d.n}: lleno y sin nada de menor nivel que apartar`);
      continue;
    }

    tablero = lienzoDeViaje(viajeId);
    const segunda = huecoValido(sinEl(tablero, colocado.id), {
      dia: d.n,
      colocado,
      naturaleza,
      cierre,
      duracion,
    });
    if (segunda) {
      const franja = franjaDesde(segunda) ?? colocado.franja;
      if (mover(colocado.id, { dia: d.n, franja })) {
        retocar(colocado.id, { hora: segunda });
        return { movido: true, dia: d.n, franja, hora: segunda, aparte: apartado, porQueNo };
      }
    }
    porQueNo.push(`día ${d.n}: ni apartando ${apartado} quedaba sitio en su horario`);
  }

  return { movido: false, porQueNo };
}

/**
 * APARTA DE UN DÍA LO QUE MENOS PESA, si pesa menos que quien pide sitio.
 *
 * Devuelve el nombre de lo apartado, o null si no había nada que apartar. No
 * expulsa a nadie: solo lo manda a otro día donde quepa. Si no cabe en ningún
 * otro sitio, se queda donde está y quien pedía sitio se busca la vida.
 */
function apartarAlMasLigero(viajeId, lienzo, quienPide, dia, di) {
  const impPide = importanciaDe(quienPide);

  const candidatos = lienzo.colocados
    .filter((c) => c.dia === dia && c.id !== quienPide.id && !esComida(c))
    .map((c) => ({ c, imp: importanciaDe(c) }))
    .filter((x) => x.imp.nivel < impPide.nivel || (x.imp.nivel === impPide.nivel && x.imp.orden > impPide.orden))
    .sort((a, b) => a.imp.nivel - b.imp.nivel || b.imp.orden - a.imp.orden);

  for (const { c, imp } of candidatos) {
    const r = recolocarConHora(viajeId, lienzo, c, { soloOtroDia: true });
    if (r.movido) {
      di(
        `   Aparto ${c.nombre} (${imp.que}) al día ${r.dia} a las ${r.hora} para hacer sitio a ` +
          `${quienPide.nombre} (${impPide.que}).`
      );
      return c.nombre;
    }
  }
  return null;
}

/**
 * LA JERARQUÍA AL DESHACER UN CHOQUE.
 *
 * El fallo que arregla esto se vio en Polonia: seis expulsiones y ni un solo
 * reencaje, entre ellas la Plaza del Mercado de Cracovia por pisarse cuarenta
 * minutos con la comida. Expulsar era el primer recurso y el único.
 *
 * Ahora es el ÚLTIMO, y antes se prueban por orden las tres cosas que no cuestan
 * nada y que una persona haría sin pensarlo:
 *
 *   a) RECORTAR el bloque que menos pesa, si es el que va delante. Una comida de
 *      90 minutos que estorba 40 se come en 50 y no estorba.
 *   b) RETRASAR lo que va detrás, si el día tiene aire. Preserva las dos cosas.
 *   c) MOVERLO a otro día de la misma parada.
 *   d) EXPULSAR, y al que menos pesa de los dos. Nunca al de mayor nivel.
 *
 * Y en los cuatro pasos el hueco se busca con los MISMOS chequeos que la
 * colocación inicial —cierre del sitio, tope del día, bloques fijos, días de
 * viaje—, porque una solución en hora inválida no es una solución: así se
 * colocó la Lonja de los Paños a las 21:30 de un sitio que cierra a las 18:00.
 *
 * Devuelve cuántas tarjetas ha tocado.
 */
function resolverChoque(viajeId, lienzo, aviso, porId, di, sacar) {
  const pareja = (aviso.idsEnConflicto ?? []).map((id) => porId.get(id)).filter(Boolean);

  // Sin la pareja completa no hay jerarquía posible: se cae al camino de
  // siempre, que al menos ya valida el hueco.
  if (pareja.length < 2) {
    const solo = (aviso.idsAfectados ?? []).map((id) => porId.get(id)).filter(Boolean).pop();
    if (!solo) return 0;
    const r = recolocarConHora(viajeId, lienzo, solo, { desde: aviso.libreDesde });
    if (r.movido) di(`   Día ${aviso.dia}: ${solo.nombre} pasa al día ${r.dia} a las ${r.hora}.`);
    else sacar(solo, 'chocaba y no había hueco en ningún día de la parada');
    return 1;
  }

  const [primero, segundo] = pareja;
  const { mas, menos, impMas, impMenos } = quienPesaMas(primero, segundo);

  // A qué hora puede empezar el segundo sin pisar al primero. En un solape es
  // cuando acaba el primero; en un «no llegas» incluye además el trayecto, y por
  // eso se lee del aviso en vez de recalcularlo.
  const puedeDesde = enMinutos(aviso.libreDesde);
  const empiezaSegundo = enMinutos(segundo.hora);
  if (puedeDesde == null || empiezaSegundo == null) return 0;

  const estorbo = puedeDesde - empiezaSegundo;
  if (estorbo <= 0) return 0;

  const intentos = [];

  // --- a) RECORTAR el que menos pesa, si va delante ------------------------
  //
  // UNA EXCURSIÓN NO SE RECORTA. Dura lo que dura: un día completo a Zakopane no
  // es un día completo de sesenta minutos. La prueba de este bloque lo dejó a la
  // vista —«se recorta de 540 a 60 min»— y un plan que dijera eso sería mentira.
  // Se salta el recorte y se va a moverla, que es lo que de verdad se puede
  // hacer con ella.
  const seDejaRecortar = (c) => deQuienEs(c)?.candidato?.tipo !== 'actividad';

  if (menos.id === primero.id && seDejaRecortar(primero)) {
    const suelo = parametro('duracion_minima_al_recortar_min', 45);
    const duracion = Number(primero.duracionMin) || 0;
    const recortada = duracion - estorbo;
    if (duracion > 0 && recortada >= suelo) {
      retocar(primero.id, { duracionMin: recortada });
      di(
        `   Día ${aviso.dia}: ${primero.nombre} se recorta de ${duracion} a ${recortada} min ` +
          `y deja sitio a ${segundo.nombre} (${impMas.que} frente a ${impMenos.que}).`
      );
      return 1;
    }
    intentos.push(
      duracion > 0
        ? `recortar ${primero.nombre} (se quedaba en ${recortada} min y el mínimo son ${suelo})`
        : `recortar ${primero.nombre}, que no tiene duración puesta`
    );
  } else if (menos.id === primero.id) {
    intentos.push(`recortar ${primero.nombre}, que es una excursión y dura lo que dura`);
  }

  // --- b) RETRASAR lo posterior, si el día tiene aire ----------------------
  //
  // Se intenta con el segundo sea quien sea el que pesa más: si cabe un poco más
  // tarde, se salvan los dos y no hay nada que decidir.
  const retraso = recolocarConHora(viajeId, lienzo, segundo, {
    desde: aviso.libreDesde,
    mismoDia: true,
  });
  if (retraso.movido) {
    di(
      `   Día ${aviso.dia}: ${segundo.nombre} se retrasa a las ${retraso.hora}, ` +
        `detrás de ${primero.nombre}.`
    );
    return 1;
  }
  intentos.push(`retrasar ${segundo.nombre} en su día`);

  // --- c) MOVER el que menos pesa a otro día válido ------------------------
  //
  // La comida no viaja de día: es un bloque diario. Si no ha podido recortarse
  // ni retrasarse, se queda el aviso escrito antes que convertirla en cena.
  if (esComida(menos)) {
    di(
      `   Día ${aviso.dia}: ${menos.nombre} choca con ${mas.nombre} y no he podido ` +
        `${intentos.join(' ni ')}. La comida no cambia de día: lo dejo dicho.`
    );
    return 0;
  }

  const mudanza = recolocarConHora(viajeId, lienzo, menos, { soloOtroDia: true });
  if (mudanza.movido) {
    di(
      `   Día ${aviso.dia}: ${menos.nombre} pasa al día ${mudanza.dia} a las ${mudanza.hora} ` +
        `(pesa menos que ${mas.nombre}: ${impMenos.que} frente a ${impMas.que}).`
    );
    return 1;
  }
  intentos.push('moverlo a otro día de la parada');

  // --- d) EXPULSAR, y al que menos pesa ------------------------------------
  //
  // Salvo que el que toca echar sea de los que no se pueden perder: entonces se
  // recorre la parada entera antes, apartando lo ligero de cada día. Es caro y
  // se hace solo aquí, que es donde el error no tiene arreglo después.
  if (esDeLosQueNoSePuedenPerder(menos)) {
    const ultimo = agotarLaParada(viajeId, lienzo, menos, di);
    if (ultimo.movido) {
      di(
        `   Día ${aviso.dia}: ${menos.nombre} (${impMenos.que}) no se pierde: lo llevo al día ` +
          `${ultimo.dia} a las ${ultimo.hora}` + (ultimo.aparte ? ` (aparté ${ultimo.aparte}).` : '.')
      );
      return 1;
    }
    sacar(
      menos,
      `es de lo que no hay que perderse, pero no pude ${intentos.join(' ni ')} ` +
        `y tampoco cabe en ningún otro día — ${ultimo.porQueNo.join('; ') || 'sin días alternativos'}`
    );
    return 1;
  }

  sacar(
    menos,
    `no pude ${intentos.join(' ni ')}: lo expulso por ser el de menor nivel ` +
      `(${impMenos.que}) frente a ${mas.nombre} (${impMas.que})`
  );
  return 1;
}

/**
 * UNA PASADA DE CORRECCIONES. Devuelve cuántas cosas ha tocado.
 *
 * Cada tipo de aviso tiene su arreglo. Lo que no sepa arreglar se queda como
 * está y se dirá al final: mejor un aviso escrito que un arreglo inventado.
 */
export function corregirAvisos(viajeId, lienzo, di, fuera, duracionComida, horaTope = '22:00') {
  let tocados = 0;
  const porId = new Map(lienzo.colocados.map((c) => [c.id, c]));

  // LO QUE YA SE HA IDO NO SE VUELVE A TOCAR.
  //
  // `lienzo` es una foto tomada antes de la pasada, y un aviso puede nombrar una
  // tarjeta que otro aviso anterior acaba de expulsar. Sin esto, la revisión
  // «movía al día 6 a las 20:00» algo que ya no estaba en el plan: no rompía
  // nada, pero escribía en el registro un movimiento que no ocurrió. Un registro
  // que miente es peor que uno que calla.
  const idos = new Set();
  const sacar = (c, motivo) => {
    idos.add(c.id);
    fuera.push(sacarDelPlan(c, di, motivo));

    // PERDER UN IMPRESCINDIBLE DE PRIMER NIVEL NO ES UNA LÍNEA MÁS DEL LOG.
    //
    // En Polonia el Castillo de Wawel se fue del viaje y quedó dicho en el
    // mismo tono que un museo de tercera. Si al final pasa —y con la jerarquía
    // nueva tiene que costar mucho— se dice con todas las letras y sube a los
    // huecos de la fase, que es lo que se mira al terminar.
    if (esDeLosQueNoSePuedenPerder(c)) {
      const imp = importanciaDe(c);
      di(`   AVISO GRAVE · ${c.nombre} (${imp.que}) se queda FUERA del viaje: ${motivo}.`, ORIGENES.ninguno);
      apuntarHueco(viajeId, FASE, `Imprescindible de primer nivel expulsado: ${c.nombre} — ${motivo}.`);
    }
  };
  const yaNoEsta = (aviso) =>
    [...(aviso.idsAfectados ?? []), ...(aviso.idsEnConflicto ?? [])].some((id) => idos.has(id));

  // LAS HORAS IMPOSIBLES, ANTES QUE NADA.
  //
  // Va delante del bucle de avisos y no dentro por lo que enseñó la prueba: el
  // espectáculo nocturno ya estaba a las 10:00 ANTES de la revisión, puesto por
  // el reparto. La revisión deshizo el solape recortando al vecino —solución
  // correcta para el solape— y dejó el espectáculo a las diez de la mañana, que
  // era el problema de verdad. Un movimiento válido no arregla una colocación
  // imposible: hay que mirarla por su cuenta.
  tocados += enderezarHorasImposibles(viajeId, lienzo, di, sacar, idos);

  for (const aviso of lienzo.avisos) {
    if (yaNoEsta(aviso)) continue;

    const dia = lienzo.dias.find((d) => d.n === aviso.dia);
    const afectados = (aviso.idsAfectados ?? []).map((id) => porId.get(id)).filter(Boolean);

    if (aviso.tipo === 'sin-comida') {
      // A la hora de comer, pero no antes de que el día esté libre: en un día de
      // llegada el mediodía puede caer dentro del tren, y poner ahí la comida
      // sería crear el aviso siguiente.
      const fijos = dia?.fijos ?? lienzo.fijos.filter((f) => f.dia === aviso.dia);
      const llega =
        fijos.find((f) => f.donde === 'salto')?.horaFin ??
        fijos.find((f) => f.donde === 'ida')?.hora ??
        null;

      const pronto = llega && Number(llega.split(':')[0]) > 13 ? llega : '13:30';

      // PONER LA COMIDA ES COLOCAR, Y COLOCAR SE VALIDA.
      //
      // La versión anterior la clavaba a las 13:30 mirara lo que hubiera en esa
      // hora: si el día ya tenía algo ahí, el aviso de «sin comida» se cambiaba
      // por uno de solape y la pasada siguiente lo resolvía a hachazos. Ahora se
      // busca un hueco de verdad, que es lo mismo que hace la colocación inicial.
      const hora =
        horaLibreEn(lienzo, {
          dia: aviso.dia,
          franja: 'mediodia',
          duracion: duracionComida,
          noAntesDe: pronto,
        }) ??
        horaLibreEn(lienzo, {
          dia: aviso.dia,
          franja: 'tarde',
          duracion: duracionComida,
          noAntesDe: pronto,
        });

      if (!hora || Number(hora.split(':')[0]) >= 16) {
        di(`   Día ${aviso.dia}: no hay hueco a una hora de comer; lo dejo dicho.`);
        continue;
      }

      const franja = franjaDesde(hora) ?? 'mediodia';

      colocar(viajeId, {
        textoManual: 'Comer',
        dia: aviso.dia,
        franja,
        hora,
        duracionMin: duracionComida,
      });
      di(`   Día ${aviso.dia}: le faltaba la comida; se la pongo a las ${hora}.`);
      tocados += 1;
      continue;
    }

    if (aviso.tipo === 'hora-franja') {
      for (const c of afectados) {
        const natural = franjaDesde(c.hora);
        if (!natural || natural === c.franja) continue;
        mover(c.id, { dia: c.dia, franja: natural });
        di(`   Día ${aviso.dia}: ${c.nombre} pasa a ${natural}, que es donde cae su hora.`);
        tocados += 1;
      }
      continue;
    }

    if (aviso.tipo === 'durante-el-traslado' || aviso.tipo === 'antes-de-llegar') {
      // Detrás del viaje, que es cuando empieza el día de verdad.
      const fijo = (dia?.fijos ?? lienzo.fijos.filter((f) => f.dia === aviso.dia)).find((f) =>
        aviso.tipo === 'durante-el-traslado' ? f.donde === 'salto' : f.donde === 'ida'
      );
      const libre = franjaDesde(fijo?.horaFin ?? fijo?.hora);

      // La hora a la que queda libre el día: la de llegada del viaje.
      const quedaLibre = aviso.libreDesde ?? fijo?.horaFin ?? fijo?.hora ?? null;

      for (const c of afectados) {
        const r = recolocarConHora(viajeId, lienzo, c, { desde: quedaLibre });
        if (r.movido) {
          di(`   Día ${aviso.dia}: ${c.nombre} pasa al día ${r.dia} a las ${r.hora}, después del viaje.`);
        } else {
          sacar(c, 'no cabía después del viaje ni en otro día');
        }
        tocados += 1;
      }
      continue;
    }

    if (aviso.tipo === 'pisa-la-salida') {
      // Delante del vuelo o fuera: detrás no hay día.
      for (const c of afectados) {
        const r = recolocarConHora(viajeId, lienzo, c, { mismoDia: false });
        if (r.movido) {
          di(`   Día ${aviso.dia}: ${c.nombre} pasa al día ${r.dia} a las ${r.hora}, antes del vuelo.`);
        } else {
          sacar(c, 'seguía a la hora del vuelo de vuelta y no cabía antes');
        }
        tocados += 1;
      }
      continue;
    }

    if (aviso.tipo === 'pisa-la-llegada') {
      for (const c of afectados) {
        const r = recolocarConHora(viajeId, lienzo, c, { desde: aviso.libreDesde });
        if (r.movido) {
          di(`   Día ${aviso.dia}: ${c.nombre} pasa a las ${r.hora}, ya con el viaje hecho.`);
        } else {
          sacar(c, 'caía antes de llegar y no había hueco después');
        }
        tocados += 1;
      }
      continue;
    }

    if (aviso.tipo === 'despues-de-irse') {
      for (const c of afectados) {
        sacar(c, 'caía después del viaje de vuelta');
        tocados += 1;
      }
      continue;
    }

    // UN HORARIO QUE NO SE ENTIENDE NO SE ARREGLA MOVIENDO NADA.
    //
    // Es el aviso flojito del bloque A: el sitio se queda donde está y alguien
    // lo mira antes de ir. Se atiende aquí para que no caiga en el saco de «no
    // he sabido resolverlo», que es para los que sí tienen arreglo.
    if (aviso.tipo === 'horario-sin-verificar') {
      di(`   ${aviso.texto}`, ORIGENES.ninguno);
      continue;
    }

    // ABRE ESE DÍA PERO NO A ESA HORA: se busca una hora suya.
    //
    // Es el mismo arreglo que un cierre, solo que sin cambiar de día si no hace
    // falta: `recolocarConHora` ya respeta la hora de cierre del sitio.
    if (aviso.tipo === 'fuera-de-horario') {
      for (const c of afectados) {
        const r = recolocarConHora(viajeId, lienzo, c);
        if (r.movido) {
          di(`   ${c.nombre} estaba fuera de su horario: lo paso al día ${r.dia} a las ${r.hora}.`);
        } else if (esDeLosQueNoSePuedenPerder(c)) {
          const ultimo = agotarLaParada(viajeId, lienzo, c, di);
          if (ultimo.movido) {
            di(`   ${c.nombre} no se pierde: al día ${ultimo.dia} a las ${ultimo.hora}.`);
          } else {
            sacar(c, `no cabe dentro de su horario en ningún día de la parada`);
          }
        } else {
          sacar(c, 'estaba fuera de su horario y no encontré ninguna hora suya libre');
        }
        tocados += 1;
      }
      continue;
    }

    if (aviso.tipo === 'sitio-cerrado') {
      for (const c of afectados) {
        // TODOS LOS DÍAS DE LA PARADA, NO EL PRIMERO QUE HAYA.
        //
        // La versión anterior buscaba UN día alternativo en el que el sitio
        // abriera y miraba si quedaba hueco con lo que ya hubiera puesto encima.
        // Si no, fuera. Así se perdió el sitio más icónico de una ciudad que
        // tenía más días libres, y el motivo escrito —«el otro día no tiene
        // hueco»— ni siquiera decía cuáles se habían mirado.
        //
        // Los días de cierre se leen de la ficha (`cierra_dias`, 0 = domingo),
        // no del texto del aviso: el texto está escrito para una persona y
        // reconstruir el dato a base de expresiones regulares es pedir un fallo.
        const r = agotarLaParada(viajeId, lienzo, c, di);

        if (r.movido) {
          di(
            `   ${c.nombre} cerraba ese día: lo paso al día ${r.dia} a las ${r.hora}` +
              (r.aparte ? ` (aparté ${r.aparte}).` : '.')
          );
        } else {
          // EL MOTIVO ENUMERA LOS DÍAS. Sin esto no se puede saber si el fallo
          // fue del reparto o del dato de horarios, que es la diferencia entre
          // arreglar el orquestador y arreglar el scraper.
          const detalle = r.porQueNo.length ? r.porQueNo.join('; ') : 'la parada no tiene días';
          sacar(
            c,
            esDeLosQueNoSePuedenPerder(c)
              ? `es de lo que no hay que perderse y aun así no cabe en ningún día — ${detalle}`
              : `no cabe en ningún día de la parada — ${detalle}`
          );
        }
        tocados += 1;
      }
      continue;
    }

    // DOS CHOQUES DE PAREJA Y DOS DE UNA SOLA TARJETA.
    //
    //   solape / no-llegas · dos bloques que se pisan. Hay que decidir cuál se
    //                        queda, y esa decisión tiene jerarquía: `resolverChoque`.
    //   muy-tarde          · empieza cuando ya no se empieza nada.
    //   recien-llegado     · está pegada a un aterrizaje.
    //
    // Los dos últimos no tienen con quién compararse —el problema es la hora, no
    // el vecino—, así que se les busca hueco y, si no lo hay, salen.
    if (aviso.tipo === 'solape' || aviso.tipo === 'no-llegas') {
      tocados += resolverChoque(viajeId, lienzo, aviso, porId, di, sacar);
      continue;
    }

    if (aviso.tipo === 'muy-tarde' || aviso.tipo === 'recien-llegado') {
      const ultimo = afectados[afectados.length - 1];
      if (!ultimo) continue;

      // LA COMIDA NO SE MUEVE DE FRANJA, SE RETRASA UN RATO.
      //
      // Es un bloque diario y a una hora: mandarla a la noche porque una visita
      // se ha alargado convierte la comida en cena, que es peor que el problema
      // que se quería arreglar. Se le da la hora a la que queda libre el día, y
      // si eso ya no es hora de comer se deja el aviso puesto: mejor decir que
      // no he sabido arreglarlo que arreglarlo mal.
      if (esComida(ultimo)) {
        const libre = aviso.libreDesde;
        const hora = Number(String(libre ?? '').split(':')[0]);
        if (libre && Number.isFinite(hora) && hora < 16) {
          retocar(ultimo.id, { hora: libre });
          di(`   Día ${aviso.dia}: la comida pasa a las ${libre}, que es cuando queda libre.`);
          tocados += 1;
        } else {
          di(`   Día ${aviso.dia}: la comida no cabe a una hora de comer; lo dejo dicho.`);
        }
        continue;
      }

      const PORQUE_SE_MUEVE = {
        'muy-tarde': ' (empezaba demasiado tarde).',
        'recien-llegado': ' (era nada más aterrizar).',
      };
      const PORQUE_SE_VA = {
        'muy-tarde': `empezaba a partir de las ${horaTope} y no había hueco antes en ningún día`,
        'recien-llegado': 'caía justo al aterrizar y no había hueco después en ningún día',
      };

      const r = recolocarConHora(viajeId, lienzo, ultimo, { desde: aviso.libreDesde });
      if (r.movido) {
        di(
          `   Día ${aviso.dia}: ${ultimo.nombre} pasa al día ${r.dia}, ${r.franja} a las ${r.hora}` +
            (PORQUE_SE_MUEVE[aviso.tipo] ?? '.')
        );
        tocados += 1;
        continue;
      }

      // UN IMPRESCINDIBLE NO ES «COSA DE ÚLTIMA HORA».
      //
      // En Polonia se fueron del plan con esa etiqueta el Casco Viejo de
      // Varsovia, el Casco Antiguo de Gdańsk y el Palacio de la Cultura. El
      // casco antiguo ES el motivo de la parada: que la primera hora elegida no
      // cuadre no lo convierte en un relleno del final del día.
      //
      // Antes de echarlo se recorre la parada entera, apartando lo ligero de
      // cada día, que es lo que ya se hace en los choques.
      if (esDeLosQueNoSePuedenPerder(ultimo)) {
        const ultimoIntento = agotarLaParada(viajeId, lienzo, ultimo, di);
        if (ultimoIntento.movido) {
          di(
            `   Día ${aviso.dia}: ${ultimo.nombre} no se pierde por la hora: lo llevo al día ` +
              `${ultimoIntento.dia} a las ${ultimoIntento.hora}` +
              (ultimoIntento.aparte ? ` (aparté ${ultimoIntento.aparte}).` : '.')
          );
          tocados += 1;
          continue;
        }
        sacar(
          ultimo,
          `no cabe en ninguna hora válida de ningún día de la parada — ` +
            `${ultimoIntento.porQueNo.join('; ') || 'sin días alternativos'}`
        );
        tocados += 1;
        continue;
      }

      sacar(ultimo, PORQUE_SE_VA[aviso.tipo] ?? 'no había hueco');
      tocados += 1;
    }
  }

  return tocados;
}

// =============================================================================
// LA FASE
// =============================================================================
export async function ejecutarFaseLienzo(viaje, prompt) {
  const viajeId = viaje.id;
  const di = (t) => anotar(viajeId, FASE, t);

  if (!hayClaveIA()) throw new Error(SIN_CLAVE);

  const auto = configAuto(viaje);
  const { adultos, edadesNinos } = ocupacionDe(viaje);
  const duracionComida = parametro('duracion_comida_min', 90);
  const ritmoDelViaje = viaje.ritmo || 'normal';
  const maxLargas = parametro('max_excursiones_largas_por_dia', 1);

  const etapas = todas(
    "SELECT * FROM etapas WHERE viaje_id = ? AND estado = 'confirmada' ORDER BY orden, id",
    viajeId
  );
  if (!etapas.length) {
    di('El viaje no tiene paradas confirmadas: no hay días que repartir.');
    return { etapas: 0, colocados: 0 };
  }

  di(`${etapas.length} parada(s) que repartir. Comida de ${duracionComida} min cada día.`);

  let colocadosEnTotal = 0;
  // Por qué se quedó fuera cada cosa, según lo dijo la propia IA o el cotejo.
  // Se guarda por candidato para poder explicarlo al final por su nombre.
  const motivosDeFuera = new Map();

  // La hora a partir de la cual no se empieza nada. Se lee una vez y se usa en
  // los dos sitios que la necesitan: el prompt y el filtro de lo que entra.
  const horaTope = parametroTexto('hora_maxima_inicio', '22:00');
  const topeDelDia = enMinutosDelDia(horaTope) ?? 22 * 60;
  let sinColocarEnTotal = 0;

  for (const etapa of etapas) {
    const ciudad = etapa.nombre_ciudad;

    // Entre salto y salto no hay nada a medias: el anterior está guardado y del
    // siguiente no se ha tocado nada. Ver el punto de control de la fase 4.
    if (hayQueParar(viajeId, FASE, ciudad)) {
      di(`Parada pedida: lo dejo antes de ${ciudad}.`, ORIGENES.ninguno);
      break;
    }

    // El lienzo se relee en cada etapa: lo colocado en la anterior ya cuenta.
    const lienzo = lienzoDeViaje(viajeId);
    const dias = diasDeLaEtapa(lienzo, etapa.id);

    if (!dias.length) {
      di(`${ciudad}: no tiene días en el lienzo. La salto.`);
      continue;
    }

    const piezas = colocablesDeEtapa(etapa, lienzo).map((p, i) => ({
      ...p,
      // Una referencia propia y no el id del candidato: un sitio generado
      // todavía no tiene candidato, y no lo tendrá hasta que se coloque.
      ref: p.clase === 'excursion' ? `x${i + 1}` : `s${i + 1}`,
    }));
    if (!piezas.length) {
      di(`${ciudad}: no hay nada apuntado que colocar.`);
      continue;
    }

    di(`Colocando los días de ${ciudad}…`);

    // Lo que la IA dice colocar y lo que se pierde por el camino. Se compara al
    // terminar la etapa: una tarjeta que desaparece entre la respuesta y el
    // lienzo tiene que verse.
    const declarados = [];
    const perdidos = [];
    // `puestos` cuenta sitios y excursiones, que es lo que se resume al final;
    // para cotejar hace falta contar TODO lo que entra, comidas incluidas.
    let entradas = 0;

    const datos = {
      CIUDAD: ciudad,
      // El ritmo del viaje, del dato. En el registro de Polonia la IA escribió
      // «ritmo tranquilo» en un viaje de ritmo normal: lo que se le pasa y lo que
      // luego se lee tienen que ser el mismo.
      RITMO: ritmoDelViaje,
      VIAJEROS:
        `${adultos} adulto(s)` +
        (edadesNinos.length ? ` y niños de ${edadesNinos.join(' y ')} años` : ''),
      DURACION_COMIDA: duracionComida,
      MAX_LARGAS: maxLargas,
      FRANJAS: FRANJAS.map((f) => `${f.clave} (${f.etiqueta}, ${f.horas})`).join(' · '),
      // DÓNDE SE DUERME.
      //
      // El prompt no lo sabía, y uno de los principios nuevos pide que el plan
      // pise la zona del hotel — y que si el hotel está en otra localidad que el
      // grueso del plan, esa localidad se gane un atardecer. Es exactamente el
      // caso de Santorini: se dormía en Oia, el plan entero estaba en Fira y Oia
      // acabó expulsada «por falta de franja».
      //
      // Sin el dato, ese principio sería una invitación a suponer dónde está el
      // hotel. Con él, es una comprobación.
      HOTEL: dondeSeDuerme(etapa),
      DIAS: dias
        .map((d) => {
          const lineas = [`- día ${d.n} · ${d.fecha} (${d.diaSemana})`];

          if (!d.fijos.length) {
            lineas.push('  sin nada fijo: día entero disponible');
            return lineas.join('\n');
          }

          for (const f of d.fijos) {
            lineas.push(`  FIJO e intocable: ${f.texto} [franja ${f.franja}]`);
          }

          // A QUÉ HORA EMPIEZA DE VERDAD EL DÍA.
          //
          // Un traslado no es un punto: ocupa de su salida a su llegada. Sin
          // decirlo, la IA leía «PKP Intercity, franja mañana», concluía
          // «llegamos por la mañana» y llenaba la tarde de una ciudad por la que
          // todavía se iba en tren. Ahora se le da masticado y la regla 2 del
          // prompt hace el resto.
          const salto = d.fijos.find((f) => f.donde === 'salto' && f.hora && f.horaFin);
          if (salto) {
            lineas.push(
              `  ESTE DÍA EL TRASLADO OCUPA DE ${salto.hora} A ${salto.horaFin}: ` +
                `el día útil empieza a las ${salto.horaFin}. Nada antes de esa hora.`
            );
          }

          const llegada = d.fijos.find((f) => f.donde === 'ida' && f.hora);
          if (llegada) {
            lineas.push(`  Se llega a las ${llegada.hora}: el día útil empieza ahí.`);
          }

          const salida = d.fijos.find((f) => f.donde === 'vuelta' && f.hora);
          if (salida) {
            lineas.push(`  Se vuela a las ${salida.hora}: el día útil acaba antes de esa hora.`);
          }

          return lineas.join('\n');
        })
        .join('\n'),
      COLOCABLES: piezas
        .map(
          (p) =>
            `- ${p.clase === 'excursion' ? 'EXCURSIÓN' : 'sitio'} ${p.ref} · ${p.nombre}` +
            `${p.categoria ? ` (${p.categoria})` : ''}` +
            `${p.bloque === 'otros' ? ' [segundo nivel]' : ''}` +
            `${p.bloque === 'ninos' ? ' [para niños]' : ''}\n` +
            `  visita: ${p.duracion ?? 'no lo sé'}` +
            `${p.horarios ? `\n  horario: ${String(p.horarios).slice(0, 120)}` : ''}` +
            `${p.cierraTexto ? `\n  CIERRA los ${p.cierraTexto}` : ''}`
        )
        .join('\n'),
    };

    let plan = null;
    try {
      const r = await consultarJSON(rellenar(prompt, datos), {
        maxTokens: 4000,
        paso: `repartir los días de ${ciudad}`,
      });
      plan = Array.isArray(r?.dias) ? r : null;
      if (plan) plan.fuera = Array.isArray(r?.fuera) ? r.fuera : [];
    } catch (err) {
      // SIN IA NO SE REPARTE. Aquí no hay regla de respaldo que valga: colocar
      // por orden de lista sería inventarse un plan, y un plan inventado es peor
      // que ninguno, porque parece uno bueno.
      apuntarHueco(
        viajeId,
        FASE,
        `${ciudad}: no pude repartir los días (${err.message}). Lo apuntado sigue en la mochila.`
      );
      di(`   ${ciudad}: no pude repartir (${err.message}). Sigo con la siguiente parada.`);
      continue;
    }

    if (!plan) {
      apuntarHueco(viajeId, FASE, `${ciudad}: la IA no devolvió un plan que se pueda leer.`);
      continue;
    }

    // --- Guardar, con el mismo `colocar` del arrastre ---------------------
    const porRef = new Map(piezas.map((p) => [p.ref, p]));
    let puestos = 0;

    for (const d of plan.dias) {
      const n = Number(d?.dia);
      if (!dias.some((x) => x.n === n)) continue;

      const resumen = [];

      // LA HORA MANDA SOBRE LA FRANJA, y esto quita una clase entera de avisos.
      //
      // La IA devuelve las dos cosas y a veces no concuerdan: puso la Plaza
      // Szczepański a las 15:30 en la franja de tarde, que empieza a las 16. El
      // lienzo lo detecta y avisa, con razón. Pero es un desajuste aritmético,
      // no una decisión: si hay hora, la franja se deduce de ella y ya no hay
      // nada que avisar.
      const franjaDeLaHora = (hora) => {
        const h = Number(String(hora ?? '').split(':')[0]);
        if (!Number.isFinite(h)) return null;
        return FRANJAS.find((f) => h >= f.desde && h < f.hasta)?.clave ?? 'noche';
      };

      // Y NADA DESPUÉS DE IRSE. El día de salida tiene su bloque fijo con hora:
      // lo que caiga en una franja posterior no es un plan, es una cosa que no
      // se va a poder hacer. Se descarta aquí en vez de dejar el aviso puesto.
      const salida = (dias.find((x) => x.n === n)?.fijos ?? []).find((f) => f.donde === 'vuelta');
      const topeFranja = salida ? CLAVES_FRANJA.indexOf(salida.franja) : -1;

      for (const item of Array.isArray(d?.plan) ? d.plan : []) {
        // LO QUE DECLARA COLOCAR SE APUNTA PARA COTEJARLO DESPUÉS.
        //
        // El registro de Polonia daba por colocado el Casco Viejo de Varsovia y
        // en el lienzo no estaba. Se perdía en alguno de los `continue` de aquí
        // abajo, en silencio. Ahora todo lo que la IA dice colocar entra en esta
        // lista y al final se compara con lo que de verdad hay.
        const refDeclarada = String(item?.ref ?? item?.id ?? item?.tipo ?? '?').trim();
        declarados.push({ ref: refDeclarada, dia: n });

        const pedida = CLAVES_FRANJA.includes(item?.franja) ? item.franja : null;
        const franja = franjaDeLaHora(item?.hora) ?? pedida;
        if (!franja) {
          perdidos.push({ ref: refDeclarada, dia: n, motivo: 'no dijo franja ni hora' });
          continue;
        }

        if (topeFranja >= 0 && CLAVES_FRANJA.indexOf(franja) > topeFranja) {
          di(`   Día ${n}: fuera «${refDeclarada}», caía después del viaje de vuelta.`);
          perdidos.push({ ref: refDeclarada, dia: n, motivo: 'caía después del viaje de vuelta' });
          continue;
        }

        // La comida no es un candidato: es un bloque de texto, como el que
        // pondría alguien a mano.
        if (item?.tipo === 'comida') {
          colocar(viajeId, {
            textoManual: 'Comer' + (item.zona ? ` · ${String(item.zona).slice(0, 60)}` : ''),
            dia: n,
            franja,
            hora: item.hora ?? null,
            duracionMin: duracionComida,
          });
          entradas += 1;
          resumen.push(`comida${item.zona ? ` (${item.zona})` : ''}`);
          continue;
        }

        const pieza = porRef.get(String(item?.ref ?? item?.id ?? '').trim());
        if (!pieza) {
          perdidos.push({
            ref: refDeclarada,
            dia: n,
            motivo: 'esa referencia no está en la lista de colocables',
          });
          continue;
        }

        // APUNTARLO ES PARTE DE COLOCARLO. Un sitio generado no es candidato
        // hasta que se decide meterlo en un día; en ese momento se apunta con la
        // misma función del botón y ya se puede colocar.
        const candidatoId =
          pieza.candidatoId ?? (pieza.sitioId ? apuntarYObtener(etapa.id, pieza.sitioId) : null);
        if (!candidatoId) {
          perdidos.push({
            ref: refDeclarada,
            dia: n,
            motivo: `no se pudo apuntar «${pieza.nombre}» para colocarlo`,
          });
          continue;
        }

        // EL TOPE SE MIRA ANTES DE COLOCAR, no después.
        //
        // El validador también lo avisa, pero avisar de algo que no debió
        // entrar es peor que no dejarlo entrar: la tarjeta ya está puesta, con
        // su hora, y quien la lea se la cree. Aquí se rechaza y el motivo va al
        // cotejo de lo perdido, que es donde se explica lo que no cupo.
        const empieza = enMinutosDelDia(item.hora);
        if (empieza != null && empieza >= topeDelDia) {
          perdidos.push({
            ref: refDeclarada,
            dia: n,
            motivo:
              `lo puso a las ${item.hora} y a partir de las ${horaTope} ya no se empieza nada`,
          });
          continue;
        }

        const fila = colocar(viajeId, { candidatoId, dia: n, franja, hora: item.hora ?? null });
        if (!fila) {
          perdidos.push({ ref: refDeclarada, dia: n, motivo: `el lienzo no aceptó «${pieza.nombre}»` });
          continue;
        }
        puestos += 1;
        entradas += 1;
        resumen.push(pieza.nombre);

        // La duración con la que ha entrado: si es una suposición nuestra, se
        // dice. Un día cuadra o no cuadra según estos minutos.
        const cuanto = duracionDeLoColocado(candidatoId);
        if (cuanto.supuesta) {
          di(`   ${pieza.nombre}: duración desconocida, asumo ${cuanto.minutos} min.`, ORIGENES.estimacion);
        }
      }

      const dia = dias.find((x) => x.n === n);
      di(
        `   Día ${n} (${ciudad}, ${dia?.diaSemana ?? ''}): ` +
          (resumen.length ? resumen.join(', ') : 'sin plan') +
          (d?.por_que ? ` — ${d.por_que}` : '')
      );
    }

    for (const f of plan.fuera ?? []) {
      const pieza = porRef.get(String(f?.ref ?? f?.id ?? '').trim());
      if (pieza) {
        sinColocarEnTotal += 1;
        di(`   Fuera: ${pieza.nombre}${f.por_que ? ` (${f.por_que})` : ''}`);
        if (pieza.clase === 'excursion' && pieza.candidatoId) {
          motivosDeFuera.set(pieza.candidatoId, f.por_que || 'no cupo en ningún día');
        }
      }
    }

    // Y ninguna tarjeta se queda sin hora: un «--:--» es invisible para el
    // validador, y lo invisible no se puede corregir después.
    ponerHorasQueFalten(viajeId, di);

    // EL COTEJO: lo declarado contra lo que hay.
    for (const x of perdidos) {
      di(`   Declaró colocar ${x.ref} en el día ${x.dia} y no se ha podido: ${x.motivo}.`);
      const pieza = porRef.get(x.ref);
      if (pieza?.clase === 'excursion' && pieza.candidatoId) {
        motivosDeFuera.set(pieza.candidatoId, `se intentó en el día ${x.dia}, pero ${x.motivo}`);
      }
    }
    if (declarados.length && entradas + perdidos.length !== declarados.length) {
      di(
        `   OJO: declaró ${declarados.length} colocación(es), han entrado ${entradas} y ` +
          `${perdidos.length} se han explicado. La diferencia se ha perdido sin motivo.`
      );
    }

    colocadosEnTotal += puestos;
    di(
      `${ciudad} lista: ${dias.length} día(s) montados, ${puestos} cosa(s) colocadas` +
        (plan.fuera?.length ? `, ${plan.fuera.length} sin colocar.` : '.')
    );
  }

  // --- LOS AVISOS TIENEN QUE QUEDAR EN VERDE ------------------------------
  //
  // No se silencian: se cuentan. Si esta fase ha dejado algo antes de llegar o
  // un sitio en su día de cierre, el aviso tiene razón y el fallo es del
  // reparto. Queda escrito para poder mirarlo.
  // --- LA REVISIÓN, CON LOS AVISOS DE VERDAD -------------------------------
  //
  // Antes esto miraba los avisos una vez y, si los había, los contaba. Y si no
  // los había escribía «todo cuadra», que era falso las más de las veces: el
  // aviso de cierre necesita los horarios traducidos y no lo estaban, y el de
  // solape necesita duraciones y no las había. Ahora se completa el tablero, se
  // pregunta, se corrige y se vuelve a preguntar.
  const maxPasadas = Math.max(1, parametro('max_revisiones_lienzo', 2));
  const sacados = [];

  await asegurarCierres(viajeId, di);

  let final = lienzoDeViaje(viajeId);
  for (let pasada = 1; pasada <= maxPasadas && final.avisos.length; pasada += 1) {
    di(`Revisión ${pasada} de ${maxPasadas}: el lienzo deja ${final.avisos.length} aviso(s).`);
    for (const a of final.avisos) di(`   · Día ${a.dia}: ${a.texto}`);

    const tocados = corregirAvisos(viajeId, final, di, sacados, duracionComida, horaTope);
    if (!tocados) {
      di('   Ninguno de esos avisos tiene un arreglo que yo sepa hacer.');
      break;
    }
    final = lienzoDeViaje(viajeId);
  }

  sinColocarEnTotal += sacados.length;

  // ¿SE DUERME EN ALGÚN SITIO SIN VER EL MOTIVO?
  //
  // Va aquí, al final, y no en la fase 1: allí la promesa de «cabe» era una
  // suposición porque los traslados aún no existían. Ahora sí: los horarios
  // reales están elegidos y las fichas tienen sus tiempos de visita.
  // LO ESENCIAL DE LA CIUDAD VA ANTES QUE LA EXCURSIÓN OPCIONAL.
  //
  // Se hace aquí, con el lienzo ya montado, y no antes: hasta ahora no se sabía
  // qué había quedado dentro y qué fuera.
  final = liberarLoQueSeComeLaExcursion(viajeId, viaje, final, di);

  contarLoDeLaAclimatacion(viajeId, final, di);

  di('Comprobando si las paradas cortas dan para lo que se va a ver…');
  const noCaben = avisarDeParadasQueNoCaben(viaje, di);
  // Y la otra cara: paradas de peso que SÍ están en la ruta pero cuyos
  // imprescindibles no han acabado en ningún día.
  avisarDeParadasSinSusImprescindibles(viaje, di);
  if (noCaben) {
    apuntarHueco(
      viajeId,
      FASE,
      `${noCaben} parada(s) donde se duerme sin que quepa su motivo principal; míralo en los avisos.`
    );
  }

  // UNA EXCURSIÓN QUE NO CABE NO PUEDE DESAPARECER EN SILENCIO.
  //
  // La fase 5 la eligió con criterio, la guardó como candidata y la pestaña la
  // enseña marcada. Si al repartir los días no entra en ninguno, quien mire el
  // viaje verá una excursión apuntada que no está en el lienzo y no sabrá si es
  // que no cupo o que se perdió por el camino. Va a los avisos del viaje.
  avisarDeExcursionesSinColocar(viaje, motivosDeFuera, di);

  if (final.avisos.length) {
    di(
      `Queda${final.avisos.length === 1 ? '' : 'n'} ${final.avisos.length} aviso(s) ` +
        'que no he sabido resolver:'
    );
    for (const a of final.avisos) di(`   · Día ${a.dia}: ${a.texto} — no he sabido resolverlo.`);
    apuntarHueco(
      viajeId,
      FASE,
      `El lienzo queda con ${final.avisos.length} aviso(s) sin resolver; revísalos en la pantalla.`
    );
  } else {
    di('Revisado con los avisos de la propia pantalla: el lienzo queda limpio.');
  }

  di(`${colocadosEnTotal} cosa(s) colocadas en total, ${sinColocarEnTotal} sin colocar a propósito.`);
  return { etapas: etapas.length, colocados: colocadosEnTotal, sinColocar: sinColocarEnTotal };
}


/**
 * AVISA DE LAS EXCURSIONES PRESELECCIONADAS QUE NO ENTRARON EN NINGÚN DÍA.
 *
 * La fase 5 las eligió con criterio y las guardó como candidatas; la pestaña de
 * la ciudad las enseña marcadas. Si el reparto de los días no las coloca, en la
 * pantalla queda una excursión apuntada que no está en ningún día, y desde
 * fuera no se distingue «no cabía» de «se perdió». Esto lo dice.
 *
 * Se rehace entero en cada pasada, y en su propia categoría, para que relanzar
 * la fase no acumule avisos viejos ni pise los de las otras.
 */
export function avisarDeExcursionesSinColocar(viaje, motivos, di) {
  ejecutar("DELETE FROM avisos WHERE viaje_id = ? AND categoria = 'excursion'", viaje.id);

  const sueltas = todas(
    `SELECT c.id, c.titulo, e.nombre_ciudad
       FROM candidatos c
       LEFT JOIN etapas e ON e.id = c.etapa_id
      WHERE c.viaje_id = ? AND c.tipo = 'actividad' AND c.marcado = 1
        AND NOT EXISTS (SELECT 1 FROM itinerario i WHERE i.candidato_id = c.id)
      ORDER BY c.id`,
    viaje.id
  );

  for (const x of sueltas) {
    const motivo = motivos.get(x.id) ?? 'no cupo en ningún día de esa parada';
    ejecutar(
      `INSERT INTO avisos (viaje_id, categoria, severidad, titulo, texto)
       VALUES (?, 'excursion', 'info', ?, ?)`,
      viaje.id,
      `«${x.titulo}» se quedó sin sitio en el lienzo`,
      `Está elegida y apuntada en ${x.nombre_ciudad ?? 'su parada'}, pero ${motivo}. ` +
        'Sigue en la pestaña de excursiones: puedes colocarla a mano o dejarla fuera.'
    );
    di(`   Aviso para el viaje: «${x.titulo}» quedó apuntada pero sin sitio (${motivo}).`);
  }

  if (sueltas.length) {
    di(`${sueltas.length} excursión(es) apuntada(s) se han quedado fuera del lienzo.`);
  }

  return sueltas.length;
}

export default {
  ejecutarFaseLienzo,
  diasDeLaEtapa,
  colocablesDeEtapa,
  avisarDeExcursionesSinColocar,
};
