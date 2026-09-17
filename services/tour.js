/**
 * services/tour.js
 * -----------------------------------------------------------------------------
 * EL ESTADO DEL TOUR DE BIENVENIDA.
 *
 * Dos datos y tres verbos. El guión —qué se señala y qué se dice— NO vive aquí:
 * vive en `public/js/tour.js`, porque es lo que pinta el navegador y porque
 * cambiar un texto no debería obligar a tocar el servidor.
 *
 * QUÉ SE GUARDA, Y POR QUÉ SON DOS COSAS
 *
 *   tour_visto          · '1' cuando se terminó o se saltó. Deja de salir solo.
 *   tour_tramos_vistos  · 'configuracion,destino,ruta' — las pantallas que ya
 *                         enseñaron su tramo.
 *
 * El segundo es el que permite lo que se pidió: que cada pantalla suelte SU
 * tramo la primera vez que se pisa, en vez de las nueve burbujas seguidas el
 * primer día. Sin él solo se podría elegir entre «todo de golpe» o «nada».
 *
 * EN LA BASE, NO EN `localStorage`. Un tour que se vuelve a lanzar solo porque
 * abriste la app en otro navegador es un tour que molesta. Y el flag tiene que
 * poder mirarse desde el servidor para mandarlo en la página.
 */

import { una, ejecutar } from '../db/index.js';
import { ajuste } from './ajustes.js';

const VISTO = 'tour_visto';
const TRAMOS = 'tour_tramos_vistos';

/** Escribe uno de los dos ajustes del tour. Sin pasar por `guardarAjuste`,
 *  que está pensado para claves y se niega a guardar cadenas vacías. */
function poner(clave, valor) {
  ejecutar(
    `INSERT INTO ajustes_instalacion (clave, valor, secreto, actualizado_en)
     VALUES (?, ?, 0, datetime('now'))
     ON CONFLICT (clave) DO UPDATE SET valor = excluded.valor, actualizado_en = datetime('now')`,
    clave,
    String(valor ?? '')
  );
}

/**
 * LO QUE VIAJA A CADA PÁGINA.
 *
 * Va en todas porque cualquiera de ellas puede ser la primera que pise el
 * usuario: no hay un orden obligatorio, y el tour tiene que saber en cualquier
 * pantalla si le toca hablar o callarse.
 */
export function estadoDelTour() {
  const tramos = String(ajuste(TRAMOS) ?? '')
    .split(',')
    .map((t) => t.trim())
    .filter(Boolean);

  return { visto: ajuste(VISTO) === '1', tramos };
}

/** Un tramo acaba de enseñarse: que no vuelva a salir solo. */
export function marcarTramo(tramo) {
  const limpio = String(tramo ?? '').trim();
  if (!limpio || !/^[a-z-]{1,40}$/.test(limpio)) return { error: 'Ese tramo no existe.' };

  const { tramos } = estadoDelTour();
  if (!tramos.includes(limpio)) tramos.push(limpio);
  poner(TRAMOS, tramos.join(','));
  return estadoDelTour();
}

/**
 * SE TERMINÓ O SE SALTÓ, que para esto son lo mismo.
 *
 * Saltar marca TAMBIÉN todos los tramos, y es a propósito: quien dice «saltar»
 * no está diciendo «este tramo no», está diciendo «el tour no». Marcar solo el
 * tramo en curso haría que le saltara otra vez en la pantalla siguiente, que es
 * exactamente lo que acaba de pedir que no pase.
 */
export function marcarVisto(todosLosTramos = []) {
  poner(VISTO, '1');
  if (todosLosTramos.length) poner(TRAMOS, todosLosTramos.join(','));
  return estadoDelTour();
}

/** Volver a empezar: lo que hace la fila camuflada de Ajustes. */
export function reiniciarTour() {
  for (const clave of [VISTO, TRAMOS]) {
    ejecutar('DELETE FROM ajustes_instalacion WHERE clave = ?', clave);
    delete process.env[clave];
  }
  return estadoDelTour();
}

/** Si alguna vez se llegó a ver algo. Lo usa la pantalla para el texto de la fila. */
export function seHaVisto() {
  return Boolean(una('SELECT 1 AS hay FROM ajustes_instalacion WHERE clave = ?', VISTO));
}
