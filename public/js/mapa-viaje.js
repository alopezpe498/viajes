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
    dia: { titulo: 'Día', capas: ['sitio', 'comer', 'actividad', 'hotel', 'recorrido', 'tiempos'] },
    etapa: { titulo: 'Etapa', capas: ['sitio', 'comer', 'actividad', 'hotel', 'orden'] },
    ruta: { titulo: 'Ruta', capas: ['linea', 'datos'] },
    expandida: { titulo: 'Ruta expandida', capas: ['sitio', 'comer', 'actividad', 'hotel', 'linea', 'datos'] },
  };

  const EXTRA = {
    recorrido: { etiqueta: 'Recorrido del día', color: '#12303E' },
    tiempos: { etiqueta: 'Ver tiempos', color: '#1B7FA6' },
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
  //
  // MENOS «Ver tiempos», que nace APAGADA. Las demás capas solo pintan lo que ya
  // está en la pantalla; esta puede costar una llamada a Google la primera vez
  // que se mira un día. El comentario del recorrido lo dice desde siempre —«este
  // mapa es de lectura y no gasta una llamada por tramo»— y encenderla de salida
  // sería romper esa promesa sin que nadie la hubiera pedido. Se enciende y se
  // recuerda encendida: la segunda vez sale de la caché y es gratis.
  const APAGADAS_DE_SALIDA = new Set(['tiempos']);
  const capas = {};
  for (const c of [...Object.keys(D.tipos), ...Object.keys(EXTRA)]) {
    capas[c] = typeof previo.capas?.[c] === 'boolean'
      ? previo.capas[c]
      : !APAGADAS_DE_SALIDA.has(c);
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

  // La clave del NAVEGADOR, la misma que pinta las teselas. La de servidor no
  // viaja aquí y no tiene por qué: el iframe lo carga el navegador.
  const CLAVE_MAPAS = div.dataset.claveMapas ?? '';

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
  function etiquetaDeTramo(desde, hasta, rotulo, tiempo = null) {
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
        // Con tiempo real se enseña ESE, que es el dato bueno; sin él, la recta
        // de siempre y diciéndolo. Nunca las dos: la etiqueta cabe una vez.
        html:
          `<div class="mm-etq mm-etq--suave">` +
          (tiempo
            ? [tiempo, rotulo ? esc(rotulo) : null].filter(Boolean).join(' · ')
            : `<i class="ti ti-walk"></i> ${esc(rotulo)} · ${esc(comoKm(d))} en línea recta`) +
          `</div>`,
        className: '',
        iconSize: null,
      }),
      interactive: false,
    }).addTo(capa);
  }

  // ===========================================================================
  // LOS TIEMPOS DE VERDAD
  // ---------------------------------------------------------------------------
  // El recorrido del día se dibuja en línea recta y lo dice, porque medirlo de
  // verdad costaba una llamada a Google por tramo CADA VEZ que se abría el mapa.
  // Con la caché del servidor eso se paga una vez, así que ya se puede preguntar
  // — pero solo cuando alguien enciende el check, no de oficio.
  //
  // SE PREGUNTA POR IDS, no por coordenadas: la cadena del día la arma el mismo
  // sitio que la pinta y el servidor la resuelve contra el viaje. Así no hay dos
  // versiones de «de dónde a dónde va el día» y no viaja ni un punto suelto.
  //
  // Lo traído se guarda por día: cambiar de día y volver no vuelve a preguntar,
  // y encender y apagar el check, tampoco.
  // ===========================================================================
  const tiemposPorDia = new Map();   // dia -> { estado, tramos, error }

  const claveDeCadena = (cadena) => cadena.map((i) => i.id).join('>');

  async function pedirTiempos(nDia, cadena) {
    const clave = claveDeCadena(cadena);
    const yaEsta = tiemposPorDia.get(nDia);
    // La misma cadena ya pedida —o pidiéndose— no se vuelve a pedir. Cambiarla
    // —mover algo de día— sí: la clave lleva los ids en orden.
    if (yaEsta && yaEsta.clave === clave && yaEsta.estado !== 'error') return;

    tiemposPorDia.set(nDia, { clave, estado: 'pidiendo', tramos: [] });
    refrescar();

    try {
      const r = await fetch(`/api/viaje/${VIAJE}/tiempos`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
        body: JSON.stringify({ cadena: cadena.map((i) => i.id) }),
      });
      const datos = await r.json().catch(() => ({}));
      if (!r.ok) throw new Error(datos.error || `Error ${r.status}`);
      tiemposPorDia.set(nDia, { clave, estado: 'hecho', tramos: datos.tramos ?? [] });
    } catch (err) {
      // NO SE INVENTA NADA. Sin respuesta, la línea se queda con su distancia en
      // recta, que es lo que había antes, y el aviso dice qué ha pasado.
      console.warn('[mapa-viaje] no pude traer los tiempos:', err.message);
      tiemposPorDia.set(nDia, { clave, estado: 'error', tramos: [], error: err.message });
    }
    refrescar();
  }

  /** La etiqueta de un tramo con su tiempo real, o null si no se sabe. */
  function etiquetaDeTiempo(desde, hasta, nDia) {
    const guardado = tiemposPorDia.get(nDia);
    if (guardado?.estado !== 'hecho') return null;

    const t = guardado.tramos.find((x) => x.de === desde.id && x.a === hasta.id);
    if (!t?.elegido) return null;

    const icono = ICONO_MODO[t.elegido.modo] ?? 'ti-arrow-right';
    // El tiempo de transporte público envejece —son los horarios de hoy— y se
    // marca con un asterisco en vez de callarlo.
    const viejo = t.elegido.modo === 'publico' ? '*' : '';
    return `<i class="ti ${icono}"></i> ${t.elegido.minutos} min${viejo}`;
  }

  const ICONO_MODO = { andando: 'ti-walk', coche: 'ti-car', publico: 'ti-bus' };

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
        //
        // SALVO QUE SE PIDA. Con «Ver tiempos» encendido se pregunta una vez por
        // día —los tramos van juntos, en una sola petición— y a partir de ahí
        // sale de la caché. La recta se queda de respaldo para lo que no se
        // pueda medir: es preferible a un hueco.
        if (capas.tiempos && cadena.length > 1) pedirTiempos(dia, cadena);

        if (hotel) {
          etiquetaDeTramo(hotel, delDia[0], 'Salida',
            capas.tiempos ? etiquetaDeTiempo(hotel, delDia[0], dia) : null);
          etiquetaDeTramo(delDia.at(-1), hotel, 'Vuelta',
            capas.tiempos ? etiquetaDeTiempo(delDia.at(-1), hotel, dia) : null);
        }

        // LOS TRAMOS DE EN MEDIO SOLO SE ETIQUETAN CON TIEMPO, y no con la recta.
        //
        // La distancia en línea recta entre dos museos del centro no le dice nada
        // a nadie, y nueve etiquetas de «300 m en recta» sobre un día tapan el
        // mapa. Un tiempo real sí: es lo que se tarda en ir, que es la pregunta.
        if (capas.tiempos) {
          for (let k = 0; k + 1 < cadena.length; k++) {
            // La salida y la vuelta ya las ha puesto el bloque de arriba.
            if (hotel && (k === 0 || k + 2 === cadena.length)) continue;
            const t = etiquetaDeTiempo(cadena[k], cadena[k + 1], dia);
            if (t) etiquetaDeTramo(cadena[k], cadena[k + 1], '', t);
          }
        }
      }

      // De dónde se viene para llegar a cada punto del día: el anterior por
      // hora y, para el primero, el hotel — que es donde empieza el día de
      // verdad, como ya dice el recorrido de aquí arriba.
      const hotelDelDia = vista === 'dia' ? vis.find((x) => x.tipo === 'hotel') : null;
      const vengoDe = (i) => {
        if (vista !== 'dia' || !i.hora) return null;
        const k = delDia.indexOf(i);
        if (k < 0) return null;
        const previo = k > 0 ? delDia[k - 1] : hotelDelDia;
        return previo && previo.id !== i.id && previo.lat != null ? previo : null;
      };

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
          // Con la medida armada, el clic es para medir y no para abrir la
          // ficha: dos cosas distintas en el mismo gesto se distinguen por el
          // modo, que además se ve en el cursor y en el botón.
          // EL GLOBO CON EL «CÓMO LLEGAR», SOLO DONDE SIGNIFICA ALGO.
          //
          // En la vista del día, y solo si hay un punto ANTERIOR del que venir:
          // al primero de la mañana se llega desde el hotel, y si no hay ni
          // hotel no hay origen y no se ofrece.
          //
          // Y VA SUELTO EN EL MAPA, NO COLGADO DEL PIN. Colgado de él se abría y
          // se cerraba en el mismo clic: seleccionar repinta la capa entera, el
          // marcador se destruye y su globo con él. Un globo del mapa sobrevive
          // al repintado porque no es de la capa.
          .on('click', () => {
            if (clicMidiendo(i)) return;
            seleccionar(i.id, true);
            abrirGlobo(i, vengoDe(i));
          });
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

  /**
   * DÓNDE ESTOY: el día y la ciudad que se están mirando.
   *
   * En la vista del día, el mapa enseñaba ocho pines y el título decía el
   * nombre del viaje: para saber si esos pines eran de Belgrado o de Split
   * había que ir a buscar el día en la lista del panel. Ahora lo dice la
   * cabecera, que es donde se mira.
   */
  function pintarDonde() {
    const n = document.getElementById('mm-donde');
    if (!n) return;

    if (vista === 'dia') {
      const d = D.dias.find((x) => x.n === dia);
      n.textContent = d
        ? `Día ${d.n}${d.ciudad ? ` · ${d.ciudad}` : ''}${d.fechaCorta ? ` · ${d.fechaCorta}` : ''}`
        : `Día ${dia}`;
      return;
    }
    if (vista === 'etapa') {
      const c = ciudadDe(ciudad);
      n.textContent = c
        ? `${c.nombre} · ${c.noches} ${c.noches === 1 ? 'noche' : 'noches'}`
        : 'Etapa';
      return;
    }
    n.textContent = `Viaje completo · ${D.dias.length} días`;
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
      // «Ver tiempos» dice en qué estado está: mientras se pregunta a Google hay
      // medio segundo en que el mapa no cambia, y un check que parece no hacer
      // nada es un check que se vuelve a pulsar. Y si falla, se dice: las
      // etiquetas se quedan con la distancia en recta y hay que saber por qué.
      let etiqueta = nombreCapa(c);
      if (c === 'tiempos' && capas.tiempos) {
        const e = tiemposPorDia.get(dia)?.estado;
        if (e === 'pidiendo') etiqueta += ' · midiendo…';
        else if (e === 'error') etiqueta += ' · no se pudo';
      }
      l.append(input, document.createTextNode(etiqueta));
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

  // ===========================================================================
  // CÓMO LLEGAR: EL CAMINO POR LAS CALLES, DENTRO DE LA APP
  // ===========================================================================
  /**
   * Un iframe de la Maps Embed API en modo «directions» entre el punto anterior
   * del día y el que se ha pinchado.
   *
   * QUÉ ES Y QUÉ NO ES. Es una brújula: por dónde se va. El tiempo y la
   * distancia NO salen de aquí —el iframe no deja leerlos por código— y no
   * hacen falta: los da Routes y ya están en las etiquetas de los tramos con
   * «Ver tiempos». Tampoco es navegación paso a paso; eso es la app de Maps.
   *
   * EL MODO, POR LA DISTANCIA EN RECTA. Dentro de una ciudad, lo que se hace
   * andando se anda: hasta dos kilómetros, a pie; más lejos, transporte
   * público. Es la misma vara que usa el resto de la pantalla para hablar de
   * tramos, y se dice en el título para que nadie tenga que adivinarlo.
   */
  const KM_A_PIE = 2;

  /** Los cuatro modos, con el nombre que se enseña y el que entiende Google. */
  const MODOS = {
    walking: 'a pie',
    transit: 'en transporte público',
    driving: 'en coche',
    bicycling: 'en bici',
  };

  /**
   * El globo del punto pinchado, con lo que se puede hacer con él:
   *
   *   · ver su FICHA, si es un sitio del catálogo —los que la tienen—;
   *   · ver CÓMO LLEGAR desde el punto anterior del día, si hay anterior.
   *
   * Sin ninguna de las dos no hay globo: un globo que solo repite el nombre que
   * ya dice el tooltip es una ventana de más.
   */
  function abrirGlobo(i, previo) {
    const conFicha = i.dir && (i.dir.tipo === 'sitio' || i.dir.tipo === 'punto');
    const conRuta = Boolean(previo && CLAVE_MAPAS);
    if (!conFicha && !conRuta) {
      mapa.closePopup();
      return;
    }

    const botones = [];
    if (conFicha) {
      botones.push(
        `<button type="button" class="mm-popup__ir" data-ficha="${esc(i.dir.tipo)}" ` +
          `data-ficha-id="${esc(String(i.dir.id))}" data-nombre="${esc(i.nombre)}">` +
          '<i class="ti ti-info-circle" aria-hidden="true"></i> Ver la ficha</button>'
      );
    }
    if (conRuta) {
      botones.push(
        `<button type="button" class="mm-popup__ir" data-desde="${esc(previo.id)}" ` +
          `data-hasta="${esc(i.id)}"><i class="ti ti-route" aria-hidden="true"></i> Cómo llegar` +
          `</button><small class="mm-popup__desde">desde ${esc(previo.nombre)}</small>`
      );
    }

    L.popup({ className: 'mm-popup', autoPan: true, offset: [0, -10] })
      .setLatLng([i.lat, i.lon])
      .setContent(
        `<b>${esc(i.nombre)}</b>${i.hora ? ` · ${esc(i.hora)}` : ''}<br>${botones.join('')}`
      )
      .openOn(mapa);
  }

  // ===========================================================================
  // LA FICHA DEL SITIO, SOLO PARA LEER
  // ---------------------------------------------------------------------------
  // La pinta el servidor con la misma plantilla para todos y aquí solo se
  // enseña. NO trae acciones a propósito: desde el mapa se mira, y lo que haya
  // que tocar se toca en la etapa, a donde lleva su enlace.
  // ===========================================================================
  const panelFicha = document.getElementById('mm-ficha');
  const tituloFicha = document.getElementById('mm-ficha-titulo');
  const cuerpoFicha = document.getElementById('mm-ficha-cuerpo');

  function cerrarFicha() {
    if (!panelFicha) return;
    panelFicha.hidden = true;
    cuerpoFicha.innerHTML = '';
  }

  async function abrirFicha(tipo, id, nombre) {
    if (!panelFicha) return;
    tituloFicha.textContent = nombre ?? 'Ficha';
    cuerpoFicha.innerHTML = '<p class="ficha-lectura__pie">Abriendo la ficha…</p>';
    panelFicha.hidden = false;
    try {
      const r = await fetch(`/api/fichas/${encodeURIComponent(tipo)}/${encodeURIComponent(id)}`);
      cuerpoFicha.innerHTML = await r.text();
    } catch {
      cuerpoFicha.innerHTML = '<p class="ficha-lectura__pie">No he podido abrir la ficha.</p>';
    }
  }

  document.getElementById('mm-ficha-cerrar')?.addEventListener('click', cerrarFicha);
  panelFicha?.addEventListener('click', (e) => { if (e.target === panelFicha) cerrarFicha(); });

  const panelIr = document.getElementById('mm-comollegar');
  const tituloIr = document.getElementById('mm-comollegar-titulo');
  const marcoIr = document.getElementById('mm-comollegar-mapa');
  const modosIr = document.getElementById('mm-comollegar-modos');
  const fueraIr = document.getElementById('mm-comollegar-fuera');

  /** Lo que se está mirando ahora mismo, para poder cambiarle el modo. */
  let tramoIr = null;

  function cerrarComoLlegar() {
    if (!panelIr) return;
    panelIr.hidden = true;
    tramoIr = null;
    // Se vacía al cerrar: un iframe escondido sigue vivo, y este pide mapas.
    marcoIr.removeAttribute('src');
  }

  /** El modo que se propone: dentro de la ciudad, lo que se anda se anda. */
  const modoDeSalida = (desde, hasta) => (km(desde, hasta) <= KM_A_PIE ? 'walking' : 'transit');

  function pintarComoLlegar() {
    if (!tramoIr) return;
    const { desde, hasta, modo } = tramoIr;

    const url = new URL('https://www.google.com/maps/embed/v1/directions');
    url.searchParams.set('key', CLAVE_MAPAS);
    // COORDENADAS Y NO NOMBRES. El nombre lo vuelve a buscar Google y puede
    // acabar en otro sitio; la coordenada es la que ya se guardó y es la que se
    // está pintando en el mapa.
    url.searchParams.set('origin', `${desde.lat},${desde.lon}`);
    url.searchParams.set('destination', `${hasta.lat},${hasta.lon}`);
    url.searchParams.set('mode', modo);
    url.searchParams.set('language', 'es');

    tituloIr.textContent = `${desde.nombre} → ${hasta.nombre} · ${MODOS[modo]}`;
    marcoIr.src = url.toString();

    // LA SALIDA A GOOGLE MAPS, con el mismo tramo y el mismo modo. Es una Maps
    // URL —otra pieza, no la del iframe— y ahí sí salen las rutas alternativas
    // y el botón de empezar el viaje.
    const fuera = new URL('https://www.google.com/maps/dir/');
    fuera.searchParams.set('api', '1');
    fuera.searchParams.set('origin', `${desde.lat},${desde.lon}`);
    fuera.searchParams.set('destination', `${hasta.lat},${hasta.lon}`);
    fuera.searchParams.set('travelmode', modo);
    fueraIr.href = fuera.toString();
    fueraIr.title = `Abrir ${desde.nombre} → ${hasta.nombre} en Google Maps`;

    for (const b of modosIr.querySelectorAll('button[data-modo]')) {
      const suyo = b.dataset.modo === modo;
      b.classList.toggle('on', suyo);
      b.setAttribute('aria-pressed', suyo ? 'true' : 'false');
    }
  }

  function abrirComoLlegar(desde, hasta) {
    if (!panelIr || !desde || !hasta || !CLAVE_MAPAS) return;
    tramoIr = { desde, hasta, modo: modoDeSalida(desde, hasta) };
    pintarComoLlegar();
    panelIr.hidden = false;
  }

  modosIr?.addEventListener('click', (e) => {
    const b = e.target.closest('button[data-modo]');
    if (!b || !tramoIr) return;
    tramoIr.modo = b.dataset.modo;
    pintarComoLlegar();
  });

  document.getElementById('mm-comollegar-cerrar')?.addEventListener('click', cerrarComoLlegar);
  panelIr?.addEventListener('click', (e) => { if (e.target === panelIr) cerrarComoLlegar(); });
  document.addEventListener('keydown', (e) => {
    if (e.key !== 'Escape') return;
    cerrarComoLlegar();
    cerrarFicha();
  });

  // El botón vive dentro del globo de Leaflet, que se crea y se destruye solo:
  // por eso se escucha en el mapa y no en el botón.
  mapa.on('popupopen', (e) => {
    for (const b of e.popup.getElement()?.querySelectorAll('.mm-popup__ir') ?? []) {
      b.addEventListener('click', (ev) => {
        const q = ev.currentTarget.dataset;
        if (q.ficha) {
          abrirFicha(q.ficha, q.fichaId, q.nombre);
          return;
        }
        abrirComoLlegar(
          D.items.find((i) => i.id === q.desde),
          D.items.find((i) => i.id === q.hasta)
        );
      });
    }
  });

  function refrescar() {
    // Al cambiar de vista, lo que solo vive en una vista se va con ella: el
    // «cómo llegar» es del día —fuera de él no hay «anterior»— y la medida se
    // arma sobre el mapa que se estaba mirando.
    cerrarComoLlegar();
    cerrarFicha();
    mapa.closePopup();
    pintarMedir();

    pintarVistas();
    pintarDonde();
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

  // ===========================================================================
  // MEDIR DOS PUNTOS
  // ---------------------------------------------------------------------------
  // La capa de tiempos contesta «cuánto hay entre lo que ya está puesto en un
  // día». Esto contesta la otra mitad: «¿y de AQUÍ a AQUÍ?», que es la pregunta
  // que uno se hace mirando el mapa y que hasta ahora obligaba a salir a Google
  // Maps y volver sin que quedara constancia.
  //
  // SE MIDE ENTRE PUNTOS DEL VIAJE, no entre coordenadas sueltas. Dos motivos y
  // los dos pesan: el servidor solo acepta ids —nadie puede usar esto como un
  // proxy gratis de Google— y una medida entre dos sitios del viaje se puede
  // guardar en su parada; entre dos manchas del mapa, no.
  // ===========================================================================
  const botonMedir = document.getElementById('mm-medir-boton');
  const textoMedir = document.getElementById('mm-medir-texto');
  const cajaMedir = document.getElementById('mm-medir-caja');

  let midiendo = false;
  let primerPunto = null;
  let marcaMedida = null;

  function decirMedida(html, tono = '') {
    cajaMedir.innerHTML = html;
    cajaMedir.hidden = !html;
    cajaMedir.className = 'mm-medir__caja' + (tono ? ` mm-medir__caja--${tono}` : '');
  }

  function limpiarMedida() {
    primerPunto = null;
    if (marcaMedida) { marcaMedida.remove(); marcaMedida = null; }
  }

  function armarMedir(si) {
    midiendo = si;
    botonMedir.setAttribute('aria-pressed', String(si));
    textoMedir.textContent = si ? 'Elige dos puntos' : 'Medir';
    // El cursor lo dice mejor que cualquier texto: el mapa está esperando algo.
    div.style.cursor = si ? 'crosshair' : '';
    if (!si) { limpiarMedida(); decirMedida(''); }
  }

  botonMedir.addEventListener('click', () => armarMedir(!midiendo));

  /**
   * LA MEDIDA SOLO DONDE SE PUEDE MEDIR.
   *
   * Se mide entre dos PUNTOS del plan, y en la vista de la ruta no hay ninguno:
   * ahí solo se pintan ciudades, cuyo clic hace otra cosa. El botón salía igual,
   * se armaba, cambiaba el cursor a la cruz y no pasaba nada al pinchar. Fuera
   * de sus vistas no se enseña, y si estaba armado se desarma.
   */
  function pintarMedir() {
    const caja = document.getElementById('mm-medir');
    const vale = vista !== 'ruta';
    if (!vale && midiendo) armarMedir(false);
    if (caja) caja.style.display = vale ? '' : 'none';
  }

  /** Segundo clic: se pregunta. El primero solo marca y espera. */
  async function medirHasta(item) {
    const a = primerPunto;
    limpiarMedida();
    armarMedir(false);

    decirMedida(
      `<span class="mm-medir__quien"><b>${esc(a.nombre)}</b> → <b>${esc(item.nombre)}</b></span>` +
        '<span class="mm-medir__nota">Midiendo…</span>'
    );

    try {
      const r = await fetch(`/api/viaje/${VIAJE}/medir`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
        body: JSON.stringify({ de: a.id, a: item.id }),
      });
      const d = await r.json().catch(() => ({}));
      if (!r.ok) throw new Error(d.error || `Error ${r.status}`);

      const quien = `<span class="mm-medir__quien"><b>${esc(a.nombre)}</b> → <b>${esc(item.nombre)}</b></span>`;

      if (!d.resultados?.length) {
        // NO SE INVENTA NADA: si Google no contestó, se dice, con su motivo.
        decirMedida(quien + `<span class="mm-medir__nota mm-medir__nota--mala">${esc(d.mensaje ?? 'No se pudo medir.')}</span>`);
        return;
      }

      const modos = d.resultados
        .map((x) => {
          const elegido = d.elegido && x.modo === d.elegido.modo;
          return (
            `<span class="mm-medir__modo${elegido ? ' mm-medir__modo--elegido' : ''}">` +
            `<i class="ti ${ICONO_MODO[x.modo] ?? 'ti-arrow-right'}"></i> ` +
            `<b>${x.minutos} min</b>${x.km != null ? ` · ${comoKm(x.km)}` : ''}</span>`
          );
        })
        .join('');

      // De dónde salió y si envejece: las dos cosas que el número solo no dice.
      const notas = [];
      if (d.fuente === 'cache') notas.push('ya estaba medido');
      if (d.resultados.some((x) => x.modo === 'publico')) notas.push('el tiempo en transporte es el de hoy');
      if (d.guardadoEn) notas.push(`guardado en los traslados de ${esc(d.guardadoEn)}`);

      decirMedida(
        quien +
          `<span class="mm-medir__modos">${modos}</span>` +
          (notas.length ? `<span class="mm-medir__nota">${notas.join(' · ')}.</span>` : '')
      );
    } catch (err) {
      decirMedida(`<span class="mm-medir__nota mm-medir__nota--mala">${esc(err.message)}</span>`);
    }
  }

  /**
   * El clic en un punto del mapa cuando la medida está armada.
   *
   * Devuelve true si lo ha consumido: quien lo llama tiene que saber que ESE
   * clic no era para seleccionar la ficha.
   */
  function clicMidiendo(item) {
    if (!midiendo || !item || item.lat == null) return false;

    if (!primerPunto) {
      primerPunto = item;
      marcaMedida = L.marker([item.lat, item.lon], {
        icon: L.divIcon({ html: '<div class="mm-punto-medido"></div>', className: '', iconSize: [14, 14] }),
        interactive: false,
      }).addTo(mapa);
      textoMedir.textContent = 'Ahora el segundo';
      decirMedida(`<span class="mm-medir__quien">Desde <b>${esc(item.nombre)}</b>. Elige el otro punto.</span>`);
      return true;
    }

    // El mismo punto dos veces no mide nada: se toma como cambiar de idea.
    if (primerPunto.id === item.id) {
      limpiarMedida();
      textoMedir.textContent = 'Elige dos puntos';
      decirMedida('');
      return true;
    }

    medirHasta(item);
    return true;
  }

  // EN EL MÓVIL ARRANCA PLEGADO. Un panel de 320 px sobre una pantalla de 390
  // deja el mapa en una rendija, y el mapa es a lo que se viene.
  if (window.matchMedia('(max-width: 720px)').matches) plegar();

  refrescar();
})();
