/**
 * public/js/home.js
 * -----------------------------------------------------------------------------
 * La portada: el menú ⋯ de cada billete, cambiar el nombre y borrar el viaje.
 *
 * Borrar se lleva por delante un montón de trabajo, así que pregunta antes con
 * el modal de la casa —no con el confirm() del navegador— y dice exactamente
 * cuántas etapas, cuántas cosas apuntadas y cuántas del lienzo se van con él.
 */
(() => {
  const portada = document.querySelector('.portada');
  if (!portada) return;

  const modalBorrar = document.getElementById('modal-borrar');
  const modalNombre = document.getElementById('modal-nombre');
  const formNombre = document.getElementById('form-nombre');

  let viajeEnCurso = null;

  function avisar(texto) {
    const nota = document.createElement('div');
    nota.className = 'nota-flotante';
    nota.textContent = texto;
    document.body.appendChild(nota);
    setTimeout(() => nota.remove(), 4000);
  }

  // ===========================================================================
  // EL MENÚ ⋯
  // ===========================================================================
  function cerrarMenus() {
    for (const m of document.querySelectorAll('.menu--abierto')) {
      m.classList.remove('menu--abierto');
      m.previousElementSibling?.setAttribute('aria-expanded', 'false');
    }
  }

  portada.addEventListener('click', (ev) => {
    const boton = ev.target.closest('.menu-btn');
    if (boton) {
      // El billete entero es un enlace: sin esto, abrir el menú abriría el viaje.
      ev.preventDefault();
      ev.stopPropagation();

      const menu = boton.nextElementSibling;
      const abierto = menu.classList.contains('menu--abierto');
      cerrarMenus();
      if (!abierto) {
        menu.classList.add('menu--abierto');
        boton.setAttribute('aria-expanded', 'true');
      }
      return;
    }

    const renombrar = ev.target.closest('[data-renombrar]');
    if (renombrar) {
      ev.preventDefault();
      ev.stopPropagation();
      abrirRenombrar(Number(renombrar.dataset.renombrar));
      return;
    }

    const borrar = ev.target.closest('[data-borrar]');
    if (borrar) {
      ev.preventDefault();
      ev.stopPropagation();
      abrirBorrar(Number(borrar.dataset.borrar));
    }
  });

  // Un clic en cualquier otro sitio cierra el menú abierto.
  document.addEventListener('click', cerrarMenus);
  document.addEventListener('keydown', (ev) => {
    if (ev.key !== 'Escape') return;
    cerrarMenus();
    cerrar(modalBorrar);
    cerrar(modalNombre);
  });

  // ===========================================================================
  // MODALES
  // ===========================================================================
  const cerrar = (modal) => { if (modal) modal.hidden = true; };

  for (const el of document.querySelectorAll('[data-modal-cerrar]')) {
    el.addEventListener('click', () => {
      cerrar(modalBorrar);
      cerrar(modalNombre);
      viajeEnCurso = null;
    });
  }

  // --- Cambiar nombre ------------------------------------------------------
  function abrirRenombrar(id) {
    cerrarMenus();
    viajeEnCurso = id;
    const billete = document.querySelector(`.billete[data-viaje="${id}"]`);
    formNombre.nombre.value = billete?.dataset.nombre ?? '';
    modalNombre.hidden = false;
    formNombre.nombre.focus();
    formNombre.nombre.select();
  }

  formNombre.addEventListener('submit', async (ev) => {
    ev.preventDefault();
    const nombre = formNombre.nombre.value.trim();
    if (!nombre || !viajeEnCurso) return;

    try {
      const r = await fetch(`/api/viajes/${viajeEnCurso}/nombre`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
        body: JSON.stringify({ nombre }),
      });
      const datos = await r.json();
      if (!r.ok) throw new Error(datos.error || `Error ${r.status}`);

      // Se pinta aquí en vez de recargar: es un solo texto y se nota más rápido.
      const billete = document.querySelector(`.billete[data-viaje="${viajeEnCurso}"]`);
      if (billete) {
        billete.querySelector('.billete__nombre').textContent = datos.nombre;
        billete.dataset.nombre = datos.nombre;
      }
      cerrar(modalNombre);
      viajeEnCurso = null;
    } catch (err) {
      console.error('[portada] no se pudo cambiar el nombre:', err);
      avisar(err.message);
    }
  });

  // --- Borrar --------------------------------------------------------------
  async function abrirBorrar(id) {
    cerrarMenus();
    viajeEnCurso = id;

    // Se pregunta al servidor QUÉ se va a llevar por delante: decir "se borrará
    // el viaje" a secas no informa de nada.
    let arrastre = null;
    try {
      const r = await fetch(`/api/viajes/${id}/arrastre`, { headers: { Accept: 'application/json' } });
      if (r.ok) arrastre = await r.json();
    } catch { /* si falla, se avisa en genérico */ }

    // Ojo con el "sus": con una sola etapa quedaba "sus 1 etapa". Se enumera sin
    // posesivo, que aguanta el singular y el plural igual de bien.
    document.getElementById('borrar-texto').textContent = arrastre
      ? `Se borrará «${arrastre.nombre}» con ${cuenta(arrastre.etapas, 'etapa', 'etapas')}, ` +
        `${cuenta(arrastre.apuntados, 'cosa apuntada', 'cosas apuntadas')} y ` +
        `${cuenta(arrastre.enElLienzo, 'cosa del lienzo', 'cosas del lienzo')}.`
      : 'Se borrará el viaje con todo lo que tenga dentro.';

    modalBorrar.hidden = false;
  }

  const cuenta = (n, uno, varios) => `${n} ${n === 1 ? uno : varios}`;

  document.getElementById('borrar-confirmar').addEventListener('click', async () => {
    if (!viajeEnCurso) return;
    try {
      const r = await fetch(`/api/viajes/${viajeEnCurso}`, {
        method: 'DELETE',
        headers: { Accept: 'application/json' },
      });
      const datos = await r.json();
      if (!r.ok) throw new Error(datos.error || `Error ${r.status}`);

      // Recargar: cambian el contador del panel y la próxima salida, no solo
      // la lista.
      location.reload();
    } catch (err) {
      console.error('[portada] no se pudo borrar:', err);
      cerrar(modalBorrar);
      avisar(err.message);
    }
  });
})();
