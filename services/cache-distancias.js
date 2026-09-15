/**
 * services/cache-distancias.js
 * -----------------------------------------------------------------------------
 * LO QUE YA SE LE PREGUNTÓ A GOOGLE, GUARDADO.
 *
 * Del hotel al Partenón andando hay lo que hay, y no va a cambiar. Hasta ahora
 * se le preguntaba a Google cada vez que alguien abría un traslado, y son TRES
 * llamadas por par —una por modo—. Esta capa mira primero aquí.
 *
 * NO SUSTITUYE A `traslados`. Esa tabla sigue siendo el registro por viaje: qué
 * consultó el usuario, desde qué elemento, con los extremos congelados. Esto es
 * la capa de debajo, de catálogo, sin `viaje_id`: borrar el viaje no se lleva lo
 * aprendido, y el viaje siguiente a la misma ciudad lo aprovecha.
 *
 * ───────────────────────────────────────────────────────────────────────────
 * LA CLAVE VA REDONDEADA, Y SI NO, ESTO NO SIRVE DE NADA.
 *
 * Dos geocodificaciones del mismo portal devuelven el sexto decimal distinto. Si
 * la clave fuera lat/lon en crudo, cada consulta abriría fila nueva y la caché
 * no acertaría JAMÁS: sería una tabla que crece y no ahorra una sola llamada.
 *
 * Cinco decimales son ~1 metro. Se guarda LO REDONDEADO, no el original: lo
 * redondeado es la clave, y guardar otra cosa haría que no se encontrara.
 * ───────────────────────────────────────────────────────────────────────────
 *
 * Y LA CADUCIDAD DEPENDE DEL MODO. Andando y coche no caducan. El transporte
 * público sí: `TRANSIT` contesta con los horarios de hoy y de esta hora, así que
 * «45 min en bus» es el bus de un martes de septiembre. Se guarda igual —para
 * orientarse vale— pero se devuelve SIEMPRE con su fecha, para que quien lo
 * enseñe pueda decir de cuándo es. Un tiempo de bus sin fecha es un tiempo que
 * miente sin que se note.
 */

import { todas, una, ejecutar } from '../db/index.js';

/** Cinco decimales ≈ 1 metro. Ver la cabecera: esto es LA clave, no un adorno. */
const DECIMALES = 5;

/** Los modos cuyo dato no envejece. El público no está, y es a propósito. */
const SIN_CADUCIDAD = new Set(['andando', 'coche']);

/** ¿El dato de este modo envejece? Lo usan las pantallas para decidir si datan. */
export const caduca = (modo) => !SIN_CADUCIDAD.has(modo);

const redondear = (n) => Number(Number(n).toFixed(DECIMALES));

const esPunto = (p) =>
  p && Number.isFinite(Number(p.lat)) && Number.isFinite(Number(p.lng));

/**
 * UN NÚMERO, O «NO HAY RUTA». Y `null` NO ES CERO.
 *
 * `Number.isFinite(Number(v))` parecía bastar y no bastaba: `Number(null)` es
 * `0`, y `0` es finito. Así que un «no hay bus entre estos dos puntos» —que
 * viaja como `minutos: null`— se guardaba como **cero minutos**.
 *
 * Bourtzi → Epidauro en transporte público son veintiocho kilómetros, y la caché
 * decía que se tarda cero. Es el mismo defecto que el «Gratis» de las fichas y
 * que la llegada falsa del traslado: un hueco relleno con un número que parece
 * bueno. `''` cae por lo mismo, que también vale cero.
 *
 * Ojo a la asimetría: `Number(undefined)` es `NaN`, que NO es finito, así que
 * `undefined` sí se colaba bien. Solo fallaba el caso que de verdad ocurre.
 */
const numeroOSinRuta = (v) => {
  if (v === null || v === undefined || v === '') return null;
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
};

/**
 * El par, siempre en el mismo orden.
 *
 * Con el menor delante, una fila vale para ir y para volver: el tiempo de A a B
 * andando es el de B a A. El criterio concreto —lat y, a igualdad, lon— da
 * exactamente igual mientras sea SIEMPRE el mismo, que es lo que garantiza el
 * CHECK de la tabla.
 */
function ordenar(a, b) {
  const p = { lat: redondear(a.lat), lon: redondear(a.lng) };
  const q = { lat: redondear(b.lat), lon: redondear(b.lng) };
  const primeroEsMenor = p.lat < q.lat || (p.lat === q.lat && p.lon <= q.lon);
  return primeroEsMenor ? [p, q] : [q, p];
}

/**
 * Lo que la caché sepa de este par, por modo.
 *
 * Devuelve un Map `modo → { modo, minutos, km, fuente, calculadoEn, caduca }`.
 * Un modo que no esté en el Map es un modo que hay que preguntar; un modo con
 * `minutos: null` es «se preguntó y no hay forma de ir así», que es una
 * respuesta y no un hueco: guardarla evita volver a preguntar lo mismo.
 */
export function loQueSeSabe(a, b, modos) {
  if (!esPunto(a) || !esPunto(b)) return new Map();

  const [p, q] = ordenar(a, b);
  const filas = todas(
    `SELECT * FROM distancias_puntos
      WHERE a_lat = ? AND a_lon = ? AND b_lat = ? AND b_lon = ?
        AND modo IN (${modos.map(() => '?').join(',')})`,
    p.lat,
    p.lon,
    q.lat,
    q.lon,
    ...modos
  );

  return new Map(
    filas.map((f) => [
      f.modo,
      {
        modo: f.modo,
        minutos: f.minutos,
        km: f.km,
        fuente: f.fuente,
        calculadoEn: f.calculado_en,
        // Va en el propio dato para que quien lo pinte no tenga que saberse la
        // lista de modos que envejecen.
        caduca: caduca(f.modo),
        deLaCache: true,
      },
    ])
  );
}

/**
 * Guarda lo que Google acaba de contestar.
 *
 * `ON CONFLICT` y no un INSERT a secas: si el mismo par se pregunta otra vez
 * —porque era de transporte público y alguien lo ha refrescado— lo que vale es
 * la respuesta nueva, con su fecha nueva.
 */
export function guardar(a, b, resultados) {
  if (!esPunto(a) || !esPunto(b) || !resultados?.length) return 0;

  const [p, q] = ordenar(a, b);
  let guardadas = 0;

  for (const r of resultados) {
    if (!r?.modo) continue;

    // EL «SIN RUTA» SE GUARDA, Y SE GUARDA COMO LO QUE ES.
    //
    // Guardarlo es deliberado —lo explican `loQueSeSabe` aquí arriba y el propio
    // `calcularVariasRutas`—: «no hay bus entre estos dos puntos» es una
    // respuesta de Google, y no apuntarla condena a preguntarla en cada visita.
    // Es el caso más frecuente, el transporte público fuera de una ciudad.
    //
    // Lo que no puede es guardarse como un cero. `minutos: null` sale de aquí
    // como `null`, y `deLaCache` ya sabe leerlo: filtra por `minutos != null`.
    const minutos = numeroOSinRuta(r.minutos);
    const km = numeroOSinRuta(r.km);

    ejecutar(
      `INSERT INTO distancias_puntos (a_lat, a_lon, b_lat, b_lon, modo, minutos, km, fuente, calculado_en)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, datetime('now'))
       ON CONFLICT (a_lat, a_lon, b_lat, b_lon, modo) DO UPDATE SET
         minutos = excluded.minutos,
         km = excluded.km,
         fuente = excluded.fuente,
         calculado_en = datetime('now')`,
      p.lat,
      p.lon,
      q.lat,
      q.lon,
      r.modo,
      minutos == null ? null : Math.round(minutos),
      km,
      r.fuente ?? 'google'
    );
    guardadas += 1;
  }

  return guardadas;
}

/**
 * CERO MINUTOS ENTRE DOS PUNTOS DISTINTOS NO ES UN TIEMPO.
 *
 * Es el rastro del fallo de `guardar`: un «no hay ruta» convertido en número. Y
 * el detector es más barato que la causa —una consulta, sin preguntarle nada a
 * nadie— así que se queda aunque la causa esté cerrada: si otro camino vuelve a
 * meter un cero, esto lo enseña.
 *
 * Solo se mira `minutos`. Un `km` de cero SÍ es legítimo: dos portales a ochenta
 * metros redondean a cero kilómetros y tardan un minuto, y hay filas así.
 *
 * Y solo entre puntos DISTINTOS: un par consigo mismo en cero es la verdad.
 */
export function cerosQueMienten() {
  return todas(
    `SELECT * FROM distancias_puntos
      WHERE minutos = 0
        AND NOT (a_lat = b_lat AND a_lon = b_lon)
      ORDER BY a_lat, a_lon, b_lat, b_lon, modo`
  );
}

/** Cuántos pares y filas hay guardados. Para la pantalla de mantenimiento. */
export function cuantoSeSabe() {
  const n = una('SELECT COUNT(*) AS filas FROM distancias_puntos');
  const pares = una(
    'SELECT COUNT(*) AS n FROM (SELECT DISTINCT a_lat, a_lon, b_lat, b_lon FROM distancias_puntos)'
  );
  return { filas: n?.filas ?? 0, pares: pares?.n ?? 0 };
}

export default { loQueSeSabe, guardar, caduca, cuantoSeSabe, cerosQueMienten };
