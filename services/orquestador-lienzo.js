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
import { todas, una, ejecutar, normalizarNombre } from '../db/index.js';
import { direccionDe } from '../services/direcciones.js';
import {
  distanciaKm,
  minutosMinimosEnLlegar,
  minutosQueSePerdonan,
} from '../services/distancias.js';
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
  minutosDeVisita,
  seLlegaAlHueco,
  puntoDeTarjeta,
  FRANJAS,
} from '../services/lienzo.js';
import { datosDeSitio, interpretarHorariosDelCatalogo } from '../services/datos-sitios.js';
import { paraguasDeZona } from '../services/contenidos.js';
import { ocupacionDe } from '../services/proveedores.js';
import { alternarApuntado } from '../services/etapa.js';
import {
  anotar,
  apuntarHueco,
  parametro,
  parametroTexto,
  configAutoDelMotor,
  ORIGENES,
} from '../services/orquestador.js';
import { enMinutosDelDia } from '../services/orquestador-traslados.js';
import { hayQueParar } from '../services/orquestador-parada.js';
import { sinCubrir } from './cubiertos.js';
import {
  horasDeSesion,
  soloAUltimaHora,
  abreEl,
  abiertoA,
  horarioPorDias,
  horaDeInicioDeExcursion,
  hayRecogidaEnHotel,
} from '../services/horarios.js';
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

/**
 * `cierra_dias` viaja como JSON de números. VACÍO ES «NO CIERRA»; NULL ES «NO LO
 * SÉ», Y NO SON LO MISMO.
 *
 * El comentario de esta función decía exactamente eso y la primera línea las
 * machacaba: `if (!valor) return []` convertía el «no lo sé» en «abre los siete
 * días» y se lo pasaba al prompt como un hecho. Así se repartió el viaje a
 * Túnez —once sitios con día de cierre, ni una línea de aviso en el prompt— y
 * así el Museo del Bardo estuvo a un pelo de caer en lunes.
 *
 * Ahora la duda se devuelve como duda y quien la reciba decide qué hacer con
 * ella. Que es lo que decía el comentario desde el principio.
 */
function diasDeCierre(valor) {
  if (valor === null || valor === undefined || valor === '') return null;
  try {
    const lista = JSON.parse(valor);
    return Array.isArray(lista) ? lista.filter((d) => Number.isInteger(d)) : null;
  } catch {
    return null;
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
/**
 * La ficha de catálogo de una excursión candidata, o null.
 *
 * `naturalezaDe` hace este mismo salto un poco más abajo, pero con el colocado
 * ya puesto; aquí hace falta ANTES, cuando todavía se está decidiendo. Es la
 * misma consulta, en el otro extremo del proceso.
 */
function fichaDeLaExcursion(candidato) {
  let deId = null;
  try {
    deId = JSON.parse(candidato.datos_extra ?? '{}').deId ?? null;
  } catch {
    deId = null;
  }
  if (!deId) return null;
  return una(
    'SELECT horarios, descripcion_larga, incluye, punto_encuentro FROM catalogo_actividades WHERE id = ?',
    Number(deId)
  );
}

export function colocablesDeEtapa(etapa, lienzo, di = () => {}) {
  const yaColocados = new Set(lienzo.colocados.map((c) => c.candidatoId).filter(Boolean));

  // --- Las excursiones, que ya son candidatos y son anclas ----------------
  const excursiones = todas(
    `SELECT * FROM candidatos
      WHERE etapa_id = ? AND tipo = 'actividad' AND marcado = 1`,
    etapa.id
  )
    .filter((c) => !yaColocados.has(c.id))
    .map((c) => {
      // LA HORA QUE PUBLICA CIVITATIS, QUE ANTES SE TIRABA.
      //
      // Aquí ponía `horarios: null` a pelo. No es que la ficha no lo dijera: es
      // que no se miraba. El itinerario de la excursión a Dougga dice «Tras
      // recogeros en vuestro hotel de Túnez sobre las 8:00 horas», y el modelo,
      // que recibía solo el nombre y «8 horas», la colocó a las 07:30.
      //
      // La fase 5 ya deja la ficha profunda descargada para las que entran, así
      // que aquí el dato está.
      const ficha = fichaDeLaExcursion(c);
      const horaOficial = horaDeInicioDeExcursion(ficha?.horarios, ficha?.descripcion_larga);

      return {
        clase: 'excursion',
        candidatoId: c.id,
        sitioId: null,
        tipo: 'actividad',
        nombre: c.titulo,
        categoria: null,
        duracion: c.duracion ?? null,
        // `horaOficial` es la afirmación; `horarios` la deja además con la forma
        // que el resto del prompt ya entiende, para no estrenar un campo que
        // solo lea una cosa.
        horaOficial,
        horarios: horaOficial,
        recogidaHotel: hayRecogidaEnHotel(ficha?.incluye, ficha?.descripcion_larga),
        puntoEncuentro: ficha?.punto_encuentro ?? null,
        cierraDias: [],
        cierraTexto: null,
        // Una excursión no es un sitio con puerta: se contrata para un día y el
        // proveedor ya dice si ese día sale. Aquí no hay duda que confesar.
        cierraSinSaber: false,
      };
    });

  // --- Y los sitios generados, en el orden de sus bloques -----------------
  const sitios = etapa.punto_interes_id
    ? todas(
        `SELECT s.* FROM sitios_lugar s
          WHERE s.punto_interes_id = ?
            AND s.bloque IN ('imprescindibles', 'otros', 'ninos')
            AND ${sinCubrir(etapa.id)}
          ORDER BY CASE bloque
                     WHEN 'imprescindibles' THEN 1
                     WHEN 'ninos' THEN 2
                     ELSE 3
                   END, orden, id`,
        etapa.punto_interes_id
      )
    : [];

  // LA ZONA QUE CONTIENE AL PLAN NO SE OFRECE COMO BLOQUE DEL PLAN.
  //
  // «Ciudad Medieval de Rodas · 1 día completo», con el Palacio del Gran
  // Maestre, el Museo Arqueologico y otros nueve DENTRO de ella. Ofrecerla es
  // ofrecer ocho horas que tapan el dia entero donde estan los once.
  const paraguas = paraguasDeZona(sitios);
  for (const p of paraguas) {
    di(
      `   «${p.nombre}» dura ${p.tiempo_visita} y el plan de ${etapa.nombre_ciudad} ya pasa por ` +
        'dentro: es la zona, no una visita aparte. No la ofrezco como bloque.'
    );
  }
  const sinLosParaguas = new Set(paraguas.map((p) => p.id));

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

  // LO YA VISTO EN ESTA CIUDAD, EN CUALQUIER PARADA DEL VIAJE.
  //
  // `apuntados` solo mira los candidatos de ESTA etapa. Cuando una ciudad sale
  // dos veces —la vuelta a Tokio para coger el avión, después de seis noches
  // allí—, las dos paradas comparten catálogo y la segunda no sabía lo que ya
  // había puesto la primera: el Senso-ji salió el día 1 y el día 17. Se mira el
  // viaje entero: lo colocado en cualquier parada no se vuelve a ofrecer.
  const vistosEnElViaje = new Set(
    todas("SELECT id, datos_extra FROM candidatos WHERE viaje_id = ? AND tipo = 'sitio'", etapa.viaje_id)
      .filter((c) => yaColocados.has(c.id))
      .map((c) => {
        try {
          return JSON.parse(c.datos_extra ?? '{}').deId ?? null;
        } catch {
          return null;
        }
      })
      .filter(Boolean)
  );

  const delCatalogo = sitios
    .filter((s) => !sinLosParaguas.has(s.id))
    .filter((s) => !vistosEnElViaje.has(s.id))
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
        cierraDias: cierres ?? [],
        cierraTexto: cierres?.length ? cierres.map((d) => DIAS_SEMANA[d]).join(' y ') : null,
        // La duda se dice. Tras la pasada de la fase «Qué ver» esto son uno o dos
        // sitios por viaje —los horarios que ni el lector ni la IA descifran—, y
        // callarlos los convertiría otra vez en «abre todos los días».
        cierraSinSaber: cierres === null,
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
  // `alternarApuntado` ALTERNA, Y ESO AQUÍ ES UNA TRAMPA.
  //
  // Si el sitio ya estaba apuntado, esta llamada lo DESAPUNTA, se lleva por
  // delante su candidato y con él el sitio que ya tenía en el lienzo. Y basta
  // con que el modelo nombre el mismo sitio dos veces para que pase.
  //
  // Pasó en el viaje a Túnez: declaró «Avenida Habib Burguiba» en el día 5 y
  // otra vez en el día 6. La primera lo apuntó y lo colocó; la segunda lo
  // desapuntó, y un imprescindible de la ciudad se evaporó del viaje. El
  // registro lo dejó escrito sin saber por qué: «tenía hueco libre (día 5,
  // tarde, 19:00) y aun así no se colocó».
  //
  // La fase de excursiones ya se protege de esto mismo, con este mismo
  // comentario. Aquí faltaba: se mira antes si ya está, y si está se devuelve el
  // que hay en vez de tocar el interruptor.
  const yaEsta = candidatoDelSitio(etapaId, sitioId);
  if (yaEsta) return yaEsta;

  const r = alternarApuntado(etapaId, 'sitio', sitioId);
  if (!r?.apuntado) return null;

  return candidatoDelSitio(etapaId, sitioId);
}

/** El candidato de ese sitio en esa etapa, si ya lo hay. */
function candidatoDelSitio(etapaId, sitioId) {
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
 * LA RED, NO LA RED PRINCIPAL.
 *
 * Los días de cierre los traduce la fase «Qué ver», con el catálogo entero
 * delante y antes de que nadie reparta nada. Esto de aquí ya no es quien lo
 * hace: es quien comprueba que se hizo.
 *
 * Antes era al revés y por eso este comentario decía que el campo «se calcula en
 * un trabajo aparte y en diferido»: se traducía aquí, al terminar la fase, solo
 * lo que se había colocado. Servía para que el validador tuviera algo que decir,
 * y llegaba tarde para lo único que importaba —repartir sabiendo qué cierra—.
 *
 * Se queda porque un viaje montado antes de este cambio, o una parada que se
 * añada a mano después, no han pasado por aquella pasada. Cuando todo ha ido
 * bien no encuentra nada que hacer y no dice nada.
 */
async function asegurarCierres(viajeId, di) {
  const puntos = todas(
    `SELECT DISTINCT punto_interes_id AS id FROM etapas
      WHERE viaje_id = ? AND punto_interes_id IS NOT NULL`,
    viajeId
  );

  let hechos = 0;
  for (const p of puntos) {
    try {
      const r = await interpretarHorariosDelCatalogo(p.id, di);
      hechos += r.leidos + r.preguntados;
    } catch (err) {
      di(`   No pude traducir los horarios pendientes (${err.message}).`);
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

  // UN SALTO ES UN EXTREMO, NO LOS DOS.
  //
  // EL FALLO QUE ORIGINA ESTO. Grecia, día 4: salto de Creta a Atenas con el
  // vuelo a las 23:05. El salto se metía a la vez en las dos cuentas —su
  // `horaFin` (23:59) como principio del día y su `hora` (19:50) como final— y
  // salía una jornada de MENOS 249 minutos. Cualquier cosa por debajo del mínimo
  // es «día de viaje», así que el día se declaraba muerto teniendo por delante
  // de las siete de la mañana a las ocho de la tarde en Creta.
  //
  // Un salto solo puede ser una de las dos cosas, y lo dice de quién es el día:
  //   · si el día es del DESTINO, el salto es la llegada y el día empieza al
  //     bajarse del avión;
  //   · si es del ORIGEN, el salto es la marcha y el día acaba al salir hacia el
  //     aeropuerto.
  // Nunca las dos. `services/lienzo.js` decide de quién es el día con esta misma
  // cuenta, así que aquí basta con mirar el resultado.
  const esDelDestino = salto ? salto.etapaId === lienzo.dias?.find((d) => d.n === dia)?.etapaId : false;

  // Desde cuándo se puede empezar: al salir del aeropuerto o del traslado.
  const empieza = Math.max(
    enMinutosDelDia(llegada?.horaFin ?? llegada?.hora) ?? 0,
    (esDelDestino ? enMinutosDelDia(salto?.horaFin) : null) ?? 0,
    9 * 60
  );

  // Hasta cuándo: cuando arranca el bloque de la salida, si lo hay.
  const acaba = Math.min(
    enMinutosDelDia(salida?.hora) ?? 24 * 60,
    (esDelDestino ? null : enMinutosDelDia(salto?.hora)) ?? 24 * 60,
    22 * 60
  );

  return acaba - empieza < minimo;
}

/** ¿Es este bloque la comida del día? */
function esComida(colocado) {
  return /^comer\b/i.test(String(colocado?.nombre ?? ''));
}

/**
 * DOS COMIDAS EL MISMO DÍA SON UNA DE MÁS.
 *
 * EL FALLO QUE ORIGINA ESTO. El día 4 de Atenas quedó así:
 *
 *     14:00  Comer · Barrio de Plaka                 (la comida de zona)
 *     14:00  Taverna tradicional en Anafiotika       (un restaurante concreto)
 *
 * Los dos a la misma hora, peleándose por la misma franja. La resolución de
 * solapes no supo qué hacer —son dos bloques legítimos— y el día se quedó con un
 * aviso sin resolver y la Taverna a una hora que parecía imposible.
 *
 * SON DOS FORMAS DE RESOLVER LA MISMA COMIDA, no dos planes. Si el día tiene un
 * restaurante concreto a la hora de comer, ESE es el almuerzo: el bloque de «come
 * por la zona» sobra, y encima es el flexible de los dos. Se quita el de zona y
 * el día conserva una comida, que es lo que tiene un día.
 *
 * CÓMO SE SABE QUE UN SITIO ES UN RESTAURANTE, sin adivinar por el nombre: la
 * ficha lo dice. `sitios_lugar.categoria` vale «gastronomía» para la Taverna y
 * «monumentos», «museos» o «barrios y paseos» para lo demás. Es el dato que ya
 * pone la fase de qué ver.
 *
 * Y SI EL RESTAURANTE NO CABE EN SU HORARIO, EL QUE SE VA ES ÉL. La comida de
 * zona es flexible y un restaurante cerrado no da de comer: se quita el
 * restaurante con su motivo y se deja la zona. Nunca al revés, y nunca dejando
 * una visita puesta a una hora en que el sitio está cerrado.
 */
export function unaSolaComidaAlDia(viajeId, lienzo, di) {
  // LAS DOS HORAS A LAS QUE SE COME, NO SOLO UNA.
  //
  // EL FALLO QUE ORIGINA ESTO. La regla se escribió mirando el almuerzo y se
  // quedó ahí: la ventana era [12:00, 17:00] y un restaurante puesto de cena se
  // le escapaba entero. La «Taverna Savopoulos» está colocada a las 20:00 y
  // convivía tan tranquila con el bloque de comida del día — dos veces de comer
  // el mismo día, que es justo lo que esta función existe para impedir.
  //
  // Dos ventanas y no una sola grande: entre las cinco y las ocho de la tarde no
  // se come, y estirar la franja de 12:00 a 23:30 haría que un bar de tapas de
  // las 18:00 pasara por «la comida del día» y se llevara por delante el bloque
  // de mediodía.
  const HORAS_DE_COMER = [
    [12 * 60, 17 * 60],        // almuerzo
    [19 * 60 + 30, 23 * 60],   // cena
  ];
  let tocado = false;

  /** ¿Es este bloque un restaurante del catálogo? Lo dice su ficha, no su nombre. */
  const esRestaurante = (c) => {
    const quien = deQuienEs(c);
    if (quien?.de !== 'sitio' || !quien.deId) return false;
    const f = una('SELECT categoria FROM sitios_lugar WHERE id = ?', quien.deId);
    return /gastronom/i.test(String(f?.categoria ?? ''));
  };

  for (const d of lienzo.dias ?? []) {
    const delDia = lienzo.colocados.filter((c) => c.dia === d.n);

    // SE EMPAREJA DENTRO DE CADA FRANJA, y esto es la mitad del arreglo.
    //
    // Un bloque de zona a mediodía y un restaurante de cena NO son un duplicado:
    // son la comida y la cena. Mirar el día entero de una vez y quedarse con uno
    // borraría el almuerzo porque hay reservada una taverna para la noche, que
    // es peor que el fallo que se está arreglando. Lo que no puede haber es dos
    // veces de comer A LA MISMA HORA.
    for (const [desde, hasta] of HORAS_DE_COMER) {
      const enLaFranja = (c) => {
        const h = enMinutos(c.hora);
        return h != null && h >= desde && h <= hasta;
      };

      const zona = delDia.find((c) => esComida(c) && enLaFranja(c));
      if (!zona) continue;

      const restaurantes = delDia.filter(
        (c) => !esComida(c) && enLaFranja(c) && esRestaurante(c)
      );
      if (!restaurantes.length) continue;

      // ¿CABE ALGUNO EN SU HORARIO? Si sí, ese es la comida y la zona sobra.
      //
      // SE PREGUNTA TRAMO A TRAMO, no con la hora de cierre. Un restaurante tiene
      // DOS servicios —«Almuerzo y cena» son 13:00-16:00 y 20:00-23:30— y
      // `cierreDe` devuelve el más temprano de los dos, las 16:00, que es la
      // respuesta prudente a otra pregunta. Usarla aquí echaba a la taverna con
      // el motivo «a las 20:00 está cerrado» justo cuando está sirviendo cenas.
      // `abiertoA` mira los tramos uno a uno y contesta lo que se pregunta.
      const diaSemana = d.fecha ? new Date(`${d.fecha}T12:00:00`).getDay() : null;
      const cabe = restaurantes.find((c) => {
        const empieza = enMinutos(c.hora);
        if (empieza == null) return false;

        const quien = deQuienEs(c);
        const horarios = quien?.deId
          ? una('SELECT horarios FROM sitios_lugar WHERE id = ?', quien.deId)?.horarios
          : null;

        if (horarios && diaSemana != null) {
          const dura = Number(c.duracionMin) || 0;
          // Abierto al sentarse Y al levantarse. `null` es «no lo sé», y una
          // duda no echa a nadie: cuenta como que cabe.
          const alEmpezar = abiertoA(horarios, diaSemana, empieza);
          const alAcabar = abiertoA(horarios, diaSemana, empieza + Math.max(0, dura - 1));
          return alEmpezar !== false && alAcabar !== false;
        }

        // Sin horario legible se vuelve a lo grueso, que es lo que había.
        const abre = aperturaDe(c, d.fecha);
        const cierra = cierreDe(c);
        const dura = Number(c.duracionMin) || 0;
        if (abre != null && empieza < abre) return false;
        if (cierra != null && empieza + dura > cierra) return false;
        return true;
      });

      if (cabe) {
        quitar(zona.id);
        di(
          `   Día ${d.n}: «${cabe.nombre}» es la comida de ese día, así que quito ` +
            `«${zona.nombre}»: no hacen falta las dos.`
        );
        tocado = true;
        continue;
      }

      // Ninguno cabe: se van ellos y se queda la zona, que siempre cabe.
      for (const c of restaurantes) {
        quitar(c.id);
        di(
          `   Día ${d.n}: fuera «${c.nombre}» — a las ${c.hora} está cerrado y no da de ` +
            `comer. Se queda «${zona.nombre}», que es flexible.`
        );
        apuntarHueco(
          viajeId,
          FASE,
          `${d.ciudad}: «${c.nombre}» no abre a la hora de comer del día ${d.n}; ` +
            'la comida se queda en la zona.'
        );
        tocado = true;
      }
    }
  }

  return tocado ? lienzoDeViaje(viajeId) : lienzo;
}

/**
 * A QUÉ HORA ABRE ESTE SITIO ESE DÍA, en minutos. Null si no se sabe.
 *
 * EL FALLO QUE ORIGINA ESTO. La Barbacana de Cracovia acabó recolocada a las
 * 9:00 con un horario que dice 10:00-18:00. `horaLibreEn` acotaba por arriba
 * —`cierraA`, que nadie visita después de cerrar— pero por abajo solo tenía
 * `INICIO_DEL_DIA`, las 9:00 a secas. Un sitio que abre más tarde no existía
 * para el buscador de huecos.
 */
function aperturaDe(colocado, fecha) {
  const quien = deQuienEs(colocado);
  if (quien?.de !== 'sitio' || !quien.deId) return null;
  const sitio = una('SELECT horarios FROM sitios_lugar WHERE id = ?', quien.deId);
  if (!sitio?.horarios) return null;

  const dia = fecha ? new Date(`${fecha}T12:00:00`).getDay() : null;
  const mes = fecha ? Number(String(fecha).slice(5, 7)) : null;
  if (dia == null) return null;

  const rangos = horarioPorDias(sitio.horarios, mes).porDia[dia]?.rangos ?? [];
  return rangos.length ? Math.min(...rangos.map(([desde]) => desde)) : null;
}

/** «540» → «09:00», para poder pasárselo a `horaLibreEn` como suelo. */
function comoHoraDeMinutos(m) {
  if (m == null) return null;
  return `${String(Math.floor(m / 60)).padStart(2, '0')}:${String(m % 60).padStart(2, '0')}`;
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
/**
 * DÓNDE SE DUERME EN ESTA PARADA, para el prompt del lienzo.
 *
 * EL PROMPT TRAÍA LA SECCIÓN ENTERA Y EL DATO NO LLEGABA:
 *
 *     DONDE SE DUERME EN ESTA PARADA
 *     {{HOTEL}}
 *
 * …y el objeto de datos no tenía esa clave, así que `rellenar()` la dejaba VACÍA
 * sin decir nada. Al modelo le llegaba el título y debajo un hueco, y repartía
 * los días sin saber dónde duermes. Lo encontró la comprobación de cobertura.
 *
 * QUÉ SE LE CUENTA: el nombre y la ZONA, que es lo que sirve para repartir un
 * día. La dirección exacta no añade nada —el modelo no calcula rutas, para eso
 * está `seLlegaAlHueco`— y la zona sí: saber que se duerme en Ano Poli cambia
 * por dónde conviene acabar la tarde.
 *
 * SIN HOTEL SE DICE QUE NO LO HAY, en vez de callarse. Un hueco mudo debajo de
 * un título es justo lo que había antes.
 *
 * ESTA FUNCIÓN SE PERDIÓ UNA VEZ, y por eso está escrito aquí: al añadirla, la
 * inserción no encontró su ancla y no se escribió. El fichero seguía compilando
 * —una función que no existe no es un error de sintaxis— y la «comprobé»
 * ejecutando una copia de su SQL a mano en vez de llamarla. El lienzo del
 * siguiente viaje reventó entero con «dondeSeDuerme is not defined» y colocó
 * CERO sitios en cuatro ciudades. Probar una réplica no es probar la función.
 */
function dondeSeDuerme(etapaId) {
  const hotel = una(
    "SELECT titulo, datos_extra FROM candidatos WHERE etapa_id = ? AND tipo = 'hotel' AND marcado = 1",
    etapaId
  );
  if (!hotel) return 'Todavía no hay hotel elegido para esta parada.';

  let extra = {};
  try {
    extra = hotel.datos_extra ? JSON.parse(hotel.datos_extra) : {};
  } catch {
    extra = {};
  }

  const zona = String(extra.zona ?? '').trim();
  return zona ? `${hotel.titulo} — ${zona}` : String(hotel.titulo);
}

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
    if (reservada) return { nivel: 5, orden: 0, rigido: true, que: 'una excursión ya reservada' };

    // SALVO QUE SEA LA PUERTA DE UN IMPRESCINDIBLE. En Japón el ferry a
    // Miyajima —que es la única forma de llegar a Itsukushima— se expulsó
    // frente a un sitio de segundo nivel, y con él se fue el imprescindible que
    // cubría. Una excursión que cubre sitios (`cubierto_por`) pesa lo que el
    // más importante de ellos.
    const cubierto = una(
      `SELECT s.bloque, s.orden FROM sitios_lugar s
         JOIN etapas e ON e.id = ? AND e.punto_interes_id = s.punto_interes_id
        WHERE s.cubierto_por_excursion = ? AND s.bloque = 'imprescindibles'
        ORDER BY s.orden LIMIT 1`,
      quien.candidato.etapa_id,
      quien.candidato.id
    );
    if (cubierto) {
      const puesto = Number(cubierto.orden) || 99;
      const intocable = puesto <= parametro('puestos_intocables_del_sitio', 3);
      return {
        nivel: intocable ? 5 : 4,
        orden: puesto,
        rigido: true,
        que: `una excursión que cubre el imprescindible #${puesto}`,
      };
    }
    return { nivel: 2, orden: 50, rigido: true, que: 'una excursión opcional' };
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

  let deDia = false;
  if (quien?.de === 'sitio' && quien.deId) {
    const sitio = una('SELECT descripcion, horarios, categoria, nombre FROM sitios_lugar WHERE id = ?', quien.deId);
    horarios = sitio?.horarios ?? null;
    descripcion = sitio?.descripcion ?? null;
    deDia = esDeLuzDelDia(sitio);
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
    deDia,
  };
}

/**
 * LO QUE SOLO SE VE CON LUZ.
 *
 * Un parque, una playa o una isla suelen tener «abierto 24 horas», y con eso el
 * relleno los metía en cualquier hueco hasta las 22:00: el Parque Topčider a
 * las 20:00 y la Playa de Banje a las 20:00 de un abril en Dubrovnik (viaje
 * 128). El horario no lo impide; la noche, sí. Los miradores no entran aquí: el
 * atardecer es justo su hora.
 */
const NOMBRE_DE_LUZ = /^(playa|parque|jardin|monte|montana|isla|lago|bosque|cascadas?|reserva|sendero|valle|garganta|cueva)\b/;
function esDeLuzDelDia(sitio) {
  if (!sitio) return false;
  if (sitio.categoria === 'naturaleza') return true;
  const nombre = String(sitio.nombre ?? '')
    .toLowerCase()
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '');
  return NOMBRE_DE_LUZ.test(nombre);
}

/** A partir de qué hora ya no empieza una visita de luz del día. */
const ULTIMA_HORA_CON_LUZ = '19:00';

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
  if (naturaleza.deDia && hora >= ULTIMA_HORA_CON_LUZ) return false;
  return true;
}


/**
 * LOS DÍAS EN QUE UN SITIO CIERRA, leídos de su horario publicado.
 *
 * LA MISMA LECTURA QUE HACE EL AVISO, hasta el último argumento. Si el aviso
 * dice una cosa y la recolocación otra, el sitio rebota entre días o sale del
 * plan por un cierre que solo existe en una de las dos lecturas.
 *
 * Un día que el horario no aclara NO cuenta como cierre: solo cuenta lo que el
 * texto dice, y la duda se queda en el aviso flojito.
 */
function cierraEseDia(colocado, fecha) {
  const quien = deQuienEs(colocado);
  if (quien?.de !== 'sitio' || !quien.deId || !fecha) return false;
  const ficha = una('SELECT horarios FROM sitios_lugar WHERE id = ?', quien.deId);
  if (!ficha?.horarios) return false;

  // EL MES VA DENTRO, Y AQUI ESTABA LA MITAD DEL FALLO.
  //
  // Esto era `diasDeCierreDe`, una lista de los siete dias leida SIN el mes:
  //
  //     [0..6].filter((d) => abreEl(ficha.horarios, d) === false)
  //
  // El aviso si pasa el mes —lo necesita para saber si rige el horario de verano
  // o el de invierno— asi que los dos leian el mismo texto con reglas distintas.
  // En el viaje 105, con «Todo el año: 09:00 - 17:00 (Martes cerrado en
  // invierno)» y un martes de septiembre:
  //
  //     el AVISO (con mes)      -> cierra los martes
  //     el que MUEVE (sin mes)  -> el martes esta bien
  //
  // Resultado: «Rotonda de Galerio cerraba ese dia: lo paso al dia 2 a las
  // 11:30», al MISMO dia 2 que era el problema, y con exito declarado. El aviso
  // sobrevivio tres pasadas de revision sin converger. Es exactamente lo que
  // avisaba el comentario que habia aqui —«si el aviso dice una cosa y la
  // recolocacion otra, el sitio acaba rebotando entre dias»— cumpliendose por
  // una lista que se leia sin la mitad del dato.
  //
  // Se pregunta por el DIA CONCRETO en vez de precalcular los siete, porque los
  // dias que cierra un sitio pueden depender del mes: una lista de siete
  // casillas no puede representar eso, y por eso no lo representaba.
  const mes = Number(String(fecha).slice(5, 7)) || null;
  return abreEl(ficha.horarios, diaDeLaSemana(fecha), mes) === false;
}

/** El día de la semana de una fecha «2026-10-16». */
function diaDeLaSemana(fecha) {
  return fecha ? new Date(`${fecha}T12:00:00`).getDay() : null;
}

/**
 * UN HUECO VÁLIDO PARA ESTA COSA EN ESTE DÍA, o null.
 *
 * Junta en un solo sitio las cinco comprobaciones: el hueco libre, el cierre del
 * sitio, el tope del día, la naturaleza de lo que se coloca y —la última— que se
 * pueda LLEGAR a ese hueco desde lo que hay antes y salir hacia lo que hay
 * después.
 */
function huecoValido(tablero, { dia, colocado, naturaleza, cierre, duracion, noAntesDe = null }) {
  // NI ANTES DE QUE ABRA. El suelo del hueco es el más tardío de los dos: lo que
  // pida quien llama y la hora a la que el sitio abre ese día.
  const abre = comoHoraDeMinutos(aperturaDe(colocado, tablero.dias?.find((d) => d.n === dia)?.fecha));
  const suelo = [noAntesDe, abre].filter(Boolean).sort().pop() ?? null;
  noAntesDe = suelo;
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
      if (libre !== hora) continue;
      // Con pases no hay negociación: si a esa hora no se llega, ese pase no es.
      if (seLlegaAlHueco(tablero, { dia, hora, duracion, colocado })) continue;
      return hora;
    }
    return null;
  }

  for (const franja of franjasQueAdmite(naturaleza)) {
    // SE REINTENTA MÁS TARDE, NO SE ABANDONA LA FRANJA.
    //
    // `horaLibreEn` da UNA hora por franja: la primera libre. Si a esa no se
    // llega, rendirse ahí mandaría a otro día algo que cabía perfectamente dos
    // horas después. Se vuelve a preguntar poniendo como suelo la hora a la que
    // sí se llega, y el tope del día corta solo: cuando ya no queda día,
    // `horaLibreEn` contesta null.
    let suelo = noAntesDe;
    for (let intento = 0; intento < 4; intento++) {
      const hora = horaLibreEn(tablero, { dia, franja, duracion, noAntesDe: suelo, cierraA: cierre });
      if (!hora || !horaLegitima(naturaleza, hora)) break;
      const pega = seLlegaAlHueco(tablero, { dia, hora, duracion, colocado });
      if (!pega) return hora;
      if (!pega.desdeMinuto) break;
      suelo = comoHoraDeMinutos(pega.desdeMinuto);
      if (!suelo) break;
    }
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


  // EL TABLERO SIN ESTA TARJETA.
  //
  // Buscarle hueco contando el hueco que ella misma ocupa es buscar donde no
  // hay: `horaLibreEn` empujaba la candidata detrás de su propio bloque y
  // devolvía null. Ese null se leía como «no cabe en ningún sitio» y acababa en
  // una expulsión que no hacía falta.
  const tablero = sinEl(lienzo, colocado.id);

  const puedeEnEsteDia = (d) =>
    !esDiaDeViaje(lienzo, d.n) && !cierraEseDia(colocado, d.fecha);

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

  // EL TABLERO SE RELEE DESPUÉS DE CADA MOVIMIENTO.
  //
  // EL FALLO QUE ORIGINA ESTO, y viene del viaje 38. Este bucle recorría todo lo
  // colocado llamando a `recolocarConHora` SIEMPRE con el mismo `lienzo`: la foto
  // con la que arrancó la pasada. Así que la segunda tarjeta buscaba hueco sin
  // ver dónde acababa de aterrizar la primera, y salía esto:
  //
  //     Basílica de Santa María … lo paso al día 4 a las 11:45.
  //     Sinagoga del Templo    … lo paso al día 4 a las 11:45.
  //     Iglesia de Corpus Christi … lo paso al día 4 a las 11:45.
  //
  // Tres bloques al mismo minuto del mismo día, y la revisión siguiente teniendo
  // que deshacer tres solapes recién creados. `horaLibreEn` calcula bien los
  // huecos —no es él— : es que le dábamos un tablero caducado.
  //
  // `resolverChoque` ya resolvió esto mismo unas líneas más abajo y su comentario
  // lo explica. Aquí se aplica el mismo patrón entero, que son cuatro cosas y no
  // una: releer, rehacer la tarjeta por su id, usar la fresca en vez de la vieja,
  // y saltarse la que ya no esté porque se la llevó otro arreglo de esta pasada.
  let tablero = lienzo;

  // La LISTA de candidatos se fija al entrar —es a quién hay que mirar— pero el
  // estado de cada uno se relee. Iterar sobre `tablero.colocados` mientras cambia
  // sería recorrer una lista que se mueve bajo los pies.
  const candidatos = lienzo.colocados.map((x) => x.id);

  for (const id of candidatos) {
    if (idos.has(id)) continue;

    const c = tablero.colocados.find((x) => x.id === id);
    if (!c) continue;
    if (esComida(c)) continue;

    const naturaleza = naturalezaDe(c);
    if (!naturaleza.sesiones?.length && !naturaleza.soloDeNoche && !naturaleza.deDia) continue;
    if (horaLegitima(naturaleza, c.hora)) continue;

    const comoEs = naturaleza.sesiones?.length
      ? `solo tiene pases a las ${naturaleza.sesiones.join(' y ')}`
      : naturaleza.soloDeNoche
        ? 'es cosa de última hora'
        : 'solo se ve con luz del día';

    const r = recolocarConHora(viajeId, tablero, c);
    if (r.movido) {
      di(`   ${c.nombre} estaba a las ${c.hora} y ${comoEs}: lo paso al día ${r.dia} a las ${r.hora}.`);
      tablero = lienzoDeViaje(viajeId);
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
      // También con el tablero al día: `agotarLaParada` aparta cosas de otros
      // días para hacer sitio, y decidir cuáles con la foto vieja es el mismo
      // error un piso más abajo.
      const ultimo = agotarLaParada(viajeId, tablero, c, di);
      if (ultimo.movido) {
        di(
          `   ${c.nombre} no se pierde: lo llevo al día ${ultimo.dia} a las ${ultimo.hora}` +
            (ultimo.aparte ? ` (aparté ${ultimo.aparte}).` : '.')
        );
        tablero = lienzoDeViaje(viajeId);
        tocados += 1;
        continue;
      }
      sacar(
        c,
        `${comoEs} y no cabe en ninguna de sus horas en ningún día de la parada — ` +
          `${ultimo.porQueNo.join('; ') || 'sin días alternativos'}`
      );
      // Sacar algo deja un hueco: el siguiente candidato tiene derecho a verlo.
      tablero = lienzoDeViaje(viajeId);
      tocados += 1;
      continue;
    }

    sacar(c, `estaba a las ${c.hora} y ${comoEs}; no encontré ninguna de sus horas libre`);
    tablero = lienzoDeViaje(viajeId);
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
/**
 * ¿TIENE ESTA EXCURSIÓN UNA HORA PUBLICADA POR QUIEN LA VENDE?
 *
 * Sirve para decidir cuál se sacrifica primero cuando hay que echar alguna. Una
 * excursión con hora de salida en su ficha es un compromiso más concreto —hay un
 * autobús, una recogida, un punto de encuentro— que una que solo dice «día
 * completo». Si hay que perder una, que sea la vaga.
 */
function horaPublicadaDe(colocado) {
  const quien = deQuienEs(colocado);
  if (quien?.candidato?.tipo !== 'actividad') return null;
  const ficha = fichaDeLaExcursion(quien.candidato);
  return ficha ? horaDeInicioDeExcursion(ficha.horarios, ficha.descripcion_larga) : null;
}

export function liberarLoQueSeComeLaExcursion(viajeId, viaje, lienzo, di) {
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

    // DE UNA EN UNA, Y SE PARA CUANDO YA CABEN.
    //
    // EL FALLO QUE ORIGINA ESTO, y es Atenas en el viaje 104. Aquí había un
    // `for` sin condición de parada: se echaban TODAS las excursiones de jornada
    // de la parada a la vez. Hacía falta UN día para el Museo de la Acrópolis y
    // se tiraron dos cosas:
    //
    //     AVISO GRAVE · «Excursión a Delfos» … deja fuera 1 imprescindible(s)
    //     AVISO GRAVE · «Crucero por Agistri, Moni y Egina» … deja fuera 1 imprescindible(s)
    //     Día 5, 6 liberado: repesco Museo de la Acrópolis.
    //     Museo de la Acrópolis entra en el día 5 a las 09:00
    //
    // El Museo entró en el día 5. La segunda expulsión no rescató nada: un día
    // entero a las islas a cambio de cero. El criterio era bueno —en los otros
    // tres disparos de la base el imprescindible aterrizó exactamente en el día
    // liberado, o sea que la excursión era de verdad el tapón— pero la dosis no.
    //
    // EL ORDEN IMPORTA, así que primero la que menos se pierde: la que no tiene
    // hora publicada por quien la vende. Una excursión con hora es un compromiso
    // más real que una sin ella, y si hay que sacrificar una, que sea la vaga.
    const conHora = new Map(culpables.map((c) => [c.id, Boolean(horaPublicadaDe(c))]));
    const porSacrificar = [...culpables].sort(
      (a, b) => (conHora.get(a.id) ? 1 : 0) - (conHora.get(b.id) ? 1 : 0)
    );
    const echadas = new Set();

    const diasLibres = [];
    const repescados = [];
    let quedan = [...sinColocar];
    let tablero = lienzo;

    for (const c of porSacrificar) {
      if (!quedan.length) break; // Ya caben todos: las demás excursiones se quedan.

      di(
        `   AVISO GRAVE · ${etapa.nombre_ciudad}: «${c.nombre}» ocupa un día entero y deja fuera ` +
          `${quedan.length} imprescindible(s) de la ciudad (${quedan.map((x) => x.nombre).join(', ')}).`,
        ORIGENES.ninguno
      );
      sacarDelPlan(c, di, `no cabe sin sacrificar lo esencial de ${etapa.nombre_ciudad}`);
      apuntarHueco(
        viajeId,
        FASE,
        `${etapa.nombre_ciudad}: «${c.nombre}» a la mochila — no cabía sin dejar fuera lo esencial.`
      );
      tocado = true;
      echadas.add(c.id);
      diasLibres.push(c.dia);

      di(
        `   Día ${c.dia} liberado: repesco ${quedan.map((x) => x.nombre).join(', ')}.`,
        ORIGENES.ninguno
      );

      // EL TABLERO SE RELEE ENTRE UNA Y OTRA.
      //
      // Con la foto de antes, los tres vieron el mismo hueco de las 09:00 y los
      // tres se colocaron ahí, encimados. Un hueco deja de estarlo en cuanto lo
      // ocupa el primero.
      tablero = lienzoDeViaje(viajeId);
      const siguen = [];
      for (const x of quedan) {
        if (colocarImprescindible(viajeId, tablero, etapa, x, di, diasLibres)) {
          repescados.push(x.nombre);
          tocado = true;
          tablero = lienzoDeViaje(viajeId);
        } else {
          siguen.push(x);
        }
      }
      quedan = siguen;
    }

    const seQuedan = culpables.filter((c) => !echadas.has(c.id));
    if (seQuedan.length) {
      di(
        `   ${etapa.nombre_ciudad}: con eso ya caben, así que ${seQuedan
          .map((c) => `«${c.nombre}»`)
          .join(', ')} se queda${seQuedan.length > 1 ? 'n' : ''} en el plan.`,
        ORIGENES.ninguno
      );
    }

    di(
      repescados.length
        ? `   ${etapa.nombre_ciudad}: repescados ${repescados.join(', ')}.`
        : `   ${etapa.nombre_ciudad}: no cupo ninguno ni con el día libre.`,
      ORIGENES.ninguno
    );

    // La comida del día de la excursión echada se va con ella. En Sarajevo
    // (viaje 128) quedó «Comer · Travnik o Jajce (durante la excursión)» en un
    // día sin excursión: este camino no pasaba por la limpieza del otro.
    quitarLaComidaDeLaExcursion(viajeId, diasLibres, di);
    rellenarElDiaLiberado(viajeId, etapa, diasLibres, di);
  }

  return tocado ? lienzoDeViaje(viajeId) : lienzo;
}

/**
 * Coloca un imprescindible que se había quedado fuera, en el primer hueco válido
 * de su parada. Devuelve true si lo ha conseguido.
 */
/**
 * EL DÍA LIBERADO NO SE QUEDA EN CRÁTER.
 *
 * EL FALLO QUE ORIGINA ESTO, y es el viaje 104, Grecia. El reparto montó Atenas
 * apoyándose en dos excursiones de jornada:
 *
 *     Día 5 (viernes): Excursión a Delfos                — día completo fuera
 *     Día 6 (sábado):  Crucero por Agistri, Moni y Egina — ocupan el día entero
 *
 * Un solo bloque cada día. Y dejó fuera DOCE sitios de Atenas justificándose con
 * ellas, con estas palabras: «los días 5 y 6 son excursiones completas», «el
 * sábado (día 6) es crucero», «el mercado especial del domingo coincide con el
 * crucero». Después la regla de arriba —vieja, correcta y que ya había disparado
 * en tres viajes— echó las dos excursiones por dejar fuera un imprescindible.
 *
 * Resultado: el día 5 con una sola visita y el **día 6 entero vacío**, con doce
 * sitios sin colocar cuya única razón de estar fuera acababa de desaparecer.
 *
 * La repesca de arriba solo mira los IMPRESCINDIBLES. Es lo correcto para lo que
 * fue escrita —rescatar el motivo de la parada— pero se queda a medias: cuando
 * los imprescindibles se acaban, o solo había uno, el cráter sigue ahí. Quitar
 * la excursión invalida las doce excusas, no una.
 *
 * SOLO RELLENA LOS DÍAS LIBERADOS, y por eso `soloEsosDias`. Derramarse a los
 * demás no taparía el agujero y sí apretaría días que estaban bien.
 *
 * Y NO TOCA LO QUE YA ESTÁ: solo añade en el hueco que quedó. Si no cabe nada
 * —porque los que faltan cierran ese día o no tienen hora— el día se queda vacío
 * y se dice, que es mejor que rellenarlo con cualquier cosa.
 */
export function rellenarElDiaLiberado(viajeId, etapa, diasLibres, di) {
  if (!etapa.punto_interes_id || !diasLibres.length) return;

  // TODO lo del catálogo de esa ciudad, no solo los imprescindibles. Los
  // fundidos dentro de otro (`cubierto_por`) quedan fuera: ya se visitan.
  const delCatalogo = todas(
    `SELECT s.id, s.nombre, s.tiempo_visita, s.bloque
       FROM sitios_lugar s
      WHERE s.punto_interes_id = ? AND ${sinCubrir(etapa.id, { soloColocadas: true })} AND s.bloque <> 'busqueda'
      ORDER BY CASE WHEN bloque = 'imprescindibles' THEN 0 ELSE 1 END, orden, id`,
    etapa.punto_interes_id
  );

  const puestos = new Set(
    todas(
      `SELECT c.datos_extra FROM itinerario i JOIN candidatos c ON c.id = i.candidato_id
        WHERE i.viaje_id = ? AND c.tipo = 'sitio'`,
      viajeId
    )
      .map((c) => {
        try {
          return JSON.parse(c.datos_extra ?? '{}')?.deId ?? null;
        } catch {
          return null;
        }
      })
      .filter(Boolean)
  );

  const pendientes = delCatalogo.filter((s) => !puestos.has(s.id));
  if (!pendientes.length) return;

  // LA COMIDA SE RESERVA ANTES DE RELLENAR, Y ESTO LO ENSEÑÓ LA PRUEBA.
  //
  // La primera versión llenaba el día de visitas y luego la pasada de repaso
  // decía «Día 6: no hay hueco a una hora de comer; lo dejo dicho»: el relleno
  // se había comido el mediodía. Un día de ocho horas de museos sin sitio para
  // comer no es un día mejor que el día vacío, es otro día mal.
  //
  // Así que primero se pone el plato y después se rellena alrededor, que es el
  // orden en que lo haría cualquiera.
  let tablero = lienzoDeViaje(viajeId);
  const duracionComida = parametro('duracion_comida_min', 90);

  for (const dia of diasLibres) {
    if (tablero.colocados.some((c) => c.dia === dia && esComida(c))) continue;
    const hora =
      horaLibreEn(tablero, { dia, franja: 'mediodia', duracion: duracionComida }) ??
      horaLibreEn(tablero, { dia, franja: 'tarde', duracion: duracionComida });
    if (!hora || Number(hora.split(':')[0]) >= 16) continue;

    colocar(viajeId, {
      textoManual: 'Comer',
      dia,
      franja: franjaDesde(hora) ?? 'mediodia',
      hora,
      duracionMin: duracionComida,
    });
    di(`   Día ${dia}: le reservo la comida a las ${hora} antes de rellenarlo.`, ORIGENES.ninguno);
    tablero = lienzoDeViaje(viajeId);
  }

  const entraron = [];

  for (const s of pendientes) {
    const sitio = {
      id: s.id,
      nombre: s.nombre,
      minutos: minutosDeVisita(s.tiempo_visita) ?? parametro('visita_por_defecto_min', 90),
    };
    const puesto = colocarImprescindible(viajeId, tablero, etapa, sitio, di, diasLibres, {
      soloEsosDias: true,
      comoSeDice: 'rellena el día %d a las %h, que se quedó libre al quitar la excursión',
    });
    if (!puesto) continue;
    entraron.push(s.nombre);
    // El tablero se relee: un hueco deja de serlo en cuanto lo ocupa el primero.
    tablero = lienzoDeViaje(viajeId);
  }

  di(
    entraron.length
      ? `   ${etapa.nombre_ciudad}: el día ${diasLibres.join(', ')} se rellena con ${entraron.join(', ')}.`
      : `   ${etapa.nombre_ciudad}: en el día ${diasLibres.join(', ')} no entra nada más del catálogo.`,
    ORIGENES.ninguno
  );
}

function colocarImprescindible(
  viajeId,
  lienzo,
  etapa,
  sitio,
  di,
  diasLibres = [],
  {
    soloEsosDias = false,
    comoSeDice = 'entra en el día %d a las %h, en el hueco que deja la excursión',
    cederSegundoNivel = false,
    siNoCabe = 'sigue sin hueco en %c ni quitando la excursión',
  } = {}
) {
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
  // Si el candidato se crea aquí y al final no entra, se deshace: un sitio
  // apuntado que no está en ningún día es una promesa que la pantalla enseña.
  const loApunteYo = !candidato;
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


  // EL DÍA QUE HA QUEDADO LIBRE VA PRIMERO: es el que la excursión ocupaba y el
  // que se ha vaciado para esto. Repescar y mandarlo a otro día sería dejar el
  // día vacío igual, que es justo lo que se quería evitar.
  const dias = lienzo.dias
    .filter((x) => x.etapaId === etapa.id)
    // EL RELLENO NO SE DERRAMA. Repescar un imprescindible sí puede acabar en
    // otro día —lo que importa es que entre—, pero rellenar el cráter que dejó
    // la excursión NO: si lo que se mete para tapar el día 6 aterriza en el 4, el
    // día 6 sigue vacío y encima el 4 queda más apretado.
    .filter((x) => !soloEsosDias || diasLibres.includes(x.n))
    .sort((a, b) => (diasLibres.includes(b.n) ? 1 : 0) - (diasLibres.includes(a.n) ? 1 : 0));

  for (const d of dias) {
    if (esDiaDeViaje(lienzo, d.n)) continue;
    if (cierraEseDia(falso, d.fecha)) continue;

    let hora = huecoValido(lienzo, {
      dia: d.n,
      colocado: falso,
      naturaleza,
      cierre,
      duracion: sitio.minutos,
    });

    // Y SI NO HAY HUECO, ¿LO HAY QUITANDO UNA VISITA DE SEGUNDO NIVEL?
    //
    // En Novi Sad, el domingo, el Museo de Vojvodina —imprescindible, abierto
    // hasta las 18:00— se quedó fuera y el «Paseo del Danubio», de segundo
    // nivel, ocupaba las 16:45. `apartarAlMasLigero` solo sabe mandar al otro a
    // OTRO día, y si no cabe en ninguno no cede nada. Aquí sí cede: se prueba
    // primero sin él, y solo si así el imprescindible entra, se va.
    if (!hora && cederSegundoNivel) {
      const cedibles = lienzo.colocados
        .filter((c) => c.dia === d.n && !esComida(c))
        .map((c) => ({ c, imp: importanciaDe(c) }))
        .filter((x) => x.imp.nivel <= 3 && /segundo nivel/.test(x.imp.que))
        .sort((x, y) => y.imp.orden - x.imp.orden);
      // Se van quitando de menos a más peso hasta que cabe —tres como mucho: un
      // imprescindible de tres horas necesita a veces dos visitas cortas—, y
      // después se devuelve cada una que no hacía falta quitar.
      const prueba = (ids) =>
        huecoValido(
          ids.reduce((t, id) => sinEl(t, id), lienzo),
          { dia: d.n, colocado: falso, naturaleza, cierre, duracion: sitio.minutos }
        );
      const quitadas = [];
      for (const { c } of cedibles) {
        quitadas.push(c);
        if (prueba(quitadas.map((q) => q.id))) break;
      }
      let cedidas = prueba(quitadas.map((q) => q.id)) ? [...quitadas] : [];
      // Se devuelven empezando por la de MÁS peso: si sobra quitar alguna, que
      // se quede la que más vale.
      for (const q of [...cedidas].reverse()) {
        const sinQ = cedidas.filter((x) => x !== q);
        if (prueba(sinQ.map((x) => x.id))) cedidas = sinQ;
      }
      if (cedidas.length > 3) cedidas = [];
      if (cedidas.length) {
        hora = prueba(cedidas.map((x) => x.id));
        for (const c of cedidas) {
          sacarDelPlan(c, di, `cede su hueco del día ${d.n} a ${sitio.nombre}, que es imprescindible`);
        }
      }
    }
    if (!hora) continue;

    colocar(viajeId, {
      candidatoId: candidato.id,
      dia: d.n,
      franja: franjaDesde(hora) ?? 'manana',
      hora,
      duracionMin: sitio.minutos,
    });
    di(`   ${sitio.nombre} ${comoSeDice.replace('%d', d.n).replace('%h', hora)}.`);
    return true;
  }

  if (loApunteYo) alternarApuntado(etapa.id, 'sitio', sitio.id);
  if (!soloEsosDias) {
    di(`   ${sitio.nombre} ${siNoCabe.replace('%c', etapa.nombre_ciudad)}.`);
  }
  return false;
}

/**
 * LA VISITA ENTERA TIENE QUE CABER, NO SOLO SU PRIMERA HORA.
 *
 * Se pasa por todo lo colocado y se comprueba que empieza cuando el sitio ya ha
 * abierto y termina antes de que cierre. Lo que no cabe se mueve a un hueco
 * válido —de su día si lo hay, de otro día de la parada si no— con la misma
 * lógica de siempre.
 *
 * Va ANTES de la revisión a propósito: la revisión resuelve conflictos entre
 * bloques, y un bloque que no cabe en su propio horario no es un conflicto con
 * nadie, es un error de colocación. Arreglarlo antes le quita a la revisión un
 * problema que no es suyo y que resolvía tirando la tarjeta.
 *
 * DEVUELVE LO QUE NO HA SABIDO ARREGLAR, y eso es la mitad del sentido de esta
 * función. En Polonia dejó tres —Kazimierz, la Fábrica de Schindler y el
 * restaurante de la última noche— cada uno con su «lo dejo para la revisión»…
 * y cuatro líneas después la fase anunciaba «el lienzo queda limpio». No lo
 * estaba. El «lo dejo para la revisión» era además una promesa imposible: esto
 * corre DESPUÉS de las dos revisiones, así que no había ninguna detrás que fuera
 * a recogerlos. Se quedaban en el registro y no llegaban ni a los avisos del
 * viaje ni al «lo que te dejo para repasar».
 */
function enderezarLoQueNoCabeEnSuHorario(viajeId, lienzo, di) {
  let tocado = false;
  let tablero = lienzo;
  const sinResolver = [];

  for (const c of lienzo.colocados) {
    if (esComida(c)) continue;

    const quien = deQuienEs(c);
    if (quien?.de !== 'sitio' || !quien.deId) continue;

    const dia = tablero.dias.find((d) => d.n === c.dia);
    const abre = aperturaDe(c, dia?.fecha);
    const cierra = cierreDe(c);
    const empieza = enMinutos(c.hora);
    const dura = Number(c.duracionMin) || 0;
    if (empieza == null || !dura) continue;

    const tarde = abre != null && empieza < abre;
    const pasada = cierra != null && empieza + dura > cierra;
    if (!tarde && !pasada) continue;

    const comoEs = tarde
      ? `abre a las ${comoHoraDeMinutos(abre)} y estaba puesto a las ${c.hora}`
      : `cierra a las ${comoHoraDeMinutos(cierra)} y ${dura} min desde las ${c.hora} no caben`;

    const r = recolocarConHora(viajeId, tablero, c);
    if (r.movido) {
      di(`   ${c.nombre}: ${comoEs}. Lo paso al día ${r.dia} a las ${r.hora}.`);
      tablero = lienzoDeViaje(viajeId);
      tocado = true;
    } else {
      // No se expulsa aquí: echarlo sería peor que dejarlo mal puesto, porque se
      // pierde el sitio sin que nadie lo haya decidido. Se queda donde está, con
      // su hora mala, y se DICE: sale en el registro, sale en los avisos del
      // viaje y sale en el repaso final.
      //
      // SALVO EL DE SEGUNDO NIVEL. La Iglesia de San Blas (viaje 128) se quedó a
      // las 17:00 cerrando a las 12:00: puesta ahí no se visita, solo ocupa media
      // hora y deja un aviso que nadie puede arreglar. Lo que de verdad se pierde
      // sin que nadie lo decida es un imprescindible, y ese sigue quedándose.
      if (/segundo nivel/.test(importanciaDe(c).que)) {
        sacarDelPlan(c, di, `${comoEs}, y no encontré otro hueco en su horario`);
        tablero = lienzoDeViaje(viajeId);
        tocado = true;
        continue;
      }
      di(`   ${c.nombre}: ${comoEs}, y no encontré hueco. Lo dejo puesto y te lo digo.`);
      sinResolver.push({ dia: c.dia, nombre: c.nombre, comoEs });
    }
  }

  return { lienzo: tocado ? lienzoDeViaje(viajeId) : lienzo, sinResolver };
}

/**
 * ¿ESA «ZONA» ES UN BARRIO CON NOMBRE O ES «EL CENTRO»?
 *
 * Las que Booking escribe como etiqueta genérica —centro, casco viejo, casco
 * antiguo, ciudad vieja y sus versiones en inglés— no identifican un sitio al
 * que el plan pueda ir o dejar de ir. Un barrio con nombre propio (Oia,
 * Kazimierz, Trastevere) sí.
 */
function esEtiquetaDeCentro(zona) {
  const z = normalizarNombre(zona);
  return [
    'centro', 'centro historico', 'centro ciudad', 'centro urbano', 'el centro',
    'casco viejo', 'casco antiguo', 'casco historico', 'ciudad vieja', 'ciudad antigua',
    'old town', 'city centre', 'city center', 'historic centre', 'historic center',
    'old city', 'downtown', 'altstadt', 'stare miasto', 'centre ville', 'centro storico',
  ].includes(z);
}

/**
 * ¿PISA EL PLAN LA ZONA DONDE SE DUERME?
 *
 * EL CASO. En Santorini el hotel estaba en Oia, el itinerario entero se montó en
 * Fira y «Oia» acabó expulsada del plan por falta de franja. El viajero eligió
 * Oia al reservar —se paga por eso— y el plan no la pisa ni una tarde.
 *
 * ESTO SOLO AVISA. No recoloca nada: decidir qué visita se mueve a la zona del
 * hotel es criterio, y el criterio va en el reparto. Aquí solo se comprueba lo
 * que se puede comprobar —si la localidad del hotel aparece en algún bloque del
 * día o hay algo a menos de un kilómetro— y se dice cuando no.
 *
 * EL FALSO POSITIVO QUE HUBO QUE QUITAR. En Gdansk saltó «duermes en Centro
 * histórico y el plan no pasa por allí» con un plan que es Casco Viejo, Paseo de
 * Motlawa, Puerta de la Grúa e Iglesia de Santa María: el casco viejo entero.
 *
 * Dos motivos, y los dos importan. El primero es que Booking NO DA
 * COORDENADAS —mira `providers/booking.js`: guarda zona, dirección y distancia
 * al centro, nunca lat/lon—, así que la salvaguarda del kilómetro de aquí abajo
 * no se ha ejecutado nunca para un hotel de verdad y solo queda la comparación
 * de nombres. Se deja puesta porque el día que haya coordenadas es la buena, pero
 * no se puede contar con ella.
 *
 * Y el segundo es que «Centro histórico» no es un sitio, es una ETIQUETA. Ningún
 * bloque del plan se va a llamar así —se llaman Casco Viejo, Plaza Mayor,
 * Rynek—, así que por nombre no puede casar nunca y el aviso salta siempre.
 * Además da igual: este aviso existe para el que paga por dormir en Oia y luego
 * no pisa Oia, y dormir en el centro no es esa historia. Cuando la zona es una
 * etiqueta de centro, no hay nada que avisar.
 */
function avisarSiElHotelNoSePisa(viajeId, lienzo, di) {
  const etapas = todas(
    "SELECT * FROM etapas WHERE viaje_id = ? AND estado = 'confirmada' ORDER BY orden",
    viajeId
  );

  /**
   * A CUÁNTO DEJA DE SER «AL LADO DEL HOTEL».
   *
   * Kilómetro y medio y no uno: la unidad que se mide aquí es un PUEBLO o un
   * barrio, no una esquina. En Santorini el hotel está en Oia Caldera y el bloque
   * «Oia» —el centro del pueblo— cae a 1.073 m: con el kilómetro pelado el aviso
   * saltaba diciendo que el plan no pisa Oia mientras el plan estaba en Oia.
   */
  const KM = 1.5;

  for (const etapa of etapas) {
    const hotel = una(
      "SELECT id, titulo, datos_extra FROM candidatos WHERE etapa_id = ? AND tipo = 'hotel' AND marcado = 1",
      etapa.id
    );
    if (!hotel) continue;

    let extra = {};
    try {
      extra = hotel.datos_extra ? JSON.parse(hotel.datos_extra) : {};
    } catch {
      extra = {};
    }

    // La localidad: lo primero de la zona de Booking («Oia Caldera, Oia» → «Oia
    // Caldera»). Sin zona no hay nada que contar en el aviso.
    const zona = String(extra.zona ?? '').split(',')[0].trim();
    if (!zona || normalizarNombre(zona) === normalizarNombre(etapa.nombre_ciudad)) continue;
    if (esEtiquetaDeCentro(zona)) continue;

    const dias = lienzo.dias.filter((d) => d.etapaId === etapa.id).map((d) => d.n);
    const delaParada = lienzo.colocados.filter((c) => dias.includes(c.dia));
    if (!delaParada.length) continue;

    // DÓNDE ESTÁ EL HOTEL, DE LA TABLA DE DIRECCIONES Y NO DE `datos_extra`.
    //
    // Booking no guarda lat/lon en `datos_extra` y nunca las ha guardado, así que
    // la salvaguarda del kilómetro leía dos `undefined` y devolvía false SIEMPRE.
    // El aviso se decidía entero por la comparación de nombres de abajo.
    //
    // Las coordenadas sí existen: las pone la geocodificación que monta el mapa
    // del viaje, en la tabla `direcciones`, que es donde viven todas.
    const suya = direccionDe('hotel', hotel.id);
    const punto = suya?.situada ? { lat: Number(suya.punto.lat), lon: Number(suya.punto.lng) } : null;

    // SI NO SE PUEDE COMPROBAR, SE CALLA.
    //
    // Es la mitad del arreglo. Sin las coordenadas del hotel esto no sabe si el
    // plan pisa la zona o no, y soltar el aviso «por si acaso» es lo que lo
    // convirtió en ruido: saltó en Santorini con el hotel en Oia y Oia en el
    // plan, y en Polonia con el hotel en Śródmieście y el casco antiguo de
    // Varsovia justo ahí. Un aviso que salta siempre se deja de leer, y entonces
    // no sirve ninguno. Mejor callar que avisar mal.
    if (!punto) continue;

    // ¿HAY ALGO DEL PLAN AL LADO DEL HOTEL? Por distancia, que es la pregunta de
    // verdad. Antes mandaba el nombre —«¿aparece "Oia Caldera" en el título de
    // algún bloque?»— y por nombre no casa ni el sitio que está a doscientos
    // metros: el bloque se llama «Camini de Oia a Amoudi», no «Oia Caldera».
    const cerca = delaParada.some((c) => {
      const p = puntoDeTarjeta(c);
      return p ? distanciaKm(punto, p) <= KM : false;
    });
    if (cerca) continue;

    // El nombre se sigue mirando, pero AHORA como red de apoyo y en los dos
    // sentidos: un bloque llamado «Oia» y una zona «Oia Caldera» hablan del
    // mismo sitio aunque ninguno contenga al otro entero.
    // El nombre se sigue mirando, pero AHORA como red de apoyo y POR PALABRAS.
    //
    // La versión vieja preguntaba si el título del bloque CONTENÍA la zona
    // entera, y así no casa nada: la zona es «Oia Caldera» y el bloque se llama
    // «Oia» o «Camini de Oia a Amoudi». Comparando palabra a palabra sí casan, y
    // por palabras completas —no por trozos— para que «oia» no se cuele dentro
    // de «Troia».
    const palabras = (t) =>
      new Set(normalizarNombre(`${t ?? ''}`).split(' ').filter((p) => p.length >= 3));
    const suyas = palabras(zona);
    const laNombra = delaParada.some((c) => {
      const n = palabras(c.nombre);
      return [...suyas].some((p) => n.has(p));
    });
    if (laNombra) continue;

    di(
      `   Duermes en ${zona} («${hotel.titulo}») pero el plan de ${etapa.nombre_ciudad} no la pisa: ` +
        'considera mover una visita o el paseo de la tarde allí.',
      ORIGENES.ninguno
    );
    apuntarHueco(
      viajeId,
      FASE,
      `${etapa.nombre_ciudad}: duermes en ${zona} y el plan no pasa por allí.`
    );
  }
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
/** El suelo del día cuando no hay hora publicada. El mismo que usa `horaLibreEn`. */
const INICIO_DEL_DIA_TEXTO = '09:00';

/**
 * LA HORA OFICIAL DE UNA EXCURSIÓN NO SE SUGIERE: SE IMPONE.
 *
 * Decirle al modelo «empieza a las 08:00» y confiar en que haga caso es lo que
 * ya falló: colocó la excursión a Dougga a las 07:30 sin tener la hora, y con la
 * hora delante tampoco hay garantía de que la respete. Una hora publicada por
 * quien vende la excursión es un dato, no una preferencia, así que se escribe
 * encima de lo que haya decidido.
 *
 * Y LA JERARQUÍA, en este orden:
 *
 *   1. Hay hora publicada → esa, tal cual, aunque sea antes de las nueve. Si el
 *      autobús sale a las 06:15, sale a las 06:15: discutirlo no lo retrasa.
 *   2. No la hay → se respeta lo que propuso el modelo…
 *   3. …pero nunca antes del suelo del día. Sin dato, un 07:30 no es una hora
 *      que nadie haya publicado: es una invención, y el suelo la corrige.
 *
 * NO SE TOCA LA DURACIÓN NI EL DÍA. Mover el día es otra decisión —hay cierres y
 * huecos de por medio— y de eso se ocupa la revisión que viene detrás.
 */
function imponerLaHoraDeLasExcursiones(viajeId, di) {
  const lienzo = lienzoDeViaje(viajeId);
  if (!lienzo?.colocados?.length) return 0;

  const suelo = enMinutos(INICIO_DEL_DIA_TEXTO) ?? 9 * 60;
  let tocadas = 0;

  for (const c of lienzo.colocados) {
    const quien = deQuienEs(c);
    if (quien?.candidato?.tipo !== 'actividad' || !quien.deId) continue;

    const ficha = una(
      'SELECT titulo, horarios, descripcion_larga, incluye FROM catalogo_actividades WHERE id = ?',
      Number(quien.deId)
    );
    const oficial = horaDeInicioDeExcursion(ficha?.horarios, ficha?.descripcion_larga);

    if (oficial) {
      if (c.hora === oficial) continue;
      retocar(c.id, { hora: oficial });
      tocadas += 1;
      di(
        `   ${c.nombre}: Civitatis la saca a las ${oficial}` +
          `${hayRecogidaEnHotel(ficha?.incluye, ficha?.descripcion_larga) ? ' recogiéndote en el hotel' : ''}` +
          `${c.hora ? `, no a las ${c.hora}` : ''}. Mando la hora publicada.`,
        ORIGENES.ninguno
      );
      continue;
    }

    // Sin hora publicada: al menos, que no empiece de madrugada.
    const suya = enMinutos(c.hora);
    if (suya == null || suya >= suelo) continue;
    retocar(c.id, { hora: INICIO_DEL_DIA_TEXTO });
    tocadas += 1;
    di(
      `   ${c.nombre} estaba a las ${c.hora} y nadie publica esa hora: la dejo a las ` +
        `${INICIO_DEL_DIA_TEXTO}, que es lo más pronto que empieza un día.`,
      ORIGENES.ninguno
    );
  }

  return tocadas;
}

/**
 * Lo que queda por decir del día de aclimatación y del siguiente.
 *
 * Se exporta por lo mismo que `revisarElReparto`: para poder probarlo sin
 * montar un viaje entero.
 */
export function contarLoDeLaAclimatacion(viajeId, lienzo, di) {
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

  // --- Y EL DÍA DE DESPUÉS, CUANDO NO SE HA PODIDO EVITAR -----------------
  //
  // El suelo del día siguiente lo pone `horaLibreEn`, y sirve para lo que se
  // COLOCA. No sirve para lo que ya tiene su hora puesta desde fuera: una
  // excursión que Civitatis saca a las 08:00 sale a las 08:00, y retrasarla a
  // las 10:00 para cumplir el suelo sería escribir una hora que no existe.
  //
  // Lo único honesto que queda es decirlo. En el viaje a Túnez esto es la
  // diferencia entre un plan que te pone ocho horas de excursión a la mañana
  // siguiente de llegar a medianoche sin comentar nada, y uno que te avisa de
  // que lo sabe y de que no lo ha podido colocar de otra manera.
  const suelo = enMinutos(parametroTexto('hora_inicio_tras_jetlag', '10:00'));
  const madrugan = lienzo.colocados.filter((c) => {
    if (c.dia !== a.dia + 1) return false;
    const suya = enMinutos(c.hora);
    return suelo != null && suya != null && suya < suelo;
  });

  if (!madrugan.length) return;

  for (const c of madrugan) {
    di(
      `   OJO: ${c.nombre} empieza a las ${c.hora} el día ${a.dia + 1}, y el día ` +
        `${a.dia} ${a.deNoche ? 'se llega de noche' : 'es de aclimatación'}.`,
      ORIGENES.ninguno
    );
  }
  apuntarHueco(
    viajeId,
    FASE,
    `El día ${a.dia + 1} arranca a las ${madrugan[0].hora} (${madrugan[0].nombre}) y ` +
      `${a.deNoche ? `la noche anterior se llega a la ciudad a las ${a.horaLlegada ?? 'última hora'}` : 'el día anterior es de aclimatación'}. ` +
      `No he podido empezar más tarde: esa hora la publica quien organiza, no yo. ` +
      `Si prefieres no madrugar, muévelo de día tú.`
  );
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
    if (cierraEseDia(colocado, d.fecha)) {
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

  // EL TABLERO, RECIÉN LEÍDO.
  //
  // `lienzo` es la foto con la que arrancó la pasada, y dentro de una misma
  // pasada se resuelven varios solapes seguidos. Calculando sobre la foto vieja,
  // el segundo arreglo manda un bloque a un hueco que el primero acaba de
  // ocupar: en la prueba, la comida se fue a las 13:30 y la Grúa a las 14:30, y
  // se pisaron entre ellas. Cada resolución mira lo que hay AHORA.
  const tablero = lienzoDeViaje(viajeId);
  const alDia = new Map(tablero.colocados.map((c) => [c.id, c]));

  const [primero, segundo] = pareja.map((x) => alDia.get(x.id) ?? x);

  // Si alguno ya no está —lo movió o lo quitó otro aviso de esta misma pasada—
  // este conflicto puede haber dejado de existir.
  if (!alDia.has(pareja[0].id) || !alDia.has(pareja[1].id)) return 0;

  const finPrimero = (enMinutos(primero.hora) ?? 0) + (Number(primero.duracionMin) || 0);

  // AQUÍ HABÍA UN «YA NO SE PISAN» QUE MATABA EL «NO LLEGAS».
  //
  // La línea era esta, y estaba justo aquí:
  //
  //     if ((enMinutos(segundo.hora) ?? 0) >= finPrimero) return 0;
  //
  // Escrita para un SOLAPE, donde el segundo siempre empieza antes de que el
  // primero acabe. Pero en un «no llegas» el segundo empieza DESPUÉS —esa es la
  // definición—, así que la condición se cumplía SIEMPRE y la función se
  // rendía en la primera línea, sin decir nada. Se vio en el viaje 102:
  //
  //     Día 3: Medina de Kairouan acaba 16:30, Café Halfaouine empieza 16:30  → 16:30 >= 16:30
  //     Día 4: Zoco de las Alfombras acaba 16:00, Bir Barouta empieza 16:15   → 16:15 >= 16:00
  //
  // Los dos avisos salieron en las dos pasadas y acabaron en «ninguno de esos
  // avisos tiene un arreglo que yo sepa hacer», teniendo el arreglo aquí mismo.
  // Es el mismo fallo que el aviso muerto de `avisosDeTiempo`: una suposición de
  // solape colocada en el camino que los dos comparten.
  //
  // No hace falta sustituirla por nada: `estorbo <= 0`, doce líneas más abajo,
  // ya dice «ya no se pisan» para los dos casos, porque se mide contra
  // `puedeDesde` —que incluye el trayecto— y no contra el final del primero.
  const { mas, menos, impMas, impMenos } = quienPesaMas(primero, segundo);

  // A qué hora puede empezar el segundo sin pisar al primero. En un solape es
  // cuando acaba el primero; en un «no llegas» incluye además el trayecto, y por
  // eso se lee del aviso en vez de recalcularlo.
  // Y la hora a la que el segundo puede empezar se recalcula sobre lo que hay
  // ahora, no sobre la que traía el aviso: si el primero se ha movido o recortado
  // entre medias, aquella ya no vale.
  const puedeDesde = Math.max(finPrimero, enMinutos(aviso.libreDesde) ?? 0);
  const empiezaSegundo = enMinutos(segundo.hora);
  if (empiezaSegundo == null) return 0;

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
  const retraso = recolocarConHora(viajeId, tablero, segundo, {
    desde: aviso.libreDesde,
    mismoDia: true,
  });
  // UNA COMIDA RETRASADA A LAS CUATRO YA NO ES UNA COMIDA.
  //
  // El paso de arriba resolvió el solape mandándola a las 16:00, que es legal y
  // es malo. Las 16:00 son el corte que ya usa el resto de la fase para decir
  // «no hay hueco a una hora de comer»; aquí vale el mismo. Si el retraso la
  // saca de hora, se deshace y se prueban los recursos de abajo.
  const seLeFueLaHora =
    retraso.movido && esComida(segundo) && (enMinutos(retraso.hora) ?? 0) >= 16 * 60;

  if (seLeFueLaHora) {
    mover(segundo.id, { dia: segundo.dia, franja: segundo.franja });
    retocar(segundo.id, { hora: segundo.hora });
    intentos.push(`retrasar la comida (se iba a las ${retraso.hora})`);
  } else if (retraso.movido) {
    di(
      `   Día ${aviso.dia}: ${segundo.nombre} se retrasa a las ${retraso.hora}, ` +
        `detrás de ${primero.nombre}.`
    );
    return 1;
  }
  intentos.push(`retrasar ${segundo.nombre} en su día`);

  // --- c) ADELANTAR LA COMIDA ---------------------------------------------
  //
  // Los dos recursos de arriba tiran del lado tarde: recortar lo de delante o
  // retrasar lo de detrás. Y con el solape de Atenas —«Comer · Plaka acaba a las
  // 15:00 y Plaka empieza a las 14:00»— ninguno servía: la comida quedaba en 30
  // minutos y el sitio no tenía dónde retrasarse. La revisión se rendía teniendo
  // a mano la solución más obvia de todas: comer antes.
  //
  // Se adelanta hasta las 13:00, que es el borde temprano de una hora de comer
  // razonable. Más pronto ya no es comer, es almorzar a deshora.
  const comida = esComida(primero) ? primero : esComida(segundo) ? segundo : null;
  if (comida) {
    const TOPE_TEMPRANO = 13 * 60;
    const empiezaComida = enMinutos(comida.hora);
    const duraComida = Number(comida.duracionMin) || 0;

    // Cuánto hay que adelantarla: lo justo para dejar libre al otro.
    const otro = comida.id === primero.id ? segundo : primero;
    const necesita =
      comida.id === primero.id
        ? empiezaComida + duraComida - (enMinutos(otro.hora) ?? 0)
        : empiezaComida + duraComida - puedeDesde;

    if (empiezaComida != null && necesita > 0 && empiezaComida - necesita >= TOPE_TEMPRANO) {
      const nueva = comoHoraDeMinutos(empiezaComida - necesita);
      const libre = horaLibreEn(sinEl(tablero, comida.id), {
        dia: comida.dia,
        franja: franjaDesde(nueva) ?? comida.franja,
        duracion: duraComida,
        noAntesDe: nueva,
      });
      if (libre === nueva) {
        mover(comida.id, { dia: comida.dia, franja: franjaDesde(nueva) ?? comida.franja });
        retocar(comida.id, { hora: nueva });
        di(
          `   Día ${aviso.dia}: la comida se adelanta a las ${nueva} y deja sitio a ` +
            `${otro.nombre}.`
        );
        return 1;
      }
    }
    intentos.push(`adelantar la comida (no cabe antes de las ${comoHoraDeMinutos(TOPE_TEMPRANO)})`);
  }

  // --- d) ADELANTAR EL SITIO, si su horario lo permite ---------------------
  //
  // El otro lado de la misma idea: si lo que va detrás puede empezar antes —el
  // sitio ya ha abierto y no pisa nada por delante— se adelanta y el solape
  // desaparece sin tocar la comida.
  if (!esComida(segundo)) {
    const nat = naturalezaDe(segundo);
    if (!nat.sesiones?.length) {
      const dia = tablero.dias.find((d) => d.n === segundo.dia);
      const abre = aperturaDe(segundo, dia?.fecha);
      const dura = Number(segundo.duracionMin) || 60;
      const desde = comoHoraDeMinutos(Math.max(abre ?? 9 * 60, 9 * 60));

      const libre = horaLibreEn(sinEl(tablero, segundo.id), {
        dia: segundo.dia,
        franja: franjaDesde(desde) ?? segundo.franja,
        duracion: dura,
        noAntesDe: desde,
        cierraA: cierreDe(segundo),
      });
      // Solo vale si de verdad queda ANTES de donde estaba y del bloque que le
      // pisaba: adelantarlo a la misma hora no arregla nada.
      if (libre && enMinutos(libre) + dura <= (enMinutos(primero.hora) ?? Infinity)) {
        mover(segundo.id, { dia: segundo.dia, franja: franjaDesde(libre) ?? segundo.franja });
        retocar(segundo.id, { hora: libre });
        di(`   Día ${aviso.dia}: ${segundo.nombre} se adelanta a las ${libre}, antes de ${primero.nombre}.`);
        return 1;
      }
    }
    intentos.push(`adelantar ${segundo.nombre}`);
  }

  // --- e) MOVER el que menos pesa a otro día válido ------------------------
  //
  // La comida no viaja de día: es un bloque diario. Si no ha podido recortarse
  // ni retrasarse ni adelantarse, se queda el aviso escrito antes que
  // convertirla en cena.
  if (esComida(menos)) {
    // SI LA COMIDA NO SE PUEDE MOVER, SE MUEVE EL OTRO.
    //
    // Es lo que faltaba. La comida es un bloque diario y a una hora: no viaja de
    // día ni se va a las cuatro. El sitio sí. Moverlo no rompe la jerarquía
    // —nadie pierde nada, solo cambia de hora— y es la diferencia entre un día
    // resuelto y un «no he sabido resolverlo» con la comida pisada.
    const elOtro = menos.id === primero.id ? segundo : primero;
    if (!esComida(elOtro)) {
      const r = recolocarConHora(viajeId, tablero, elOtro);
      if (r.movido) {
        di(
          `   Día ${aviso.dia}: la comida no se puede mover, así que muevo ${elOtro.nombre} ` +
            `al día ${r.dia} a las ${r.hora}.`
        );
        return 1;
      }
      intentos.push(`mover ${elOtro.nombre}`);
    }

    di(
      `   Día ${aviso.dia}: ${menos.nombre} choca con ${mas.nombre} y no he podido ` +
        `${intentos.join(' ni ')}. La comida no cambia de día: lo dejo dicho.`
    );
    return 0;
  }

  const mudanza = recolocarConHora(viajeId, tablero, menos, { soloOtroDia: true });
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

    // EL PESO SE MIRA ANTES DE SACARLO, Y AQUÍ ESTABA EL SILENCIO DE WAWEL.
    //
    // `sacarDelPlan` borra el candidato —eso es lo que significa desapuntar— y
    // `importanciaDe` lo busca por su candidato. Preguntando después, la fila ya
    // no existía, `deQuienEs` devolvía null y todo caía al nivel 3 por defecto:
    // el aviso grave no podía saltar NUNCA, por importante que fuera lo que se
    // estaba tirando. El Castillo de Wawel se fue del viaje sin una línea.
    const imp = importanciaDe(c);
    const noSePodiaPerder = esDeLosQueNoSePuedenPerder(c);
    const eraExcursion = deQuienEs(c)?.candidato?.tipo === 'actividad';

    fuera.push({ ...sacarDelPlan(c, di, motivo), dia: c.dia, eraExcursion });

    if (noSePodiaPerder) {
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

  const auto = configAutoDelMotor(viaje);
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

    const piezas = colocablesDeEtapa(etapa, lienzo, di).map((p, i) => ({
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
      // EL PERFIL, PARA LA REGLA 13 DEL PROMPT. Sin esto la regla estaría
      // escrita y sin dato, que es el fallo que acabamos de arreglar dos veces.
      INTERESES:
        [auto.intereses, (auto.categorias ?? []).join(', ')].filter(Boolean).join(' · ') ||
        '(sin especificar)',
      HOTEL: dondeSeDuerme(etapa.id),
      COLOCABLES: piezas
        .map(
          (p) =>
            `- ${p.clase === 'excursion' ? 'EXCURSIÓN' : 'sitio'} ${p.ref} · ${p.nombre}` +
            `${p.categoria ? ` (${p.categoria})` : ''}` +
            `${p.bloque === 'otros' ? ' [segundo nivel]' : ''}` +
            `${p.bloque === 'ninos' ? ' [para niños]' : ''}\n` +
            `  visita: ${p.duracion ?? 'no lo sé'}` +
            `${p.horarios ? `\n  horario: ${String(p.horarios).slice(0, 120)}` : ''}` +
            `${p.cierraTexto ? `\n  CIERRA los ${p.cierraTexto}` : ''}` +
            `${p.cierraSinSaber ? '\n  NO SE SABE qué días cierra: no lo des por abierto' : ''}`
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

  // LA HORA QUE PUBLICA CIVITATIS MANDA, Y SE IMPONE ANTES DE REVISAR NADA.
  //
  // Va aquí y no después: lo que la revisión corrija tiene que partir ya de la
  // hora buena. Si se forzara al final, la revisión habría estado peleándose con
  // una hora inventada y moviendo cosas alrededor de ella.
  imponerLaHoraDeLasExcursiones(viajeId, di);

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

  // LA EXCURSIÓN EXPULSADA DEJA SU DÍA, Y ESE DÍA SE RELLENA.
  //
  // En Dubrovnik (viaje 127) la revisión echó «Excursión a Mostar y las
  // cascadas de Kravice» del día 9 y el día se quedó con las murallas por la
  // mañana, una «Comer · Mostar, durante la excursión» a las 13:00 y la tarde
  // vacía. El relleno solo se disparaba con la excursión que no llegó a
  // colocarse, no con la que se colocó y luego se echó: el mismo cráter por la
  // otra puerta.
  rellenarLosDiasDeExcursionesEchadas(
    viajeId,
    sacados.filter((x) => x.eraExcursion).map((x) => x.dia),
    di
  );
  final = lienzoDeViaje(viajeId);

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

  // UNA PASADA MÁS, PORQUE ACABAMOS DE CAMBIAR EL PLAN.
  //
  // El bucle de revisiones de arriba ya ha terminado, y justo después esto quita
  // excursiones y rellena el día que dejan. Lo que se mete ahí no lo mira nadie:
  // en la prueba de Grecia el día 6 pasó de vacío a cinco visitas y se quedó
  // SIN COMIDA, porque el aviso de «este día no tiene dónde comer» nace después
  // de que su único arreglo haya pasado de largo.
  //
  // Es una sola pasada y solo si hay algo que mirar: no se reabre el bucle, se
  // le da al plan nuevo el mismo repaso que tuvo el viejo.
  if (final.avisos.length) {
    di(`Tras liberar el día: quedan ${final.avisos.length} aviso(s); los repaso.`);
    if (corregirAvisos(viajeId, final, di, sacados, duracionComida, horaTope)) {
      final = lienzoDeViaje(viajeId);
    }
  }

  // LO QUE LA IA COLOCÓ FUERA DE HORARIO, ANTES DE QUE LA REVISIÓN SE PELEE.
  //
  // El Castillo de Wawel se colocó a las 16:30 con 180 minutos y cerrando a las
  // 17:00. La hora de INICIO era válida —el sitio estaba abierto— y nadie miró
  // que la visita entera no cabía. La revisión lo heredó ya roto y acabó
  // echándolo del viaje.
  const enderezado = enderezarLoQueNoCabeEnSuHorario(viajeId, final, di);
  final = enderezado.lienzo;
  const fueraDeHorario = enderezado.sinResolver;

  // UNA COMIDA AL DÍA, NO DOS. Va antes de los avisos: lo que se quite aquí no
  // tiene que salir después como un solape sin resolver.
  final = unaSolaComidaAlDia(viajeId, final, di);
  final = comidaAHoraDeComer(viajeId, final, di);

  avisarSiElHotelNoSePisa(viajeId, final, di);

  contarLoDeLaAclimatacion(viajeId, final, di);

  // LAS EXCURSIONES QUE NO ENTRARON, ANTES DE JUZGAR. Su relleno cambia los
  // días —y ahora devuelve los sitios que tapaban—, así que el veredicto de las
  // paradas tiene que leer el plan de después, no el de antes.
  avisarDeExcursionesSinColocar(viaje, motivosDeFuera, di);

  repescarLosImprescindiblesQueFaltan(viajeId, di);

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
  // LO QUE SE QUEDÓ FUERA DE SU HORARIO CUENTA COMO PENDIENTE, igual que un
  // solape. Es un bloque puesto a una hora a la que el sitio está cerrado: si no
  // entra aquí, la fase se declara limpia teniéndolo dentro.
  if (fueraDeHorario.length) {
    di(
      `${fueraDeHorario.length} bloque(s) se quedan a una hora en la que el sitio ` +
        'está cerrado y no encontré dónde moverlos:'
    );
    for (const f of fueraDeHorario) di(`   · Día ${f.dia}: ${f.nombre} — ${f.comoEs}.`);
    apuntarHueco(
      viajeId,
      FASE,
      `${fueraDeHorario.length} visita(s) puestas fuera del horario del sitio: ` +
        `${fueraDeHorario.map((f) => `${f.nombre} (día ${f.dia})`).join(', ')}.`
    );
  }

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
  } else if (!fueraDeHorario.length) {
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
    `SELECT c.id, c.titulo, c.etapa_id AS etapaId, e.nombre_ciudad
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
    rellenarLoQueDejoLaExcursionFantasma(viaje, sueltas, di);
  }

  return sueltas.length;
}

/**
 * EL DÍA QUE SE PLANIFICÓ ALREDEDOR DE UNA EXCURSIÓN QUE NO LLEGÓ A ENTRAR.
 *
 * EL FALLO QUE ORIGINA ESTO, y es Tesalónica en el viaje 108. El reparto montó
 * el día 2 así:
 *
 *     Día 2 (Tesalónica, martes): comida (Durante la excursión, en Édessa o Pozar),
 *                                 Arco de Galerio, Ladadika
 *       — «Día completo: excursión a Pozar y Édessa ocupa la jornada entera»
 *
 * …y dejó fuera DIECIOCHO sitios justificándose con ella. Después la excursión no
 * cupo: «quedó apuntada pero sin sitio». La parada acabó con 2 de 10
 * imprescindibles, un día con una comida «durante la excursión» que no existe y
 * el Arco de Galerio a las 19:00 durante quince minutos.
 *
 * ES EL HERMANO GEMELO DE `liberarLoQueSeComeLaExcursion`, Y AL REVÉS. Aquella
 * quita una excursión que SÍ está y rellena el hueco que deja. Esta atiende el
 * caso contrario —una que NO está y a la que el plan le sigue haciendo sitio— y
 * por eso aquella no podía dispararse aquí: solo mira excursiones colocadas.
 *
 * Quitar la excursión invalida sus excusas. Que no llegara a ponerse, también.
 *
 * SOLO AÑADE EN LOS HUECOS QUE HAYAN QUEDADO. No mueve ni toca nada de lo que ya
 * está, y `huecoValido` sigue mandando: si el día está lleno de verdad, no entra
 * nada y no pasa nada.
 */
/**
 * LA COMIDA, A LA HORA DE COMER.
 *
 * El plan tiene una comida al día, y el reparto la dejaba donde caía: a las
 * 20:00 el día de llegada a Belgrado o a las 17:30 en Sarajevo (viaje 128).
 * Eso no es la comida, es la cena, y el día queda sin comer. Si está fuera de
 * las 12:00–16:30 se busca un hueco dentro, de su duración o de una hora; si no
 * lo hay, se queda donde estaba.
 */
const COMIDA_DESDE = '12:00';
const COMIDA_HASTA = '16:30';
function comidaAHoraDeComer(viajeId, lienzo, di) {
  let tocado = false;
  for (const c of lienzo.colocados.filter((x) => esComida(x) && x.hora)) {
    if (c.hora >= COMIDA_DESDE && c.hora <= COMIDA_HASTA) continue;
    const tablero = sinEl(lienzoDeViaje(viajeId), c.id);
    const duraciones = [...new Set([Number(c.duracionMin) || 90, 60])];
    let puesta = null;
    for (const duracion of duraciones) {
      for (const franja of ['manana', 'mediodia']) {
        const h = horaLibreEn(tablero, { dia: c.dia, franja, duracion, noAntesDe: COMIDA_DESDE });
        if (h && h >= COMIDA_DESDE && h <= COMIDA_HASTA) {
          puesta = { hora: h, duracion };
          break;
        }
      }
      if (puesta) break;
    }
    if (!puesta) continue;
    mover(c.id, { dia: c.dia, franja: franjaDesde(puesta.hora) ?? 'mediodia' });
    retocar(c.id, { hora: puesta.hora, duracionMin: puesta.duracion });
    di(
      `   Día ${c.dia}: «${c.nombre}» estaba a las ${c.hora}; la paso a las ${puesta.hora}` +
        (puesta.duracion !== (Number(c.duracionMin) || 90) ? ` (${puesta.duracion} min)` : '') +
        ', que es hora de comer.',
      ORIGENES.ninguno
    );
    tocado = true;
  }
  return tocado ? lienzoDeViaje(viajeId) : lienzo;
}

/**
 * EL ÚLTIMO REPASO: NINGÚN IMPRESCINDIBLE FUERA SI HAY UNO DE SEGUNDO NIVEL
 * OCUPANDO SU HUECO.
 *
 * Todo lo anterior coloca, corrige y rellena, y puede acabar con un
 * imprescindible fuera y un sitio de segundo nivel en la hora en la que cabía.
 * Aquí, por parada y en su orden, cada imprescindible que falte se intenta en
 * un hueco libre y, si no lo hay, en el que deja una visita de segundo nivel.
 * Nunca desplaza a otro imprescindible ni a una excursión.
 */
function repescarLosImprescindiblesQueFaltan(viajeId, di) {
  const etapas = todas(
    "SELECT * FROM etapas WHERE viaje_id = ? AND estado = 'confirmada' AND noches > 0 ORDER BY orden",
    viajeId
  );
  const estaColocado = (sitioId) =>
    Boolean(
      una(
        `SELECT 1 FROM itinerario i JOIN candidatos c ON c.id = i.candidato_id
          WHERE i.viaje_id = ? AND c.tipo = 'sitio' AND c.datos_extra LIKE ?`,
        viajeId,
        `%"deId":${sitioId}%`
      )
    );

  for (const etapa of etapas) {
    const faltan = imprescindiblesDeParada(etapa).filter((x) => !estaColocado(x.id));
    for (const x of faltan) {
      colocarImprescindible(viajeId, lienzoDeViaje(viajeId), etapa, x, di, [], {
        comoSeDice: 'entra en el día %d a las %h, en el último repaso',
        cederSegundoNivel: true,
        siNoCabe: 'sigue sin hueco en %c ni cediéndole una visita de segundo nivel',
      });
    }
  }
}

/**
 * LA COMIDA «DURANTE LA EXCURSIÓN» SIN EXCURSIÓN.
 *
 * El reparto pone la comida del día de la excursión dentro de ella —«Comer ·
 * Mostar, durante la excursión»—. Si la excursión se va, esa comida se queda
 * contando una mentira a la hora de comer. Se quita solo si ese día no queda
 * ninguna otra excursión; el relleno pone después una comida de verdad.
 */
// «durante la excursión», pero también «a bordo o en el puerto al regreso» (el
// crucero de las Elafitas) o «incluida en la excursión».
const COMIDA_DE_EXCURSION = /excursi|a bordo|durante|incluid|al regreso|en ruta/i;

function quitarLaComidaDeLaExcursion(viajeId, dias, di) {
  const lienzo = lienzoDeViaje(viajeId);
  for (const dia of dias) {
    const delDia = lienzo.colocados.filter((c) => c.dia === dia);
    if (delDia.some((c) => deQuienEs(c)?.candidato?.tipo === 'actividad')) continue;
    for (const c of delDia) {
      if (!esComida(c) || !COMIDA_DE_EXCURSION.test(String(c.nombre ?? ''))) continue;
      quitar(c.id);
      di(`   Día ${dia}: quito «${c.nombre}», que era la comida de una excursión que ya no está.`, ORIGENES.ninguno);
    }
  }
}

function rellenarLosDiasDeExcursionesEchadas(viajeId, dias, di) {
  const unicos = [...new Set(dias.filter((d) => Number.isInteger(d)))];
  if (!unicos.length) return;

  quitarLaComidaDeLaExcursion(viajeId, unicos, di);

  const lienzo = lienzoDeViaje(viajeId);
  const porEtapa = new Map();
  for (const n of unicos) {
    const d = lienzo.dias.find((x) => x.n === n);
    if (!d?.etapaId || esDiaDeViaje(lienzo, n)) continue;
    porEtapa.set(d.etapaId, [...(porEtapa.get(d.etapaId) ?? []), n]);
  }
  for (const [etapaId, suyos] of porEtapa) {
    const etapa = una('SELECT * FROM etapas WHERE id = ?', etapaId);
    if (!etapa) continue;
    di(
      `   ${etapa.nombre_ciudad}: la excursión del día ${suyos.join(', ')} se ha ido, así que ` +
        'vuelvo a mirar qué cabe en su hueco.',
      ORIGENES.ninguno
    );
    rellenarElDiaLiberado(viajeId, etapa, suyos, di);
  }
}

function rellenarLoQueDejoLaExcursionFantasma(viaje, sueltas, di) {
  const etapas = [...new Set(sueltas.map((x) => x.etapaId).filter(Boolean))];

  for (const etapaId of etapas) {
    const etapa = una('SELECT * FROM etapas WHERE id = ?', etapaId);
    if (!etapa) continue;

    const lienzo = lienzoDeViaje(viaje.id);
    const dias = lienzo.dias
      .filter((d) => d.etapaId === etapa.id && !esDiaDeViaje(lienzo, d.n))
      .map((d) => d.n);
    if (!dias.length) continue;

    di(
      `   ${etapa.nombre_ciudad}: la excursión que sostenía el plan no entró, así que ` +
        'vuelvo a mirar qué cabe en sus días.',
      ORIGENES.ninguno
    );
    quitarLaComidaDeLaExcursion(viaje.id, dias, di);
    rellenarElDiaLiberado(viaje.id, etapa, dias, di);
  }
}

export default {
  ejecutarFaseLienzo,
  diasDeLaEtapa,
  colocablesDeEtapa,
  avisarDeExcursionesSinColocar,
};
