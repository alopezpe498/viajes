/**
 * ¿ESTE SITIO SE VE DENTRO DE OTRA COSA, EN ESTE VIAJE?
 *
 * `sitios_lugar.cubierto_por` guarda dos cosas distintas en la misma columna:
 *
 *   - el id de OTRO SITIO de la misma ciudad, cuando uno se visita dentro del
 *     otro (la Catedral de San Doimo dentro del Palacio de Diocleciano). Eso es
 *     del catálogo y vale para cualquier viaje;
 *   - el id del CANDIDATO de una excursión, cuando la excursión lleva a ese
 *     sitio. Eso es de UN viaje, y solo vale si la excursión está en él.
 *
 * Leerlo como «no es NULL, así que se ve» dejó a Hiroshima sin el Parque de la
 * Paz, el Museo y la Cúpula: los tapaba una visita guiada que no llegó a entrar
 * en el lienzo. Y el candidato de una excursión expulsada se borra, así que el
 * sitio quedaba tapado por algo que ya no existe —el Santuario de Itsukushima,
 * por el ferry que se echó—, y el catálogo es compartido: el viaje siguiente a
 * la misma ciudad lo heredaba tapado.
 *
 * Esto devuelve la condición SQL de «se ofrece»: sin tapar, o tapado por algo
 * que en este viaje no lo tapa. Con `soloColocadas`, una excursión tapa solo si
 * está en el lienzo; es lo que vale en cuanto el lienzo está montado.
 *
 * Si el número coincide con un sitio de la misma ciudad se lee como fusión,
 * aunque también coincida con un candidato: ante la duda, tapado, que es como
 * se leía siempre.
 */
export function sinCubrir(etapaId, { soloColocadas = false, alias = 's' } = {}) {
  const e = Number(etapaId);
  if (!Number.isInteger(e)) return `${alias}.cubierto_por IS NULL`;

  return `(${alias}.cubierto_por IS NULL OR NOT (
      EXISTS (SELECT 1 FROM sitios_lugar o
               WHERE o.id = ${alias}.cubierto_por AND o.punto_interes_id = ${alias}.punto_interes_id)
      OR EXISTS (SELECT 1 FROM candidatos c
                  WHERE c.id = ${alias}.cubierto_por AND c.tipo = 'actividad' AND c.etapa_id = ${e}
                  ${soloColocadas ? 'AND EXISTS (SELECT 1 FROM itinerario i WHERE i.candidato_id = c.id)' : ''})
    ))`;
}
