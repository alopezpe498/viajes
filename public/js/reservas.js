/**
 * public/js/reservas.js
 * -----------------------------------------------------------------------------
 * El bloque de reserva de una ficha, y la lista de «Mis reservas».
 *
 * DOS COMPORTAMIENTOS, LOS DOS PEQUEÑOS:
 *
 *   1. La casilla «Reservado» abre el cuerpo y se guarda al instante. Los campos
 *      se guardan al SALIR de ellos, no en cada tecla: un localizador se teclea
 *      de un tirón y guardar ocho veces mientras se escribe no aporta nada.
 *   2. En la lista, pulsar un localizador lo copia. Es lo que uno hace con un
 *      código en el móvil, delante del mostrador.
 *
 * Se activa solo si encuentra lo suyo, así que cargarlo en las dos pantallas no
 * estorba.
 */
(() => {
  'use strict';

  const decir = (bloque, texto, malo = false) => {
    const hueco = bloque.querySelector('[data-estado]');
    if (!hueco) return;
    hueco.textContent = texto ?? '';
    hueco.classList.toggle('reserva__estado--malo', Boolean(malo));
    if (texto) setTimeout(() => { hueco.textContent = ''; }, 2500);
  };

  async function guardar(bloque, cambios) {
    const id = bloque.dataset.reserva;
    try {
      const r = await fetch(`/api/candidatos/${id}/reserva`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(cambios),
      });
      if (!r.ok) throw new Error(`El servidor respondió ${r.status}`);
      const datos = await r.json();
      decir(bloque, 'Guardado');
      return datos.reserva;
    } catch (err) {
      decir(bloque, `No se ha podido guardar: ${err.message}`, true);
      return null;
    }
  }

  // ===========================================================================
  // 1) EL BLOQUE DE UNA FICHA
  // ===========================================================================
  document.addEventListener('change', async (e) => {
    const check = e.target.closest('[data-reservado]');
    if (!check) return;

    const bloque = check.closest('[data-reserva]');
    if (!bloque) return;

    const cuerpo = bloque.querySelector('.reserva__cuerpo');
    // Al marcar se abre; al desmarcar se queda abierto si hay algo escrito, que
    // es la forma de dejar claro que no se ha borrado nada.
    if (cuerpo) {
      const hayDatos = [...bloque.querySelectorAll('[data-campo]')].some((c) => c.value.trim());
      cuerpo.hidden = !check.checked && !hayDatos;
    }
    bloque.classList.toggle('reserva--si', check.checked);

    await guardar(bloque, { reservado: check.checked });
  });

  // Los campos, al salir de ellos y solo si han cambiado.
  document.addEventListener(
    'blur',
    async (e) => {
      const campo = e.target.closest('[data-campo]');
      if (!campo) return;

      const bloque = campo.closest('[data-reserva]');
      if (!bloque) return;

      const valor = campo.value.trim();
      if (valor === (campo.dataset.ultimo ?? campo.defaultValue ?? '')) return;
      campo.dataset.ultimo = valor;

      await guardar(bloque, { [campo.dataset.campo]: valor });
    },
    true
  );

  // ===========================================================================
  // 2) COPIAR UN LOCALIZADOR
  // ===========================================================================
  document.addEventListener('click', async (e) => {
    const chip = e.target.closest('[data-copiar]');
    if (!chip) return;

    try {
      await navigator.clipboard.writeText(chip.dataset.copiar);
      const antes = chip.textContent;
      chip.textContent = 'copiado';
      setTimeout(() => { chip.textContent = antes; }, 1200);
    } catch {
      // Sin permiso de portapapeles no pasa nada: el código está a la vista.
    }
  });
})();
