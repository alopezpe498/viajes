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
 * Mapa: Leaflet con teselas de OpenStreetMap. Son gratis y no piden clave, pero
 * exigen la atribución en pantalla: está puesta y no se quita.
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

  L.tileLayer('https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png', {
    maxZoom: 18,
    attribution: '© OpenStreetMap',
  }).addTo(mapa);

  L.control.zoom({ position: 'topright' }).addTo(mapa);

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

    marcadores.set(p.id, { marcador, estado: p.estado, ficha: p.ficha ?? null });
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
      const datos = await r.json().catch(() => ({}));
      if (!r.ok) throw new Error(datos.error || `Error ${r.status}`);

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
        if (datos.etapaNueva) {
          avisarConEnlace(`${datos.ciudad} añadida a tu ruta`, 'Ver mi ruta', `/viaje/${viaje}/ruta`);
          subirContadorDeRuta();
        }
      } else {
        avisarConEnlace('Añadido a tu ruta', 'Ver mi ruta', `/viaje/${viaje}/ruta`);
        subirContadorDeRuta();
      }
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
    if (sondeando || !carrusel?.dataset.estadoUrl) return;
    sondeando = true;
    setTimeout(comprobar, 5000);
  }

  async function comprobar() {
    try {
      const r = await fetch(carrusel.dataset.estadoUrl, { headers: { Accept: 'application/json' } });
      if (!r.ok) throw new Error(`El servidor respondió ${r.status}`);
      const estado = await r.json();

      const enCurso = new Set(estado.investigando ?? []);

      // Si alguna tarjeta estaba investigándose y ya no lo está, es que terminó:
      // recargamos para que salga con su ficha y su marcador con tic.
      const seguian = [...carrusel.children].filter((t) => t.dataset.estado === 'investigando');
      const algunaAcabo = seguian.some((t) => !enCurso.has(Number(t.dataset.puntoId)));
      if (algunaAcabo) { location.reload(); return; }

      if (!enCurso.size) { sondeando = false; return; } // nada en marcha: paramos
    } catch (err) {
      console.error('[descubrir] no se pudo consultar el estado:', err);
    }
    setTimeout(comprobar, 5000);
  }

  // Al cargar puede haber cosas ya en marcha (venías de pulsar y recargaste).
  if (carrusel && [...carrusel.children].some((t) => t.dataset.estado === 'investigando')) {
    arrancarSondeo();
  }
})();
