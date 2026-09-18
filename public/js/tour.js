/**
 * public/js/tour.js
 * -----------------------------------------------------------------------------
 * EL TOUR DE BIENVENIDA: UNA VEZ, AL ENTRAR, Y SE ACABA.
 *
 * POR QUÉ SE REHIZO. El primero repartía nueve burbujas por las pantallas y cada
 * una soltaba su tramo la primera vez que la pisabas. Sonaba bien y no lo era:
 * te interrumpía cuando ya estabas haciendo algo, y nunca llegabas a ver el
 * CONJUNTO, que es justo lo que no se entiende de esta aplicación al principio.
 * Aquí no hay seis fases que descubrir por sorpresa: hay un orden, y el orden es
 * lo que hay que contar.
 *
 * ASÍ QUE AHORA ES UNA SOLA PARADA, en la primera pantalla, con las seis
 * pantallas en el orden en que se usan y un pantallazo REAL de cada una. Se ve
 * entero en un minuto o se salta en un clic.
 *
 * LOS PANTALLAZOS SON DE VERDAD, hechos con Playwright contra la app corriendo
 * (`public/img/tour/`). Un dibujo idealizado envejece mal y miente: enseña
 * botones que no están. El de documentos sale vacío porque así es como lo vas a
 * encontrar tú el primer día, y su propio texto explica de dónde salen los
 * papeles.
 *
 * EL GUIÓN VIVE AQUÍ y no en el servidor, como el anterior y por lo mismo:
 * cambiar una frase no debería obligar a tocar el backend.
 */

const PASOS = [
  {
    clave: 'bienvenida',
    titulo: 'Esto es un generador de viajes',
    texto:
      'Le dices a dónde quieres ir y cuántos días tienes, y te devuelve un viaje entero: ' +
      'vuelos, hoteles, qué ver cada día y a qué hora. Son seis pantallas y se usan en este orden.',
    imagen: null,
  },
  {
    clave: 'configuracion',
    titulo: '1 · Configuración',
    texto:
      'Aquí empieza todo: a dónde vas, qué días, cuántos sois y qué os interesa. ' +
      'Lo que marques aquí no es decoración — decide qué ciudades entran en la ruta y qué se ve en cada una.',
    imagen: '/img/tour/configuracion.jpg',
  },
  {
    clave: 'destino',
    titulo: '2 · El mapa: a dónde vas',
    texto:
      'Tocas el mapa o escribes, y vale de tres formas. Una CIUDAD: el viaje entero transcurre allí. ' +
      'Un PAÍS: se eligen las ciudades que caben en tus días y se ordenan en una ruta. ' +
      'Y VARIOS PAÍSES: ahí se abre una pantalla aparte para decidir contigo cuáles entran, ' +
      'porque «¿cabe Montenegro?» depende de cuántos días tienes y de cuánta carretera aguantas — ' +
      'y eso no lo decide sola.',
    imagen: '/img/tour/destino.jpg',
  },
  {
    clave: 'ruta',
    titulo: '3 · La ruta',
    texto:
      'El esqueleto del viaje: en qué ciudades duermes y cuántas noches en cada una. ' +
      'Puedes mover noches de una a otra y reordenar las paradas, y todo lo demás se recalcula detrás.',
    imagen: '/img/tour/ruta.jpg',
  },
  {
    clave: 'lienzo',
    titulo: '4 · El lienzo',
    texto:
      'El viaje día a día, con sus horas. Se arrastra de la mochila al día que quieras. ' +
      'Y avisa cuando algo no cuadra: un museo que cierra ese día, dos cosas que se solapan, un sitio al que no da tiempo a llegar.',
    imagen: '/img/tour/lienzo.jpg',
  },
  {
    clave: 'documentos',
    titulo: '5 · Los documentos',
    texto:
      'Las tarjetas de embarque, las reservas del hotel y los bonos de las excursiones, todos juntos. ' +
      'Cada papel se sube donde vive —el billete en su vuelo, la reserva en su hotel— y aquí aparecen reunidos para el día del viaje.',
    imagen: '/img/tour/documentos.jpg',
  },
  {
    clave: 'presupuesto',
    titulo: '6 · El presupuesto',
    texto:
      'Lo que cuesta, separado en dos: los precios REALES de lo que has planificado, y una estimación ' +
      'aparte para comer y moverte. No se mezclan a propósito — y si falta algún precio, te dice que el total está incompleto en vez de disimularlo.',
    imagen: '/img/tour/presupuesto.jpg',
  },
];

(function tourDeBienvenida() {
  const caja = document.getElementById('datos-tour');
  if (!caja) return;

  let estado;
  try {
    estado = JSON.parse(caja.textContent || '{}');
  } catch {
    return;
  }
  if (estado?.visto) return;

  // SOLO EN LA PRIMERA PANTALLA. El tour explica el orden de las seis, así que
  // sale en la portada y en ningún otro sitio: soltarlo encima de alguien que ya
  // está dentro del lienzo es la interrupción que este rediseño viene a quitar.
  if (window.location.pathname !== '/') return;

  let i = 0;

  // LA VERSION DEL ARRANQUE EN CADA IMAGEN. El service worker sirve las imagenes
  // de cache sin revalidar; sin esto, un pantallazo cambiado seguia saliendo con
  // la foto vieja indefinidamente.
  const conVersion = (url) => (estado?.v ? `${url}?v=${estado.v}` : url);

  const dlg = document.createElement('dialog');
  dlg.className = 'tour';
  // `autofocus` va en SEGUIR y no es un detalle: `<dialog>` enfoca solo el primer
  // elemento enfocable, que aquí es «Saltar». Sin esto el anillo de foco señala
  // el botón equivocado y, peor, pulsar Enter nada más abrirse salta el tour.
  dlg.innerHTML = `
    <figure class="tour__marco" id="tour-marco">
      <img class="tour__imagen" id="tour-imagen" alt="" decoding="async">
    </figure>
    <div class="tour__cuerpo">
      <h2 class="tour__titulo" id="tour-titulo"></h2>
      <p class="tour__texto" id="tour-texto"></p>
    </div>
    <footer class="tour__pie">
      <div class="tour__puntos" id="tour-puntos" aria-hidden="true"></div>
      <div class="tour__botones">
        <button type="button" class="tour__saltar" id="tour-saltar">Saltar</button>
        <button type="button" class="tour__seguir" id="tour-seguir" autofocus></button>
      </div>
    </footer>`;
  document.body.appendChild(dlg);

  const $ = (id) => dlg.querySelector('#' + id);
  const puntos = $('tour-puntos');
  PASOS.forEach(() => puntos.appendChild(document.createElement('span')));

  // LAS IMÁGENES, PRECARGADAS EN CUANTO SE ABRE. Son seis JPEG y sin esto se ve
  // el salto al pasar de paso: el hueco vacío y luego la foto. Cargarlas de
  // golpe al abrir cuesta una vez y quita seis parpadeos.
  for (const p of PASOS) {
    if (!p.imagen) continue;
    const pre = new Image();
    pre.src = conVersion(p.imagen);
  }

  function pintar() {
    const p = PASOS[i];
    $('tour-titulo').textContent = p.titulo;
    $('tour-texto').textContent = p.texto;

    const marco = $('tour-marco');
    const img = $('tour-imagen');
    if (p.imagen) {
      img.src = conVersion(p.imagen);
      img.alt = `La pantalla de ${p.titulo.replace(/^\d+\s·\s/, '')}`;
      marco.hidden = false;
    } else {
      marco.hidden = true;
      img.removeAttribute('src');
    }

    [...puntos.children].forEach((x, n) => x.classList.toggle('es-ahora', n === i));
    $('tour-seguir').textContent = i === PASOS.length - 1 ? 'Empezar' : 'Siguiente';
    $('tour-saltar').hidden = i === PASOS.length - 1;
  }

  async function cerrar() {
    dlg.close();
    dlg.remove();
    // Si la llamada falla, el tour vuelve a salir la próxima vez. Molesto, pero
    // es lo honesto: decir «visto» sin haberlo guardado sería mentirle al
    // servidor y perder el único registro que hay.
    try {
      await fetch('/api/tour/visto', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: '{}',
      });
    } catch {
      /* se intentará otro día */
    }
  }

  $('tour-seguir').addEventListener('click', () => {
    if (i === PASOS.length - 1) return cerrar();
    i += 1;
    pintar();
  });
  $('tour-saltar').addEventListener('click', cerrar);

  // Escape cuenta como saltar: `<dialog>` lo cierra solo, y sin esto el tour
  // volvería a salir la próxima vez porque nadie lo habría marcado.
  dlg.addEventListener('cancel', (e) => {
    e.preventDefault();
    cerrar();
  });

  pintar();
  dlg.showModal();

  // EL FOCO SE QUEDA EN «SIGUIENTE», con su anillo y todo.
  //
  // Probé a quitárselo con `blur()` para que no pareciera que había algo
  // seleccionado, y era peor: el foco se iba al `body` y entonces Enter no hacía
  // nada. Un anillo en el botón principal no es ruido, es la señal correcta —dice
  // que Enter avanza— y además es lo que necesita quien navega con teclado.
})();
