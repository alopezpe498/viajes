/**
 * app.js
 * -----------------------------------------------------------------------------
 * Servidor Express del generador de viajes.
 *
 * Arranca en http://localhost:3000, crea el esquema de la BD si no existe y
 * siembra un viaje de ejemplo la primera vez.
 */

import express from 'express';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { crearEsquema, migrarEsquema } from './db/index.js';
import { sembrarSiHaceFalta } from './db/seed.js';
import { router } from './routes/viajes.js';
import { arrancarWorker } from './jobs/worker.js';
import { hayClaveIA } from './lib/ia.js';
import { hayClaveGoogle } from './lib/google.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

const PUERTO = process.env.PORT || 3000;
const app = express();

// --- Plantillas ------------------------------------------------------------
app.set('view engine', 'ejs');
app.set('views', path.join(__dirname, 'views'));

// --- Estaticos y formularios ----------------------------------------------
app.use(express.static(path.join(__dirname, 'public')));
app.use(express.urlencoded({ extended: false })); // formularios normales
app.use(express.json());                          // fetch del marcado

// --- Rutas -----------------------------------------------------------------
app.use('/', router);

// 404 sencillo
app.use((req, res) => {
  res.status(404).send('Página no encontrada. <a href="/">Volver a mis viajes</a>');
});

// Errores: los enseñamos en consola y damos un mensaje legible en pantalla.
app.use((err, req, res, _next) => {
  console.error('[error]', err);
  res.status(500).send('Se ha roto algo por dentro. Mira la consola del servidor.');
});

// --- Arranque --------------------------------------------------------------
crearEsquema();
migrarEsquema();   // añade columnas nuevas y renumera pasos si hace falta
sembrarSiHaceFalta();

// La cola de scraping vive dentro de este mismo proceso: marca como
// interrumpidos los trabajos que quedaron a medias y se pone a escuchar.
arrancarWorker();

const servidor = app.listen(PUERTO, () => {
  console.log('');
  console.log('  Generador de viajes en marcha');
  console.log(`  → http://localhost:${PUERTO}`);
  console.log('');
  console.log('  Datos REALES por la cola: actividades (Civitatis),');
  console.log('  vuelos (Kayak), hoteles (Booking) y avisos');
  console.log('  (Open-Meteo, Exteriores y Nager.Date).');
  console.log('');

  // Avisar aqui de que falta la clave ahorra el viaje de escribir un destino,
  // esperar a la cola y encontrarse el error en pantalla.
  if (!hayClaveIA()) {
    console.log('  [!] Sin ANTHROPIC_API_KEY: la pantalla de descubrir destino');
    console.log('      no podra investigar nada. Copia .env.ejemplo a .env,');
    console.log('      pon tu clave y reinicia. Lo demas funciona igual.');
    console.log('');
  }

  // Con que fuente se van a calcular direcciones y traslados. Se dice al
  // arrancar porque desde fuera no hay forma de saberlo mirando la pantalla:
  // "12 min en coche" se ve igual lo diga Google o lo diga OSRM.
  if (hayClaveGoogle()) {
    console.log('  Direcciones y traslados: Google primero (clave de servidor),');
    console.log('  con Nominatim y OSRM de respaldo. En local la clave esta');
    console.log('  restringida por IP y fallara: se vera en el log y se usara');
    console.log('  el respaldo, que no da transporte publico.');
  } else {
    console.log('  Direcciones y traslados: Nominatim y OSRM (sin clave de Google).');
    console.log('  Sin transporte publico: eso solo lo sabe Google.');
  }
  console.log('');
});

// Si el puerto ya está pillado, un mensaje util en vez de un volcado de pila.
// (Pasa facil: el 3000 es el puerto por defecto de medio mundo.)
servidor.on('error', (err) => {
  if (err.code === 'EADDRINUSE') {
    console.error('');
    console.error(`  [X] El puerto ${PUERTO} ya está ocupado por otro programa.`);
    console.error('');
    console.error('      Opciones:');
    console.error('        - Para el otro programa y vuelve a lanzar: npm start');
    console.error(`        - O arranca en otro puerto:  PORT=3001 npm start`);
    console.error('          (en PowerShell:  $env:PORT=3001; npm start)');
    console.error('');
    process.exit(1);
  }
  throw err;
});
