/**
 * services/registro-traducido.js
 * -----------------------------------------------------------------------------
 * EL LOG, CONTADO EN CRISTIANO.
 *
 * El registro del orquestador son doscientas líneas de máquina por viaje, y
 * dentro está lo más valioso que produce esta aplicación: POR QUÉ el viaje salió
 * así. Por qué Wieliczka entró y Majdanek se quedó en la mochila, por qué esa
 * puerta y no otra, por qué el museo no cupo. Está todo escrito y es infumable
 * de leer.
 *
 * Esto lo traduce. NO lo sustituye: el log crudo se sigue guardando igual, se
 * sigue viendo en vivo mientras se genera, y tiene su botón en la pantalla nueva
 * para cuando haga falta depurar.
 *
 * UNA PASADA, AL TERMINAR, Y GUARDADA. Tres motivos y los tres cuentan:
 *
 *   · Abrir es instantáneo, siempre.
 *   · El texto es EL MISMO cada vez. Una traducción que cambiara entre lecturas
 *     no sería la memoria del viaje, sería un oráculo: se vuelve a leer meses
 *     después justo para comprobar qué decía, y tiene que decir lo mismo.
 *   · Una llamada de IA por viaje en lugar de una por apertura.
 *
 * SI NO ESTÁ, NO SE HACE A ESCONDIDAS. Un viaje viejo o una pasada que falló
 * dejan la pantalla sin traducción, y entonces sale un botón para generarla.
 * Traducir en silencio en cada apertura es justo lo que se ha decidido no hacer.
 *
 * NO INVENTA RAZONES. El prompt lo dice y el código lo comprueba: una línea sin
 * `porque` se queda sin desplegable en vez de estrenar un motivo verosímil. Un
 * motivo inventado con cara de dato es peor que un hueco declarado.
 */
import { todas, una, ejecutar } from '../db/index.js';
import { consultarJSON, hayClaveIA, modeloCriterio } from '../lib/ia.js';
import { promptDeFase, FASES } from './orquestador.js';

/** Los cuatro estados. Son los mismos que filtran los chips de la pantalla. */
export const ESTADOS = {
  elegido: { etiqueta: 'Elegido', icono: 'ti-check', color: '#1E6B3C', fondo: '#E1F2E7' },
  descartado: { etiqueta: 'Descartado', icono: 'ti-backpack', color: '#5E7A87', fondo: '#EEF4F7' },
  movido: { etiqueta: 'Movido', icono: 'ti-arrows-move', color: '#16688A', fondo: '#D3E8F0' },
  aviso: { etiqueta: 'Aviso', icono: 'ti-alert-triangle', color: '#854F0B', fondo: '#FAEEDA' },
};

const texto = (v) => {
  const t = String(v ?? '').trim();
  return t || null;
};

/** Cualquier cosa rara se queda en «elegido», que es el estado neutro. */
const estadoValido = (v) => (Object.hasOwn(ESTADOS, String(v ?? '')) ? String(v) : 'elegido');

// =============================================================================
// LEER
// =============================================================================
/**
 * CUÁNTAS VECES HA CORRIDO CADA FASE DE ESTE VIAJE.
 *
 * La huella con la que se sabe si la historia se ha quedado vieja. Relanzar una
 * fase escribe una PASADA nueva en su registro, y eso —y solo eso— es lo que
 * significa «esto ya no cuenta el viaje que hay».
 */
function huellaDePasadas(viajeId) {
  const filas = todas(
    `SELECT fase, MAX(pasada) AS n FROM orquestador_registro
      WHERE viaje_id = ? GROUP BY fase`,
    viajeId
  );
  return Object.fromEntries(filas.map((f) => [f.fase, Number(f.n) || 1]));
}

/**
 * La traducción guardada de un viaje, o null.
 *
 * Devuelve además si se ha quedado VIEJA. No se regenera sola —eso sería
 * traducir al vuelo por la puerta de atrás— pero se dice, y el botón de generar
 * sigue ahí.
 *
 * SE MIRAN LAS PASADAS, NO LAS LÍNEAS, Y ESTO COSTÓ UN FALSO POSITIVO EN CADA
 * VIAJE. La primera versión guardaba cuántas líneas tenía el registro al
 * traducir y comparaba con las de ahora. Pero después de contar se escriben DOS
 * LÍNEAS MÁS, y las escribe esta misma función: «Vista traducida del registro:
 * 4 ciudad(es) contadas» y, detrás, el «Orquestador terminado» del worker. Así
 * que toda historia recién hecha nacía declarándose obsoleta —«214 líneas
 * entonces, 216 ahora: relanzaste alguna fase después»— sin que nadie hubiera
 * relanzado nada.
 *
 * Y no se arregla contando dos líneas menos: el número de líneas no significa
 * nada por sí mismo. Lo que la pregunta quiere saber es si alguna fase ha vuelto
 * a correr, y eso lo dice su PASADA, que es un dato exacto y no un proxy.
 *
 * SIN HUELLA GUARDADA NO SE AVISA. Las traducciones de antes de este arreglo no
 * la tienen, y no hay forma de saber si están al día. Callar es mejor que soltar
 * un aviso que puede ser mentira: la misma regla que el aviso del hotel.
 */
export function registroTraducidoDe(viajeId) {
  const fila = una('SELECT * FROM registro_traducido WHERE viaje_id = ?', viajeId);
  if (!fila) return null;

  let datos;
  try {
    datos = JSON.parse(fila.json);
  } catch {
    return null;
  }

  let entonces = null;
  try {
    entonces = fila.pasadas ? JSON.parse(fila.pasadas) : null;
  } catch {
    entonces = null;
  }

  const ahora = huellaDePasadas(viajeId);

  // Vieja solo si alguna fase ha vuelto a correr desde que se escribió. Una fase
  // NUEVA que antes no existía también cuenta: es una parte del viaje que la
  // historia no llegó a ver.
  const relanzadas = entonces
    ? Object.keys(ahora).filter((f) => (ahora[f] ?? 0) > (entonces[f] ?? 0))
    : [];

  return {
    ...datos,
    generadoEn: fila.generado_en,
    modelo: fila.modelo,
    lineasTraducidas: fila.lineas,
    vieja: relanzadas.length > 0,
    relanzadas,
  };
}

/** El registro crudo de un viaje, en el orden en que se escribió. */
export function registroCrudoDe(viajeId) {
  return todas(
    `SELECT fase, pasada, linea, origen, creado_en
       FROM orquestador_registro WHERE viaje_id = ? ORDER BY id`,
    viajeId
  );
}

// =============================================================================
// TRADUCIR
// =============================================================================
/**
 * EL TEXTO QUE SE LE DA A LA IA.
 *
 * Se agrupa por fases y con su nombre en cristiano delante, porque el orden de
 * las fases ES el orden del relato que se le pide: la ruta primero y las
 * ciudades después. Darle las líneas sueltas sería pedirle que reconstruya una
 * estructura que ya tenemos.
 *
 * Solo la ÚLTIMA pasada de cada fase. Si una fase se relanzó tres veces, las dos
 * primeras cuentan una historia que ya no es la del viaje que hay.
 */
function registroParaTraducir(viajeId) {
  const filas = registroCrudoDe(viajeId);
  if (!filas.length) return null;

  const trozos = [];
  for (const f of FASES) {
    const suyas = filas.filter((r) => r.fase === f.clave);
    if (!suyas.length) continue;

    const ultima = Math.max(...suyas.map((r) => r.pasada));
    const lineas = suyas.filter((r) => r.pasada === ultima).map((r) => r.linea);
    if (!lineas.length) continue;

    trozos.push(`### FASE: ${f.etiqueta}\n${lineas.join('\n')}`);
  }

  return trozos.length ? trozos.join('\n\n') : null;
}

/**
 * SANEA LO QUE DEVUELVE EL MODELO.
 *
 * No es paranoia de tipos: es la regla de la casa. Lo que no venga bien no se
 * arregla adivinando, se deja fuera o se deja en null. En particular `porque`,
 * que es lo único que esta pantalla no puede permitirse inventar.
 */
function sanear(bruto) {
  const linea = (l) => {
    const que = texto(l?.que);
    if (!que) return null;
    return {
      estado: estadoValido(l?.estado),
      que,
      // Null es una respuesta legítima: significa «el registro no lo decía».
      porque: texto(l?.porque),
      cuando: texto(l?.cuando),
    };
  };

  const lista = (xs) => (Array.isArray(xs) ? xs.map(linea).filter(Boolean) : []);

  return {
    titular: texto(bruto?.titular),
    ruta: lista(bruto?.ruta),
    ciudades: (Array.isArray(bruto?.ciudades) ? bruto.ciudades : [])
      .map((c) => ({
        nombre: texto(c?.nombre),
        resumen: texto(c?.resumen),
        lineas: lista(c?.lineas),
      }))
      .filter((c) => c.nombre),
  };
}

/**
 * TRADUCE Y GUARDA. Devuelve lo guardado, o un objeto con `error`.
 *
 * No lanza nunca: la llama el worker justo después de montar un viaje entero, y
 * que esto falle no puede convertir un viaje bien montado en un viaje con error.
 * Es la misma regla que ya siguen el presupuesto y el gasto diario, que también
 * cuelgan del final y también van con su propio paracaídas.
 */
export async function traducirRegistro(viajeId, { di = null } = {}) {
  const viaje = una('SELECT id, nombre, destino FROM viajes WHERE id = ?', viajeId);
  if (!viaje) return { error: 'No existe ese viaje.' };

  if (!hayClaveIA()) return { error: 'No hay clave de IA configurada.' };

  const registro = registroParaTraducir(viajeId);
  if (!registro) return { error: 'Este viaje no tiene registro que traducir.' };

  let plantilla;
  try {
    plantilla = promptDeFase('registro_traducido');
  } catch (err) {
    return { error: err.message };
  }

  try {
    const bruto = await consultarJSON(plantilla.replace('{{REGISTRO}}', registro), {
      // El log entero de un viaje son unos 25.000 caracteres y la respuesta es
      // larga: una línea por decisión, y hay muchas.
      maxTokens: 16000,
      paso: `traducir el registro de ${viaje.destino ?? viaje.nombre}`,
      // De criterio, no rápido: esto no es extraer un dato, es contar una
      // historia sin inventarse ninguna razón, que es lo difícil.
      modelo: modeloCriterio(),
    });

    const limpio = sanear(bruto);
    if (!limpio.ruta.length && !limpio.ciudades.length) {
      return { error: 'La traducción volvió vacía.' };
    }

    const cuantas = una(
      'SELECT COUNT(*) AS n FROM orquestador_registro WHERE viaje_id = ?',
      viajeId
    ).n;

    ejecutar(
      `INSERT INTO registro_traducido (viaje_id, json, modelo, lineas, pasadas, generado_en)
       VALUES (?, ?, ?, ?, ?, datetime('now'))
       ON CONFLICT (viaje_id) DO UPDATE SET
         json = excluded.json, modelo = excluded.modelo,
         lineas = excluded.lineas, pasadas = excluded.pasadas,
         generado_en = excluded.generado_en`,
      viajeId,
      JSON.stringify(limpio),
      modeloCriterio(),
      cuantas,
      JSON.stringify(huellaDePasadas(viajeId))
    );

    di?.(`Vista traducida del registro: ${limpio.ciudades.length} ciudad(es) contadas.`);
    return registroTraducidoDe(viajeId);
  } catch (err) {
    di?.(`No pude traducir el registro (${err.message}). El log crudo sigue entero.`);
    return { error: err.message };
  }
}

// =============================================================================
// LA SEGUNDA CAPA: LO QUE TOQUÉ YO
// =============================================================================
/**
 * LOS CAMBIOS A MANO, ENCIMA DE LO QUE HIZO LA MÁQUINA.
 *
 * Lo que decidió el orquestador queda FIJO: su relato es el del día en que se
 * montó el viaje y no se reescribe. Lo que la persona cambia después se cuenta
 * aparte y se distingue, para que al releer el viaje meses más tarde se vea
 * entero: por qué la máquina lo montó así, y qué se decidió cambiar.
 *
 * ESTO SOLO CUENTA, NO VIGILA. Aquí no hay avisos ni validaciones: de eso ya se
 * encarga la capa de avisos del lienzo, que avisa sin prohibir. Esta pantalla es
 * la memoria, no el guardia.
 *
 * LO QUE SE PUEDE DECIR HOY, Y HASTA DÓNDE. `tocado_a_mano` es un booleano: dice
 * QUÉ se tocó, no qué había antes ni cuándo. Así que esto cuenta «esta visita la
 * moviste tú», que es el 90 % de lo que se quiere saber, y no puede contar «la
 * moviste del día 3 al día 4 un martes». Para eso haría falta una tabla de
 * historial con el antes y el después, y eso es otra cosa —una que de momento
 * nadie ha pedido—. Se dice lo que se sabe y no se finge el resto.
 *
 * Y NO VE LOS BORRADOS: quitar algo del lienzo borra su fila, y una fila borrada
 * no tiene dónde llevar la marca. Queda dicho aquí para que no se lea como un
 * viaje sin cambios cuando lo que hubo fue una supresión.
 */
export function cambiosAMano(viajeId) {
  const filas = todas(
    `SELECT i.id, i.dia, i.hora, i.franja,
            COALESCE(c.titulo, i.texto_manual) AS nombre,
            c.tipo AS tipo,
            e.nombre_ciudad AS ciudad
       FROM itinerario i
       LEFT JOIN candidatos c ON c.id = i.candidato_id
       LEFT JOIN etapas e ON e.id = i.etapa_id
      WHERE i.viaje_id = ? AND i.tocado_a_mano = 1
      ORDER BY i.dia, i.hora, i.orden`,
    viajeId
  );

  return filas.map((f) => ({
    id: `m${f.id}`,
    que: texto(f.nombre) ?? 'Un bloque del lienzo',
    ciudad: texto(f.ciudad),
    cuando: [f.dia ? `Día ${f.dia}` : null, texto(f.hora)].filter(Boolean).join(' · ') || null,
    tipo: texto(f.tipo),
  }));
}

export default { traducirRegistro, registroTraducidoDe, registroCrudoDe, cambiosAMano, ESTADOS };
