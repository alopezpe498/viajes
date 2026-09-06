/**
 * public/js/adjuntos.js
 * -----------------------------------------------------------------------------
 * El cajón de adjuntos: subir, listar y borrar.
 *
 * Todo delegado en el documento, así que vale para los tres sitios donde
 * aparece —un tramo, el hotel, una excursión— y para los que se pinten después
 * de cargar la página. Cada cajón sabe de qué elemento es por sus data-.
 *
 * SE SUBE DE UNO EN UNO, con el archivo como cuerpo del fetch. El servidor lo
 * recibe con express.raw, así que no hace falta meter una librería de multipart
 * en el proyecto para algo que se usa así.
 */
(() => {
  const TOPE = 15 * 1024 * 1024;
  const ACEPTADOS = ['application/pdf', 'image/jpeg', 'image/png', 'image/heic', 'image/heif'];

  /** "1.2 MB" · "340 KB" — el mismo criterio que el servidor. */
  function comoTamano(bytes) {
    const n = Number(bytes) || 0;
    if (n < 1024) return `${n} B`;
    if (n < 1024 * 1024) return `${Math.round(n / 1024)} KB`;
    return `${(n / 1024 / 1024).toFixed(1)} MB`;
  }

  function esc(t) {
    const d = document.createElement('div');
    d.textContent = t ?? '';
    return d.innerHTML;
  }

  /** Un aviso dentro del propio cajón: el error es de ahí, no de la pantalla. */
  function avisar(cajon, texto, esError = true) {
    const p = cajon.querySelector('[data-aviso]');
    if (!p) return;
    p.textContent = texto;
    p.classList.toggle('oculto', !texto);
    p.classList.toggle('adjuntos__aviso--error', esError);
    if (texto) clearTimeout(p._reloj), (p._reloj = setTimeout(() => p.classList.add('oculto'), 6000));
  }

  /** Repinta la lista y el contador. Una sola forma de pintar un adjunto. */
  function pintar(cajon, adjuntos) {
    const lista = cajon.querySelector('[data-lista]');
    lista.innerHTML = adjuntos
      .map(
        (a) => `<li class="adjunto" data-adjunto="${a.id}">
          <i class="ti ${a.mime === 'application/pdf' ? 'ti-file-type-pdf' : 'ti-photo'}" aria-hidden="true"></i>
          <span class="adjunto__nombre" title="${esc(a.nombre_original)}">${esc(a.nombre_original)}</span>
          <span class="adjunto__peso">${esc(a.tamanoTexto || comoTamano(a.tamano))}</span>
          <a class="adjunto__accion" href="/adjunto/${a.id}" target="_blank" rel="noopener noreferrer">Ver</a>
          <button class="adjunto__accion adjunto__accion--peligro" type="button"
                  data-borrar-adjunto="${a.id}">Borrar</button>
        </li>`
      )
      .join('');

    const contador = cajon.querySelector('.adjuntos__n');
    if (contador) {
      contador.textContent = adjuntos.length;
      contador.classList.toggle('adjuntos__n--cero', adjuntos.length === 0);
    }
  }

  async function recargar(cajon) {
    const { tipo, elemento } = cajon.dataset;
    try {
      const r = await fetch(`/api/adjuntos/${tipo}/${elemento}`, { headers: { Accept: 'application/json' } });
      const datos = await r.json();
      if (r.ok) pintar(cajon, datos.adjuntos);
    } catch (err) {
      console.error('[adjuntos] no se pudo recargar la lista:', err);
    }
  }

  /** Sube un archivo. Comprueba antes lo evidente para no gastar el viaje. */
  async function subir(cajon, archivo) {
    const { tipo, elemento } = cajon.dataset;

    if (!ACEPTADOS.includes(archivo.type)) {
      avisar(cajon, `«${archivo.name}»: solo PDF o imágenes (JPG, PNG, HEIC).`);
      return false;
    }
    if (archivo.size > TOPE) {
      avisar(cajon, `«${archivo.name}» pesa ${comoTamano(archivo.size)}; el máximo son 15 MB.`);
      return false;
    }

    try {
      const r = await fetch(`/api/adjuntos/${tipo}/${elemento}`, {
        method: 'POST',
        headers: {
          'Content-Type': archivo.type,
          // El nombre va codificado: puede traer acentos, comas o espacios, y
          // una cabecera HTTP no admite cualquier cosa.
          'X-Nombre': encodeURIComponent(archivo.name),
        },
        body: archivo,
      });
      const datos = await r.json();
      if (!r.ok) throw new Error(datos.error || `Error ${r.status}`);
      return true;
    } catch (err) {
      console.error('[adjuntos] no se pudo subir:', err);
      avisar(cajon, err.message);
      return false;
    }
  }

  /** Sube una tanda, de una en una, y recarga al final. */
  async function subirVarios(cajon, archivos) {
    const zona = cajon.querySelector('[data-soltar]');
    zona?.classList.add('soltar--trabajando');
    avisar(cajon, '', false);

    let bien = 0;
    for (const a of archivos) {
      if (await subir(cajon, a)) bien++;
    }

    zona?.classList.remove('soltar--trabajando');
    await recargar(cajon);

    if (bien) avisar(cajon, `${bien} ${bien === 1 ? 'archivo añadido' : 'archivos añadidos'}.`, false);
    // Si no entró ninguno, el aviso del fallo ya está puesto y se respeta.
  }

  // ===========================================================================
  // ABRIR Y CERRAR
  // ===========================================================================
  document.addEventListener('click', (ev) => {
    const boton = ev.target.closest('.adjuntos__disparador');
    if (!boton) return;

    const cuerpo = document.getElementById(boton.getAttribute('aria-controls'));
    if (!cuerpo) return;

    const abierto = boton.getAttribute('aria-expanded') === 'true';
    boton.setAttribute('aria-expanded', String(!abierto));
    cuerpo.hidden = abierto;

    // Al abrir se recarga: puede haber cambiado desde otra pestaña, y de paso el
    // servidor aprovecha para limpiar los que se quedaron sin elemento.
    if (!abierto) recargar(boton.closest('.adjuntos'));
  });

  // ===========================================================================
  // ELEGIR ARCHIVOS
  // ===========================================================================
  document.addEventListener('change', (ev) => {
    const campo = ev.target.closest('[data-archivo]');
    if (!campo || !campo.files?.length) return;

    const cajon = campo.closest('.adjuntos');
    subirVarios(cajon, [...campo.files]);
    campo.value = ''; // para poder volver a elegir el mismo archivo
  });

  // ===========================================================================
  // ARRASTRAR Y SOLTAR
  // ---------------------------------------------------------------------------
  // Hay que cancelar dragover en la zona o el navegador abre el archivo en la
  // pestaña, que es su comportamiento por defecto y aquí sería perder la página.
  // ===========================================================================
  document.addEventListener('dragover', (ev) => {
    const zona = ev.target.closest('[data-soltar]');
    if (!zona) return;
    ev.preventDefault();
    zona.classList.add('soltar--encima');
  });

  document.addEventListener('dragleave', (ev) => {
    const zona = ev.target.closest('[data-soltar]');
    if (zona && !zona.contains(ev.relatedTarget)) zona.classList.remove('soltar--encima');
  });

  document.addEventListener('drop', (ev) => {
    const zona = ev.target.closest('[data-soltar]');
    if (!zona) return;
    ev.preventDefault();
    zona.classList.remove('soltar--encima');

    const archivos = [...(ev.dataTransfer?.files ?? [])];
    if (archivos.length) subirVarios(zona.closest('.adjuntos'), archivos);
  });

  // Soltar FUERA de una zona tampoco puede abrir el archivo y perder la página.
  document.addEventListener('dragover', (ev) => {
    if (!ev.target.closest('[data-soltar]')) ev.preventDefault();
  });
  document.addEventListener('drop', (ev) => {
    if (!ev.target.closest('[data-soltar]')) ev.preventDefault();
  });

  // ===========================================================================
  // BORRAR
  // ===========================================================================
  document.addEventListener('click', async (ev) => {
    const boton = ev.target.closest('[data-borrar-adjunto]');
    if (!boton) return;

    const cajon = boton.closest('.adjuntos');
    const fila = boton.closest('.adjunto');
    const nombre = fila?.querySelector('.adjunto__nombre')?.textContent ?? 'ese archivo';
    if (!confirm(`¿Borrar «${nombre}»?`)) return;

    try {
      const r = await fetch(`/api/adjuntos/${boton.dataset.borrarAdjunto}`, {
        method: 'DELETE',
        headers: { Accept: 'application/json' },
      });
      const datos = await r.json();
      if (!r.ok) throw new Error(datos.error || `Error ${r.status}`);
      await recargar(cajon);
    } catch (err) {
      console.error('[adjuntos] no se pudo borrar:', err);
      avisar(cajon, err.message);
    }
  });
})();
