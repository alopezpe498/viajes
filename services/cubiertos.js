/**
 * ¿ESTE SITIO SE VE DENTRO DE OTRA COSA, EN ESTE VIAJE?
 *
 * Dos columnas, dos cosas distintas:
 *
 *   - `cubierto_por`: el id de OTRO SITIO de la misma ciudad, cuando uno se
 *     visita dentro del otro (la Catedral de San Doimo dentro del Palacio de
 *     Diocleciano). Es del catálogo y vale para cualquier viaje.
 *   - `cubierto_por_excursion`: el id del CANDIDATO de una excursión que lleva a
 *     ese sitio. Es de UN viaje, y solo vale si la excursión está en él.
 *
 * Antes iban en la misma columna y se leían como «no es NULL, así que se ve».
 * Eso dejó a Hiroshima sin el Parque de la Paz, el Museo y la Cúpula: los
 * tapaba una visita guiada que no llegó a entrar en el lienzo. Y el candidato
 * de una excursión expulsada se borra, así que el sitio quedaba tapado por algo
 * que ya no existe —el Santuario de Itsukushima, por el ferry que se echó—, y
 * el catálogo es compartido: el viaje siguiente a la misma ciudad lo heredaba.
 *
 * Esto devuelve la condición SQL de «se ofrece»: no está fundido en otro sitio,
 * y ninguna excursión de ESTE viaje lo tapa. Con `soloColocadas`, la excursión
 * tapa solo si está en el lienzo; es lo que vale en cuanto el lienzo está
 * montado.
 */
export function sinCubrir(etapaId, { soloColocadas = false, alias = 's' } = {}) {
  const e = Number(etapaId);
  if (!Number.isInteger(e)) return `(${alias}.cubierto_por IS NULL AND ${alias}.cubierto_por_excursion IS NULL)`;

  return `(${alias}.cubierto_por IS NULL AND (${alias}.cubierto_por_excursion IS NULL OR NOT EXISTS (
      SELECT 1 FROM candidatos c
       WHERE c.id = ${alias}.cubierto_por_excursion AND c.tipo = 'actividad' AND c.etapa_id = ${e}
       ${soloColocadas ? 'AND EXISTS (SELECT 1 FROM itinerario i WHERE i.candidato_id = c.id)' : ''})))`;
}
