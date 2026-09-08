/**
 * public/js/etapa.js
 * -----------------------------------------------------------------------------
 * La pantalla de una parada: pestañas, "me lo apunto", notas con autoguardado y
 * los tramos de transporte.
 *
 * El círculo de elegir hotel NO se toca aquí: esa tarjeta es la misma del paso
 * 6 y la maneja el código genérico de app.js. Lo único que cambia es la URL de
 * su `data-marcar`, y eso lo pone la plantilla.
 */
(() => {
  const raiz = document.querySelector('.contenido--etapa');
  if (!raiz) return;

  const etapaId = raiz.dataset.etapa;

  /** Aviso corto abajo que se va solo. Nada de alert(), que bloquea. */
  function avisar(texto) {
    const nota = document.createElement('div');
    nota.className = 'nota-flotante';
    nota.textContent = texto;
    document.body.appendChild(nota);
    setTimeout(() => nota.remove(), 4000);
  }

  // ===========================================================================
  // PESTAÑAS
  // ---------------------------------------------------------------------------
  // DÓNDE ESTABAS SE RECUERDA, y hace falta.
  //
  // Media pantalla trabaja en segundo plano —hoteles, vuelos, cómo llegar,
  // restaurantes— y cuando algo termina la forma más honesta de enseñarlo es
  // recargar: lo que se pinta lo decide el servidor, que sabe cómo está cada
  // cosa. Pero recargar te devolvía a "Qué ver" y perdías de vista justo lo que
  // estabas esperando.
  //
  // El ancla de la URL ya guardaba la pestaña grande. Faltaban dos cosas:
  //
  //   - La SUBPESTAÑA (Sitios / Excursiones / Comer / Moverse) no se guardaba
  //     en ningún sitio, así que siempre volvías a Sitios.
  //   - Y el ancla solo se ponía al pulsar una pestaña. Llegando por un
  //     redirect sin ancla, no había nada que reponer.
  //
  // Se guardan las dos en `sessionStorage`, por etapa. Es de la pestaña del
  // navegador y se va al cerrarla, que es exactamente lo que se quiere: no es
  // un dato del viaje, es dónde estaba mirando ahora mismo.
  // ===========================================================================
  const barra = document.getElementById('pestanas');
  const botones = barra ? [...barra.querySelectorAll('.pestana')] : [];
  const paneles = botones.map((b) => document.getElementById(b.dataset.panel));

  const LLAVE = `etapa:${etapaId}:vista`;

  function recordar(cambios) {
    try {
      const guardado = { ...leerRecuerdo(), ...cambios };
      sessionStorage.setItem(LLAVE, JSON.stringify(guardado));
    } catch { /* sin sessionStorage (modo privado antiguo): se sigue igual */ }
  }

  function leerRecuerdo() {
    try {
      return JSON.parse(sessionStorage.getItem(LLAVE) ?? '{}') ?? {};
    } catch {
      return {};
    }
  }

  /**
   * LA PESTAÑA VIVE EN LA URL, Y EN LA QUERY.
   *
   * Antes vivía en el ancla (`#dormir`). El ancla vale para navegar dentro de
   * la página, pero NO llega al servidor: el navegador se la queda. Y como
   * esta pantalla se recarga entera cada dos por tres —cuando acaba una
   * búsqueda, al apuntar algo, al elegir un hotel—, el servidor pintaba
   * siempre "Qué ver" y la tuya solo volvía cuando el JS terminaba de
   * cargar. Eso era el salto.
   *
   * En la query (`?p=dormir`) sí llega, así que la página nace ya con la
   * pestaña buena y no hay nada que reponer ni nada que parpadee.
   */
  function ponerEnLaUrl(cambios) {
    const url = new URL(location.href);
    for (const [clave, valor] of Object.entries(cambios)) {
      if (valor) url.searchParams.set(clave, valor);
      else url.searchParams.delete(clave);
    }
    // El ancla se va: ya no manda ella, y dejarla puesta la haría pelear con
    // la query en la siguiente recarga.
    url.hash = '';
    history.replaceState(null, '', url);
  }

  function mostrar(indice, { enLaUrl = true } = {}) {
    botones.forEach((b, i) => {
      b.classList.toggle('pestana--activa', i === indice);
      b.setAttribute('aria-selected', String(i === indice));
    });
    paneles.forEach((p, i) => {
      if (p) p.hidden = i !== indice;
    });
    if (!botones[indice]) return;
    if (enLaUrl) ponerEnLaUrl({ p: botones[indice].dataset.ancla });
    // Y guardada también, que es de lo que tira si se llega sin nada en la URL.
    recordar({ pestana: botones[indice].dataset.ancla });
  }

  botones.forEach((b, i) => b.addEventListener('click', () => mostrar(i)));

  barra?.addEventListener('keydown', (ev) => {
    if (ev.key !== 'ArrowRight' && ev.key !== 'ArrowLeft') return;
    const actual = botones.findIndex((b) => b.classList.contains('pestana--activa'));
    const siguiente = (actual + (ev.key === 'ArrowRight' ? 1 : -1) + botones.length) % botones.length;
    mostrar(siguiente);
    botones[siguiente].focus();
    ev.preventDefault();
  });

  /**
   * Abre la pestaña que diga la URL, sea por query o por ancla.
   *
   * El ancla se sigue atendiendo porque los enlaces de la pantalla de ruta
   * llegan así (`/etapa/15#llegar`) y porque están en marcadores de la gente.
   * Al atenderlo se pasa a la query, y a partir de ahí ya sobrevive solo.
   */
  function pestanaDeLaUrl() {
    const query = new URLSearchParams(location.search).get('p');
    const ancla = location.hash.slice(1);

    let i = botones.findIndex((b) => b.dataset.ancla === query);
    if (i >= 0) {
      // El servidor ya la ha pintado; aquí solo se sincroniza el estado y se
      // guarda. Sin tocar la URL, que ya está como toca.
      mostrar(i, { enLaUrl: false });
      return true;
    }

    i = botones.findIndex((b) => b.dataset.ancla === ancla);
    if (i >= 0) {
      mostrar(i);   // y de paso el ancla se convierte en query
      return true;
    }
    return false;
  }

  /**
   * Al cargar: manda la URL y, si no dice nada, lo último que se estaba mirando.
   *
   * En ese orden porque la URL es una intención explícita —venir de la ruta
   * pulsando "cómo llegar"— y lo recordado es solo dónde te quedaste.
   */
  (() => {
    if (pestanaDeLaUrl()) return;

    const { pestana } = leerRecuerdo();
    const i = botones.findIndex((b) => b.dataset.ancla === pestana);
    if (i > 0) mostrar(i);   // 0 es la de por defecto: ya está puesta
  })();

  // Y también cuando el ancla cambia sin recargar. Pasa más de lo que parece:
  // ir de /etapa/15 a /etapa/15#dormir es navegación DENTRO del mismo
  // documento, el navegador no vuelve a pedir la página y sin esto la pestaña
  // se quedaba donde estaba. Los chips de la pantalla de ruta llegan así.
  window.addEventListener('hashchange', pestanaDeLaUrl);


  // ===========================================================================
  // SUBPESTAÑAS DE "QUÉ VER"
  // ---------------------------------------------------------------------------
  // Sitios y Excursiones. No sabe cuántas hay ni cómo se llaman: lee lo que
  // haya en el HTML, así que para añadir "Comer" o "Bares" basta con meterlas
  // en la plantilla y aquí no se toca nada.
  // ===========================================================================
  const barraSub = raiz.querySelector('.subpestanas');
  if (barraSub) {
    const subBotones = [...barraSub.querySelectorAll('.subpestana')];
    const subPaneles = subBotones.map((b) => document.getElementById(b.dataset.subpanel));

    const mostrarSub = (indice, { guardar = true } = {}) => {
      subBotones.forEach((b, i) => {
        b.classList.toggle('subpestana--activa', i === indice);
        b.setAttribute('aria-selected', String(i === indice));
      });
      subPaneles.forEach((p, i) => {
        if (p) p.hidden = i !== indice;
      });
      if (guardar && subBotones[indice]) {
        const clave = subBotones[indice].dataset.subpanel;
        ponerEnLaUrl({ sp: clave });
        recordar({ subpestana: clave });
      }
    };

    subBotones.forEach((b, i) => b.addEventListener('click', () => mostrarSub(i)));

    // Y se repone al cargar. Esta es la que más se notaba: "Comer" y "Moverse"
    // son subpestañas, así que buscar un restaurante y esperar el resultado
    // acababa devolviéndote a "Sitios" en cada recarga.
    //
    // Manda la URL —que es lo que el servidor ya ha pintado— y el recuerdo
    // solo cubre el caso de llegar sin nada puesto.
    const enLaUrl = new URLSearchParams(location.search).get('sp');
    const { subpestana } = leerRecuerdo();
    const iSub = subBotones.findIndex(
      (b) => b.dataset.subpanel === (enLaUrl || subpestana)
    );
    if (iSub > 0) mostrarSub(iSub, { guardar: !enLaUrl });

    barraSub.addEventListener('keydown', (ev) => {
      if (ev.key !== 'ArrowRight' && ev.key !== 'ArrowLeft') return;
      const actual = subBotones.findIndex((b) => b.classList.contains('subpestana--activa'));
      const siguiente = (actual + (ev.key === 'ArrowRight' ? 1 : -1) + subBotones.length) % subBotones.length;
      mostrarSub(siguiente);
      subBotones[siguiente].focus();
      ev.preventDefault();
    });
  }

  // ===========================================================================
  // PLEGAR Y DESPLEGAR (los "Cambiar filtros")
  // ---------------------------------------------------------------------------
  // El panel de filtros ya sabe abrirse solo con su .plegable__disparador. Esto
  // es para los enlaces que lo abren desde OTRO sitio de la pantalla: el
  // "Cambiar filtros" que va junto al resumen. Antes ese enlace te sacaba a la
  // pantalla del wizard; ahora despliega el formulario que tiene al lado.
  // ===========================================================================
  raiz.addEventListener('click', (ev) => {
    const boton = ev.target.closest('[data-plegar]');
    if (!boton) return;

    const panel = document.getElementById(boton.dataset.plegar);
    if (!panel) return;

    const cerrado = panel.classList.contains('oculto');
    panel.classList.toggle('oculto', !cerrado);

    // El disparador propio del plegable tiene que enterarse, o la próxima vez
    // que lo pulsen hará lo contrario de lo que se ve.
    const disparador = raiz.querySelector(`[aria-controls="${boton.dataset.plegar}"]`);
    disparador?.setAttribute('aria-expanded', String(cerrado));

    if (cerrado) panel.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
  });


  // ===========================================================================
  // EL CLIP DE UNA EXCURSIÓN
  // ---------------------------------------------------------------------------
  // Con la tarjeta cerrada, el clip dice cuántos papeles hay y abre el
  // desplegable directamente por su sección. Es una entrada aparte de "Ver
  // detalles" a propósito: ese botón, cuando la ficha no está descargada, se va
  // a Civitatis a buscarla, y para mirar un bono que ya tienes no hace falta
  // abrir un navegador.
  // ===========================================================================
  raiz.addEventListener('click', (ev) => {
    const clip = ev.target.closest('[data-clip]');
    if (!clip) return;

    const panel = document.getElementById(clip.getAttribute('aria-controls'));
    const seccion = panel?.querySelector('[data-seccion-adjuntos]');
    if (!panel || !seccion) return;

    const boton = raiz.querySelector(`[data-detalles="${clip.dataset.clip}"]`);

    // Si ya estaba abierto por el clip, se cierra: es un interruptor.
    if (!panel.hidden && clip.classList.contains('clip--abierto')) {
      panel.hidden = true;
      clip.classList.remove('clip--abierto');
      boton?.setAttribute('aria-expanded', 'false');
      return;
    }

    panel.hidden = false;
    clip.classList.add('clip--abierto');
    boton?.setAttribute('aria-expanded', 'true');
    seccion.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
  });

  // ===========================================================================
  // VER DETALLES DE UNA EXCURSIÓN
  // ---------------------------------------------------------------------------
  // Tres caminos, y el primero es el que más se usa:
  //
  //  a) La ficha ya está guardada -> se despliega al instante. No se busca
  //     nada, ni la primera vez que la abre ESTE viaje: la ficha es del
  //     catálogo y puede haberla traído otro.
  //  b) No está -> se pide SOLO ESA y se sondea hasta que llegue.
  //  c) Ya se está buscando -> se sondea sin volver a pedirla.
  //
  // Nunca se piden todas de golpe: con veintiocho excursiones por ciudad serían
  // veintiocho visitas de navegador para leer tres.
  // ===========================================================================
  raiz.addEventListener('click', async (ev) => {
    const boton = ev.target.closest('[data-detalles]');
    if (!boton) return;

    const caja = boton.closest('.excursion');
    const ficha = document.getElementById(`ficha-${boton.dataset.detalles}`);
    if (!caja || !ficha) return;

    // --- a) Ya la tenemos: abrir y cerrar, sin más ---------------------------
    if (caja.dataset.tieneFicha) {
      const abierta = !ficha.hidden;
      ficha.hidden = abierta;
      boton.setAttribute('aria-expanded', String(!abierta));
      boton.querySelector('span').textContent = abierta ? 'Abrir ficha' : 'Ocultar ficha';
      // El clip abre el mismo panel: que no se quede diciendo que está abierto
      // cuando lo acaba de cerrar el otro botón.
      caja.querySelector('[data-clip]')?.classList.toggle('clip--abierto', !abierta);
      if (!abierta) ficha.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
      return;
    }

    // --- b) Hay que ir a buscarla -------------------------------------------
    // El panel se abre YA, aunque la ficha tarde: dentro está la sección de
    // bonos y entradas, y si no se abriera no habría forma de subir un papel a
    // una excursión cuya ficha todavía no se ha traído (o cuya búsqueda falla).
    if (ficha.querySelector('[data-seccion-adjuntos]')) {
      ficha.hidden = false;
      boton.setAttribute('aria-expanded', 'true');
    }

    const aviso = caja.querySelector('.excursion__buscando');
    const enMarcha = () => {
      boton.disabled = true;
      boton.querySelector('i').className = 'ti ti-loader-2';
      boton.querySelector('span').textContent = 'Buscando detalles…';
      aviso?.classList.remove('oculto');
    };
    const parado = () => {
      boton.disabled = false;
      boton.querySelector('i').className = 'ti ti-list-details';
      // No se trajo nada: sigue invitando a buscar, no a abrir lo que no hay.
      boton.querySelector('span').textContent = 'Buscar detalles';
      aviso?.classList.add('oculto');
    };

    enMarcha();

    try {
      const r = await fetch(`/etapa/${etapaId}/actividad/${boton.dataset.detalles}/detalles`, {
        method: 'POST',
        headers: { Accept: 'application/json' },
      });
      const datos = await r.json();
      if (!r.ok) throw new Error(datos.error || `Error ${r.status}`);

      // Puede estar ya hecha: entonces solo hay que recargar para pintarla.
      if (datos.estado === 'hecho') return recargarConLaFicha(boton.dataset.detalles);

      sondearFicha(boton.dataset.detalles, parado);
    } catch (err) {
      console.error('[etapa] no se pudo pedir la ficha:', err);
      parado();
      avisar(err.message);
    }
  });

  /**
   * Recarga dejando abierta la excursión que se acaba de traer.
   *
   * Se recarga en vez de montar la ficha aquí a mano para que la pinte SIEMPRE
   * la misma plantilla (parciales/ficha-actividad.ejs). Dos sitios pintando lo
   * mismo acaban divergiendo.
   */
  function recargarConLaFicha(actividadId) {
    const url = new URL(location.href);
    url.searchParams.set('abrir', actividadId);
    // La pestaña y la subpestaña, en la query: son las que el servidor lee para
    // pintar la pantalla ya abierta por donde toca. Con el ancla no llegaban.
    url.searchParams.set('p', 'ver');
    url.searchParams.set('sp', 'sub-excursiones');
    url.hash = '';
    location.replace(url);
  }

  /** Pregunta cada 4 s si la ficha ya está. */
  function sondearFicha(actividadId, alFallar) {
    const reloj = setInterval(async () => {
      try {
        const r = await fetch(`/etapa/${etapaId}/actividad/${actividadId}/detalles`, {
          headers: { Accept: 'application/json' },
        });
        const datos = await r.json();

        if (datos.estado === 'hecho') {
          clearInterval(reloj);
          recargarConLaFicha(actividadId);
        } else if (datos.estado === 'error' || datos.estado === 'sin_datos') {
          clearInterval(reloj);
          alFallar();
          avisar(datos.mensaje_error || 'No se pudo traer la ficha de esa excursión.');
        }
      } catch (err) {
        console.error('[etapa] sondeo de la ficha:', err);
      }
    }, 4000);
  }

  // Al volver de la búsqueda: abrir la excursión que se pidió y quitar el
  // parámetro de la URL, que ya ha hecho su trabajo.
  (() => {
    const pedida = new URLSearchParams(location.search).get('abrir');
    if (!pedida) return;

    // La excursión está en su subpestaña: hay que enseñarla antes.
    raiz.querySelector('[data-subpanel="sub-excursiones"]')?.click();

    const caja = raiz.querySelector(`.excursion[data-actividad="${pedida}"]`);
    const boton = caja?.querySelector('[data-detalles]');
    const ficha = document.getElementById(`ficha-${pedida}`);
    if (ficha && caja?.dataset.tieneFicha) {
      ficha.hidden = false;
      boton?.setAttribute('aria-expanded', 'true');
      if (boton) boton.querySelector('span').textContent = 'Ocultar detalles';
      caja.scrollIntoView({ behavior: 'smooth', block: 'center' });
    }

    const url = new URL(location.href);
    url.searchParams.delete('abrir');
    history.replaceState(null, '', url);
  })();

  // Si la página se abre con una ficha ya en marcha (porque se pidió y se
  // recargó), se sigue sondeando sin tener que pulsar otra vez.
  raiz.querySelectorAll('.excursion[data-buscando-ficha="1"]').forEach((caja) => {
    const boton = caja.querySelector('[data-detalles]');
    sondearFicha(caja.dataset.actividad, () => {
      if (!boton) return;
      boton.disabled = false;
      // Ya está guardada: a partir de aquí el botón abre, no busca.
      boton.querySelector('i').className = 'ti ti-file-text';
      boton.querySelector('span').textContent = 'Abrir ficha';
      caja.querySelector('.excursion__buscando')?.classList.add('oculto');
    });
  });


  // ===========================================================================
  // EL DETALLE DE UNA FICHA DE SITIO
  // ---------------------------------------------------------------------------
  // Abre y cierra lo que ya está pintado: el párrafo del "por qué", los lugares
  // de dentro y el "cómo moverse". Todo eso vive en el CATÁLOGO, así que si se
  // amplió alguna vez —aquí o en el mapa— ya está ahí y no hay nada que buscar.
  // ===========================================================================
  raiz.addEventListener('click', (ev) => {
    const boton = ev.target.closest('[data-detalle-sitio]');
    if (!boton) return;

    const caja = document.getElementById(boton.getAttribute('aria-controls'));
    if (!caja) return;

    const abierto = !caja.hidden;
    caja.hidden = abierto;
    boton.setAttribute('aria-expanded', String(!abierto));
    boton.querySelector('i').className = abierto ? 'ti ti-chevron-down' : 'ti ti-chevron-up';
    boton.querySelector('span').textContent = abierto ? 'Ver detalle' : 'Ocultar detalle';
    if (!abierto) caja.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
  });

  // ===========================================================================
  // AMPLIAR LA FICHA DE UN SITIO
  // ---------------------------------------------------------------------------
  // Es el mismo trabajo que usa la pantalla del mapa, y lo que salga se guarda
  // en el catálogo. Por eso, una vez ampliada, se ve desde las dos pantallas y
  // ya no se vuelve a buscar nunca.
  // ===========================================================================
  raiz.addEventListener('click', async (ev) => {
    const boton = ev.target.closest('[data-ampliar]');
    if (!boton) return;

    const puntoId = boton.dataset.ampliar;
    boton.disabled = true;
    boton.querySelector('i').className = 'ti ti-loader-2';
    boton.childNodes[boton.childNodes.length - 1].textContent = ' Ampliando…';

    const rendirse = (mensaje) => {
      boton.disabled = false;
      boton.querySelector('i').className = 'ti ti-sparkles';
      boton.childNodes[boton.childNodes.length - 1].textContent = ' Ampliar la ficha';
      if (mensaje) avisar(mensaje);
    };

    try {
      const r = await fetch(`/etapa/${etapaId}/sitio/${puntoId}/ampliar`, {
        method: 'POST',
        headers: { Accept: 'application/json' },
      });
      const datos = await r.json();
      if (!r.ok) throw new Error(datos.error || `Error ${r.status}`);

      if (datos.estado === 'hecha') return location.reload();
      sondearAmpliacion(puntoId, rendirse);
    } catch (err) {
      console.error('[etapa] no se pudo ampliar la ficha:', err);
      rendirse(err.message);
    }
  });

  /** Pregunta cada 4 s si la ficha ampliada ya está. */
  function sondearAmpliacion(puntoId, rendirse) {
    const reloj = setInterval(async () => {
      try {
        const r = await fetch(`/etapa/${etapaId}/sitio/${puntoId}/ampliar`, {
          headers: { Accept: 'application/json' },
        });
        const datos = await r.json();

        if (datos.estado === 'hecha') {
          clearInterval(reloj);
          location.reload();
        } else if (datos.estado === 'error' || datos.estado === 'sin_datos') {
          clearInterval(reloj);
          rendirse(datos.mensaje_error || 'No se pudo ampliar esa ficha.');
        }
      } catch (err) {
        console.error('[etapa] sondeo de la ampliación:', err);
      }
    }, 4000);
  }

  // ===========================================================================
  // ME LO APUNTO
  // ===========================================================================
  raiz.addEventListener('click', async (ev) => {
    const boton = ev.target.closest('[data-apuntar]');
    if (!boton) return;

    // Está dentro de un <summary>: sin esto, apuntar abriría la mini-ficha.
    ev.preventDefault();
    ev.stopPropagation();

    // DESAPUNTAR ALGO QUE TIENE PAPELES SE LOS LLEVA POR DELANTE.
    //
    // El servidor borra los adjuntos del candidato al desapuntarlo —si no, se
    // quedarían colgando de algo que ya no está en el viaje—, así que aquí hay
    // que decirlo ANTES y con el número, no después. La cuenta está en el propio
    // cajón, que ya la lleva al día: no hace falta preguntar al servidor para
    // saber si hay que avisar.
    const estaApuntado = boton.classList.contains('apuntar--si');
    if (estaApuntado) {
      const caja = boton.closest('.excursion, .tarjeta-punto, .mini');
      const cuantos = Number(caja?.querySelector('.adjuntos__n')?.textContent) || 0;
      if (cuantos) {
        const nombre =
          caja.querySelector('.tarjeta__titulo, .tarjeta-punto__nombre, .mini__nombre')
            ?.textContent.trim() ?? 'esto';
        const aviso =
          `«${nombre}» tiene ${cuantos} ${cuantos === 1 ? 'adjunto' : 'adjuntos'} que se ` +
          `${cuantos === 1 ? 'borrará' : 'borrarán'} al quitarlo del viaje.

¿Seguir?`;
        if (!confirm(aviso)) return;
      }
    }

    boton.disabled = true;
    try {
      const r = await fetch(`/etapa/${etapaId}/apuntar`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
        body: JSON.stringify({ que: boton.dataset.apuntar, id: Number(boton.dataset.id) }),
      });
      const datos = await r.json();
      if (!r.ok) throw new Error(datos.error || `Error ${r.status}`);

      pintarApuntado(boton, datos.apuntado);
      actualizarCuenta(datos.apuntado ? 1 : -1);
    } catch (err) {
      console.error('[etapa] no se pudo apuntar:', err);
      avisar(err.message);
    } finally {
      boton.disabled = false;
    }
  });

  function pintarApuntado(boton, apuntado) {
    boton.classList.toggle('apuntar--si', apuntado);
    boton.querySelector('i').className = `ti ${apuntado ? 'ti-check' : 'ti-bookmark'}`;
    boton.querySelector('span').textContent = apuntado ? 'Apuntado' : 'Me lo apunto';
    // El tinte de la tarjeta entera, que es lo que se ve de lejos.
    boton.closest('.mini')?.classList.toggle('mini--apuntada', apuntado);
    boton.closest('.excursion')?.classList.toggle('excursion--apuntada', apuntado);
  }

  function actualizarCuenta(delta) {
    const cuenta = document.getElementById('cuenta-apuntados');
    const palabra = document.getElementById('palabra-apuntados');
    const chip = botones[0]?.querySelector('.pestana__n');
    if (!cuenta) return;

    const n = Math.max(0, Number(cuenta.textContent) + delta);
    cuenta.textContent = n;
    if (palabra) palabra.textContent = n === 1 ? 'cosa apuntada' : 'cosas apuntadas';
    if (chip) chip.textContent = n;
  }

  // ===========================================================================
  // PONERLO EN UN DÍA
  // ===========================================================================
  // Un mini-selector inline: día y franja, y a colocar. Es el atajo para no
  // tener que abrir el lienzo, arrastrar y volver por cada cosa.
  let datosColocar = null;
  try {
    datosColocar = JSON.parse(document.getElementById('datos-colocar')?.textContent ?? 'null');
  } catch { /* sin días: la etapa no está confirmada */ }

  raiz.addEventListener('click', (ev) => {
    const boton = ev.target.closest('[data-poner], [data-poner-traslado]');
    if (!boton || !datosColocar?.dias.length) return;

    ev.preventDefault();
    ev.stopPropagation();

    // UN TRASLADO SE COLOCA IGUAL QUE UNA VISITA, pero no es un candidato: no
    // está apuntado en la mochila, es una ficha del catálogo urbano. Va con su
    // nombre y su ficha, y con hora, que en un metro o un taxi es el dato.
    const traslado = boton.dataset.ponerTraslado;
    abrirModal(
      traslado
        ? selectorDeDia({
            movilidadId: Number(traslado),
            textoManual: boton.dataset.nombre,
            conHora: true,
          })
        : selectorDeDia({ candidatoId: Number(boton.dataset.poner) }),
      boton.dataset.nombre ?? boton.closest('[data-comer], .ficha-sitio, .excursion')
        ?.querySelector('h4, h2, .tarjeta__titulo')?.textContent.trim()
    );
  });

  /**
   * El selector de día, EN UN MODAL CENTRADO.
   *
   * Antes se colgaba del propio botón, y en las fichas de "Moverse" el botón
   * está dentro de una tarjeta de una rejilla: el formulario acababa pintado
   * arriba del todo de la página, a pantallas de distancia de lo que se acababa
   * de pulsar. Parecía que no había pasado nada.
   *
   * Centrado sobre el contenido no hay dónde perderlo. Se cierra con Cancelar,
   * con Escape y tocando fuera, que son las tres cosas que uno intenta.
   */
  let modalAbierto = null;

  function abrirModal(contenido, titulo) {
    cerrarModal();

    const fondo = document.createElement('div');
    fondo.className = 'ventana-fondo';
    fondo.innerHTML = `
      <div class="ventana" role="dialog" aria-modal="true" aria-label="Ponerlo en un día">
        <div class="ventana__cabecera">
          <h3 class="ventana__titulo">Ponerlo en un día</h3>
          ${titulo ? `<p class="ventana__sub">${esc(titulo)}</p>` : ''}
        </div>
      </div>`;

    fondo.querySelector('.ventana').appendChild(contenido);
    document.body.appendChild(fondo);
    document.body.classList.add('con-ventana');
    modalAbierto = fondo;

    // Tocar fuera cierra; tocar dentro, no.
    fondo.addEventListener('click', (ev) => {
      if (ev.target === fondo) cerrarModal();
    });

    contenido.querySelector('select, input')?.focus();
    return fondo;
  }

  function cerrarModal() {
    modalAbierto?.remove();
    modalAbierto = null;
    document.body.classList.remove('con-ventana');
  }

  document.addEventListener('keydown', (ev) => {
    if (ev.key === 'Escape' && modalAbierto) {
      ev.preventDefault();
      cerrarModal();
    }
  });

  function selectorDeDia(cuerpo, { medios = [] } = {}) {
    const caja = document.createElement('form');
    caja.className = 'poner-en-dia';
    caja.innerHTML = `
      <select name="dia" aria-label="Día">
        ${datosColocar.dias.map((d) => `<option value="${d.n}">Día ${d.n} · ${d.fecha}</option>`).join('')}
      </select>
      <select name="franja" aria-label="Franja">
        ${datosColocar.franjas.map((f) => `<option value="${f.clave}">${f.etiqueta}</option>`).join('')}
      </select>
      ${medios.length
        ? `<select name="medio" aria-label="Cómo se va">
             ${medios.map((m) => `<option value="${m.valor}">${esc(m.etiqueta)}</option>`).join('')}
           </select>`
        : ''}
      ${cuerpo.conHora
        ? `<input type="time" name="hora" aria-label="Hora" title="Hora (opcional)">
           <input type="number" name="duracionMin" min="1" max="1440" step="5"
                  placeholder="min" aria-label="Duración en minutos" title="Duración en minutos">`
        : ''}
      <div class="poner-en-dia__pie">
        <button class="boton boton--primario boton--pequeno" type="submit">Poner</button>
        <button class="boton boton--secundario boton--pequeno" type="button" data-cerrar-modal>
          Cancelar
        </button>
      </div>`;

    caja.addEventListener('click', (ev) => {
      ev.stopPropagation();
      if (ev.target.closest('[data-cerrar-modal]')) cerrarModal();
    });
    caja.addEventListener('submit', async (ev) => {
      ev.preventDefault();
      ev.stopPropagation();
      try {
        // Un traslado consultado tiene su propia puerta: allí los minutos los
        // pone el medio elegido, no se teclean.
        const url = cuerpo.trasladoId
          ? `/api/traslados/${cuerpo.trasladoId}/al-lienzo`
          : '/api/itinerario';

        const r = await fetch(url, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
          body: JSON.stringify({
            viajeId: datosColocar.viajeId,
            ...cuerpo,
            dia: Number(caja.dia.value),
            franja: caja.franja.value,
            medio: caja.medio?.value || null,
            hora: caja.hora?.value || null,
            duracionMin: Number(caja.duracionMin?.value) || null,
          }),
        });
        const datos = await r.json();
        if (!r.ok) throw new Error(datos.error || `Error ${r.status}`);
        // Recargar: la etiqueta "Día N · franja" la pinta el servidor.
        location.reload();
      } catch (err) {
        console.error('[etapa] no se pudo colocar:', err);
        avisar(err.message);
      }
    });

    return caja;
  }

  // ===========================================================================
  // NOTAS CON AUTOGUARDADO
  // ===========================================================================
  const campo = document.getElementById('notas-campo');
  const estado = document.getElementById('notas-estado');
  if (campo) {
    let reloj;
    campo.addEventListener('input', () => {
      if (estado) estado.textContent = '';
      clearTimeout(reloj);
      // Se guarda cuando dejas de escribir, no en cada tecla: son notas, no un
      // chat.
      reloj = setTimeout(guardarNotas, 800);
    });
    campo.addEventListener('blur', () => {
      clearTimeout(reloj);
      guardarNotas();
    });
  }

  async function guardarNotas() {
    try {
      const r = await fetch(campo.dataset.url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
        body: JSON.stringify({ notas: campo.value }),
      });
      if (!r.ok) throw new Error(`Error ${r.status}`);
      if (estado) {
        estado.textContent = 'Guardado';
        setTimeout(() => { if (estado.textContent === 'Guardado') estado.textContent = ''; }, 2000);
      }
    } catch (err) {
      console.error('[etapa] no se pudieron guardar las notas:', err);
      if (estado) estado.textContent = 'No se pudo guardar';
    }
  }

  // ===========================================================================
  // HOTEL: el botón "Cambiar" vuelve a enseñar la lista
  // ===========================================================================
  document.getElementById('cambiar-hotel')?.addEventListener('click', () => {
    const lista = document.getElementById('lista-hoteles');
    if (lista) lista.hidden = false;
  });

  // ===========================================================================
  // TRAMOS
  // ===========================================================================
  raiz.addEventListener('click', (ev) => {
    const manual = ev.target.closest('[data-manual]');
    if (manual) {
      const form = raiz.querySelector(`[data-form-manual="${manual.dataset.manual}"]`);
      if (form) form.hidden = !form.hidden;
      return;
    }

    const cancelar = ev.target.closest('[data-cancelar-manual]');
    if (cancelar) {
      cancelar.closest('.manual').hidden = true;
      return;
    }

    const olvidar = ev.target.closest('[data-olvidar]');
    if (olvidar) {
      quitarManual(olvidar.dataset.olvidar);
      return;
    }

    const vuelos = ev.target.closest('[data-vuelos]');
    if (vuelos) abrirVuelos(vuelos.dataset.vuelos);
  });

  /** Guardar el tramo apuntado a mano. */
  raiz.addEventListener('submit', async (ev) => {
    const form = ev.target.closest('[data-form-manual]');
    if (!form) return;
    ev.preventDefault();

    const tramoId = form.dataset.formManual;
    const datos = Object.fromEntries(new FormData(form));

    try {
      const r = await fetch(`/tramo/${tramoId}/manual`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
        body: JSON.stringify(datos),
      });
      const respuesta = await r.json();
      if (!r.ok) throw new Error(respuesta.error || `Error ${r.status}`);
      // La caja del tramo cambia bastante (estado, resumen, botones): recargar
      // es más honesto que remendar el DOM a mano.
      location.reload();
    } catch (err) {
      console.error('[etapa] no se pudo guardar el tramo:', err);
      avisar(err.message);
    }
  });

  async function quitarManual(tramoId) {
    try {
      const r = await fetch(`/tramo/${tramoId}/olvidar`, {
        method: 'POST',
        headers: { Accept: 'application/json' },
      });
      if (!r.ok) throw new Error(`Error ${r.status}`);
      location.reload();
    } catch (err) {
      console.error('[etapa] no se pudo quitar:', err);
      avisar(err.message);
    }
  }

  /**
   * Enseña u oculta la lista de vuelos de un tramo.
   *
   * La lista YA viene pintada desde el servidor, con la tarjeta rica de
   * siempre: los dos trayectos con sus horarios, aeropuertos y escalas. Antes
   * se montaba aquí a mano y se quedaba en una lista pelada sin horas, que es
   * justo lo que no sirve para elegir un vuelo.
   */
  function abrirVuelos(tramoId) {
    const caja = raiz.querySelector(`[data-vuelos-de="${tramoId}"]`);
    if (!caja) return;
    caja.hidden = !caja.hidden;
    if (!caja.hidden) caja.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
  }

  // ===========================================================================
  // AL ELEGIR HOTEL, LA FICHA VERDE SALE YA
  // ---------------------------------------------------------------------------
  // El círculo lo marca el manejador genérico de app.js, que hace lo suyo bien:
  // pinta el círculo y desmarca los demás. Pero la ficha de arriba —el "Tu
  // alojamiento en Madrid" con el precio— la pinta el SERVIDOR, así que se
  // quedaba con el hotel anterior (o sin nada) hasta que uno cambiaba de
  // pestaña y volvía. Elegir algo y que la pantalla no lo reconozca es de las
  // cosas que más hacen dudar de si se ha guardado.
  //
  // Se pinta aquí con los datos que ya están en la tarjeta elegida: no hace
  // falta preguntarle nada más al servidor.
  // ===========================================================================
  document.addEventListener('click', (ev) => {
    const boton = ev.target.closest('[data-exclusivo="hotel"][data-marcar]');
    if (!boton) return;

    // Después del manejador de app.js, que es quien habla con el servidor.
    setTimeout(() => pintarHotelElegido(boton), 60);
  });

  function pintarHotelElegido(boton) {
    const panel = document.getElementById('panel-dormir');
    if (!panel) return;

    const elegido = boton.getAttribute('aria-pressed') === 'true';
    const tarjeta = boton.closest('.segmento');
    const caja = panel.querySelector('[data-hotel-elegido]');
    if (!caja) return;

    if (!elegido || !tarjeta) {
      // Se ha soltado el hotel: la ficha se va, no se queda con el anterior.
      caja.hidden = true;
      caja.innerHTML = '';
      return;
    }

    const nombre = tarjeta.querySelector('.segmento__nombre')?.textContent.trim() ?? '';
    const precio = tarjeta.querySelector('.segmento__precio, .precio')?.textContent.trim() ?? '';
    const enlace = tarjeta.querySelector('a[href*="booking"]')?.href ?? '';

    caja.innerHTML =
      '<div class="elegido__marca">' +
      `<i class="ti ti-check" aria-hidden="true"></i> Tu alojamiento en ${esc(caja.dataset.ciudad ?? '')}` +
      '</div>' +
      `<div class="elegido__nombre">${esc(nombre)}</div>` +
      '<div class="elegido__pie">' +
      `<span class="elegido__precio">${esc(precio || '—')}</span>` +
      (enlace
        ? `<a class="elegido__enlace" href="${esc(enlace)}" target="_blank" rel="noopener noreferrer">` +
          'Ver en Booking <i class="ti ti-external-link" aria-hidden="true"></i></a>'
        : '') +
      '</div>';
    caja.hidden = false;
  }

  // Elegir un vuelo lo hace el manejador genérico de app.js: la tarjeta es la
  // misma del paso 5 y su círculo ya sabe hablar con `data-marcar`. Después se
  // recarga, porque el tramo pasa de "Pendiente" a "Resuelto" y eso cambia
  // media tarjeta.
  document.addEventListener('click', (ev) => {
    const enVuelos = ev.target.closest('.vuelos-tramo [data-marcar]');
    if (!enVuelos) return;

    // RECARGAR SIN PERDER EL SITIO.
    //
    // Elegir un vuelo cambia media tarjeta —de "Pendiente" a "Resuelto"— y
    // repintarla a mano sería duplicar la plantilla. Pero la recarga te dejaba
    // arriba del todo, y el tramo que acababas de resolver estaba a media
    // pantalla de scroll. Se apunta cuál era y al volver se va a él.
    const caja = enVuelos.closest('[data-vuelos-de]');
    if (caja) {
      try {
        sessionStorage.setItem(`etapa:${etapaId}:volverA`, caja.dataset.vuelosDe);
      } catch { /* sin sessionStorage: se recarga y ya, arriba */ }
    }
    setTimeout(() => location.reload(), 400);
  });

  /** Al cargar: si veníamos de resolver un tramo, se vuelve a él. */
  (() => {
    let tramo = null;
    try {
      tramo = sessionStorage.getItem(`etapa:${etapaId}:volverA`);
      sessionStorage.removeItem(`etapa:${etapaId}:volverA`);
    } catch { /* nada que reponer */ }
    if (!tramo) return;

    const caja = raiz.querySelector(`[data-vuelos-de="${tramo}"]`)?.closest('.tramo, .bloque')
      ?? raiz.querySelector(`[data-vuelos-de="${tramo}"]`);
    caja?.scrollIntoView({ block: 'center' });
  })();

  function esc(t) {
    const d = document.createElement('div');
    d.textContent = t ?? '';
    return d.innerHTML.replace(/"/g, '&quot;');
  }

  // ===========================================================================
  // MOVILIDAD
  // ---------------------------------------------------------------------------
  // Dos piezas que comparten casi todo: cómo se va de esta ciudad a la
  // siguiente (fichas de medio en el tramo) y cómo se mueve uno por dentro
  // (fichas de metro, bus, taxi... en su subpestaña).
  //
  // Las dos guardan en el CATÁLOGO, no en el viaje: mirar cómo ir de Sarajevo a
  // Mostar se hace UNA vez y el año que viene ya está. Lo del viaje es otra
  // cosa: cuál elegí y lo que tecleé debajo.
  //
  // Y en las dos se puede escribir una ficha a mano, con IA o sin ella. Si la
  // consulta falla —o no hay clave configurada— la pantalla no se queda muerta.
  // ===========================================================================
  const MEDIOS = [
    ['bus', 'Autobús'], ['tren', 'Tren'], ['ferry', 'Ferry'],
    ['coche', 'Coche de alquiler'], ['traslado', 'Traslado privado'],
    ['avion', 'Avión'], ['otro', 'Otro'],
  ];
  const TIPOS_MOVILIDAD = [
    ['metro', 'Metro'], ['bus', 'Bus urbano'], ['taxi', 'Taxi'], ['app', 'App'],
    ['tarjeta', 'Tarjeta turística'], ['especial', 'Especial'], ['otro', 'Otro'],
  ];

  /**
   * Un fetch de JSON que no obliga a repetir el mismo try/catch diez veces.
   *
   * Al fallar, el error se lleva ENTERO lo que contestó el servidor. Hace falta
   * para los traslados: cuando dice "Falta la dirección de X" también manda de
   * qué elemento es, y con eso se puede ofrecer abrir su ficha en vez de dejar
   * a la persona buscándola.
   */
  async function pedir(url, opciones = {}) {
    const r = await fetch(url, {
      headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
      ...opciones,
    });
    const datos = await r.json().catch(() => ({}));
    if (!r.ok) {
      const err = new Error(datos.error || `Error ${r.status}`);
      Object.assign(err, datos);
      throw err;
    }
    return datos;
  }

  // --- Pedirle a la IA cómo se llega ----------------------------------------
  raiz.addEventListener('click', async (ev) => {
    const boton = ev.target.closest('[data-buscar-medios]');
    if (!boton) return;

    boton.disabled = true;
    boton.querySelector('i').className = 'ti ti-loader-2 girando';
    boton.querySelector('span').textContent = 'Buscando…';
    try {
      await pedir(`/api/tramos/${boton.dataset.buscarMedios}/transporte/buscar`, { method: 'POST' });
      location.reload();
    } catch (err) {
      console.error('[etapa] no se pudo buscar el transporte del tramo:', err);
      boton.disabled = false;
      boton.querySelector('i').className = 'ti ti-sparkles';
      boton.querySelector('span').textContent = 'Buscar cómo llegar';
      avisar(err.message);
    }
  });

  // --- Pedirle a la IA cómo se mueve uno por la ciudad ----------------------
  document.getElementById('buscar-movilidad')?.addEventListener('click', async (ev) => {
    const boton = ev.currentTarget;
    boton.disabled = true;
    boton.querySelector('i').className = 'ti ti-loader-2 girando';
    boton.querySelector('span').textContent = 'Buscando…';
    try {
      await pedir(`/api/etapas/${boton.dataset.etapa}/movilidad/buscar`, { method: 'POST' });
      location.reload();
    } catch (err) {
      console.error('[etapa] no se pudo buscar la movilidad:', err);
      boton.disabled = false;
      boton.querySelector('i').className = 'ti ti-sparkles';
      boton.querySelector('span').textContent = 'Buscar cómo moverse';
      avisar(err.message);
    }
  });

  // --- Elegir el medio de un tramo ------------------------------------------
  raiz.addEventListener('click', async (ev) => {
    const boton = ev.target.closest('[data-elegir-medio]');
    if (!boton) return;

    boton.disabled = true;
    try {
      const r = await pedir(
        `/api/tramos/${boton.dataset.tramo}/transporte/${boton.dataset.elegirMedio}/elegir`,
        { method: 'POST' }
      );
      pintarEleccion(boton.dataset.tramo, r.elegidaId);
    } catch (err) {
      console.error('[etapa] no se pudo elegir el medio:', err);
      avisar(err.message);
    } finally {
      boton.disabled = false;
    }
  });

  /**
   * Repinta cuál está elegido SIN recargar.
   *
   * Recargar aquí sería lo de siempre en esta pantalla, pero aquí no vale: si
   * estabas tecleando el horario del tren y pulsas "bus", una recarga se lleva
   * por delante lo que hubiera a medio escribir. Lo tecleado se guarda al salir
   * del campo, y la elección solo cambia clases y una clase `oculto`.
   */
  function pintarEleccion(tramoId, elegidaId) {
    const caja = raiz.querySelector(`[data-medios-de="${tramoId}"]`);
    if (!caja) return;

    caja.querySelectorAll('.ficha-transporte').forEach((ficha) => {
      const esta = Number(ficha.dataset.ficha) === Number(elegidaId);
      ficha.classList.toggle('ficha-transporte--elegida', esta);

      const boton = ficha.querySelector('[data-elegir-medio]');
      if (boton) {
        boton.classList.toggle('apuntar--si', esta);
        boton.querySelector('i').className = esta ? 'ti ti-check' : 'ti ti-circle';
        boton.querySelector('span').textContent = esta ? 'Elegido' : 'Elegir';
      }

      // Los campos de lo concreto solo se ven en el elegido, pero NO SE VACÍAN:
      // siguen ahí, con lo suyo, por si vuelvo a cambiar de idea.
      ficha.querySelector('[data-datos-medio]')?.classList.toggle('oculto', !esta);
    });

    // Y EL TRAMO PASA A "RESUELTO" AQUÍ MISMO.
    //
    // Elegir un medio es decidir el tramo, pero la insignia la pintaba solo el
    // servidor: se quedaba en "Pendiente" hasta que entrabas a editar y
    // guardabas sin tocar nada, que es un rodeo absurdo para algo ya decidido.
    pintarEstadoTramo(tramoId, Boolean(elegidaId));

    // El resumen del tramo cambia con la elección ("Bus · 2 h 30"), y eso lo
    // pinta el servidor. Se refresca sin tocar los campos de aquí.
    refrescarResumenTramo(tramoId);
  }

  /**
   * La insignia del tramo: "Resuelto" con su tic, o "Pendiente" con su aviso.
   *
   * Elegir un medio resuelve; soltarlo vuelve a dejarlo pendiente, salvo que el
   * tramo tenga además un vuelo elegido o una nota a mano. Eso último no se
   * sabe desde aquí, así que al soltar se deja que lo diga el servidor en la
   * siguiente pintada: no se apaga una insignia que quizá deba seguir verde.
   */
  function pintarEstadoTramo(tramoId, resuelto) {
    const insignia = raiz.querySelector(`[data-estado-tramo="${tramoId}"]`);
    if (!insignia || !resuelto) return;

    insignia.classList.add('tramo-caja__estado--ok');
    insignia.innerHTML =
      '<i class="ti ti-check" aria-hidden="true"></i> Resuelto';
  }

  async function refrescarResumenTramo(tramoId) {
    const destino = raiz.querySelector(`[data-resumen-tramo="${tramoId}"]`);
    if (!destino) return;
    try {
      const r = await pedir(`/api/tramos/${tramoId}/transporte`);
      const elegida = (r.fichas ?? []).find((f) => f.elegida);
      if (elegida) {
        // El MISMO orden que arma el servidor en resumenDeTramo(): lo tecleado
        // primero, que es lo concreto. Dos sitios pintando la misma frase de
        // distinta forma acaban divergiendo, y aquí se ven una detrás de otra
        // —esta al pulsar, la del servidor al recargar—.
        destino.textContent = [
          elegida.etiquetaMedio,
          elegida.datos?.horario || elegida.duracion,
          elegida.datos?.precio_real || elegida.precio,
        ]
          .filter(Boolean)
          .join(' · ');
      }
    } catch { /* el resumen es un adorno: si falla, se queda como estaba */ }
  }

  // --- Lo tecleado en el medio elegido --------------------------------------
  // Se guarda al salir de cada campo, no con un botón: son cuatro casillas que
  // uno rellena de una en una, y un "Guardar" más sería una pulsación de más
  // cada vez.
  raiz.addEventListener('change', async (ev) => {
    const form = ev.target.closest('[data-datos-medio]');
    if (!form || !ev.target.matches('input')) return;

    const marca = form.querySelector('[data-guardado]');
    try {
      await pedir(`/api/tramos/${form.dataset.tramo}/transporte/${form.dataset.datosMedio}/datos`, {
        method: 'POST',
        body: JSON.stringify(Object.fromEntries(new FormData(form))),
      });
      if (marca) {
        marca.textContent = 'Guardado';
        setTimeout(() => { if (marca.textContent === 'Guardado') marca.textContent = ''; }, 2000);
      }
      refrescarResumenTramo(form.dataset.tramo);
    } catch (err) {
      console.error('[etapa] no se pudieron guardar los datos del medio:', err);
      if (marca) marca.textContent = 'No se pudo guardar';
    }
  });

  // --- Fichas a mano, y editar las que hay ----------------------------------
  // Mismo formulario para crear y para editar, y para las dos clases de ficha:
  // cambian los campos, no el mecanismo.
  const CAMPOS_MEDIO = (f = {}) => `
    <label><span>Medio</span>
      <select name="medio">
        ${MEDIOS.map(([v, t]) => `<option value="${v}" ${f.medio === v ? 'selected' : ''}>${t}</option>`).join('')}
      </select>
    </label>
    <label><span>Nombre</span>
      <input name="nombre" required maxlength="120" value="${esc(f.nombre)}"
             placeholder="Centrotrans, línea directa"></label>
    <label><span>Duración</span>
      <input name="duracion" maxlength="60" value="${esc(f.duracion)}" placeholder="2 h 15"></label>
    <label><span>Frecuencia</span>
      <input name="frecuencia" maxlength="120" value="${esc(f.frecuencia)}"
             placeholder="Cada 2 h, de 6:00 a 20:00"></label>
    <label><span>Precio</span>
      <input name="precio" maxlength="60" value="${esc(f.precio)}" placeholder="12 KM (~6 €)"></label>
    <label class="ancho"><span>Nota</span>
      <input name="nota" maxlength="300" value="${esc(f.nota)}"
             placeholder="Sale de la estación de autobuses, se paga el billete al conductor"></label>
    <label class="ancho"><span>Según el sentido</span>
      <input name="nota_sentido" maxlength="300" value="${esc(f.nota_sentido)}"
             placeholder="En sentido contrario solo hay tres salidas al día"></label>
    <label class="ancho"><span>Web</span>
      <input name="web" maxlength="300" value="${esc(f.web)}" placeholder="https://…"></label>`;

  const CAMPOS_MOVILIDAD = (f = {}) => `
    <label><span>Tipo</span>
      <select name="tipo">
        ${TIPOS_MOVILIDAD.map(([v, t]) => `<option value="${v}" ${f.tipo === v ? 'selected' : ''}>${t}</option>`).join('')}
      </select>
    </label>
    <label><span>Nombre</span>
      <input name="nombre" required maxlength="120" value="${esc(f.nombre)}"
             placeholder="Radio Taxi Mostar"></label>
    <label><span>Precio</span>
      <input name="precio" maxlength="60" value="${esc(f.precio)}" placeholder="1,80 € el billete"></label>
    <label><span>Teléfono</span>
      <input name="telefono" type="tel" maxlength="40" value="${esc(f.telefono)}"
             placeholder="+387 36 xxx xxx"></label>
    <label class="ancho"><span>Qué es</span>
      <input name="descripcion" maxlength="300" value="${esc(f.descripcion)}"
             placeholder="La línea 1 va del centro a la estación"></label>
    <label class="ancho"><span>Nota</span>
      <input name="nota" maxlength="300" value="${esc(f.nota)}"
             placeholder="Hay que pedir el taxímetro"></label>
    <label class="ancho"><span>Web</span>
      <input name="web" maxlength="300" value="${esc(f.web)}" placeholder="https://…"></label>`;

  /** Monta el formulario, lo mete donde toca y devuelve lo que se envíe. */
  function formularioFicha({ titulo, campos, destino, alEnviar }) {
    destino.querySelector('.ficha-manual')?.remove();

    const form = document.createElement('form');
    form.className = 'ficha-manual';
    form.innerHTML = `
      <h4 class="ficha-manual__titulo">${esc(titulo)}</h4>
      <div class="ficha-manual__campos">${campos}</div>
      <div class="ficha-manual__pie">
        <button class="boton boton--primario" type="submit">Guardar</button>
        <button class="boton boton--secundario" type="button" data-cancelar-ficha>Cancelar</button>
      </div>`;

    form.addEventListener('click', (ev) => {
      if (ev.target.closest('[data-cancelar-ficha]')) form.remove();
    });
    form.addEventListener('submit', async (ev) => {
      ev.preventDefault();
      const boton = form.querySelector('[type="submit"]');
      boton.disabled = true;
      try {
        await alEnviar(Object.fromEntries(new FormData(form)));
        location.reload();
      } catch (err) {
        console.error('[etapa] no se pudo guardar la ficha:', err);
        boton.disabled = false;
        avisar(err.message);
      }
    });

    destino.prepend(form);
    form.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
    form.querySelector('input')?.focus();
    return form;
  }

  /** Lee del DOM lo que ya tiene una ficha, para reabrirla en el formulario. */
  function leerFichaTransporte(art) {
    const dato = (k) =>
      [...art.querySelectorAll('.ficha-transporte__datos div')]
        .find((d) => d.querySelector('dt')?.textContent.trim() === k)
        ?.querySelector('dd')?.textContent.trim() ?? '';
    return {
      medio: art.dataset.medio ?? 'otro',
      nombre: art.querySelector('.ficha-transporte__nombre')?.textContent.trim() ?? '',
      duracion: dato('Duración'),
      frecuencia: dato('Frecuencia'),
      precio: dato('Precio'),
      nota: art.querySelector('.ficha-transporte__nota')?.textContent.trim() ?? '',
      nota_sentido: art.dataset.notaSentido ?? '',
      web: art.dataset.web ?? '',
    };
  }

  function leerFichaMovilidad(art) {
    return {
      tipo: art.dataset.tipo ?? 'otro',
      nombre: art.querySelector('.ficha-movilidad__nombre')?.textContent.trim() ?? '',
      descripcion: art.querySelector('.ficha-movilidad__texto')?.textContent.trim() ?? '',
      precio: art.dataset.precio ?? '',
      telefono: art.dataset.telefono ?? '',
      nota: art.querySelector('.ficha-movilidad__nota')?.textContent.trim() ?? '',
      web: art.dataset.web ?? '',
    };
  }

  raiz.addEventListener('click', (ev) => {
    // Nueva ficha de medio en un tramo.
    const nuevoMedio = ev.target.closest('[data-nuevo-medio]');
    if (nuevoMedio) {
      const tramoId = nuevoMedio.dataset.nuevoMedio;
      const caja = raiz.querySelector(`[data-medios-de="${tramoId}"]`);
      if (!caja) return;
      // Con el panel vacío está escondido: al escribir el primero, se enseña.
      caja.hidden = false;
      formularioFicha({
        titulo: 'Un medio más, escrito a mano',
        campos: CAMPOS_MEDIO(),
        destino: caja,
        alEnviar: (datos) =>
          pedir(`/api/tramos/${tramoId}/transporte`, { method: 'POST', body: JSON.stringify(datos) }),
      });
      return;
    }

    // Editar una ficha de medio.
    const editarMedio = ev.target.closest('[data-editar-medio]');
    if (editarMedio) {
      const art = editarMedio.closest('.ficha-transporte');
      const caja = editarMedio.closest('[data-medios-de]');
      if (!art || !caja) return;
      formularioFicha({
        titulo: 'Corregir este medio',
        campos: CAMPOS_MEDIO(leerFichaTransporte(art)),
        destino: caja,
        alEnviar: (datos) =>
          pedir(`/api/transporte-tramo/${art.dataset.ficha}`, {
            method: 'PUT',
            body: JSON.stringify(datos),
          }),
      });
      return;
    }

    // Nueva ficha de movilidad urbana.
    const nuevaMovilidad = ev.target.closest('#nueva-movilidad');
    if (nuevaMovilidad) {
      const caja = document.getElementById('sub-moverse');
      if (!caja) return;
      formularioFicha({
        titulo: 'Una ficha escrita a mano',
        campos: CAMPOS_MOVILIDAD(),
        destino: document.getElementById('lista-movilidad') ?? caja,
        alEnviar: (datos) =>
          pedir(`/api/etapas/${etapaId}/movilidad`, { method: 'POST', body: JSON.stringify(datos) }),
      });
      return;
    }

    // Editar una ficha de movilidad.
    const editarMovilidad = ev.target.closest('[data-editar-movilidad]');
    if (editarMovilidad) {
      const art = editarMovilidad.closest('.ficha-movilidad');
      if (!art) return;
      formularioFicha({
        titulo: 'Corregir esta ficha',
        campos: CAMPOS_MOVILIDAD(leerFichaMovilidad(art)),
        destino: document.getElementById('lista-movilidad'),
        alEnviar: (datos) =>
          pedir(`/api/movilidad/${art.dataset.movilidad}`, {
            method: 'PUT',
            body: JSON.stringify(datos),
          }),
      });
    }
  });

  // --- Borrar fichas --------------------------------------------------------
  // Se pregunta: la ficha es del CATÁLOGO, así que borrarla se la quita también
  // a los demás viajes que pasen por aquí.
  raiz.addEventListener('click', async (ev) => {
    const boton = ev.target.closest('[data-borrar-medio], [data-borrar-movilidad]');
    if (!boton) return;

    const esMedio = Boolean(boton.dataset.borrarMedio);
    const id = boton.dataset.borrarMedio || boton.dataset.borrarMovilidad;
    const nombre = boton.dataset.nombre || 'esta ficha';
    if (!confirm(`¿Borrar «${nombre}»? Desaparece del catálogo, también para otros viajes.`)) return;

    try {
      await pedir(esMedio ? `/api/transporte-tramo/${id}` : `/api/movilidad/${id}`, {
        method: 'DELETE',
      });
      location.reload();
    } catch (err) {
      console.error('[etapa] no se pudo borrar la ficha:', err);
      avisar(err.message);
    }
  });


// ===========================================================================
  // DIRECCIONES
  // ---------------------------------------------------------------------------
  // El mismo manejador para las cuatro fichas: hotel, sitio, excursión y
  // transporte urbano. Todas usan `parciales/direccion.ejs`, así que basta con
  // saber leer su `data-direccion-de="tipo:id"`.
  //
  // GUARDAR ES INSTANTÁNEO. Buscar las coordenadas va por la cola —hay que
  // tiene turno de una petición por segundo— y mientras tanto la ficha dice
  // "situando…" y se sondea hasta que se sepa. Nadie espera a nadie.
  //
  // Y AQUÍ NO SE PINTAN COORDENADAS. Ni en el texto, ni en un title, ni en un
  // data-. Lo que se enseña es lo que la persona escribió.
  // ===========================================================================
  raiz.addEventListener('click', (ev) => {
    const abrir = ev.target.closest('[data-editar-direccion]');
    if (abrir) {
      const caja = abrir.closest('.direccion');
      const form = caja.querySelector('[data-form-direccion]');
      form.hidden = false;
      caja.querySelector('.direccion__vista').hidden = true;
      caja.querySelector('.direccion__poner').hidden = true;
      form.direccion.focus();
      form.direccion.select();
      return;
    }

    const cancelar = ev.target.closest('[data-cancelar-direccion]');
    if (cancelar) {
      cerrarDireccion(cancelar.closest('.direccion'));
      return;
    }

    const borrar = ev.target.closest('[data-borrar-direccion]');
    if (borrar) {
      const caja = borrar.closest('.direccion');
      caja.querySelector('[data-form-direccion]').direccion.value = '';
      guardarDireccion(caja);
    }
  });

  raiz.addEventListener('submit', (ev) => {
    const form = ev.target.closest('[data-form-direccion]');
    if (!form) return;
    ev.preventDefault();
    guardarDireccion(form.closest('.direccion'));
  });

  /** Vuelve a enseñar lo que hay, con el formulario recogido. */
  function cerrarDireccion(caja) {
    const form = caja.querySelector('[data-form-direccion]');
    const vista = caja.querySelector('.direccion__vista');
    const poner = caja.querySelector('.direccion__poner');
    const hay = Boolean(caja.querySelector('[data-texto]').textContent.trim());

    form.hidden = true;
    vista.hidden = !hay;
    poner.hidden = hay;
  }

  async function guardarDireccion(caja) {
    const [tipo, elementoId] = caja.dataset.direccionDe.split(':');
    const form = caja.querySelector('[data-form-direccion]');
    const boton = form.querySelector('[type="submit"]');

    boton.disabled = true;
    try {
      const r = await pedir(`/api/direcciones/${tipo}/${elementoId}`, {
        method: 'POST',
        body: JSON.stringify({
          direccion: form.direccion.value,
          viajeId: Number(caja.dataset.viaje),
        }),
      });
      pintarDireccion(caja, r.direccion);
      cerrarDireccion(caja);
      // Se busca en la cola: se pregunta hasta que se sepa.
      if (r.direccion?.buscando) sondearDireccion(caja, tipo, elementoId);
    } catch (err) {
      console.error('[etapa] no se pudo guardar la dirección:', err);
      avisar(err.message);
    } finally {
      boton.disabled = false;
    }
  }

  function pintarDireccion(caja, d) {
    caja.querySelector('[data-texto]').textContent = d?.direccion ?? '';
    caja.querySelector('[data-form-direccion]').direccion.value = d?.direccion ?? '';

    const estado = caja.querySelector('[data-estado]');
    estado.innerHTML = !d
      ? ''
      : d.buscando
        ? '<span class="direccion__situando"><i class="ti ti-loader-2 girando"></i> situando…</span>'
        : d.situada
          ? ''
          : d.fallo
            // Avería: no hay nada que afinar y hay que decirlo, no insinuarlo.
            ? `<span class="direccion__fallo" title="${esc(d.mensaje)}">` +
              '<i class="ti ti-alert-triangle"></i> No he podido situarla</span>'
            : `<span class="direccion__aviso" title="${esc(d.mensaje)}">` +
              '<i class="ti ti-help-circle"></i> sin localizar</span>';
  }

  /**
   * Pregunta cada 3 s si ya se sabe dónde cae.
   *
   * Se para sola: en cuanto deja de estar "buscando" —la haya encontrado o
   * no—, no hay nada más que preguntar.
   */
  function sondearDireccion(caja, tipo, elementoId) {
    let vueltas = 0;
    const reloj = setInterval(async () => {
      vueltas += 1;
      try {
        const r = await pedir(`/api/direcciones/${tipo}/${elementoId}`);
        if (!r.direccion?.buscando || vueltas > 20) {
          clearInterval(reloj);
          pintarDireccion(caja, r.direccion);
        }
      } catch {
        clearInterval(reloj);
      }
    }, 3000);
  }

  // Al cargar: las que ya estaban buscándose siguen sondeándose sin tocar nada.
  raiz.querySelectorAll('.direccion').forEach((caja) => {
    if (!caja.querySelector('.direccion__situando')) return;
    const [tipo, elementoId] = caja.dataset.direccionDe.split(':');
    sondearDireccion(caja, tipo, elementoId);
  });

  // ===========================================================================
  // TRASLADOS
  // ---------------------------------------------------------------------------
  // El buscador de "¿cuánto hay de aquí a allá?" y la lista de lo consultado.
  //
  // Los dos campos aceptan DOS COSAS: el nombre de algo del viaje (y entonces
  // se manda su tipo y su id, para poder recalcular con la dirección de
  // mañana) o cualquier texto (y entonces se geocodifica al vuelo). La lista
  // de lugares llega pintada en el `datalist`, así que basta con mirar si lo
  // tecleado coincide con uno.
  // ===========================================================================
  let lugaresDelViaje = [];
  try {
    lugaresDelViaje = JSON.parse(document.getElementById('datos-lugares')?.textContent ?? '[]');
  } catch { /* sin lugares: todo será texto libre, que también vale */ }

  /** ¿Lo tecleado es uno de los sitios del viaje, o es texto suelto? */
  function comoExtremo(texto) {
    const t = String(texto ?? '').trim();
    if (!t) return null;

    const encaja = lugaresDelViaje.find(
      (l) => l.situada && l.nombre.toLowerCase() === t.toLowerCase()
    );
    return encaja ? { tipo: encaja.tipo, id: encaja.id, texto: encaja.nombre } : { texto: t };
  }

  const cajaError = document.getElementById('traslado-error');

  function errorDeTraslado(mensaje, falta = null) {
    if (!cajaError) return avisar(mensaje);

    cajaError.hidden = false;
    cajaError.querySelector('[data-mensaje]').textContent = mensaje;

    // Si lo que falta es la dirección de algo concreto, se ofrece ir a ponerla
    // en vez de dejar a la persona buscándola por la pantalla.
    const boton = cajaError.querySelector('[data-ir-a-direccion]');
    const caja = falta?.tipo && falta?.id
      ? raiz.querySelector(`.direccion[data-direccion-de="${falta.tipo}:${falta.id}"]`)
      : null;

    boton.hidden = !caja;
    boton.onclick = caja
      ? () => {
          cajaError.hidden = true;
          // Su ficha puede estar en otra subpestaña o dentro de un desplegable.
          caja.closest('.subpanel')?.previousElementSibling
            ?.querySelector(`[data-subpanel="${caja.closest('.subpanel').id}"]`)?.click();
          caja.closest('[hidden]')?.removeAttribute('hidden');
          caja.querySelector('[data-editar-direccion]:not([hidden])')?.click();
          caja.scrollIntoView({ behavior: 'smooth', block: 'center' });
        }
      : null;
  }

  document.getElementById('buscador-traslado')?.addEventListener('submit', async (ev) => {
    ev.preventDefault();
    const form = ev.currentTarget;
    const boton = form.querySelector('[type="submit"]');

    const origen = comoExtremo(form.origen.value);
    const destino = comoExtremo(form.destino.value);
    if (!origen || !destino) return errorDeTraslado('Hay que decir de dónde y adónde.');

    if (cajaError) cajaError.hidden = true;
    boton.disabled = true;
    boton.querySelector('i').className = 'ti ti-loader-2 girando';
    try {
      await pedir(`/api/etapas/${form.dataset.etapa}/traslados`, {
        method: 'POST',
        body: JSON.stringify({ origen, destino }),
      });
      // Se recarga: la lista, el estado del sondeo y el aviso de lo que falta
      // los pinta el servidor, y aquí ya hay tres sitios que actualizar.
      location.reload();
    } catch (err) {
      console.error('[etapa] no se pudo consultar el traslado:', err);
      boton.disabled = false;
      boton.querySelector('i').className = 'ti ti-calculator';
      errorDeTraslado(err.message, err.falta);
    }
  });

  // --- Fijar un traslado para tenerlo siempre arriba ------------------------
  raiz.addEventListener('click', async (ev) => {
    const boton = ev.target.closest('[data-fijar]');
    if (!boton) return;

    boton.disabled = true;
    try {
      await pedir(`/api/traslados/${boton.dataset.fijar}/fijar`, { method: 'POST' });
      // Recargar: cambiar de montón mueve la fila de una lista a la otra, y eso
      // lo pinta el servidor.
      location.reload();
    } catch (err) {
      console.error('[etapa] no se pudo fijar el traslado:', err);
      boton.disabled = false;
      avisar(err.message);
    }
  });

  raiz.addEventListener('click', async (ev) => {
    const recalcular = ev.target.closest('[data-recalcular]');
    if (recalcular) {
      recalcular.disabled = true;
      recalcular.querySelector('i').className = 'ti ti-loader-2 girando';
      try {
        await pedir(`/api/traslados/${recalcular.dataset.recalcular}/recalcular`, { method: 'POST' });
        location.reload();
      } catch (err) {
        console.error('[etapa] no se pudo recalcular:', err);
        avisar(err.message);
      }
      return;
    }

    const borrar = ev.target.closest('[data-borrar-traslado]');
    if (borrar) {
      if (!confirm(`¿Borrar «${borrar.dataset.nombre}» de la lista?`)) return;
      try {
        await pedir(`/api/traslados/${borrar.dataset.borrarTraslado}`, { method: 'DELETE' });
        borrar.closest('.traslado')?.remove();
      } catch (err) {
        console.error('[etapa] no se pudo borrar el traslado:', err);
        avisar(err.message);
      }
    }
  });

  // --- Llevar un traslado consultado al lienzo -------------------------------
  // Además del día y la franja hay que elegir EL MEDIO: el mismo traslado son
  // 20 minutos andando u 8 en coche, y la tarjeta tiene que decir cuál se hace.
  raiz.addEventListener('click', (ev) => {
    const boton = ev.target.closest('[data-al-lienzo]');
    if (!boton || !datosColocar?.dias.length) return;

    ev.preventDefault();

    const fila = boton.closest('.traslado');
    const medios = [...fila.querySelectorAll('.traslado__medio')].map((m) => ({
      valor: m.dataset.modo,
      etiqueta: m.textContent.replace(/\s+/g, ' ').trim(),
    }));

    abrirModal(
      selectorDeDia({ trasladoId: Number(boton.dataset.alLienzo) }, { medios }),
      fila.querySelector('.traslado__recorrido')?.textContent.trim()
    );
  });

// ===========================================================================
  // COMER
  // ---------------------------------------------------------------------------
  // Buscar, apuntar, corregir y pedir los datos de contacto.
  //
  // LOS DATOS DE CONTACTO VAN APARTE, y ese es el punto importante: Places es
  // la API cara y el teléfono, la web y los horarios se pagan por sitio. De
  // veinte resultados se abren dos, así que se piden al pulsar en UNA ficha y
  // solo la primera vez. Es el mismo camino que las fichas de Civitatis.
  // ===========================================================================
  const TIPOS_COCINA_SUGERIDOS =
    'tapas, arrocería, italiano, japonés, de mercado, castellano, vegetariano';

  document.getElementById('buscador-comer')?.addEventListener('submit', (ev) => {
    ev.preventDefault();
    buscarComer(ev.currentTarget.dataset.etapa, ev.currentTarget.consulta.value);
  });

  // El botón de al lado: lo mejor de la ciudad, sin escribir nada.
  document.getElementById('comer-rapido')?.addEventListener('click', () => {
    const form = document.getElementById('buscador-comer');
    buscarComer(form.dataset.etapa, '');
  });

  async function buscarComer(etapa, consulta) {
    const form = document.getElementById('buscador-comer');
    for (const b of form.querySelectorAll('button')) b.disabled = true;
    form.consulta.disabled = true;

    try {
      await pedir(`/api/etapas/${etapa}/comer/buscar`, {
        method: 'POST',
        body: JSON.stringify({ consulta }),
      });
      location.reload();
    } catch (err) {
      console.error('[etapa] no se pudo buscar dónde comer:', err);
      for (const b of form.querySelectorAll('button')) b.disabled = false;
      form.consulta.disabled = false;
      avisar(err.message);
    }
  }

  // --- Apuntar un sitio -----------------------------------------------------
  raiz.addEventListener('click', async (ev) => {
    const boton = ev.target.closest('[data-marcar-comer]');
    if (!boton) return;

    boton.disabled = true;
    try {
      await pedir(`/etapa/${etapaId}/apuntar`, {
        method: 'POST',
        body: JSON.stringify({ que: 'comer', id: Number(boton.dataset.marcarComer) }),
      });
      // Recargar: apuntar cambia la ficha, el contador de la pestaña y la lista
      // de lugares del buscador de traslados. Tres sitios que pinta el servidor.
      location.reload();
    } catch (err) {
      console.error('[etapa] no se pudo apuntar:', err);
      boton.disabled = false;
      avisar(err.message);
    }
  });

  // --- Los datos de contacto, bajo demanda ----------------------------------
  raiz.addEventListener('click', async (ev) => {
    const boton = ev.target.closest('[data-detalles-comer]');
    if (!boton) return;

    const id = boton.dataset.detallesComer;
    boton.disabled = true;
    boton.querySelector('i').className = 'ti ti-loader-2 girando';
    boton.querySelector('span').textContent = 'Buscando…';

    const parado = () => {
      boton.disabled = false;
      boton.querySelector('i').className = 'ti ti-address-book';
      boton.querySelector('span').textContent = 'Teléfono y horarios';
    };

    try {
      const r = await pedir(`/api/comer/${id}/detalles`, {
        method: 'POST',
        body: JSON.stringify({ viajeId: datosColocar?.viajeId ?? null }),
      });
      if (r.estado === 'hecho') return location.reload();
      sondearDetallesComer(id, parado);
    } catch (err) {
      console.error('[etapa] no se pudieron pedir los datos:', err);
      parado();
      avisar(err.message);
    }
  });

  /** Pregunta cada 4 s si ya están, igual que las fichas de Civitatis. */
  function sondearDetallesComer(id, alFallar) {
    const reloj = setInterval(async () => {
      try {
        const r = await pedir(`/api/comer/${id}/detalles?viaje=${datosColocar?.viajeId ?? ''}`);
        if (r.estado === 'hecho') {
          clearInterval(reloj);
          location.reload();
        } else if (r.estado === 'error' || r.estado === 'no_existe') {
          clearInterval(reloj);
          alFallar();
          avisar(r.mensaje || 'No se pudieron traer los datos de ese sitio.');
        }
      } catch (err) {
        console.error('[etapa] sondeo de los datos:', err);
      }
    }, 4000);
  }

  // --- Fichas a mano, y corregir las que hay --------------------------------
  const CAMPOS_COMER = (f = {}) => `
    <label><span>Nombre</span>
      <input name="nombre" required maxlength="150" value="${esc(f.nombre)}"
             placeholder="Casa Botín"></label>
    <label><span>Cocina</span>
      <input name="cocina" maxlength="100" value="${esc(f.cocina)}"
             placeholder="${TIPOS_COCINA_SUGERIDOS.split(', ')[0]}"></label>
    <label><span>Precio</span>
      <input name="precioTexto" maxlength="60" value="${esc(f.precioTexto)}"
             placeholder="40-55 € por persona"></label>
    <label><span>Teléfono</span>
      <input name="telefono" type="tel" maxlength="40" value="${esc(f.telefono)}"
             placeholder="+34 913 66 42 17"></label>
    <label class="ancho"><span>Dirección</span>
      <input name="direccion" maxlength="300" value="${esc(f.direccion)}"
             placeholder="Calle de Cuchilleros 17"></label>
    <label class="ancho"><span>Web</span>
      <input name="web" maxlength="300" value="${esc(f.web)}" placeholder="https://…"></label>
    <label class="ancho"><span>Nota</span>
      <input name="nota" maxlength="300" value="${esc(f.nota)}"
             placeholder="Me lo recomendó Ana. Reservar con tiempo."></label>`;

  /** Lo que ya tiene una ficha, leído del DOM para reabrirla en el formulario. */
  function leerFichaComer(art) {
    return {
      nombre: art.dataset.nombre ?? '',
      cocina: art.dataset.cocina ?? '',
      precioTexto: art.dataset.precioTexto ?? '',
      telefono: art.dataset.telefono ?? '',
      web: art.dataset.web ?? '',
      nota: art.dataset.notaTexto ?? '',
      direccion: art.querySelector('.direccion [data-texto]')?.textContent.trim() ?? '',
    };
  }

  raiz.addEventListener('click', (ev) => {
    const nueva = ev.target.closest('#nueva-comer');
    if (nueva) {
      formularioFicha({
        titulo: 'Un sitio escrito a mano',
        campos: CAMPOS_COMER(),
        destino: document.getElementById('lista-comer'),
        alEnviar: (datos) =>
          pedir(`/api/etapas/${etapaId}/comer`, { method: 'POST', body: JSON.stringify(datos) }),
      });
      return;
    }

    const editar = ev.target.closest('[data-editar-comer]');
    if (editar) {
      const art = editar.closest('.ficha-comer');
      formularioFicha({
        titulo: 'Corregir este sitio',
        campos: CAMPOS_COMER(leerFichaComer(art)),
        destino: document.getElementById('lista-comer'),
        alEnviar: (datos) =>
          pedir(`/api/comer/${art.dataset.comer}`, {
            method: 'PUT',
            body: JSON.stringify(datos),
          }),
      });
      return;
    }

    const borrar = ev.target.closest('[data-borrar-comer]');
    if (borrar) {
      if (!confirm(`¿Borrar «${borrar.dataset.nombre}»? Desaparece del catálogo de la ciudad.`)) return;
      pedir(`/api/comer/${borrar.dataset.borrarComer}`, { method: 'DELETE' })
        .then(() => location.reload())
        .catch((err) => {
          console.error('[etapa] no se pudo borrar:', err);
          avisar(err.message);
        });
    }
  });

  // ===========================================================================
  // DISTANCIAS DE UNA FICHA
  // ---------------------------------------------------------------------------
  // "¿A cuánto está de…?" con la ficha como origen fijo. Es el MISMO selector y
  // la MISMA tabla de traslados de la pestaña "Moverse": aquí solo se mira
  // desde el otro lado. Por eso borrar una distancia desde aquí la borra allí,
  // que es lo correcto: es el mismo dato.
  // ===========================================================================
  raiz.addEventListener('click', (ev) => {
    const boton = ev.target.closest('[data-anadir-distancia]');
    if (!boton) return;
    ev.preventDefault();

    const caja = boton.closest('.distancias');
    const abierto = caja.querySelector('.distancias__form');
    if (abierto) { abierto.remove(); return; }

    const [tipo, id] = caja.dataset.distanciasDe.split(':');

    const form = document.createElement('form');
    form.className = 'distancias__form';
    form.innerHTML = `
      <label class="distancias__campo">
        <span>¿A cuánto está de…?</span>
        <input type="text" name="destino" list="lugares-${etapaId}" autocomplete="off"
               placeholder="El hotel, un sitio, o una dirección" required>
      </label>
      <button class="boton boton--primario boton--pequeno" type="submit">Calcular</button>
      <button class="boton boton--secundario boton--pequeno" type="button" data-cerrar>Cancelar</button>`;

    form.addEventListener('click', (e) => {
      if (e.target.closest('[data-cerrar]')) form.remove();
    });
    form.addEventListener('submit', async (e) => {
      e.preventDefault();
      const enviar = form.querySelector('[type="submit"]');
      enviar.disabled = true;
      try {
        await pedir(`/api/etapas/${etapaId}/traslados`, {
          method: 'POST',
          body: JSON.stringify({
            origen: { tipo, id: Number(id), texto: caja.dataset.nombre },
            destino: comoExtremo(form.destino.value),
          }),
        });
        location.reload();
      } catch (err) {
        console.error('[etapa] no se pudo calcular la distancia:', err);
        enviar.disabled = false;
        avisar(err.message);
      }
    });

    boton.before(form);
    form.destino.focus();
  });

  raiz.addEventListener('click', async (ev) => {
    const boton = ev.target.closest('[data-borrar-distancia]');
    if (!boton) return;
    try {
      await pedir(`/api/traslados/${boton.dataset.borrarDistancia}`, { method: 'DELETE' });
      boton.closest('.distancia')?.remove();
    } catch (err) {
      console.error('[etapa] no se pudo borrar la distancia:', err);
      avisar(err.message);
    }
  });

  // ===========================================================================
  // SONDEO mientras haya algo en marcha
  // ---------------------------------------------------------------------------
  // UNO SOLO PARA TODA LA PANTALLA. Aquí pueden estar trabajando a la vez la
  // preparación de la ciudad, los hoteles y los vuelos de cada tramo, y con un
  // sondeo por cosa serían cuatro peticiones cada cinco segundos para responder
  // lo mismo.
  //
  // Y lo importante: se enciende si CUALQUIERA de ellas está en marcha. Antes
  // solo miraba la ficha y los hoteles, así que buscar vuelos dejaba el
  // "Buscando en Kayak…" colgado indefinidamente —el trabajo terminaba bien,
  // pero nadie estaba mirando— y los resultados solo salían cuando otra cosa
  // forzaba una recarga.
  //
  // Cuando algo termina se recarga la pantalla entera, y eso NO pisa al tramo
  // que siga buscando: lo que se pinta lo decide el servidor, que sabe cómo
  // está cada uno. El que siga en marcha vuelve a salir "buscando", y el que
  // haya fallado sale con su error y su botón de reintentar.
  // ===========================================================================
  if (!raiz.dataset.trabajando) return;

  const pistaGeneral = document.getElementById('buscando-pista');
  const lineaPreparando = document.getElementById('preparando-mensaje');
  const arranque = Date.now();

  /** Cuántas cosas hay trabajando ahora mismo, para notar cuándo baja. */
  const cuantasTrabajan = (datos) =>
    (datos.preparacion?.trabajando ? 1 : 0) +
    (datos.datos?.buscando ? 1 : 0) +
    (datos.hoteles === 'buscando' ? 1 : 0) +
    (datos.movilidad?.buscando ? 1 : 0) +
    (datos.traslados?.calculando ? 1 : 0) +
    (datos.comer?.buscando ? 1 : 0) +
    Object.values(datos.tramos ?? {}).filter((t) => t.estado === 'buscando').length +
    Object.values(datos.tramos ?? {}).filter((t) => t.medios?.buscando).length;

  let ultimaCuenta = null;

  async function comprobar() {
    try {
      const r = await fetch(`/etapa/${etapaId}/estado`, { headers: { Accept: 'application/json' } });
      if (!r.ok) throw new Error(`El servidor respondió ${r.status}`);
      const datos = await r.json();

      // Nada en marcha: se recarga y se ve el resultado de todo.
      if (!datos.trabajando) {
        if (pistaGeneral) pistaGeneral.textContent = 'Listo, cargando…';
        location.reload();
        return;
      }

      // Algo ha terminado pero queda trabajo: también se recarga, para enseñar
      // ya lo que esté hecho sin esperar a lo demás.
      const cuenta = cuantasTrabajan(datos);
      if (ultimaCuenta != null && cuenta < ultimaCuenta) {
        location.reload();
        return;
      }
      ultimaCuenta = cuenta;

      // Mientras tanto, contar el rato en cada sitio que esté esperando.
      const segundos = Math.round((Date.now() - arranque) / 1000);
      if (pistaGeneral) pistaGeneral.textContent = `Lleva ${segundos} s…`;
      if (lineaPreparando && datos.preparacion?.mensaje) {
        lineaPreparando.textContent = datos.preparacion.mensaje;
      }
      for (const [tramoId, estado] of Object.entries(datos.tramos ?? {})) {
        const pista = raiz.querySelector(`[data-pista-tramo="${tramoId}"]`);
        if (pista) pista.textContent = estado.estado === 'buscando' ? ` Lleva ${segundos} s…` : '';
      }
    } catch (err) {
      console.error('[etapa] no se pudo consultar el estado:', err);
      if (pistaGeneral) pistaGeneral.textContent = 'Sin respuesta del servidor; reintentando…';
    }
    setTimeout(comprobar, 5000);
  }

  setTimeout(comprobar, 5000);
})();
