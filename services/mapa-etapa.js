/**
 * services/mapa-etapa.js
 * -----------------------------------------------------------------------------
 * EL MAPA DE LA CIUDAD: todo lo que el viaje tiene en esta parada, a la vez.
 *
 * Es un mapa de CONSULTA. Sirve para ver de un vistazo cómo queda repartido lo
 * apuntado respecto al hotel —si el museo está a diez minutos andando o al otro
 * lado del río—, y esa pregunta no se contesta con una lista. Aquí no se añade,
 * no se edita y no se borra: para eso están las otras pestañas.
 *
 * QUÉ SALE: el hotel elegido (que es la referencia), los sitios y excursiones
 * apuntados, y los restaurantes apuntados. Solo lo apuntado: el catálogo entero
 * de restaurantes de la ciudad llenaría el mapa de chinchetas que no son del
 * viaje.
 *
 * DE DÓNDE SALEN LAS COORDENADAS, en este orden:
 *   1. La tabla `direcciones`, cuando el sitio ya está geocodificado.
 *   2. El propio catálogo, para los sitios: `puntos_interes` y `sitios_lugar`
 *      traen lat/lon de serie y no hace falta geocodificar nada.
 *
 * Lo que no tenga ninguna de las dos se queda fuera del mapa y se cuenta aparte,
 * para poder decir cuántos faltan en vez de que desaparezcan sin más.
 */
import { todas, una, normalizarNombre } from '../db/index.js';
import { direccionesDe, claveDeCandidato, TIPOS_CON_DIRECCION } from './direcciones.js';

/**
 * Los cuatro tipos que se pintan, con su cara.
 *
 * El color va aquí y no en el CSS porque el marcador se dibuja en el cliente a
 * partir de esto: un sitio donde mirar qué es cada punto del mapa.
 */
export const TIPOS_DEL_MAPA = {
  hotel: { etiqueta: 'Hotel', icono: 'ti-bed', color: '#1B7FA6' },
  sitio: { etiqueta: 'Sitio', icono: 'ti-map-pin', color: '#2E9E7B' },
  actividad: { etiqueta: 'Excursión', icono: 'ti-ticket', color: '#8A5A16' },
  comer: { etiqueta: 'Comer', icono: 'ti-tools-kitchen-2', color: '#C25B3F' },
};

// =============================================================================
// COORDENADAS
// =============================================================================
/**
 * El punto de una fila de catálogo, cuando lo trae de serie.
 *
 * Los sitios lo tienen: vienen de la investigación de la ciudad con sus
 * coordenadas. Los restaurantes y las excursiones no, y dependen de que se haya
 * geocodificado su dirección.
 */
function puntoDelCatalogo(tipo, id) {
  const tabla = tipo === 'punto' ? 'puntos_interes' : tipo === 'sitio' ? 'sitios_lugar' : null;
  if (!tabla) return null;

  const fila = una(`SELECT lat, lon FROM ${tabla} WHERE id = ?`, id);
  if (!fila || fila.lat == null || fila.lon == null) return null;
  return { lat: fila.lat, lng: fila.lon };
}

// =============================================================================
// DISTANCIAS DESDE EL HOTEL
// =============================================================================
/** "andando" primero: es la pregunta que se hace mirando un mapa de ciudad. */
const ORDEN_DE_MODOS = ['andando', 'publico', 'coche', 'taxi'];

/**
 * Cuánto hay del hotel a cada cosa, de lo que YA está calculado.
 *
 * No se calcula nada aquí: se leen los traslados que se guardaron cuando se
 * consultaron desde la pestaña "Moverse" o desde las fichas. Este mapa no
 * dispara ni una petición a Google; enseña lo que hay y calla lo que no.
 *
 * Devuelve un Map de "tipo:id" -> { texto, etiqueta, icono, modo }.
 */
function distanciasDesdeElHotel(hotel, elementos) {
  const desdeElHotel = new Map();
  if (!hotel) return desdeElHotel;

  const filas = todas(
    `SELECT * FROM traslados
      WHERE (origen_tipo = 'hotel' AND origen_id = ?)
         OR (destino_tipo = 'hotel' AND destino_id = ?)
      ORDER BY id DESC`,
    hotel.id,
    hotel.id
  );

  const interesan = new Set(elementos.map((e) => `${e.tipo}:${e.id}`));

  for (const t of filas) {
    // El otro extremo del traslado: el que no es el hotel.
    const esOrigenElHotel = t.origen_tipo === 'hotel' && Number(t.origen_id) === hotel.id;
    const otroTipo = esOrigenElHotel ? t.destino_tipo : t.origen_tipo;
    const otroId = Number(esOrigenElHotel ? t.destino_id : t.origen_id);
    const clave = `${otroTipo}:${otroId}`;

    if (!interesan.has(clave)) continue;
    // Las filas vienen de la más nueva a la más vieja: la primera que aparece
    // de cada sitio es la buena y las demás son consultas anteriores.
    if (desdeElHotel.has(clave)) continue;

    let resultados = [];
    try {
      resultados = t.resultados ? (JSON.parse(t.resultados) ?? []) : [];
    } catch {
      /* resultados corruptos: ese traslado se queda sin distancia */
    }
    if (!resultados.length) continue;

    const mejor =
      ORDEN_DE_MODOS.map((m) => resultados.find((r) => r.modo === m)).find(Boolean) ??
      resultados[0];
    if (!mejor) continue;

    desdeElHotel.set(clave, {
      modo: mejor.modo,
      minutos: mejor.minutos ?? null,
      km: mejor.km ?? null,
      estimado: mejor.fuente === 'estimado',
    });
  }

  return desdeElHotel;
}

// =============================================================================
// LO QUE PIDE LA PANTALLA
// =============================================================================
/**
 * TODO LO DE ESTA PARADA, LISTO PARA PINTAR.
 *
 * La lista sale plana y con la misma forma para los cuatro tipos, a propósito:
 * el cliente pinta marcadores a partir de esta lista sin saber de dónde vino
 * cada uno. Eso es lo que deja la puerta abierta a pintar mañana el recorrido
 * de un día —la misma lista, con un `orden` puesto— sin tocar el pintado.
 */
export function mapaDeEtapa(etapaId) {
  const etapa = una('SELECT * FROM etapas WHERE id = ?', Number(etapaId));
  if (!etapa) return null;

  /** [{tipo, id, nombre, claveDireccion:{tipo,id}}] antes de resolver puntos. */
  const crudos = [];

  // --- El hotel elegido, que es la referencia -----------------------------
  const hotel = una(
    "SELECT * FROM candidatos WHERE etapa_id = ? AND tipo = 'hotel' AND marcado = 1",
    etapa.id
  );
  if (hotel) {
    crudos.push({ tipo: 'hotel', id: hotel.id, nombre: hotel.titulo, dir: { tipo: 'hotel', id: hotel.id } });
  }

  // --- Sitios y excursiones apuntados -------------------------------------
  // La dirección y las coordenadas viven en su fila de CATÁLOGO, no en el
  // candidato: el candidato es "esto lo quiero", el catálogo es "esto es".
  for (const c of todas(
    "SELECT * FROM candidatos WHERE etapa_id = ? AND tipo IN ('sitio','actividad') ORDER BY tipo, id",
    etapa.id
  )) {
    const clave = claveDeCandidato(c);
    if (!clave) continue;
    crudos.push({
      // 'punto' y 'sitio' son dos tablas de catálogo distintas, pero para quien
      // mira el mapa las dos son "un sitio".
      tipo: c.tipo === 'actividad' ? 'actividad' : 'sitio',
      id: c.id,
      nombre: c.titulo,
      dir: clave,
    });
  }

  // --- Restaurantes apuntados ---------------------------------------------
  // Apuntados, no todos los de la ciudad: los del catálogo son candidatos a
  // mirar, y el mapa es de lo que ya está en el viaje.
  for (const c of todas(
    "SELECT * FROM candidatos WHERE etapa_id = ? AND tipo = 'comer' ORDER BY id",
    etapa.id
  )) {
    let deId = null;
    try {
      deId = JSON.parse(c.datos_extra ?? '{}')?.deId ?? null;
    } catch {
      /* datos_extra corrupto: se queda sin ficha de catálogo */
    }
    if (!deId) continue;
    const ficha = una('SELECT * FROM catalogo_comer WHERE id = ?', Number(deId));
    if (!ficha) continue;
    crudos.push({ tipo: 'comer', id: c.id, nombre: ficha.nombre, dir: { tipo: 'comer', id: ficha.id } });
  }

  // --- Resolver el punto de cada uno --------------------------------------
  // Las direcciones se piden de golpe por tipo: una consulta por tipo en vez de
  // una por elemento.
  const porTipo = new Map();
  for (const c of crudos) {
    if (!porTipo.has(c.dir.tipo)) porTipo.set(c.dir.tipo, []);
    porTipo.get(c.dir.tipo).push(c.dir.id);
  }
  const direcciones = new Map();
  for (const [tipo, ids] of porTipo) {
    if (!TIPOS_CON_DIRECCION[tipo]) continue;
    for (const [id, d] of direccionesDe(tipo, ids)) direcciones.set(`${tipo}:${id}`, d);
  }

  const elementos = [];
  const sinSituar = [];

  for (const c of crudos) {
    const d = direcciones.get(`${c.dir.tipo}:${c.dir.id}`) ?? null;
    const punto = (d?.situada ? d.punto : null) ?? puntoDelCatalogo(c.dir.tipo, c.dir.id);

    if (!punto) {
      // SE IGNORA, PERO SE CUENTA. Que un sitio no salga en el mapa sin decir
      // nada hace pensar que el mapa está mal; decir "tres sin situar" hace
      // pensar que faltan tres direcciones, que es la verdad.
      sinSituar.push({ tipo: c.tipo, nombre: c.nombre, esperando: Boolean(d?.buscando) });
      continue;
    }

    elementos.push({
      tipo: c.tipo,
      id: c.id,
      nombre: c.nombre,
      etiqueta: TIPOS_DEL_MAPA[c.tipo]?.etiqueta ?? c.tipo,
      direccion: d?.direccion ?? null,
      punto,
      // Se rellena justo debajo, cuando ya se sabe cuál es el hotel.
      desdeElHotel: null,
      // Hueco para el futuro recorrido de un día: el pintado ya lo lee y lo
      // enseña como número dentro del marcador si viene puesto.
      orden: null,
    });
  }

  // --- Distancias desde el hotel ------------------------------------------
  const elHotel = elementos.find((e) => e.tipo === 'hotel') ?? null;
  if (elHotel) {
    const distancias = distanciasDesdeElHotel(
      { id: elHotel.id },
      // Los traslados guardan el id de la fila de CATÁLOGO, no el del candidato.
      crudos.map((c) => ({ tipo: c.dir.tipo, id: c.dir.id }))
    );

    for (const e of elementos) {
      const c = crudos.find((x) => x.tipo === e.tipo && x.id === e.id);
      if (!c) continue;
      e.desdeElHotel = distancias.get(`${c.dir.tipo}:${c.dir.id}`) ?? null;
    }
  }

  // --- El encuadre --------------------------------------------------------
  // Se manda calculado desde aquí para que el cliente no tenga que decidir nada
  // cuando hay un solo marcador o ninguno.
  const puntos = elementos.map((e) => e.punto);
  const limites = puntos.length
    ? [
        [Math.min(...puntos.map((p) => p.lat)), Math.min(...puntos.map((p) => p.lng))],
        [Math.max(...puntos.map((p) => p.lat)), Math.max(...puntos.map((p) => p.lng))],
      ]
    : null;

  return {
    etapaId: etapa.id,
    ciudad: etapa.nombre_ciudad,
    tipos: TIPOS_DEL_MAPA,
    elementos,
    sinSituar,
    limites,
    // DOS COSAS DISTINTAS, y confundirlas hace que la pantalla mienta:
    //   · `hotelElegido`  hay un hotel marcado en esta parada.
    //   · `hotelEnElMapa` además tiene dirección situada y sale pintado.
    // El caso de en medio existe y es común: hotel elegido cuya dirección no se
    // pudo geocodificar. Decir ahí "no hay hotel elegido" es falso.
    hotelElegido: Boolean(hotel),
    hotelEnElMapa: Boolean(elHotel),
    nombreDelHotel: hotel?.titulo ?? null,
  };
}

export default { mapaDeEtapa, TIPOS_DEL_MAPA };
