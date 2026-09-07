/**
 * public/js/descubrir.js
 * -----------------------------------------------------------------------------
 * El mapa de la pantalla "Descubrir" y su carrusel, atados el uno al otro.
 *
 * Lo único con algo de miga es la sincronización bidireccional: tocas un
 * marcador y el carrusel va a su tarjeta; deslizas el carrusel y el mapa centra
 * su marcador. Hecho a lo tonto, eso se muerde la cola: mover el carrusel
 * dispara el scroll, que mueve el mapa, que... Por eso hay un cerrojo
 * (`moviendoYo`) que corta el eco durante el desplazamiento.
 *
 * Mapa: Leaflet, con las teselas de Google si la clave del navegador funciona y
 * con las de OpenStreetMap si no. El respaldo no es un adorno: la clave está
 * restringida por dominio y en cuanto se prueba desde otro sitio deja de valer,
 * y entonces esta pantalla tiene que seguir viéndose igual.
 */
(() => {
  const divMapa = document.getElementById('mapa');
  if (!divMapa || typeof L === 'undefined') return;

  const carrusel = document.getElementById('carrusel');

  let datos;
  try {
    datos = JSON.parse(divMapa.dataset.mapa || '{}');
  } catch {
    console.error('[descubrir] los datos del mapa no se pueden leer');
    return;
  }

  // ===========================================================================
  // EL MAPA
  // ===========================================================================
  const mapa = L.map(divMapa, {
    zoomControl: false,
    attributionControl: true,
    // El carrusel se lleva la parte de abajo: que el zoom no quede tapado.
    scrollWheelZoom: true,
  });

  L.control.zoom({ position: 'topright' }).addTo(mapa);

  // ===========================================================================
  // LAS TESELAS
  // ---------------------------------------------------------------------------
  // Google primero, OpenStreetMap de respaldo. Y el respaldo entra SIEMPRE que
  // algo salga mal: sin clave, con la clave restringida a otro dominio, con la
  // API caída o con el script bloqueado por una extensión. Nunca se queda el
  // mapa en gris, que es lo que pasaría si esto se diera por hecho.
  // ===========================================================================

  /**
   * El mapa, sin gritar.
   *
   * Google trae por defecto todos los negocios, todas las paradas de metro y
   * los iconos de las carreteras, y encima de eso hay que pintar marcadores,
   * líneas punteadas y etiquetas de distancia. Se apagan las etiquetas de
   * puntos de interés y de transporte —lo que sobra— y se baja la saturación,
   * y quedan a la vista las ciudades, las carreteras y la costa, que es lo que
   * se está mirando aquí.
   */
  const ESTILO_LIMPIO = [
    { elementType: 'geometry', stylers: [{ saturation: -30 }] },
    { featureType: 'poi', elementType: 'labels', stylers: [{ visibility: 'off' }] },
    { featureType: 'poi.business', stylers: [{ visibility: 'off' }] },
    { featureType: 'transit', stylers: [{ visibility: 'off' }] },
    { featureType: 'road', elementType: 'labels.icon', stylers: [{ visibility: 'off' }] },
    { featureType: 'administrative.land_parcel', stylers: [{ visibility: 'off' }] },
    { featureType: 'administrative.neighborhood', stylers: [{ visibility: 'off' }] },
    // El agua, del azul de la casa.
    { featureType: 'water', elementType: 'geometry', stylers: [{ color: '#D3E8F0' }] },
  ];

  function teselasDeOSM(motivo) {
    if (motivo) console.warn(`[descubrir] teselas de OpenStreetMap: ${motivo}`);
    L.tileLayer('https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png', {
      maxZoom: 18,
      attribution: '© OpenStreetMap',
    }).addTo(mapa);
  }

  /**
   * Carga la API de Google. Resuelve cuando está lista y falla en cuanto se
   * tuerza, para poder irse al respaldo sin dejar a nadie esperando.
   *
   * Tres formas de enterarse de que no va, y hacen falta las tres:
   *
   *   - `gm_authFailure`, que Google llama en ALGUNOS fallos de clave.
   *   - El `onerror` del script, si ni siquiera se descarga.
   *   - Un plazo, porque los otros dos no siempre llegan: una extensión que
   *     bloquee el dominio puede dejar la carga colgada sin decir nada.
   *
   * Y aun con las tres no basta, que es lo que costó descubrir: con
   * `RefererNotAllowedMapError` —la clave no autoriza este dominio— la API
   * CARGA BIEN, no llama a `gm_authFailure`, escribe el error en la consola y
   * deja el mapa en gris. Desde el código todo parece haber ido bien. Por eso
   * después de poner la capa hay que comprobar que de verdad ha pintado algo:
   * eso lo hace `teselasDeGoogle`.
   */
  function cargarGoogle(clave) {
    return new Promise((listo, falla) => {
      const CALLBACK = '__mapaListo';
      const reloj = setTimeout(() => falla(new Error('la API de Google tardó demasiado')), 6000);

      const terminar = (fn, arg) => { clearTimeout(reloj); fn(arg); };

      window[CALLBACK] = () => terminar(listo);
      window.gm_authFailure = () =>
        terminar(falla, new Error('la clave no vale para este dominio'));

      const script = document.createElement('script');
      // `language` y `region` en español: sin esto los nombres salen en el
      // idioma del país que se esté mirando.
      script.src =
        'https://maps.googleapis.com/maps/api/js' +
        `?key=${encodeURIComponent(clave)}` +
        `&language=es&region=ES&loading=async&callback=${CALLBACK}`;
      script.async = true;
      script.onerror = () => terminar(falla, new Error('no se pudo descargar la API de Google'));
      document.head.appendChild(script);
    });
  }

  /**
   * Pone las teselas de Google y COMPRUEBA QUE PINTAN.
   *
   * La comprobación no es paranoia: es el único modo de detectar
   * `RefererNotAllowedMapError`. En ese caso la API carga, la capa se añade sin
   * quejarse y el mapa se queda gris para siempre. Se espera al `tilesloaded`
   * del mapa de Google —el evento que dice "ya hay imágenes"— y, si no llega a
   * tiempo, se quita la capa y se vuelve a OpenStreetMap.
   */
  function teselasDeGoogle() {
    return new Promise((listo, falla) => {
      if (!L.gridLayer?.googleMutant) {
        return falla(new Error('no cargó el puente con Leaflet'));
      }

      const capa = L.gridLayer.googleMutant({
        type: 'roadmap',
        styles: ESTILO_LIMPIO,
        maxZoom: 20,
      });
      capa.addTo(mapa);

      const reloj = setTimeout(() => {
        mapa.removeLayer(capa);
        falla(
          new Error(
            'Google no llegó a pintar. Lo normal es que la clave no autorice ' +
              `«${location.origin}»: mira la consola, ahí lo dice con su nombre.`
          )
        );
      }, 4000);

      // `_mutant` es el mapa de Google que hay por debajo. Su `tilesloaded` es
      // la señal de que hay imágenes de verdad en pantalla.
      const alPintar = () => { clearTimeout(reloj); listo(); };

      if (capa._mutant && window.google?.maps?.event) {
        google.maps.event.addListenerOnce(capa._mutant, 'tilesloaded', alPintar);
      } else {
        // Sin acceso al mapa de dentro, se mira si el plugin ha destapado su
        // contenedor, que es lo que hace cuando Google le contesta.
        const mirar = setInterval(() => {
          const div = document.querySelector('.leaflet-google-mutant');
          if (div && getComputedStyle(div).visibility === 'visible') {
            clearInterval(mirar);
            alPintar();
          }
        }, 250);
        setTimeout(() => clearInterval(mirar), 4000);
      }
    });
  }

  (async () => {
    const clave = datos.claveMapas;
    if (!clave) return teselasDeOSM('no hay GOOGLE_MAPS_BROWSER_KEY en el .env');

    try {
      await cargarGoogle(clave);
      await teselasDeGoogle();
      console.log('[descubrir] teselas de Google Maps, en español.');
    } catch (err) {
      teselasDeOSM(err.message);
    }
  })();

  /** Escapa lo que va dentro del globo: los nombres vienen de la IA. */
  function escapar(t) {
    const d = document.createElement('div');
    d.textContent = t;
    return d.innerHTML;
  }

  /**
   * Los marcadores son HTML, no imágenes: así se pintan con los colores del
   * tema (nada de la chincheta azul de Leaflet) y el estado se cambia con una
   * clase, sin recargar iconos.
   */
  function iconoDe(estado, activo) {
    return L.divIcon({
      className: '', // el contenedor de Leaflet, sin estilos suyos
      html:
        `<span class="marcador marcador--${estado}${activo ? ' marcador--activo' : ''}">` +
        (estado === 'investigada' ? '<i class="ti ti-check"></i>' : '') +
        '</span>',
      iconSize: [26, 26],
      iconAnchor: [13, 13],
    });
  }

  /** id del punto -> { marcador, estado } */
  const marcadores = new Map();

  for (const p of datos.puntos ?? []) {
    const marcador = L.marker([p.lat, p.lon], {
      icon: iconoDe(p.estado, false),
      title: p.nombre,
      riseOnHover: true,
    }).addTo(mapa);

    marcador.on('click', () => irATarjeta(p.id, { desdeMapa: true }));

    // Los ya investigados llevan globo con el atajo a su ficha. El resto no:
    // un globo que no lleva a ningún sitio solo estorba.
    if (p.ficha) {
      marcador.bindPopup(
        `<strong>${escapar(p.nombre)}</strong><br>` +
          `<a class="popup__enlace" href="${p.ficha}">Ver ficha →</a>`,
        { closeButton: false, offset: [0, -6] }
      );
    }

    marcadores.set(p.id, { marcador, estado: p.estado, ficha: p.ficha ?? null, enRuta: Boolean(p.enRuta) });
  }

  // Encuadre inicial: que quepan todos, con hueco abajo para el carrusel.
  if (marcadores.size) {
    const limites = L.latLngBounds([...marcadores.values()].map((m) => m.marcador.getLatLng()));
    mapa.fitBounds(limites, { padding: [60, 60], paddingBottomRight: [60, 240], maxZoom: 9 });
  } else if (datos.centro) {
    mapa.setView(datos.centro, 5);
  } else {
    mapa.setView([20, 0], 2); // el mundo entero: no sabemos nada todavía
  }

  // ===========================================================================
  // SINCRONIZACIÓN mapa <-> carrusel
  // ===========================================================================
  let moviendoYo = false; // cerrojo contra el eco
  let idActivo = null;

  /** Marca un punto como el que se está mirando, en el mapa y en el carrusel. */
  function resaltar(id, { centrarMapa = false } = {}) {
    if (id === idActivo) return;
    idActivo = id;

    for (const [otroId, m] of marcadores) {
      m.marcador.setIcon(iconoDe(m.estado, otroId === id));
    }

    if (centrarMapa) {
      const m = marcadores.get(id);
      // panTo, no setView: mantener el zoom que el usuario haya elegido.
      if (m) mapa.panTo(m.marcador.getLatLng(), { animate: true, duration: 0.4 });
    }

    if (carrusel) {
      for (const t of carrusel.children) {
        t.classList.toggle('tarjeta-punto--activa', Number(t.dataset.puntoId) === id);
      }
    }
  }

  /** Desplaza el carrusel hasta la tarjeta de un punto. */
  function irATarjeta(id, { desdeMapa = false } = {}) {
    if (!carrusel) return;
    const tarjeta = carrusel.querySelector(`[data-punto-id="${id}"]`);
    if (!tarjeta) return;

    moviendoYo = true;
    tarjeta.scrollIntoView({ behavior: 'smooth', block: 'nearest', inline: 'center' });
    resaltar(id, { centrarMapa: !desdeMapa });
    setTimeout(ajustarFlechas, 500);
    // El scroll suave tarda; soltamos el cerrojo cuando ya ha parado.
    clearTimeout(irATarjeta.reloj);
    irATarjeta.reloj = setTimeout(() => { moviendoYo = false; }, 600);
  }

  /** Qué tarjeta está en el centro del carrusel ahora mismo. */
  function tarjetaCentrada() {
    if (!carrusel) return null;
    const centro = carrusel.scrollLeft + carrusel.clientWidth / 2;
    let mejor = null;
    let menorDistancia = Infinity;
    for (const t of carrusel.children) {
      const d = Math.abs(t.offsetLeft + t.offsetWidth / 2 - centro);
      if (d < menorDistancia) { menorDistancia = d; mejor = t; }
    }
    return mejor;
  }

  if (carrusel) {
    let relojScroll;
    carrusel.addEventListener('scroll', () => {
      if (moviendoYo) return;
      // Esperamos a que pare de deslizarse: mover el mapa en cada píxel marea.
      clearTimeout(relojScroll);
      relojScroll = setTimeout(() => {
        const t = tarjetaCentrada();
        if (t) resaltar(Number(t.dataset.puntoId), { centrarMapa: true });
      }, 120);
    }, { passive: true });

    // Tocar una tarjeta también la selecciona y lleva el mapa a su marcador:
    // antes solo funcionaba en un sentido (del mapa a la tarjeta).
    carrusel.addEventListener('click', (ev) => {
      if (ev.target.closest('button, a')) return;   // los botones son suyos
      const tarjeta = ev.target.closest('.tarjeta-punto');
      if (!tarjeta) return;
      irATarjeta(Number(tarjeta.dataset.puntoId));
    });

    // Empezamos por el primero: el más importante según la IA.
    const primera = carrusel.children[0];
    if (primera) resaltar(Number(primera.dataset.puntoId), { centrarMapa: false });
  }

  // ===========================================================================
  // RECORRER EL CARRUSEL
  // ===========================================================================
  // En el móvil se desliza con el dedo y ya está. En escritorio no había forma
  // decente: la rueda no mueve en horizontal y la barra estaba oculta. Se
  // añaden dos flechas y el arrastre con el ratón.
  const flechaIzq = document.getElementById('flecha-izq');
  const flechaDer = document.getElementById('flecha-der');

  /** Lo que mide una tarjeta más su hueco: lo que avanza cada flecha. */
  function pasoDelCarrusel() {
    const tarjeta = carrusel?.querySelector('.tarjeta-punto');
    if (!tarjeta) return 300;
    const hueco = parseFloat(getComputedStyle(carrusel).gap) || 12;
    return tarjeta.offsetWidth + hueco;
  }

  /** Cada flecha solo aparece si hay algo por ese lado. */
  function ajustarFlechas() {
    if (!carrusel || !flechaIzq || !flechaDer) return;
    const margen = 8;   // holgura: el scroll no siempre cae en el píxel exacto
    flechaIzq.hidden = carrusel.scrollLeft <= margen;
    flechaDer.hidden =
      carrusel.scrollLeft + carrusel.clientWidth >= carrusel.scrollWidth - margen;
  }

  /**
   * Mueve el carrusel y reajusta las flechas cuando el desplazamiento ha
   * terminado.
   *
   * El reajuste NO se deja solo en manos del evento `scroll`: con
   * `scroll-behavior: smooth` y `scroll-snap` de por medio, ese evento no
   * siempre llega cuando el movimiento lo provoca el propio código, y las
   * flechas se quedaban como estaban. Se llama también aquí, a mano, después
   * de cada empujón.
   */
  function empujar(px) {
    carrusel.scrollBy({ left: px, behavior: 'smooth' });
    setTimeout(ajustarFlechas, 450);
    setTimeout(ajustarFlechas, 900);   // por si el snap remata más tarde
  }

  flechaIzq?.addEventListener('click', () => empujar(-pasoDelCarrusel()));
  flechaDer?.addEventListener('click', () => empujar(pasoDelCarrusel()));

  if (carrusel) {
    carrusel.addEventListener('scroll', ajustarFlechas, { passive: true });
    window.addEventListener('resize', ajustarFlechas);
    // Al cargar, las imágenes cambian el ancho: se recalcula cuando acaban.
    window.addEventListener('load', ajustarFlechas);
    ajustarFlechas();

    // --- Arrastre con el ratón -------------------------------------------
    // Con pointer events, que valen para ratón y para lápiz sin duplicar código.
    // El táctil se queda fuera a propósito: el navegador ya lo hace mejor.
    let arrastrando = false;
    let empezoEn = 0;
    let scrollAlEmpezar = 0;
    let recorrido = 0;

    carrusel.addEventListener('pointerdown', (ev) => {
      if (ev.pointerType === 'touch') return;
      // Los botones y enlaces de la tarjeta siguen siendo suyos.
      if (ev.target.closest('button, a')) return;

      arrastrando = true;
      recorrido = 0;
      empezoEn = ev.clientX;
      scrollAlEmpezar = carrusel.scrollLeft;
      carrusel.classList.add('carrusel--agarrado');
      // Sin esto, el scroll suave pelea con el arrastre y da tirones.
      carrusel.style.scrollBehavior = 'auto';
    });

    carrusel.addEventListener('pointermove', (ev) => {
      if (!arrastrando) return;
      const movido = ev.clientX - empezoEn;
      recorrido = Math.abs(movido);
      carrusel.scrollLeft = scrollAlEmpezar - movido;
      ajustarFlechas();
    });

    const soltar = () => {
      if (!arrastrando) return;
      arrastrando = false;
      carrusel.classList.remove('carrusel--agarrado');
      carrusel.style.scrollBehavior = '';
      ajustarFlechas();
    };

    carrusel.addEventListener('pointerup', soltar);
    carrusel.addEventListener('pointerleave', soltar);
    carrusel.addEventListener('pointercancel', soltar);

    // Un arrastre no debe acabar en clic. Si se ha movido más de unos píxeles,
    // el clic que viene detrás se anula: si no, arrastrar sobre una tarjeta
    // acabaría abriendo su ficha.
    carrusel.addEventListener('click', (ev) => {
      if (recorrido > 6) {
        ev.preventDefault();
        ev.stopPropagation();
        recorrido = 0;
      }
    }, true);
  }

  // ===========================================================================
  // BOTONES DE LAS TARJETAS
  // ===========================================================================
  if (carrusel) {
    carrusel.addEventListener('click', async (ev) => {
      const boton = ev.target.closest('[data-accion]');
      if (!boton) return;

      const tarjeta = boton.closest('.tarjeta-punto');
      const puntoId = Number(tarjeta?.dataset.puntoId);
      const base = carrusel.dataset.urlBase;
      const viaje = carrusel.dataset.viaje;
      if (!puntoId || !base || !viaje) return;

      if (boton.dataset.accion === 'investigar') {
        await investigar(boton, tarjeta, `${base}/punto/${puntoId}/investigar?viaje=${viaje}`);
      } else if (boton.dataset.accion === 'a-mi-ruta') {
        await aMiRuta(boton, `${base}/punto/${puntoId}/a-mi-ruta?viaje=${viaje}`);
      }
    });

    // ---------------------------------------------------------------------
    // CIUDAD DE ENTRADA
    // ---------------------------------------------------------------------
    // Es un `change` y no un `click` porque el control es una casilla de
    // verdad: así funciona también con el teclado.
    //
    // SE COMPORTA COMO UN GRUPO DE OPCIONES, no como una casilla suelta: solo
    // puede haber una ciudad de entrada, y se cambia marcando otra. Desmarcar
    // la que está no significa nada —el viaje entra por algún sitio— así que
    // se vuelve a poner y se dice por qué.
    carrusel.addEventListener('change', async (ev) => {
      const casilla = ev.target.closest('[data-accion="ciudad-entrada"]');
      if (!casilla) return;

      const etiqueta = casilla.closest('[data-entrada-de]');
      const puntoId = Number(etiqueta?.dataset.entradaDe);
      const base = carrusel.dataset.urlBase;
      const viaje = carrusel.dataset.viaje;
      if (!puntoId || !base || !viaje) return;

      if (!casilla.checked) {
        casilla.checked = true;
        avisar('Marca otra ciudad para cambiar por dónde entras.');
        return;
      }

      casilla.disabled = true;
      try {
        const r = await fetch(`${base}/punto/${puntoId}/ciudad-entrada?viaje=${viaje}`, {
          method: 'POST',
          headers: { Accept: 'application/json' },
        });
        const datosR = await r.json().catch(() => ({}));
        if (!r.ok) throw new Error(datosR.error || `Error ${r.status}`);

        const nombre = etiqueta.closest('.tarjeta-punto')?.querySelector('.tarjeta-punto__nombre');
        avisarConEnlace(
          `Entras por ${nombre?.textContent.trim() ?? 'esa ciudad'}`,
          'Ver mi ruta',
          `/viaje/${viaje}/ruta`
        );
        // Todo cambia a la vez: la que era entrada deja de serlo, la ciudad
        // queda confirmada en la ruta y TODAS las distancias se miden desde
        // otro sitio. Se repinta entero, que es más simple y más seguro que
        // ir tocando trozos.
        await refrescar();
      } catch (err) {
        console.error('[descubrir] no se pudo marcar la ciudad de entrada:', err);
        casilla.checked = false;
        avisar(err.message);
      } finally {
        casilla.disabled = false;
      }
    });
  }

  /** [Investigar] -> encola el trabajo y deja el botón girando. */
  async function investigar(boton, tarjeta, url) {
    boton.disabled = true;
    try {
      const r = await fetch(url, { method: 'POST', headers: { Accept: 'application/json' } });
      if (!r.ok) throw new Error((await r.json().catch(() => ({}))).error || `Error ${r.status}`);

      boton.outerHTML =
        '<span class="boton boton--secundario boton--esperando" data-accion="investigando">' +
        '<span class="rueda" aria-hidden="true"></span> Investigando…</span>';
      tarjeta.dataset.estado = 'investigando';

      const m = marcadores.get(Number(tarjeta.dataset.puntoId));
      if (m) {
        m.estado = 'investigando';
        m.marcador.setIcon(iconoDe('investigando', Number(tarjeta.dataset.puntoId) === idActivo));
      }
      arrancarSondeo();
    } catch (err) {
      console.error('[descubrir] no se pudo lanzar la investigación:', err);
      boton.disabled = false;
      avisar(err.message);
    }
  }

  /**
   * El botón de añadir. Hace dos cosas distintas según el nivel del destino, y
   * el servidor ya sabe cuál: aquí solo se pinta lo que conteste.
   *
   *  - País: crea una etapa. El botón pasa a "En tu ruta".
   *  - Ciudad: apunta el sitio dentro de la etapa de esa ciudad, creándola sola
   *    si hacía falta. El botón pasa a "Apuntado".
   */
  async function aMiRuta(boton, url) {
    const esCiudad = Boolean(carrusel?.dataset.ciudad);
    boton.disabled = true;
    try {
      const r = await fetch(url, { method: 'POST', headers: { Accept: 'application/json' } });
      // Ojo con el nombre: `datos` de fuera son los del mapa. Llamar igual a la
      // respuesta tapaba aquel dentro de esta función.
      const datosRespuesta = await r.json().catch(() => ({}));
      if (!r.ok) throw new Error(datosRespuesta.error || `Error ${r.status}`);

      boton.classList.remove('boton--primario');
      boton.classList.add('boton--hecho');
      boton.innerHTML = esCiudad
        ? '<i class="ti ti-check" aria-hidden="true"></i> Apuntado'
        : '<i class="ti ti-check" aria-hidden="true"></i> En tu ruta';

      // Aviso discreto con el atajo, sin sacar a nadie de aquí: lo normal es
      // seguir mirando el mapa y añadir dos o tres sitios más de una tacada.
      const viaje = carrusel?.dataset.viaje;
      if (!viaje) return;

      if (esCiudad) {
        // La ciudad solo entra en la ruta la primera vez, y solo entonces se
        // avisa: repetirlo con cada museo sería ruido.
        if (datosRespuesta.etapaNueva) {
          avisarConEnlace(`${datosRespuesta.ciudad} añadida a tu ruta`, 'Ver mi ruta', `/viaje/${viaje}/ruta`);
          subirContadorDeRuta();
        }
      } else {
        avisarConEnlace('Añadido a tu ruta', 'Ver mi ruta', `/viaje/${viaje}/ruta`);
        subirContadorDeRuta();
      }

      // Y AQUÍ ESTABA EL FALLO. La tarjeta se pintaba de "En tu ruta" y hasta
      // ahí llegaba todo: el marcador seguía igual y, sobre todo, la ciudad no
      // aparecía en la lista de las que llevan línea punteada, porque esa lista
      // vive en `marcadores` y nadie la actualizaba. Había que salir de la
      // pantalla y volver a entrar para verlo.
      await refrescar();
    } catch (err) {
      console.error('[descubrir] no se pudo añadir:', err);
      boton.disabled = false;
      avisar(err.message);
    }
  }

  /**
   * Sube el contador de "Mi ruta" con un pulso.
   *
   * Se suma aquí en el cliente en vez de preguntarlo: el servidor acaba de
   * confirmar el alta, así que el número es +1 seguro y el pulso se ve al
   * instante en vez de después de una ida y vuelta.
   */
  function subirContadorDeRuta() {
    const cuenta = document.getElementById('cuenta-ruta');
    if (!cuenta) return;
    cuenta.textContent = Number(cuenta.textContent || 0) + 1;
    cuenta.classList.remove('pill__cuenta--pulso');
    void cuenta.offsetWidth;          // reiniciar la animación
    cuenta.classList.add('pill__cuenta--pulso');
  }

  /** Como avisar(), pero con un enlace al lado. Dura un poco más: hay que leerlo. */
  function avisarConEnlace(texto, textoEnlace, url) {
    const nota = document.createElement('div');
    nota.className = 'nota-flotante nota-flotante--con-enlace';
    nota.append(texto);
    const a = document.createElement('a');
    a.href = url;
    a.textContent = textoEnlace;
    nota.append(a);
    document.body.appendChild(nota);
    setTimeout(() => nota.remove(), 6000);
  }

  /** Un aviso discreto abajo, que se va solo. Nada de alert(), que bloquea. */
  function avisar(texto) {
    const nota = document.createElement('div');
    nota.className = 'nota-flotante';
    nota.textContent = texto;
    document.body.appendChild(nota);
    setTimeout(() => nota.remove(), 4000);
  }

  // ===========================================================================
  // SONDEO mientras haya algo investigándose
  // ===========================================================================
  // Solo se enciende si hace falta: si no hay nada en curso, ni una petición.
  let sondeando = false;

  function arrancarSondeo() {
    if (sondeando || !destinoId) return;
    sondeando = true;
    setTimeout(comprobar, 5000);
  }

  /**
   * Cada vuelta REPINTA, mire lo que mire.
   *
   * Antes esto comparaba qué tarjetas seguían investigándose y, si alguna había
   * terminado, recargaba la página entera. Tenía dos problemas y los dos se
   * notaban:
   *
   *   - Recargar es un martillazo: se pierde el encuadre del mapa, la tarjeta
   *     que estabas mirando y el sitio del carrusel.
   *   - Y sobre todo, solo se enteraba de un cambio si LA PROPIA PANTALLA había
   *     visto empezar la investigación. Si el trabajo ya estaba en marcha al
   *     entrar, o si el sondeo se saltaba justo el momento en que terminaba, la
   *     tarjeta se quedaba para siempre con su ruedecita y su línea de
   *     distancia sin pintar. Eso es lo que le pasó a Gdansk.
   *
   * Ahora se pide el estado completo y se pinta lo que diga el servidor. Sin
   * comparar nada, sin recordar nada: si algo cambió, se ve; y si no cambió,
   * repintar lo mismo no cuesta nada.
   */
  async function comprobar() {
    try {
      const estado = await refrescar();
      // Se para cuando no queda nada en marcha, ni investigándose ni
      // calculándose. Preguntar cada cinco segundos por gusto no tiene sentido.
      if (estado && !estado.investigando?.length && !estado.calculando) {
        sondeando = false;
        return;
      }
    } catch (err) {
      console.error('[descubrir] no se pudo consultar el estado:', err);
    }
    setTimeout(comprobar, 5000);
  }

  // Al cargar ya no hace falta mirar las tarjetas para saber si hay algo en
  // marcha: el `refrescar()` del final pregunta al servidor y enciende el
  // sondeo si toca. Mirar el DOM era además lo que dejaba fuera el caso de
  // Gdansk: si el trabajo empezó en otra pestaña, aquí no había ninguna
  // ruedecita que ver y nunca se sondeaba.

  // ===========================================================================
  // DISTANCIAS DESDE LA CIUDAD DE ENTRADA
  // ---------------------------------------------------------------------------
  // Para decidir la ruta hace falta saber si Florencia está a tiro de Roma o si
  // son tres horas de carretera. El mapa hasta ahora solo decoraba.
  //
  // NO SE ESPERA A NADIE. Se pide lo que hay en caché, se pinta, y si falta algo
  // el servidor lo va calculando por detrás mientras se sondea. Una distancia
  // que tarda deja un guión; nunca deja la pantalla en blanco.
  //
  // Las LÍNEAS solo se dibujan a las ciudades SELECCIONADAS —las que ya están en
  // la ruta—: una a cada candidata sería una telaraña sobre el mapa.
  // ===========================================================================
  const viajeId = datos.viaje?.id ?? null;
  const destinoId = datos.destino?.id ?? null;

  /** id de ciudad -> lo que sabemos de su distancia. */
  let distancias = {};
  let referencia = null;

  /** Las líneas dibujadas, para poder rehacerlas sin duplicar. */
  const capaLineas = L.layerGroup().addTo(mapa);

  function pintarDistanciaEnFicha(id, dato) {
    const linea = carrusel?.querySelector(`[data-distancia-de="${id}"]`);
    if (!linea) return;

    if (!dato) {
      linea.hidden = false;
      linea.querySelector('[data-distancia-texto]').textContent = '—';
      linea.className = 'tarjeta-punto__distancia';
      return;
    }
    linea.hidden = false;
    linea.querySelector('[data-distancia-texto]').textContent = dato.texto;
    linea.className =
      'tarjeta-punto__distancia' +
      (dato.gravedad === 'cerca' ? '' : ` tarjeta-punto__distancia--${dato.gravedad}`);
  }

  /** Las líneas punteadas de la referencia a lo que ya está en la ruta. */
  function pintarLineas() {
    capaLineas.clearLayers();
    if (!referencia) return;

    const origen = marcadores.get(referencia.ciudadId);
    if (!origen) return;
    const desde = origen.marcador.getLatLng();

    for (const [id, m] of marcadores) {
      if (id === referencia.ciudadId) continue;
      // Solo las elegidas: las candidatas sin elegir llenarían el mapa de rayas.
      if (!m.enRuta) continue;

      const dato = distancias[id];
      const hasta = m.marcador.getLatLng();

      L.polyline([desde, hasta], {
        color: '#1B7FA6',
        weight: 1.5,
        opacity: 0.55,
        dashArray: '4 6',
        interactive: false,
      }).addTo(capaLineas);

      if (!dato?.etiqueta) continue;

      const medio = L.latLng((desde.lat + hasta.lat) / 2, (desde.lng + hasta.lng) / 2);
      L.marker(medio, {
        interactive: false,
        icon: L.divIcon({
          className: '',
          html:
            `<span class="etiqueta-distancia${dato.gravedad === 'cerca' ? '' : ' etiqueta-distancia--' + dato.gravedad}">` +
            `${dato.etiqueta}</span>`,
          iconSize: null,
        }),
      }).addTo(capaLineas);
    }
  }

  // ===========================================================================
  // REFRESCAR: una llamada y el mapa entero al día
  // ---------------------------------------------------------------------------
  // Se pide TODO junto —estado de cada punto, referencia y distancias— y se
  // repinta entero. Pedirlo por trozos deja medio mapa de una época y medio de
  // otra: la tarjeta ya dice "En tu ruta" pero la línea punteada todavía no
  // está, o la referencia se ha movido y las distancias siguen siendo las de
  // antes.
  //
  // Repintar de más no cuesta nada; repintar de menos es justo el fallo que
  // había.
  // ===========================================================================

  /** Cómo se ve la acción de investigar según en qué anda el punto. */
  function botonDeInvestigar(estado, ficha) {
    if (estado === 'investigando') {
      return (
        '<span class="boton boton--secundario boton--esperando" data-accion="investigando">' +
        '<span class="rueda" aria-hidden="true"></span> Investigando…</span>'
      );
    }
    if (estado === 'investigada' && ficha) {
      return (
        `<a class="boton boton--secundario" href="${ficha}" data-accion="ver-ficha">` +
        '<i class="ti ti-file-text" aria-hidden="true"></i> Ver ficha</a>'
      );
    }
    return (
      '<button class="boton boton--secundario" type="button" data-accion="investigar">' +
      '<i class="ti ti-sparkles" aria-hidden="true"></i> Investigar</button>'
    );
  }

  /** Pone al día una tarjeta del carrusel con lo que dice el servidor. */
  function refrescarTarjeta(p) {
    const tarjeta = carrusel?.querySelector(`[data-punto-id="${p.id}"]`);
    if (!tarjeta) return;

    // --- El botón de investigar, si de verdad ha cambiado ------------------
    // Se compara antes de tocar el DOM: rehacerlo en cada vuelta del sondeo
    // haría parpadear la ruedecita cada cinco segundos.
    if (tarjeta.dataset.estado !== p.estado) {
      tarjeta.dataset.estado = p.estado;
      const viejo = tarjeta.querySelector(
        '[data-accion="investigar"], [data-accion="investigando"], [data-accion="ver-ficha"]'
      );
      if (viejo) viejo.outerHTML = botonDeInvestigar(p.estado, p.ficha);
    }

    // --- El botón de añadir -----------------------------------------------
    const anadir = tarjeta.querySelector('[data-accion="a-mi-ruta"]');
    if (anadir && p.enRuta && !anadir.disabled) {
      anadir.disabled = true;
      anadir.classList.remove('boton--primario');
      anadir.classList.add('boton--hecho');
      anadir.innerHTML = carrusel.dataset.ciudad
        ? '<i class="ti ti-check" aria-hidden="true"></i> Apuntado'
        : '<i class="ti ti-check" aria-hidden="true"></i> En tu ruta';
    }

    // --- El control de ciudad de entrada ----------------------------------
    const entrada = tarjeta.querySelector('[data-entrada-de]');
    if (entrada) {
      entrada.classList.toggle('entrada--si', p.esEntrada);
      const casilla = entrada.querySelector('input');
      if (casilla) casilla.checked = p.esEntrada;
    }
  }

  /** El marcador del mapa: su icono y si le toca línea. */
  function refrescarMarcador(p) {
    const m = marcadores.get(p.id);
    if (!m) return;

    // `enRuta` es lo que decide si se le pinta línea punteada, y era justo lo
    // que se quedaba desactualizado al añadir una ciudad.
    m.enRuta = p.enRuta;
    m.ficha = p.ficha;

    if (m.estado !== p.estado) {
      m.estado = p.estado;
      m.marcador.setIcon(iconoDe(p.estado, p.id === idActivo));
    }

    // Al terminar de investigarse gana globo con el atajo a su ficha.
    if (p.ficha && !m.marcador.getPopup()) {
      m.marcador.bindPopup(
        `<strong>${escapar(p.nombre ?? '')}</strong><br>` +
          `<a class="popup__enlace" href="${p.ficha}">Ver ficha →</a>`,
        { closeButton: false, offset: [0, -6] }
      );
    }
  }

  let refrescando = null;

  /**
   * Trae el estado completo y lo pinta. Devuelve lo que dijo el servidor.
   *
   * Si ya hay una llamada en marcha se devuelve esa misma en vez de lanzar
   * otra: el sondeo y un clic pueden coincidir, y dos respuestas pisándose
   * dejarían el mapa a medias.
   */
  function refrescar() {
    if (refrescando) return refrescando;
    refrescando = traerYPintar().finally(() => { refrescando = null; });
    return refrescando;
  }

  async function traerYPintar() {
    if (!destinoId) return null;

    const url =
      `/api/destinos/${destinoId}/mapa` + (viajeId ? `?viaje=${viajeId}` : '');

    let estado;
    try {
      const r = await fetch(url, { headers: { Accept: 'application/json' } });
      if (!r.ok) throw new Error(`El servidor respondió ${r.status}`);
      estado = await r.json();
    } catch (err) {
      console.warn('[descubrir] no se pudo refrescar el mapa:', err.message);
      return null;
    }

    referencia = estado.referencia ?? null;
    distancias = estado.distancias ?? {};

    for (const p of estado.puntos ?? []) {
      // El nombre no viaja en esta respuesta: lo tenemos del pintado inicial.
      const nombre = marcadores.get(p.id)?.marcador.options.title ?? '';
      refrescarTarjeta(p);
      refrescarMarcador({ ...p, nombre });
    }

    // La ciudad de entrada no se mide contra sí misma: su línea se borra.
    for (const [id] of marcadores) {
      if (id === referencia?.ciudadId) {
        const linea = carrusel?.querySelector(`[data-distancia-de="${id}"]`);
        if (linea) linea.hidden = true;
        continue;
      }
      pintarDistanciaEnFicha(id, distancias[id] ?? null);
    }

    pintarLineas();

    // Mientras quede algo en marcha —una investigación o un par de ciudades
    // sin calcular— se sigue mirando. El sondeo se enciende solo.
    if (estado.investigando?.length || estado.calculando) arrancarSondeo();

    return estado;
  }

  refrescar();
})();
