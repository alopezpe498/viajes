/**
 * ¿ZONA O EDIFICIO? Rellena `sitios_lugar.es_zona` en los sitios que no lo tienen.
 *
 *   node tools/marcar-zonas.js              (dice qué haría)
 *   node tools/marcar-zonas.js --de-verdad
 *
 * `situarLosSitios` ya lo apunta al situar cada sitio con Google. Esto es para
 * los que se situaron antes de que existiera la columna, y SOLO para los largos
 * —180 minutos o más—, que son los únicos que pueden dejar una parada como
 * «corta» por no caber enteros. Una consulta a Google por sitio.
 */
import { todas, ejecutar, una } from '../db/index.js';
import { situarLugarConGoogle } from '../lib/google.js';
import { esZonaSegunGoogle } from '../services/direcciones.js';
import { minutosDeVisita } from '../services/lienzo.js';

const deVerdad = process.argv.includes('--de-verdad');

const largos = todas(
  `SELECT s.id, s.nombre, s.tiempo_visita, s.punto_interes_id AS punto
     FROM sitios_lugar s
    WHERE s.es_zona IS NULL AND s.cubierto_por IS NULL AND s.tiempo_visita IS NOT NULL`
).filter((s) => (minutosDeVisita(s.tiempo_visita) ?? 0) >= 180);

console.log(`${largos.length} sitio(s) de 180 min o más sin saber si son zona.`);
let zonas = 0;
for (const s of largos) {
  const ciudad = una('SELECT nombre FROM puntos_interes WHERE id = ?', s.punto)?.nombre ?? '';
  if (!deVerdad) {
    console.log(`  · ${s.nombre} (${ciudad}, ${s.tiempo_visita})`);
    continue;
  }
  const r = await situarLugarConGoogle(`${s.nombre}, ${ciudad}`, null).catch(() => null);
  const zona = esZonaSegunGoogle(r?.tipos);
  if (zona != null) ejecutar('UPDATE sitios_lugar SET es_zona = ? WHERE id = ?', zona, s.id);
  if (zona === 1) zonas += 1;
  console.log(`  ${zona === 1 ? 'ZONA   ' : zona === 0 ? 'edificio' : '¿?     '} ${s.nombre} (${ciudad}) ${JSON.stringify(r?.tipos ?? [])}`);
}
if (!deVerdad) console.log('\n(solo lo he dicho; con --de-verdad lo hago)');
else console.log(`\n${zonas} zona(s) de ${largos.length}.`);
