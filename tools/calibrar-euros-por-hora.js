/**
 * ¿CON QUÉ TASA HABRÍA GANADO OTRA PUERTA?
 *
 *   node tools/calibrar-euros-por-hora.js [viaje...]
 *
 * PARA QUÉ EXISTE. `euros_por_hora_util` se tuvo que declarar a ojo porque no
 * había con qué medirlo: de cada viaje solo se guardaba el vuelo de la puerta
 * ganadora, así que no existía el precio de las perdedoras. Desde que
 * `puertas_probadas` guarda todas las combinaciones con sus sumandos por
 * separado, la pregunta se puede contestar.
 *
 * QUÉ HACE, y nada más: recalcula el ranking con distintas tasas y dice a partir
 * de cuál cambia el ganador. No toca el parámetro ni escribe nada; el número lo
 * pones tú en /orquestador cuando veas los datos.
 *
 * CÓMO LEERLO. Si en todos tus viajes hace falta una tasa absurdamente baja para
 * mover algo, el precio pesa poco y puedes bajarla. Si con la tasa de hoy ya
 * cambia el ganador en la mitad de los viajes, manda demasiado y hay que subirla.
 * El punto bueno es el que mueve las decisiones ajustadas y deja quietas las
 * claras — que es el criterio con el que se puso 30 de fábrica, sin datos.
 *
 * SOLO LEE.
 */

import { todas, una } from '../db/index.js';
import { parametro } from '../services/orquestador.js';

const PEDIDOS = process.argv.slice(2).map(Number).filter(Boolean);

const viajes = PEDIDOS.length
  ? PEDIDOS
  : todas('SELECT DISTINCT viaje_id FROM puertas_probadas ORDER BY viaje_id DESC').map((r) => r.viaje_id);

if (!viajes.length) {
  console.log('Todavía no hay ningún viaje con puertas apuntadas.');
  console.log('El diario se escribe al generar un viaje, en la fase «ciudades y noches».');
  process.exit(0);
}

const TASA_HOY = parametro('euros_por_hora_util', 30);
const TASAS = [5, 10, 15, 20, 30, 50, 100];

console.log(`# ¿CON QUÉ TASA HABRÍA GANADO OTRA PUERTA?\n`);
console.log(`tasa puesta hoy: ${TASA_HOY} €/h · ${viajes.length} viaje(s) con diario\n`);

for (const viajeId of viajes) {
  const filas = todas(
    `SELECT * FROM puertas_probadas WHERE viaje_id = ? AND reparto IS NOT NULL
      ORDER BY puntos DESC`,
    viajeId
  );
  if (filas.length < 2) continue;

  const v = una('SELECT destino FROM viajes WHERE id = ?', viajeId);
  console.log(`## Viaje ${viajeId}${v?.destino ? ` · ${v.destino}` : ''}\n`);

  if (filas.some((f) => f.precio == null)) {
    console.log('  Falta el precio de alguna combinación: aquí el precio no puntuó.\n');
  }

  // LA BASE ES LA PUNTUACIÓN SIN EL PRECIO. `coste_precio` es lo que se restó
  // con la tasa de ese día, así que devolviéndolo se recupera el punto de
  // partida y desde ahí se puede aplicar cualquier otra.
  const pesoMedio = filas[0].coste_precio && filas[0].precio
    ? (filas[0].coste_precio * TASA_HOY) / filas[0].precio
    : 1;

  const conTasa = (t) =>
    filas
      .map((f) => ({
        que: `${f.combinacion} ${f.entrada}→${f.salida}`,
        precio: f.precio,
        puntos: f.puntos + (f.coste_precio ?? 0) - (t > 0 && f.precio != null ? (f.precio / t) * pesoMedio : 0),
      }))
      .sort((a, b) => b.puntos - a.puntos);

  const sinPrecio = conTasa(0);
  console.log(`  sin contar el precio gana:  ${sinPrecio[0].que}  (${sinPrecio[0].puntos.toFixed(1)})`);
  console.log(`     la segunda:              ${sinPrecio[1].que}  (${sinPrecio[1].puntos.toFixed(1)}), ` +
    `margen ${(sinPrecio[0].puntos - sinPrecio[1].puntos).toFixed(1)}`);
  console.log(`  precios: ${filas.map((f) => `${f.combinacion} ${f.precio == null ? '—' : `${Math.round(f.precio)} €`}`).join(' · ')}\n`);

  console.log('  tasa      gana                                  ¿cambia?');
  for (const t of TASAS) {
    const r = conTasa(t);
    const cambia = r[0].que !== sinPrecio[0].que;
    console.log(
      `  ${String(t + ' €/h').padEnd(9)} ${r[0].que.padEnd(38)} ${cambia ? 'SÍ' : 'no'}` +
        `${t === TASA_HOY ? '   <- la puesta hoy' : ''}`
    );
  }
  console.log('');
}
