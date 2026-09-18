/**
 * EL MISMO SITIO GUARDADO DOS VECES, CON DOS NOMBRES
 *
 *   node tools/el-mismo-sitio-dos-veces.js
 *
 * Los busca por el `place_id` de Google, que es una IDENTIDAD y no un parecido:
 * si Google contesta lo mismo a dos preguntas, son el mismo lugar.
 *
 * POR QUÉ NO POR NOMBRE, que es lo primero que se intentó. Medido sobre el
 * catálogo entero comparando solape de palabras: 20 parejas sospechosas y 19
 * eran FALSOS POSITIVOS. «Museo Arqueológico de Tesalónica» y «Museo Bizantino
 * de Tesalónica» comparten dos palabras de tres y son museos distintos; lo mismo
 * «Iglesia de San Pedro y San Pablo» contra «Iglesia de San Andrés». Y el caso
 * que sabemos que existe —«Mercado Central de Atenas» y «Mercado de Varvakios»—
 * NO aparecía, porque los dos nombres no comparten ni una palabra.
 *
 * Un detector con 19 falsos de 20 y que se deja el único verdadero no es un
 * detector: es ruido.
 *
 * POR QUÉ TAMPOCO POR COORDENADA. Sirve para el amontonamiento —y para eso está
 * la guarda de la coordenada compartida— pero no distingue «el mismo sitio con
 * dos nombres» de «dos sitios distintos a los que Google dio el mismo centroide
 * de zona». En Kairuan había CINCO sitios distintos en un punto.
 *
 * DE DÓNDE SALEN ESTOS DUPLICADOS, que son tres fuentes y van a más:
 *
 *   · la misma ciudad investigada dos veces bautiza distinto;
 *   · el complemento por perfil añade lo que su perfil llama de otra manera
 *     («Mercado de Varvakios» donde ya había «Mercado Central de Atenas»);
 *   · las búsquedas a mano de la pestaña de sitios.
 *
 * SOLO LEE Y DICE. No funde nada: cuál de los dos nombres se queda es una
 * decisión de quien mira el viaje, y `cubierto_por` ya existe para marcarlo.
 */

import { todas } from '../db/index.js';

const filas = todas(
  `SELECT s.id, s.nombre, s.bloque, s.orden, d.place_id, d.direccion,
          p.nombre AS ciudad, p.id AS pid
     FROM sitios_lugar s
     JOIN puntos_interes p ON p.id = s.punto_interes_id
     JOIN direcciones d ON d.tipo_elemento = 'sitio' AND d.elemento_id = s.id
    WHERE d.place_id IS NOT NULL AND s.bloque <> 'busqueda'
    ORDER BY p.nombre, s.orden`
);

const total = todas(
  "SELECT COUNT(*) AS n FROM sitios_lugar WHERE bloque <> 'busqueda'"
)[0].n;

console.log('# EL MISMO SITIO GUARDADO DOS VECES\n');
console.log(`${filas.length} de ${total} sitios tienen identificador de Google.\n`);

if (!filas.length) {
  // EL DATO SE LLENA SOLO HACIA DELANTE. La columna es nueva y las filas viejas
  // no lo tienen: se rellena la próxima vez que se sitúe cada sitio. Decirlo es
  // mejor que un «0 duplicados» que se leería como «está limpio».
  console.log('Ninguno lo tiene todavía: la columna es nueva y se rellena al situar.');
  console.log('Genera un viaje, o sitúa una ciudad, y vuelve a pasar esto.');
  process.exit(0);
}

const porLugar = new Map();
for (const f of filas) {
  const clave = `${f.pid}|${f.place_id}`;
  if (!porLugar.has(clave)) porLugar.set(clave, []);
  porLugar.get(clave).push(f);
}

const repetidos = [...porLugar.values()].filter((v) => v.length > 1);

if (!repetidos.length) {
  console.log('Ninguno repetido entre los que tienen identificador.');
} else {
  console.log(`${repetidos.length} lugar(es) guardados más de una vez:\n`);
  for (const grupo of repetidos) {
    console.log(`  ${grupo[0].ciudad} · ${grupo[0].direccion ?? 'sin dirección'}`);
    for (const g of grupo) {
      console.log(`     [${g.bloque} #${g.orden}] ${g.nombre}`);
    }
    console.log('');
  }
  console.log('  No se funde nada: cuál de los nombres se queda lo decides tú.');
  console.log('  `cubierto_por` es el campo para marcar que uno se ve dentro del otro.');
}

const sinId = total - filas.length;
if (sinId > 0) {
  console.log(`\n${sinId} sitio(s) todavía sin identificador: no se puede decir nada de ellos.`);
}
