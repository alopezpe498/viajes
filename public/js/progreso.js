/**
 * public/js/progreso.js
 * -----------------------------------------------------------------------------
 * LA TARJETA DE PROGRESO DEL VIAJE AUTOMÁTICO.
 *
 * QUÉ CAMBIA. Al elegir destino, el orquestador arrancaba y te llevaba a
 * `/viajes/:id/orquestador`: seis fases con su log en crudo, que es una pantalla
 * para diagnosticar y no para esperar. Ahora la espera ocurre ENCIMA de donde
 * estabas —el mapa del mundo, o la ventana de países si el viaje es de varios— y
 * al terminar salta sola al registro traducido, que es el que se lee.
 *
 * La pantalla del log en crudo NO se toca y sigue llegándose a ella: desde el
 * enlace de abajo mientras se espera, y desde el viaje después. Lo que cambia es
 * que deja de ser lo primero que ve alguien que acaba de elegir un destino.
 *
 * NO INVENTA NADA: todo sale de `/viajes/:id/orquestador/estado`, que ya existía
 * para la otra pantalla y devuelve las fases con su estado, el porcentaje, si ha
 * terminado y si hay registro. Aquí no se calcula progreso por tiempo ni se
 * anima una barra a ojo mientras se espera, que es la forma habitual de mentir
 * en una pantalla de carga.
 *
 * SI CIERRAS, NO PASA NADA. El trabajo va por la cola, en segundo plano. Al
 * volver al viaje se te enseña por dónde va.
 */

/**
 * Qué está haciendo cada fase, en una línea.
 *
 * Vive aquí y no en el servidor porque es texto de pantalla: el `estado` ya trae
 * la etiqueta de cada fase, y esto es la frase que la acompaña. Si una fase no
 * está en este mapa se enseña su etiqueta sola, que es lo peor que puede pasar.
 */
const QUE_HACE = {
  ciudades_y_noches: 'Eligiendo qué ciudades entran, cuántas noches y por dónde entrar y salir.',
  traslados: 'Midiendo cómo ir de cada ciudad a la siguiente, puerta a puerta.',
  dormir: 'Buscando un alojamiento en cada parada, con los filtros que has puesto.',
  sitios: 'Eligiendo los sitios de cada parada según lo que os interesa.',
  excursiones: 'Mirando qué excursiones merecen la pena, sin amontonarlas.',
  lienzo: 'Colocando todo en sus días y sus horas, respetando cierres y traslados.',
};

const CLASE_DE_ESTADO = {
  hecho: 'prog__punto--hecho',
  con_huecos: 'prog__punto--huecos',
  error: 'prog__punto--error',
  en_curso: 'prog__punto--ahora',
};

const RADIO = 38;
const VUELTA = 2 * Math.PI * RADIO;

/**
 * Abre la tarjeta y se queda sondeando hasta que el viaje esté montado.
 *
 * @param {number|string} viajeId
 * @param {string} destino  Lo que se enseña en el título: «Preparando Túnez».
 */
export function abrirProgreso(viajeId, destino) {
  const dlg = document.createElement('dialog');
  dlg.className = 'prog';
  // EL FOCO SE QUEDA EN LA TARJETA, NO EN EL ENLACE.
  //
  // `<dialog>` enfoca solo el primer elemento enfocable, y aquí el único es el
  // enlace de «ver el detalle»: quedaba con su anillo puesto, como si fuera la
  // acción que se espera de ti. Y no lo es — esta ventana no pide nada, informa.
  // `tabindex="-1"` la hace enfocable, pero NO basta: `showModal()` enfoca igual
  // al primer descendiente enfocable. Hay que llevarle el foco a mano después de
  // abrirla, y eso está unas líneas más abajo.
  dlg.tabIndex = -1;
  dlg.innerHTML = `
    <div class="prog__anillo">
      <svg width="88" height="88" aria-hidden="true">
        <circle cx="44" cy="44" r="${RADIO}" fill="none" stroke="var(--borde)" stroke-width="7"/>
        <circle class="prog__aro" cx="44" cy="44" r="${RADIO}" fill="none" stroke="var(--acento)"
                stroke-width="7" stroke-linecap="round"
                stroke-dasharray="${VUELTA}" stroke-dashoffset="${VUELTA}"/>
      </svg>
      <div class="prog__pct">0%</div>
    </div>
    <h3 class="prog__titulo">Preparando ${destino ? String(destino) : 'el viaje'}</h3>
    <p class="prog__fase"><span class="prog__giro" aria-hidden="true"></span><span data-fase>Empezando…</span></p>
    <p class="prog__desc" data-desc>Esto tarda unos minutos. Puedes cerrar: el viaje se sigue montando.</p>
    <div class="prog__puntos" data-puntos aria-hidden="true"></div>
    <p class="prog__pie" data-pie></p>
    <p class="prog__fallo" data-fallo hidden></p>
    <p class="prog__salida"><a href="/viajes/${viajeId}/orquestador">Ver el detalle de lo que va haciendo</a></p>`;
  document.body.appendChild(dlg);
  dlg.showModal();
  dlg.focus();

  // ESCAPE NO CIERRA. No es una ventana que se descarte: mientras esté abierta
  // hay un viaje montándose detrás, y cerrarla de un toque accidental deja a
  // alguien mirando un mapa sin saber que su viaje sigue en marcha. Para irse
  // está el enlace de abajo, que lleva a un sitio donde se ve lo mismo.
  dlg.addEventListener('cancel', (e) => e.preventDefault());

  const $ = (sel) => dlg.querySelector(sel);
  let ultimaFase = null;

  function pintar(estado) {
    const fases = Array.isArray(estado?.fases) ? estado.fases : [];
    const pct = Math.max(0, Math.min(100, Number(estado?.porcentaje) || 0));

    $('.prog__pct').textContent = `${pct}%`;
    $('.prog__aro').setAttribute('stroke-dashoffset', String(VUELTA * (1 - pct / 100)));

    // LA FASE QUE SE ENSEÑA ES LA QUE ESTÁ EN CURSO. Si no hay ninguna —entre
    // dos fases, o justo al arrancar— se deja la última que se vio en vez de
    // parpadear a «Empezando…»: el trabajo no se ha detenido, solo está entre
    // una cosa y la siguiente.
    const enCurso = fases.find((f) => f.estado === 'en_curso');
    if (enCurso) ultimaFase = enCurso;
    if (ultimaFase) {
      $('[data-fase]').textContent = ultimaFase.etiqueta ?? ultimaFase.clave;
      $('[data-desc]').textContent =
        QUE_HACE[ultimaFase.clave] ?? 'Trabajando en esta parte del viaje.';
    }

    const puntos = $('[data-puntos]');
    if (puntos.children.length !== fases.length) {
      puntos.innerHTML = fases.map(() => '<span class="prog__punto"></span>').join('');
    }
    [...puntos.children].forEach((el, i) => {
      el.className = `prog__punto ${CLASE_DE_ESTADO[fases[i]?.estado] ?? ''}`.trim();
    });

    const hechas = fases.filter((f) => f.estado !== 'pendiente' && f.estado !== 'en_curso').length;
    const faltan = fases.slice(hechas + (enCurso ? 1 : 0)).map((f) => f.etiqueta ?? f.clave);
    $('[data-pie]').innerHTML =
      `Fase <b>${Math.min(hechas + 1, fases.length || 1)}</b> de ${fases.length || 6}` +
      (faltan.length ? ` · faltan ${faltan.join(', ')}` : ' · terminando');

    if (estado?.mensajeError) {
      const fallo = $('[data-fallo]');
      fallo.textContent = estado.mensajeError;
      fallo.hidden = false;
    }
  }

  async function mirar() {
    let estado;
    try {
      const r = await fetch(`/viajes/${viajeId}/orquestador/estado`, {
        headers: { Accept: 'application/json' },
      });
      if (!r.ok) throw new Error(String(r.status));
      estado = await r.json();
    } catch {
      // UN SONDEO QUE FALLA NO ES UN VIAJE QUE FALLA. Puede ser un segundo sin
      // red o un reinicio del servidor; el trabajo sigue en la cola. Se calla y
      // se vuelve a preguntar.
      return setTimeout(mirar, 4000);
    }

    pintar(estado);

    if (estado.terminado) {
      // AL REGISTRO TRADUCIDO, que se genera solo al final del orquestador. Si
      // por lo que sea no llegó a escribirse, se va al log en crudo en vez de
      // dejar a alguien en una pantalla vacía.
      window.location.href = estado.hayRegistro
        ? `/viajes/${viajeId}/orquestador/vista`
        : `/viajes/${viajeId}/orquestador`;
      return;
    }

    setTimeout(mirar, 2500);
  }

  mirar();
}
