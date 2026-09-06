/**
 * test-booking.js
 * -----------------------------------------------------------------------------
 * Script de prueba DESECHABLE del proveedor Booking.
 *
 *   node test-booking.js <destino> <fechaEntrada> <fechaSalida> [adultos] [maxResultados]
 *
 * Ejemplos:
 *   node test-booking.js "Paris" 2026-09-14 2026-09-17
 *   node test-booking.js "Paris" 2026-09-14 2026-09-17 2 15
 *   node test-booking.js Oviedo 2026-09-07 2026-09-10 1 10
 */

import { buscarHoteles } from './providers/booking.js';

const USO = `
Uso:
  node test-booking.js <destino> <fechaEntrada> <fechaSalida> [adultos] [maxResultados]

Argumentos:
  destino        Ciudad o zona. Si lleva espacios, entre comillas: "Nueva York"
  fechaEntrada   Formato YYYY-MM-DD. Ej: 2026-09-14
  fechaSalida    Formato YYYY-MM-DD, posterior a la entrada. Ej: 2026-09-17
  adultos        Opcional, entero positivo. Por defecto 2.
  maxResultados  Opcional, entero positivo. Por defecto 20.

Ejemplos:
  node test-booking.js "Paris" 2026-09-14 2026-09-17
  node test-booking.js "Paris" 2026-09-14 2026-09-17 2 15
  node test-booking.js Oviedo 2026-09-07 2026-09-10 1 10
`;

/** Sale con un mensaje de error claro y el modo de empleo. */
function abortar(mensaje) {
  console.error(`\n[X] ${mensaje}`);
  console.error(USO);
  process.exit(1);
}

const aISO = (d) =>
  `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;

/**
 * Valida una fecha YYYY-MM-DD. No basta con la forma: "2026-02-31" tiene el
 * formato correcto pero no existe, asi que comprobamos que al reconstruirla
 * salga la misma fecha. (Mismo criterio que en test-vueling.js.)
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

/** Valida un entero positivo opcional. */
function validarEntero(valor, nombre, porDefecto, maximo) {
  if (valor === undefined) return porDefecto;
  if (!/^\d+$/.test(valor)) {
    abortar(`${nombre} debe ser un numero entero. Recibido: "${valor}".`);
  }
  const n = Number(valor);
  if (n < 1) abortar(`${nombre} debe ser 1 o mas. Recibido: ${n}.`);
  if (n > maximo) abortar(`${nombre} es demasiado alto (${n}). Maximo razonable: ${maximo}.`);
  return n;
}

function parsearArgumentos(argv) {
  const args = argv.slice(2);

  if (args.length === 0) {
    abortar('Faltan argumentos: hacen falta al menos destino, fechaEntrada y fechaSalida.');
  }
  if (args.length < 3) {
    abortar(
      `Se esperaban al menos 3 argumentos (destino, fechaEntrada, fechaSalida). Recibidos: ${args.length}.`
    );
  }
  if (args.length > 5) {
    abortar(`Sobran argumentos (recibidos ${args.length}, maximo 5).`);
  }

  const [destino, entradaCruda, salidaCruda, adultosCrudo, maxCrudo] = args;

  if (!destino.trim()) abortar('El destino no puede estar vacio.');

  const entrada = validarFecha(entradaCruda, 'fechaEntrada');
  const salida = validarFecha(salidaCruda, 'fechaSalida');

  if (salida.fecha <= entrada.fecha) {
    abortar(
      `La fechaSalida (${salida.iso}) debe ser posterior a la fechaEntrada (${entrada.iso}). ` +
        'Una estancia dura al menos una noche.'
    );
  }

  const hoy = new Date();
  hoy.setHours(0, 0, 0, 0);
  if (entrada.fecha < hoy) {
    abortar(`La fechaEntrada (${entrada.iso}) esta en el pasado.`);
  }

  const noches = Math.round((salida.fecha - entrada.fecha) / 86_400_000);

  return {
    destino: destino.trim(),
    fechaEntrada: entrada.iso,
    fechaSalida: salida.iso,
    noches,
    adultos: validarEntero(adultosCrudo, 'adultos', 2, 30),
    maxResultados: validarEntero(maxCrudo, 'maxResultados', 20, 100),
  };
}

/** Recorta un texto a n caracteres, con puntos suspensivos si sobra. */
function recorta(texto, n) {
  if (!texto) return '-';
  return texto.length > n ? `${texto.slice(0, n - 1)}…` : texto;
}

/** "a 5,2 km del centro" -> "5,2 km" (la tabla ya dice que es del centro). */
function distanciaCorta(texto) {
  if (!texto) return '-';
  const m = /([\d.,]+\s*(?:km|m)\b)/i.exec(texto);
  return m ? m[1] : recorta(texto, 12);
}

async function main() {
  const consulta = parsearArgumentos(process.argv);

  console.log('='.repeat(70));
  console.log('PRUEBA DE SCRAPING - BOOKING.COM');
  console.log('='.repeat(70));
  console.log(`Destino:        ${consulta.destino}`);
  console.log(`Entrada:        ${consulta.fechaEntrada}`);
  console.log(`Salida:         ${consulta.fechaSalida}  (${consulta.noches} noche/s)`);
  console.log(`Adultos:        ${consulta.adultos}`);
  console.log(`Max resultados: ${consulta.maxResultados}`);
  console.log('-'.repeat(70));
  console.log('Se abrira una ventana de Chrome. No la cierres a mano.');
  console.log('Si sale una verificacion, resuelvela tu en la ventana: el script espera.\n');

  console.time('TIEMPO TOTAL');

  try {
    const hoteles = await buscarHoteles({
      destino: consulta.destino,
      fechaEntrada: consulta.fechaEntrada,
      fechaSalida: consulta.fechaSalida,
      adultos: consulta.adultos,
      maxResultados: consulta.maxResultados,
    });

    console.log(`\nEncontrados ${hoteles.length} alojamientos.\n`);

    console.table(
      hoteles.map((h) => ({
        Alojamiento: recorta(h.nombre, 35),
        Estancia: h.precioTotal != null ? `${h.precioTotal} ${h.moneda ?? ''}`.trim() : '-',
        Estr: h.estrellas != null ? `${h.estrellas}${h.estrellasAutodeclaradas ? '*' : ''}` : '-',
        Nota: h.valoracion != null ? `${h.valoracion}` : '-',
        Opiniones: h.numOpiniones ?? '-',
        Zona: recorta(h.zona, 26),
        Centro: distanciaCorta(h.distanciaCentro),
      }))
    );
    console.log('(Estancia = precio TOTAL de las noches indicadas · Estr con * = calidad autodeclarada, no estrellas oficiales)\n');

    const conPrecio = hoteles.filter((h) => h.precioTotal != null);
    if (conPrecio.length) {
      const barato = conPrecio.reduce((a, b) => (b.precioTotal < a.precioTotal ? b : a));
      console.log(
        `Mas barato:     ${barato.nombre} — ${barato.precioTotal} ${barato.moneda ?? ''} (${barato.zona ?? 'zona ?'})`
      );
    }

    const conNota = hoteles.filter((h) => h.valoracion != null);
    if (conNota.length) {
      const mejor = conNota.reduce((a, b) => (b.valoracion > a.valoracion ? b : a));
      console.log(
        `Mejor valorado: ${mejor.nombre} — ${mejor.valoracion}/10 (${mejor.numOpiniones ?? '?'} opiniones)`
      );
    }

    const anuncios = hoteles.filter((h) => h.esAnuncio).length;
    console.log(
      `Sin precio: ${hoteles.length - conPrecio.length} · sin valoracion: ${hoteles.length - conNota.length} · patrocinados: ${anuncios}`
    );
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
