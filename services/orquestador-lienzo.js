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
 * Lo que se puede colocar en una etapa.
 *
 * Se dejan fuera dos cosas y por motivos distintos: lo que ya está en el lienzo
 * —porque colocarlo otra vez sería moverlo— y los sitios cubiertos por una
 * excursión, que la fase 5 marcó para que no se programe dos veces la misma
 * visita.
 */
export function colocablesDeEtapa(etapa, lienzo) {
  const yaColocados = new Set(lienzo.colocados.map((c) => c.candidatoId).filter(Boolean));

  const candidatos = todas(
    `SELECT * FROM candidatos
      WHERE etapa_id = ? AND tipo IN ('sitio', 'actividad') AND marcado = 1`,
    etapa.id
  ).filter((c) => !yaColocados.has(c.id));

  return candidatos.map((c) => {
    // El sitio del catálogo del que sale la tarjeta, que es quien tiene los
    // horarios y el tiempo de visita.
    const sitio = c.url
      ? una('SELECT * FROM sitios_lugar WHERE wikipedia_url = ? OR nombre = ?', c.url, c.titulo)
      : una('SELECT * FROM sitios_lugar WHERE nombre = ?', c.titulo);

    const datos = sitio ? datosDeSitio(sitio) : null;
    const cierres = sitio ? diasDeCierre(sitio.cierra_dias) : [];

    return {
      candidatoId: c.id,
      tipo: c.tipo,
      nombre: c.titulo,
      categoria: sitio?.categoria ?? null,
      // Una excursión trae hora de encuentro; un sitio, no.
      hora: c.tipo === 'actividad' ? null : null,
      duracion: c.duracion ?? datos?.tiempoVisita ?? null,
      horarios: datos?.horarios ?? null,
      precio: datos?.precio ?? null,
      cierraDias: cierres,
      cierraTexto: cierres.length ? cierres.map((d) => DIAS_SEMANA[d]).join(' y ') : null,
    };
  });
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

    const piezas = colocablesDeEtapa(etapa, lienzo);
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
            `- ${p.tipo === 'actividad' ? 'EXCURSIÓN' : 'sitio'} #${p.candidatoId} · ${p.nombre}` +
            `${p.categoria ? ` (${p.categoria})` : ''}\n` +
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
    const porId = new Map(piezas.map((p) => [p.candidatoId, p]));
    let puestos = 0;

    for (const d of plan.dias) {
      const n = Number(d?.dia);
      if (!dias.some((x) => x.n === n)) continue;

      const resumen = [];

      for (const item of Array.isArray(d?.plan) ? d.plan : []) {
        const franja = CLAVES_FRANJA.includes(item?.franja) ? item.franja : null;
        if (!franja) continue;

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

        const pieza = porId.get(Number(item?.id));
        if (!pieza) continue;

        colocar(viajeId, {
          candidatoId: pieza.candidatoId,
          dia: n,
          franja,
          hora: item.hora ?? null,
        });
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
      const pieza = porId.get(Number(f?.id));
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
