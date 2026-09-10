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
  FRANJAS,
} from '../services/lienzo.js';
import { datosDeSitio, interpretarHorario } from '../services/datos-sitios.js';
import { ocupacionDe } from '../services/proveedores.js';
import { alternarApuntado } from '../services/etapa.js';
import { anotar, apuntarHueco, parametro, configAuto, ORIGENES } from '../services/orquestador.js';

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
function recolocarConHora(viajeId, lienzo, colocado, { desde = null, mismoDia = false } = {}) {
  const quien = deQuienEs(colocado);
  const sitio =
    quien?.de === 'sitio' && quien.deId
      ? una('SELECT horarios, categoria FROM sitios_lugar WHERE id = ?', quien.deId)
      : null;

  const cierre = sitio ? cierraALasMinutos(sitio) : null;
  const duracion = Number(colocado.duracionMin) || 60;

  const franjasDesde = (clave) => CLAVES_FRANJA.slice(CLAVES_FRANJA.indexOf(clave) + 1);

  // 1) Lo que queda del mismo día, detrás de donde estaba.
  for (const franja of franjasDesde(colocado.franja)) {
    const hora = horaLibreEn(lienzo, {
      dia: colocado.dia,
      franja,
      duracion,
      noAntesDe: desde,
      cierraA: cierre,
    });
    if (hora) {
      mover(colocado.id, { dia: colocado.dia, franja });
      retocar(colocado.id, { hora });
      return { movido: true, dia: colocado.dia, franja, hora };
    }
  }

  if (mismoDia) return { movido: false };

  // 2) Otro día de la misma parada, empezando por el primero.
  const diaActual = lienzo.dias.find((d) => d.n === colocado.dia);
  for (const d of lienzo.dias.filter((x) => x.etapaId === diaActual?.etapaId && x.n !== colocado.dia)) {
    for (const franja of CLAVES_FRANJA) {
      const hora = horaLibreEn(lienzo, { dia: d.n, franja, duracion, cierraA: cierre });
      if (hora) {
        mover(colocado.id, { dia: d.n, franja });
        retocar(colocado.id, { hora });
        return { movido: true, dia: d.n, franja, hora };
      }
    }
  }

  return { movido: false };
}

/**
 * UNA PASADA DE CORRECCIONES. Devuelve cuántas cosas ha tocado.
 *
 * Cada tipo de aviso tiene su arreglo. Lo que no sepa arreglar se queda como
 * está y se dirá al final: mejor un aviso escrito que un arreglo inventado.
 */
function corregirAvisos(viajeId, lienzo, di, fuera, duracionComida) {
  let tocados = 0;
  const porId = new Map(lienzo.colocados.map((c) => [c.id, c]));

  for (const aviso of lienzo.avisos) {
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

      const hora = llega && Number(llega.split(':')[0]) > 13 ? llega : '13:30';
      const franja = franjaDesde(hora) ?? 'mediodia';

      if (Number(hora.split(':')[0]) >= 16) {
        di(`   Día ${aviso.dia}: no hay hueco a una hora de comer; lo dejo dicho.`);
        continue;
      }

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
          fuera.push(sacarDelPlan(c, di, 'no cabía después del viaje ni en otro día'));
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
          fuera.push(sacarDelPlan(c, di, 'seguía a la hora del vuelo de vuelta y no cabía antes'));
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
          fuera.push(sacarDelPlan(c, di, 'caía antes de llegar y no había hueco después'));
        }
        tocados += 1;
      }
      continue;
    }

    if (aviso.tipo === 'despues-de-irse') {
      for (const c of afectados) {
        fuera.push(sacarDelPlan(c, di, 'caía después del viaje de vuelta'));
        tocados += 1;
      }
      continue;
    }

    if (aviso.tipo === 'sitio-cerrado') {
      for (const c of afectados) {
        // OTRO DÍA DE LA MISMA PARADA EN EL QUE ESE SITIO ABRA.
        //
        // Los días de cierre se leen de la ficha (`cierra_dias`, 0 = domingo),
        // no del texto del aviso: el texto está escrito para una persona y
        // reconstruir el dato a base de expresiones regulares es pedir un fallo.
        const quien = deQuienEs(c);
        const ficha =
          quien?.de === 'sitio' && quien.deId
            ? una('SELECT cierra_dias FROM sitios_lugar WHERE id = ?', quien.deId)
            : null;

        let cierra = [];
        try {
          cierra = ficha?.cierra_dias ? JSON.parse(ficha.cierra_dias) : [];
        } catch {
          cierra = [];
        }

        const diaSemana = (fecha) =>
          fecha ? new Date(`${fecha}T12:00:00`).getDay() : null;

        const destino = lienzo.dias.find(
          (d) =>
            d.etapaId === dia?.etapaId &&
            d.n !== c.dia &&
            !cierra.includes(diaSemana(d.fecha))
        );
        if (destino) {
          const duracion = Number(c.duracionMin) || 60;
          const hora =
            horaLibreEn(lienzo, { dia: destino.n, franja: c.franja, duracion }) ??
            CLAVES_FRANJA.map((f) => horaLibreEn(lienzo, { dia: destino.n, franja: f, duracion })).find(
              Boolean
            );
          if (hora) {
            mover(c.id, { dia: destino.n, franja: franjaDesde(hora) ?? c.franja });
            retocar(c.id, { hora });
            di(`   ${c.nombre} cerraba ese día: lo paso al día ${destino.n} a las ${hora}.`);
          } else {
            fuera.push(sacarDelPlan(c, di, 'cierra ese día y el otro día no tiene hueco'));
          }
        } else {
          fuera.push(sacarDelPlan(c, di, 'cierra el único día que había para verlo'));
        }
        tocados += 1;
      }
      continue;
    }

    if (aviso.tipo === 'no-llegas' || aviso.tipo === 'solape') {
      // El segundo de la pareja es el que no cabe: se va a la franja siguiente.
      const ultimo = afectados[afectados.length - 1];
      if (!ultimo) continue;

      // LA COMIDA NO SE MUEVE DE FRANJA, SE RETRASA UN RATO.
      //
      // Es un bloque diario y a una hora: mandarla a la noche porque una visita
      // se ha alargado convierte la comida en cena, que es peor que el problema
      // que se quería arreglar. Se le da la hora a la que queda libre el día, y
      // si eso ya no es hora de comer se deja el aviso puesto: mejor decir que
      // no he sabido arreglarlo que arreglarlo mal.
      const esComida = /^comer\b/i.test(String(ultimo.nombre ?? ''));
      if (esComida) {
        const libre = aviso.libreDesde;
        const hora = Number(String(libre ?? '').split(':')[0]);
        if (libre && Number.isFinite(hora) && hora < 16) {
          retocar(ultimo.id, { hora: libre });
          di(`   Día ${aviso.dia}: la comida pasa a las ${libre}, que es cuando queda libre.`);
          tocados += 1;
        } else {
          di(`   Día ${aviso.dia}: la comida se solapa y no hay hueco a una hora de comer.`);
        }
        continue;
      }

      const r = recolocarConHora(viajeId, lienzo, ultimo, { desde: aviso.libreDesde });
      if (r.movido) {
        di(
          `   Día ${aviso.dia}: ${ultimo.nombre} pasa al día ${r.dia}, ${r.franja} a las ${r.hora}` +
            `${aviso.tipo === 'solape' ? ' (se solapaba con lo anterior).' : ' (no daba tiempo).'}`
        );
      } else {
        fuera.push(
          sacarDelPlan(
            ultimo,
            di,
            aviso.tipo === 'solape'
              ? 'se solapaba y no había hueco con hora en ningún día de la parada'
              : 'no daba tiempo a llegar y no había hueco en ningún día de la parada'
          )
        );
      }
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
  let sinColocarEnTotal = 0;

  for (const etapa of etapas) {
    const ciudad = etapa.nombre_ciudad;

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
      }
    }

    // Y ninguna tarjeta se queda sin hora: un «--:--» es invisible para el
    // validador, y lo invisible no se puede corregir después.
    ponerHorasQueFalten(viajeId, di);

    // EL COTEJO: lo declarado contra lo que hay.
    for (const x of perdidos) {
      di(`   Declaró colocar ${x.ref} en el día ${x.dia} y no se ha podido: ${x.motivo}.`);
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

    const tocados = corregirAvisos(viajeId, final, di, sacados, duracionComida);
    if (!tocados) {
      di('   Ninguno de esos avisos tiene un arreglo que yo sepa hacer.');
      break;
    }
    final = lienzoDeViaje(viajeId);
  }

  sinColocarEnTotal += sacados.length;

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

export default { ejecutarFaseLienzo, diasDeLaEtapa, colocablesDeEtapa };
