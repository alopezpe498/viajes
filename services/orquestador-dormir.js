/**
 * services/orquestador-dormir.js
 * -----------------------------------------------------------------------------
 * FASE 3 DEL ORQUESTADOR: un alojamiento por parada.
 *
 * La fase 1 dejó las paradas con sus noches y la 2 los traslados con su hora.
 * Aquí se busca dónde dormir en cada una, con los filtros que se contestaron al
 * activar el modo automático.
 *
 * EL PRECIO SE PREGUNTA POR NIVEL Y SE TRADUCE AQUÍ.
 *
 * En la configuración se dice «económico», «medio» o «alto», y no una cifra, por
 * un motivo que se ve en cuanto el viaje tiene dos ciudades: «medio» en Cracovia
 * y «medio» en Zúrich no se parecen en nada. Una cifra escrita una vez en la
 * configuración obligaría a acertarla en todas las paradas a la vez, que es
 * imposible. Así que la primera llamada a la IA de cada parada traduce el nivel
 * a un rango de euros por noche PARA ESA CIUDAD Y ESAS FECHAS, y ese rango es el
 * que va al buscador.
 *
 * SI NO HAY NADA, SE AFLOJA POR ORDEN Y SE DICE.
 *
 * Primero el techo del precio, que es lo que más suele fallar y lo que menos
 * duele; después la zona; después el desayuno y la cancelación. La VALORACIÓN
 * MÍNIMA NO SE TOCA NUNCA: es la única condición que no habla de comodidad sino
 * de si el sitio está bien o mal, y bajarla para poder cerrar la búsqueda sería
 * resolver el problema mintiendo.
 *
 * Cada escalón queda escrito en el log. Si al final no hay nada, se deja el
 * hueco y se sigue con la parada siguiente: un viaje con un hotel sin resolver
 * se arregla en diez minutos; uno que se paró en la segunda ciudad, no.
 */
import { todas, una, ejecutar } from '../db/index.js';
import { consultarJSON, hayClaveIA, SIN_CLAVE } from '../lib/ia.js';
import { buscarHoteles } from '../providers/booking.js';
import { ocupacionDe, aplicarFiltrosLocales } from '../services/proveedores.js';
import { elegirHotel } from '../services/etapa.js';
import { anotar, apuntarHueco, parametro, configAuto, ORIGENES } from '../services/orquestador.js';
import { hayQueParar } from '../services/orquestador-parada.js';
import { porParada } from '../services/paralelo.js';
import { enFase } from '../services/fase-actual.js';
import { enParada } from '../services/cronometro.js';
import { apuntarReintento } from './cronometro.js';

const FASE = 'dormir';

/** Cuántos alojamientos se piden por parada. Para elegir, de sobra. */
const MAX_HOTELES = 18;

/** Las dos mitades del prompt editable. */
const MARCA_PRECIO = '=== PASO 1: TRADUCIR EL NIVEL DE PRECIO ===';
const MARCA_ELEGIR = '=== PASO 2: ELEGIR ===';

export function partirPrompt(texto) {
  const i = texto.indexOf(MARCA_PRECIO);
  const j = texto.indexOf(MARCA_ELEGIR);
  if (i < 0 || j < 0 || j < i) {
    throw new Error(
      `El prompt de esta fase tiene que llevar las dos marcas «${MARCA_PRECIO}» y ` +
        `«${MARCA_ELEGIR}», en ese orden. Revísalo en el cerebro del orquestador.`
    );
  }
  return {
    precio: texto.slice(i + MARCA_PRECIO.length, j).trim(),
    elegir: texto.slice(j + MARCA_ELEGIR.length).trim(),
  };
}

export function rellenar(plantilla, datos) {
  return plantilla.replace(/\{\{([A-Z_]+)\}\}/g, (_, clave) => {
    const v = datos[clave];
    return v === undefined || v === null ? '' : String(v);
  });
}

// =============================================================================
// LOS FILTROS
// =============================================================================
/**
 * La configuración del modo automático, traducida a los filtros de siempre.
 *
 * `aflojado` dice qué se ha soltado ya en esta parada. Se pasa entero en vez de
 * ir mutando el objeto para que cada intento sea reproducible: mirando el nivel
 * de relajación se sabe exactamente con qué se buscó.
 */
export function filtrosDesdeAuto(auto, rango, aflojado = {}) {
  const oNulo = (v) => (v && v !== 'indiferente' ? v : null);

  return {
    precioMin: rango?.min ?? null,
    precioMax: rango?.max ?? null,
    // La valoración mínima va SIEMPRE y no se afloja nunca.
    notaMinima: auto.notaMinima ? Number(auto.notaMinima) : null,
    estrellas: null,
    piscina: false,
    wifi: false,
    parking: false,
    desayuno: aflojado.desayuno ? false : auto.desayuno === 'si',
    cancelacionGratis: aflojado.condiciones ? false : auto.cancelacionGratis === 'si',
    tipoAlojamiento: oNulo(auto.tipoAlojamiento),
    // «Céntrico» ya no es solo un filtro local: viaja a Booking dentro del
    // `nflt`, que es la única forma de que las 20 tarjetas que leemos sean de
    // verdad las del centro. `aflojado.zona` puede ser un número (radio
    // ampliado, en km: Booking solo tiene 1, 3 y 5) o `true` (soltar la zona).
    distanciaMax:
      auto.zona !== 'centrico'
        ? null
        : aflojado.zona === true
          ? null
          : Number(aflojado.zona) || 1,
  };
}

/** Cómo se lee un intento en el log. */
function resumenDeFiltros(f) {
  const t = [];
  if (f.precioMin || f.precioMax) t.push(`${f.precioMin ?? 0}-${f.precioMax ?? '∞'} €/noche`);
  if (f.notaMinima) t.push(`nota ≥ ${f.notaMinima}`);
  if (f.tipoAlojamiento) t.push(f.tipoAlojamiento);
  if (f.distanciaMax) t.push(`a menos de ${f.distanciaMax} km del centro`);
  if (f.desayuno) t.push('con desayuno');
  if (f.cancelacionGratis) t.push('cancelación gratis');
  return t.join(' · ') || 'sin filtros';
}

// =============================================================================
// LAS FECHAS
// =============================================================================
/** Noches que hay entre dos fechas de reserva. */
function nochesEntreFechas(desde, hasta) {
  if (!desde || !hasta) return 0;
  const a = new Date(`${desde}T12:00:00`);
  const b = new Date(`${hasta}T12:00:00`);
  return Math.max(0, Math.round((b - a) / 86_400_000));
}

/**
 * LAS NOCHES DE LA PARADA, ajustadas a lo que hacen los vuelos.
 *
 * La fecha de entrada de una etapa es el día que se llega. Pero si el vuelo
 * aterriza de madrugada —a las 00:40 del día 5, por ejemplo— esa noche ya hay
 * que tener cama, y la reserva empieza el día 4: quien llegue a las 00:40 con
 * una reserva que empieza el 5 se encuentra el mostrador cerrado.
 *
 * Solo se adelanta con la llegada del viaje (el vuelo de ida), y solo en la
 * primera parada: es la única que depende de un vuelo intercontinental. Los
 * saltos internos los pone la fase 2 a horas civilizadas.
 */
export function fechasDeLaEtapa(etapa, esPrimera, horaLlegada) {
  const entrada = etapa.fecha_inicio;
  const salida = etapa.fecha_fin;
  if (!entrada || !salida) return null;

  // "00:40", "01:15"… De madrugada es antes de las 6: a esa hora el día de
  // calendario ya ha cambiado pero la noche es la anterior.
  //
  // OJO CON EL HUECO: Number('') es 0, y 0 es "menos de las 6". Sin comprobar
  // que hay hora de verdad, un vuelo sin horario adelantaba la reserva una noche
  // y se pagaba una cama que nadie iba a usar. Pasó: "el vuelo llega a las null,
  // así que la reserva empieza la noche anterior".
  const texto = String(horaLlegada ?? '').trim();
  const h = /^\d{1,2}:\d{2}/.test(texto) ? Number(texto.split(':')[0]) : NaN;
  const deMadrugada = esPrimera && Number.isFinite(h) && h < 6;

  if (!deMadrugada) return { entrada, salida, adelantada: false };

  const antes = new Date(`${entrada}T12:00:00`);
  antes.setDate(antes.getDate() - 1);
  return { entrada: antes.toISOString().slice(0, 10), salida, adelantada: true };
}

/** La hora a la que aterriza el vuelo de ida, si lo hay. */
function horaDeLlegada(viajeId) {
  // SE MIRAN TODOS LOS VUELOS MARCADOS, y el de ida se reconoce por su tramo.
  //
  // Antes se exigía `transporte_id IS NULL`, que era verdad cuando el
  // orquestador guardaba los vuelos sueltos. Desde que se enganchan a su tramo
  // —que es lo que los deja en verde en Mi ruta— esa condición no la cumple
  // ninguno: la hora de llegada salía null y la primera parada se buscaba con
  // una noche de más.
  const candidatos = todas(
    `SELECT datos_extra FROM candidatos
      WHERE viaje_id = ? AND tipo = 'vuelo' AND marcado = 1
      ORDER BY id`,
    viajeId
  );

  for (const c of candidatos) {
    try {
      const d = JSON.parse(c?.datos_extra ?? '{}');
      const ida = (d.tramos ?? []).find((t) => t.tramo === 'ida');
      if (ida?.horaLlegada) return ida.horaLlegada;
    } catch {
      /* datos_extra corrupto: se mira el siguiente */
    }
  }
  return null;
}

// =============================================================================
// LA FASE
// =============================================================================
export async function ejecutarFaseDormir(viaje, promptEntero) {
  const viajeId = viaje.id;
  const di = (t, origen = null) => anotar(viajeId, FASE, t, origen);

  if (!hayClaveIA()) throw new Error(SIN_CLAVE);

  const partes = partirPrompt(promptEntero);
  const auto = configAuto(viaje);
  const { adultos, edadesNinos } = ocupacionDe(viaje);
  const viajeros = adultos + edadesNinos.length;

  const pasoPct = parametro('relajacion_precio_pct', 25);
  const maxVeces = parametro('relajacion_precio_max_veces', 2);

  const etapas = todas(
    "SELECT * FROM etapas WHERE viaje_id = ? AND estado = 'confirmada' ORDER BY orden, id",
    viajeId
  );
  if (!etapas.length) {
    di('El viaje no tiene paradas confirmadas: no hay dónde buscar.');
    return { etapas: 0, resueltas: 0 };
  }

  const llegada = horaDeLlegada(viajeId);
  di(`${etapas.length} parada(s) donde buscar alojamiento para ${viajeros} viajero(s).`);

  const aLaVez = Math.max(1, parametro('concurrencia_paradas', 3));

  // CADA PARADA BUSCA SU HOTEL POR SU CUENTA.
  //
  // No dependen unas de otras: cada una tiene sus fechas, su rango de precio y
  // su búsqueda. `i === 0` era lo único que miraba al bucle, y se sustituye por
  // el índice que ya trae la propia lista.
  //
  // El scraping de Booking NO se paraleliza aunque esto suba: el cerrojo de
  // `abrirNavegador` lo serializa porque el perfil de Chrome es uno solo. Lo que
  // se gana aquí son las llamadas de IA del rango de precio y de la elección.
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
    async (etapa) => {
      const i = etapas.indexOf(etapa);
      const ciudad = etapa.nombre_ciudad;

      if (etapa.tocado_a_mano) {
        di(`${ciudad}: la has tocado tú; no la toco.`);
        return { hecha: false };
      }
      const yaElegido = una(
        "SELECT titulo FROM candidatos WHERE etapa_id = ? AND tipo = 'hotel' AND marcado = 1",
        etapa.id
      );
      if (yaElegido) {
        di(`${ciudad}: ya tenías elegido «${yaElegido.titulo}». No lo cambio.`);
        resueltas += 1;
        return { hecha: false };
      }

      const fechas = fechasDeLaEtapa(etapa, i === 0, llegada);
      if (!fechas) {
        apuntarHueco(viajeId, FASE, `${ciudad}: la parada no tiene fechas.`);
        return { hecha: false };
      }
      if (fechas.adelantada) {
        di(
          `${ciudad}: el vuelo llega a las ${llegada}, así que la reserva empieza la noche anterior (${fechas.entrada}).`,
          ORIGENES.scraping
        );
      }

      di(`Buscando dónde dormir en ${ciudad} (${etapa.noches} noche(s), del ${fechas.entrada} al ${fechas.salida})…`);

      // --- 1) El nivel de precio, traducido a esta ciudad -------------------
      let rango = null;
      try {
        const r = await consultarJSON(
          rellenar(partes.precio, {
            CIUDAD: ciudad,
            PAIS: viaje.destino ?? '',
            FECHA_ENTRADA: fechas.entrada,
            FECHA_SALIDA: fechas.salida,
            NIVEL: auto.nivelPrecio ?? 'medio',
            VIAJEROS: `${adultos} adulto(s)` + (edadesNinos.length ? ` y ${edadesNinos.length} niño(s)` : ''),
            TIPO: auto.tipoAlojamiento ?? 'indiferente',
          }),
          { maxTokens: 600, paso: `precio de ${ciudad}` }
        );
        const min = Math.round(Number(r?.min_por_noche));
        const max = Math.round(Number(r?.max_por_noche));
        if (Number.isFinite(min) && Number.isFinite(max) && min > 0 && max >= min) {
          rango = { min, max, porQue: typeof r?.por_que === 'string' ? r.por_que.trim() : null };
        }
      } catch (err) {
        di(`   No pude traducir el nivel de precio (${err.message}).`);
      }

      if (rango) {
        // Una ESTIMACIÓN declarada: nadie ha buscado este rango, lo pone la IA
        // para acotar la búsqueda. Se enseña con «≈» y se etiqueta como lo que es,
        // que no es lo mismo que un precio inventado haciéndose pasar por dato.
        di(
          `   «${auto.nivelPrecio}» en ${ciudad} ≈ ${rango.min}-${rango.max} €/noche.${rango.porQue ? ` ${rango.porQue}` : ''}`,
          ORIGENES.estimacion
        );
      } else {
        // SIN RANGO SE BUSCA IGUAL, sin filtro de precio. Es peor —habrá que
        // elegir entre cosas de todos los precios— pero infinitamente mejor que
        // quedarse sin buscar.
        di('   Sin traducción de precio: busco sin filtro de precio.');
      }

      // --- 2) Buscar, aflojando por orden -----------------------------------
      // EL ORDEN DE LA ESCALERA IMPORTA, y antes estaba al revés.
      //
      // Se subía el precio dos veces (hasta un +50%) antes de tocar la zona, así
      // que un viaje acababa buscando hoteles de 180 €/noche cuando el que valía
      // costaba 53. Dormir a 3 km del centro en vez de a 1 molesta bastante menos
      // que pagar la mitad más por la misma cama, así que el radio se amplía
      // PRIMERO. Y cuando por fin se toca el precio, la banda se ensancha por los
      // dos lados: subir solo el techo deja fuera lo barato, que es justo lo que
      // uno quiere encontrar cuando ya está aflojando.
      const escalones = [{ rango, aflojado: {}, comoSeLlama: null }];

      const esCentrico = auto.zona === 'centrico';
      if (esCentrico) {
        escalones.push({
          rango,
          aflojado: { zona: 3 },
          comoSeLlama: 'ampliando el radio a 3 km del centro',
        });
      }

      // A partir de aquí se sigue buscando con el radio ya ampliado: sería absurdo
      // volver a estrecharlo justo cuando estamos ampliando lo demás.
      const zonaAncha = esCentrico ? { zona: 3 } : {};
      for (let v = 1; rango && v <= maxVeces; v += 1) {
        const techo = Math.round(rango.max * (1 + (pasoPct / 100) * v));
        const suelo = Math.max(0, Math.round(rango.min * (1 - (pasoPct / 100) * v)));
        escalones.push({
          rango: { min: suelo, max: techo },
          aflojado: { ...zonaAncha },
          comoSeLlama: `ensanchando el precio a ${suelo}-${techo} €/noche`,
        });
      }

      const ultimoRango = escalones[escalones.length - 1].rango;
      if (esCentrico) {
        escalones.push({
          rango: ultimoRango,
          aflojado: { zona: true },
          comoSeLlama: 'soltando lo de céntrico',
        });
      }
      escalones.push({
        rango: ultimoRango,
        aflojado: { zona: true, desayuno: true, condiciones: true },
        comoSeLlama: 'soltando también el desayuno y la cancelación gratuita',
      });

      let hoteles = [];
      let filtrosUsados = null;
      for (const escalon of escalones) {
        const filtros = filtrosDesdeAuto(auto, escalon.rango, escalon.aflojado);
        // Los números de esta línea son los de nuestra propia escalera (el radio al
        // que ampliamos, el porcentaje que ensanchamos), no datos de fuera.
        if (escalon.comoSeLlama) {
          // Los números de esta línea son los de nuestra escalera aplicados sobre
          // la estimación de arriba: ni dato ni invención.
          di(`   Sin resultados. Lo intento ${escalon.comoSeLlama}.`, ORIGENES.estimacion);
        }

        // Cada escalón de la escalera es una búsqueda de más: son los minutos que
        // cuesta no haber encontrado nada a la primera, y se apuntan como lo que
        // son —un reintento— para que el desglose de la fase los enseñe.
        const cerrarReintento = escalon.comoSeLlama
          ? apuntarReintento({ motivo: 'filtros aflojados' })
          : () => {};

        try {
          hoteles = await buscarHoteles({
            destino: ciudad,
            fechaEntrada: fechas.entrada,
            fechaSalida: fechas.salida,
            adultos,
            edadesNinos,
            filtros,
            maxResultados: MAX_HOTELES,
          });
        } catch (err) {
          di(`   La búsqueda falló (${err.message}).`);
          hoteles = [];
        } finally {
          cerrarReintento();
        }

        // «CÉNTRICO», SEGUNDA VUELTA: red de seguridad, ya no la única defensa.
        //
        // El radio va ahora dentro del `nflt` de Booking, así que las tarjetas que
        // llegan ya deberían cumplirlo. Esto se queda por si alguna se cuela (o si
        // Booking mide desde otro punto), pero si vuelve a descartar 18 de 20 es
        // que el filtro de la URL ha dejado de aplicarse: por eso el log dice
        // cuántas caen aquí. Antes ESTE era el único filtro, y como Booking
        // devuelve sus «opciones recomendadas» —que no vienen ordenadas por
        // distancia— tiraba casi todo y el orquestador acababa subiendo el precio
        // para nada.
        const antes = hoteles.length;
        hoteles = aplicarFiltrosLocales(
          hoteles.map((h) => ({ ...h, extra: { distanciaCentro: h.distanciaCentro } })),
          filtros
        );
        if (antes !== hoteles.length) {
          di(`   ${antes - hoteles.length} descartado(s) por quedar lejos del centro.`);
        }

        if (hoteles.length) {
          filtrosUsados = filtros;
          // Cuántos ha devuelto Booking; los filtros que se leen ahí dentro llevan
        // el rango de precio que se inventó la IA, y por eso la línea no se marca
        // como scraping: el número de resultados es real, la horquilla no.
        di(`   ${hoteles.length} alojamiento(s) con: ${resumenDeFiltros(filtros)}.`, ORIGENES.estimacion);
          break;
        }
      }

      if (!hoteles.length) {
        apuntarHueco(
          viajeId,
          FASE,
          `${ciudad}: no encontré alojamiento ni aflojando los filtros. Tendrás que buscarlo tú.`
        );
        di(`   ${ciudad}: sin alojamiento después de aflojar todo lo que se podía. Lo dejo como hueco.`);
        return { hecha: false };
      }

      // --- 3) Guardar los candidatos, como los guarda el flujo manual -------
      // LAS NOCHES QUE SE HAN BUSCADO, no las que tiene la etapa.
      //
      // Casi siempre son las mismas, pero cuando la reserva se adelanta por un
      // vuelo de madrugada se busca una noche más, y dividir el total de tres
      // noches entre las dos de la etapa daba un precio por noche inflado un 50%:
      // el Ibis de Gdansk salió en el log a "202 €/noche" costando 67.
      const noches = Math.max(1, nochesEntreFechas(fechas.entrada, fechas.salida));
      const ids = [];

      for (const h of hoteles) {
        const r = ejecutar(
          // El total de la estancia para la ocupacion pedida: ya es de todos.
          `INSERT INTO candidatos
             (viaje_id, etapa_id, tipo, titulo, precio, moneda, duracion, valoracion, num_opiniones,
              url, imagen_url, origen_datos, marcado, datos_extra, precio_ambito)
           VALUES (?, ?, 'hotel', ?, ?, ?, ?, ?, ?, ?, ?, 'booking', 0, ?, 'por_grupo')`,
          viajeId,
          etapa.id,
          h.nombre ?? '(sin nombre)',
          h.precioTotal ?? null,
          h.moneda ?? null,
          h.estanciaTexto ?? null,
          h.valoracion ?? null,
          h.numOpiniones ?? null,
          h.url ?? null,
          h.imagenUrl ?? null,
          JSON.stringify({
            zona: h.zona ?? null,
            direccion: h.direccion ?? null,
            estrellas: h.estrellas ?? null,
            distanciaCentro: h.distanciaCentro ?? null,
            esAnuncio: h.esAnuncio ?? false,
          })
        );
        ids.push({ id: Number(r.lastInsertRowid), hotel: h });
      }

      // --- 4) Elegir --------------------------------------------------------
      const porNoche = (h) => (h.precioTotal ? Math.round(h.precioTotal / noches) : null);

      const lista = ids
        .map(
          ({ id, hotel: h }, n) =>
            `- op${n + 1} · ${h.nombre}\n` +
            `  ${h.valoracion ? `valoración ${h.valoracion}` : 'sin valoración'}` +
            `${h.numOpiniones ? ` (${h.numOpiniones} opiniones)` : ''}` +
            ` · ${porNoche(h) != null ? `${porNoche(h)} €/noche` : 'precio desconocido'}` +
            `${h.precioTotal ? ` (${Math.round(h.precioTotal)} € la estancia)` : ''}\n` +
            `  ${h.zona ?? 'zona desconocida'}` +
            `${h.distanciaCentro ? ` · ${h.distanciaCentro}` : ''}` +
            `${h.estrellas ? ` · ${h.estrellas}★` : ''}`
        )
        .join('\n');

      // Si la etapa acaba con un traslado temprano, la cercanía a la estación
      // pasa a contar. Se le dice, porque él no puede saberlo.
      const salidaTemprana = (() => {
        const t = una(
          `SELECT td.horario FROM transportes tr
             JOIN transporte_datos td ON td.transporte_id = tr.id AND td.ficha_id = tr.ficha_transporte_id
            WHERE tr.viaje_id = ? AND tr.etapa_origen_id = ?`,
          viajeId,
          etapa.id
        );
        // Sin traslado desde esta parada no hay hora que mirar. El guardia va
        // sobre el texto y no sobre el número: `Number('')` es 0, que es finito y
        // menor que 10, así que la versión anterior daba por "salida temprana" un
        // tramo inexistente y reventaba al leerle la hora.
        if (!t?.horario) return null;
        const h = Number(String(t.horario).split(':')[0]);
        return Number.isFinite(h) && h < 10 ? t.horario : null;
      })();

      let elegido = null;
      try {
        const r = await consultarJSON(
          rellenar(partes.elegir, {
            CIUDAD: ciudad,
            NOCHES: noches,
            VIAJEROS: `${adultos} adulto(s)` + (edadesNinos.length ? ` y ${edadesNinos.length} niño(s)` : ''),
            FILTROS: resumenDeFiltros(filtrosUsados),
            SALIDA_TEMPRANA: salidaTemprana
              ? `Sí: al terminar esta parada se sale a las ${salidaTemprana}, así que estar cerca de la estación suma.`
              : 'No: no hay salida madrugadora desde esta parada.',
            OPCIONES: lista,
          }),
          { maxTokens: 1200, paso: `elegir hotel en ${ciudad}` }
        );
        const n = Number(String(r?.elegida ?? '').replace(/\D/g, ''));
        const cand = ids[n - 1];
        if (cand) {
          elegido = { ...cand, porQue: typeof r?.por_que === 'string' ? r.por_que.trim() : null };
        }
      } catch (err) {
        di(`   La IA no pudo elegir (${err.message}).`);
      }

      // Si no contesta, se coge la mejor relación valoración/precio, que es el
      // criterio que ella tenía que seguir. Mejor sin el matiz que sin hotel.
      if (!elegido) {
        const mejor = [...ids]
          .filter((x) => x.hotel.valoracion)
          .sort((a, b) => {
            const ra = (a.hotel.valoracion ?? 0) / Math.max(porNoche(a.hotel) ?? 1, 1);
            const rb = (b.hotel.valoracion ?? 0) / Math.max(porNoche(b.hotel) ?? 1, 1);
            return rb - ra;
          })[0] ?? ids[0];
        elegido = { ...mejor, porQue: 'mejor relación valoración/precio, elegido sin la IA' };
        di('   Elijo yo por relación valoración/precio.');
      }

      elegirHotel(etapa.id, elegido.id);

      const h = elegido.hotel;
      dudarDelPrecio(viajeId, elegido, ciudad, rango, noches, di);
      // Nombre, nota, precio y distancia son los de la tarjeta de Booking.
      di(
        `${ciudad}: ${h.nombre}` +
          `${h.valoracion ? `, ${h.valoracion}` : ''}` +
          `${porNoche(h) != null ? `, ${porNoche(h)} €/noche` : ''}` +
          `${h.distanciaCentro ? `, ${h.distanciaCentro}` : ''}.`,
        ORIGENES.scraping
      );
      if (elegido.porQue) di(`   Por qué: ${elegido.porQue}`);
      return { hecha: true };
    }
  );

  // UN FALLO EN UNA CIUDAD NO SE TRAGA NI SE LLEVA A LAS DEMÁS.
  for (const [k, r] of resultados.entries()) {
    if (!r?.error) continue;
    const cual = etapas[k]?.nombre_ciudad ?? `parada ${k + 1}`;
    di(`${cual}: no se pudo (${r.error.message}).`);
    apuntarHueco(viajeId, FASE, `${cual}: ${r.error.message}`);
  }

  const resueltas = resultados.filter((r) => r?.valor?.hecha).length;

  di(`${resueltas} de ${etapas.length} parada(s) con alojamiento.`);
  return { etapas: etapas.length, resueltas };
}

/**
 * ¿ES CREÍBLE ESTE PRECIO?
 *
 * EL FALLO QUE ORIGINA ESTO. En las ciudades con moneda distinta del euro, los
 * hoteles salían a precios de risa: categoría alta por lo que cuesta un menú del
 * día. La causa de raíz estaba en el lector de importes —«THB 4,500» se leía
 * como 4,5— y ya está arreglada en `services/importes.js`, pero un lector de
 * precios puede volver a equivocarse el día que Booking cambie el formato, y
 * entonces nadie se enteraría otra vez.
 *
 * Así que hay dos redes, y son distintas:
 *
 *   1. LA MONEDA. Si el precio no viene en euros, no se convierte a ciegas: no
 *      hay fuente de tipos de cambio aquí y no se va a inventar una. Se dice.
 *
 *   2. EL RANGO. El paso 1 de esta misma fase ya estimó lo que cuesta una noche
 *      de este nivel en esta ciudad. Un precio muy por debajo de ese suelo no es
 *      un chollo: es un número mal leído. Se marca como dudoso.
 *
 * NO SE CORRIGE NADA Y NO SE DESCARTA EL HOTEL: no hay forma de saber cuál es el
 * precio bueno, y tirar el alojamiento por una sospecha dejaría la parada sin
 * dónde dormir. Queda dicho en el registro y en la ficha, que es lo que permite
 * mirarlo.
 */
function dudarDelPrecio(viajeId, elegido, ciudad, rango, noches, di) {
  const h = elegido.hotel;
  const total = Number(h.precioTotal);
  if (!Number.isFinite(total) || total <= 0) return;

  const porNoche = Math.round(total / Math.max(1, noches));
  const motivos = [];

  // 1) Moneda que no es el euro.
  if (h.moneda && h.moneda !== 'EUR') {
    motivos.push(`el precio viene en ${h.moneda}, no en euros, y aquí no se convierte`);
  }

  // 2) Muy por debajo de lo que se estimó para esta ciudad y este nivel.
  const suelo = Number(rango?.min);
  if (Number.isFinite(suelo) && suelo > 0) {
    const cuantoDebajo = parametro('factor_precio_sospechoso', 3);
    if (porNoche * cuantoDebajo < suelo) {
      motivos.push(
        `${porNoche} €/noche es más de ${cuantoDebajo} veces más barato que el suelo ` +
          `estimado para ${ciudad} (${suelo} €/noche)`
      );
    }
  }

  if (!motivos.length) return;

  const aviso = `Precio a verificar: ${motivos.join('; ')}.`;

  di(`   OJO en ${ciudad}: ${aviso} Lo dejo puesto, pero no me fiaría del importe.`, ORIGENES.ninguno);
  apuntarHueco(viajeId, FASE, `${ciudad}: precio del alojamiento a verificar (${h.nombre}).`);

  // Y en la ficha, que es donde se mira al reservar.
  const fila = una('SELECT datos_extra FROM candidatos WHERE id = ?', elegido.id);
  let extra = {};
  try {
    extra = fila?.datos_extra ? JSON.parse(fila.datos_extra) : {};
  } catch {
    extra = {};
  }
  ejecutar(
    'UPDATE candidatos SET datos_extra = ? WHERE id = ?',
    JSON.stringify({ ...extra, precioDudoso: aviso, precioTexto: h.precioTexto ?? null }),
    elegido.id
  );
}

export default { ejecutarFaseDormir, partirPrompt, filtrosDesdeAuto, fechasDeLaEtapa };
