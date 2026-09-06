/**
 * services/adjuntos.js
 * -----------------------------------------------------------------------------
 * LOS ADJUNTOS: el billete, la confirmación del hotel, el bono de la excursión.
 *
 * Todo eso llega por correo en PDF o como foto y hasta ahora no tenía sitio:
 * acababa en la galería del móvil, perdido. Ahora cuelga del elemento al que
 * pertenece y viaja dentro del ZIP del dosier.
 *
 * DÓNDE VIVEN. Los archivos en disco, la ficha en la base:
 *
 *   adjuntos/viaje-35/transporte/66/1757...-billete-ida.pdf
 *
 * En base solo va el nombre del archivo, nunca la ruta entera: si algún día
 * cambia la carpeta, se cambia aquí y ya está.
 *
 * LOS NOMBRES SE SANEAN SIEMPRE. Lo que llega es el nombre que el usuario tenía
 * en su ordenador, y eso puede traer barras, dos puntos, "..", acentos o
 * cualquier cosa. Se guarda con un nombre nuevo —marca de tiempo más un nombre
 * limpio— y el original solo se conserva para enseñarlo.
 */

import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { todas, una, ejecutar } from '../db/index.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

/** La carpeta raíz de los adjuntos. Fuera de `public/`: se sirven a mano. */
export const CARPETA = path.join(__dirname, '..', 'adjuntos');

/** Tope por archivo. Un billete o una confirmación no pesan más que esto. */
export const TOPE = 15 * 1024 * 1024;

/**
 * Lo que se acepta. Solo papeles: un PDF o una foto.
 *
 * El HEIC está porque es lo que hace un iPhone por defecto y sería absurdo
 * rechazar la foto que acabas de hacerle al billete. No se convierte a nada: se
 * guarda tal cual y el navegador lo abrirá o lo descargará según pueda.
 */
const ACEPTADOS = new Map([
  ['application/pdf', '.pdf'],
  ['image/jpeg', '.jpg'],
  ['image/png', '.png'],
  ['image/heic', '.heic'],
  ['image/heif', '.heic'],
]);

const TIPOS = ['transporte', 'alojamiento', 'excursion'];

/** Qué se le dice a alguien que intenta subir un .docx. */
export const LO_QUE_SE_ACEPTA = 'Solo PDF o imágenes (JPG, PNG, HEIC).';

/** El nombre, sin nada que pueda salirse de su carpeta. */
function sanear(nombre) {
  return String(nombre ?? '')
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .replace(/[^a-zA-Z0-9._-]+/g, '-')
    .replace(/^[-.]+|[-.]+$/g, '')
    .slice(0, 60)
    .toLowerCase() || 'archivo';
}

/** La carpeta de un elemento concreto. */
function carpetaDe(viajeId, tipo, elementoId) {
  return path.join(CARPETA, `viaje-${viajeId}`, tipo, String(elementoId));
}

/** La ruta completa de un adjunto ya guardado. */
export function rutaDe(adjunto) {
  return path.join(
    carpetaDe(adjunto.viaje_id, adjunto.tipo_elemento, adjunto.elemento_id),
    adjunto.nombre_archivo
  );
}

/** "1.2 MB" · "340 KB" */
export function comoTamano(bytes) {
  const n = Number(bytes) || 0;
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${Math.round(n / 1024)} KB`;
  return `${(n / 1024 / 1024).toFixed(1)} MB`;
}

/**
 * Guarda un archivo subido.
 *
 * Devuelve { ok: false, error } en vez de lanzar cuando el problema es del
 * archivo (tipo no admitido, demasiado grande): eso no es una excepción, es una
 * respuesta que la pantalla tiene que poder enseñar tal cual.
 */
export async function guardarAdjunto({ viajeId, tipo, elementoId, nombre, mime, datos }) {
  if (!TIPOS.includes(tipo)) return { ok: false, error: 'Ese tipo de elemento no existe.' };
  if (!datos?.length) return { ok: false, error: 'El archivo llegó vacío.' };
  if (datos.length > TOPE) {
    return { ok: false, error: `El archivo pesa ${comoTamano(datos.length)}; el máximo son ${comoTamano(TOPE)}.` };
  }

  const limpio = String(mime ?? '').split(';')[0].trim().toLowerCase();
  const extension = ACEPTADOS.get(limpio);
  if (!extension) return { ok: false, error: LO_QUE_SE_ACEPTA };

  const carpeta = carpetaDe(viajeId, tipo, elementoId);
  await fs.mkdir(carpeta, { recursive: true });

  // Nombre único: dos billetes que se llamen igual tienen que convivir.
  const base = sanear(String(nombre ?? '').replace(/\.[^.]+$/, ''));
  const enDisco = `${Date.now()}-${base}${extension}`;
  await fs.writeFile(path.join(carpeta, enDisco), datos);

  const r = ejecutar(
    `INSERT INTO adjuntos
       (viaje_id, tipo_elemento, elemento_id, nombre_archivo, nombre_original, mime, tamano)
     VALUES (?, ?, ?, ?, ?, ?, ?)`,
    viajeId,
    tipo,
    elementoId,
    enDisco,
    String(nombre ?? enDisco).slice(0, 200),
    limpio,
    datos.length
  );

  console.log(`[adjuntos] Viaje #${viajeId}: «${nombre}» (${comoTamano(datos.length)}) en ${tipo}/${elementoId}.`);
  return { ok: true, adjunto: adjuntoPorId(Number(r.lastInsertRowid)) };
}

/** Un adjunto por su id. */
export const adjuntoPorId = (id) => una('SELECT * FROM adjuntos WHERE id = ?', Number(id));

/** Los adjuntos de un elemento, listos para pintar. */
export function adjuntosDe(tipo, elementoId) {
  return todas(
    'SELECT * FROM adjuntos WHERE tipo_elemento = ? AND elemento_id = ? ORDER BY subido_en, id',
    tipo,
    Number(elementoId)
  ).map((a) => ({ ...a, tamanoTexto: comoTamano(a.tamano) }));
}

/** Cuántos tiene cada elemento de una lista, de una sola consulta. */
export function cuentaDeAdjuntos(tipo, ids) {
  if (!ids?.length) return new Map();
  const filas = todas(
    `SELECT elemento_id, COUNT(*) AS n FROM adjuntos
      WHERE tipo_elemento = ? AND elemento_id IN (${ids.map(() => '?').join(',')})
      GROUP BY elemento_id`,
    tipo,
    ...ids
  );
  return new Map(filas.map((f) => [f.elemento_id, f.n]));
}

/** Todos los del viaje, que es lo que necesita el dosier. */
export function adjuntosDelViaje(viajeId) {
  return todas(
    'SELECT * FROM adjuntos WHERE viaje_id = ? ORDER BY tipo_elemento, elemento_id, id',
    Number(viajeId)
  );
}

/** Borra uno: primero el archivo, después la fila. */
export async function borrarAdjunto(id) {
  const a = adjuntoPorId(id);
  if (!a) return false;

  // Si el archivo ya no está, da igual: lo que no puede quedarse es la fila.
  await fs.rm(rutaDe(a), { force: true }).catch(() => {});
  ejecutar('DELETE FROM adjuntos WHERE id = ?', a.id);
  return true;
}

/**
 * Borra todos los de un elemento. Se llama al borrar el elemento en sí: un tramo
 * que desaparece, un hotel que se suelta, una excursión que se desapunta.
 */
export async function borrarAdjuntosDe(tipo, elementoId) {
  const suyos = adjuntosDe(tipo, elementoId);
  if (!suyos.length) return 0;

  for (const a of suyos) await fs.rm(rutaDe(a), { force: true }).catch(() => {});
  await fs.rm(carpetaDe(suyos[0].viaje_id, tipo, elementoId), { recursive: true, force: true }).catch(() => {});
  ejecutar('DELETE FROM adjuntos WHERE tipo_elemento = ? AND elemento_id = ?', tipo, Number(elementoId));

  console.log(`[adjuntos] ${suyos.length} adjunto/s borrado/s de ${tipo}/${elementoId}.`);
  return suyos.length;
}

/**
 * Red de seguridad: se lleva los adjuntos cuyo elemento ya no existe.
 *
 * `borrarAdjuntosDe` cubre los borrados que pasan por un sitio evidente, pero
 * hay caminos que no: recalcular la ruta borra tramos de golpe, y refrescar los
 * hoteles borra los candidatos no marcados. En vez de perseguir cada uno —y
 * olvidarme del próximo—, esto se pasa por lo que hay y limpia lo que sobra.
 * Se llama al listar y al generar el dosier, que es cuando importa.
 */
export async function limpiarAdjuntosHuerfanos(viajeId) {
  const suyos = adjuntosDelViaje(viajeId);
  let limpiados = 0;

  for (const a of suyos) {
    const existe =
      a.tipo_elemento === 'transporte'
        ? una('SELECT 1 FROM transportes WHERE id = ?', a.elemento_id)
        : una('SELECT 1 FROM candidatos WHERE id = ?', a.elemento_id);
    if (existe) continue;

    await fs.rm(rutaDe(a), { force: true }).catch(() => {});
    ejecutar('DELETE FROM adjuntos WHERE id = ?', a.id);
    limpiados++;
  }

  if (limpiados) {
    console.log(`[adjuntos] Viaje #${viajeId}: ${limpiados} adjunto/s huérfano/s limpiado/s.`);
  }
  return limpiados;
}

/** Se lleva la carpeta entera de un viaje. Para cuando se borra el viaje. */
export async function borrarAdjuntosDelViaje(viajeId) {
  await fs.rm(path.join(CARPETA, `viaje-${viajeId}`), { recursive: true, force: true }).catch(() => {});
  // Las filas se van solas: `adjuntos.viaje_id` tiene ON DELETE CASCADE.
}
