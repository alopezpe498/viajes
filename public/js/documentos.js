/**
 * public/js/documentos.js
 * -----------------------------------------------------------------------------
 * EL VISOR DE DOCUMENTOS DEL VIAJE.
 *
 * Se pulsa un documento de la lista y se ve a la derecha. Nada más: esta
 * pantalla no sube, no borra y no edita. Por eso aquí no hay ni un solo POST.
 *
 * CADA FORMATO SE PINTA COMO SE PUEDE PINTAR, y esa decisión la tomó el servidor
 * —que es quien sabe el MIME— y llega en `data-como`. Aquí solo se obedece:
 *
 *   pdf      → un <iframe>, que es lo que el navegador ya sabe hacer
 *   imagen   → un <img>
 *   correo   → se pide el contenido ya desmontado y se pintan las cabeceras
 *   texto    → igual, pero solo el cuerpo
 *   descarga → lo que no se sabe pintar (HEIC, Word): se ofrece bajarlo y punto
 *
 * LO QUE NO SE SABE ENSEÑAR SE DICE. Un visor que deja un rectángulo en blanco
 * hace pensar que el documento está roto; uno que dice «esto no lo sé enseñar,
 * bájatelo» deja al usuario en condiciones de hacer algo.
 */
(() => {
  const zona = document.querySelector('[data-docs]');
  if (!zona) return; // el viaje no tiene papeles: no hay visor que montar

  const lienzo = zona.querySelector('[data-visor-lienzo]');
  const elNombre = zona.querySelector('[data-visor-nombre]');
  const laEtiqueta = zona.querySelector('[data-visor-etiqueta]');
  const descargar = zona.querySelector('[data-visor-descargar]');
  const completa = zona.querySelector('[data-visor-completa]');
  const visor = zona.querySelector('[data-visor]');

  /** Escapar SIEMPRE lo que venga de un archivo: es texto ajeno. */
  const limpio = (t) =>
    String(t ?? '')
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;');

  function pintarDescarga(url, nombre, porQue) {
    lienzo.innerHTML =
      '<div class="visor__descarga">' +
      '<i class="ti ti-file-download" aria-hidden="true"></i>' +
      `<strong>${limpio(nombre)}</strong>` +
      `<span>${limpio(porQue)}</span>` +
      `<a class="boton boton--secundario" href="${limpio(url)}" download>Descargar el documento</a>` +
      '</div>';
  }

  function pintarAviso(texto) {
    lienzo.innerHTML = `<p class="visor__vacio"><i class="ti ti-alert-circle" aria-hidden="true"></i>${limpio(texto)}</p>`;
  }

  /** El correo, con sus cabeceras arriba y el cuerpo tal cual venía. */
  function pintarCorreo(d) {
    const fila = (campo, valor) =>
      valor
        ? `<span class="correo__campo">${campo}</span><span class="correo__valor">${limpio(valor)}</span>`
        : '';

    const cabeceras = fila('De', d.de) + fila('Para', d.para) + fila('Fecha', d.fecha);

    lienzo.innerHTML =
      '<div class="visor__papel">' +
      (d.asunto ? `<h2 class="correo__asunto">${limpio(d.asunto)}</h2>` : '') +
      (cabeceras ? `<div class="correo__cabeceras">${cabeceras}</div>` : '') +
      // Cuando el texto sale de desmontar el HTML se avisa: explica que la
      // presentación se vea pobre y evita que parezca que falta algo.
      (d.deHtml
        ? '<p class="visor__nota">Este correo solo venía en formato con estilos. Se enseña su texto, sin la maquetación original.</p>'
        : '') +
      (d.cuerpo
        ? `<pre class="correo__cuerpo">${limpio(d.cuerpo)}</pre>`
        : '<p class="secundario">Este correo no trae texto que enseñar.</p>') +
      '</div>';
  }

  function pintarTexto(d) {
    lienzo.innerHTML =
      '<div class="visor__papel">' +
      (d.cuerpo
        ? `<pre class="texto__cuerpo">${limpio(d.cuerpo)}</pre>`
        : '<p class="secundario">El archivo está vacío.</p>') +
      '</div>';
  }

  /** Marca cuál está abierto: sin esto no se sabe qué se está mirando. */
  function marcar(boton) {
    for (const b of zona.querySelectorAll('.doc')) {
      b.classList.toggle('activo', b === boton);
      b.setAttribute('aria-current', b === boton ? 'true' : 'false');
    }
  }

  async function abrir(boton) {
    const { doc, como, url, nombre, etiqueta } = boton.dataset;

    marcar(boton);
    elNombre.textContent = nombre;
    laEtiqueta.textContent = etiqueta;

    descargar.href = url;
    descargar.hidden = false;
    // La pantalla completa solo tiene sentido con algo que ocupe: en un correo
    // corto es un botón que no hace nada visible.
    completa.hidden = !(como === 'pdf' || como === 'imagen');

    if (como === 'pdf') {
      lienzo.innerHTML = `<iframe src="${limpio(url)}" title="${limpio(nombre)}"></iframe>`;
      return;
    }
    if (como === 'imagen') {
      lienzo.innerHTML = `<img src="${limpio(url)}" alt="${limpio(nombre)}">`;
      return;
    }
    if (como === 'descarga') {
      pintarDescarga(url, nombre, 'Este formato no se puede ver aquí dentro.');
      return;
    }

    // Correo y texto: el contenido lo desmonta el servidor.
    lienzo.innerHTML = '<p class="visor__vacio"><i class="ti ti-loader" aria-hidden="true"></i>Abriendo…</p>';
    try {
      const r = await fetch(`/api/adjunto/${doc}/contenido`, { headers: { Accept: 'application/json' } });
      if (!r.ok) {
        pintarDescarga(url, nombre, 'No se ha podido leer el contenido de este documento.');
        return;
      }
      const d = await r.json();
      if (d.clase === 'correo') pintarCorreo(d);
      else pintarTexto(d);
    } catch {
      pintarAviso('No se ha podido abrir el documento. Inténtalo otra vez.');
    }
  }

  zona.addEventListener('click', (e) => {
    const boton = e.target.closest('.doc');
    if (boton) abrir(boton);
  });

  completa?.addEventListener('click', () => {
    // El navegador puede negarse —o no soportarlo— y eso no es un error que
    // haya que contarle a nadie: el documento se sigue viendo igual.
    visor.requestFullscreen?.().catch(() => {});
  });

  // Se abre el primero al entrar: el visor vacío desperdicia media pantalla y
  // la primera pregunta de cualquiera es «enséñame algo».
  const primero = zona.querySelector('.doc');
  if (primero) abrir(primero);
})();
