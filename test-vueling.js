/**
 * test-vueling.js
 * -----------------------------------------------------------------------------
 * Script de prueba DESECHABLE. No forma parte de la app final: solo sirve para
 * comprobar que la "receta" de providers/vueling.js sigue funcionando.
 *
 *   node test-vueling.js                                       (valores por defecto)
 *   node test-vueling.js <origen> <destino> <fechaIda> <fechaVuelta>
 *
 * Ejemplo:
 *   node test-vueling.js BCN OVD 2026-09-07 2026-09-10
 *
 * Sin argumentos usa BCN -> OVD con el proximo lunes y el proximo jueves.
 */

import { buscarVuelos } from './providers/vueling.js';

const USO = `
Uso:
  node test-vueling.js                                        (valores por defecto)
  node test-vueling.js <origen> <destino> <fechaIda> <fechaVuelta>

Argumentos:
  origen       Codigo IATA de 3 letras. Ej: BCN
  destino      Codigo IATA de 3 letras. Ej: OVD
  fechaIda     Fecha en formato YYYY-MM-DD. Ej: 2026-09-07
  fechaVuelta  Fecha en formato YYYY-MM-DD. Ej: 2026-09-10

Ejemplos:
  node test-vueling.js
  node test-vueling.js BCN OVD 2026-09-07 2026-09-10
  node test-vueling.js MAD LPA 2026-12-20 2026-12-27
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
 * Devuelve la proxima fecha (estrictamente futura) que caiga en el dia de la
 * semana pedido. 1 = lunes ... 4 = jueves ... 0 = domingo.
 */
function proximoDiaDeLaSemana(diaSemana, desde = new Date()) {
  const fecha = new Date(desde);
  fecha.setHours(12, 0, 0, 0); // mediodia: evita sustos con cambios de hora
  do {
    fecha.setDate(fecha.getDate() + 1);
  } while (fecha.getDay() !== diaSemana);
  return fecha;
}

/** Valida un codigo IATA: exactamente 3 letras. Lo devuelve en mayusculas. */
function validarIATA(valor, nombre) {
  if (!/^[A-Za-z]{3}$/.test(valor)) {
    abortar(
      `${nombre} debe ser un codigo IATA de 3 letras (ej: BCN, OVD). Recibido: "${valor}".`
    );
  }
  return valor.toUpperCase();
}

/**
 * Valida una fecha YYYY-MM-DD. No basta con la forma: "2026-02-31" tiene el
 * formato correcto pero no existe, asi que comprobamos que al reconstruirla
 * salga la misma fecha.
 */
function validarFecha(valor, nombre) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(valor)) {
    abortar(`${nombre} debe tener el formato YYYY-MM-DD (ej: 2026-09-07). Recibido: "${valor}".`);
  }
  const d = new Date(`${valor}T12:00:00`);
  if (Number.isNaN(d.getTime()) || aISO(d) !== valor) {
    abortar(`${nombre} no es una fecha que exista en el calendario: "${valor}".`);
  }
  return { iso: valor, fecha: d };
}

function parsearArgumentos(argv) {
  const args = argv.slice(2);

  // Sin argumentos: valores por defecto + aviso de que se pueden pasar.
  if (args.length === 0) {
    const hoy = new Date();
    const lunes = proximoDiaDeLaSemana(1, hoy);
    const jueves = proximoDiaDeLaSemana(4, lunes); // el jueves siguiente al lunes
    console.log('[i] Sin argumentos: uso los valores por defecto (BCN -> OVD, proximo lunes a jueves).');
    console.log('[i] Puedes pasarlos: node test-vueling.js <origen> <destino> <fechaIda> <fechaVuelta>');
    console.log('[i] Ejemplo:         node test-vueling.js BCN OVD 2026-09-07 2026-09-10\n');
    return {
      origen: 'BCN',
      destino: 'OVD',
      fechaIda: aISO(lunes),
      fechaVuelta: aISO(jueves),
      porDefecto: true,
    };
  }

  if (args.length !== 4) {
    abortar(
      `Se esperaban 4 argumentos (origen, destino, fechaIda, fechaVuelta) o ninguno. Recibidos: ${args.length}.`
    );
  }

  const [origenCrudo, destinoCrudo, idaCruda, vueltaCruda] = args;

  const origen = validarIATA(origenCrudo, 'origen');
  const destino = validarIATA(destinoCrudo, 'destino');

  if (origen === destino) {
    abortar(`El origen y el destino no pueden ser el mismo aeropuerto (${origen}).`);
  }

  const ida = validarFecha(idaCruda, 'fechaIda');
  const vuelta = validarFecha(vueltaCruda, 'fechaVuelta');

  if (vuelta.fecha < ida.fecha) {
    abortar(`La fechaVuelta (${vuelta.iso}) es anterior a la fechaIda (${ida.iso}).`);
  }

  // Aviso, no error: si buscas en pasado Vueling no te dara nada util.
  const hoy = new Date();
  hoy.setHours(0, 0, 0, 0);
  if (ida.fecha < hoy) {
    abortar(`La fechaIda (${ida.iso}) esta en el pasado.`);
  }

  return { origen, destino, fechaIda: ida.iso, fechaVuelta: vuelta.iso, porDefecto: false };
}

async function main() {
  const consulta = parsearArgumentos(process.argv);

  console.log('='.repeat(70));
  console.log('PRUEBA DE SCRAPING - VUELING');
  console.log('='.repeat(70));
  console.log(`Hoy:    ${aISO(new Date())}`);
  console.log(`Ida:    ${consulta.fechaIda}`);
  console.log(`Vuelta: ${consulta.fechaVuelta}`);
  console.log(`Ruta:   ${consulta.origen} -> ${consulta.destino}`);
  console.log('-'.repeat(70));
  console.log('Se abrira una ventana de Chrome. No la cierres a mano.\n');

  console.time('TIEMPO TOTAL');

  try {
    const vuelos = await buscarVuelos({
      origen: consulta.origen,
      destino: consulta.destino,
      fechaIda: consulta.fechaIda,
      fechaVuelta: consulta.fechaVuelta,
    });

    console.log(`\nEncontrados ${vuelos.length} vuelos.\n`);

    console.table(
      vuelos.map((v) => ({
        Tramo: v.tramo,
        Fecha: v.fecha,
        Ruta: `${v.origen}-${v.destino}`,
        Compania: v.aerolinea,
        Vuelo: v.numeroVuelo ?? '-',
        Salida: v.horaSalida,
        Llegada: v.horaLlegada,
        Duracion: v.duracion,
        Escalas: v.escalas === 0 ? 'Directo' : `${v.escalas} escala(s)`,
        Precio: v.precio != null ? `${v.precio} ${v.moneda}` : '-',
      }))
    );

    // Resumen rapido: el mas barato de cada tramo.
    for (const tramo of ['ida', 'vuelta']) {
      const delTramo = vuelos.filter((v) => v.tramo === tramo && v.precio != null);
      if (!delTramo.length) continue;
      const barato = delTramo.reduce((a, b) => (b.precio < a.precio ? b : a));
      console.log(
        `Mas barato ${tramo}: ${barato.horaSalida}-${barato.horaLlegada} ` +
          `(${barato.numeroVuelo}) por ${barato.precio} ${barato.moneda}`
      );
    }
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
