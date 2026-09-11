/**
 * providers/vueling.js
 * -----------------------------------------------------------------------------
 * Proveedor "Vueling". Contrato comun a todos los proveedores del proyecto:
 *
 *   buscarVuelos({ origen, destino, fechaIda, fechaVuelta })
 *     -> Promise<Array<{
 *          aerolinea, horaSalida, horaLlegada, duracion,
 *          escalas, precio, moneda,
 *          // extras propios de vuelos, no rompen el contrato:
 *          tramo, origen, destino, numeroVuelo, fecha
 *        }>>
 *
 * TODA la logica especifica de Vueling (URLs, selectores, esperas) vive AQUI.
 * El dia de manana /providers/booking.js expondra la misma forma de entrada y
 * salida, para que la app pueda llamarlos de forma intercambiable.
 *
 * =============================================================================
 * LA RECETA (flujo real observado navegando a mano el 05/09/2026)
 * =============================================================================
 *  1. Ir a https://www.vueling.com/es
 *  2. Banner de cookies (OneTrust) -> rechazar las no esenciales, si aparece
 *  3. Campo "De": #originInput -> escribir el codigo IATA -> elegir en el desplegable
 *  4. Campo "A": #destinationInput -> idem
 *     (ojo: al elegir el origen, Vueling abre solo el desplegable de destino)
 *  5. Fechas: #outboundDate abre un calendario de 2 meses.
 *     Cada dia es un <button> cuyo id TERMINA en  -day-<dia>-<mes0>-<anio>
 *     donde <mes0> es el mes en base 0 (0=enero ... 8=septiembre).
 *     Se elige primero el dia de ida y despues el de vuelta.
 *  6. Boton "BUSCAR" -> ABRE UNA PESTANA NUEVA con la pagina de resultados
 *     en https://tickets.vueling.com/booking/selectFlight
 *     (la pestana original se marcha a un enlace de afiliado de Booking.com)
 *  7. Resultados: dos bloques con titulos <h2> "Ida: ..." y "Vuelta: ...".
 *     Dentro de cada bloque, cada vuelo es un .vy-flight-selector con:
 *       - .vy-flight-journey_hour            -> [hora salida, hora llegada]
 *       - .vy-flight-journey_connector_link  -> "Directo" / "1 escala"
 *       - texto VYxxxx                       -> numero de vuelo
 *       - boton de precio "SELECCIONAR VUELO POR 138 EUR / 138 EUR"
 *     La duracion NO se muestra: la calculamos a partir de las horas.
 * =============================================================================
 */

import path from 'node:path';
import fs from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import {
  abrirNavegador,
  cerrarNavegador,
  comprobarCaptcha,
  dormir,
  pausaHumana,
  TIMEOUT_LARGO,
} from '../lib/browser.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

const URL_INICIO = 'https://www.vueling.com/es';

/** Error que lleva dentro el nombre del paso de la receta que ha fallado. */
class ErrorReceta extends Error {
  constructor(paso, causa) {
    super(
      `[vueling] Fallo el paso "${paso}". ` +
        'Probablemente el selector ha cambiado: revisa la receta en providers/vueling.js.\n' +
        `  Detalle: ${causa?.message ?? causa}`
    );
    this.name = 'ErrorReceta';
    this.paso = paso;
    this.causa = causa;
  }
}

/** Ejecuta un paso de la receta y, si falla, lo envuelve con un mensaje claro. */
async function paso(nombre, fn) {
  console.log(`  . ${nombre}...`);
  try {
    return await fn();
  } catch (err) {
    throw new ErrorReceta(nombre, err);
  }
}

/** Normaliza 'YYYY-MM-DD' o Date -> { dia, mes0, anio, iso } */
function normalizarFecha(valor, nombreCampo) {
  const d = valor instanceof Date ? valor : new Date(`${valor}T12:00:00`);
  if (Number.isNaN(d.getTime())) {
    throw new Error(`${nombreCampo} no es una fecha valida: ${valor}`);
  }
  const dosDigitos = (n) => String(n).padStart(2, '0');
  return {
    dia: d.getDate(),
    mes0: d.getMonth(), // base 0, que es justo lo que usa el id del calendario
    anio: d.getFullYear(),
    iso: `${d.getFullYear()}-${dosDigitos(d.getMonth() + 1)}-${dosDigitos(d.getDate())}`,
    // Formato tal cual lo pinta Vueling en los inputs, para poder verificarlo.
    es: `${dosDigitos(d.getDate())}/${dosDigitos(d.getMonth() + 1)}/${d.getFullYear()}`,
  };
}

/** Guarda una captura para poder ver que habia en pantalla cuando algo fallo. */
async function capturaDeFallo(pagina, etiqueta) {
  try {
    const dir = path.join(__dirname, '..', 'capturas');
    await fs.mkdir(dir, { recursive: true });
    const ruta = path.join(dir, `fallo-${etiqueta}-${Date.now()}.png`);
    await pagina.screenshot({ path: ruta, fullPage: true });
    console.error(`  [i] Captura del fallo guardada en: ${ruta}`);
  } catch {
    /* si ni siquiera podemos capturar, seguimos adelante */
  }
}

/**
 * PASO 2 de la receta: banner de cookies.
 *
 * Vueling usa OneTrust. El banner ofrece tres botones:
 *   "QUIERO CONFIGURARLAS" | "PREFIERO RECHAZARLAS" | "OK, LAS ACEPTO"
 * Elegimos siempre la opcion mas respetuosa con la privacidad: rechazarlas.
 *
 * Mientras el banner esta abierto, OneTrust pone una capa oscura
 * (.onetrust-pc-dark-filter) que INTERCEPTA TODOS LOS CLICS. Por eso no basta
 * con ignorarlo: hay que cerrarlo antes de tocar el buscador.
 *
 * Si el banner no aparece -porque el perfil persistente ya guardo tu decision
 * en una ejecucion anterior- no pasa nada: seguimos adelante.
 */
async function gestionarCookies(pagina) {
  // Varias formas de encontrar el boton de rechazo, de la mas concreta a la mas
  // general. La ultima busca por TEXTO VISIBLE, que aguanta mejor los rediseños.
  const candidatos = [
    pagina.locator('#onetrust-reject-all-handler'),
    pagina.locator('.ot-pc-refuse-all-handler'),
    pagina.locator('#onetrust-consent-sdk button').filter({ hasText: /rechaz/i }),
  ];

  // Damos hasta 10s a que el banner aparezca (se pinta despues de la portada).
  const limite = Date.now() + 10_000;
  while (Date.now() < limite) {
    for (const candidato of candidatos) {
      const boton = candidato.first();
      // isVisible() sin timeout responde al instante: no bloquea si no existe.
      if (await boton.isVisible().catch(() => false)) {
        await boton.click();
        // Esperamos a que se vaya la capa oscura antes de seguir.
        await pagina
          .locator('.onetrust-pc-dark-filter')
          .waitFor({ state: 'hidden', timeout: 10_000 })
          .catch(() => {});
        await pausaHumana();
        console.log('    (banner de cookies: rechazadas las no esenciales)');
        return true;
      }
    }
    await dormir(400);
  }

  console.log('    (no hay banner de cookies; el perfil ya guardaba la decision)');
  return false;
}

/**
 * PASOS 3 y 4: rellenar un campo de aeropuerto (origen o destino).
 *
 * El input es un autocompletado: escribiendo el codigo IATA ("BCN", "OVD") el
 * desplegable filtra hasta dejar una unica opcion. Escribimos tecla a tecla con
 * un pequeno retardo porque el componente Angular reacciona a eventos de teclado.
 */
async function rellenarAeropuerto(pagina, selectorInput, codigoIATA) {
  const input = pagina.locator(selectorInput);
  await input.click();
  await pausaHumana(300, 700);

  await input.fill(''); // limpia lo que hubiera de una busqueda anterior
  await input.pressSequentially(codigoIATA, { delay: 90 }); // "tecleo humano"

  // El desplegable de aeropuertos vive en este contenedor.
  const lista = pagina.locator('.vy-station-selector_box-list');
  await lista.waitFor({ state: 'visible', timeout: TIMEOUT_LARGO });

  const opciones = lista.locator('button');

  // Elegimos por TEXTO VISIBLE, nunca por posicion.
  // Cada fila es "Barcelona, Espana" + "BCN", con el codigo SIEMPRE al final;
  // por eso anclamos la expresion al final del texto de la fila.
  // (Ojo: no vale getByRole con \bBCN\b, porque el nombre accesible sale
  //  concatenado sin espacio -> "Barcelona,EspanaBCN" y no hay limite de palabra.)
  const opcion = opciones.filter({ hasText: new RegExp(`${codigoIATA}\\s*$`, 'i') }).first();

  // IMPORTANTE: hay que ESPERAR de forma reintentante, no mirar una sola vez.
  // El desplegable se abre primero con la lista COMPLETA de aeropuertos y solo
  // unos milisegundos despues aplica el filtro de lo que hemos tecleado. Si
  // comprobamos en ese hueco, veriamos "A Coruna, Agadir, Alicante..." y
  // concluiriamos por error que nuestro aeropuerto no existe.
  try {
    await opcion.waitFor({ state: 'visible', timeout: TIMEOUT_LARGO });
  } catch {
    const vistas = await opciones.allTextContents();
    throw new Error(
      `El desplegable no ofrecio ningun aeropuerto acabado en "${codigoIATA}". ` +
        `Opciones que si aparecieron: ${JSON.stringify(vistas.slice(0, 8))}`
    );
  }

  await opcion.click();
  await pausaHumana();
}

/**
 * PASO 5: elegir un dia en el calendario.
 *
 * Los ids de los dias son estables en su SUFIJO:
 *   vy-date-picker-<uuid aleatorio>-day-<dia>-<mes0>-<anio>
 * Por eso usamos un selector "termina en" ($=), que ignora el uuid.
 *
 * Ojo: el calendario pinta tambien los dias de relleno del mes vecino, ocultos.
 * Filtramos por visibilidad para no clicar uno de esos.
 */
async function elegirDia(pagina, { dia, mes0, anio }, etiqueta) {
  const selectorDia = `button[id$="-day-${dia}-${mes0}-${anio}"]`;

  // El calendario muestra 2 meses. Si la fecha cae mas adelante, avanzamos.
  for (let intento = 0; intento < 12; intento++) {
    const celda = pagina.locator(selectorDia).locator('visible=true').first();
    if (await celda.count()) {
      await celda.click();
      await pausaHumana();
      return;
    }
    const siguiente = pagina.getByRole('button', { name: /MES SIGUIENTE/i }).first();
    if (!(await siguiente.isVisible().catch(() => false))) break;
    await siguiente.click();
    await pausaHumana(400, 900);
  }

  throw new Error(
    `No encuentro el dia ${dia}/${mes0 + 1}/${anio} (${etiqueta}) en el calendario. ` +
      `Selector usado: ${selectorDia}`
  );
}

/**
 * PASO 7: leer las tarjetas de vuelo de la pagina de resultados.
 * Esta funcion se ejecuta DENTRO del navegador (page.evaluate), asi que no
 * puede usar nada del ambito de Node.
 */
function extraerVuelosDelDOM() {
  const resultados = [];

  // Cada bloque de resultados va precedido de un <h2> "Ida: ..." o "Vuelta: ...".
  document.querySelectorAll('h2').forEach((titulo) => {
    const m = /^(Ida|Vuelta)\s*:/i.exec(titulo.textContent.trim());
    if (!m) return;

    // Subimos por el DOM hasta el contenedor que realmente tiene las tarjetas.
    let contenedor = titulo;
    for (let i = 0; i < 6 && contenedor; i++) {
      if (contenedor.querySelectorAll('.vy-flight-selector').length) break;
      contenedor = contenedor.parentElement;
    }
    if (!contenedor) return;

    contenedor.querySelectorAll('.vy-flight-selector').forEach((tarjeta) => {
      const texto = tarjeta.innerText.replace(/\s+/g, ' ').trim();

      // Horas: el primer .vy-flight-journey_hour es la salida, el segundo la llegada.
      const horas = [...tarjeta.querySelectorAll('.vy-flight-journey_hour')].map((h) =>
        h.textContent.trim()
      );

      // Conector central: "Directo" o "1 escala".
      const conector =
        tarjeta.querySelector('.vy-flight-journey_connector_link')?.textContent.trim() ?? '';

      // Precio: el boton de compra lleva el importe en su texto accesible.
      const botonPrecio = [...tarjeta.querySelectorAll('button')].find((b) =>
        /(\d[\d.,]*)\s*(EUR|€)/.test(b.innerText)
      );
      const crudoPrecio = botonPrecio ? botonPrecio.innerText.replace(/\s+/g, ' ') : '';
      const mp = /(\d[\d.,]*)\s*(EUR|€)/.exec(crudoPrecio);

      resultados.push({
        tramo: m[1].toLowerCase(), // "ida" | "vuelta"
        horaSalida: horas[0] ?? null,
        horaLlegada: horas[1] ?? null,
        textoEscalas: conector,
        numeroVuelo: (texto.match(/\b([A-Z]{2}\d{3,4})\b/) || [])[1] ?? null,
        precioTexto: mp ? mp[1] : null,
        monedaTexto: mp ? mp[2] : null,
      });
    });
  });

  return resultados;
}

/** "07:10" + "08:45" -> "1h 35m" (un cruce de medianoche se cuenta como +1 dia). */
function calcularDuracion(salida, llegada) {
  if (!salida || !llegada) return null;
  const [hs, ms] = salida.split(':').map(Number);
  const [hl, ml] = llegada.split(':').map(Number);
  let minutos = hl * 60 + ml - (hs * 60 + ms);
  if (minutos < 0) minutos += 24 * 60;
  return `${Math.floor(minutos / 60)}h ${String(minutos % 60).padStart(2, '0')}m`;
}

/** "Directo" -> 0 . "1 escala" -> 1 . "2 escalas" -> 2 */
function calcularEscalas(texto) {
  if (!texto) return null;
  if (/directo/i.test(texto)) return 0;
  const m = /(\d+)\s*escala/i.exec(texto);
  return m ? Number(m[1]) : null;
}

/**
 * =============================================================================
 * FUNCION PUBLICA DEL PROVEEDOR
 * =============================================================================
 * @param {object} opciones
 * @param {string} opciones.origen           Codigo IATA, p.ej. "BCN"
 * @param {string} opciones.destino          Codigo IATA, p.ej. "OVD"
 * @param {string|Date} opciones.fechaIda    "YYYY-MM-DD" o Date
 * @param {string|Date} opciones.fechaVuelta "YYYY-MM-DD" o Date
 */
export async function buscarVuelos({ origen, destino, fechaIda, fechaVuelta }) {
  if (!origen || !destino) throw new Error('[vueling] Faltan origen y/o destino.');

  const ida = normalizarFecha(fechaIda, 'fechaIda');
  const vuelta = normalizarFecha(fechaVuelta, 'fechaVuelta');

  const { contexto, pagina } = await abrirNavegador({ de: 'Vueling' });
  let paginaResultados = null;

  try {
    // ---- PASO 1: portada -------------------------------------------------
    await paso('1. Abrir vueling.com', async () => {
      await pagina.goto(URL_INICIO, { waitUntil: 'domcontentloaded', timeout: TIMEOUT_LARGO });
      // El buscador es Angular y tarda en hidratarse: esperamos al campo real.
      await pagina.locator('#originInput').waitFor({ state: 'visible', timeout: TIMEOUT_LARGO });
    });

    await comprobarCaptcha(pagina, { paso: 'portada' });

    // ---- PASO 2: cookies -------------------------------------------------
    await paso('2. Banner de cookies', () => gestionarCookies(pagina));

    // ---- PASO 3: origen --------------------------------------------------
    await paso(`3. Origen (${origen})`, () =>
      rellenarAeropuerto(pagina, '#originInput', origen)
    );

    // ---- PASO 4: destino -------------------------------------------------
    // Al elegir el origen, Vueling abre solo el desplegable de destino; aun asi
    // hacemos clic explicito para no depender de ese comportamiento.
    await paso(`4. Destino (${destino})`, () =>
      rellenarAeropuerto(pagina, '#destinationInput', destino)
    );

    // ---- PASO 5: fechas --------------------------------------------------
    await paso(`5. Fechas (ida ${ida.iso} / vuelta ${vuelta.iso})`, async () => {
      const calendario = pagina.locator('.datepicker-wrapper');

      // OJO, detalle importante de la receta: al elegir el destino, Vueling
      // ABRE SOLO el calendario en modo "elige fecha de ida". Si en ese momento
      // clicamos #outboundDate lo estariamos CERRANDO (es un toggle), y la web
      // se queda con unas fechas por defecto que no son las nuestras.
      // Por eso: primero miramos si ya esta abierto; solo lo abrimos si no lo esta.
      const yaAbierto = await calendario
        .waitFor({ state: 'visible', timeout: 5_000 })
        .then(() => true)
        .catch(() => false);

      if (!yaAbierto) {
        // #outboundDate es readonly: la unica forma de abrirlo es clicandolo.
        await pagina.locator('#outboundDate').click();
        await calendario.waitFor({ state: 'visible', timeout: TIMEOUT_LARGO });
      }

      // Primero la ida; al elegirla, el calendario pasa solo a modo "vuelta".
      await elegirDia(pagina, ida, 'ida');
      await elegirDia(pagina, vuelta, 'vuelta');

      // Verificacion dura: si las fechas no son las pedidas, mejor fallar aqui
      // que traerse en silencio los precios de otros dias.
      const valorIda = await pagina.locator('#outboundDate').inputValue();
      const valorVuelta = await pagina.locator('#returnDate').inputValue();
      if (valorIda !== ida.es || valorVuelta !== vuelta.es) {
        throw new Error(
          `Las fechas no quedaron como pedimos. ` +
            `Esperado ida=${ida.es} vuelta=${vuelta.es}; ` +
            `la web tiene ida=${valorIda} vuelta=${valorVuelta}.`
        );
      }
      console.log(`    (ida=${valorIda} . vuelta=${valorVuelta})`);
    });

    // ---- PASO 6: buscar (abre pestana nueva) -----------------------------
    paginaResultados = await paso('6. Pulsar BUSCAR', async () => {
      const esperaPestanaNueva = contexto.waitForEvent('page', { timeout: TIMEOUT_LARGO });
      await pagina.getByRole('button', { name: /^buscar$/i }).first().click();

      // Normalmente Vueling abre los resultados en una pestana nueva, pero
      // contemplamos tambien que algun dia navegue en la misma.
      const nueva = await esperaPestanaNueva.catch(() => null);
      const destinoPagina = nueva ?? pagina;
      await destinoPagina.waitForLoadState('domcontentloaded', { timeout: TIMEOUT_LARGO });
      return destinoPagina;
    });

    await comprobarCaptcha(paginaResultados, { paso: 'resultados' });

    // ---- PASO 7: leer resultados -----------------------------------------
    const crudos = await paso('7. Leer la lista de vuelos', async () => {
      await paginaResultados
        .locator('.vy-flight-selector')
        .first()
        .waitFor({ state: 'visible', timeout: TIMEOUT_LARGO });

      // Bajamos hasta el final para forzar el render del bloque de vuelta.
      await paginaResultados.mouse.wheel(0, 4000);
      await pausaHumana(1200, 2000);

      return paginaResultados.evaluate(extraerVuelosDelDOM);
    });

    if (!crudos.length) {
      throw new ErrorReceta(
        '7. Leer la lista de vuelos',
        new Error('La pagina cargo pero no encontre ninguna tarjeta .vy-flight-selector')
      );
    }

    // ---- Normalizacion al contrato comun ---------------------------------
    return crudos.map((v) => ({
      aerolinea: 'Vueling',
      horaSalida: v.horaSalida,
      horaLlegada: v.horaLlegada,
      duracion: calcularDuracion(v.horaSalida, v.horaLlegada),
      escalas: calcularEscalas(v.textoEscalas),
      precio: v.precioTexto ? Number(v.precioTexto.replace(/\./g, '').replace(',', '.')) : null,
      moneda: v.monedaTexto === '€' ? 'EUR' : (v.monedaTexto ?? 'EUR'),
      // extras utiles para el generador de viajes
      tramo: v.tramo,
      origen: v.tramo === 'ida' ? origen : destino,
      destino: v.tramo === 'ida' ? destino : origen,
      numeroVuelo: v.numeroVuelo,
      fecha: v.tramo === 'ida' ? ida.iso : vuelta.iso,
    }));
  } catch (err) {
    await capturaDeFallo(paginaResultados ?? pagina, err.paso ? err.paso.split('.')[0] : 'error');
    throw err;
  } finally {
    await cerrarNavegador(contexto);
  }
}

export default { buscarVuelos };
