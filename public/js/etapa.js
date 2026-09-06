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
  // ===========================================================================
  const barra = document.getElementById('pestanas');
  const botones = barra ? [...barra.querySelectorAll('.pestana')] : [];
  const paneles = botones.map((b) => document.getElementById(b.dataset.panel));

  function mostrar(indice, { conAncla = true } = {}) {
    botones.forEach((b, i) => {
      b.classList.toggle('pestana--activa', i === indice);
      b.setAttribute('aria-selected', String(i === indice));
    });
    paneles.forEach((p, i) => {
      if (p) p.hidden = i !== indice;
    });
    // El ancla en la URL: así "#llegar" desde la pantalla de ruta abre
    // directamente la pestaña del transporte, y recargar no la pierde.
    if (conAncla && botones[indice]) {
      history.replaceState(null, '', `#${botones[indice].dataset.ancla}`);
    }
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

  /** Abre la pestaña que diga el ancla de la URL, si la hay. */
  function pestanaDelAncla() {
    const ancla = location.hash.slice(1);
    const i = botones.findIndex((b) => b.dataset.ancla === ancla);
    if (i >= 0) mostrar(i, { conAncla: false });
  }

  pestanaDelAncla();

  // Y también cuando el ancla cambia sin recargar. Pasa más de lo que parece:
  // ir de /etapa/15 a /etapa/15#dormir es navegación DENTRO del mismo
  // documento, el navegador no vuelve a pedir la página y sin esto la pestaña
  // se quedaba donde estaba. Los chips de la pantalla de ruta llegan así.
  window.addEventListener('hashchange', pestanaDelAncla);


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

    const mostrarSub = (indice) => {
      subBotones.forEach((b, i) => {
        b.classList.toggle('subpestana--activa', i === indice);
        b.setAttribute('aria-selected', String(i === indice));
      });
      subPaneles.forEach((p, i) => {
        if (p) p.hidden = i !== indice;
      });
    };

    subBotones.forEach((b, i) => b.addEventListener('click', () => mostrarSub(i)));

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
      boton.querySelector('span').textContent = abierta ? 'Ver detalles' : 'Ocultar detalles';
      if (!abierta) ficha.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
      return;
    }

    // --- b) Hay que ir a buscarla -------------------------------------------
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
      boton.querySelector('span').textContent = 'Ver detalles';
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
    url.hash = 'ver';
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
      boton.querySelector('i').className = 'ti ti-list-details';
      boton.querySelector('span').textContent = 'Ver detalles';
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
    const boton = ev.target.closest('[data-poner]');
    if (!boton || !datosColocar?.dias.length) return;

    ev.preventDefault();
    ev.stopPropagation();

    // Si ya estaba abierto, se cierra: el botón es un interruptor.
    const abierto = boton.parentElement.querySelector('.poner-en-dia');
    if (abierto) { abierto.remove(); return; }

    boton.parentElement.appendChild(selectorDeDia(Number(boton.dataset.poner)));
  });

  function selectorDeDia(candidatoId) {
    const caja = document.createElement('form');
    caja.className = 'poner-en-dia';
    caja.innerHTML = `
      <select name="dia" aria-label="Día">
        ${datosColocar.dias.map((d) => `<option value="${d.n}">Día ${d.n} · ${d.fecha}</option>`).join('')}
      </select>
      <select name="franja" aria-label="Franja">
        ${datosColocar.franjas.map((f) => `<option value="${f.clave}">${f.etiqueta}</option>`).join('')}
      </select>
      <button type="submit">Poner</button>`;

    caja.addEventListener('click', (ev) => ev.stopPropagation());
    caja.addEventListener('submit', async (ev) => {
      ev.preventDefault();
      ev.stopPropagation();
      try {
        const r = await fetch('/api/itinerario', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
          body: JSON.stringify({
            viajeId: datosColocar.viajeId,
            candidatoId,
            dia: Number(caja.dia.value),
            franja: caja.franja.value,
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

  // Elegir un vuelo lo hace el manejador genérico de app.js: la tarjeta es la
  // misma del paso 5 y su círculo ya sabe hablar con `data-marcar`. Después se
  // recarga, porque el tramo pasa de "Pendiente" a "Resuelto" y eso cambia
  // media tarjeta.
  document.addEventListener('click', (ev) => {
    if (ev.target.closest('.vuelos-tramo [data-marcar]')) {
      setTimeout(() => location.reload(), 400);
    }
  });

  function esc(t) {
    const d = document.createElement('div');
    d.textContent = t ?? '';
    return d.innerHTML;
  }

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
    (datos.hoteles === 'buscando' ? 1 : 0) +
    Object.values(datos.tramos ?? {}).filter((t) => t.estado === 'buscando').length;

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
