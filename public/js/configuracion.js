/**
 * public/js/configuracion.js
 * -----------------------------------------------------------------------------
 * CONFIGURA TU VIAJE: calendario de rango, contadores, chips y barra final.
 *
 * Es la lógica de maqueta-configuracion.html, con tres cosas que una maqueta no
 * tiene que resolver y una pantalla de verdad sí:
 *
 *   · Los valores de partida salen del viaje guardado, no de constantes. Esta
 *     pantalla se abre tanto para dar de alta como para editar.
 *   · Cada control escribe en un campo oculto del formulario. Lo que se manda
 *     son los mismos nombres de siempre —`fecha_inicio`, `adultos`,
 *     `edades_ninos`…—: esto es un cambio de interfaz, no de modelo.
 *   · Los límites del modelo se respetan: de 1 a 9 adultos y de 0 a 6 niños. La
 *     maqueta no ponía tope porque no guardaba nada.
 */
(() => {
  const raiz = document.querySelector('.config');
  if (!raiz) return;

  const inicial = JSON.parse(raiz.dataset.inicial ?? '{}');

  // Los campos que viajan al servidor. La pantalla es nueva; el contrato, el de
  // siempre.
  const campo = {
    inicio: document.getElementById('campo-fecha-inicio'),
    fin: document.getElementById('campo-fecha-fin'),
    adultos: document.getElementById('campo-adultos'),
    ninos: document.getElementById('campo-ninos'),
    edades: document.getElementById('campo-edades'),
    tipo: document.getElementById('campo-tipo'),
    ritmo: document.getElementById('campo-ritmo'),
  };

  // ===========================================================================
  // CALENDARIO DE RANGO
  // ===========================================================================
  const MESES = ['enero', 'febrero', 'marzo', 'abril', 'mayo', 'junio',
    'julio', 'agosto', 'septiembre', 'octubre', 'noviembre', 'diciembre'];
  const DIAS = ['L', 'M', 'X', 'J', 'V', 'S', 'D'];

  /** "2026-10-14" -> Date local. Sin husos: aquí solo importa el día. */
  const deIso = (s) => {
    if (!s) return null;
    const [a, m, d] = s.slice(0, 10).split('-').map(Number);
    return new Date(a, m - 1, d);
  };
  const aIso = (f) =>
    `${f.getFullYear()}-${String(f.getMonth() + 1).padStart(2, '0')}-${String(f.getDate()).padStart(2, '0')}`;

  const claveDia = (d) => d.getFullYear() * 10000 + (d.getMonth() + 1) * 100 + d.getDate();

  const hoy = new Date();
  hoy.setHours(0, 0, 0, 0);

  let ini = deIso(inicial.fechaInicio);
  let fin = deIso(inicial.fechaFin);

  // Se abre por el mes de la ida si ya la hay, y por el actual si no: lo normal
  // al editar es querer ver lo que ya elegiste.
  let base = ini ? new Date(ini.getFullYear(), ini.getMonth(), 1)
                 : new Date(hoy.getFullYear(), hoy.getMonth(), 1);

  const zonaMeses = document.getElementById('meses');
  const btnPrev = document.getElementById('cal-prev');
  const btnNext = document.getElementById('cal-next');

  function pintaMes(f, extra) {
    const y = f.getFullYear();
    const m = f.getMonth();
    const primero = new Date(y, m, 1);
    // La semana empieza en lunes: getDay() da 0 para domingo, así que se rota.
    const desplaza = (primero.getDay() + 6) % 7;
    const nDias = new Date(y, m + 1, 0).getDate();

    let html = `<div class="mes ${extra}"><h3>${MESES[m]} ${y}</h3><div class="semana">`
      + DIAS.map((d) => `<span>${d}</span>`).join('') + '</div><div class="dias">';

    for (let i = 0; i < desplaza; i++) html += '<button type="button" class="relleno"></button>';

    for (let d = 1; d <= nDias; d++) {
      const fecha = new Date(y, m, d);
      const k = claveDia(fecha);
      const pasado = fecha < hoy;
      let cls = [];

      if (ini && fin && k > claveDia(ini) && k < claveDia(fin)) cls.push('en-rango');
      if (ini && k === claveDia(ini)) {
        cls.push('extremo', 'inicio');
        if (fin && claveDia(fin) !== k) cls.push('con-rango');
      }
      if (fin && k === claveDia(fin) && (!ini || claveDia(ini) !== k)) cls.push('extremo', 'fin');
      if (ini && fin && claveDia(ini) === claveDia(fin) && k === claveDia(ini)) {
        cls = ['extremo', 'inicio', 'fin'];
      }

      html += `<button type="button" data-y="${y}" data-m="${m}" data-d="${d}" `
        + `class="${cls.join(' ')}"${pasado ? ' disabled' : ''}>${d}</button>`;
    }

    return html + '</div></div>';
  }

  const fmt = (d) => `${d.getDate()} ${MESES[d.getMonth()].slice(0, 3)} ${d.getFullYear()}`;

  /** Noches entre las dos fechas. Null si el rango no está cerrado. */
  function noches() {
    if (!ini || !fin) return null;
    return Math.round((fin - ini) / 86400000);
  }

  function repinta() {
    const seg = new Date(base.getFullYear(), base.getMonth() + 1, 1);
    zonaMeses.innerHTML = pintaMes(base, 'primero') + pintaMes(seg, 'segundo');

    zonaMeses.querySelectorAll('.dias button[data-d]').forEach((b) => {
      b.onclick = () => {
        const f = new Date(+b.dataset.y, +b.dataset.m, +b.dataset.d);
        // Con el rango ya cerrado, un clic empieza una selección nueva.
        if (!ini || (ini && fin)) { ini = f; fin = null; }
        else if (claveDia(f) < claveDia(ini)) { ini = f; }
        else { fin = f; }
        repinta();
      };
    });

    // Atrás no se puede ir más allá del mes en curso: los días pasados están
    // deshabilitados y un calendario de meses vacíos no lleva a ninguna parte.
    btnPrev.disabled =
      base.getFullYear() === hoy.getFullYear() && base.getMonth() === hoy.getMonth();

    campo.inicio.value = ini ? aIso(ini) : '';
    campo.fin.value = fin ? aIso(fin) : '';

    const rIda = document.getElementById('res-ida');
    const rVta = document.getElementById('res-vuelta');
    const rN = document.getElementById('res-noches');

    rIda.innerHTML = `<b>Ida</b> · ${ini ? fmt(ini) : 'elige un día'}`;
    rVta.innerHTML = `<b>Vuelta</b> · ${fin ? fmt(fin) : 'elige un día'}`;

    const n = noches();
    if (n != null && n > 0) {
      rN.textContent = `${n}${n === 1 ? ' noche' : ' noches'}`;
      rN.classList.remove('vacio');
    } else {
      rN.textContent = n === 0 ? 'mismo día' : 'sin fechas';
      rN.classList.add('vacio');
    }

    pintaBarra();
  }

  btnPrev.onclick = () => { base = new Date(base.getFullYear(), base.getMonth() - 1, 1); repinta(); };
  btnNext.onclick = () => { base = new Date(base.getFullYear(), base.getMonth() + 1, 1); repinta(); };

  // ===========================================================================
  // VIAJEROS
  // ===========================================================================
  // Los topes son los del modelo, no un capricho de la pantalla: el servidor
  // recorta a estos mismos números y enseñar un "+" que no hace nada es peor
  // que apagarlo.
  const MAX_ADULTOS = 9;
  const MIN_ADULTOS = 1;
  const MAX_NINOS = 6;
  const MAX_EDAD = 17;

  let ad = Math.min(Math.max(Number(inicial.adultos) || 2, MIN_ADULTOS), MAX_ADULTOS);
  let ni = Math.min(Math.max(Number(inicial.ninos) || 0, 0), MAX_NINOS);
  let edades = (inicial.edades ?? []).slice(0, ni).map((e) => Number(e) || 0);
  while (edades.length < ni) edades.push(0);

  const resumenViajeros = () => {
    let t = `${ad} adulto${ad !== 1 ? 's' : ''}`;
    if (ni > 0) t += ` y ${ni} niño${ni !== 1 ? 's' : ''}`;
    return t;
  };

  function pintaViajeros() {
    document.getElementById('ad-num').textContent = ad;
    document.getElementById('ni-num').textContent = ni;
    document.getElementById('ad-menos').disabled = ad <= MIN_ADULTOS;
    document.getElementById('ad-mas').disabled = ad >= MAX_ADULTOS;
    document.getElementById('ni-menos').disabled = ni <= 0;
    document.getElementById('ni-mas').disabled = ni >= MAX_NINOS;

    const cont = document.getElementById('edades');
    cont.innerHTML = '';
    edades.forEach((e, i) => {
      const div = document.createElement('div');
      div.className = 'edad';
      const opciones = Array.from(
        { length: MAX_EDAD + 1 },
        (_, a) => `<option value="${a}"${a === e ? ' selected' : ''}>${a}</option>`
      ).join('');
      div.innerHTML = `Niño ${i + 1} <select aria-label="Edad del niño ${i + 1}">${opciones}</select> años`;
      div.querySelector('select').onchange = (ev) => {
        edades[i] = Number(ev.target.value);
        guardaViajeros();
      };
      cont.appendChild(div);
    });

    guardaViajeros();
  }

  /**
   * Los viajeros, a los campos del formulario.
   *
   * Las edades van como campos repetidos con el mismo nombre, que es lo que ya
   * espera el servidor (`comoLista` entiende tanto la lista como el valor
   * suelto). Con cero niños no se manda ninguno y la lista llega vacía.
   */
  function guardaViajeros() {
    campo.adultos.value = ad;
    campo.ninos.value = ni;
    campo.edades.innerHTML = edades
      .map((e) => `<input type="hidden" name="edades_ninos" value="${Number(e) || 0}">`)
      .join('');
    pintaBarra();
  }

  document.getElementById('ad-mas').onclick = () => { if (ad < MAX_ADULTOS) { ad++; pintaViajeros(); } };
  document.getElementById('ad-menos').onclick = () => { if (ad > MIN_ADULTOS) { ad--; pintaViajeros(); } };
  document.getElementById('ni-mas').onclick = () => {
    if (ni >= MAX_NINOS) return;
    ni++;
    edades.push(5);
    pintaViajeros();
  };
  document.getElementById('ni-menos').onclick = () => {
    if (ni <= 0) return;
    ni--;
    edades.pop();
    pintaViajeros();
  };

  // ===========================================================================
  // CHIPS Y SEGMENTOS
  // ===========================================================================
  const chips = [...document.querySelectorAll('#chips-tipo .chip')];
  chips.forEach((c) => {
    c.onclick = () => {
      c.classList.toggle('activo');
      c.setAttribute('aria-pressed', String(c.classList.contains('activo')));
      guardaTipos();
    };
  });

  /** Los tipos van como CSV, que es como se guardan en `viajes.tipo_viaje`. */
  function guardaTipos() {
    campo.tipo.value = chips
      .filter((c) => c.classList.contains('activo'))
      .map((c) => c.dataset.valor)
      .join(',');
  }

  const segmentos = [...document.querySelectorAll('#seg-ritmo button')];
  segmentos.forEach((b) => {
    b.onclick = () => {
      segmentos.forEach((x) => {
        x.classList.remove('activo');
        x.setAttribute('aria-pressed', 'false');
      });
      b.classList.add('activo');
      b.setAttribute('aria-pressed', 'true');
      campo.ritmo.value = b.dataset.valor;
    };
  });

  // ===========================================================================
  // LA BARRA DE ABAJO
  // ===========================================================================
  const resumenFinal = document.getElementById('resumen-final');
  const botonGuardar = document.getElementById('btn-guardar');

  /**
   * El resumen se va componiendo, y el botón dice la verdad.
   *
   * Sin fechas el servidor rechaza el guardado, así que el botón se apaga y el
   * texto de al lado explica qué falta. Enseñar un botón que va a fallar es
   * peor que no enseñarlo.
   */
  function pintaBarra() {
    const n = noches();

    if (ini && fin && n > 0) {
      resumenFinal.innerHTML =
        `<b>${fmt(ini)} → ${fmt(fin)}</b> · ${n} ${n === 1 ? 'noche' : 'noches'} · ${resumenViajeros()}`;
      botonGuardar.disabled = false;
      return;
    }

    if (ini && fin && n === 0) {
      resumenFinal.textContent = 'La vuelta tiene que ser posterior a la ida';
    } else if (ini && !fin) {
      resumenFinal.textContent = 'Falta el día de vuelta';
    } else {
      resumenFinal.textContent = 'Elige las fechas para continuar';
    }
    botonGuardar.disabled = true;
  }

  // ===========================================================================
  // ARRANQUE
  // ===========================================================================
  pintaViajeros();
  guardaTipos();
  repinta();
})();
