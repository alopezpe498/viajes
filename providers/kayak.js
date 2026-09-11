/**
 * providers/kayak.js
 * -----------------------------------------------------------------------------
 * Proveedor "Kayak" (metabuscador de vuelos). A diferencia de vueling.js, aqui
 * salen TODAS las aerolineas: Volotea, Ryanair, Iberia, Vueling...
 *
 *   buscarVuelosKayak({ origen, destino, fechaIda, fechaVuelta, maxResultados })
 *     -> Promise<Array<{
 *          aerolinea, horaSalida, horaLlegada, duracion, escalas,
 *          aeropuertoOrigen, aeropuertoDestino, precio, moneda, tramo,
 *          // extras
 *          tramos, clase, patrocinado
 *        }>>
 *
 * =============================================================================
 * DECISION IMPORTANTE: tramo = 'combinado'
 * =============================================================================
 * Kayak NO separa ida y vuelta en dos listas. Cada tarjeta de resultado es un
 * PAQUETE de ida y vuelta con UN SOLO PRECIO, y dentro lleva los dos tramos,
 * que ademas pueden ser de aerolineas distintas. Tal cual se ve en pantalla:
 *
 *     9:35 – 11:15   BCN Barcelona-El Prat – OVD Asturias   directo   1h 40m
 *     23:15 – 0:50+1 OVD Asturias – BCN Barcelona-El Prat   directo   1h 35m
 *     Volotea, Vueling                                      107 €
 *
 * Ese "107 €" es por los dos vuelos juntos: no se puede repartir entre ellos.
 * Por eso devolvemos UN objeto por tarjeta (= una opcion reservable), con:
 *   - tramo: 'combinado'
 *   - los campos de primer nivel (horaSalida, duracion, escalas...) referidos
 *     al tramo de IDA, que es lo que uno mira primero
 *   - precio: el del paquete completo
 *   - tramos: [ida, vuelta] con el detalle de cada uno, para no perder nada
 *
 * Si algun dia Kayak devolviera solo ida (busqueda de un tramo), el objeto sale
 * con tramo: 'ida' y un unico elemento en tramos.
 *
 * =============================================================================
 * LA RECETA (flujo real observado navegando a mano el 05/09/2026)
 * =============================================================================
 *  1. URL de resultados ya rellena, sin pasar por el formulario:
 *       https://www.kayak.es/flights/BCN-OVD/2026-09-14/2026-09-17?sort=bestflight_a
 *     Un solo paso: es la misma estrategia que funciono con Booking.
 *  2. Kayak busca "en cientos de webs" y va metiendo resultados poco a poco.
 *     Hay que esperar a que pare de crecer la lista (ver esperarCargaCompleta).
 *  3. Las tarjetas son .nrc6 dentro de .ev1_-results-list.
 *     La primera suele ser un ANUNCIO (.nrc6-mod-sponsored-result): se salta.
 *  4. AVISO SOBRE LOS SELECTORES: Kayak ofusca TODAS las clases (nrc6, hYzH,
 *     p6Cx, Qk4D, vmXl...) y practicamente no usa data-testid en las tarjetas.
 *     Por eso NO leemos campo a campo por clase: leemos el innerText de la
 *     tarjeta y lo parseamos por patrones (horas, codigos IATA, "directo",
 *     duracion, precio). El texto que ve una persona cambia mucho menos que
 *     unos nombres de clase generados en cada compilacion.
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
  scrollHumano,
} from '../lib/browser.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

const BASE = 'https://www.kayak.es/flights';

/** Contenedor de la lista y tarjeta de resultado. */
const SEL_LISTA = '.ev1_-results-list';
const SEL_TARJETA = `${SEL_LISTA} .nrc6`;

/** Kayak es lento a proposito: consulta muchas webs. 45 s de margen. */
const TIMEOUT_BUSQUEDA = 45_000;

/**
 * =============================================================================
 * FILTROS QUE VIAJAN EN LA URL (parametro `fs`)
 * =============================================================================
 * Kayak mete sus filtros en `fs`, con pares clave=valor separados por punto y
 * coma. Probe uno a uno construyendo la URL a mano y mirando si el panel de
 * filtros se quedaba marcado y si los resultados cuadraban. Lo que salio:
 *
 * FUNCIONAN (comprobado el 05/09/2026):
 *
 *   stops=0      Solo directos.
 *                -> BCN-LIS: 50 tarjetas, TODAS "directo", casilla marcada.
 *   stops=0,1    Directos o con una escala. Es una LISTA de indices
 *                (0=directo, 1=una escala, 2=dos o mas), no un maximo.
 *                -> OVD-LIS: casillas "Directo" y "1 escala" marcadas.
 *                OJO: `stops=-1` NO significa "hasta 1". Kayak lo normaliza a
 *                `stops=0,2`, o sea directos Y dos escalas o mas, saltandose
 *                justo la de una escala. Si lo usas te trae lo contrario de lo
 *                que querias, y sin avisar.
 *   legdur=-480  Duracion maxima de trayecto, EN MINUTOS.
 *                -> el slider de "Tiempo de viaje" se quedo en 8h 0m y la
 *                   duracion mas larga de los resultados fue 7h 40m.
 *
 * NO FUNCIONAN (por eso esos filtros los hacemos nosotros):
 *
 *   depart=0600,1200  Ignorado. El rango del panel siguio en 6:30-23:00 y
 *                     seguian saliendo vuelos que despegaban a las 22h.
 *   price=-200        Ignorado. Seguian saliendo paquetes de hasta 220 EUR.
 *                     (Ademas Kayak ni siquiera pinta un filtro de precio en
 *                      el panel de esta busqueda.)
 */
export const FILTROS_KAYAK = {
  escalas: {
    directos: 'stops=0',
    max1: 'stops=0,1',
  },
  // Duracion maxima por trayecto, en horas -> minutos para Kayak.
  duracionMax: { 4: 'legdur=-240', 8: 'legdur=-480', 12: 'legdur=-720' },
};

/**
 * Monta el valor de `fs`. Devuelve null si no hay nada que mandar.
 * Los filtros de horario y de precio NO salen de aqui: son locales.
 */
export function construirFs(filtros = {}) {
  const trozos = [];

  const escalas = FILTROS_KAYAK.escalas[filtros.escalas];
  if (escalas) trozos.push(escalas);

  const duracion = FILTROS_KAYAK.duracionMax[Number(filtros.duracionMax)];
  if (duracion) trozos.push(duracion);

  return trozos.length ? trozos.join(';') : null;
}

/** Error que lleva dentro el nombre del paso de la receta que ha fallado. */
class ErrorReceta extends Error {
  constructor(paso, causa) {
    super(
      `[kayak] Fallo el paso "${paso}". ` +
        'Probablemente el selector ha cambiado: revisa la receta en providers/kayak.js.\n' +
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

/** Valida un codigo IATA de 3 letras y lo devuelve en mayusculas. */
function validarIATA(valor, campo) {
  if (!/^[A-Za-z]{3}$/.test(valor ?? '')) {
    throw new Error(`[kayak] ${campo} debe ser un codigo IATA de 3 letras. Recibido: "${valor}".`);
  }
  return valor.toUpperCase();
}

/** Comprueba que una fecha viene como YYYY-MM-DD y que existe en el calendario. */
function validarFecha(valor, campo) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(valor ?? '')) {
    throw new Error(`[kayak] ${campo} debe tener el formato YYYY-MM-DD. Recibido: "${valor}".`);
  }
  const d = new Date(`${valor}T12:00:00`);
  const dos = (n) => String(n).padStart(2, '0');
  const rehecha = `${d.getFullYear()}-${dos(d.getMonth() + 1)}-${dos(d.getDate())}`;
  if (Number.isNaN(d.getTime()) || rehecha !== valor) {
    throw new Error(`[kayak] ${campo} no es una fecha que exista: "${valor}".`);
  }
  return d;
}

/** Guarda una captura para poder ver que habia en pantalla cuando algo fallo. */
async function capturaDeFallo(pagina, etiqueta) {
  try {
    const dir = path.join(__dirname, '..', 'capturas');
    await fs.mkdir(dir, { recursive: true });
    const ruta = path.join(dir, `fallo-kayak-${etiqueta}-${Date.now()}.png`);
    await pagina.screenshot({ path: ruta, fullPage: false });
    console.error(`  [i] Captura del fallo guardada en: ${ruta}`);
  } catch {
    /* si ni siquiera podemos capturar, seguimos adelante */
  }
}

/**
 * Cierra lo que estorbe: cookies, "registrate", encuestas, alertas de precio.
 * Todo con espera CORTA y tolerante: si no esta, seguimos sin mas.
 *
 * El banner de cookies SI aparecio la primera vez que corrio esto con el perfil
 * limpio de Playwright, y se cerro solo por aqui. Una vez rechazadas, el perfil
 * persistente se acuerda y ya no vuelve a salir.
 */
async function cerrarEstorbos(pagina) {
  const candidatos = [
    // Cookies: preferimos rechazar; si solo hay "aceptar", no lo tocamos.
    { nombre: 'cookies', loc: pagina.locator('#onetrust-reject-all-handler') },
    { nombre: 'cookies', loc: pagina.getByRole('button', { name: /rechazar( todo)?/i }) },
    // Popups varios de Kayak (alerta de precios, encuesta, registro).
    { nombre: 'popup', loc: pagina.locator('button[aria-label="Close"]') },
    { nombre: 'popup', loc: pagina.locator('[role="button"][aria-label="Cerrar"]') },
    { nombre: 'popup', loc: pagina.getByRole('button', { name: /^no, gracias$/i }) },
  ];

  const cerrados = [];
  for (const { nombre, loc } of candidatos) {
    const boton = loc.first();
    if (await boton.isVisible({ timeout: 600 }).catch(() => false)) {
      await boton.click({ timeout: 3000 }).catch(() => {});
      cerrados.push(nombre);
      await pausaHumana(300, 700);
    }
  }
  console.log(cerrados.length ? `    (cerrados: ${[...new Set(cerrados)].join(', ')})` : '    (no habia nada que cerrar)');
  return cerrados;
}

/**
 * Espera a que Kayak termine la busqueda.
 *
 * No nos fiamos de ningun spinner concreto (las clases cambian): esperamos a
 * que aparezca la primera tarjeta y luego a que el numero de tarjetas DEJE DE
 * CRECER durante dos comprobaciones seguidas. Es el unico criterio que no
 * depende de como se llame hoy el elemento de "Cargando".
 */
/**
 * ¿ESTO ES «NO HA CARGADO» O ES «CERO CON ESTOS FILTROS»?
 *
 * No es lo mismo y se parecían mucho: las dos cosas son una página sin tarjetas.
 * Con el filtro de directos, BCN→GDN enseña «0 de 599 vuelos» y un aviso de que
 * no hay nada; el scraper esperaba sus 45 segundos y lo daba por fallo. Eso hacía
 * que una puerta con vuelos perfectamente válidos —con escala— se descartara
 * como si Kayak estuviera caído.
 *
 * SE MIRA LA ESTRUCTURA ANTES QUE EL TEXTO. El texto está en el idioma de la
 * web y cambia con el rediseño de turno; el contador a cero, la lista vacía y el
 * botón de quitar filtros son lo que la página ES. El texto solo confirma.
 *
 * Devuelve `null` si no hay señales claras —que es lo que hay que hacer mientras
 * la búsqueda sigue en marcha— y el motivo si las hay.
 */
async function detectarSinResultados(pagina) {
  return pagina
    .evaluate(() => {
      const texto = document.body?.innerText ?? '';

      // 1) EL CONTADOR A CERO. "0 de 599 vuelos", "0 of 599". Es la señal más
      //    fuerte: dice a la vez que hay vuelos y que ninguno pasa el filtro.
      const contador = texto.match(/\b0\s+(?:de|of)\s+([\d.,]+)\s+\S+/i);

      // 2) EL BOTÓN DE QUITAR FILTROS. Solo aparece cuando hay filtros puestos
      //    que están recortando; es la propia web reconociendo la situación.
      const botones = [...document.querySelectorAll('button, a, [role="button"]')];
      const quitarFiltros = botones.some((b) =>
        /(quitar|borrar|restablecer|eliminar|limpiar)[^.]{0,20}filtro|clear[^.]{0,12}filter|reset[^.]{0,12}filter/i.test(
          b.innerText ?? ''
        )
      );

      // 3) LA PÁGINA ESTÁ MONTADA. Si hay panel de filtros o cabecera de
      //    resultados, ya ha cargado: la ausencia de tarjetas es un resultado,
      //    no una espera.
      const montada =
        Boolean(document.querySelector('[class*="filter" i], [id*="filter" i]')) ||
        Boolean(contador);

      // 4) Y el texto, como confirmación.
      const sinNada =
        /no se han encontrado|no encontramos|no hay vuelos|sin resultados|no results|no flights found/i.test(
          texto
        );

      return { contador: contador ? contador[0] : null, quitarFiltros, montada, sinNada };
    })
    .catch(() => null);
}

/** Con esto se da por hecho que no hay nada que esperar. */
function esCeroPorFiltros(señales) {
  if (!señales) return false;
  // El contador a cero basta por sí solo. Las demás señales necesitan que la
  // página esté montada, para no confundir una carga a medias con un cero.
  if (señales.contador) return true;
  return señales.montada && (señales.quitarFiltros || señales.sinNada);
}

async function esperarCargaCompleta(pagina) {
  // 1) Que aparezca algo... O que la página diga que no hay nada.
  //
  // Se compite entre las dos cosas en vez de esperar solo a la tarjeta: si el
  // filtro deja la lista a cero, la tarjeta no va a llegar nunca y quedarse los
  // 45 segundos completos es tiempo tirado además de un diagnóstico falso.
  const hastaCuando = Date.now() + TIMEOUT_BUSQUEDA;
  let aparecio = false;

  while (Date.now() < hastaCuando) {
    if ((await pagina.locator(SEL_TARJETA).count().catch(() => 0)) > 0) {
      aparecio = true;
      break;
    }
    const señales = await detectarSinResultados(pagina);
    if (esCeroPorFiltros(señales)) {
      console.log(
        `    (cero resultados con estos filtros${señales.contador ? `: «${señales.contador}»` : ''})`
      );
      return { tarjetas: 0, sinResultadosPorFiltros: true };
    }
    await dormir(1000);
  }

  if (!aparecio) {
    throw new Error(
      `Kayak no mostró ningún resultado en ${TIMEOUT_BUSQUEDA / 1000} s. ` +
        'Puede ser que la ruta no tenga vuelos esos días, que la búsqueda vaya muy lenta, ' +
        'o que nos haya puesto un muro. Mira la ventana de Chrome.'
    );
  }

  // 2) Que se estabilice.
  const limite = Date.now() + TIMEOUT_BUSQUEDA;
  let anterior = -1;
  let estables = 0;

  while (Date.now() < limite) {
    const n = await pagina.locator(SEL_TARJETA).count();

    if (n === anterior) {
      estables++;
      if (estables >= 2) {
        console.log(`    (búsqueda estabilizada en ${n} tarjetas)`);
        return { tarjetas: n, sinResultadosPorFiltros: false };
      }
    } else {
      estables = 0;
      anterior = n;
    }
    await dormir(1500);
  }

  const n = await pagina.locator(SEL_TARJETA).count();
  console.log(`    (se agotó la espera; sigo con las ${n} tarjetas que hay)`);
  return { tarjetas: n, sinResultadosPorFiltros: false };
}

/**
 * Lee las tarjetas. Se ejecuta DENTRO del navegador, asi que no puede usar nada
 * del ambito de Node.
 *
 * Parseo por TEXTO, no por clases (ver aviso de la cabecera). Las lineas de una
 * tarjeta tienen esta pinta:
 *
 *   El mejor            <- insignias opcionales
 *   9:35 – 11:15        <- tramo: horas
 *   BCNBarcelona-El Prat<- origen (IATA pegado al nombre)
 *   -
 *   OVDAsturias         <- destino
 *   directo             <- escalas
 *   1h 40m              <- duracion
 *   23:15 – 0:50+1      <- segundo tramo, idem
 *   ...
 *   Volotea, Vueling    <- aerolineas
 *   107 €               <- precio del PAQUETE
 *   Turista             <- clase
 */
function extraerVuelosDelDOM(selectorTarjeta) {
  const RE_HORAS = /^(\d{1,2}:\d{2})\s*[–-]\s*(\d{1,2}:\d{2})(?:\s*\+(\d))?$/;
  const RE_AEROPUERTO = /^([A-Z]{3})(.*)$/;
  const RE_ESCALAS = /^(directo|(\d+)\s*(?:escalas?|paradas?))$/i;
  const RE_DURACION = /^(?:(\d+)\s*h)?\s*(?:(\d+)\s*m)?$/;
  const RE_PRECIO = /^([\d.,]+)\s*(€|EUR)$/;
  const RE_PRECIO_TOTAL = /^([\d.,]+)\s*(€|EUR)\s*en total$/i;

  const aNumero = (s) => {
    const n = Number(String(s).replace(/\./g, '').replace(',', '.'));
    return Number.isFinite(n) ? n : null;
  };

  return [...document.querySelectorAll(selectorTarjeta)].map((tarjeta) => {
    const patrocinado = /sponsored/.test(tarjeta.className || '');
    const lineas = tarjeta.innerText.split('\n').map((s) => s.trim()).filter(Boolean);

    // --- Tramos ---------------------------------------------------------
    const tramos = [];
    for (let i = 0; i < lineas.length; i++) {
      const mh = RE_HORAS.exec(lineas[i]);
      if (!mh) continue;

      const bloque = {
        horaSalida: mh[1],
        horaLlegada: mh[2],
        diasDespues: mh[3] ? Number(mh[3]) : 0, // el "+1" de llegar de madrugada
        aeropuertoOrigen: null,
        aeropuertoDestino: null,
        nombreOrigen: null,
        nombreDestino: null,
        escalas: null,
        duracion: null,
        escalaTexto: null, // "Escala de 8h 35m en Madrid-Barajas", si la hay
      };

      // Los dos aeropuertos vienen justo detrás.
      let j = i + 1;
      const aeropuertos = [];
      while (j < lineas.length && j < i + 7 && aeropuertos.length < 2) {
        const ma = RE_AEROPUERTO.exec(lineas[j]);
        if (ma && ma[1] !== 'EUR') aeropuertos.push({ iata: ma[1], nombre: ma[2].trim() || null });
        j++;
      }
      if (aeropuertos[0]) {
        bloque.aeropuertoOrigen = aeropuertos[0].iata;
        bloque.nombreOrigen = aeropuertos[0].nombre;
      }
      if (aeropuertos[1]) {
        bloque.aeropuertoDestino = aeropuertos[1].iata;
        bloque.nombreDestino = aeropuertos[1].nombre;
      }

      // Escalas y duración van pegadas después de los aeropuertos.
      // En los vuelos con escala, Kayak intercala además el aeropuerto de
      // conexión ("MAD") y una descripción muy útil de la espera
      // ("Escala de 8h 35m en Adolfo Suárez Madrid-Barajas"). La guardamos:
      // una escala de 8 horas cambia por completo lo que vale ese vuelo.
      for (let k = j - 1; k < Math.min(lineas.length, j + 5); k++) {
        const me = RE_ESCALAS.exec(lineas[k]);
        if (me) bloque.escalas = /directo/i.test(me[1]) ? 0 : Number(me[2]);

        if (/^Escala de /i.test(lineas[k])) bloque.escalaTexto = lineas[k];

        if (/^\d/.test(lineas[k])) {
          const md = RE_DURACION.exec(lineas[k]);
          if (md && (md[1] || md[2])) bloque.duracion = lineas[k];
        }
      }

      tramos.push(bloque);
      i = j; // seguimos buscando el siguiente tramo a partir de aquí
    }

    // --- Precio, aerolíneas y clase --------------------------------------
    // CUIDADO, esto cambia segun el numero de viajeros:
    //   1 pasajero  ->  "107 €"
    //   varios      ->  "113 €" / "/persona" / "452 € en total"
    // Si te quedas con el primer precio que aparece, con 4 pasajeros guardarias
    // 113 € cuando en realidad son 452 €. Asi que buscamos el "en total" y, si
    // esta, ESE es el precio; el otro queda como precio por persona.
    const iPrecio = lineas.findIndex((l) => RE_PRECIO.test(l));
    const iTotal = lineas.findIndex((l) => RE_PRECIO_TOTAL.test(l));
    const mTotal = iTotal >= 0 ? RE_PRECIO_TOTAL.exec(lineas[iTotal]) : null;
    const mp = mTotal ?? (iPrecio >= 0 ? RE_PRECIO.exec(lineas[iPrecio]) : null);

    // El por-persona solo existe cuando hay varios viajeros.
    const mPorPersona = mTotal && iPrecio >= 0 ? RE_PRECIO.exec(lineas[iPrecio]) : null;

    // OJO: NO vale coger sin más la línea anterior al precio. En muchas tarjetas
    // Kayak mete entre medias el contador de equipaje, que es un número suelto:
    //     "Volotea, Ryanair"  /  "0"  /  "175 €"
    // Si te fías de la línea anterior, la aerolínea te sale como "0".
    // Así que retrocedemos saltando los números sueltos hasta dar con texto.
    const RE_SOLO_DURACION = /^\d+\s*h(\s*\d+\s*m)?$|^\d+\s*m$/;
    let aerolinea = null;
    for (let k = iPrecio - 1; k >= 0 && k >= iPrecio - 4; k--) {
      const l = lineas[k];
      if (/^\d+$/.test(l)) continue;              // contador de equipaje
      if (!/[A-Za-zÁÉÍÓÚÜÑáéíóúüñ]/.test(l)) continue;
      // Si llegamos a datos del tramo es que esta tarjeta no trae aerolínea.
      if (RE_ESCALAS.test(l) || RE_SOLO_DURACION.test(l) || RE_HORAS.test(l)) break;
      if (/^Escala de /i.test(l)) break;
      aerolinea = l;
      break;
    }

    return {
      patrocinado,
      tramos,
      aerolinea,
      precio: mp ? aNumero(mp[1]) : null,
      moneda: mp ? (mp[2] === '€' ? 'EUR' : mp[2]) : null,
      // La clase va detras del ULTIMO precio (con varios viajeros, detras del total).
      clase: (() => {
        const iUltimo = iTotal >= 0 ? iTotal : iPrecio;
        return iUltimo >= 0 ? (lineas[iUltimo + 1] ?? null) : null;
      })(),
      precioPorPersona: mPorPersona ? aNumero(mPorPersona[1]) : null,
    };
  });
}

/**
 * =============================================================================
 * FUNCION PUBLICA DEL PROVEEDOR
 * =============================================================================
 * @param {object} opciones
 * @param {string} opciones.origen          IATA, p.ej. "BCN"
 * @param {string} opciones.destino         IATA, p.ej. "OVD"
 * @param {string} opciones.fechaIda        "YYYY-MM-DD"
 * @param {string|null} opciones.fechaVuelta "YYYY-MM-DD", o null para SOLO IDA
 * @param {number} [opciones.adultos]       1 por defecto
 * @param {number[]} [opciones.edadesNinos]  Edades de los niños, p.ej. [4, 9]
 * @param {object} [opciones.filtros] Filtros que Kayak sabe aplicar (ver FILTROS_KAYAK)
 * @param {number} [opciones.maxResultados] 15 por defecto
 */
export async function buscarVuelosKayak({
  origen,
  destino,
  fechaIda,
  fechaVuelta,
  adultos = 1,
  edadesNinos = [],
  filtros = {},
  maxResultados = 15,
}) {
  const orig = validarIATA(origen, 'origen');
  const dest = validarIATA(destino, 'destino');
  if (orig === dest) throw new Error(`[kayak] Origen y destino no pueden ser el mismo (${orig}).`);

  const ida = validarFecha(fechaIda, 'fechaIda');

  // SOLO IDA: sin fechaVuelta se busca un trayecto suelto, no un paquete.
  // Es lo que hace falta para los tramos de la ruta: la ida del 11 y la vuelta
  // del 13 son dos busquedas distintas, con horarios y filtros propios.
  const soloIda = fechaVuelta == null || fechaVuelta === '';
  const vuelta = soloIda ? null : validarFecha(fechaVuelta, 'fechaVuelta');
  if (vuelta && vuelta < ida) {
    throw new Error(`[kayak] La fechaVuelta (${fechaVuelta}) es anterior a la fechaIda (${fechaIda}).`);
  }
  if (!Number.isInteger(maxResultados) || maxResultados < 1) {
    throw new Error(`[kayak] maxResultados debe ser un entero positivo (recibido: ${maxResultados}).`);
  }

  if (!Number.isInteger(adultos) || adultos < 1) {
    throw new Error(`[kayak] adultos debe ser un entero positivo (recibido: ${adultos}).`);
  }
  const edades = (edadesNinos ?? []).map(Number).filter((e) => Number.isInteger(e) && e >= 0 && e <= 17);

  // PASO 1: la URL de resultados, ya rellena, con los pasajeros incluidos.
  //
  // Formato de Kayak para los viajeros (comprobado a mano en kayak.es):
  //   .../2026-09-14/2026-09-17/2adults              -> 2 adultos
  //   .../2026-09-14/2026-09-17/2adults/children-5   -> 2 adultos + 1 niño de 5
  //   .../2026-09-14/2026-09-17/2adults/children-4-9 -> 2 adultos + niños de 4 y 9
  // Las edades van pegadas con guiones, una por niño, y Kayak las lee bien
  // (el panel de "Viajeros" muestra un desplegable "Edad del niño" por cada una).
  const partesPax = [`${adultos}adults`];
  if (edades.length) partesPax.push(`children-${edades.join('-')}`);

  // Con vuelta van las dos fechas; sin ella, solo la de ida. Kayak entiende las
  // dos formas con la misma URL:
  //   .../BCN-MAD/2026-09-11/2026-09-13/2adults   -> ida y vuelta
  //   .../BCN-MAD/2026-09-11/2adults              -> solo ida
  const partesFecha = soloIda ? [fechaIda] : [fechaIda, fechaVuelta];
  let url = `${BASE}/${orig}-${dest}/${partesFecha.join('/')}/${partesPax.join('/')}?sort=bestflight_a`;

  // Filtros que Kayak sabe hacer por URL. Los demas los aplicamos nosotros.
  const fs = construirFs(filtros);
  if (fs) url += `&fs=${fs}`;

  const { contexto, pagina } = await abrirNavegador({ de: 'Kayak' });

  try {
    await paso(`1. Abrir resultados ${orig}→${dest}`, async () => {
      // Dejamos la URL en el log: es la forma de comprobar de un vistazo que los
      // viajeros han viajado bien hasta Kayak (.../2adults/children-5).
      console.log(`    URL: ${url}`);
      await pagina.goto(url, { waitUntil: 'domcontentloaded', timeout: TIMEOUT_BUSQUEDA });
      await pausaHumana(1000, 2000); // un respiro, como quien llega y mira
    });

    // Antes de nada: si nos han puesto un muro, paramos y avisamos.
    await comprobarCaptcha(pagina, { paso: 'resultados de Kayak' });

    await paso('2. Cerrar cookies y popups', () => cerrarEstorbos(pagina));

    const carga = await paso('3. Esperar a que termine la búsqueda', () =>
      esperarCargaCompleta(pagina)
    );

    // CERO CON ESTOS FILTROS NO ES UN FALLO, ES UNA RESPUESTA.
    //
    // Hay vuelos en esa ruta; lo que no hay es ninguno que cumpla lo que se ha
    // pedido. Devolverlo como error hacía que quien llama descartara la ruta
    // entera, cuando lo que toca es aflojar un filtro y volver a preguntar.
    //
    // Va como lista vacía con una marca encima: quien solo mire `.length` sigue
    // funcionando igual, y quien quiera distinguir los dos casos puede.
    if (carga?.sinResultadosPorFiltros) {
      const vacio = [];
      vacio.sinResultadosPorFiltros = true;
      return vacio;
    }

    // Un scroll suave: es lo que haría una persona y de paso asienta el render.
    await paso('4. Recorrer la lista', async () => {
      for (let i = 0; i < 3; i++) await scrollHumano(pagina);
      await pagina.evaluate(() => window.scrollTo(0, 0));
      await pausaHumana(400, 900);
    });

    const crudos = await paso('5. Leer las tarjetas', () =>
      pagina.evaluate(extraerVuelosDelDOM, SEL_TARJETA)
    );

    if (!crudos.length) {
      throw new ErrorReceta(
        '5. Leer las tarjetas',
        new Error(`La página cargó pero no encontré ninguna tarjeta ${SEL_TARJETA}`)
      );
    }

    // Fuera los anuncios: son ofertas de agencias, no resultados de la búsqueda.
    const utiles = crudos.filter((v) => !v.patrocinado);
    const anuncios = crudos.length - utiles.length;
    if (anuncios) console.log(`    (${anuncios} resultado/s patrocinado/s descartado/s)`);

    // Normalización al contrato.
    return utiles.slice(0, maxResultados).map((v) => {
      const primero = v.tramos[0] ?? {};
      return {
        aerolinea: v.aerolinea,
        // Campos de primer nivel = tramo de IDA (ver la nota de la cabecera).
        horaSalida: primero.horaSalida ?? null,
        horaLlegada: primero.horaLlegada ?? null,
        duracion: primero.duracion ?? null,
        escalas: primero.escalas ?? null,
        aeropuertoOrigen: primero.aeropuertoOrigen ?? null,
        aeropuertoDestino: primero.aeropuertoDestino ?? null,
        precio: v.precio,
        moneda: v.moneda,
        tramo: v.tramos.length >= 2 ? 'combinado' : 'ida',
        // extras
        tramos: v.tramos,
        precioPorPersona: v.precioPorPersona ?? null,
        clase: v.clase,
        patrocinado: v.patrocinado,
      };
    });
  } catch (err) {
    await capturaDeFallo(pagina, err.paso ? err.paso.split('.')[0] : 'error');
    throw err;
  } finally {
    await dormir(500);
    await cerrarNavegador(contexto);
  }
}

export default { buscarVuelosKayak };
