/**
 * public/js/app.js
 * -----------------------------------------------------------------------------
 * JavaScript del navegador. Vanilla, sin frameworks. Tres cosas y para:
 *   1. Marcar/desmarcar candidatos sin recargar la pagina.
 *   2. Los chips del paso 4 (tipo de viaje, multiseleccion).
 *   3. El filtro del catalogo (todas / gratis / mejor valoradas).
 *
 * Si el JS fallara, la app sigue siendo navegable: los formularios y los enlaces
 * funcionan por su cuenta. Lo unico que se pierde es el marcado en vivo.
 */

// =============================================================================
// 1. Marcar / desmarcar
// =============================================================================
document.addEventListener('click', async (evento) => {
  const boton = evento.target.closest('[data-marcar]');
  if (!boton) return;

  evento.preventDefault();

  // Pintamos el cambio YA y luego confirmamos con el servidor: se siente
  // instantaneo. Si la peticion falla, lo dejamos como estaba.
  const estabaMarcado = boton.getAttribute('aria-pressed') === 'true';
  boton.setAttribute('aria-pressed', String(!estabaMarcado));
  boton.disabled = true;

  try {
    const respuesta = await fetch(boton.dataset.marcar, { method: 'POST' });
    if (!respuesta.ok) throw new Error(`El servidor respondió ${respuesta.status}`);

    const datos = await respuesta.json();
    boton.setAttribute('aria-pressed', String(datos.marcado));
    boton.setAttribute('aria-label', datos.marcado ? 'Quitar de la selección' : 'Añadir a la selección');

    // Elección única (hoteles): el servidor ya desmarcó los demás, así que
    // apagamos también sus círculos y quitamos el resaltado de su tarjeta.
    if (datos.marcado && boton.dataset.exclusivo) {
      document.querySelectorAll(`[data-exclusivo="${boton.dataset.exclusivo}"]`).forEach((otro) => {
        if (otro === boton) return;
        otro.setAttribute('aria-pressed', 'false');
        otro.setAttribute('aria-label',
          boton.dataset.exclusivo === 'vuelo' ? 'Elegir esta opción de vuelo' : 'Elegir este alojamiento');
        otro.closest('.segmento')?.classList.remove('segmento--elegido');
      });
    }
    boton.closest('.segmento')?.classList.toggle('segmento--elegido', datos.marcado);

    actualizarContador(datos);
    actualizarPanel(datos);
  } catch (err) {
    // Deshacemos el cambio optimista y avisamos.
    boton.setAttribute('aria-pressed', String(estabaMarcado));
    console.error('[marcar] no se pudo guardar:', err);
    alert('No se ha podido guardar la selección. Comprueba que el servidor sigue en marcha.');
  } finally {
    boton.disabled = false;
  }
});

/** Contador de la barra inferior (el que se ve en movil). */
function actualizarContador({ total, costeTotal }) {
  const resumen = document.querySelector('.barra__resumen');
  if (!resumen) return;
  const plural = total === 1 ? '' : 's';
  resumen.innerHTML =
    `<strong>${total}</strong> seleccionado${plural}` + (costeTotal ? ` · ${costeTotal} €` : '');
}

/** Panel lateral de escritorio: lo repintamos entero, que es mas simple. */
function actualizarPanel({ porTipo, total, costeTotal }) {
  const panel = document.getElementById('panel-lateral');
  if (!panel) return;

  const ETIQUETAS = { actividad: 'Actividades', vuelo: 'Vuelos', hotel: 'Hotel', sitio: 'Sitios' };
  let html = '<h3>Tu selección</h3>';

  if (!total) {
    html += '<p class="secundario" style="margin:0">Aún no has marcado nada. Toca el círculo de una tarjeta.</p>';
  } else {
    for (const [tipo, titulos] of Object.entries(porTipo)) {
      if (!titulos.length) continue;
      html += `<div class="lateral__grupo">
                 <div class="lateral__etiqueta">${ETIQUETAS[tipo] || tipo} (${titulos.length})</div>
                 ${titulos.map((t) => `<div class="lateral__item">${escapar(t)}</div>`).join('')}
               </div>`;
    }
    html += `<div class="lateral__total"><span>Total</span><span>${costeTotal} €</span></div>`;
  }
  panel.innerHTML = html;
}

/** Los titulos vienen de la BD: los escapamos antes de meterlos en el HTML. */
function escapar(texto) {
  const d = document.createElement('div');
  d.textContent = texto;
  return d.innerHTML;
}

// =============================================================================
// 2. Chips del paso 4 (multiseleccion)
// =============================================================================
document.addEventListener('click', (evento) => {
  const chip = evento.target.closest('[data-chip]');
  if (!chip) return;

  const pulsado = chip.getAttribute('aria-pressed') === 'true';
  chip.setAttribute('aria-pressed', String(!pulsado));

  // El valor real viaja en un campo oculto del formulario.
  const campo = document.getElementById('tipo_viaje');
  if (!campo) return;
  const marcados = [...document.querySelectorAll('[data-chip][aria-pressed="true"]')]
    .map((c) => c.dataset.chip);
  campo.value = marcados.join(',');
});

// =============================================================================
// 3. Filtro del catalogo
// =============================================================================
document.addEventListener('click', (evento) => {
  const filtro = evento.target.closest('[data-filtro]');
  if (!filtro) return;

  // Solo un filtro activo a la vez.
  document.querySelectorAll('[data-filtro]').forEach((f) => f.classList.remove('chip--activo'));
  filtro.classList.add('chip--activo');

  const modo = filtro.dataset.filtro;
  document.querySelectorAll('#rejilla-actividades > [data-precio]').forEach((celda) => {
    const precio = Number(celda.dataset.precio);
    const valoracion = Number(celda.dataset.valoracion);

    let visible = true;
    if (modo === 'gratis') visible = precio === 0;
    if (modo === 'top') visible = valoracion >= 9;

    celda.classList.toggle('oculto', !visible);
  });
});

// =============================================================================
// 4. Sondeo del estado "buscando" (actividades y hoteles)
// -----------------------------------------------------------------------------
// Mientras el worker scrapea, la pantalla pregunta cada 5 s si ya ha terminado.
// Cuando el estado deja de ser "buscando", recarga y se pinta el resultado (o
// el error). Sin websockets: un fetch y a correr.
//
// Sirve para cualquier pantalla que espere: basta con que su caja tenga un id
// de los de la lista y un data-estado-url al que preguntar.
// =============================================================================
(() => {
  // ESTA PANTALLA, ¿LLEVA SU PROPIO SONDEO? Entonces aquí no se toca nada.
  //
  // La de etapa lo lleva: mira a la vez la preparación de la ciudad, los
  // hoteles, los vuelos de cada tramo, el transporte, los traslados y la
  // búsqueda de restaurantes, y contesta en un solo JSON con `trabajando`.
  //
  // Este de aquí es más viejo y espera otra cosa: un `estado` en la raíz de la
  // respuesta. Como en la etapa ese campo no existe, `datos.estado !== 'buscando'`
  // daba SIEMPRE verdadero y recargaba la pantalla entera CADA CINCO SEGUNDOS
  // mientras hubiera una búsqueda en marcha. Eso es lo que hacía saltar la
  // pestaña a "Qué ver" una y otra vez: cada recarga vuelve a pintar la primera
  // pestaña antes de que el JS reponga la que estabas mirando.
  //
  // Dos sondeos sobre la misma pantalla no tienen arreglo bueno. El que manda
  // es el que la pantalla declara suyo.
  if (document.querySelector('[data-trabajando]')) return;

  const caja =
    document.getElementById('buscando-actividades') ||
    document.getElementById('buscando-hoteles') ||
    document.getElementById('buscando-vuelos') ||
    document.getElementById('buscando-avisos') ||
    document.getElementById('buscando-descubrir');
  if (!caja) return; // esta pantalla no está esperando nada

  const url = caja.dataset.estadoUrl;
  const pista = document.getElementById('buscando-pista');
  // Cinco segundos van bien para un scraper que tarda medio minuto, pero se
  // hacen eternos para los avisos, que son tres peticiones y acaban en tres
  // segundos. Cada pantalla puede pedir su ritmo con data-intervalo.
  const INTERVALO = Number(caja.dataset.intervalo) || 5000;
  const arranque = Date.now();

  const segundos = () => Math.round((Date.now() - arranque) / 1000);

  async function comprobar() {
    try {
      const respuesta = await fetch(url, { headers: { Accept: 'application/json' } });
      if (!respuesta.ok) throw new Error(`El servidor respondió ${respuesta.status}`);

      const datos = await respuesta.json();

      if (datos.estado !== 'buscando') {
        // Ya hay algo que enseñar (actividades o el error): recargamos.
        if (pista) pista.textContent = 'Listo, cargando…';
        location.reload();
        return;
      }

      if (pista) pista.textContent = `Buscando desde hace ${segundos()} s…`;
    } catch (err) {
      // Si el servidor no responde no montamos un drama: se reintenta solo.
      console.error('[buscando] no se pudo consultar el estado:', err);
      if (pista) pista.textContent = 'Sin respuesta del servidor; reintentando…';
    }
    setTimeout(comprobar, INTERVALO);
  }

  setTimeout(comprobar, INTERVALO);
})();

// =============================================================================
// 5. Pantalla 1 "Configura tu viaje": steppers, edades, ritmo y plegado
// -----------------------------------------------------------------------------
// Todo son botones: no se escribe ningún número a mano. Los valores reales
// viajan en campos ocultos que se van sincronizando.
// =============================================================================
(() => {
  const formulario = document.getElementById('form-configuracion');
  if (!formulario) return; // no estamos en esa pantalla

  // --- Steppers (adultos / niños) -----------------------------------------
  const CAMPOS = { adultos: 'campo-adultos', ninos: 'campo-ninos' };

  formulario.addEventListener('click', (evento) => {
    const boton = evento.target.closest('.stepper__boton');
    if (!boton) return;

    const stepper = boton.closest('[data-stepper]');
    const nombre = stepper.dataset.stepper;
    const min = Number(stepper.dataset.min);
    const max = Number(stepper.dataset.max);
    const campo = document.getElementById(CAMPOS[nombre]);

    const nuevo = Math.min(Math.max(Number(campo.value) + Number(boton.dataset.delta), min), max);
    campo.value = String(nuevo);
    stepper.querySelector('[data-valor]').textContent = String(nuevo);

    // Los botones al tope se deshabilitan: mejor que dejar pulsar sin efecto.
    stepper.querySelectorAll('.stepper__boton').forEach((b) => {
      const destino = nuevo + Number(b.dataset.delta);
      b.disabled = destino < min || destino > max;
    });

    if (nombre === 'ninos') sincronizarEdades(nuevo);
  });

  /**
   * Añade o quita selectores de edad para que haya exactamente uno por niño.
   * Al bajar, quita SIEMPRE el último, para no perder las edades ya elegidas.
   */
  function sincronizarEdades(cuantos) {
    const caja = document.getElementById('edades-ninos');
    const lista = document.getElementById('edades-lista');
    if (!caja || !lista) return;

    while (lista.children.length > cuantos) lista.lastElementChild.remove();

    while (lista.children.length < cuantos) {
      const i = lista.children.length;
      const etiqueta = document.createElement('label');
      etiqueta.className = 'edad';
      const opciones = Array.from({ length: 18 }, (_, e) => `<option value="${e}">${e}</option>`).join('');
      etiqueta.innerHTML =
        `<span class="edad__num">Niño ${i + 1}</span>` +
        `<select name="edades_ninos">${opciones}</select>`;
      lista.appendChild(etiqueta);
    }

    caja.classList.toggle('oculto', cuantos === 0);
  }

  // Estado inicial de los botones al cargar (por si ya viene a tope).
  formulario.querySelectorAll('[data-stepper]').forEach((stepper) => {
    const campo = document.getElementById(CAMPOS[stepper.dataset.stepper]);
    const valor = Number(campo.value);
    stepper.querySelectorAll('.stepper__boton').forEach((b) => {
      const destino = valor + Number(b.dataset.delta);
      b.disabled = destino < Number(stepper.dataset.min) || destino > Number(stepper.dataset.max);
    });
  });

  // --- Ritmo: píldoras exclusivas (solo una) ------------------------------
  formulario.addEventListener('click', (evento) => {
    const pildora = evento.target.closest('[data-ritmo]');
    if (!pildora) return;
    formulario.querySelectorAll('[data-ritmo]').forEach((p) => p.setAttribute('aria-pressed', 'false'));
    pildora.setAttribute('aria-pressed', 'true');
    document.getElementById('campo-ritmo').value = pildora.dataset.ritmo;
  });

  // (El plegado "Más opciones" lo lleva el manejador genérico de abajo.)

  // --- "7 noches" calculado en vivo ---------------------------------------
  const desde = document.getElementById('fecha_inicio');
  const hasta = document.getElementById('fecha_fin');
  const nota = document.getElementById('noches-nota');

  function pintarNoches() {
    if (!desde.value || !hasta.value) { nota.textContent = ''; return; }
    const d1 = new Date(`${desde.value}T12:00:00`);
    const d2 = new Date(`${hasta.value}T12:00:00`);
    const noches = Math.round((d2 - d1) / 86400000);
    nota.textContent =
      noches > 0 ? `${noches} ${noches === 1 ? 'noche' : 'noches'}`
      : noches === 0 ? 'La vuelta es el mismo día: hace falta al menos una noche.'
      : 'La vuelta es anterior a la ida.';
  }

  desde.addEventListener('change', pintarNoches);
  hasta.addEventListener('change', pintarNoches);
  pintarNoches();
})();


// =============================================================================
// 6. Paneles de filtros (hoteles y vuelos)
// -----------------------------------------------------------------------------
// Los chips son botones y sus valores viajan en campos ocultos del formulario.
// Nada se aplica hasta enviarlo, salvo los filtros LOCALES (ver el bloque 8):
// esos se notan al momento porque no hace falta volver a buscar nada.
//
// POR QUÉ ESTO ES GENÉRICO Y VA DELEGADO EN document
// Antes había un bloque por pantalla, cada uno atado a un id fijo
// (form-filtros-hotel, campo-nota, campo-escalas...). Eso valía mientras hubiera
// UN panel por página. Ya no: la etapa tiene un panel de vuelos por CADA TRAMO
// —la ida y la vuelta llevan filtros distintos— y con ids globales el segundo
// panel escribía en los campos del primero.
//
// Así que ahora no hay ni un id: cada chip dice a qué CAMPO pertenece y el
// manejador lo busca por `name` DENTRO de su propio formulario. Pueden convivir
// los que hagan falta sin pisarse.
//
//   data-grupo="escalas"  -> grupo exclusivo: solo un chip encendido
//   data-booleano="wifi"  -> interruptor de sí/no
// =============================================================================
(() => {
  /** El campo oculto que le toca a este chip, dentro de SU formulario. */
  const campoDe = (formulario, nombre) => formulario.elements[nombre] ?? null;

  document.addEventListener('click', (evento) => {
    const chip = evento.target.closest('[data-grupo], [data-booleano]');
    if (!chip) return;

    const formulario = chip.closest('form[data-filtros]');
    if (!formulario) return;

    // --- Grupo exclusivo: se apaga el resto del grupo en ESTE formulario ---
    if (chip.dataset.grupo) {
      const grupo = chip.dataset.grupo;
      formulario
        .querySelectorAll(`[data-grupo="${grupo}"]`)
        .forEach((c) => c.setAttribute('aria-pressed', 'false'));
      chip.setAttribute('aria-pressed', 'true');

      const campo = campoDe(formulario, grupo);
      if (campo) campo.value = chip.dataset.valor ?? '';
      return;
    }

    // --- Interruptor de sí/no ---------------------------------------------
    const nombre = chip.dataset.booleano;
    const activo = chip.getAttribute('aria-pressed') === 'true';
    chip.setAttribute('aria-pressed', String(!activo));
    const campo = campoDe(formulario, nombre);
    if (campo) campo.value = !activo ? '1' : '0';
  });
})();

// =============================================================================
// 7. Plegables (genérico)
// -----------------------------------------------------------------------------
// Cualquier .plegable__disparador con aria-controls abre y cierra su panel.
// Está delegado en document a propósito: al principio esto vivía dentro del
// bloque de la pantalla 1 y, al reutilizar el plegable en los filtros de
// hoteles, el botón no hacía nada porque aquel manejador no llegaba a existir.
// =============================================================================
document.addEventListener('click', (evento) => {
  const disparador = evento.target.closest('.plegable__disparador');
  if (!disparador) return;

  const panel = document.getElementById(disparador.getAttribute('aria-controls'));
  if (!panel) return;

  const abierto = disparador.getAttribute('aria-expanded') === 'true';
  disparador.setAttribute('aria-expanded', String(!abierto));
  panel.classList.toggle('oculto', abierto);
});

// =============================================================================
// 8. Filtros LOCALES: los que se notan sin volver a buscar
// -----------------------------------------------------------------------------
// Hay dos clases de filtro y la diferencia se ve en el panel:
//
//  - Los que aplica el proveedor (escalas, duración, nota, comodidades) viajan
//    en la URL de la búsqueda. Cambiarlos obliga a buscar otra vez, así que
//    solo cambian su campo oculto y esperan al botón.
//
//  - Los LOCALES (franja horaria de salida, precio por persona, distancia al
//    centro) los aplicamos nosotros sobre las tarjetas ya pintadas. Cambiarlos
//    se nota al instante y de paso se guarda la preferencia, sin encolar nada.
//
// Este bloque solo hace algo si hay resultados en pantalla: en un panel que
// todavía no ha buscado nada, los mismos chips viajan con el formulario.
// =============================================================================
(() => {
  /** "7:20 – 8:30" -> 7 (la hora de SALIDA, que es la primera). */
  const horaDe = (texto) => {
    const m = /(\d{1,2}):(\d{2})/.exec(String(texto || ''));
    return m ? Number(m[1]) : null;
  };

  const FRANJAS = { manana: [0, 12], tarde: [12, 19], noche: [19, 24] };

  /** Sin franja pedida o sin hora conocida, no se descarta. */
  const encaja = (hora, franja) => {
    if (!franja || hora == null) return true;
    const [desde, hasta] = FRANJAS[franja];
    return hora >= desde && hora < hasta;
  };

  /** "a 1,2 km del centro" -> 1.2 · "a 500 m del centro" -> 0.5 */
  const kmDelCentro = (texto) => {
    const m = /([\d.,]+)\s*(km|m)\b/i.exec(texto || '');
    if (!m) return null;
    const valor = Number(m[1].replace(/\./g, '').replace(',', '.'));
    if (!Number.isFinite(valor)) return null;
    return m[2].toLowerCase() === 'm' ? valor / 1000 : valor;
  };

  /** Guarda una preferencia local sin encolar ninguna búsqueda. */
  async function guardar(url, datos) {
    if (!url) return;
    try {
      await fetch(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        body: new URLSearchParams(datos).toString(),
      });
    } catch (err) {
      console.error('[filtros] no se pudo guardar la preferencia:', err);
    }
  }

  // --- VUELOS: franjas horarias y precio por persona -----------------------
  function aplicarVuelos(formulario) {
    const valor = (n) => formulario.elements[n]?.value || null;
    const ida = valor('salidaIda');
    const vuelta = valor('salidaVuelta');
    const tope = Number(valor('precioMaxPersona')) || null;
    const pax = Number(formulario.dataset.pax) || 1;

    let ocultos = 0;
    const tarjetas = document.querySelectorAll('.segmento--vuelo');
    tarjetas.forEach((tarjeta) => {
      const horas = [...tarjeta.querySelectorAll('.tramo__horas')].map((e) => horaDe(e.textContent));
      const precioTxt = tarjeta.querySelector('.segmento__precio')?.textContent ?? '';
      const mp = /(\d[\d.]*)/.exec(precioTxt.replace(/\./g, ''));
      const precio = mp ? Number(mp[1]) : null;

      let fuera = !encaja(horas[0], ida) || !encaja(horas[1], vuelta);
      if (!fuera && tope && precio != null && precio / pax > tope) fuera = true;

      tarjeta.classList.toggle('oculto', fuera);
      if (fuera) ocultos++;
    });

    // Si los filtros locales lo esconden todo, se avisa ahí mismo.
    const aviso = document.getElementById('aviso-sin-resultados-locales');
    if (aviso) aviso.classList.toggle('oculto', !(tarjetas.length > 0 && ocultos === tarjetas.length));
    return ocultos;
  }

  document.addEventListener('click', (evento) => {
    const chip = evento.target.closest('[data-local]');
    if (!chip) return;
    const formulario = chip.closest('form[data-filtros="vuelo"]');
    if (!formulario) return;

    // El campo oculto ya lo ha puesto el bloque 6; aquí solo se aplica y guarda.
    aplicarVuelos(formulario);
    guardar(formulario.dataset.urlLocal, { [chip.dataset.local]: chip.dataset.valor });
  });

  document.addEventListener('input', (evento) => {
    const campo = evento.target.closest('[data-local-precio]');
    if (!campo) return;
    const formulario = campo.closest('form[data-filtros="vuelo"]');
    if (!formulario) return;

    aplicarVuelos(formulario);
    clearTimeout(campo._espera);
    campo._espera = setTimeout(
      () => guardar(formulario.dataset.urlLocal, { precioMaxPersona: campo.value }),
      600
    );
  });

  // --- HOTELES: distancia al centro ----------------------------------------
  document.addEventListener('click', async (evento) => {
    const chip = evento.target.closest('[data-distancia]');
    if (!chip) return;
    const grupo = chip.closest('#chips-distancia');
    if (!grupo) return;

    const maxKm = chip.dataset.distancia ? Number(chip.dataset.distancia) : null;

    document.querySelectorAll('.segmento').forEach((tarjeta) => {
      const texto = tarjeta.querySelector('.segmento__centro')?.innerText ?? '';
      const km = kmDelCentro(texto);
      // Sin dato de distancia NO se esconde: mejor enseñar de más.
      tarjeta.classList.toggle('oculto', maxKm != null && km != null && km > maxKm);
    });

    guardar(grupo.dataset.url, { distanciaMax: maxKm ?? '' });
  });
})();
