/**
 * services/plantillas.js
 * -----------------------------------------------------------------------------
 * PLANTILLAS DE CONFIGURACIÓN: dejar de teclear lo mismo en cada viaje.
 *
 * Quien siempre viaja en pareja, con ritmo normal, saliendo de Barcelona y con
 * las mismas manías de hotel, rellena doce campos idénticos cada vez. Una
 * plantilla los guarda con un nombre y el paso 1 los carga.
 *
 * ESTO NO TOCA EL MOTOR. No cambia cómo se monta un viaje, ni los modelos de IA,
 * ni los parámetros del orquestador —que son globales y no se rellenan por
 * viaje—. Solo ahorra tecleo.
 *
 * NO GUARDA DESTINO NI FECHAS, y es la decisión que hace útil la funcionalidad:
 * son lo único que de verdad cambia de un viaje a otro. Copiarlas convertiría la
 * plantilla en un viaje clonado, que es otra cosa y no es esta.
 *
 * ───────────────────────────────────────────────────────────────────────────
 * LA PLANTILLA ACTÚA SOBRE EL VIAJE, NO SOBRE EL FORMULARIO.
 *
 * Lo natural parecía rellenar los campos de la pantalla con JavaScript. No vale,
 * por dos razones y la segunda es definitiva:
 *
 *   1. Los widgets del paso 1 —contadores, chips, segmentos, las edades que se
 *      generan solas— guardan su estado en variables de clausura de
 *      `public/js/configuracion.js` y arrancan leyendo `data-inicial`, que pinta
 *      el servidor. No hay setter que llamar desde fuera.
 *   2. `filtros_hoteles` y `filtros_vuelos` NO ESTÁN en ese formulario: se
 *      editan en los pasos 5 y 6. No hay campo que rellenar.
 *
 * Así que cargar escribe en las columnas del viaje y se vuelve al paso 1, que se
 * pinta relleno con el JS de siempre. Una sola mecánica para las doce cosas.
 * ───────────────────────────────────────────────────────────────────────────
 *
 * DOS REGLAS AL CARGAR, Y LAS DOS SON DE SEGURIDAD:
 *
 *   · LO QUE LA PLANTILLA NO TRAE, NO SE TOCA. Se escribe solo lo que está en el
 *     JSON. Nunca un `null` porque falte una clave: una plantilla de antes de que
 *     existiera un campo no puede borrar ese campo del viaje.
 *   · NADA ENTRA CRUDO. Cada valor pasa por el mismo normalizador que ya usa el
 *     formulario. Una plantilla guardada hace seis meses puede traer un ritmo
 *     retirado o una categoría que ya no existe, y eso no puede acabar en la
 *     base solo porque venga de un sitio de confianza.
 */

import { todas, una, ejecutar, normalizarNombre } from '../db/index.js';
import {
  TIPOS_VIAJE,
  RITMOS,
  configAuto,
  OPCIONES_AUTO,
} from './orquestador.js';
import { filtrosHotelesDe, normalizarFiltrosVuelos } from './proveedores.js';
import { CATEGORIAS_SITIO } from './descubrir.js';

/** Los doce valores que copia una plantilla. Ni destino ni fechas. */
const CAMPOS = [
  'adultos',
  'ninos',
  'edades_ninos',
  'ciudad_origen',
  'tipo_viaje',
  'ritmo',
  'presupuesto',
  'revision_reparto',
  'automatico',
  'config_auto',
  'filtros_hoteles',
  'filtros_vuelos',
];

/** Los mismos topes que el paso 1. */
const MAX_ADULTOS = 9;
const MAX_NINOS = 6;
const MAX_EDAD = 17;

const entre = (v, min, max, porDefecto) => {
  const n = Number(v);
  return Number.isFinite(n) ? Math.min(Math.max(Math.round(n), min), max) : porDefecto;
};

/** JSON de la base a objeto, sin reventar si viene roto. */
function comoObjeto(valor) {
  if (valor && typeof valor === 'object') return valor;
  try {
    return valor ? JSON.parse(valor) : null;
  } catch {
    return null;
  }
}

// =============================================================================
// LA FOTO: de un viaje a una plantilla
// =============================================================================
/**
 * Los ajustes de un viaje, listos para guardarse como plantilla.
 *
 * Se lee de la FILA YA GUARDADA y no del formulario, y eso es lo que hace que
 * los filtros de los pasos 5 y 6 entren sin pedirlos: están en sus columnas.
 *
 * Los tres JSON se guardan como OBJETO, no como la cadena que hay en la base:
 * un JSON dentro de otro en texto es ilegible y se escapa dos veces.
 */
export function ajustesDelViaje(viaje) {
  if (!viaje) return null;

  return {
    adultos: viaje.adultos ?? 2,
    ninos: viaje.ninos ?? 0,
    edades_ninos: comoObjeto(viaje.edades_ninos) ?? [],
    ciudad_origen: viaje.ciudad_origen ?? 'Barcelona',
    tipo_viaje: viaje.tipo_viaje ?? '',
    ritmo: viaje.ritmo ?? 'normal',
    presupuesto: viaje.presupuesto ?? null,
    revision_reparto: viaje.revision_reparto ? 1 : 0,
    automatico: viaje.automatico ? 1 : 0,
    config_auto: configAuto(viaje),
    filtros_hoteles: filtrosHotelesDe(viaje),
    filtros_vuelos: normalizarFiltrosVuelos(viaje.filtros_vuelos),
  };
}

// =============================================================================
// EL SANEADO: de una plantilla a un viaje
// =============================================================================
/**
 * Los ajustes de una plantilla, ya validados, listos para escribir.
 *
 * Devuelve SOLO las claves que la plantilla trae de verdad. Una clave ausente no
 * sale en el objeto, y por eso el UPDATE de abajo no la toca.
 */
function saneados(ajustes) {
  const a = comoObjeto(ajustes) ?? {};
  const tiene = (k) => Object.prototype.hasOwnProperty.call(a, k) && a[k] !== undefined;
  const limpio = {};

  if (tiene('adultos')) limpio.adultos = entre(a.adultos, 1, MAX_ADULTOS, 2);
  if (tiene('ninos')) limpio.ninos = entre(a.ninos, 0, MAX_NINOS, 0);

  // Las edades se recortan a los niños que haya QUEDADO, no a los que traía la
  // plantilla: si `ninos` se sanea a 6 y venían 8 edades, sobran dos.
  if (tiene('edades_ninos')) {
    const cuantos = limpio.ninos ?? entre(a.ninos, 0, MAX_NINOS, 0);
    const brutas = Array.isArray(a.edades_ninos) ? a.edades_ninos : [];
    const edades = brutas.slice(0, cuantos).map((e) => entre(e, 0, MAX_EDAD, 0));
    while (edades.length < cuantos) edades.push(0);
    limpio.edades_ninos = edades;
  }

  if (tiene('ciudad_origen')) {
    limpio.ciudad_origen = String(a.ciudad_origen ?? '').trim().slice(0, 120) || 'Barcelona';
  }

  // Contra la lista de verdad: un tipo retirado se cae solo.
  if (tiene('tipo_viaje')) {
    const validos = new Set(TIPOS_VIAJE.map((t) => t.valor));
    limpio.tipo_viaje = String(a.tipo_viaje ?? '')
      .split(',')
      .map((t) => t.trim())
      .filter((t) => validos.has(t))
      .join(',');
  }

  if (tiene('ritmo')) limpio.ritmo = RITMOS.includes(a.ritmo) ? a.ritmo : 'normal';

  if (tiene('presupuesto')) {
    const n = Number(a.presupuesto);
    limpio.presupuesto = Number.isFinite(n) && n > 0 ? n : null;
  }

  if (tiene('revision_reparto')) limpio.revision_reparto = a.revision_reparto ? 1 : 0;
  if (tiene('automatico')) limpio.automatico = a.automatico ? 1 : 0;

  // LOS TRES JSON, CADA UNO POR SU NORMALIZADOR DE SIEMPRE.
  //
  // `configAuto` es el de LECTURA —descarta por lista blanca lo que ya no sea
  // válido— y es el que toca: `validarConfigAuto` espera un cuerpo de formulario
  // con nombres `auto_*`, que aquí no existen. Ese sigue actuando donde siempre,
  // al guardar la pantalla.
  //
  // CON UN REMIENDO, Y NO ES CAPRICHO: `configAuto` comprueba que las categorías
  // sean cadenas, pero NO que existan. Quien las valida de verdad contra la
  // lista es `validarConfigAuto`, y ese no se puede usar aquí. Probado con una
  // plantilla que traía «ovnis»: pasaba entera. Se filtra aquí contra la lista
  // buena, que es lo que hace el formulario.
  if (tiene('config_auto')) {
    const auto = configAuto({ config_auto: JSON.stringify(a.config_auto ?? {}) });
    limpio.config_auto = {
      ...auto,
      categorias: (auto.categorias ?? []).filter((c) => CATEGORIAS_SITIO.includes(c)),
    };
  }
  if (tiene('filtros_hoteles')) {
    limpio.filtros_hoteles = filtrosHotelesDe({ filtros_hoteles: JSON.stringify(a.filtros_hoteles ?? {}) });
  }
  if (tiene('filtros_vuelos')) {
    limpio.filtros_vuelos = normalizarFiltrosVuelos(a.filtros_vuelos ?? {});
  }

  return limpio;
}

// =============================================================================
// LEER
// =============================================================================
/** Una línea que diga de un vistazo qué trae la plantilla. */
function resumenDe(a) {
  const etiquetaDe = (lista, v) => OPCIONES_AUTO[lista]?.find((o) => o.valor === v)?.etiqueta;

  const trozos = [];
  const ad = Number(a?.adultos) || 0;
  const ni = Number(a?.ninos) || 0;
  if (ad) trozos.push(`${ad} adulto${ad === 1 ? '' : 's'}${ni ? ` y ${ni} niño${ni === 1 ? '' : 's'}` : ''}`);
  if (a?.ciudad_origen) trozos.push(`desde ${a.ciudad_origen}`);
  if (a?.ritmo) trozos.push(`ritmo ${a.ritmo}`);
  if (a?.presupuesto) trozos.push(`${Math.round(a.presupuesto)} €`);
  if (a?.automatico) trozos.push('viaje automático');
  const nivel = etiquetaDe('nivelPrecio', a?.config_auto?.nivelPrecio);
  if (nivel) trozos.push(`hotel ${nivel.toLowerCase()}`);

  return trozos.join(' · ') || 'sin ajustes guardados';
}

/**
 * Todas las plantillas, para el selector. La última usada, la primera.
 *
 * EL RESUMEN SE CALCULA SOBRE LO SANEADO, no sobre lo guardado. Una plantilla
 * vieja con un ritmo que ya no existe se cargaría como «normal», así que
 * anunciarla como «ritmo frenetico» sería prometer algo que no va a pasar. El
 * selector tiene que decir lo que de verdad se va a cargar.
 */
export function plantillas() {
  return todas(
    'SELECT * FROM plantillas_config ORDER BY usado_en IS NULL, usado_en DESC, nombre'
  ).map((p) => ({
    id: p.id,
    nombre: p.nombre,
    creadoEn: p.creado_en,
    usadoEn: p.usado_en,
    resumen: resumenDe(saneados(p.ajustes)),
  }));
}

/** Una plantilla por su id, con los ajustes ya parseados. */
export function plantillaPorId(id) {
  const p = una('SELECT * FROM plantillas_config WHERE id = ?', Number(id));
  return p ? { ...p, ajustes: comoObjeto(p.ajustes) ?? {} } : null;
}

// =============================================================================
// GUARDAR
// =============================================================================
/**
 * Guarda la configuración de un viaje como plantilla.
 *
 * MISMO NOMBRE = SOBREESCRIBE, que es lo que uno espera al escribir el nombre de
 * una plantilla que acaba de cargar y retocar. La pantalla pregunta antes.
 *
 * Se llama DESPUÉS del UPDATE del paso 1, así que fotografía lo recién guardado:
 * no puede capturar un estado a medias, y los filtros de los pasos 5 y 6 entran
 * sin que nadie los mande en el formulario.
 */
export function guardarPlantilla(viajeId, nombre) {
  const limpio = String(nombre ?? '').trim().slice(0, 80);
  if (!limpio) return { error: 'La plantilla necesita un nombre.' };

  const viaje = una('SELECT * FROM viajes WHERE id = ?', Number(viajeId));
  if (!viaje) return { error: 'Ese viaje ya no existe.' };

  const norm = normalizarNombre(limpio);
  const ajustes = JSON.stringify(ajustesDelViaje(viaje));
  const yaEsta = una('SELECT id FROM plantillas_config WHERE nombre_norm = ?', norm);

  if (yaEsta) {
    ejecutar(
      'UPDATE plantillas_config SET nombre = ?, ajustes = ? WHERE id = ?',
      limpio,
      ajustes,
      yaEsta.id
    );
    console.log(`[plantillas] «${limpio}» actualizada desde el viaje #${viaje.id}.`);
    return { id: yaEsta.id, nombre: limpio, actualizada: true };
  }

  const r = ejecutar(
    'INSERT INTO plantillas_config (nombre, nombre_norm, ajustes) VALUES (?, ?, ?)',
    limpio,
    norm,
    ajustes
  );
  console.log(`[plantillas] «${limpio}» guardada desde el viaje #${viaje.id}.`);
  return { id: Number(r.lastInsertRowid), nombre: limpio, creada: true };
}

/** Fuera una plantilla. No toca ningún viaje: los que la usaron ya la copiaron. */
export function borrarPlantilla(id) {
  const p = una('SELECT nombre FROM plantillas_config WHERE id = ?', Number(id));
  if (!p) return false;
  ejecutar('DELETE FROM plantillas_config WHERE id = ?', Number(id));
  console.log(`[plantillas] «${p.nombre}» borrada.`);
  return true;
}

// =============================================================================
// CARGAR
// =============================================================================
/**
 * Escribe los ajustes de una plantilla en un viaje.
 *
 * NO SE CARGA SOBRE UN VIAJE QUE YA TIENE RUTA, y no es una limitación de la
 * pantalla: es que cambiar los viajeros tiene consecuencias. El paso 1 detecta
 * ese cambio y llama a `olvidarTransporteYAlojamiento` —unos vuelos para dos no
 * sirven para cuatro—. Escribir las columnas por detrás se saltaría esa limpieza
 * y dejaría el viaje con hoteles buscados para la ocupación de antes. Mientras
 * cargar sea solo para empezar un viaje, el caso no existe; el día que se quiera
 * permitir, hay que traerse esa limpieza aquí.
 */
export function cargarPlantillaEn(viajeId, plantillaId) {
  const viaje = una('SELECT * FROM viajes WHERE id = ?', Number(viajeId));
  if (!viaje) return { error: 'Ese viaje ya no existe.' };

  if (una('SELECT 1 AS hay FROM etapas WHERE viaje_id = ?', viaje.id)) {
    return { error: 'Este viaje ya tiene ruta: cargar una plantilla ahora descuadraría lo buscado.' };
  }

  const plantilla = plantillaPorId(plantillaId);
  if (!plantilla) return { error: 'Esa plantilla ya no existe.' };

  const valores = saneados(plantilla.ajustes);
  const claves = CAMPOS.filter((c) => c in valores);
  if (!claves.length) return { error: 'Esa plantilla no tiene nada que cargar.' };

  // Las tres columnas que son JSON se guardan como texto; el resto, tal cual.
  const comoColumna = (clave) =>
    ['edades_ninos', 'config_auto', 'filtros_hoteles', 'filtros_vuelos'].includes(clave)
      ? JSON.stringify(valores[clave])
      : valores[clave];

  ejecutar(
    `UPDATE viajes SET ${claves.map((c) => `${c} = ?`).join(', ')} WHERE id = ?`,
    ...claves.map(comoColumna),
    viaje.id
  );
  ejecutar("UPDATE plantillas_config SET usado_en = datetime('now') WHERE id = ?", plantilla.id);

  console.log(
    `[plantillas] «${plantilla.nombre}» cargada en el viaje #${viaje.id} (${claves.length} ajuste(s)).`
  );
  return { id: plantilla.id, nombre: plantilla.nombre, cuantos: claves.length };
}

export default {
  plantillas,
  plantillaPorId,
  ajustesDelViaje,
  guardarPlantilla,
  borrarPlantilla,
  cargarPlantillaEn,
};
