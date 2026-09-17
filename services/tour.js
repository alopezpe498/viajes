/**
 * services/tour.js
 * -----------------------------------------------------------------------------
 * EL ESTADO DEL TOUR DE BIENVENIDA.
 *
 * UN DATO Y TRES VERBOS. El guión —las seis pantallas y lo que se dice de cada
 * una— NO vive aquí: vive en `public/js/tour.js`, porque es lo que pinta el
 * navegador y porque cambiar una frase no debería obligar a tocar el servidor.
 *
 *   tour_visto · '1' cuando se terminó o se saltó. Deja de salir solo.
 *
 * AQUÍ HABÍA UN SEGUNDO DATO, `tour_tramos_vistos`, y sobra desde que el tour es
 * una sola parada en la portada. Servía para que cada pantalla soltara SU tramo
 * la primera vez que la pisabas; se quitó porque interrumpía a alguien que ya
 * estaba haciendo algo y, sobre todo, porque así nunca se llegaba a ver el
 * CONJUNTO, que es lo único que de verdad no se entiende al principio.
 *
 * EN LA BASE, NO EN `localStorage`. Un tour que se vuelve a lanzar solo porque
 * abriste la app en otro navegador es un tour que molesta. Y el flag tiene que
 * poder mirarse desde el servidor para mandarlo en la página.
 */

import { una, ejecutar } from '../db/index.js';
import { ajuste } from './ajustes.js';

const VISTO = 'tour_visto';

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
  return { visto: ajuste(VISTO) === '1' };
}

/** Se terminó o se saltó, que para esto son lo mismo. */
export function marcarVisto() {
  poner(VISTO, '1');
  return estadoDelTour();
}

/** Volver a empezar: lo que hace la fila camuflada de Ajustes. */
export function reiniciarTour() {
  // Se borra también la clave vieja de los tramos: una instalación que venga del
  // tour anterior la tiene guardada y ya no la lee nadie.
  for (const clave of [VISTO, 'tour_tramos_vistos']) {
    ejecutar('DELETE FROM ajustes_instalacion WHERE clave = ?', clave);
    delete process.env[clave];
  }
  return estadoDelTour();
}

/** Si alguna vez se llegó a ver algo. Lo usa la pantalla para el texto de la fila. */
export function seHaVisto() {
  return Boolean(una('SELECT 1 AS hay FROM ajustes_instalacion WHERE clave = ?', VISTO));
}
