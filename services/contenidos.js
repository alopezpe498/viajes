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

  return fundidos;
}
