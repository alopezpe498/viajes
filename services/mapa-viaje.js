/**
 * services/mapa-viaje.js
 * -----------------------------------------------------------------------------
 * EL MAPA MAESTRO: el viaje entero en un solo mapa.
 *
 * Cuatro vistas para cuatro preguntas distintas, y esa es toda la idea:
 *
 *   Día            · ¿cómo me muevo hoy?
 *   Etapa          · ¿qué hago en esta ciudad y en qué orden?
 *   Ruta           · ¿cómo es el esqueleto del viaje?
 *   Ruta expandida · ¿qué pinta tiene esto entero?
 *
 * NO SUSTITUYE AL MAPA DE ETAPA. Aquél contesta otra cosa —a qué distancia del
 * hotel está cada cosa de UNA parada, con los traslados ya calculados— y sigue
 * donde estaba. Éste es el de arriba, el del viaje completo.
 *
 * ES DE LECTURA PURA. No escribe nada del viaje: ni coloca, ni mueve, ni borra.
 * La única escritura que hace es geocodificar un hotel que no tuviera punto, y
 * eso no es del viaje: es rellenar la ficha de una dirección que ya estaba
 * escrita, en la tabla donde viven todas.
 *
 * DE DÓNDE SALE CADA COSA
 * -----------------------------------------------------------------------------
 *   ciudades  · las etapas confirmadas, con sus noches y sus días.
 *   items     · los bloques del lienzo (`itinerario`), con su día y su hora.
 *   puntos    · `direcciones` primero, y el catálogo después —`sitios_lugar` y
 *               `puntos_interes` traen lat/lon de serie—. Ese orden lo compartía
 *               con el mapa pequeño de etapa, que ya no existe: este es el único
 *               mapa, y por eso este es el único sitio donde se sitúa nada.
 *   traslados · los `transportes` entre etapas, con su precio ya en €/persona.
 *
 * LA REGLA DE HONESTIDAD, que aquí tiene una forma muy concreta: NADA se pinta
 * sin coordenadas reales. Lo que no se pueda situar —una geocodificación que
 * falló, una comida que solo tiene zona («Comer · Casco Viejo») y no un
 * restaurante concreto— sale en la lista del panel con su día y su hora y la
 * etiqueta «sin ubicar en el mapa», pero SIN pin. Un pin en el centro de la
 * ciudad «porque por ahí anda» es exactamente la clase de dato inventado que
 * este proyecto no se permite.
 */
import { todas, una } from '../db/index.js';
import { lienzoDeViaje } from './lienzo.js';
import {
  direccionesDe,
  claveDeCandidato,
  volcarDireccionDeHotel,
  geocodificarFila,
  direccionDe,
  situarActividadConPlaces,
  TIPOS_CON_DIRECCION,
} from './direcciones.js';

/**
 * LOS TIPOS QUE SE PINTAN, con su cara.
 *
 * El color vive aquí y no en el CSS porque el marcador se dibuja en el cliente a
 * partir de esto, y porque la leyenda lo lee del mismo sitio: un color que se
 * escriba dos veces acaba siendo dos colores.
 *
 * Eran los mismos cuatro que los del mapa pequeño de etapa —dos listas iguales
 * escritas dos veces—. Al quedarse este como único mapa, esta es la lista.
 */
export const TIPOS_DEL_MAPA = {
  sitio: { etiqueta: 'Sitios', singular: 'Sitio', icono: 'ti-map-pin', color: '#2E9E7B' },
  comer: { etiqueta: 'Comidas', singular: 'Comida', icono: 'ti-tools-kitchen-2', color: '#C25B3F' },
  actividad: { etiqueta: 'Excursiones', singular: 'Excursión', icono: 'ti-ticket', color: '#8A5A16' },
  hotel: { etiqueta: 'Hoteles', singular: 'Hotel', icono: 'ti-bed', color: '#1B7FA6' },
};

/** Cómo se pinta cada medio en la línea de traslado. */
const ICONO_DE_MEDIO = {
  vuelo: 'ti-plane', avion: 'ti-plane',
  tren: 'ti-train',
  bus: 'ti-bus', autobus: 'ti-bus',
  coche: 'ti-car', taxi: 'ti-car', traslado: 'ti-car',
  ferry: 'ti-ship', barco: 'ti-ship',
};

const num = (v) => (Number.isFinite(Number(v)) ? Number(v) : null);

/** "330" -> "5 h 30". El mismo formato que usan los tramos y la ruta. */
function comoDuracion(minutos) {
  const m = num(minutos);
  if (m == null || m <= 0) return null;
  const h = Math.floor(m / 60);
  const r = Math.round(m % 60);
  if (!h) return `${r} min`;
  return r ? `${h} h ${String(r).padStart(2, '0')}` : `${h} h`;
}

// =============================================================================
// COORDENADAS
// =============================================================================
/**
 * El punto que trae de serie una fila de catálogo.
 *
 * Los sitios lo tienen —la investigación de la ciudad los guarda con lat/lon— y
 * por eso la mayoría del mapa se pinta sin geocodificar nada. Las excursiones y
 * los restaurantes dependen de que alguien haya situado su dirección.
 */
function puntoDelCatalogo(tipo, id) {
  const tabla = tipo === 'punto' ? 'puntos_interes' : tipo === 'sitio' ? 'sitios_lugar' : null;
  if (!tabla) return null;

  const fila = una(`SELECT lat, lon FROM ${tabla} WHERE id = ?`, id);
  if (!fila || fila.lat == null || fila.lon == null) return null;
  return { lat: Number(fila.lat), lon: Number(fila.lon) };
}

/**
 * EL HOTEL, QUE ES EL ÚNICO QUE HAY QUE IR A BUSCAR.
 *
 * EL AGUJERO QUE ESTO TAPA. `providers/booking.js` guarda zona, dirección y
 * distancia al centro, pero NUNCA lat/lon —es el mismo hueco que hizo saltar el
 * falso aviso de «duermes en Centro histórico y el plan no pasa por allí»—, así
 * que un hotel recién elegido no se puede pintar. Tiene la dirección delante,
 * eso sí, escrita por el scraping.
 *
 * Se geocodifica UNA VEZ y se guarda. La tabla `direcciones` es la caché: la
 * segunda vez que se abra el mapa, `direccionesDe` ya lo devuelve situado y aquí
 * no se entra. Por eso esto se puede llamar en cada carga sin miedo.
 *
 * Y SE ESPERA A QUE TERMINE, en vez de encolarlo en el worker. Son uno o dos
 * hoteles por viaje y una sola vez en la vida del viaje; encolarlo significaría
 * que la primera vez que abres el mapa tu hotel no está, que es justo la primera
 * impresión que no interesa dar. Si falla, se sigue sin él y sale en la lista
 * como «sin ubicar en el mapa», que es la verdad.
 */
async function situarLosHoteles(candidatosHotel, di) {
  for (const c of candidatosHotel) {
    // `situada` es lo que hay que mirar, no si existe la fila: una dirección
    // escrita y sin geocodificar existe y no sirve para pintar nada.
    if (direccionDe('hotel', c.id)?.situada) continue;

    // La dirección del scraping, volcada a su ficha si aún no estaba.
    volcarDireccionDeHotel(c, { nombreCiudad: c.nombre_ciudad ?? null });

    const d = direccionDe('hotel', c.id);
    if (!d || d.situada || !d.direccion) continue;

    try {
      await geocodificarFila(d.id);
      di?.(`[mapa-viaje] hotel «${c.titulo}» situado y guardado: no se repetirá.`);
    } catch (err) {
      di?.(`[mapa-viaje] no pude situar «${c.titulo}» (${err.message}); irá sin pin.`);
    }
  }
}

// =============================================================================
// EL MAPA
// =============================================================================
/**
 * TODO lo que la pantalla necesita, en un solo objeto.
 *
 * Se devuelve masticado —los días ya numerados, los items ya con su ciudad y su
 * hora, los traslados ya con su etiqueta escrita— para que el cliente solo tenga
 * que filtrar y pintar. La aritmética de qué va con qué se hace aquí, en código,
 * como todo lo demás en esta casa.
 */
export async function mapaDeViaje(viajeId) {
  const viaje = una('SELECT * FROM viajes WHERE id = ?', viajeId);
  if (!viaje) return null;

  const lienzo = lienzoDeViaje(viajeId);
  if (!lienzo) return null;

  const etapas = todas(
    `SELECT * FROM etapas
      WHERE viaje_id = ? AND estado = 'confirmada'
      ORDER BY orden, id`,
    viajeId
  );

  // --- 1) LAS CIUDADES ----------------------------------------------------
  // El punto de la ciudad sale de su punto de interés, que es de donde lo saca
  // todo lo demás: es el mismo que usó el mapamundi para colocarla.
  const diasDeEtapa = new Map();
  for (const d of lienzo.dias ?? []) {
    if (!diasDeEtapa.has(d.etapaId)) diasDeEtapa.set(d.etapaId, []);
    diasDeEtapa.get(d.etapaId).push(d.n);
  }

  const ciudades = etapas.map((e, i) => {
    const p = e.punto_interes_id ? puntoDelCatalogo('punto', e.punto_interes_id) : null;
    return {
      id: `e${e.id}`,
      etapaId: e.id,
      orden: i + 1,
      nombre: e.nombre_ciudad,
      noches: e.noches,
      dias: diasDeEtapa.get(e.id) ?? [],
      fechaInicio: e.fecha_inicio,
      fechaFin: e.fecha_fin,
      lat: p?.lat ?? null,
      lon: p?.lon ?? null,
    };
  });

  // --- 2) LOS HOTELES, ANTES DE NADA --------------------------------------
  // Se sitúan primero porque el resto del armado ya los quiere con punto.
  const hoteles = todas(
    `SELECT c.*, e.nombre_ciudad
       FROM candidatos c
       JOIN etapas e ON e.id = c.etapa_id
      WHERE e.viaje_id = ? AND c.tipo = 'hotel' AND c.marcado = 1`,
    viajeId
  );
  await situarLosHoteles(hoteles, (t) => console.log(t));

  // --- 3) LO CRUDO: hoteles + lo colocado en el lienzo ---------------------
  const crudos = [];

  for (const h of hoteles) {
    const ciudad = ciudades.find((c) => c.etapaId === h.etapa_id);
    crudos.push({
      id: `h${h.id}`,
      tipo: 'hotel',
      nombre: h.titulo,
      etapaId: h.etapa_id,
      ciudadId: ciudad?.id ?? null,
      // El hotel no es una parada del día: no tiene hora ni entra en el
      // recorrido. Se enseña porque es la base contra la que se lee todo.
      dia: null,
      hora: null,
      duracion: null,
      detalle: `${h.etapa_id && ciudad ? `${ciudad.noches} ${ciudad.noches === 1 ? 'noche' : 'noches'}` : ''}`,
      dir: { tipo: 'hotel', id: h.id },
    });
  }

  // LOS BLOQUES DEL LIENZO, Y CÓMO SE LES PONE TIPO.
  //
  // El lienzo tiene sus propios tipos y no son los del mapa. Dos traducciones:
  //
  //   · LAS COMIDAS SON «manual». No son un candidato: el orquestador las
  //     escribe a mano como «Comer · Casco Viejo, cerca del hotel», que es una
  //     ZONA y no un restaurante. Se reconocen igual que en el lienzo —por el
  //     «Comer» de delante, misma regla y mismo sitio— y se les da el tipo
  //     `comer` para que la casilla de Comidas las controle y lleven su icono.
  //     Casi ninguna tendrá punto, y eso está bien: saldrán en la lista con su
  //     hora y la etiqueta de «sin ubicar», que es exactamente lo que son.
  //
  //   · UN VUELO O UN TREN NO SON UNA PARADA. No tienen un punto en el mapa:
  //     son la línea entre dos ciudades, y esa se pinta aparte. Se marcan como
  //     `fijo` para que la lista los enseñe con su hora —«a las 15:00 se vuela»
  //     es información del día— sin que ninguna casilla pueda hacerlos
  //     desaparecer, porque no hay casilla para ellos.
  const esComer = (n) => /^comer\b/i.test(String(n ?? ''));

  for (const b of lienzo.colocados ?? []) {
    const ciudad = ciudades.find((c) => c.etapaId === b.etapaId);

    let tipo;
    if (b.tipo === 'traslado') tipo = 'fijo';
    else if (b.tipo === 'manual') tipo = esComer(b.nombre) ? 'comer' : 'fijo';
    else tipo = b.tipo;

    let dir = null;
    if (b.candidatoId) {
      const cand = una('SELECT * FROM candidatos WHERE id = ?', b.candidatoId);
      dir = cand ? claveDeCandidato(cand) : null;
    }

    crudos.push({
      id: `i${b.id}`,
      tipo,
      nombre: b.nombre,
      etapaId: b.etapaId,
      ciudadId: ciudad?.id ?? null,
      dia: b.dia,
      hora: b.hora,
      duracion: b.duracion ?? null,
      detalle: [
        b.dia ? `Día ${b.dia}` : null,
        comoDuracion(b.duracion),
      ].filter(Boolean).join(' · '),
      dir,
    });
  }

  // --- 3b) LAS EXCURSIONES, QUE TAMPOCO TRAEN COORDENADAS -----------------
  //
  // Civitatis no las da —ni dirección: `punto_encuentro` viene vacío—, así que
  // sin esto TODAS salían del mapa con «sin ubicar», Auschwitz incluida, que es
  // el motivo por el que media Europa va a Cracovia. Se buscan por su nombre en
  // Places, una vez en la vida de cada una, con los dos guardianes que hay en
  // `situarActividadConPlaces`: tiene que ser un sitio y no una zona, y tiene que
  // caer a distancia de excursión. Lo que no case se queda sin ubicar.
  const porSituar = crudos.filter(
    (c) => c.dir?.tipo === 'actividad' && !direccionDe('actividad', c.dir.id)
  );
  for (const c of porSituar) {
    const ciudad = ciudades.find((x) => x.id === c.ciudadId);
    await situarActividadConPlaces(c.dir.id, {
      cerca: ciudad?.lat != null ? { lat: ciudad.lat, lon: ciudad.lon } : null,
    });
  }

  // --- 4) RESOLVER EL PUNTO DE CADA UNO -----------------------------------
  // Las direcciones se piden de golpe por tipo: una consulta por tipo en vez de
  // una por elemento, que con un viaje de cuarenta bloques se nota.
  const porTipo = new Map();
  for (const c of crudos) {
    if (!c.dir) continue;
    if (!porTipo.has(c.dir.tipo)) porTipo.set(c.dir.tipo, []);
    porTipo.get(c.dir.tipo).push(c.dir.id);
  }
  const direcciones = new Map();
  for (const [tipo, ids] of porTipo) {
    if (!TIPOS_CON_DIRECCION[tipo]) continue;
    for (const [id, d] of direccionesDe(tipo, ids)) direcciones.set(`${tipo}:${id}`, d);
  }

  const items = [];
  for (const c of crudos) {
    const d = c.dir ? direcciones.get(`${c.dir.tipo}:${c.dir.id}`) ?? null : null;
    const punto =
      (d?.situada ? { lat: Number(d.punto.lat), lon: Number(d.punto.lng ?? d.punto.lon) } : null) ??
      (c.dir ? puntoDelCatalogo(c.dir.tipo, c.dir.id) : null);

    items.push({
      id: c.id,
      tipo: c.tipo,
      nombre: c.nombre,
      detalle: c.detalle || null,
      ciudadId: c.ciudadId,
      etapaId: c.etapaId,
      dia: c.dia,
      hora: c.hora,
      duracion: c.duracion,
      lat: punto?.lat ?? null,
      lon: punto?.lon ?? null,
      // LA ETIQUETA DE LA HONESTIDAD. `false` es «tiene pin»; `true` es «sale en
      // la lista y se dice que no se pudo situar». No hay un tercer estado en el
      // que se le invente una posición.
      sinUbicar: !(punto && Number.isFinite(punto.lat) && Number.isFinite(punto.lon)),
      direccion: d?.direccion ?? null,
      // CON QUÉ SE HA CASADO, cuando no es evidente. Una excursión situada por
      // su nombre se pinta en el sitio que Google entendió —«Campo de
      // concentración de Auschwitz»— y quien mire el mapa tiene derecho a saber
      // cuál es ese sitio, porque el nombre del pin dice otra cosa.
      situadaComo: d?.mensaje ?? null,
    });
  }

  // --- 5) LOS TRASLADOS ENTRE CIUDADES ------------------------------------
  // El precio ya viene normalizado a €/persona por el correctivo de las
  // monedas: aquí solo se traduce el ámbito, que es la última aritmética.
  const personas = Math.max(1, (num(viaje.adultos) || 0) + (num(viaje.ninos) || 0));

  const traslados = todas(
    `SELECT t.*, o.id AS oid, d.id AS did
       FROM transportes t
       JOIN etapas o ON o.id = t.etapa_origen_id
       JOIN etapas d ON d.id = t.etapa_destino_id
      WHERE t.viaje_id = ?
      ORDER BY o.orden`,
    viajeId
  ).map((t) => {
    const precio = num(t.precio_estimado);
    const porPersona =
      precio == null ? null : t.precio_ambito === 'por_grupo' ? precio / personas : precio;

    return {
      id: `t${t.id}`,
      deCiudadId: `e${t.etapa_origen_id}`,
      aCiudadId: `e${t.etapa_destino_id}`,
      medio: t.tipo,
      icono: ICONO_DE_MEDIO[String(t.tipo ?? '').toLowerCase()] ?? 'ti-arrow-right',
      duracion: comoDuracion(t.duracion_min),
      // Sin precio no se escribe un cero: se deja en null y la etiqueta lo omite.
      precio: porPersona == null ? null : Math.round(porPersona),
      nota: t.notas ?? null,
    };
  });

  return {
    viaje: {
      id: viaje.id,
      nombre: viaje.nombre,
      destino: viaje.destino,
      dias: (lienzo.dias ?? []).length,
    },
    tipos: TIPOS_DEL_MAPA,
    dias: (lienzo.dias ?? []).map((d) => ({
      n: d.n,
      fecha: d.fecha,
      fechaCorta: d.fechaCorta,
      ciudad: d.ciudad,
      etapaId: d.etapaId,
      ciudadId: `e${d.etapaId}`,
    })),
    ciudades,
    items,
    traslados,
    // Para poder decirlo en pantalla sin que el cliente lo recuente.
    sinUbicar: items.filter((i) => i.sinUbicar).length,
  };
}

export default { mapaDeViaje, TIPOS_DEL_MAPA };
