/**
 * test-civitatis.js
 * -----------------------------------------------------------------------------
 * Script de prueba DESECHABLE del proveedor Civitatis.
 *
 *   node test-civitatis.js <destino> [maxResultados]
 *
 * Ejemplos:
 *   node test-civitatis.js berlin
 *   node test-civitatis.js berlin 20
 *   node test-civitatis.js "Nueva York" 10
 */

import { buscarActividades } from './providers/civitatis.js';

const USO = `
Uso:
  node test-civitatis.js <destino> [maxResultados]

Argumentos:
  destino        Ciudad de Civitatis. Acepta acentos y espacios: se convierte
                 al slug de la URL ("Nueva York" -> nueva-york).
  maxResultados  Opcional. Entero positivo, por defecto 30.

Ejemplos:
  node test-civitatis.js berlin
  node test-civitatis.js berlin 20
  node test-civitatis.js "Nueva York" 10
`;

/** Sale con un mensaje de error claro y el modo de empleo. */
function abortar(mensaje) {
  console.error(`\n[X] ${mensaje}`);
  console.error(USO);
  process.exit(1);
}

function parsearArgumentos(argv) {
  const args = argv.slice(2);

  if (args.length === 0) {
    abortar('Falta el destino.');
  }
  if (args.length > 2) {
    abortar(`Sobran argumentos (recibidos ${args.length}, se esperaban 1 o 2).`);
  }

  const [destino, maxCrudo] = args;

  if (!destino.trim()) {
    abortar('El destino no puede estar vacio.');
  }

  let maxResultados = 30;
  if (maxCrudo !== undefined) {
    // Nada de parseInt: "20abc" colaria y no queremos sorpresas.
    if (!/^\d+$/.test(maxCrudo)) {
      abortar(`maxResultados debe ser un numero entero. Recibido: "${maxCrudo}".`);
    }
    maxResultados = Number(maxCrudo);
    if (maxResultados < 1) {
      abortar(`maxResultados debe ser 1 o mas. Recibido: ${maxResultados}.`);
    }
    if (maxResultados > 200) {
      abortar(`maxResultados es demasiado alto (${maxResultados}). Maximo razonable: 200.`);
    }
  }

  return { destino: destino.trim(), maxResultados };
}

/** Recorta un texto a n caracteres, con puntos suspensivos si sobra. */
function recorta(texto, n) {
  if (!texto) return '-';
  return texto.length > n ? `${texto.slice(0, n - 1)}…` : texto;
}

async function main() {
  const { destino, maxResultados } = parsearArgumentos(process.argv);

  console.log('='.repeat(70));
  console.log('PRUEBA DE SCRAPING - CIVITATIS');
  console.log('='.repeat(70));
  console.log(`Destino:        ${destino}`);
  console.log(`Max resultados: ${maxResultados}`);
  console.log('-'.repeat(70));
  console.log('Se abrira una ventana de Chrome. No la cierres a mano.\n');

  console.time('TIEMPO TOTAL');

  try {
    const actividades = await buscarActividades({ destino, maxResultados });

    console.log(`\nEncontradas ${actividades.length} actividades.\n`);

    console.table(
      actividades.map((a) => ({
        Actividad: recorta(a.titulo, 40),
        Precio: a.precio === 0 ? 'Gratis' : a.precio != null ? `${a.precio} ${a.moneda ?? ''}`.trim() : '-',
        Duracion: a.duracion ?? '-',
        Nota: a.valoracion != null ? `${a.valoracion}/10` : '-',
        Opiniones: a.numOpiniones ?? '-',
      }))
    );

    // Un par de datos de contexto, que para eso es una prueba.
    const conNota = actividades.filter((a) => a.valoracion != null);
    if (conNota.length) {
      const mejor = conNota.reduce((a, b) => (b.valoracion > a.valoracion ? b : a));
      console.log(`Mejor valorada: ${mejor.titulo} (${mejor.valoracion}/10, ${mejor.numOpiniones ?? '?'} opiniones)`);
    }
    const conPrecio = actividades.filter((a) => a.precio != null);
    if (conPrecio.length) {
      const barata = conPrecio.reduce((a, b) => (b.precio < a.precio ? b : a));
      console.log(
        `Mas barata:     ${barata.titulo} (${barata.precio === 0 ? 'gratis' : `${barata.precio} ${barata.moneda ?? ''}`.trim()})`
      );
    }
    console.log(`Sin valoracion: ${actividades.length - conNota.length} · sin duracion: ${actividades.filter((a) => !a.duracion).length}`);
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
