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
import { lienzoDeViaje, colocar, FRANJAS } from '../services/lienzo.js';
import { datosDeSitio } from '../services/datos-sitios.js';
import { ocupacionDe } from '../services/proveedores.js';
import { alternarApuntado } from '../services/etapa.js';
import { anotar, apuntarHueco, parametro, configAuto } from '../services/orquestador.js';

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
// LA FASE
// =============================================================================
export async function ejecutarFaseLienzo(viaje, prompt) {
  const viajeId = viaje.id;
  const di = (t) => anotar(viajeId, FASE, t);

  if (!hayClaveIA()) throw new Error(SIN_CLAVE);

  const auto = configAuto(viaje);
  const { adultos, edadesNinos } = ocupacionDe(viaje);
  const duracionComida = parametro('duracion_comida_min', 90);
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

    const datos = {
      CIUDAD: ciudad,
      RITMO: viaje.ritmo || 'normal',
      VIAJEROS:
        `${adultos} adulto(s)` +
        (edadesNinos.length ? ` y niños de ${edadesNinos.join(' y ')} años` : ''),
      DURACION_COMIDA: duracionComida,
      MAX_LARGAS: maxLargas,
      FRANJAS: FRANJAS.map((f) => `${f.clave} (${f.etiqueta}, ${f.horas})`).join(' · '),
      DIAS: dias
        .map(
          (d) =>
            `- día ${d.n} · ${d.fecha} (${d.diaSemana})\n` +
            (d.fijos.length
              ? d.fijos.map((f) => `  FIJO e intocable: ${f.texto} [franja ${f.franja}]`).join('\n')
              : '  sin nada fijo: día entero disponible')
        )
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
        const pedida = CLAVES_FRANJA.includes(item?.franja) ? item.franja : null;
        const franja = franjaDeLaHora(item?.hora) ?? pedida;
        if (!franja) continue;

        if (topeFranja >= 0 && CLAVES_FRANJA.indexOf(franja) > topeFranja) {
          di(`   Día ${n}: fuera «${item?.ref ?? item?.tipo ?? '?'}», caía después del viaje de vuelta.`);
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
          resumen.push(`comida${item.zona ? ` (${item.zona})` : ''}`);
          continue;
        }

        const pieza = porRef.get(String(item?.ref ?? item?.id ?? '').trim());
        if (!pieza) continue;

        // APUNTARLO ES PARTE DE COLOCARLO. Un sitio generado no es candidato
        // hasta que se decide meterlo en un día; en ese momento se apunta con la
        // misma función del botón y ya se puede colocar.
        const candidatoId =
          pieza.candidatoId ?? (pieza.sitioId ? apuntarYObtener(etapa.id, pieza.sitioId) : null);
        if (!candidatoId) continue;

        colocar(viajeId, { candidatoId, dia: n, franja, hora: item.hora ?? null });
        puestos += 1;
        resumen.push(pieza.nombre);
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
  const final = lienzoDeViaje(viajeId);
  if (final.avisos.length) {
    di(`ATENCIÓN: el lienzo termina con ${final.avisos.length} aviso(s). Eso es un fallo del reparto:`);
    for (const a of final.avisos) di(`   · Día ${a.dia}: ${a.texto}`);
    apuntarHueco(
      viajeId,
      FASE,
      `El lienzo queda con ${final.avisos.length} aviso(s) sin resolver; revísalos en la pantalla.`
    );
  } else {
    di('El lienzo no deja ningún aviso: todo cuadra.');
  }

  di(`${colocadosEnTotal} cosa(s) colocadas en total, ${sinColocarEnTotal} sin colocar a propósito.`);
  return { etapas: etapas.length, colocados: colocadosEnTotal, sinColocar: sinColocarEnTotal };
}

export default { ejecutarFaseLienzo, diasDeLaEtapa, colocablesDeEtapa };
