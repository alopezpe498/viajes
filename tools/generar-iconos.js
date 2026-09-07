/**
 * tools/generar-iconos.js
 * -----------------------------------------------------------------------------
 * Los iconos de la PWA, dibujados a mano y escritos como PNG de verdad.
 *
 * SIN DEPENDENCIAS, como el resto del proyecto. Un PNG es una firma, tres
 * trozos y un CRC32, y `node:zlib` ya viene en Node: meter `sharp` o `canvas`
 * —doscientos megas de binarios nativos— para pintar un avión sobre un cuadrado
 * azul sería desproporcionado.
 *
 * SE EJECUTA A MANO, no al arrancar:
 *
 *     node tools/generar-iconos.js
 *
 * Los PNG resultantes se quedan en `public/icons` y son los que sirve el
 * manifest. Esto está aquí para poder rehacerlos si cambia el color de marca o
 * hace falta otro tamaño, no porque haya que ejecutarlo nunca más.
 *
 * ZONA SEGURA DE LOS MASKABLE
 * ---------------------------
 * Android recorta el icono con la forma que le dé la gana: círculo, cuadrado
 * redondeado, "squircle"... Lo único garantizado es el círculo central del 80 %
 * del ancho. Por eso hay dos versiones del dibujo:
 *
 *   - `any`      el avión ocupa el 76 % del lienzo. Se ve grande porque nadie
 *                lo va a recortar.
 *   - `maskable` el avión cabe dentro de ese círculo del 80 %, o sea que se
 *                dibuja al 52 %. Parece pequeño mirando el PNG suelto y es
 *                exactamente lo que hay que hacer: en el móvil, recortado,
 *                queda igual que el resto.
 */

import zlib from 'node:zlib';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const DESTINO = path.join(__dirname, '..', 'public', 'icons');

/** Los colores de la app, los mismos que las variables del CSS. */
const FONDO = [0x1b, 0x7f, 0xa6];      // --acento
const GLIFO = [0xff, 0xff, 0xff];

// =============================================================================
// EL DIBUJO
// =============================================================================
/**
 * Un avión visto desde arriba, apuntando hacia arriba.
 *
 * Va en coordenadas de 0 a 1 sobre su propia caja, y solo la mitad derecha: la
 * izquierda es su espejo, que es como se dibuja un avión y como se evita que
 * las dos alas salgan distintas.
 *
 * El orden es el del contorno, de la punta del morro hacia abajo.
 */
const MEDIO_AVION = [
  [0.500, 0.020],   // el morro
  [0.548, 0.150],
  [0.560, 0.380],
  [0.980, 0.610],   // punta del ala
  [0.980, 0.700],
  [0.558, 0.585],
  [0.545, 0.830],
  [0.720, 0.930],   // punta del estabilizador de cola
  [0.720, 0.985],
  [0.500, 0.910],   // el centro de la cola
];

/** El contorno completo: la mitad derecha y su espejo, en orden. */
const AVION = [
  ...MEDIO_AVION,
  ...MEDIO_AVION.slice(0, -1).reverse().map(([x, y]) => [1 - x, y]),
];

/**
 * ¿Cae este punto dentro del polígono? Algoritmo del rayo de toda la vida.
 *
 * Cuenta cuántas veces cruza una recta horizontal hacia la derecha: impar es
 * dentro, par es fuera.
 */
function dentro(poligono, x, y) {
  let esta = false;
  for (let i = 0, j = poligono.length - 1; i < poligono.length; j = i++) {
    const [xi, yi] = poligono[i];
    const [xj, yj] = poligono[j];
    if (yi > y !== yj > y && x < ((xj - xi) * (y - yi)) / (yj - yi) + xi) esta = !esta;
  }
  return esta;
}

/**
 * Pinta el icono en un búfer RGBA.
 *
 * `ocupacion` es qué parte del lienzo llena el avión. El antialiasing se hace
 * por fuerza bruta: cada píxel se mira en una rejilla de 4×4 y se queda con la
 * proporción que cae dentro. Es lento y da igual —son cuatro imágenes— y evita
 * el borde de sierra que se vería en un icono de 512.
 */
function pintar(tamano, ocupacion) {
  const pixeles = Buffer.alloc(tamano * tamano * 4);
  const MUESTRAS = 4;

  // La caja donde vive el avión, centrada.
  const lado = tamano * ocupacion;
  const margen = (tamano - lado) / 2;

  for (let y = 0; y < tamano; y++) {
    for (let x = 0; x < tamano; x++) {
      let dentroCuantas = 0;

      for (let sy = 0; sy < MUESTRAS; sy++) {
        for (let sx = 0; sx < MUESTRAS; sx++) {
          const px = x + (sx + 0.5) / MUESTRAS;
          const py = y + (sy + 0.5) / MUESTRAS;
          const u = (px - margen) / lado;
          const v = (py - margen) / lado;
          if (u >= 0 && u <= 1 && v >= 0 && v <= 1 && dentro(AVION, u, v)) dentroCuantas++;
        }
      }

      const t = dentroCuantas / (MUESTRAS * MUESTRAS);
      const i = (y * tamano + x) * 4;
      // El glifo se mezcla sobre el fondo: nada es transparente, que un maskable
      // con agujeros se ve fatal recortado.
      pixeles[i] = Math.round(FONDO[0] + (GLIFO[0] - FONDO[0]) * t);
      pixeles[i + 1] = Math.round(FONDO[1] + (GLIFO[1] - FONDO[1]) * t);
      pixeles[i + 2] = Math.round(FONDO[2] + (GLIFO[2] - FONDO[2]) * t);
      pixeles[i + 3] = 255;
    }
  }
  return pixeles;
}

// =============================================================================
// ESCRIBIR EL PNG
// =============================================================================
/** La tabla del CRC32, que es lo que valida cada trozo del PNG. */
const TABLA_CRC = (() => {
  const t = new Int32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[n] = c;
  }
  return t;
})();

function crc32(buf) {
  let c = -1;
  for (const b of buf) c = TABLA_CRC[(c ^ b) & 0xff] ^ (c >>> 8);
  return (c ^ -1) >>> 0;
}

/** Un trozo del PNG: longitud, tipo, datos y su CRC. */
function trozo(tipo, datos) {
  const longitud = Buffer.alloc(4);
  longitud.writeUInt32BE(datos.length);

  const cuerpo = Buffer.concat([Buffer.from(tipo, 'ascii'), datos]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(cuerpo));

  return Buffer.concat([longitud, cuerpo, crc]);
}

/** RGBA en crudo -> PNG. */
function comoPNG(pixeles, tamano) {
  const FIRMA = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(tamano, 0);
  ihdr.writeUInt32BE(tamano, 4);
  ihdr[8] = 8;    // 8 bits por canal
  ihdr[9] = 6;    // RGBA
  ihdr[10] = 0;   // compresión: deflate, la única que hay
  ihdr[11] = 0;   // filtro: el estándar
  ihdr[12] = 0;   // sin entrelazar

  // Cada línea lleva delante su byte de filtro. Con 0 ("ninguno") el PNG pesa
  // algo más, pero para cuatro iconos de un color plano da igual y el código se
  // lee de una vez.
  const crudo = Buffer.alloc((tamano * 4 + 1) * tamano);
  for (let y = 0; y < tamano; y++) {
    const destino = y * (tamano * 4 + 1);
    crudo[destino] = 0;
    pixeles.copy(crudo, destino + 1, y * tamano * 4, (y + 1) * tamano * 4);
  }

  return Buffer.concat([
    FIRMA,
    trozo('IHDR', ihdr),
    trozo('IDAT', zlib.deflateSync(crudo, { level: 9 })),
    trozo('IEND', Buffer.alloc(0)),
  ]);
}

// =============================================================================
// A GENERAR
// =============================================================================
/**
 * `any` llena el 76 %: nadie lo va a recortar y se quiere que se vea.
 * `maskable` se queda en el 52 % para caber en el círculo central del 80 %,
 * que es lo único que Android garantiza que no recorta.
 */
const ICONOS = [
  { archivo: 'icono-192.png', tamano: 192, ocupacion: 0.76 },
  { archivo: 'icono-512.png', tamano: 512, ocupacion: 0.76 },
  { archivo: 'icono-maskable-192.png', tamano: 192, ocupacion: 0.52 },
  { archivo: 'icono-maskable-512.png', tamano: 512, ocupacion: 0.52 },
  // iOS no aplica máscara: recorta él las esquinas y le viene bien el grande.
  { archivo: 'apple-touch-icon.png', tamano: 180, ocupacion: 0.72 },
];

fs.mkdirSync(DESTINO, { recursive: true });

for (const { archivo, tamano, ocupacion } of ICONOS) {
  const png = comoPNG(pintar(tamano, ocupacion), tamano);
  fs.writeFileSync(path.join(DESTINO, archivo), png);
  console.log(`  ${archivo.padEnd(26)} ${tamano}x${tamano}  ${(png.length / 1024).toFixed(1)} KB`);
}

console.log(`\nEscritos en ${DESTINO}`);
