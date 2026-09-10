/**
 * public/js/elegir-destino.js
 * -----------------------------------------------------------------------------
 * El mapamundi donde se elige a dónde se va.
 *
 * Dos formas de llegar al mismo sitio: tocar el mapa o escribir el nombre. Las
 * dos acaban en la misma tarjeta y en el mismo botón, así que el código de la
 * tarjeta es uno solo y no hay dos caminos que mantener.
 *
 * La geocodificación NO se pide desde aquí: va contra /api/geocodificar, que es
 * un proxy del servidor. La clave de Google está restringida por IP y no puede
 * una petición por segundo, y ninguna de las dos cosas se puede garantizar
 * desde el navegador.
 */
(() => {
  const divMapa = document.getElementById('mapamundi');
  if (!divMapa || typeof L === 'undefined') return;

  const viajeId = document.querySelector('.mundo')?.dataset.viaje;
  const bandeja = document.getElementById('bandeja');
  const pista = document.getElementById('pista');

  const vistas = {
    cargando: document.getElementById('vista-cargando'),
    sitio: document.getElementById('vista-sitio'),
    preparando: document.getElementById('vista-preparando'),
    nada: document.getElementById('vista-nada'),
  };

  // ===========================================================================
  // EL MAPA
  // ===========================================================================
  const mapa = L.map(divMapa, {
    zoomControl: false,
    minZoom: 2,
    // Sin esto, al arrastrar más allá del meridiano 180 el mapa se queda en una
    // copia del mundo y los marcadores parecen estar en otro sitio.
    worldCopyJump: true,
  }).setView([30, 10], 2.5);

  // LAS TESELAS: Google en español, y OSM si Google falla.
  //
  // Aquí no había nada de Google: ni una línea, ni el puente con Leaflet, ni la
  // clave. El mapa se pintaba con las teselas del Humanitarian OSM Team y ya.
  // Por eso en esta pantalla no aparecía ningún error de Google en la consola
  // NI una sola petición a maps.googleapis.com: no es que fallara, es que no
  // existía el código que la haría.
  //
  // En un mapamundi el idioma se nota más que en ningún otro sitio: con OSM los
  // países salen en su lengua local (Warszawa, Lisboa, Milano) y con Google en
  // español (Varsovia, Lisboa, Milán). Elegir a dónde vas leyendo topónimos en
  // polaco es peor de lo que parece.
  //
  // El respaldo sigue siendo el de HOT, que es más cálido y con menos ruido que
  // el OSM estándar, y su atribución es obligatoria: va abajo a la derecha.
  Teselas.poner(mapa, {
    clave: document.querySelector('.mundo')?.dataset.claveMapas ?? '',
    contexto: 'elegir destino (mapamundi)',
    humanitario: true,
  });

  L.control.zoom({ position: 'bottomright', zoomInTitle: 'Acercar', zoomOutTitle: 'Alejar' }).addTo(mapa);

  /** La gota azul del estilo de la app. Nada de la chincheta por defecto. */
  const PIN = L.divIcon({
    className: '',
    html: '<span class="gota"></span>',
    iconSize: [26, 34],
    iconAnchor: [13, 32],   // la punta de la gota, no su centro
  });

  let marcador = null;

  function ponerMarcador(lat, lon) {
    if (marcador) marcador.setLatLng([lat, lon]);
    else marcador = L.marker([lat, lon], { icon: PIN, keyboard: false }).addTo(mapa);
  }

  function quitarMarcador() {
    if (marcador) {
      mapa.removeLayer(marcador);
      marcador = null;
    }
  }

  // ===========================================================================
  // LA BANDEJA
  // ===========================================================================
  /** Sube la bandeja enseñando una de sus tres vistas. */
  function abrir(cual) {
    for (const [nombre, el] of Object.entries(vistas)) el.hidden = nombre !== cual;
    bandeja.classList.add('bandeja--abierta');
  }

  function cerrar() {
    bandeja.classList.remove('bandeja--abierta');
    quitarMarcador();
    elegido = null;
  }

  for (const b of document.querySelectorAll('[data-cerrar]')) b.addEventListener('click', cerrar);

  // Escapar cierra, que es lo que espera cualquiera.
  document.addEventListener('keydown', (ev) => {
    if (ev.key === 'Escape' && bandeja.classList.contains('bandeja--abierta')) cerrar();
  });

  /** El sitio que está ahora en la bandeja, o null. */
  let elegido = null;

  /** Pinta un sitio en la bandeja y deja el botón listo. */
  function mostrarSitio(sitio) {
    elegido = sitio;

    document.getElementById('sitio-pais').textContent = sitio.pais ?? '';
    document.getElementById('sitio-pais').hidden = !sitio.pais;
    document.getElementById('sitio-nombre').textContent = sitio.nombre;

    const chip = document.getElementById('sitio-tipo');
    chip.textContent = sitio.tipo === 'ciudad' ? 'Ciudad' : 'País';

    document.getElementById('sitio-texto').textContent =
      `Prepararé los imprescindibles de ${sitio.nombre}: qué ver, cuántos días ` +
      'dedicar a cada sitio y por dónde empezar.';

    document.getElementById('boton-investigar-texto').textContent = `Investigar ${sitio.nombre}`;
    document.getElementById('boton-investigar').disabled = false;

    abrir('sitio');
  }

  /** Pinta el "aquí no hay nada" con el texto que toque. */
  function mostrarNada(titulo, texto) {
    document.getElementById('nada-titulo').textContent = titulo;
    document.getElementById('nada-texto').textContent = texto;
    abrir('nada');
  }

  // ===========================================================================
  // TOCAR EL MAPA
  // ===========================================================================
  // Cada consulta lleva número: si alguien toca tres sitios seguidos, solo vale
  // la última. Sin esto, una respuesta lenta puede pisar a una posterior.
  let consulta = 0;

  mapa.on('click', async (ev) => {
    if (pista) pista.hidden = true;   // ya sabe que se puede tocar

    const { lat, lng } = ev.latlng;
    ponerMarcador(lat, lng);
    abrir('cargando');

    const mia = ++consulta;
    try {
      const url = `/api/geocodificar?lat=${lat}&lon=${lng}&zoom=${mapa.getZoom()}`;
      const r = await fetch(url, { headers: { Accept: 'application/json' } });
      const datos = await r.json();
      if (mia !== consulta) return;   // llegó tarde: manda otra

      if (!r.ok) throw new Error(datos.error || `Error ${r.status}`);

      if (datos.hay) mostrarSitio(datos);
      else mostrarNada('Ahí solo hay agua', 'Prueba a tocar tierra firme, o usa el buscador de arriba.');
    } catch (err) {
      if (mia !== consulta) return;
      console.error('[mundo] no se pudo identificar el sitio:', err);
      mostrarNada('No he podido saber qué hay ahí', 'Prueba otra vez, o busca el sitio por su nombre.');
    }
  });

  // ===========================================================================
  // BUSCAR POR NOMBRE
  // ===========================================================================
  const formulario = document.getElementById('buscador');
  const campo = document.getElementById('campo-busqueda');

  formulario?.addEventListener('submit', async (ev) => {
    ev.preventDefault();
    const texto = campo.value.trim();
    if (!texto) return;

    if (pista) pista.hidden = true;
    formulario.classList.add('buscador--buscando');
    abrir('cargando');

    const mia = ++consulta;
    try {
      // ================== ¿ESTO SON VARIOS PAÍSES? ==================
      //
      // VA ANTES DE GOOGLE Y NO DESPUÉS, y ese orden es todo el arreglo.
      // Geocodificar «Viaje por Bosnia, croacia y montenegro» devuelve UN sitio
      // —Croacia—, y a partir de ahí el texto original ya no existe: lo que
      // seguía viajando al servidor era «Croacia», así que la detección miraba
      // un solo país y decidía, con toda la razón, que era un viaje normal.
      //
      // El servidor descarta de balde lo que no puede ser una lista, así que un
      // «Portugal» no cuesta ni una llamada a la IA.
      if (viajeId) {
        const rp = await fetch(`/api/viajes/${viajeId}/destino/interpretar`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
          body: JSON.stringify({ texto }),
        });
        const paises = await rp.json().catch(() => ({}));
        if (mia !== consulta) return;

        // SI ESTO FALLA, QUE SE VEA. El fallo callado costó una tarde: con el
        // servidor arrancado antes de que existiera la ruta, la petición
        // devolvía un 404 con HTML, `rp.json()` reventaba, el catch lo tragaba y
        // el buscador seguía al geocodificador como si nada. Desde fuera era
        // idéntico a «la detección no funciona».
        //
        // Se sigue sin bloquear el viaje —quedarse sin poder elegir destino sería
        // peor—, pero ahora la consola lo dice.
        if (!rp.ok) {
          console.warn(
            `[mundo] no pude interpretar el destino (el servidor respondió ${rp.status}). ` +
              'Si esperabas la detección de varios países, reinicia el servidor: ' +
              'esa ruta puede no existir todavía en el proceso que está corriendo.'
          );
        }

        if (rp.ok && paises.multipais) {
          window.location.href = paises.url;
          return;
        }
      }

      const r = await fetch(`/api/geocodificar-texto?q=${encodeURIComponent(texto)}`, {
        headers: { Accept: 'application/json' },
      });
      const datos = await r.json();
      if (mia !== consulta) return;

      if (!r.ok) throw new Error(datos.error || `Error ${r.status}`);

      if (!datos.hay) {
        mostrarNada('No encuentro ese sitio', 'Prueba con otro nombre o toca el mapa.');
        return;
      }

      // A un país se le mira entero; a una ciudad se le entra.
      mapa.flyTo([datos.lat, datos.lon], datos.zoomVuelo ?? 6, { duration: 1.2 });
      ponerMarcador(datos.lat, datos.lon);
      mostrarSitio(datos);
    } catch (err) {
      if (mia !== consulta) return;
      console.error('[mundo] no se pudo buscar:', err);
      mostrarNada('No he podido buscar', 'Prueba otra vez dentro de un momento.');
    } finally {
      formulario.classList.remove('buscador--buscando');
    }
  });

  // ===========================================================================
  // INVESTIGAR
  // ===========================================================================
  const botonInvestigar = document.getElementById('boton-investigar');

  botonInvestigar?.addEventListener('click', async () => {
    if (!elegido || !viajeId) return;

    botonInvestigar.disabled = true;
    const texto = document.getElementById('boton-investigar-texto');
    const antes = texto.textContent;
    texto.textContent = 'Preparando…';

    try {
      const r = await fetch('/api/destinos/elegir', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
        body: JSON.stringify({
          nombre: elegido.nombre,
          tipo: elegido.tipo,
          lat: elegido.lat,
          lon: elegido.lon,
          viajeId: Number(viajeId),
        }),
      });
      const datos = await r.json();
      if (!r.ok) throw new Error(datos.error || `Error ${r.status}`);

      // EL NIVEL DEL DESTINO DECIDE QUÉ PASA AHORA.
      //
      //  - País o región: a la pantalla de exploración, que ya sabe enseñar
      //    "investigando" y sondear. Ahí hay ciudades entre las que elegir.
      //  - Ciudad: no hay nada que elegir. Nos quedamos AQUÍ contando lo que se
      //    está buscando y, cuando está, se entra directamente en su parada.
      // 'explorar' (país o región) y 'ruta' (la ciudad ya está más de una vez en
      // el viaje) se resuelven igual: se va a donde diga el servidor.
      if (datos.modo !== 'ciudad') {
        location.href = datos.url;
        return;
      }

      if (datos.listo) {
        location.href = datos.url;
        return;
      }

      esperarACiudad(datos);
    } catch (err) {
      console.error('[mundo] no se pudo elegir el destino:', err);
      texto.textContent = antes;
      botonInvestigar.disabled = false;
      avisar(err.message);
    }
  });

  /**
   * Se queda en el mapa enseñando el progreso hasta que la parada está lista.
   *
   * Los mensajes los da el servidor, que es quien sabe por dónde va: primero
   * los sitios y después las excursiones. Aquí no se adivina el orden.
   */
  function esperarACiudad(datos) {
    document.getElementById('preparando-titulo').textContent = elegido.nombre;
    document.getElementById('preparando-texto').textContent =
      datos.mensaje || `Preparando ${elegido.nombre}…`;
    abrir('preparando');

    const reloj = setInterval(async () => {
      try {
        const r = await fetch(datos.urlEstado, { headers: { Accept: 'application/json' } });
        const estado = await r.json();
        if (!r.ok) throw new Error(estado.error || `Error ${r.status}`);

        if (estado.mensaje) {
          document.getElementById('preparando-texto').textContent = estado.mensaje;
        }

        if (!estado.trabajando) {
          clearInterval(reloj);
          // Aunque haya fallado se entra igual: la etapa enseña el aviso y el
          // botón de reintentar, que es mejor que dejar a nadie en el mapa.
          location.href = datos.url;
        }
      } catch (err) {
        console.error('[mundo] sondeando la preparación:', err);
      }
    }, 4000);
  }

  /** Aviso corto abajo que se va solo. Nada de alert(), que bloquea. */
  function avisar(texto) {
    const nota = document.createElement('div');
    nota.className = 'nota-flotante';
    nota.textContent = texto;
    document.body.appendChild(nota);
    setTimeout(() => nota.remove(), 4000);
  }
})();
