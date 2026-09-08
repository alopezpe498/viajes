/**
 * public/js/mapa-teselas.js
 * -----------------------------------------------------------------------------
 * LAS TESELAS DE LOS MAPAS, EN UN SOLO SITIO.
 *
 * Google primero, en español, y OpenStreetMap de respaldo si algo falla. Lo
 * usan las dos pantallas con mapa: el mapamundi de elegir destino y el de
 * explorar un destino.
 *
 * POR QUÉ ESTÁ AQUÍ Y NO EN CADA UNA. Estaba escrito solo en descubrir.js, y el
 * mapamundi ni se había enterado: seguía con teselas de OSM y sin una sola
 * línea de código de Google. Por eso allí no había ni error en consola ni una
 * petición a maps.googleapis.com, que es exactamente lo que se ve cuando un
 * código no existe, no cuando falla. Dos mapas con la misma necesidad y una
 * sola implementación: si mañana cambia el proveedor, se cambia una vez.
 *
 * EL RESPALDO ENTRA SIEMPRE que algo salga mal: sin clave, con la clave
 * restringida a otro dominio, con la API caída, con el script bloqueado por una
 * extensión o —el caso feo— con la API cargada pero sin permiso para pintar.
 * Nunca se queda el mapa en gris.
 */
(() => {
  /**
   * El mapa, sin gritar.
   *
   * Google trae por defecto todos los negocios, todas las paradas de metro y
   * los iconos de las carreteras, y encima de eso hay que pintar marcadores,
   * líneas punteadas y etiquetas de distancia. Se apagan las etiquetas de
   * puntos de interés y de transporte —lo que sobra— y se baja la saturación:
   * quedan a la vista las ciudades, las carreteras y la costa, que es lo que se
   * está mirando.
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

  /** Cuánto se espera a que Google PINTE antes de darlo por perdido. */
  const PLAZO_PINTAR = 6000;
  /** Cuánto se espera a que el script llegue y llame al callback. */
  const PLAZO_CARGAR = 8000;

  /** Un salto de línea, para armar el aviso de varias líneas. */
  const SALTO = String.fromCharCode(10);

  /**
   * EL AVISO, y es ruidoso a propósito.
   *
   * El respaldo funcionaba bien y esa era justo la trampa: se caía a OSM con un
   * console.warn de una línea, el mapa se veía "igual que antes" y se podía
   * estar semanas sin Google sin que nada lo dijera. Un respaldo silencioso es
   * un fallo que no existe hasta que alguien lo mira a ojo.
   */
  function avisarDelRespaldo(motivo, contexto) {
    console.warn(
      '%c[mapa] TESELAS DE RESPALDO: OpenStreetMap, no Google.',
      'font-weight:bold;color:#B4501E',
      [
        '',
        '  Pantalla: ' + contexto,
        '  Motivo:   ' + motivo,
        '  Dominio:  ' + location.origin,
        '',
        '  Si esto no es lo que esperabas, en Google Cloud Console:',
        '    · que "Maps JavaScript API" esté ACTIVADA en el proyecto de la clave',
        '    · que el proyecto tenga facturación activa',
        '    · que la restricción por referente incluya ' + location.origin + '/*',
        '    · y que la clave del .env sea la de ESE proyecto (hay dos claves)',
        '',
        '  (Con RefererNotAllowedMapError la API carga sin quejarse y NO dispara',
        '   gm_authFailure: por eso aquí no basta con que cargue; se comprueba',
        '   que PINTE de verdad.)',
      ].join(SALTO)
    );
  }

  /** OpenStreetMap. El que nunca falla y nunca pide permiso. */
  function ponerOSM(mapa, { humanitario = false } = {}) {
    // Las de HOT son más cálidas y con menos ruido; las usa el mapamundi.
    const url = humanitario
      ? 'https://{s}.tile.openstreetmap.fr/hot/{z}/{x}/{y}.png'
      : 'https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png';
    return L.tileLayer(url, {
      maxZoom: humanitario ? 19 : 18,
      subdomains: humanitario ? 'ab' : 'abc',
      attribution: humanitario
        ? '© OpenStreetMap · Teselas: Humanitarian OSM Team'
        : '© OpenStreetMap',
    }).addTo(mapa);
  }

  /**
   * Carga la API de Google UNA SOLA VEZ por página.
   *
   * Se guarda la promesa: si dos mapas la piden a la vez, la segunda espera a la
   * primera en vez de meter otro <script>, que es como se acaba con dos copias
   * de la API peleándose.
   *
   * Tres formas de enterarse de que no va, y hacen falta las tres:
   *   - gm_authFailure, que Google llama en ALGUNOS fallos de clave.
   *   - El onerror del script, si ni siquiera se descarga.
   *   - Un plazo, porque los otros dos no siempre llegan: una extensión que
   *     bloquee el dominio puede dejar la carga colgada sin decir nada.
   */
  let cargando = null;

  function cargarGoogle(clave) {
    if (window.google?.maps) return Promise.resolve();
    if (cargando) return cargando;

    cargando = new Promise((listo, falla) => {
      const CALLBACK = '__mapaListo';
      const reloj = setTimeout(
        () => falla(new Error('la API de Google no contestó en ' + PLAZO_CARGAR / 1000 + ' s')),
        PLAZO_CARGAR
      );
      const terminar = (fn, arg) => { clearTimeout(reloj); fn(arg); };

      window[CALLBACK] = () => terminar(listo);
      window.gm_authFailure = () =>
        terminar(falla, new Error('gm_authFailure: la clave no vale para este dominio'));

      const script = document.createElement('script');
      // `language` y `region` en español: sin esto los nombres salen en el
      // idioma del país que se mira (Warszawa en vez de Varsovia).
      script.src =
        'https://maps.googleapis.com/maps/api/js' +
        '?key=' + encodeURIComponent(clave) +
        '&language=es&region=ES&loading=async&callback=' + CALLBACK;
      script.async = true;
      script.onerror = () =>
        terminar(falla, new Error('no se pudo descargar el script de la API'));
      document.head.appendChild(script);
    }).catch((err) => {
      cargando = null;   // que el siguiente pueda reintentar
      throw err;
    });

    return cargando;
  }

  /**
   * Pone las teselas de Google y COMPRUEBA QUE PINTAN.
   *
   * La comprobación no es paranoia: es el único modo de detectar
   * RefererNotAllowedMapError y compañía. En esos casos la API carga, la capa se
   * añade sin quejarse y el mapa se queda gris para siempre. Se espera al
   * `tilesloaded` del mapa de Google —el evento que dice "ya hay imágenes"— y,
   * si no llega a tiempo, se quita la capa y se vuelve a OpenStreetMap.
   */
  function ponerGoogle(mapa, { maxZoom = 20 } = {}) {
    return new Promise((listo, falla) => {
      if (!L.gridLayer?.googleMutant) {
        return falla(new Error('no cargó Leaflet.GoogleMutant, el puente con Leaflet'));
      }

      const capa = L.gridLayer.googleMutant({ type: 'roadmap', styles: ESTILO_LIMPIO, maxZoom });
      capa.addTo(mapa);

      const reloj = setTimeout(() => {
        mapa.removeLayer(capa);
        falla(
          new Error(
            'la API cargó pero el mapa no llegó a pintar en ' + PLAZO_PINTAR / 1000 + ' s ' +
              '(la clave carga pero no tiene permiso para renderizar)'
          )
        );
      }, PLAZO_PINTAR);

      const alPintar = () => { clearTimeout(reloj); listo(capa); };

      // `_mutant` es el mapa de Google que hay por debajo, y el plugin lo crea
      // un poco después de añadir la capa: por eso se reintenta engancharse.
      const engancharse = () => {
        if (capa._mutant && window.google?.maps?.event) {
          google.maps.event.addListenerOnce(capa._mutant, 'tilesloaded', alPintar);
          return true;
        }
        return false;
      };

      if (!engancharse()) {
        const mirar = setInterval(() => { if (engancharse()) clearInterval(mirar); }, 120);
        setTimeout(() => clearInterval(mirar), PLAZO_PINTAR);
      }
    });
  }

  /**
   * LO ÚNICO QUE SE LLAMA DESDE FUERA.
   *
   * Pone las mejores teselas que se puedan y devuelve cuál se usó, por si la
   * pantalla quiere hacer algo distinto según el caso.
   *
   * @param {L.Map}   mapa                 el mapa de Leaflet ya creado
   * @param {object}  opciones
   * @param {string}  opciones.clave       clave de navegador (puede venir vacía)
   * @param {string}  opciones.contexto    nombre de la pantalla, para el aviso
   * @param {boolean} opciones.humanitario teselas HOT en el respaldo
   * @returns {Promise<'google'|'osm'>}
   */
  async function poner(mapa, { clave = '', contexto = 'mapa', humanitario = false, maxZoom } = {}) {
    if (!clave) {
      avisarDelRespaldo('no hay GOOGLE_MAPS_BROWSER_KEY configurada en el .env', contexto);
      ponerOSM(mapa, { humanitario });
      return 'osm';
    }

    try {
      await cargarGoogle(clave);
      await ponerGoogle(mapa, { maxZoom });
      console.log(
        '%c[mapa] ' + contexto + ': teselas de Google Maps, en español.',
        'color:#1B7FA6;font-weight:bold'
      );
      return 'google';
    } catch (err) {
      avisarDelRespaldo(err.message || String(err), contexto);
      ponerOSM(mapa, { humanitario });
      return 'osm';
    }
  }

  window.Teselas = { poner, ESTILO_LIMPIO };
})();
