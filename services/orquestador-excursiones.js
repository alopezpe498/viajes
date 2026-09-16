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
import { todas, una, ejecutar, normalizarNombre } from '../db/index.js';
import { horaDeInicioDeExcursion, hayRecogidaEnHotel } from './horarios.js';
import { consultarJSON, hayClaveIA, SIN_CLAVE } from '../lib/ia.js';
import {
  traerExcursionesSiHacenFalta,
  actividadesDeCiudad,
  asegurarFichaDeActividad,
} from '../services/catalogo.js';
import { alternarApuntado } from '../services/etapa.js';
import { ocupacionDe } from '../services/proveedores.js';
import { anotar, apuntarHueco, parametro, configAuto, ORIGENES } from '../services/orquestador.js';
import { lienzoDeViaje } from '../services/lienzo.js';
import { hayQueParar } from '../services/orquestador-parada.js';
import { porParada, esperarAviso, avisoDeSitios } from '../services/paralelo.js';
import { direccionDe, situarActividadConPlaces } from '../services/direcciones.js';
import { distanciaKm } from '../services/distancias.js';
import { fueraDeTemporada, mesesDelViaje } from '../services/temporadas.js';
import { enFase } from '../services/fase-actual.js';
import { enParada } from '../services/cronometro.js';

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

/**
 * CUÁNTOS DÍAS DE ESTA PARADA ADMITEN UNA EXCURSIÓN LARGA.
 *
 * No son las noches. Una parada de tres noches puede tener UN solo día libre: el
 * de llegada se va en el vuelo y el hotel, el de salida en el traslado a la
 * siguiente ciudad, y en medio queda uno. Contar noches y elegir excursiones por
 * ese número es lo que llenó Atenas de tres excursiones de jornada completa
 * cuando solo cabía una.
 *
 * Se cuentan los días de la etapa a los que NO se les ha comido ya el día un
 * bloque fijo —la llegada, el salto a la siguiente ciudad, el vuelo de vuelta—.
 * Los fijos ya están decididos cuando corre esta fase: los puso la fase 2.
 *
 * Devuelve null cuando todavía no hay lienzo del que sacarlo; quien llama decide
 * qué hacer con eso, y lo que hace es no prometer un número que no sabe.
 */
export function diasUtilesDeEtapa(viajeId, etapaId) {
  const lienzo = lienzoDeViaje(viajeId);
  if (!lienzo?.dias?.length) return null;

  const suyos = lienzo.dias.filter((d) => d.etapaId === etapaId).map((d) => d.n);
  if (!suyos.length) return null;

  const ocupados = new Set(
    (lienzo.fijos ?? [])
      .filter((f) => suyos.includes(f.dia))
      .map((f) => f.dia)
  );

  return { total: suyos.length, libres: suyos.filter((n) => !ocupados.has(n)).length };
}

/** Una excursión es "de día completo" a partir de seis horas. */
const LARGA_DESDE_MIN = 6 * 60;
export const esLarga = (duracion) => (duracionEnMinutos(duracion) ?? 0) >= LARGA_DESDE_MIN;

// =============================================================================
// LA FASE
// =============================================================================
export async function ejecutarFaseExcursiones(viaje, prompt) {
  const viajeId = viaje.id;
  const di = (t, origen = null) => anotar(viajeId, FASE, t, origen);

  if (!hayClaveIA()) throw new Error(SIN_CLAVE);

  const auto = configAuto(viaje);
  const { adultos, edadesNinos } = ocupacionDe(viaje);
  const maxLargasPorDia = parametro('max_excursiones_largas_por_dia', 1);
  const maxPorViaje = parametro('max_excursiones_por_viaje', 0); // 0 = sin límite

  // CUÁNTO SE ESPERA A LOS SITIOS DE UNA CIUDAD ANTES DE SEGUIR SIN ELLOS.
  //
  // El número sale de lo medido, no de la intuición: en el viaje 60 los sitios
  // de una ciudad tuvieron nombres y coordenadas a los 45 s (Atenas) y 53 s
  // (Santorini) de arrancar la fase, y la ciudad entera tardó 1m 35s. Cuatro
  // minutos son 4,5 veces lo primero y 2,5 veces lo segundo.
  //
  // El margen de sobra es para los viajes de muchas paradas, donde una ciudad de
  // la tercera tanda empieza tarde. Aun así no se descontrola: una parada de
  // esta fase esperando ocupa su plaza, así que esta fase no puede adelantarse a
  // la de sitios más de una tanda. Y cuando el aviso llega, esperar no cuesta
  // nada, así que pasarse por arriba es más barato que quedarse corto.
  const esperaSitiosSeg = parametro('espera_sitios_excursiones_seg', 240);

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

  // Los meses que toca el viaje, para la comprobación de temporada.
  const mesesDelDestino = mesesDelViaje(viaje.fecha_inicio, viaje.fecha_fin);

  // LO QUE YA SE HA COGIDO EN OTRAS PARADAS, para no repetir la experiencia.
  //
  // El concierto de Chopin acabó colocado en Cracovia Y en Varsovia: dos
  // entradas distintas del catálogo, la misma noche de piano. Se guardan los
  // títulos ya elegidos en el viaje —con su ciudad— y se comparan por parecido.
  const yaEnElViaje = [];

  // AQUÍ LAS PARADAS NO SON DEL TODO INDEPENDIENTES, y hay que decirlo.
  //
  // Las otras dos fases con paradas se paralelizan enteras porque cada ciudad se
  // resuelve sola. Esta tiene un tope para TODO el viaje
  // (`max_excursiones_por_viaje`) que se consulta dentro del bucle: cada parada
  // necesita saber cuántas llevan elegidas las anteriores. Con tres corriendo a
  // la vez, las tres leerían el mismo contador antes de que ninguna lo subiera y
  // el tope se pasaría de largo.
  //
  // Repartir la cuota por adelantado lo arreglaría, pero eso ya es cambiar la
  // lógica, y el encargo dice que no. Así que: si hay tope, se va en fila como
  // hasta ahora; si no lo hay —que es lo de fábrica, 0 = sin límite— las paradas
  // van a la vez. Cuando el tope importa, se dice en el registro por qué se
  // tarda más.
  const aLaVez = maxPorViaje ? 1 : Math.max(1, parametro('concurrencia_paradas', 3));
  if (maxPorViaje) {
    di(
      `Hay tope de ${maxPorViaje} excursión(es) para todo el viaje, así que las paradas ` +
        'van de una en una: cada una necesita saber lo que llevan las anteriores.',
      ORIGENES.ninguno
    );
  }

  const { resultados } = await porParada(
    etapas,
    {
      limite: aLaVez,
      nombreDe: (e) => e.nombre_ciudad,
      hayQueParar: (ciudad) => hayQueParar(viajeId, FASE, ciudad),
      enFase: (fn) => enFase(viajeId, FASE, fn),
      enParada,
      di: (t) => di(t, ORIGENES.ninguno),
    },
    async (etapa, ciudad) => {

      // --- 1) Buscar, con la misma función del flujo manual ----------------
      di(`Buscando excursiones en ${ciudad}…`);
      let cuantas = 0;
      try {
        const antes = actividadesDeCiudad(ciudad).length;
        // Con el país y la ciudad base delante: sin ellos, una parada cuyo
        // nombre no coincide con su slug se queda sin excursiones y parece que
        // Civitatis no tiene nada, cuando lo que no teníamos era la dirección.
        const punto = etapa.punto_interes_id
          ? una('SELECT ciudad_base, destino_id FROM puntos_interes WHERE id = ?', etapa.punto_interes_id)
          : null;
        const suDestino = punto?.destino_id
          ? una('SELECT pais, nombre FROM destinos WHERE id = ?', punto.destino_id)
          : null;

        cuantas = await traerExcursionesSiHacenFalta(ciudad, {
          pais: suDestino?.pais ?? suDestino?.nombre ?? viaje.destino ?? null,
          ciudadBase: punto?.ciudad_base ?? null,
        });
        if (antes) di(`   ${ciudad}: ya existían ${antes} excursiones. No vuelvo a buscar.`);
      } catch (err) {
        // ESTO SÍ ES UN HUECO: la búsqueda ha fallado y no se sabe qué hay.
        apuntarHueco(viajeId, FASE, `${ciudad}: la búsqueda de excursiones falló (${err.message}).`);
        di(`   ${ciudad}: la búsqueda falló (${err.message}). Sigo con la siguiente parada.`);
        return { guardadas: 0 };
      }

      const disponibles = actividadesDeCiudad(ciudad);
      if (!disponibles.length) {
        // Esto NO es un hueco: es que en esa ciudad no hay nada que ofrecer.
        di(`   ${ciudad}: Civitatis no tiene excursiones. No es un fallo: no hay.`);
        return { guardadas: 0 };
      }

      // Lo que ya estuviera apuntado a mano se respeta y cuenta para los topes.
      const yaApuntadas = todas(
        "SELECT titulo, url, datos_extra FROM candidatos WHERE etapa_id = ? AND tipo = 'actividad'",
        etapa.id
      );
      if (yaApuntadas.length) {
        di(`   ${ciudad}: ya tenías ${yaApuntadas.length} apuntada(s); las respeto y cuentan para el tope.`);
      }
      // POR IDENTIDAD Y, DE PROPINA, POR TEXTO. La identidad es la buena: la
      // pareja (tabla, id) que guarda el candidato. El texto se conserva para los
      // candidatos viejos que se apuntaron antes de que existiera `datos_extra`.
      const yaPuestas = new Set();
      for (const c of yaApuntadas) {
        yaPuestas.add(c.url ?? `titulo:${c.titulo}`);
        try {
          const extra = c.datos_extra ? JSON.parse(c.datos_extra) : null;
          if (extra?.de === 'actividad' && extra.deId != null) {
            yaPuestas.add(`actividad:${Number(extra.deId)}`);
          }
        } catch {
          /* datos_extra roto: se queda con el respaldo por texto */
        }
      }

      // --- 2) Preseleccionar -----------------------------------------------

      // ANTES DE PREGUNTARLE A LA IA, ESPERAR A QUE ESTA CIUDAD TENGA SUS SITIOS.
      //
      // EL FALLO QUE ORIGINA ESTO. Esta fase y la de «Qué ver» arrancan en el
      // mismo segundo. En Santorini, la lista de sitios se leyó VACÍA porque la
      // otra fase la escribió un segundo después, y con ella vacía la IA eligió
      // las excursiones a ciegas: sin saber que Akrotiri ya estaba entre lo que
      // el viaje iba a ver, eligió la entrada al yacimiento como si fuera un
      // extra. Todo lo que vino detrás —la fusión que no fundió nada, el
      // `cubre_sitios` vacío, la excursión expulsada en el lienzo por solaparse
      // consigo misma— sale de esta lista. En Atenas la carrera se ganó por
      // cuatro segundos, que es peor todavía: el fallo aparece o no según quién
      // llegue antes.
      //
      // LA ESPERA VA AQUÍ Y NO EN LA FUSIÓN. Poniéndola solo al fundir se
      // arreglaría el síntoma pequeño y la IA seguiría eligiendo a ciegas, que
      // es el daño grande. El solapamiento es LA regla que justifica esta fase
      // entera: sin la lista delante no se está aplicando.
      //
      // Y ESPERA SOLO ESTA CIUDAD. No se ponen las fases en fila —medido, cuesta
      // 1m 23s—: se espera el aviso de ESTE punto de interés. Las otras paradas
      // y la fase de dormir siguen corriendo. Y como el aviso se da en cuanto
      // los sitios tienen nombre y coordenada, sin esperar a sus precios y
      // horarios, la espera cae dentro del tiempo que la otra fase iba a gastar
      // igualmente.
      if (etapa.punto_interes_id) {
        const desde = Date.now();
        const como = await esperarAviso(avisoDeSitios(viajeId, etapa.punto_interes_id), {
          segundos: esperaSitiosSeg,
        });
        const seg = Math.round((Date.now() - desde) / 1000);
        if (como === 'aviso') {
          di(`   ${ciudad}: esperé ${seg}s a que sus sitios estuvieran listos. Ya los tengo.`, ORIGENES.ninguno);
        } else if (como === 'plazo') {
          // NO SE CONGELA, PERO SE DICE. Si los sitios de esta ciudad no llegan,
          // se sigue con lo que haya —que es como se trabajaba hasta ahora— y
          // queda escrito que la elección se hizo sin ellos.
          di(
            `   ${ciudad}: los sitios de esta parada no llegaron en ${esperaSitiosSeg}s. ` +
              'Sigo sin ellos: la elección de excursiones no podrá mirar el solapamiento.'
          );
        }
      }

      const sitios = etapa.punto_interes_id
        ? todas(
            `SELECT nombre, categoria, bloque FROM sitios_lugar
              WHERE punto_interes_id = ? AND bloque <> 'busqueda' ORDER BY orden, id`,
            etapa.punto_interes_id
          )
        : [];

      // LA ETIQUETA DEL PROMPT VA EN SU PROPIO CAMPO, NO ENCIMA DEL ID.
      //
      // Aquí estuvo el fallo que dejó la fase entera trabajando en vano. A la IA
      // se le dan las excursiones numeradas «ex1, ex2…» para que pueda
      // referirse a ellas, y eso se hacía escribiendo `id: 'ex7'` ENCIMA del id
      // real de `catalogo_actividades`. Luego, al guardar, `alternarApuntado`
      // buscaba la fila 'ex7' del catálogo, no la encontraba y devolvía null sin
      // decir nada: el registro contaba las elegidas, la pantalla no pintaba
      // ninguna y el lienzo nunca colocó una excursión en ningún viaje.
      //
      // La etiqueta ahora es `ref` y el id sigue siendo el id.
      const candidatas = disponibles
        .filter(
          (a) =>
            !yaPuestas.has(`actividad:${Number(a.id)}`) &&
            !yaPuestas.has(a.url ?? `titulo:${a.titulo}`)
        )
        .map((a, i) => ({ ...a, ref: `ex${i + 1}` }));

      if (!candidatas.length) {
        di(`   ${ciudad}: todas las excursiones ya estaban apuntadas.`);
        return { guardadas: 0 };
      }

      const noches = Math.max(0, Number(etapa.noches) || 0);

      // LOS DÍAS LIBRES DE VERDAD, antes de elegir nada. Va al registro porque es
      // el número que explica por qué se eligieron una o tres.
      const utiles = diasUtilesDeEtapa(viajeId, etapa.id);
      if (utiles) {
        di(
          `   ${ciudad}: ${utiles.total} día(s) de parada, ${utiles.libres} con hueco para una ` +
            'excursión larga (los demás se los comen la llegada, la salida o el traslado).'
        );
      }

      // Y EL TOPE DE LARGAS SALE DE AHÍ, no de las noches. Antes era «las que
      // quepan en las noches», que es otra cosa: en Atenas daban tres y solo había
      // un día libre. Si no se sabe, se conserva el criterio viejo.
      const topeLargasReal =
        utiles != null
          ? Math.min(maxLargasPorDia * Math.max(utiles.libres, 0), Math.max(utiles.libres, 0))
          : null;

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
        DIAS_UTILES: utiles == null ? 'no lo sé' : String(utiles.libres),
        SITIOS: sitios.length
          ? sitios.map((s) => `- ${s.nombre}${s.categoria ? ` (${s.categoria})` : ''}`).join('\n')
          : '(esta parada todavía no tiene fichas de sitios)',
        EXCURSIONES: candidatas
          .map(
            (a) =>
              `- ${a.ref} · ${a.titulo}\n` +
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
        return { guardadas: 0 };
      }

      // --- 3) Aplicar los topes, que son duros -----------------------------
      const pedidas = (Array.isArray(respuesta?.elegidas) ? respuesta.elegidas : [])
        .map((e) => ({
          ...e,
          // La IA contesta con la etiqueta («ex7»), no con el id del catálogo.
          actividad: candidatas.find((c) => c.ref === String(e?.id ?? '').trim()),
        }))
        .filter((e) => e.actividad);

      // El tope que se hace cumplir en código, no solo en el prompt: si la IA pide
      // tres excursiones de jornada y solo hay un día libre, entran las que caben.
      const topeLargas =
        topeLargasReal != null
          ? topeLargasReal
          : Math.max(0, maxLargasPorDia * Math.max(noches, 1));
      const elegidas = [];
      let largas = 0;

      for (const e of pedidas) {
        if (maxPorViaje && elegidasEnTotal + elegidas.length >= maxPorViaje) {
          di(`   Tope del viaje (${maxPorViaje}): dejo fuera «${e.actividad.titulo}».`);
          return { guardadas: 0 };
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
      //
      // Y COMPROBANDO QUE SE HA GUARDADO. `alternarApuntado` devuelve null cuando
      // no encuentra el origen, y ese null en silencio es exactamente lo que
      // permitió que esta fase pareciera funcionar durante meses. Ahora, si una
      // no entra, se dice en el registro y se apunta como hueco.
      const cubiertos = [];
      const guardadas = [];
      // El candidato de una excursión, por su IDENTIDAD: la misma pareja
      // (tabla, id) con la que la pestaña decide qué pintar como apuntado. Si
      // esto lo encuentra, la pantalla también.
      const candidatoDe = (actividadId) =>
        una(
          `SELECT id FROM candidatos
            WHERE etapa_id = ? AND tipo = 'actividad'
              AND datos_extra LIKE ? ORDER BY id DESC LIMIT 1`,
          etapa.id,
          `%"deId":${Number(actividadId)}%`
        );

      for (const e of elegidas) {
        // --- FUERA DE TEMPORADA -------------------------------------------
        //
        // «Zakopane + paseo en moto de nieve» para un viaje del 21 al 27 de
        // septiembre. En los Tatras, en septiembre, no hay nieve: o no opera o
        // opera sin la moto, que es la mitad de por qué la eliges.
        // La descripción larga YA NO ENTRA: es la página de Civitatis scrapeada
        // entera, con reseñas y nombres propios dentro, y buscar ahí palabras
        // clave es buscar en el ruido. «Ana Belén» descartó Auschwitz por
        // navideña. El título sí, y la ficha manda sobre todo lo demás.
        const temporada = fueraDeTemporada({
          titulo: e.actividad.titulo,
          fechasPropias: e.actividad.detalles_extra ?? e.actividad.horarios ?? '',
          meses: mesesDelDestino,
        });

        if (temporada?.duro) {
          di(
            `   ✘ «${e.actividad.titulo}»: fuera de temporada (${temporada.que}: ` +
              `${temporada.porQue}; va de ${temporada.meses.join(', ')} y vas en ` +
              `${mesesDelDestino.join(', ')}). La descarto.`,
            ORIGENES.ninguno
          );
          continue;
        }

        // --- MISMA EXPERIENCIA EN OTRA PARADA ------------------------------
        const gemela = yaEnElViaje.find((x) => seParecen(x.titulo, e.actividad.titulo));
        if (gemela) {
          di(
            `   ✘ «${e.actividad.titulo}»: equivalente ya incluida en ${gemela.ciudad} ` +
              `(«${gemela.titulo}»). La descarto.`,
            ORIGENES.ninguno
          );
          continue;
        }

        // `alternarApuntado` ALTERNA: si la excursión ya estuviera apuntada, esa
        // llamada la DESAPUNTARÍA y se llevaría por delante su sitio en el
        // lienzo. Hoy no puede pasar —las ya apuntadas se filtran antes de
        // ofrecérselas a la IA—, pero la fase no puede depender de ese detalle
        // de otro sitio: si ya está, no se toca.
        if (!candidatoDe(e.actividad.id)) {
          alternarApuntado(etapa.id, 'actividad', e.actividad.id);
        }

        const candidato = candidatoDe(e.actividad.id);

        if (!candidato) {
          apuntarHueco(
            viajeId,
            FASE,
            `${ciudad}: «${e.actividad.titulo}» se eligió pero no se pudo guardar como candidata.`
          );
          di(`   ✘ «${e.actividad.titulo}» NO se pudo guardar como candidata.`, ORIGENES.ninguno);
          return { guardadas: 0 };
        }

        guardadas.push(e);
        yaEnElViaje.push({ titulo: e.actividad.titulo, ciudad });

        // LA FICHA PROFUNDA, AHORA QUE SABEMOS QUE ESTA ENTRA.
        //
        // Hasta aquí solo se tenía lo del listado: título, precio, nota y
        // duración. El itinerario —y con él la hora a la que pasan a buscarte—
        // vive en la ficha completa, y esa solo se pedía cuando alguien pulsaba
        // «Ver detalles». Para la fase 6 eso llegaba tarde: colocaba la
        // excursión sin la hora y el modelo se la inventaba. Dougga quedó a las
        // 07:30 y su ficha dice «sobre las 8:00 horas».
        //
        // SOLO DE LAS ELEGIDAS, y por eso va aquí dentro y no arriba: una ciudad
        // ofrece treinta excursiones y entran una o dos. Treinta fichas serían
        // treinta visitas a Civitatis para tirar veintiocho.
        //
        // Y si ya estaba descargada no cuesta nada: `asegurarFichaDeActividad`
        // mira `detalles_en` antes de abrir el navegador.
        const conFicha = await asegurarFichaDeActividad(e.actividad.id);
        const horaOficial = horaDeInicioDeExcursion(
          conFicha?.horarios,
          conFicha?.descripcion_larga
        );
        if (horaOficial) {
          di(
            `   «${e.actividad.titulo}»: Civitatis publica salida a las ${horaOficial}` +
              `${hayRecogidaEnHotel(conFicha?.incluye, conFicha?.descripcion_larga) ? ', con recogida en el hotel' : ''}.`,
            ORIGENES.scraping
          );
        }

        // Y si la temporada era dudosa —no motivo para tirarla, pero tampoco
        // para fiarse— se dice aquí, que es donde se lee antes de reservar.
        if (temporada && !temporada.duro) {
          di(
            `   ⚠ «${e.actividad.titulo}»: verifica disponibilidad en tus fechas ` +
              `(${temporada.que}: ${temporada.porQue}).`,
            ORIGENES.ninguno
          );
          apuntarHueco(
            viajeId,
            FASE,
            `${ciudad}: «${e.actividad.titulo}» puede no operar en tus fechas (${temporada.que}).`
          );
        }

        di(
          `   Excursión «${e.actividad.titulo}» guardada como candidata de ${ciudad} ` +
            `(candidato #${candidato.id}, catálogo #${e.actividad.id}).`,
          ORIGENES.scraping
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
          } else {
            // ESTO NO PUEDE SEGUIR SIENDO MUDO. Este casado es por igualdad
            // exacta de nombre, así que falla en cuanto la IA escribe «Acrópolis
            // de Atenas» donde la ficha dice «Acrópolis». Fallar es aceptable;
            // fallar sin dejar rastro es lo que hizo falta dos diagnósticos para
            // ver que aquí no pasaba nada de nada.
            di(
              `   «${e.actividad.titulo}» dice cubrir «${String(nombre).trim()}», ` +
                'pero no hay ningún sitio con ese nombre en esta parada.',
              ORIGENES.ninguno
            );
          }
        }

        // Y LO QUE LA IA NO DIJO PERO EL TÍTULO CANTA.
        //
        // EL FALLO QUE ORIGINA ESTO. En Santorini, el día 3, «Entrada al
        // yacimiento arqueológico de Akrotiri» y «Akrotiri» se solaparon, y la
        // excursión acabó expulsada «por ser de menor nivel». Son la MISMA
        // visita: la entrada al yacimiento es visitar Akrotiri. El sistema las
        // tenía como dos cosas y las hizo competir entre sí por un hueco.
        //
        // El mecanismo de tapar ya existía y es el de arriba, pero casa por
        // IGUALDAD EXACTA de nombre: solo funciona si la IA acierta a devolver
        // «Akrotiri» clavado en `cubre_sitios`. Cuando no lo pone —y aquí no lo
        // puso— nadie más lo mira.
        //
        // Esto lo mira en código, que es donde va lo comprobable: si el nombre
        // del sitio aparece ENTERO dentro del título de la excursión, es que la
        // excursión va a ese sitio.
        //
        // CON SU SALVAGUARDA DE DISTANCIA, la misma que usa `contenidos.js`: si
        // los dos tienen coordenadas y están a más de 200 m, no se fundan. Sin
        // ella, «Akrotiri» se tragaría al «Faro de Akrotiri», que está a cuatro
        // kilómetros y es otra visita. Ante la duda no se funde, como siempre.
        if (candidato) {
          await cubrirSitiosQueSonElMismoLugar(e.actividad, candidato, etapa, cubiertos);
        }
      }

      // Cuentan las GUARDADAS, no las elegidas: el tope del viaje tiene que
      // hablar de lo que existe en la base, no de lo que se pensó.
      elegidasEnTotal += guardadas.length;
      return { guardadas: guardadas.length };
    }
  );

  // UN FALLO EN UNA CIUDAD NO SE TRAGA NI SE LLEVA A LAS DEMÁS.
  for (const [k, r] of resultados.entries()) {
    if (!r?.error) continue;
    const cual = etapas[k]?.nombre_ciudad ?? `parada ${k + 1}`;
    di(`${cual}: no se pudo (${r.error.message}).`);
    apuntarHueco(viajeId, FASE, `${cual}: ${r.error.message}`);
  }

  di(`${elegidasEnTotal} excursión(es) preseleccionada(s) en todo el viaje.`);
  return { etapas: etapas.length, elegidas: elegidasEnTotal };
}

/**
 * AVISA DE LAS CANDIDATAS DE PESO QUE SE HAN QUEDADO FUERA DEL VIAJE.
 *
 * En Grecia, Meteora —peso 4, monasterios colgados de una roca— se cayó de la
 * ruta por la regla de las dos noches, se evaluó como excursión de trece horas
 * desde Tesalónica y se descartó con razón. Las dos decisiones eran defendibles;
 * el problema es que, sumadas, dejaron fuera del viaje lo más espectacular del
 * país sin que nadie lo dijera.
 *
 * Esto NO cambia ninguna decisión. Solo impide que el resultado sea invisible:
 * si te interesa, ya sabes que existe y que hace falta una noche o cambiar la
 * ruta para verlo.
 */
function avisarDeLasQueSeCayeron(viaje, di) {
  const pesoMinimo = parametro('peso_minimo_aviso_candidata', 4);

  let guardadas = null;
  try {
    guardadas = viaje.ciudades_candidatas ? JSON.parse(viaje.ciudades_candidatas) : null;
  } catch {
    return; // sin la lista no hay nada que comparar
  }
  const descartadas = (guardadas?.descartadas ?? []).filter((c) => (Number(c.peso) || 0) >= pesoMinimo);
  if (!descartadas.length) return;

  // Lo que sí está en el viaje: las paradas y lo que cubren las excursiones ya
  // preseleccionadas. Si el nombre aparece en cualquiera de las dos, no se ha
  // perdido nada.
  const enLaRuta = todas(
    "SELECT nombre_ciudad FROM etapas WHERE viaje_id = ? AND estado = 'confirmada'",
    viaje.id
  ).map((e) => normalizarNombre(e.nombre_ciudad));

  const enExcursiones = todas(
    "SELECT titulo FROM candidatos WHERE viaje_id = ? AND tipo = 'actividad' AND marcado = 1",
    viaje.id
  ).map((c) => normalizarNombre(c.titulo ?? ''));

  ejecutar("DELETE FROM avisos WHERE viaje_id = ? AND categoria = 'candidata'", viaje.id);

  for (const c of descartadas) {
    const suyo = normalizarNombre(c.nombre ?? '');
    if (!suyo) continue;
    if (enLaRuta.some((n) => n.includes(suyo) || suyo.includes(n))) continue;
    if (enExcursiones.some((t) => t.includes(suyo))) continue;

    ejecutar(
      `INSERT INTO avisos (viaje_id, categoria, severidad, titulo, texto)
       VALUES (?, 'candidata', 'info', ?, ?)`,
      viaje.id,
      `${c.nombre} (peso ${c.peso}) ha quedado fuera del viaje`,
      'No da para parada porque no llega al mínimo de noches, y no hay ninguna excursión ' +
        'viable desde tu ruta que lo cubra. Si te interesa, valora añadirle una noche a mano ' +
        'o cambiar la ruta para pasar por allí.'
    );

    di(
      `Aviso para el viaje: ${c.nombre} (peso ${c.peso}) se queda fuera —ni parada ni excursión—.`
    );
  }
}

/**
 * ¿SON LA MISMA EXPERIENCIA DOS TÍTULOS DE CATÁLOGO?
 *
 * El concierto de Chopin en Cracovia y el de Varsovia son entradas distintas,
 * con su id y su precio, y para el catálogo no tienen nada que ver. Para quien
 * viaja son la misma noche dos veces.
 *
 * Se comparan las palabras con peso —fuera las de relleno y los nombres de
 * ciudad, que son justo lo que las diferencia— y se pide que compartan la mayor
 * parte. No es semántica: es que «concierto» y «chopin» estén en los dos.
 */
const RELLENO = new Set([
  'de', 'del', 'la', 'el', 'los', 'las', 'en', 'y', 'a', 'con', 'por', 'para',
  'un', 'una', 'al', 'tour', 'visita', 'entrada', 'entradas', 'excursion',
  'guiada', 'guiado', 'free', 'ticket', 'tickets',
]);

export function seParecen(a, b) {
  const palabras = (t) =>
    new Set(
      String(t ?? '')
        .toLowerCase()
        .normalize('NFD')
        .replace(/[\u0300-\u036f]/g, '')
        .split(/[^a-z0-9]+/)
        .filter((x) => x.length > 2 && !RELLENO.has(x))
    );

  const x = palabras(a);
  const y = palabras(b);
  if (x.size < 1 || y.size < 1) return false;

  const comunes = [...x].filter((p) => y.has(p)).length;
  // Sobre la lista MÁS CORTA: «Concierto de Chopin» y «Concierto de Chopin en la
  // Sala de Conciertos de Varsovia» son lo mismo aunque la segunda diga más.
  return comunes / Math.min(x.size, y.size) >= 0.6;
}

export default { ejecutarFaseExcursiones, duracionEnMinutos, esLarga };

/**
 * LOS SITIOS QUE SON EL MISMO LUGAR QUE LA EXCURSIÓN.
 *
 * Complementa a `cubre_sitios`, que lo dice la IA y casa por igualdad exacta.
 *
 * POR QUÉ LA VERSIÓN ANTERIOR NO LLEGÓ A AKROTIRI. Pedía que el nombre del sitio
 * apareciera ENTERO dentro del título de la excursión, y en Santorini los dos se
 * llaman así:
 *
 *     excursión: «Entrada al yacimiento arqueológico de Akrotiri»
 *     sitio:     «Acrópolis de Akrotiri»
 *
 * Ninguno contiene al otro. Solo comparten la palabra «akrotiri», y fundir por
 * una palabra suelta es como se acaba tapando el Museo de Atenas con un tour por
 * Atenas. Por nombre, este caso no se puede resolver sin abrir la puerta a
 * errores peores.
 *
 * SE RESUELVE POR COORDENADA, QUE ES UN HECHO Y NO UN PARECIDO. Se busca la
 * excursión por su nombre en Places —lo mismo que hace el mapa del viaje, la
 * misma función y la misma caché, una vez en la vida de cada excursión— y se
 * compara dónde cae:
 *
 *     «Entrada al yacimiento arqueológico de Akrotiri»  →  36.3518, 25.4034
 *     «Acrópolis de Akrotiri»                           →  36.3518, 25.4034
 *
 * El mismo punto. Y la de al lado, «Excursión a Akrotiri, playa Roja y Oia»,
 * cae a cinco kilómetros: comparte la palabra pero NO es el mismo sitio, y por
 * coordenada se distingue sola. Eso es exactamente lo que hacía falta.
 *
 * SE CONSERVA LA EXCURSIÓN Y SE TAPA EL SITIO, que es lo que ya significa
 * `cubierto_por`: la excursión trae guía y entrada, el sitio no. Y el sitio no se
 * borra: queda marcado, con su motivo, y el lienzo ya sabe saltárselo.
 *
 * ANTE LA DUDA NO SE FUNDE. Si la excursión no se puede situar, queda la
 * comprobación del nombre entero, que es exigente. Perder una visita por fundirla
 * mal es peor que tenerla dos veces, que al menos se ve.
 */
async function cubrirSitiosQueSonElMismoLugar(actividad, candidato, etapa, cubiertos) {
  if (!etapa?.punto_interes_id) return;

  /** A cuánto dejan de ser el mismo sitio. */
  const METROS = 300;

  const limpio = (t) =>
    String(t ?? '')
      .normalize('NFD')
      .replace(/[\u0300-\u036f]/g, '')
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, ' ')
      .trim();

  const titulo = limpio(actividad.titulo);
  if (!titulo) return;
  const ciudad = limpio(etapa.nombre_ciudad);

  const sitios = todas(
    `SELECT id, nombre, lat, lon FROM sitios_lugar
      WHERE punto_interes_id = ? AND cubierto_por IS NULL`,
    etapa.punto_interes_id
  );
  if (!sitios.length) {
    // RENDIRSE EN SILENCIO ES LO QUE ESCONDIÓ ESTE FALLO.
    //
    // Esta salida se tomó en Santorini con la tabla vacía por la carrera entre
    // fases: sin comparar, sin situar la excursión y sin una sola línea en el
    // registro. Con la espera de arriba ya no debería darse por ese motivo, pero
    // si vuelve a pasar —una ciudad sin ficha, todos los sitios ya cubiertos—
    // tiene que verse. La otra rama sí escribe cuando funde.
    anotar(
      etapa.viaje_id,
      FASE,
      `   No había sitios sin cubrir con los que comparar «${actividad.titulo}»: ` +
        'no puedo saber si es la misma visita que algo que ya se iba a ver.',
      ORIGENES.ninguno
    );
    return;
  }

  // SITUARLA, UNA VEZ EN LA VIDA. Si ya tiene fila —situada o fallida— esto no
  // llama a nadie: `situarActividadConPlaces` lo comprueba antes que nada.
  const dondeLaCiudad = una('SELECT lat, lon FROM puntos_interes WHERE id = ?', etapa.punto_interes_id);
  try {
    await situarActividadConPlaces(actividad.id, {
      cerca: Number.isFinite(Number(dondeLaCiudad?.lat))
        ? { lat: Number(dondeLaCiudad.lat), lon: Number(dondeLaCiudad.lon) }
        : null,
    });
  } catch (err) {
    console.warn(`[excursiones] no pude situar «${actividad.titulo}» (${err.message}).`);
  }

  const d = direccionDe('actividad', actividad.id);
  const punto = d?.situada ? { lat: Number(d.punto.lat), lon: Number(d.punto.lng) } : null;

  for (const s of sitios) {
    const nombre = limpio(s.nombre);
    // Nombres muy cortos no identifican nada, y la ciudad tampoco: un free tour
    // por Atenas no puede tapar «Atenas».
    if (nombre.length < 4 || nombre === ciudad) continue;

    const tienePunto = Number.isFinite(Number(s.lat));
    const metros =
      punto && tienePunto
        ? distanciaKm(punto, { lat: Number(s.lat), lon: Number(s.lon) }) * 1000
        : null;

    // Dos caminos para decir «es el mismo sitio», y el de la coordenada manda.
    const mismaCoordenada = metros != null && metros <= METROS;
    const nombreEntero = new RegExp(`(^| )${nombre}( |$)`).test(titulo);

    if (!mismaCoordenada && !nombreEntero) continue;
    // Si el nombre casa pero las coordenadas dicen que están lejos, gana la
    // coordenada: es el «no los fundo» de siempre.
    if (nombreEntero && metros != null && metros > METROS) continue;

    ejecutar('UPDATE sitios_lugar SET cubierto_por = ? WHERE id = ?', candidato.id, s.id);
    cubiertos.push(
      `${s.nombre} (es el mismo lugar que «${actividad.titulo}»` +
        (mismaCoordenada ? `, a ${Math.round(metros)} m` : ', que lo lleva en el nombre') +
        ')'
    );
  }
}
