/**
 * services/orquestador-excursiones.js
 * -----------------------------------------------------------------------------
 * FASE 5 DEL ORQUESTADOR: qué excursiones merecen la pena.
 *
 * Busca con el mismo Civitatis del flujo manual —la misma función, no una copia—
 * y PRESELECCIONA. No coloca nada en días: eso es del lienzo.
 *
 * LA REGLA QUE JUSTIFICA ESTA FASE ES EL SOLAPAMIENTO.
 *
 * La mitad de lo que vende Civitatis en una ciudad es «visitar con guía» algo
 * que ya está en las fichas de sitios: Auschwitz, las minas de sal, la catedral.
 * No son un extra sobre lo que ya se iba a ver: son LA MISMA VISITA contada dos
 * veces. Sin esta fase, el lienzo acabaría poniendo el sitio el martes y la
 * excursión al mismo sitio el jueves.
 *
 * Así que hay que elegir una de las dos, y el criterio no es el precio: es si el
 * sitio se entiende sin que nadie lo cuente. Un campo de concentración o unas
 * minas ganan mucho con un guía; un mirador o un parque, nada. Cuando gana la
 * excursión, el sitio queda marcado con `cubierto_por`, que es la regla hecha
 * dato para que el lienzo no tenga que volver a razonarla.
 *
 * NO ELEGIR NINGUNA ES UNA RESPUESTA. Una ciudad de dos noches donde todo lo que
 * vende Civitatis es un free tour por el casco viejo no tiene ningún hueco que
 * llenar. Eso NO es un hueco de la fase: es una decisión, y se cuenta como tal.
 * Hueco es que la búsqueda falle, que es otra cosa.
 */
import { todas, una, ejecutar } from '../db/index.js';
import { consultarJSON, hayClaveIA, SIN_CLAVE } from '../lib/ia.js';
import { traerExcursionesSiHacenFalta, actividadesDeCiudad } from '../services/catalogo.js';
import { alternarApuntado } from '../services/etapa.js';
import { ocupacionDe } from '../services/proveedores.js';
import { anotar, apuntarHueco, parametro, configAuto } from '../services/orquestador.js';

const FASE = 'excursiones';

export function rellenar(plantilla, datos) {
  return plantilla.replace(/\{\{([A-Z_]+)\}\}/g, (_, clave) => {
    const v = datos[clave];
    return v === undefined || v === null ? '' : String(v);
  });
}

/** "2 horas", "8 h", "Día completo" -> minutos, o null si no se entiende. */
export function duracionEnMinutos(texto) {
  const t = String(texto ?? '').toLowerCase();
  if (/d[ií]a completo|jornada completa|todo el d[ií]a/.test(t)) return 8 * 60;
  const h = t.match(/(\d+(?:[.,]\d+)?)\s*h/);
  if (h) return Math.round(Number(h[1].replace(',', '.')) * 60);
  const m = t.match(/(\d+)\s*min/);
  if (m) return Number(m[1]);
  return null;
}

/** Una excursión es "de día completo" a partir de seis horas. */
const LARGA_DESDE_MIN = 6 * 60;
export const esLarga = (duracion) => (duracionEnMinutos(duracion) ?? 0) >= LARGA_DESDE_MIN;

// =============================================================================
// LA FASE
// =============================================================================
export async function ejecutarFaseExcursiones(viaje, prompt) {
  const viajeId = viaje.id;
  const di = (t) => anotar(viajeId, FASE, t);

  if (!hayClaveIA()) throw new Error(SIN_CLAVE);

  const auto = configAuto(viaje);
  const { adultos, edadesNinos } = ocupacionDe(viaje);
  const maxLargasPorDia = parametro('max_excursiones_largas_por_dia', 1);
  const maxPorViaje = parametro('max_excursiones_por_viaje', 0); // 0 = sin límite

  const etapas = todas(
    "SELECT * FROM etapas WHERE viaje_id = ? AND estado = 'confirmada' ORDER BY orden, id",
    viajeId
  );
  if (!etapas.length) {
    di('El viaje no tiene paradas confirmadas: no hay dónde buscar.');
    return { etapas: 0, elegidas: 0 };
  }

  di(
    `${etapas.length} parada(s). Topes: ${maxLargasPorDia} excursión(es) larga(s) por día` +
      (maxPorViaje ? ` y ${maxPorViaje} en todo el viaje.` : ' y sin tope para el viaje.')
  );

  let elegidasEnTotal = 0;

  for (const etapa of etapas) {
    const ciudad = etapa.nombre_ciudad;

    // --- 1) Buscar, con la misma función del flujo manual ----------------
    di(`Buscando excursiones en ${ciudad}…`);
    let cuantas = 0;
    try {
      const antes = actividadesDeCiudad(ciudad).length;
      cuantas = await traerExcursionesSiHacenFalta(ciudad);
      if (antes) di(`   ${ciudad}: ya existían ${antes} excursiones. No vuelvo a buscar.`);
    } catch (err) {
      // ESTO SÍ ES UN HUECO: la búsqueda ha fallado y no se sabe qué hay.
      apuntarHueco(viajeId, FASE, `${ciudad}: la búsqueda de excursiones falló (${err.message}).`);
      di(`   ${ciudad}: la búsqueda falló (${err.message}). Sigo con la siguiente parada.`);
      continue;
    }

    const disponibles = actividadesDeCiudad(ciudad);
    if (!disponibles.length) {
      // Esto NO es un hueco: es que en esa ciudad no hay nada que ofrecer.
      di(`   ${ciudad}: Civitatis no tiene excursiones. No es un fallo: no hay.`);
      continue;
    }

    // Lo que ya estuviera apuntado a mano se respeta y cuenta para los topes.
    const yaApuntadas = todas(
      "SELECT titulo, url FROM candidatos WHERE etapa_id = ? AND tipo = 'actividad'",
      etapa.id
    );
    if (yaApuntadas.length) {
      di(`   ${ciudad}: ya tenías ${yaApuntadas.length} apuntada(s); las respeto y cuentan para el tope.`);
    }
    const yaPuestas = new Set(yaApuntadas.map((c) => c.url ?? `titulo:${c.titulo}`));

    // --- 2) Preseleccionar -----------------------------------------------
    const sitios = etapa.punto_interes_id
      ? todas(
          `SELECT nombre, categoria, bloque FROM sitios_lugar
            WHERE punto_interes_id = ? AND bloque <> 'busqueda' ORDER BY orden, id`,
          etapa.punto_interes_id
        )
      : [];

    const candidatas = disponibles
      .filter((a) => !yaPuestas.has(a.url ?? `titulo:${a.titulo}`))
      .map((a, i) => ({ ...a, id: `ex${i + 1}` }));

    if (!candidatas.length) {
      di(`   ${ciudad}: todas las excursiones ya estaban apuntadas.`);
      continue;
    }

    const noches = Math.max(0, Number(etapa.noches) || 0);
    const topes =
      `como mucho ${maxLargasPorDia} excursión(es) de día completo por día, y esta parada tiene ` +
      `${noches} noche(s)` +
      (maxPorViaje ? `; en todo el viaje no pueden pasar de ${maxPorViaje}, y ya llevas ${elegidasEnTotal}.` : '.');

    const datos = {
      CIUDAD: ciudad,
      NOCHES: noches,
      RITMO: viaje.ritmo || 'normal',
      VIAJEROS:
        `${adultos} adulto(s)` +
        (edadesNinos.length ? ` y niños de ${edadesNinos.join(' y ')} años` : ''),
      INTERESES:
        [auto.intereses, (auto.categorias ?? []).join(', ')].filter(Boolean).join(' · ') ||
        '(no lo han dicho)',
      TOPES: topes,
      SITIOS: sitios.length
        ? sitios.map((s) => `- ${s.nombre}${s.categoria ? ` (${s.categoria})` : ''}`).join('\n')
        : '(esta parada todavía no tiene fichas de sitios)',
      EXCURSIONES: candidatas
        .map(
          (a) =>
            `- ${a.id} · ${a.titulo}\n` +
            `  duración: ${a.duracion ?? 'no la dice'}` +
            `${esLarga(a.duracion) ? ' (día completo)' : ''}` +
            ` · precio: ${a.precio != null ? `${a.precio} ${a.moneda ?? '€'}` : 'no lo dice'}` +
            `${a.valoracion ? ` · valoración ${a.valoracion}` : ''}` +
            `${a.punto_encuentro ? `\n  punto de encuentro: ${String(a.punto_encuentro).slice(0, 120)}` : ''}` +
            `${a.horarios ? `\n  horarios: ${String(a.horarios).slice(0, 120)}` : ''}`
        )
        .join('\n'),
    };

    let respuesta = null;
    try {
      respuesta = await consultarJSON(rellenar(prompt, datos), {
        maxTokens: 2500,
        paso: `excursiones de ${ciudad}`,
      });
    } catch (err) {
      // SIN IA NO SE PRESELECCIONA, y no se inventa un criterio de emergencia:
      // el valor de esta fase ES el criterio. Las excursiones quedan buscadas y
      // visibles en la pestaña, que es donde estarían sin el orquestador.
      apuntarHueco(
        viajeId,
        FASE,
        `${ciudad}: las excursiones están buscadas pero no pude preseleccionar (${err.message}).`
      );
      di(`   ${ciudad}: no pude preseleccionar (${err.message}). Quedan en la pestaña para que elijas.`);
      continue;
    }

    // --- 3) Aplicar los topes, que son duros -----------------------------
    const pedidas = (Array.isArray(respuesta?.elegidas) ? respuesta.elegidas : [])
      .map((e) => ({
        ...e,
        actividad: candidatas.find((c) => c.id === String(e?.id ?? '').trim()),
      }))
      .filter((e) => e.actividad);

    const topeLargas = Math.max(0, maxLargasPorDia * Math.max(noches, 1));
    const elegidas = [];
    let largas = 0;

    for (const e of pedidas) {
      if (maxPorViaje && elegidasEnTotal + elegidas.length >= maxPorViaje) {
        di(`   Tope del viaje (${maxPorViaje}): dejo fuera «${e.actividad.titulo}».`);
        continue;
      }
      if (esLarga(e.actividad.duracion)) {
        if (largas >= topeLargas) {
          di(`   Tope de largas (${topeLargas} en ${noches} noche(s)): dejo fuera «${e.actividad.titulo}».`);
          continue;
        }
        largas += 1;
      }
      elegidas.push(e);
    }

    // --- 4) Guardar, con la misma función del botón «Me lo apunto» -------
    const cubiertos = [];
    for (const e of elegidas) {
      alternarApuntado(etapa.id, 'actividad', e.actividad.id);

      // El solapamiento, hecho dato: el sitio que cubre esta excursión queda
      // marcado para que el lienzo no programe los dos.
      const candidato = una(
        `SELECT id FROM candidatos
          WHERE etapa_id = ? AND tipo = 'actividad' AND titulo = ? ORDER BY id DESC LIMIT 1`,
        etapa.id,
        e.actividad.titulo
      );
      for (const nombre of Array.isArray(e.cubre_sitios) ? e.cubre_sitios : []) {
        const sitio = una(
          `SELECT id, nombre FROM sitios_lugar
            WHERE punto_interes_id = ? AND lower(nombre) = lower(?)`,
          etapa.punto_interes_id,
          String(nombre).trim()
        );
        if (sitio && candidato) {
          ejecutar('UPDATE sitios_lugar SET cubierto_por = ? WHERE id = ?', candidato.id, sitio.id);
          cubiertos.push(`${sitio.nombre} (lo cubre «${e.actividad.titulo}»)`);
        }
      }
    }

    elegidasEnTotal += elegidas.length;

    const descartadas = (Array.isArray(respuesta?.descartadas) ? respuesta.descartadas : [])
      .map((d) => ({ ...d, actividad: candidatas.find((c) => c.id === String(d?.id ?? '').trim()) }))
      .filter((d) => d.actividad);

    di(
      `${ciudad}: elegidas ${elegidas.length}` +
        (elegidas.length ? ` (${elegidas.map((e) => e.actividad.titulo).join(', ')})` : '') +
        `, descartadas ${descartadas.length} de ${candidatas.length} miradas.`
    );
    for (const e of elegidas) if (e.por_que) di(`   ✔ ${e.actividad.titulo}: ${e.por_que}`);
    for (const d of descartadas) if (d.por_que) di(`   ✘ ${d.actividad.titulo}: ${d.por_que}`);
    for (const c of cubiertos) di(`   Ya no hace falta ir por libre a ${c}.`);
    if (!elegidas.length) {
      di(`   En ${ciudad} no hay ninguna que aporte sobre lo que ya vais a ver. No es un hueco: es la decisión.`);
    }
  }

  di(`${elegidasEnTotal} excursión(es) preseleccionada(s) en todo el viaje.`);
  return { etapas: etapas.length, elegidas: elegidasEnTotal };
}

export default { ejecutarFaseExcursiones, duracionEnMinutos, esLarga };
