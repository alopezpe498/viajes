/**
 * public/js/ayuda.js
 * -----------------------------------------------------------------------------
 * El asistente de ayuda: la burbuja de la esquina y su panel de chat.
 *
 * SE MONTA SOLO. El marcado lo crea este fichero, no las plantillas, y es a
 * propósito: esto sale en todas las pantallas, y pegar el mismo bloque de HTML
 * en veinticinco vistas es garantizar que dentro de dos meses haya veinticinco
 * versiones distintas. Aquí hay una.
 *
 * EL HISTORIAL ES DE LA SESIÓN, y de la pestaña. No se guarda en ningún sitio:
 * una duda sobre dónde se pulsa algo no es algo que uno quiera encontrarse
 * mañana, y guardarlo obligaría a decidir dónde y por cuánto tiempo.
 */
(() => {
  if (document.querySelector('.ay-burbuja')) return;   // por si acaso, una sola

  const IDEAS = [
    '¿Cómo cambio una noche de ciudad?',
    '¿Qué significa el rojo en una tarjeta?',
    '¿Cómo mido la distancia entre dos puntos?',
    '¿Dónde subo el billete de avión?',
  ];

  /** Lo dicho en esta sesión. Va al servidor para que se entienda un "¿y eso?". */
  const hilo = [];
  let esperando = false;
  let comprobado = false;

  // ===========================================================================
  // EL MARCADO
  // ===========================================================================
  const burbuja = document.createElement('button');
  burbuja.className = 'ay-burbuja';
  burbuja.type = 'button';
  burbuja.title = 'Ayuda sobre cómo se usa la web';
  burbuja.setAttribute('aria-label', 'Abrir la ayuda');
  burbuja.setAttribute('aria-expanded', 'false');
  burbuja.innerHTML = '<i class="ti ti-help" aria-hidden="true"></i>';

  const panel = document.createElement('section');
  panel.className = 'ay-panel';
  panel.hidden = true;
  panel.setAttribute('role', 'dialog');
  panel.setAttribute('aria-label', 'Ayuda de la aplicación');
  panel.innerHTML = `
    <header class="ay-cab">
      <i class="ti ti-help ay-cab__icono" aria-hidden="true"></i>
      <h2 class="ay-cab__titulo">
        Ayuda
        <span class="ay-cab__pie">Dudas sobre cómo se usa la web</span>
      </h2>
      <button class="ay-cerrar" type="button" aria-label="Cerrar la ayuda">
        <i class="ti ti-x" aria-hidden="true"></i>
      </button>
    </header>

    <div class="ay-hilo" id="ay-hilo" aria-live="polite"></div>

    <form class="ay-pie">
      <textarea class="ay-campo" rows="1" maxlength="500"
                placeholder="Pregunta lo que quieras de la web…"
                aria-label="Tu pregunta"></textarea>
      <button class="ay-enviar" type="submit" aria-label="Enviar">
        <i class="ti ti-send" aria-hidden="true"></i>
      </button>
    </form>`;

  document.body.append(burbuja, panel);

  const zona = panel.querySelector('#ay-hilo');
  const campo = panel.querySelector('.ay-campo');
  const enviar = panel.querySelector('.ay-enviar');
  const formulario = panel.querySelector('.ay-pie');

  // ===========================================================================
  // PINTAR
  // ===========================================================================
  function esc(t) {
    const d = document.createElement('div');
    d.textContent = t ?? '';
    return d.innerHTML;
  }

  /** Añade un mensaje al hilo y baja hasta él. `clase` es el matiz: nosabe, fallo. */
  function decir(texto, quien, clase = '') {
    const m = document.createElement('div');
    m.className = `ay-msg ay-msg--${quien === 'yo' ? 'yo' : 'el'} ${clase}`;
    m.textContent = texto;
    zona.appendChild(m);
    abajo();
    return m;
  }

  function abajo() {
    zona.scrollTop = zona.scrollHeight;
  }

  /** La bienvenida, solo la primera vez que se abre. */
  function bienvenida() {
    if (zona.children.length) return;

    const hola = document.createElement('p');
    hola.className = 'ay-hola';
    hola.textContent =
      'Pregúntame cómo se hace cualquier cosa en esta web. Solo sé lo que ' +
      'cuenta el manual de la aplicación: si algo no está ahí, te lo diré en ' +
      'vez de inventármelo.';

    const ideas = document.createElement('div');
    ideas.className = 'ay-ideas';
    for (const t of IDEAS) {
      const b = document.createElement('button');
      b.className = 'ay-idea';
      b.type = 'button';
      b.textContent = t;
      b.addEventListener('click', () => mandar(t));
      ideas.appendChild(b);
    }

    zona.append(hola, ideas);
  }

  // ===========================================================================
  // ABRIR Y CERRAR
  // ===========================================================================
  function abrir() {
    panel.hidden = false;
    burbuja.classList.add('ay-burbuja--oculta');
    burbuja.setAttribute('aria-expanded', 'true');
    bienvenida();
    avisarSiNoHayClave();
    campo.focus();
    abajo();
  }

  function cerrar() {
    panel.hidden = true;
    burbuja.classList.remove('ay-burbuja--oculta');
    burbuja.setAttribute('aria-expanded', 'false');
    burbuja.focus();
  }

  /**
   * SIN CLAVE DE IA NO HAY RESPUESTAS, y se dice al abrir.
   *
   * Dejar escribir la pregunta entera para contestar con un error es tirar un
   * trabajo que ya estaba hecho. Se pregunta una vez por sesión.
   */
  async function avisarSiNoHayClave() {
    if (comprobado) return;
    comprobado = true;
    try {
      const r = await fetch('/api/ayuda');
      const d = await r.json();
      if (!d.disponible) {
        decir(
          'Ahora mismo no puedo contestar: falta la clave de la IA. Se pone en ' +
            'los ajustes de instalación.',
          'el',
          'ay-msg--fallo'
        );
      }
    } catch {
      /* Si esto falla, se verá al preguntar. No hace falta insistir dos veces. */
    }
  }

  // ===========================================================================
  // PREGUNTAR
  // ===========================================================================
  async function mandar(texto) {
    const pregunta = String(texto ?? '').trim();
    if (!pregunta || esperando) return;

    // Las sugerencias se van en cuanto se usa una: ya han hecho su trabajo.
    panel.querySelector('.ay-ideas')?.remove();
    panel.querySelector('.ay-hola')?.remove();

    decir(pregunta, 'yo');
    hilo.push({ de: 'usuario', texto: pregunta });
    campo.value = '';
    talla();

    esperando = true;
    enviar.disabled = true;

    const puntos = document.createElement('div');
    puntos.className = 'ay-pensando';
    puntos.innerHTML = '<span></span><span></span><span></span>';
    zona.appendChild(puntos);
    abajo();

    try {
      const r = await fetch('/api/ayuda', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        // El historial va SIN el turno que se acaba de meter: ese es la pregunta.
        body: JSON.stringify({ pregunta, historial: hilo.slice(0, -1) }),
      });
      const d = await r.json();
      puntos.remove();

      if (!r.ok || d.error) {
        decir(d.error || 'No he podido contestar.', 'el', 'ay-msg--fallo');
        return;
      }

      decir(d.respuesta, 'el', d.loSabe ? '' : 'ay-msg--nosabe');
      hilo.push({ de: 'asistente', texto: d.respuesta });
    } catch (err) {
      puntos.remove();
      decir(`No he podido contestar: ${err.message}`, 'el', 'ay-msg--fallo');
    } finally {
      esperando = false;
      enviar.disabled = false;
      campo.focus();
    }
  }

  /** El campo crece con lo escrito, hasta el tope que pone la hoja de estilos. */
  function talla() {
    campo.style.height = 'auto';
    campo.style.height = `${campo.scrollHeight}px`;
  }

  // ===========================================================================
  // ENGANCHES
  // ===========================================================================
  burbuja.addEventListener('click', abrir);
  panel.querySelector('.ay-cerrar').addEventListener('click', cerrar);

  formulario.addEventListener('submit', (e) => {
    e.preventDefault();
    mandar(campo.value);
  });

  campo.addEventListener('input', talla);

  // Enter manda; Mayúsculas+Enter hace un salto de línea, como en cualquier chat.
  campo.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      mandar(campo.value);
    }
  });

  // Escape cierra, pero solo si no hay otra cosa encima: en esta app hay modales
  // y paneles que también escuchan Escape, y cerrar dos cosas de una tecla es
  // cerrar una que no querías.
  document.addEventListener('keydown', (e) => {
    if (e.key !== 'Escape' || panel.hidden) return;
    if (!panel.contains(document.activeElement)) return;
    cerrar();
  });
})();
