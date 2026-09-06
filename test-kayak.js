/**
 * test-kayak.js
 * -----------------------------------------------------------------------------
 * Script de prueba DESECHABLE del proveedor Kayak.
 *
 *   node test-kayak.js <origen> <destino> <fechaIda> <fechaVuelta> [maxResultados]
 *
 * Ejemplos:
 *   node test-kayak.js BCN OVD 2026-09-14 2026-09-17
 *   node test-kayak.js BCN OVD 2026-09-14 2026-09-17 10
 *   node test-kayak.js MAD LIS 2026-10-05 2026-10-09 15
 *
 * OJO: cada tarjeta de Kayak es un PAQUETE de ida y vuelta con un solo precio.
 * La tabla muestra el tramo de ida y, debajo, el de vuelta.
 */

import { buscarVuelosKayak } from './providers/kayak.js';

const USO = `
Uso:
  node test-kayak.js <origen> <destino> <fechaIda> <fechaVuelta> [maxResultados] [adultos] [edadesNinos]

Argumentos:
  origen         Código IATA de 3 letras. Ej: BCN
  destino        Código IATA de 3 letras. Ej: OVD
  fechaIda       Formato YYYY-MM-DD. Ej: 2026-09-14
  fechaVuelta    Formato YYYY-MM-DD, no anterior a la ida. Ej: 2026-09-17
  maxResultados  Opcional, entero positivo. Por defecto 15.
  adultos        Opcional, entero 1-9. Por defecto 1.
  edadesNinos    Opcional, edades separadas por comas. Ej: 5   o   4,9

Ejemplos:
  node test-kayak.js BCN OVD 2026-09-14 2026-09-17
  node test-kayak.js BCN OVD 2026-09-14 2026-09-17 10
  node test-kayak.js BCN OVD 2026-09-14 2026-09-17 8 2 5      (2 adultos y un niño de 5)
`;

/** Sale con un mensaje de error claro y el modo de empleo. */
function abortar(mensaje) {
  console.error(`\n[X] ${mensaje}`);
  console.error(USO);
  process.exit(1);
}

const aISO = (d) =>
  `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;

/** Valida un código IATA: exactamente 3 letras. Lo devuelve en mayúsculas. */
function validarIATA(valor, nombre) {
  if (!/^[A-Za-z]{3}$/.test(valor)) {
    abortar(`${nombre} debe ser un código IATA de 3 letras (ej: BCN, OVD). Recibido: "${valor}".`);
  }
  return valor.toUpperCase();
}

/**
 * Valida una fecha YYYY-MM-DD. No basta con la forma: "2026-02-31" tiene el
 * formato correcto pero no existe. (Mismo criterio que test-vueling.js.)
 */
function validarFecha(valor, nombre) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(valor)) {
    abortar(`${nombre} debe tener el formato YYYY-MM-DD (ej: 2026-09-14). Recibido: "${valor}".`);
  }
  const d = new Date(`${valor}T12:00:00`);
  if (Number.isNaN(d.getTime()) || aISO(d) !== valor) {
    abortar(`${nombre} no es una fecha que exista en el calendario: "${valor}".`);
  }
  return { iso: valor, fecha: d };
}

function parsearArgumentos(argv) {
  const args = argv.slice(2);

  if (args.length === 0) abortar('Faltan argumentos.');
  if (args.length < 4) {
    abortar(`Se esperaban al menos 4 argumentos (origen, destino, fechaIda, fechaVuelta). Recibidos: ${args.length}.`);
  }
  if (args.length > 7) abortar(`Sobran argumentos (recibidos ${args.length}, máximo 7).`);

  const [origenCrudo, destinoCrudo, idaCruda, vueltaCruda, maxCrudo, adultosCrudo, edadesCrudas] = args;

  const origen = validarIATA(origenCrudo, 'origen');
  const destino = validarIATA(destinoCrudo, 'destino');
  if (origen === destino) abortar(`El origen y el destino no pueden ser el mismo aeropuerto (${origen}).`);

  const ida = validarFecha(idaCruda, 'fechaIda');
  const vuelta = validarFecha(vueltaCruda, 'fechaVuelta');
  if (vuelta.fecha < ida.fecha) {
    abortar(`La fechaVuelta (${vuelta.iso}) es anterior a la fechaIda (${ida.iso}).`);
  }

  const hoy = new Date();
  hoy.setHours(0, 0, 0, 0);
  if (ida.fecha < hoy) abortar(`La fechaIda (${ida.iso}) está en el pasado.`);

  let maxResultados = 15;
  if (maxCrudo !== undefined) {
    if (!/^\d+$/.test(maxCrudo)) abortar(`maxResultados debe ser un número entero. Recibido: "${maxCrudo}".`);
    maxResultados = Number(maxCrudo);
    if (maxResultados < 1) abortar(`maxResultados debe ser 1 o más. Recibido: ${maxResultados}.`);
    if (maxResultados > 50) abortar(`maxResultados es demasiado alto (${maxResultados}). Máximo razonable: 50.`);
  }

  let adultos = 1;
  if (adultosCrudo !== undefined) {
    if (!/^\d+$/.test(adultosCrudo)) abortar(`adultos debe ser un número entero. Recibido: "${adultosCrudo}".`);
    adultos = Number(adultosCrudo);
    if (adultos < 1 || adultos > 9) abortar(`adultos debe estar entre 1 y 9. Recibido: ${adultos}.`);
  }

  let edadesNinos = [];
  if (edadesCrudas !== undefined && edadesCrudas.trim() !== '') {
    edadesNinos = edadesCrudas.split(',').map((e) => e.trim());
    for (const e of edadesNinos) {
      if (!/^\d+$/.test(e) || Number(e) > 17) {
        abortar(`Las edades de los niños deben ser números de 0 a 17, separados por comas. Recibido: "${edadesCrudas}".`);
      }
    }
    edadesNinos = edadesNinos.map(Number);
  }

  return { origen, destino, fechaIda: ida.iso, fechaVuelta: vuelta.iso, maxResultados, adultos, edadesNinos };
}

/** "1h 40m" -> 100 minutos. Sirve para saber cuál es el más rápido. */
function aMinutos(duracion) {
  if (!duracion) return null;
  const h = /(\d+)\s*h/.exec(duracion);
  const m = /(\d+)\s*m/.exec(duracion);
  const total = (h ? Number(h[1]) * 60 : 0) + (m ? Number(m[1]) : 0);
  return total || null;
}

/** Minutos totales del paquete (ida + vuelta), para el "más rápido". */
function minutosTotales(vuelo) {
  const suma = (vuelo.tramos || []).reduce((acc, t) => acc + (aMinutos(t.duracion) ?? 0), 0);
  return suma || aMinutos(vuelo.duracion) || null;
}

/** "1h 40m" -> "1h 40m"; 215 -> "3h 35m" */
function formatearMinutos(min) {
  if (min == null) return '-';
  return `${Math.floor(min / 60)}h ${String(min % 60).padStart(2, '0')}m`;
}

/** Una línea de tabla por TRAMO, para poder ver ida y vuelta. */
function filasDeTramos(vuelo, indice) {
  const tramos = vuelo.tramos?.length ? vuelo.tramos : [vuelo];
  return tramos.map((t, i) => ({
    '#': i === 0 ? String(indice + 1) : '',
    Tramo: tramos.length >= 2 ? (i === 0 ? 'ida' : 'vuelta') : 'ida',
    Aerolínea: i === 0 ? (vuelo.aerolinea ?? '-').slice(0, 24) : '',
    Ruta: `${t.aeropuertoOrigen ?? '?'}–${t.aeropuertoDestino ?? '?'}`,
    Horario:
      `${t.horaSalida ?? '?'}–${t.horaLlegada ?? '?'}` + (t.diasDespues ? `+${t.diasDespues}` : ''),
    Duración: t.duracion ?? '-',
    Escalas: t.escalas === 0 ? 'directo' : t.escalas != null ? `${t.escalas} escala(s)` : '-',
    // La espera importa tanto como el precio: 8 h en Barajas no es lo mismo que 1 h.
    Espera: t.escalaTexto ? (/(\d+h(\s*\d+m)?|\d+m)/.exec(t.escalaTexto)?.[1] ?? '-') : '',
    Precio: i === 0 ? (vuelo.precio != null ? `${vuelo.precio} ${vuelo.moneda ?? ''}`.trim() : '-') : '',
  }));
}

async function main() {
  const consulta = parsearArgumentos(process.argv);

  console.log('='.repeat(70));
  console.log('PRUEBA DE SCRAPING - KAYAK');
  console.log('='.repeat(70));
  console.log(`Ruta:           ${consulta.origen} -> ${consulta.destino}`);
  console.log(`Ida:            ${consulta.fechaIda}`);
  console.log(`Vuelta:         ${consulta.fechaVuelta}`);
  console.log(`Max resultados: ${consulta.maxResultados}`);
  console.log(`Viajeros:       ${consulta.adultos} adulto/s` +
    (consulta.edadesNinos.length ? ` y ${consulta.edadesNinos.length} niño/s (${consulta.edadesNinos.join(', ')} años)` : ''));
  console.log('-'.repeat(70));
  console.log('Se abrirá una ventana de Chrome. No la cierres a mano.');
  console.log('Kayak busca en muchas webs: la carga puede tardar bastante.');
  console.log('Si sale una verificación, resuélvela tú en la ventana: el script espera.\n');

  console.time('TIEMPO TOTAL');

  try {
    const vuelos = await buscarVuelosKayak(consulta);

    console.log(`\nEncontradas ${vuelos.length} opciones (cada una es ida + vuelta con un solo precio).\n`);

    console.table(vuelos.flatMap((v, i) => filasDeTramos(v, i)));

    const conPrecio = vuelos.filter((v) => v.precio != null);
    if (conPrecio.length) {
      const barato = conPrecio.reduce((a, b) => (b.precio < a.precio ? b : a));
      console.log(
        `Más barato:  ${barato.precio} ${barato.moneda} — ${barato.aerolinea ?? '?'} ` +
          `(${formatearMinutos(minutosTotales(barato))} en total)`
      );
    }

    const conDuracion = vuelos.filter((v) => minutosTotales(v) != null);
    if (conDuracion.length) {
      const rapido = conDuracion.reduce((a, b) => (minutosTotales(b) < minutosTotales(a) ? b : a));
      console.log(
        `Más rápido:  ${formatearMinutos(minutosTotales(rapido))} — ${rapido.aerolinea ?? '?'} ` +
          `(${rapido.precio} ${rapido.moneda})`
      );
    }

    const directos = vuelos.filter((v) => (v.tramos || []).every((t) => t.escalas === 0)).length;
    console.log(`Directos ida y vuelta: ${directos} de ${vuelos.length}`);
  } catch (err) {
    console.error('\n[X] LA PRUEBA HA FALLADO\n');
    console.error(err.message);
    if (err.causa?.stack) {
      console.error('\n--- traza original ---');
      console.error(err.causa.stack.split('\n').slice(0, 5).join('\n'));
    }
    process.exitCode = 1;
  } finally {
    console.log();
    console.timeEnd('TIEMPO TOTAL');
  }
}

main();
