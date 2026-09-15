/**
 * public/js/mapa-viaje.js
 * -----------------------------------------------------------------------------
 * EL MAPA MAESTRO, por dentro.
 *
 * Cuatro vistas sobre los mismos datos. No hay cuatro mapas: hay uno y un filtro
 * —`visibles()`— que decide qué entra según la vista, el día o la ciudad
 * elegidos y los checks encendidos. Todo lo demás (pintar, listar, encuadrar)
 * trabaja sobre lo que devuelva ese filtro, así que una vista nueva sería una
 * entrada más en VISTAS y una rama más en el filtro.
 *
 * EL SERVIDOR YA HIZO LAS CUENTAS. Aquí no se decide qué día es cada bloque ni
 * cuánto cuesta un traslado: eso viene masticado de `services/mapa-viaje.js`.
 * Este fichero filtra, ordena por hora y pinta.
 *
 * LO QUE NO TIENE COORDENADAS NO SE PINTA. Los items llegan con `sinUbicar`
 * puesto por el servidor y aquí se respeta a rajatabla: van a la lista con su
 * etiqueta y no se les inventa un punto. Es la misma regla de toda la casa,
 * aplicada al único sitio donde inventar sería más fácil que decir la verdad.
 */
(() => {
  const div = document.getElementById('mapa-maestro');
  if (!div || typeof L === 'undefined') return;

  let D;
  try {
    D = JSON.parse(decodeURIComponent(div.dataset.mapa ?? '%7B%7D'));
  } catch {
    console.error('[mapa-viaje] los datos del mapa no son JSON válido');
    return;
  }

  const VIAJE = div.dataset.viaje;

  // ===========================================================================
  // LAS CUATRO VISTAS Y SUS CAPAS
  // ===========================================================================
  /**
   * Cada vista enseña SOLO sus checks.
   *
   * Un check de «Recorrido del día» en la vista de Ruta no hace nada, y un
   * control que no hace nada enseña a desconfiar de los que sí. Por eso la lista
   * de capas es parte de la definición de la vista y no una lista global.
   */
  const VISTAS = {
    dia: { titulo: 'Día', capas: ['sitio', 'comer', 'actividad', 'hotel', 'recorrido'] },
    etapa: { titulo: 'Etapa', capas: ['sitio', 'comer', 'actividad', 'hotel', 'orden'] },
    ruta: { titulo: 'Ruta', capas: ['linea', 'datos'] },
    expandida: { titulo: 'Ruta expandida', capas: ['sitio', 'comer', 'actividad', 'hotel', 'linea', 'datos'] },
  };

  const EXTRA = {
    recorrido: { etiqueta: 'Recorrido del día', color: '#12303E' },
    orden: { etiqueta: 'Orden de visita', color: '#12303E' },
    linea: { etiqueta: 'Líneas de traslado', color: '#16688A' },
    datos: { etiqueta: 'Tiempo y precio', color: '#16688A' },
  };

  const nombreCapa = (c) => D.tipos[c]?.etiqueta ?? EXTRA[c]?.etiqueta ?? c;
  const colorCapa = (c) => D.tipos[c]?.color ?? EXTRA[c]?.color ?? '#1B7FA6';
  const colorTipo = (t) => D.tipos[t]?.color ?? '#5E7A87';
  // Los fijos —el vuelo, el tren— llevan su propio icono: no son una capa, pero
  // en la lista tienen que distinguirse de un sitio de un vistazo.
  const iconoTipo = (t) => D.tipos[t]?.icono ?? (t === 'fijo' ? 'ti-arrow-right' : 'ti-point');

  // ===========================================================================
  // MEMORIA
  // ---------------------------------------------------------------------------
  // Por viaje, no global: uno vuelve al mapa de Polonia esperando el día que
  // estaba mirando, no el de Grecia. Si localStorage no está disponible —modo
  // privado, permisos— la pantalla funciona igual con los valores de arranque.
  // ===========================================================================
  const LLAVE = `mapa-viaje:${VIAJE}`;

  function recordado() {
    try {
      return JSON.parse(localStorage.getItem(LLAVE) ?? '{}') ?? {};
    } catch {
      return {};
    }
  }
  function recordar() {
    try {
      localStorage.setItem(LLAVE, JSON.stringify({ vista, dia, ciudad, capas }));
    } catch {
      /* sin memoria se sigue igual: es una comodidad, no un requisito */
    }
  }

  const previo = recordado();

  /**
   * LO QUE PIDE LA URL MANDA SOBRE LO QUE SE RECORDABA.
   *
   * Al mapa se llega de dos maneras y quieren cosas distintas. Entrando por «Mi
   * ruta» uno vuelve a lo que estaba mirando, y para eso está la memoria.
   * Entrando desde una parada —«enséñame Heraclión»— la memoria es justo lo que
   * estorba: llegabas pidiendo Heraclión y te salía el día de Atenas que mirabas
   * ayer, y el enlace parecía roto.
   *
   * Así que el parámetro gana. Y no se recuerda en ese momento: se recordará al
   * primer cambio que hagas, como cualquier otro.
   */
  const pedido = new URLSearchParams(location.search);

  // SE VALIDA ANTES DE OBEDECER. Un `?dia=99` en un viaje de siete días no es
  // una petición: es un enlace viejo o un dedazo. Hacerle caso a medias —cambiar
  // de vista pero no de día— dejaba la pantalla en la vista de Día enseñando un
  // día que no se había pedido, que es la peor de las tres respuestas posibles.
  const diaPedido = D.dias.some((d) => d.n === Number(pedido.get('dia')))
    ? Number(pedido.get('dia'))
    : null;

  // Una etapa se pide por su id de base de datos; el mapa las nombra `e<id>`.
  const ciudadPedida = D.ciudades.find((c) => c.id === `e${Number(pedido.get('etapa'))}`)?.id ?? null;

  // Con día pedido, la vista es la del día; con etapa, la de la etapa. Pedir un
  // día y quedarse en «Ruta expandida» sería no hacer caso a medias.
  let vista = diaPedido
    ? 'dia'
    : ciudadPedida
      ? 'etapa'
      : (VISTAS[previo.vista] ? previo.vista : 'expandida');

  let dia = diaPedido ?? Number(previo.dia) ?? D.dias[0]?.n ?? 1;

  let ciudad = ciudadPedida
    ?? (D.ciudades.some((c) => c.id === previo.ciudad) ? previo.ciudad : null)
    ?? D.ciudades[0]?.id
    ?? null;

  // LOS DOS SELECTORES SE PONEN DE ACUERDO, aunque solo se haya pedido uno.
  //
  // Pedir un día y dejar la ciudad como estaba deja el selector de ciudad
  // apuntando a otra parada: no se nota en la vista de Día —ahí filtra el día—
  // pero en cuanto se cambia a «Etapa» aparece la ciudad de ayer. Y al revés:
  // pedir una etapa sin día dejaba el día viejo esperando a que alguien mirase.
  if (diaPedido) {
    const suya = D.dias.find((d) => d.n === diaPedido)?.ciudadId;
    if (suya && D.ciudades.some((c) => c.id === suya)) ciudad = suya;
  } else if (ciudadPedida) {
    const suyo = D.dias.find((d) => d.ciudadId === ciudadPedida);
    if (suyo) dia = suyo.n;
  }

  let seleccion = null;

  // Todas encendidas de salida; lo que se recuerde manda por encima.
  const capas = {};
  for (const c of [...Object.keys(D.tipos), ...Object.keys(EXTRA)]) {
    capas[c] = typeof previo.capas?.[c] === 'boolean' ? previo.capas[c] : true;
  }

  // ===========================================================================
  // EL MAPA
  // ===========================================================================
  const mapa = L.map('mapa-maestro', { zoomControl: false });
  L.control.zoom({ position: 'bottomright' }).addTo(mapa);
  // El mundo entero hasta que se encuadre: sin una vista inicial, Leaflet se
  // queja antes de que llegue el primer fitBounds.
  mapa.setView([40, 0], 3);

  window.Teselas?.poner(mapa, {
    clave: div.dataset.claveMapas ?? '',
    contexto: 'mapa maestro del viaje',
  });

  let capa = L.layerGroup().addTo(mapa);

  const esc = (t) => {
    const d = document.createElement('div');
    d.textContent = t ?? '';
    return d.innerHTML;
  };

  // ===========================================================================
  // QUÉ SE VE
  // ===========================================================================
  const ciudadDe = (id) => D.ciudades.find((c) => c.id === id) ?? null;

  /**
   * El filtro, que es el corazón de la pantalla.
   *
   * En la vista de Día, el hotel entra si es el de la ciudad donde se duerme ese
   * día aunque el hotel no tenga día propio: es la base de la jornada, no una
   * parada.
   */
  function visibles() {
    if (vista === 'ruta') return [];

    return D.items.filter((i) => {
      // LOS FIJOS NO TIENEN CASILLA Y NO SE PUEDEN APAGAR. Un vuelo o un tren no
      // son una capa del mapa —no tienen pin— pero sí son información del día:
      // filtrarlos por un check que no existe los haría desaparecer del panel.
      if (i.tipo !== 'fijo' && !capas[i.tipo]) return false;
      if (vista === 'expandida') return true;
      if (vista === 'etapa') return i.ciudadId === ciudad;
      // vista === 'dia'
      if (i.tipo === 'hotel') return ciudadDe(i.ciudadId)?.dias.includes(dia);
      return i.dia === dia;
    });
  }

  /** Lo que se puede pintar: lo visible que además tiene coordenadas. */
  const conPunto = (lista) => lista.filter((i) => !i.sinUbicar);

  /** Por día y hora. Lo que no tiene hora va al final, que es donde molesta menos. */
  const porCrono = (a, b) =>
    (a.dia ?? 99) - (b.dia ?? 99) || String(a.hora ?? '99:99').localeCompare(String(b.hora ?? '99:99'));

  // ===========================================================================
  // PINTAR EL MAPA
  // ===========================================================================
  function iconoPin(item, numero) {
    const sel = seleccion === item.id ? ' mm-pin--sel' : '';
    const dentro =
      numero != null ? String(numero) : `<i class="ti ${iconoTipo(item.tipo)}"></i>`;
    return L.divIcon({
      html: `<div class="mm-pin${numero != null ? ' mm-pin--num' : ''}${sel}" style="background:${colorTipo(item.tipo)}">${dentro}</div>`,
      className: '',
      iconSize: [29, 29],
      iconAnchor: [15, 15],
    });
  }

  function iconoCiudad(c) {
    const sel = seleccion === c.id ? ' mm-pin--sel' : '';
    return L.divIcon({
      html: `<div class="mm-pin-ciudad${sel}"><span>${c.orden}</span><small>${c.noches}n</small></div>`,
      className: '',
      iconSize: [50, 50],
      iconAnchor: [25, 25],
    });
  }

  /**
   * CUÁNTO HAY DE UN PUNTO A OTRO, EN LÍNEA RECTA.
   *
   * Haversine, cuatro líneas y ninguna llamada a nadie. No es la distancia
   * andando —esa depende de las calles y de si hay un río en medio— y por eso
   * todo lo que sale de aquí se enseña diciendo «en línea recta». Pedirle a
   * Google la de verdad serían dos peticiones por día de viaje cada vez que se
   * abre el mapa, y esta pantalla es de lectura.
   */
  function km(a, b) {
    const R = 6371;
    const rad = (g) => (g * Math.PI) / 180;
    const dLat = rad(b.lat - a.lat);
    const dLon = rad(b.lon - a.lon);
    const s =
      Math.sin(dLat / 2) ** 2 +
      Math.cos(rad(a.lat)) * Math.cos(rad(b.lat)) * Math.sin(dLon / 2) ** 2;
    return 2 * R * Math.asin(Math.sqrt(s));
  }

  /** 0.85 -> «850 m»; 3.2 -> «3,2 km». Lo que uno diría en voz alta. */
  const comoKm = (n) =>
    n < 1 ? `${Math.round(n * 1000)} m` : `${n.toFixed(1).replace('.', ',')} km`;

  /** La etiqueta de un tramo a pie entre el hotel y una parada. */
  function etiquetaDeTramo(desde, hasta, rotulo) {
    if (!desde || !hasta) return;
    const d = km(desde, hasta);
    // Dos bloques en el mismo sitio —el hotel y la cena de al lado— darían una
    // etiqueta de «0 m» que solo estorba.
    if (d < 0.05) return;

    // A UN TERCIO DEL CAMINO, NO EN EL MEDIO.
    //
    // Cuando el día empieza y acaba en el mismo sitio —Wawel por la mañana y el
    // tour de Wawel por la noche— la ida y la vuelta son el MISMO segmento, y en
    // el punto medio las dos etiquetas se pisaban una encima de otra. A un
    // tercio desde su propio origen cada una cae en un sitio distinto de la
    // misma línea, y además se lee de dónde sale cada una.
    const t = 0.34;
    L.marker([desde.lat + (hasta.lat - desde.lat) * t, desde.lon + (hasta.lon - desde.lon) * t], {
      icon: L.divIcon({
        html:
          `<div class="mm-etq mm-etq--suave"><i class="ti ti-walk"></i> ` +
          `${esc(rotulo)} · ${esc(comoKm(d))} en línea recta</div>`,
        className: '',
        iconSize: null,
      }),
      interactive: false,
    }).addTo(capa);
  }

  /** La etiqueta de una línea de traslado: modo, duración y €/persona. */
  function textoDelTraslado(t) {
    const partes = [t.duracion, t.precio != null ? `${t.precio} €/persona` : null].filter(Boolean);
    return `<i class="ti ${t.icono}"></i> ${esc(partes.join(' · ') || t.medio || '')}`;
  }

  function pintarTraslados(puntos, grueso) {
    for (const t of D.traslados) {
      const a = ciudadDe(t.deCiudadId);
      const b = ciudadDe(t.aCiudadId);
      if (!a?.lat || !b?.lat) continue;

      if (capas.linea) {
        L.polyline([[a.lat, a.lon], [b.lat, b.lon]], {
          color: '#16688A',
          weight: grueso ? 3 : 2.5,
          dashArray: '7 9',
          opacity: grueso ? 1 : 0.7,
        }).addTo(capa);
      }
      if (capas.datos) {
        L.marker([(a.lat + b.lat) / 2, (a.lon + b.lon) / 2], {
          icon: L.divIcon({ html: `<div class="mm-etq">${textoDelTraslado(t)}</div>`, className: '', iconSize: null }),
          interactive: false,
        }).addTo(capa);
      }
      // La línea cuenta para el encuadre solo si se está viendo.
      if (capas.linea || capas.datos) puntos.push([a.lat, a.lon], [b.lat, b.lon]);
    }
  }

  function pintar() {
    capa.remove();
    capa = L.layerGroup().addTo(mapa);

    // EL ENCUADRE SE CALCULA CON LO QUE SE VE, y solo con eso. Si apago las
    // excursiones, Auschwitz deja de estirar el mapa de Cracovia hasta que
    // la ciudad no se distingue.
    const puntos = [];

    if (vista === 'ruta') {
      for (const c of D.ciudades) {
        if (c.lat == null) continue;
        L.marker([c.lat, c.lon], { icon: iconoCiudad(c) })
          .addTo(capa)
          .bindTooltip(`<b>${esc(c.nombre)}</b> · ${c.noches}n`)
          .on('click', () => seleccionar(c.id, true));
        puntos.push([c.lat, c.lon]);
      }
      pintarTraslados(puntos, true);
    } else {
      if (vista === 'expandida') {
        for (const c of D.ciudades) {
          if (c.lat == null) continue;
          L.marker([c.lat, c.lon], { icon: iconoCiudad(c), zIndexOffset: -100 })
            .addTo(capa)
            .bindTooltip(`<b>${esc(c.nombre)}</b> · ${c.noches}n`)
            .on('click', () => seleccionar(c.id, true));
          puntos.push([c.lat, c.lon]);
        }
        pintarTraslados(puntos, false);
      }

      const vis = conPunto(visibles());

      // Los números: por hora dentro del día, o por día y hora en toda la etapa.
      const delDia = vis.filter((i) => i.hora).sort(porCrono);
      const deLaEtapa = vis.filter((i) => i.dia).sort(porCrono);

      // EL DÍA EMPIEZA Y ACABA EN EL HOTEL, porque es lo que pasa de verdad.
      //
      // El recorrido iba de la primera parada a la última y se dejaba fuera los
      // dos tramos que más se preguntan: cuánto hay desde el hotel hasta lo
      // primero de la mañana, y cuánto queda de vuelta al final del día. Son la
      // primera y la última caminata de la jornada, y saber si son cuatrocientos
      // metros o tres kilómetros cambia el plan.
      //
      // Solo si el hotel se está viendo: una línea hacia un punto sin pin es una
      // línea que no lleva a ninguna parte.
      if (vista === 'dia' && capas.recorrido && delDia.length) {
        const hotel = vis.find((i) => i.tipo === 'hotel');
        const cadena = hotel ? [hotel, ...delDia, hotel] : delDia;

        if (cadena.length > 1) {
          L.polyline(cadena.map((i) => [i.lat, i.lon]), {
            color: '#12303E', weight: 2, dashArray: '2 7', opacity: 0.6,
          }).addTo(capa);
        }

        // Y CON SU DISTANCIA. En línea recta y DICIÉNDOLO: la de verdad depende
        // de las calles y de si hay un río en medio, y eso no se sabe sin
        // preguntárselo a Google. Este mapa es de lectura y no gasta una llamada
        // por tramo; un número honesto y etiquetado vale más que uno exacto que
        // cuesta dinero cada vez que se abre la pantalla.
        if (hotel) {
          etiquetaDeTramo(hotel, delDia[0], 'Salida');
          etiquetaDeTramo(delDia.at(-1), hotel, 'Vuelta');
        }
      }

      for (const i of vis) {
        let numero = null;
        if (vista === 'dia' && i.hora) numero = delDia.indexOf(i) + 1;
        else if (vista === 'etapa' && capas.orden && i.dia) numero = deLaEtapa.indexOf(i) + 1;

        L.marker([i.lat, i.lon], { icon: iconoPin(i, numero) })
          .addTo(capa)
          .bindTooltip(
            `<b>${esc(i.nombre)}</b>${i.hora ? ` · ${esc(i.hora)}` : ''}` +
              (i.situadaComo ? `<br><small>${esc(i.situadaComo)}</small>` : '')
          )
          .on('click', () => seleccionar(i.id, true));
        puntos.push([i.lat, i.lon]);
      }
    }

    encuadrar(puntos);
  }

  /**
   * EL ENCUADRE, CONTANDO LO QUE TAPA.
   *
   * Un `padding` simétrico centra los marcadores en el CONTENEDOR, y medio
   * contenedor está debajo del panel: la mitad del día quedaba escondida detrás
   * de su propia lista. Se aparta por la izquierda lo que ocupa el panel y por
   * abajo lo que ocupan la barra de vistas y la leyenda en el móvil.
   *
   * Y el zoom máximo va por vista, porque son tres escalas distintas: un día se
   * mira a pie de calle, una ciudad entera desde arriba y el viaje desde muy
   * arriba. Con un tope único, el día de una ciudad pequeña salía a vista de
   * pájaro y no se distinguían dos paradas contiguas.
   */
  function encuadrar(puntos) {
    if (!puntos.length) return;

    const estrecho = window.matchMedia('(max-width: 720px)').matches;
    const panelTapa = !estrecho && !panel.classList.contains('oculto');

    mapa.fitBounds(puntos, {
      paddingTopLeft: [panelTapa ? 348 : 40, 80],
      paddingBottomRight: [40, estrecho ? 150 : 70],
      maxZoom: vista === 'dia' ? 16 : vista === 'etapa' ? 15 : 12,
    });
  }

  // ===========================================================================
  // PINTAR LOS CONTROLES
  // ===========================================================================
  function pintarVistas() {
    const n = document.getElementById('mm-vistas');
    n.innerHTML = '';
    for (const [clave, v] of Object.entries(VISTAS)) {
      const b = document.createElement('button');
      b.textContent = v.titulo;
      b.className = vista === clave ? 'on' : '';
      b.setAttribute('aria-pressed', String(vista === clave));
      b.onclick = () => { vista = clave; seleccion = null; refrescar(); };
      n.appendChild(b);
    }
  }

  function pintarSelector() {
    const n = document.getElementById('mm-selector');
    n.innerHTML = '';

    if (vista === 'dia') {
      for (const d of D.dias) {
        const b = document.createElement('button');
        b.textContent = `Día ${d.n}`;
        b.title = `${d.fechaCorta ?? ''} · ${d.ciudad ?? ''}`.trim();
        b.className = d.n === dia ? 'on' : '';
        b.onclick = () => { dia = d.n; seleccion = null; refrescar(); };
        n.appendChild(b);
      }
    } else if (vista === 'etapa') {
      for (const c of D.ciudades) {
        const b = document.createElement('button');
        b.textContent = c.nombre;
        b.className = c.id === ciudad ? 'on' : '';
        b.onclick = () => { ciudad = c.id; seleccion = null; refrescar(); };
        n.appendChild(b);
      }
    } else {
      const s = document.createElement('span');
      s.className = 'mm-selector__nota';
      s.textContent = `Viaje completo · ${D.dias.length} días · ${D.ciudades.length} ciudades`;
      n.appendChild(s);
    }
  }

  function pintarCapas() {
    const n = document.getElementById('mm-capas');
    n.innerHTML = '<h3>Qué ver en el mapa</h3>';
    const g = document.createElement('div');
    g.className = 'mm-capas__grid';
    n.appendChild(g);

    for (const c of VISTAS[vista].capas) {
      const l = document.createElement('label');
      l.className = 'mm-capa' + (capas[c] ? '' : ' off');
      l.style.setProperty('--cc', colorCapa(c));
      const input = document.createElement('input');
      input.type = 'checkbox';
      input.checked = capas[c];
      input.onchange = (e) => { capas[c] = e.target.checked; refrescar(); };
      l.append(input, document.createTextNode(nombreCapa(c)));
      g.appendChild(l);
    }
  }

  function grupo(texto) {
    const d = document.createElement('div');
    d.className = 'mm-grupo';
    d.textContent = texto;
    return d;
  }

  function fila(i, { icono, color, titulo, detalle, hora, sinUbicar = false } = {}) {
    const b = document.createElement('button');
    b.type = 'button';
    b.className = 'mm-item' + (seleccion === i.id ? ' sel' : '') + (sinUbicar ? ' mm-item--sinubicar' : '');
    b.dataset.id = i.id;

    b.innerHTML =
      `<span class="mm-item__ic" style="background:${color}">${icono}</span>` +
      `<span class="mm-item__txt"><b>${esc(titulo)}</b>${detalle ? `<small>${esc(detalle)}</small>` : ''}</span>` +
      (sinUbicar
        ? '<span class="mm-item__aviso">sin ubicar en el mapa</span>'
        : hora ? `<span class="mm-item__hora">${esc(hora)}</span>` : '');

    // Lo que no está en el mapa no se puede seleccionar: no habría a dónde ir.
    if (!sinUbicar) b.onclick = () => seleccionar(i.id, false);
    else b.disabled = false;
    return b;
  }

  const filaItem = (i) =>
    fila(i, {
      icono: `<i class="ti ${iconoTipo(i.tipo)}"></i>`,
      color: colorTipo(i.tipo),
      titulo: i.nombre,
      // CON QUÉ SE HA CASADO, cuando el pin no está donde dice el nombre. Una
      // excursión se sitúa buscando su nombre en Google, y «Excursión a
      // Auschwitz-Birkenau con guía» acaba clavada en el Campo de concentración
      // de Auschwitz: es el sitio correcto, pero hay que decir cuál es.
      detalle: [i.detalle, i.situadaComo].filter(Boolean).join(' · '),
      hora: i.hora,
      sinUbicar: i.sinUbicar,
    });

  function pintarLista() {
    const n = document.getElementById('mm-lista');
    n.innerHTML = '';

    if (vista === 'ruta') {
      for (const c of D.ciudades) {
        n.appendChild(
          fila(c, {
            icono: String(c.orden),
            color: '#16688A',
            titulo: c.nombre,
            detalle: `${c.noches} ${c.noches === 1 ? 'noche' : 'noches'} · días ${c.dias.join(', ')}`,
            sinUbicar: c.lat == null,
          })
        );
      }
      for (const t of D.traslados) {
        const a = ciudadDe(t.deCiudadId);
        const b = ciudadDe(t.aCiudadId);
        const partes = [t.duracion, t.precio != null ? `${t.precio} €/persona` : 'precio no encontrado'];
        n.appendChild(grupo(`${a?.nombre ?? '?'} → ${b?.nombre ?? '?'} · ${partes.filter(Boolean).join(' · ')}`));
      }
      return;
    }

    const vis = visibles();

    if (vista === 'expandida') {
      for (const c of D.ciudades) {
        const suyos = vis.filter((i) => i.ciudadId === c.id).sort(porCrono);
        if (!suyos.length) continue;
        n.appendChild(grupo(`${c.nombre} · ${c.noches} ${c.noches === 1 ? 'noche' : 'noches'}`));
        for (const i of suyos) n.appendChild(filaItem(i));
      }
    } else {
      for (const i of [...vis].sort(porCrono)) n.appendChild(filaItem(i));
    }

    if (!vis.length) n.appendChild(grupo('Nada que enseñar con estos checks.'));
  }

  function pintarLeyenda() {
    const n = document.getElementById('mm-leyenda');
    const tipos = VISTAS[vista].capas.filter((c) => D.tipos[c]);
    if (!tipos.length) {
      n.style.display = 'none';
      return;
    }
    n.style.display = '';
    n.innerHTML = tipos
      .map(
        (t) =>
          `<span><i class="punto" style="background:${colorTipo(t)}"></i>${esc(D.tipos[t].singular)}</span>`
      )
      .join('');
  }

  // ===========================================================================
  // SELECCIÓN CRUZADA
  // ===========================================================================
  /**
   * Tocar una fila centra y resalta su pin; tocar un pin resalta la fila y hace
   * que la lista baje hasta ella. Volver a tocar lo mismo deselecciona.
   */
  function seleccionar(id, desdeElMapa) {
    seleccion = seleccion === id ? null : id;
    pintar();
    pintarLista();

    if (!seleccion) return;
    const o = D.items.find((i) => i.id === seleccion) ?? ciudadDe(seleccion);
    if (o?.lat != null) mapa.panTo([o.lat, o.lon]);

    if (desdeElMapa) {
      document.querySelector(`.mm-item[data-id="${CSS.escape(seleccion)}"]`)
        ?.scrollIntoView({ block: 'nearest', behavior: 'smooth' });
    }
  }

  function refrescar() {
    pintarVistas();
    pintarSelector();
    pintarCapas();
    pintarLeyenda();
    pintarLista();
    pintar();
    recordar();
  }

  // ===========================================================================
  // EL PANEL
  // ===========================================================================
  const panel = document.getElementById('mm-panel');
  const abrir = document.getElementById('mm-abrir');

  /**
   * Plegar y desplegar vuelven a encuadrar, porque el hueco útil ha cambiado:
   * con el panel fuera caben 320 píxeles más de mapa y sería raro no usarlos.
   * Se espera a que acabe la transición para medir el tamaño de verdad.
   */
  const trasPlegar = () => setTimeout(() => { mapa.invalidateSize(); pintar(); }, 270);

  const plegar = () => {
    panel.classList.add('oculto');
    abrir.classList.add('visible');
    trasPlegar();
  };
  const desplegar = () => {
    panel.classList.remove('oculto');
    abrir.classList.remove('visible');
    trasPlegar();
  };

  document.getElementById('mm-cerrar').onclick = plegar;
  abrir.onclick = desplegar;

  // EN EL MÓVIL ARRANCA PLEGADO. Un panel de 320 px sobre una pantalla de 390
  // deja el mapa en una rendija, y el mapa es a lo que se viene.
  if (window.matchMedia('(max-width: 720px)').matches) plegar();

  refrescar();
})();
