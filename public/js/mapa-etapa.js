/**
 * public/js/mapa-etapa.js
 * -----------------------------------------------------------------------------
 * EL MAPA DE LA PARADA: todo lo del viaje en esta ciudad, a la vez.
 *
 * De consulta y nada más. Se mira para saber si el museo está a diez minutos
 * del hotel o al otro lado del río, que es una pregunta que una lista no
 * contesta. Aquí no se añade, no se edita y no se borra.
 *
 * SE MONTA TARDE, Y A PROPÓSITO. Leaflet necesita que su contenedor tenga
 * tamaño para calcular el encuadre, y esta pestaña nace oculta: montarlo al
 * cargar la página daría un mapa de cero píxeles con los marcadores amontonados
 * en una esquina. Se monta la primera vez que se abre la pestaña, y si el
 * servidor la pintó ya abierta —`?p=mapa`—, al cargar.
 *
 * PARAMETRIZABLE A PROPÓSITO. `pintar(lista, opciones)` no sabe de dónde sale
 * la lista ni qué representa: pinta lo que le den. Por eso el día que esto
 * tenga que enseñar el recorrido de UN día con las paradas numeradas, basta con
 * pasarle la lista de ese día con su `orden` puesto y encender la línea. El
 * pintado no hay que tocarlo.
 */
(() => {
  const div = document.getElementById('mapa-etapa');
  if (!div || typeof L === 'undefined') return;

  let datos;
  try {
    datos = JSON.parse(div.dataset.mapa ?? '{}');
  } catch {
    console.error('[mapa-etapa] los datos del mapa no son JSON válido');
    return;
  }

  const leyenda = document.getElementById('mapa-etapa-leyenda');
  const panel = document.getElementById('sub-mapa') ?? document.getElementById('panel-mapa');

  let mapa = null;
  let capa = null;

  const esc = (t) => {
    const d = document.createElement('div');
    d.textContent = t ?? '';
    return d.innerHTML;
  };

  // ===========================================================================
  // EL MARCADOR
  // ===========================================================================
  /**
   * Un marcador de los nuestros: HTML, no una imagen.
   *
   * Así lleva los colores del tema y el icono de Tabler que ya usa el resto de
   * la app, en vez de la chincheta azul de Leaflet. El hotel va más grande
   * porque es la referencia contra la que se lee todo lo demás.
   *
   * Si el elemento trae `orden`, el marcador enseña el número en vez del icono.
   * Eso es lo que hará falta el día que esto pinte el recorrido de un día, y por
   * eso está puesto ya: es una línea, y quitarla luego sería rehacerlo.
   */
  function iconoDe(elemento) {
    const t = datos.tipos?.[elemento.tipo] ?? {};
    const esHotel = elemento.tipo === 'hotel';
    const dentro =
      elemento.orden != null
        ? `<span class="marca-mapa__n">${esc(String(elemento.orden))}</span>`
        : `<i class="ti ${esc(t.icono ?? 'ti-map-pin')}" aria-hidden="true"></i>`;

    return L.divIcon({
      className: '',
      html:
        `<span class="marca-mapa ${esHotel ? 'marca-mapa--hotel' : ''}" ` +
        `style="--marca:${esc(t.color ?? '#1B7FA6')}">${dentro}</span>`,
      iconSize: esHotel ? [38, 38] : [30, 30],
      iconAnchor: esHotel ? [19, 19] : [15, 15],
      popupAnchor: [0, esHotel ? -20 : -16],
    });
  }

  /** Lo que se lee al pulsar un marcador. Nombre, tipo y a cuánto está. */
  function globoDe(elemento) {
    const t = datos.tipos?.[elemento.tipo] ?? {};
    const d = elemento.desdeElHotel;

    let distancia;
    if (elemento.tipo === 'hotel') {
      distancia = '<span class="globo-mapa__ref">Desde aquí se miden las distancias</span>';
    } else if (d && d.minutos != null) {
      const km = d.km != null ? ` · ${esc(comoDistancia(d.km))}` : '';
      distancia =
        `<span class="globo-mapa__dist">${d.estimado ? '~' : ''}${esc(String(d.minutos))} min ` +
        `${esc(comoModo(d.modo))}${km} desde el hotel</span>`;
    } else if (datos.hotelEnElMapa) {
      distancia = '<span class="globo-mapa__sin">Sin distancia calculada desde el hotel</span>';
    } else if (datos.hotelElegido) {
      distancia =
        '<span class="globo-mapa__sin">El hotel no está situado, así que no hay ' +
        'distancia que medir</span>';
    } else {
      distancia = '<span class="globo-mapa__sin">No hay hotel elegido en esta parada</span>';
    }

    return (
      '<div class="globo-mapa">' +
      `<span class="globo-mapa__tipo" style="--marca:${esc(t.color ?? '#1B7FA6')}">` +
      `<i class="ti ${esc(t.icono ?? 'ti-map-pin')}" aria-hidden="true"></i> ${esc(elemento.etiqueta)}</span>` +
      `<strong class="globo-mapa__nombre">${esc(elemento.nombre)}</strong>` +
      distancia +
      '</div>'
    );
  }

  const MODOS = {
    andando: 'andando',
    coche: 'en coche',
    publico: 'en transporte público',
    taxi: 'en taxi',
  };
  const comoModo = (m) => MODOS[m] ?? m ?? '';

  /**
   * "420 m", "1,4 km". Nunca "0.42315836220747927 km", que es lo que salía.
   *
   * Por debajo del kilómetro se dice en metros y redondeado a la decena: en un
   * mapa de ciudad la diferencia entre 420 y 423 metros no existe, y los
   * decimales solo hacen ruido. La coma es la nuestra, no el punto.
   */
  function comoDistancia(km) {
    const n = Number(km);
    if (!Number.isFinite(n) || n <= 0) return '';
    if (n < 1) return `${Math.round((n * 1000) / 10) * 10} m`;
    return `${n.toFixed(1).replace('.', ',')} km`;
  }

  // ===========================================================================
  // PINTAR
  // ===========================================================================
  /**
   * Pinta una lista de elementos. La función no sabe qué son ni de dónde salen.
   *
   * @param {Array}  lista            elementos con {tipo, nombre, punto, ...}
   * @param {object} opciones
   * @param {boolean} opciones.unir   unir los puntos con una línea, en el orden
   *                                  de la lista. Para el recorrido de un día.
   * @param {boolean} opciones.encuadrar  ajustar la vista a lo pintado.
   */
  function pintar(lista, { unir = false, encuadrar = true } = {}) {
    capa.clearLayers();

    const conPunto = (lista ?? []).filter((e) => e.punto);
    if (!conPunto.length) return;

    for (const e of conPunto) {
      L.marker([e.punto.lat, e.punto.lng], {
        icon: iconoDe(e),
        title: e.nombre,
        // El hotel por encima: es la referencia y no debe quedar tapado.
        zIndexOffset: e.tipo === 'hotel' ? 1000 : 0,
      })
        .bindPopup(globoDe(e))
        .addTo(capa);
    }

    // De momento nadie la enciende. Está aquí porque el recorrido de un día es
    // exactamente esto con `unir: true`, y dejarlo escrito ahora cuesta cinco
    // líneas y no obliga a volver a este archivo.
    if (unir && conPunto.length > 1) {
      L.polyline(
        conPunto.map((e) => [e.punto.lat, e.punto.lng]),
        { color: '#1B7FA6', weight: 2.5, opacity: 0.65, dashArray: '6 5', interactive: false }
      ).addTo(capa);
    }

    if (encuadrar) encuadrarEn(conPunto);
  }

  /**
   * Que se vea todo.
   *
   * Con un solo marcador `fitBounds` deja un cuadro de área cero y el mapa se va
   * al zoom máximo, que en una ciudad significa ver una acera. Con uno se centra
   * y se pone un zoom de barrio, que es lo útil.
   */
  function encuadrarEn(lista) {
    if (!lista.length) return;
    if (lista.length === 1) {
      mapa.setView([lista[0].punto.lat, lista[0].punto.lng], 15);
      return;
    }
    mapa.fitBounds(
      lista.map((e) => [e.punto.lat, e.punto.lng]),
      { padding: [40, 40], maxZoom: 16 }
    );
  }

  // ===========================================================================
  // LA LEYENDA
  // ===========================================================================
  function pintarLeyenda(lista) {
    if (!leyenda) return;
    const presentes = [...new Set(lista.map((e) => e.tipo))];
    leyenda.innerHTML = presentes
      .map((tipo) => {
        const t = datos.tipos?.[tipo] ?? {};
        return (
          `<span class="mapa-leyenda__item"><span class="mapa-leyenda__punto" ` +
          `style="--marca:${esc(t.color ?? '#1B7FA6')}"><i class="ti ${esc(t.icono ?? 'ti-map-pin')}" ` +
          `aria-hidden="true"></i></span>${esc(t.etiqueta ?? tipo)}</span>`
        );
      })
      .join('');
  }

  // ===========================================================================
  // MONTAJE
  // ===========================================================================
  let montado = false;

  function montar() {
    if (montado) return;
    montado = true;

    mapa = L.map(div, { zoomControl: false, scrollWheelZoom: true });
    L.control.zoom({ position: 'topright' }).addTo(mapa);
    capa = L.layerGroup().addTo(mapa);

    // Las mismas teselas que el mapa de destinos, del mismo sitio: Google en
    // español y OpenStreetMap de respaldo, avisando por consola si se cae.
    Teselas.poner(mapa, {
      clave: div.dataset.claveMapas ?? '',
      contexto: `mapa de la etapa (${datos.ciudad ?? ''})`,
    });

    // Un encuadre de partida antes de pintar, para que el mapa no arranque en
    // mitad del Atlántico si algo va mal.
    mapa.setView([40.4168, -3.7038], 12);

    pintar(datos.elementos ?? []);
    pintarLeyenda((datos.elementos ?? []).filter((e) => e.punto));
  }

  /**
   * La pestaña nace oculta y Leaflet no sabe medir un contenedor sin tamaño.
   * `invalidateSize` le dice que vuelva a mirar; sin esto el mapa sale cortado
   * y con el encuadre mal calculado.
   */
  function despertar() {
    if (!montado) {
      montar();
      return;
    }
    mapa.invalidateSize();
    encuadrarEn((datos.elementos ?? []).filter((e) => e.punto));
  }

  // Si el servidor ya la pintó abierta, se monta ahora.
  if (panel && !panel.hidden) montar();

  // Y si no, en cuanto se abra. Se mira el atributo `hidden` del panel en vez
  // de escuchar el clic de la pestaña: así funciona igual venga de un clic, de
  // la URL o del guión que repone la pestaña antes de pintar.
  if (panel) {
    new MutationObserver(() => {
      if (!panel.hidden) despertar();
    }).observe(panel, { attributes: true, attributeFilter: ['hidden'] });
  }

  // Lo dejamos a mano para la fase del recorrido de un día: `MapaEtapa.pintar(
  // paradasDelDia, { unir: true })` y ya está.
  window.MapaEtapa = { pintar, encuadrarEn, montar, datos };
})();
