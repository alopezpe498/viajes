/**
 * public/js/tour.js
 * -----------------------------------------------------------------------------
 * EL TOUR DE BIENVENIDA.
 *
 * Burbujas que señalan un elemento real de la pantalla, una a una, con el resto
 * atenuado. Nueve paradas repartidas en siete pantallas, y CADA PANTALLA SUELTA
 * LA SUYA la primera vez que se pisa: soltar las nueve seguidas el primer día no
 * es enseñar la aplicación, es un examen.
 *
 * EL GUIÓN ESTÁ AQUÍ Y NO EN EL SERVIDOR, a propósito: cambiar un texto o mover
 * un ancla no debería obligar a tocar una ruta ni a reiniciar nada.
 *
 * LAS ANCLAS SON ELEMENTOS QUE YA EXISTEN. Ninguna pantalla se ha tocado para
 * añadir un `id` de adorno: `#meses`, `#chips-tipo`, `#campo-busqueda`,
 * `#sitio-tipo`, `#carrusel`, `#zona-ruta`, `#pestanas`, `#mochila` y
 * `#mm-vistas` estaban todos ahí antes de esto.
 *
 * DOS DE ELLAS NO ESTÁN AL CARGAR LA PÁGINA. El chip de tipo aparece cuando se
 * toca algo en el mapamundi, y el carrusel de candidatas cuando termina de
 * investigarse el país. Por eso cada parada ESPERA a su ancla en vez de darla
 * por perdida, con un tope; y si aun así no aparece, el tramo NO se marca como
 * visto y se reserva para la próxima vez que se pise esa pantalla. Un tour que
 * se cuelga esperando es peor que uno corto, pero perder la parada que explica
 * los niveles porque alguien tardó en tocar el mapa es peor que las dos cosas.
 */
(() => {
  'use strict';

  // ===========================================================================
  // EL GUIÓN
  // ===========================================================================
  //
  // `tramo` es la pantalla: es lo que se marca como visto, de modo que las dos
  // paradas de configuración van juntas y no se pueden ver a medias.
  //
  // `en` decide en qué URL sale. Se compara contra `location.pathname`.
  const GUION = [
    {
      tramo: 'configuracion',
      en: /^\/viajes\/\d+\/paso\/1\/?$/,
      ancla: '#meses',
      texto:
        'Marca ida y vuelta. De aquí sale el número de noches, y con él cuántas ' +
        'ciudades caben: no es solo una fecha, es el tamaño del viaje.',
    },
    {
      tramo: 'configuracion',
      en: /^\/viajes\/\d+\/paso\/1\/?$/,
      ancla: '#chips-tipo',
      texto:
        'Lo que marques aquí cambia qué ciudades se proponen y qué se coloca en ' +
        'cada día. Si no marcas nada, se reparte a partes iguales.',
    },
    {
      tramo: 'destino',
      en: /^\/elegir-destino\//,
      ancla: '#campo-busqueda',
      texto: 'Escribe un país o una ciudad, o toca el mapa directamente. Sirven las dos cosas.',
    },
    {
      tramo: 'destino',
      en: /^\/elegir-destino\//,
      ancla: '#sitio-tipo',
      // La parada más importante del tour: es la que explica por qué la
      // aplicación se comporta distinto con «Roma» que con «Grecia».
      texto:
        'Fíjate en esta etiqueta. Con un PAÍS te llevo a explorar sus ciudades y ' +
        'eliges cuáles entran. Con una CIUDAD no hay nada que explorar: vamos ' +
        'directos a montarla. Y si nombras varios países, te pregunto antes cuáles quieres.',
    },
    {
      tramo: 'descubrir',
      en: /^\/descubrir\//,
      ancla: '#carrusel',
      texto:
        'Cada tarjeta es una ciudad candidata. Añade a la ruta las que quieras; ' +
        'el contador de arriba lleva la cuenta.',
    },
    {
      tramo: 'ruta',
      en: /^\/viaje\/\d+\/ruta\/?$/,
      ancla: '#zona-ruta',
      texto:
        'Este es el esqueleto del viaje. Arrastra para reordenar, ajusta las noches ' +
        'de cada parada, y toca una para abrirla y trabajarla por dentro.',
    },
    {
      tramo: 'etapa',
      en: /^\/etapa\/\d+\/?$/,
      ancla: '#pestanas',
      texto:
        'Cada parada se resuelve en tres: Qué ver, Dónde dormir y Cómo llegar. ' +
        'Lo que apuntes en «Qué ver» es lo que después se reparte por días.',
    },
    {
      tramo: 'lienzo',
      en: /^\/viaje\/\d+\/lienzo\/?$/,
      ancla: '#mochila',
      texto:
        'Todo lo que apuntaste cae aquí, en la mochila. Arrástralo a un día o deja ' +
        'que se reparta solo; lo que no entre se queda aquí esperando, no se pierde.',
    },
    {
      tramo: 'mapa',
      en: /^\/viaje\/\d+\/mapa\/?$/,
      ancla: '#mm-vistas',
      texto:
        'Aquí se ve si el plan se sostiene: cambia entre la ruta completa y cada ' +
        'día, y mide distancias reales entre dos puntos. Fin del tour.',
    },
  ];

  const TODOS_LOS_TRAMOS = [...new Set(GUION.map((p) => p.tramo))];

  /**
   * LO QUE SE ESPERA A UN ANCLA QUE TODAVÍA NO ESTÁ.
   *
   * Generoso a propósito: dos de las anclas dependen de que el usuario haga algo
   * —tocar el mapamundi, esperar a que se investigue el país— y meterle prisa a
   * eso es meterle prisa a él.
   */
  const ESPERA_MAX_MS = 45000;

  // ===========================================================================
  // ESTADO
  // ===========================================================================
  const fuente = document.getElementById('datos-tour');
  if (!fuente) return;

  let estado;
  try {
    estado = JSON.parse(fuente.textContent || '{}');
  } catch {
    return;
  }

  // `?tour=1` relanza desde cero: es lo que abre la fila de Ajustes.
  const forzado = new URLSearchParams(location.search).get('tour') === '1';

  const mios = GUION.filter((p) => p.en.test(location.pathname));
  if (!mios.length) return;

  const tramo = mios[0].tramo;
  if (!forzado && (estado.visto || (estado.tramos || []).includes(tramo))) return;

  // ===========================================================================
  // AVISAR AL SERVIDOR
  // ===========================================================================
  const avisar = (url, cuerpo) =>
    fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(cuerpo || {}),
    }).catch(() => {});

  // ===========================================================================
  // ESPERAR UN ANCLA QUE AÚN NO ESTÁ
  // ===========================================================================
  function visible(el) {
    if (!el) return false;
    const r = el.getBoundingClientRect();
    return r.width > 0 && r.height > 0;
  }

  function esperarAncla(selector) {
    const ya = document.querySelector(selector);
    if (visible(ya)) return Promise.resolve(ya);

    return new Promise((listo) => {
      let acabado = false;
      const terminar = (el) => {
        if (acabado) return;
        acabado = true;
        obs.disconnect();
        clearTimeout(reloj);
        listo(el);
      };
      const mirar = () => {
        const el = document.querySelector(selector);
        if (visible(el)) terminar(el);
      };
      const obs = new MutationObserver(mirar);
      obs.observe(document.body, { childList: true, subtree: true, attributes: true });
      const reloj = setTimeout(() => terminar(null), ESPERA_MAX_MS);
      mirar();
    });
  }

  // ===========================================================================
  // LA BURBUJA
  // ===========================================================================
  const velo = document.createElement('div');
  velo.className = 'tour-velo';
  velo.setAttribute('aria-hidden', 'true');

  const halo = document.createElement('div');
  halo.className = 'tour-halo';
  halo.setAttribute('aria-hidden', 'true');

  const burbuja = document.createElement('div');
  burbuja.className = 'tour-burbuja';
  burbuja.setAttribute('role', 'dialog');
  burbuja.setAttribute('aria-modal', 'true');
  burbuja.setAttribute('aria-labelledby', 'tour-texto');
  burbuja.innerHTML = `
    <p class="tour-burbuja__texto" id="tour-texto"></p>
    <div class="tour-burbuja__pie">
      <span class="tour-burbuja__progreso" id="tour-progreso"></span>
      <div class="tour-burbuja__botones">
        <button type="button" class="tour-boton tour-boton--saltar" id="tour-saltar">Saltar</button>
        <button type="button" class="tour-boton tour-boton--seguir" id="tour-seguir">Siguiente</button>
      </div>
    </div>`;

  const elTexto = burbuja.querySelector('#tour-texto');
  const elProgreso = burbuja.querySelector('#tour-progreso');
  const botonSaltar = burbuja.querySelector('#tour-saltar');
  const botonSeguir = burbuja.querySelector('#tour-seguir');

  let anclaActual = null;
  let devolverElFoco = null;

  /**
   * DÓNDE SE PONE LA BURBUJA.
   *
   * Debajo del elemento si cabe, encima si no, y centrada en su eje. En móvil no
   * se calcula nada: se ancla abajo a ancho completo, como ya hace `.barra-final`
   * en el resto de la aplicación.
   */
  function colocar(el) {
    const r = el.getBoundingClientRect();
    const margen = 12;

    halo.style.top = `${r.top - 6}px`;
    halo.style.left = `${r.left - 6}px`;
    halo.style.width = `${r.width + 12}px`;
    halo.style.height = `${r.height + 12}px`;

    if (window.innerWidth <= 600) {
      burbuja.classList.add('tour-burbuja--abajo');
      burbuja.style.top = '';
      burbuja.style.left = '';
      return;
    }
    burbuja.classList.remove('tour-burbuja--abajo');

    const alto = burbuja.offsetHeight || 150;
    const ancho = burbuja.offsetWidth || 320;
    const cabeDebajo = r.bottom + margen + alto < window.innerHeight;

    const arriba = cabeDebajo ? r.bottom + margen : Math.max(margen, r.top - margen - alto);
    let izq = r.left + r.width / 2 - ancho / 2;
    izq = Math.max(margen, Math.min(izq, window.innerWidth - ancho - margen));

    burbuja.style.top = `${arriba}px`;
    burbuja.style.left = `${izq}px`;
  }

  function quitar() {
    velo.remove();
    halo.remove();
    burbuja.remove();
    document.removeEventListener('keydown', teclado, true);
    window.removeEventListener('resize', recolocar);
    window.removeEventListener('scroll', recolocar, true);
    if (anclaActual) {
      anclaActual.removeAttribute('aria-describedby');
      anclaActual.classList.remove('tour-senalado');
    }
    if (devolverElFoco && document.contains(devolverElFoco)) devolverElFoco.focus();
  }

  const recolocar = () => { if (anclaActual) colocar(anclaActual); };

  /** Esc sale, y el tabulador no se escapa de la burbuja. */
  function teclado(e) {
    if (e.key === 'Escape') {
      e.preventDefault();
      saltar();
      return;
    }
    if (e.key !== 'Tab') return;
    const focoables = [botonSaltar, botonSeguir];
    const primero = focoables[0];
    const ultimo = focoables[focoables.length - 1];
    if (e.shiftKey && document.activeElement === primero) {
      e.preventDefault();
      ultimo.focus();
    } else if (!e.shiftKey && document.activeElement === ultimo) {
      e.preventDefault();
      primero.focus();
    }
  }

  function saltar() {
    quitar();
    avisar('/api/tour/visto', { tramos: TODOS_LOS_TRAMOS });
  }

  // ===========================================================================
  // EL RECORRIDO DE ESTA PANTALLA
  // ===========================================================================
  let i = 0;
  // Cuántas paradas de este tramo se han tenido que saltar porque su ancla no
  // llegó a aparecer. Decide si el tramo se da por visto o se reserva para otra
  // vez — ver `cerrarTramo`.
  let saltadas = 0;

  async function siguiente() {
    if (anclaActual) {
      anclaActual.removeAttribute('aria-describedby');
      anclaActual.classList.remove('tour-senalado');
      anclaActual = null;
    }

    if (i >= mios.length) return cerrarTramo();

    const parada = mios[i];
    const el = await esperarAncla(parada.ancla);
    i += 1;

    // El ancla no llegó a aparecer. Puede ser que no aplique en este viaje o que
    // el usuario todavía no haya hecho lo que la saca; aquí no se distingue, y
    // por eso se cuenta.
    if (!el) {
      saltadas += 1;
      return siguiente();
    }

    if (!document.body.contains(velo)) {
      document.body.append(velo, halo, burbuja);
      document.addEventListener('keydown', teclado, true);
      window.addEventListener('resize', recolocar);
      window.addEventListener('scroll', recolocar, true);
      devolverElFoco = document.activeElement;
    }

    anclaActual = el;
    el.classList.add('tour-senalado');
    el.setAttribute('aria-describedby', 'tour-texto');
    el.scrollIntoView({ block: 'center', behavior: 'smooth' });

    elTexto.textContent = parada.texto;

    // El número es el de la parada dentro del GUIÓN ENTERO, no dentro de esta
    // pantalla: el tour son nueve paradas aunque hoy solo salgan dos.
    const nGlobal = GUION.indexOf(parada) + 1;
    elProgreso.textContent = `Paso ${nGlobal} de ${GUION.length}`;
    botonSeguir.textContent =
      i >= mios.length && nGlobal === GUION.length ? 'Terminar' : 'Siguiente';

    colocar(el);
    botonSeguir.focus();
  }

  /**
   * SE DA POR VISTO SOLO LO QUE SE HA VISTO.
   *
   * Si alguna parada se quedó sin ancla, el tramo NO se marca: se reserva para
   * la próxima vez que se pise esta pantalla.
   *
   * EL CASO QUE OBLIGA A ESTO es la parada del chip de tipo —país o ciudad—, que
   * es la más importante del tour y cuya ancla solo existe cuando el usuario ha
   * tocado algo en el mapamundi. Con la regla simple («se enseñó el tramo, luego
   * visto»), a quien se quedara mirando el mapa un minuto se le perdía esa
   * parada para siempre, que es justo la que no se puede perder.
   *
   * No hay riesgo de que insista eternamente: en cuanto el ancla aparece una vez,
   * el tramo se cierra. Y si de verdad no aplica —el carrusel en un viaje de
   * ciudad—, esa pantalla no se vuelve a pisar.
   */
  function cerrarTramo() {
    quitar();
    if (saltadas === 0) avisar('/api/tour/tramo', { tramo });

    // El último tramo del guión cierra el tour entero.
    if (saltadas === 0 && tramo === GUION[GUION.length - 1].tramo) {
      avisar('/api/tour/visto', { tramos: TODOS_LOS_TRAMOS });
    }
  }

  botonSeguir.addEventListener('click', siguiente);
  botonSaltar.addEventListener('click', saltar);

  // Al relanzar desde Ajustes se llega con `?tour=1`: se limpia de la barra de
  // direcciones para que recargar no vuelva a forzarlo.
  if (forzado && window.history?.replaceState) {
    const u = new URL(location.href);
    u.searchParams.delete('tour');
    window.history.replaceState({}, '', u);
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', siguiente, { once: true });
  } else {
    siguiente();
  }
})();
