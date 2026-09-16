/**
 * services/contenidos.js
 * -----------------------------------------------------------------------------
 * LO QUE ESTÁ DENTRO DE OTRA COSA NO ES OTRA VISITA.
 *
 * EL CASO QUE ORIGINA ESTE FICHERO. El día 7 de Atenas quedó así:
 *
 *     8:30  Acrópolis            180 min
 *    10:00  Partenón             ...
 *    (otro día)  Templo de Atenea Niké
 *
 * El Partenón está DENTRO de la Acrópolis. El Templo de Atenea Niké también. Se
 * entra una vez, con una entrada, y se ven los tres. La revisión llegó a recortar
 * la Acrópolis de 180 a 90 minutos «para hacer sitio» al Partenón — es decir,
 * quitó tiempo de ver el Partenón para poder ver el Partenón.
 *
 * QUÉ HACE ESTO Y QUÉ NO. Detecta pares contenido/contenedor y los funde en una
 * sola visita, con la duración del conjunto y los sub-sitios listados en la
 * descripción. El mecanismo de fusión ya existía —`cubierto_por`, que usan las
 * excursiones para tapar los sitios que incluyen— así que se reutiliza: aquí
 * solo cambia quién tapa a quién.
 *
 * ANTE LA DUDA, NO SE FUNDE. Dos museos a cien metros en la misma calle no son
 * uno dentro de otro, y fundirlos perdería una visita entera. Hace falta que la
 * IA lo afirme Y que las coordenadas lo respalden, cuando las hay.
 */
import { todas, una, ejecutar } from '../db/index.js';
import { consultarJSON, hayClaveIA } from '../lib/ia.js';
import { distanciaKm } from './distancias.js';

/** A cuánto puede estar un sitio de su recinto para creernos que está dentro. */
const METROS_DE_MARGEN = 200;

/**
 * FUNDE LOS SITIOS QUE ESTÁN DENTRO DE OTROS, en una ciudad.
 *
 * Devuelve cuántos ha fundido. No borra nada: el contenido se marca con
 * `cubierto_por` apuntando al contenedor, que es exactamente lo que ya hace una
 * excursión cuando incluye una visita, y el lienzo y los avisos ya saben
 * saltarse lo que está cubierto.
 */
export async function fundirSitiosContenidos(punto, ciudad, di = () => {}) {
  if (!punto?.id || !hayClaveIA()) return 0;

  const sitios = todas(
    `SELECT id, nombre, descripcion, horarios, lat, lon, tiempo_visita, bloque, orden
       FROM sitios_lugar
      WHERE punto_interes_id = ? AND cubierto_por IS NULL AND bloque <> 'busqueda'
      ORDER BY orden, id`,
    punto.id
  );
  if (sitios.length < 2) return 0;

  let pares = [];
  try {
    const r = await consultarJSON(
      [
        `Estos son los sitios que se van a visitar en ${ciudad}:`,
        ...sitios.map((s) => `- [${s.id}] ${s.nombre}`),
        '',
        '¿Cuáles de ellos están FÍSICAMENTE DENTRO del recinto de otro, de forma',
        'que se visitan con la misma entrada y en la misma visita?',
        '',
        'Ejemplo: el Partenón y el Templo de Atenea Niké están dentro de la',
        'Acrópolis de Atenas: se sube una vez y se ven los tres.',
        '',
        'NO cuentan: dos sitios cercanos, dos museos del mismo barrio, ni un',
        'edificio y la plaza donde está. Solo lo que se ve SIN volver a pagar ni',
        'volver a entrar. Si dudas, NO lo incluyas.',
        '',
        'Devuelve SOLO: {"dentro":[{"contenido":12,"contenedor":7}]}',
      ].join('\n'),
      { maxTokens: 700, paso: `sitios contenidos en ${ciudad}`, modelo: 'rapido' }
    );
    pares = Array.isArray(r?.dentro) ? r.dentro : [];
  } catch (err) {
    di(`   No pude mirar qué sitios están dentro de otros (${err.message}).`);
    return 0;
  }

  const porId = new Map(sitios.map((s) => [s.id, s]));
  let fundidos = 0;

  for (const par of pares) {
    const dentro = porId.get(Number(par?.contenido));
    const fuera = porId.get(Number(par?.contenedor));
    if (!dentro || !fuera || dentro.id === fuera.id) continue;

    // Y LAS COORDENADAS, CUANDO LAS HAY. Es la parte comprobable: si el modelo
    // dice que algo está dentro de un recinto que está a tres kilómetros, se
    // ha equivocado y se nota sin saber nada de la ciudad.
    if (dentro.lat != null && fuera.lat != null) {
      const metros = distanciaKm(
        { lat: Number(dentro.lat), lon: Number(dentro.lon) },
        { lat: Number(fuera.lat), lon: Number(fuera.lon) }
      ) * 1000;
      if (metros > METROS_DE_MARGEN) {
        di(
          `   «${dentro.nombre}» dice estar dentro de «${fuera.nombre}» pero hay ` +
            `${Math.round(metros)} m entre los dos: no los fundo.`
        );
        continue;
      }
    }

    // El contenedor se queda con la visita, y en su descripción se dice qué
    // incluye: quien lea la tarjeta tiene que saber que el Partenón está ahí.
    const yaDice = String(fuera.descripcion ?? '').toLowerCase().includes(dentro.nombre.toLowerCase());
    ejecutar(
      `UPDATE sitios_lugar
          SET descripcion = CASE WHEN ? THEN descripcion
                                 ELSE COALESCE(descripcion, '') || ?
                            END
        WHERE id = ?`,
      yaDice ? 1 : 0,
      `\n\nIncluye: ${dentro.nombre}.`,
      fuera.id
    );
    ejecutar('UPDATE sitios_lugar SET cubierto_por = ? WHERE id = ?', fuera.id, dentro.id);

    di(`   «${dentro.nombre}» se visita dentro de «${fuera.nombre}»: una sola visita.`);
    fundidos += 1;
  }

  avisarDeLosQueSonElMismoSitio(sitios, di);

  return fundidos;
}

/**
 * A partir de aquí, un montón en la misma coordenada ya no son dos fichas de lo
 * mismo: es que la geocodificación se rindió y los mandó a todos al mismo sitio.
 */
const SON_YA_UN_MONTON = 3;

/**
 * SITIOS QUE COMPARTEN LA COORDENADA EXACTA.
 *
 * EL CASO QUE ORIGINA ESTO, del viaje 101. El catálogo de Kairouan tenía:
 *
 *     Museo de Arte Islámico de Kairouan   35.5925359, 10.0528505
 *     Museo de Kairouan                    35.5925359, 10.0528505
 *
 * La misma coordenada hasta el séptimo decimal: es el Museo Nacional de Arte
 * Islámico de Raqqada, dos veces. El lienzo colocó uno y expulsó el otro con un
 * AVISO GRAVE de imprescindible perdido — un aviso grave por dejar fuera algo
 * que ya estaba dentro.
 *
 * SON DOS FENÓMENOS DISTINTOS Y HAY QUE DECIR CUÁL ES CADA UNO, que es lo que se
 * vio al medirlo contra el catálogo entero: de 42 parejas «en el mismo punto»,
 * casi todas no eran duplicados sino esto:
 *
 *     Kairouan  8 sitios en 35.681076, 10.104229
 *     Susa      4 sitios en 35.827671, 10.638795
 *
 * Ocho sitios no son el mismo sitio ocho veces. Es que Google no supo situarlos
 * uno a uno y devolvió el mismo punto para todos —la Gran Mezquita, el Ribat—, y
 * eso importa MUCHO más que un duplicado: la guarda del reparto y el aviso de
 * «no llegas» miden distancias entre esos puntos, y entre dos sitios que
 * heredaron la misma coordenada la distancia sale cero SIEMPRE. No es que estén
 * cerca: es que no lo sabemos.
 *
 * NO SE FUNDE NADA, Y ES A PROPÓSITO. Fundir marca `cubierto_por`, y eso saca al
 * sitio de `colocablesDeEtapa`, de `imprescindiblesDeParada` y de la lectura de
 * horarios: si el parecido fuera falso se perdería una visita entera sin que
 * nadie lo dijera. La doctrina de este fichero es la de arriba —«ANTE LA DUDA,
 * NO SE FUNDE»— y la duda la resuelve quien mira, no el programa.
 *
 * Tampoco se le pregunta a la IA: la coordenada ya lo ha dicho. Es aritmética
 * sobre un dato que está en la base, y la aritmética no mejora por consultarla.
 */
function avisarDeLosQueSonElMismoSitio(sitios, di) {
  const grupos = new Map();
  for (const s of sitios) {
    if (s.lat == null || s.lon == null) continue;
    const clave = `${s.lat},${s.lon}`;
    if (!grupos.has(clave)) grupos.set(clave, []);
    grupos.get(clave).push(s.nombre);
  }

  for (const [clave, nombres] of grupos) {
    if (nombres.length < 2) continue;

    if (nombres.length >= SON_YA_UN_MONTON) {
      di(
        `   ${nombres.length} sitios comparten la misma coordenada exacta (${clave}): ` +
          'no están situados uno a uno, heredaron un punto. Las distancias entre ellos ' +
          `no valen. Son: ${nombres.join(', ')}.`
      );
      continue;
    }

    di(
      `   «${nombres[0]}» y «${nombres[1]}» están en la coordenada exacta (${clave}): ` +
        'puede que sean el mismo sitio con dos nombres. Los dejo puestos, míralo.'
    );
  }
}
