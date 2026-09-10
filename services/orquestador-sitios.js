/**
 * services/orquestador-sitios.js
 * -----------------------------------------------------------------------------
 * FASE 4 DEL ORQUESTADOR: qué ver en cada parada.
 *
 * AQUÍ NO HAY UN PROCESO NUEVO, y esa es la idea entera. Lo que hace esta fase
 * es entrar en la pestaña de Sitios de cada etapa por ti: la misma generación en
 * tres bloques, las mismas categorías, la misma Wikipedia, las mismas fotos y la
 * misma búsqueda única en Google. Si mañana esa generación mejora, esta fase
 * mejora sola, porque llama a las mismas funciones y no a copias suyas.
 *
 * LO ÚNICO QUE AÑADE ES EL SESGO POR INTERESES.
 *
 * En el flujo manual nadie ha declarado qué le interesa: se entra en la etapa y
 * se pide lo que hay que ver. En el modo automático sí se ha declarado, al
 * activar el viaje automático, y sería absurdo no usarlo. Pero SESGAR NO ES
 * FILTRAR: quien dice que le interesa la naturaleza no quiere un viaje a
 * Cracovia sin Wawel. Los imprescindibles universales entran igual; lo que
 * cambia es lo que ocupa el resto de los huecos.
 *
 * DE UNA EN UNA Y CON PACIENCIA. Cada etapa abre un navegador para la búsqueda
 * de datos duros en Google. Cuatro paradas en paralelo son cuatro navegadores a
 * la vez contra el mismo servidor, que es la forma más rápida de que te pidan un
 * captcha y quedarte sin datos en las cuatro.
 *
 * LO QUE YA ESTÁ NO SE REGENERA. Si una parada ya tiene sus sitios —porque el
 * usuario entró antes, o porque se relanzó el orquestador— se anota y se pasa a
 * la siguiente. Volver a generarlos pisaría lo que hubiera tocado a mano.
 *
 * Y NO SE APUNTA NADA. Esta fase deja las fichas listas; decidir qué se visita
 * es de la fase del lienzo.
 */
import { todas, una, ejecutar } from '../db/index.js';
import { hayClaveIA, SIN_CLAVE } from '../lib/ia.js';
import {
  investigarCiudadConIA,
  guardarFichaProfunda,
  ponerFotosDeWikipedia,
  repasarFotosDeSitios,
} from '../services/descubrir.js';
import { situarLosSitios } from '../services/direcciones.js';
import { buscarDatosDeSitios } from '../services/datos-sitios.js';
import { destinoPorNombre } from '../services/catalogo.js';
import { ocupacionDe } from '../services/proveedores.js';
import { anotar, apuntarHueco, configAuto, ORIGENES } from '../services/orquestador.js';
import { hayQueParar } from '../services/orquestador-parada.js';

const FASE = 'sitios';

// =============================================================================
// EL SESGO
// =============================================================================
export function rellenar(plantilla, datos) {
  return plantilla.replace(/\{\{([A-Z_]+)\}\}/g, (_, clave) => {
    const v = datos[clave];
    return v === undefined || v === null ? '' : String(v);
  });
}

/**
 * El bloque de intereses que se le añade a la generación.
 *
 * Sale del prompt de la fase, que es editable: la redacción de CÓMO usar los
 * intereses es justo lo que hay que poder afinar sin tocar código. Si no hay
 * intereses declarados no se añade nada y la generación es la de siempre.
 */
export function sesgoDeIntereses(prompt, auto) {
  const texto = (auto.intereses ?? '').trim();
  const categorias = auto.categorias ?? [];
  if (!texto && !categorias.length) return null;

  return rellenar(prompt, {
    INTERESES: texto || '(no lo ha escrito)',
    CATEGORIAS: categorias.length ? categorias.join(', ') : '(ninguna marcada)',
  });
}

// =============================================================================
// LA FASE
// =============================================================================
export async function ejecutarFaseSitios(viaje, prompt) {
  const viajeId = viaje.id;
  const di = (t) => anotar(viajeId, FASE, t);

  if (!hayClaveIA()) throw new Error(SIN_CLAVE);

  const auto = configAuto(viaje);
  const { edadesNinos } = ocupacionDe(viaje);
  const sesgo = sesgoDeIntereses(prompt, auto);

  const etapas = todas(
    "SELECT * FROM etapas WHERE viaje_id = ? AND estado = 'confirmada' ORDER BY orden, id",
    viajeId
  );
  if (!etapas.length) {
    di('El viaje no tiene paradas confirmadas: no hay dónde buscar.');
    return { etapas: 0, generadas: 0 };
  }

  if (sesgo) {
    const lista = [auto.intereses, (auto.categorias ?? []).join(', ')].filter(Boolean).join(' · ');
    di(`Sesgo por intereses: ${lista}. Los imprescindibles de cada ciudad entran igual.`);
  } else {
    di('Sin intereses declarados: se generan los sitios como en el flujo manual.');
  }

  di(`${etapas.length} parada(s), de una en una para no amontonar búsquedas.`);

  let generadas = 0;

  for (const etapa of etapas) {
    const ciudad = etapa.nombre_ciudad;

    // EL PUNTO DE CONTROL DE LA PARADA.
    //
    // Entre ciudad y ciudad no hay nada a medias: la anterior está terminada y
    // de la siguiente no se ha tocado nada. Es el mejor sitio para dejarlo, y
    // por eso se mira aquí y no dentro del trabajo de una ciudad.
    //
    // Se corta con `break` y NO con una excepción: la fase devuelve lo que lleve
    // hecho y el worker la cierra como terminada. Lo hecho, hecho queda; lo que
    // falte lo hará el relanzado.
    if (hayQueParar(viajeId, FASE, ciudad)) {
      di(`Parada pedida: lo dejo antes de ${ciudad}.`, ORIGENES.ninguno);
      break;
    }

    const punto = etapa.punto_interes_id
      ? una('SELECT * FROM puntos_interes WHERE id = ?', etapa.punto_interes_id)
      : null;

    if (!punto) {
      apuntarHueco(
        viajeId,
        FASE,
        `${ciudad}: la parada no tiene ficha propia en el catálogo, así que no hay dónde guardar los sitios.`
      );
      di(`${ciudad}: sin ficha en el catálogo. Lo dejo como hueco.`);
      continue;
    }

    // --- Lo que ya está no se toca ---------------------------------------
    const cuantos = una(
      'SELECT COUNT(*) AS n FROM sitios_lugar WHERE punto_interes_id = ?',
      punto.id
    ).n;
    if (cuantos) {
      di(`${ciudad}: ya existían ${cuantos} sitios. No los regenero.`);
      generadas += 1;

      // PERO SÍ SE REPASAN LAS FOTOS QUE FALTEN.
      //
      // Las fichas viejas se guardaron cuando solo se miraba la Wikipedia en
      // español, y fuera de los sitios muy famosos ahí no hay artículo: de
      // veinte sitios de Gdansk llegaron tres con foto. Regenerarlas sería
      // tirar trabajo bueno, así que se rellena solo el hueco de la foto.
      try {
        const destinoDeLaCiudad = punto.destino_id
          ? una('SELECT nombre FROM destinos WHERE id = ?', punto.destino_id)
          : null;
        const puestas = await repasarFotosDeSitios(punto, destinoDeLaCiudad?.nombre ?? viaje.destino);
        if (puestas) di(`   ${ciudad}: ${puestas} foto(s) recuperadas de fichas que no tenían.`);
      } catch (err) {
        di(`   ${ciudad}: no pude repasar las fotos (${err.message}).`);
      }
      continue;
    }

    di(`Buscando qué ver en ${ciudad}…`);

    // --- 1) La generación de siempre, en tres bloques ---------------------
    let ficha;
    try {
      const destino = punto.destino_id
        ? una('SELECT nombre FROM destinos WHERE id = ?', punto.destino_id)
        : destinoPorNombre(viaje.destino ?? '');
      ficha = await investigarCiudadConIA(punto, destino?.nombre ?? ciudad, {
        edadesNinos,
        sesgo,
      });
    } catch (err) {
      apuntarHueco(viajeId, FASE, `${ciudad}: no se pudieron generar los sitios (${err.message}).`);
      di(`${ciudad}: la generación falló (${err.message}). Sigo con la siguiente parada.`);
      continue;
    }

    // --- 2) Wikipedia: foto y enlace --------------------------------------
    await ponerFotosDeWikipedia(ficha.sitios);
    guardarFichaProfunda(punto, ficha);
    ejecutar("UPDATE puntos_interes SET investigado_en = datetime('now') WHERE id = ?", punto.id);

    // --- 3) Dirección y coordenada, como en el flujo manual ---------------
    try {
      await situarLosSitios(punto);
    } catch (err) {
      // Que Places no conteste no deja la parada sin sitios: solo sin
      // direcciones, que es un hueco menor y se ve en la ficha.
      di(`   ${ciudad}: no pude situar los sitios (${err.message}).`);
    }

    // --- 4) Los datos duros, una sola búsqueda ----------------------------
    //
    // Se ESPERA a que termine en vez de encolarla. En el flujo manual se encola
    // porque hay alguien mirando la pantalla y la ficha se completa sola; aquí
    // no hay nadie mirando, y la fase tiene que poder decir si los datos
    // entraron o no antes de darse por terminada.
    let datos = null;
    try {
      datos = await buscarDatosDeSitios(punto);
    } catch (err) {
      apuntarHueco(
        viajeId,
        FASE,
        `${ciudad}: los sitios están, pero la búsqueda de precios y horarios falló (${err.message}).`
      );
    }

    // LO QUE LA BÚSQUEDA NO HA PODIDO CONFIRMAR, FUERA Y DICHO.
    //
    // El filtro lo aplica la propia búsqueda de datos duros (no hay una segunda
    // búsqueda para esto); aquí solo se cuenta lo que ha tirado y por qué, que
    // es lo que permite ver si se está pasando de estricto.
    for (const x of datos?.descartados ?? []) {
      di(`   Descartado por no verificado: ${x.nombre} (${x.motivo})`);
    }

    const sinDatos = datos ? datos.sitios - datos.rellenados : null;
    // Se cuenta de la BASE y no de lo que propuso la IA: entre medias el filtro
    // de existencia puede haber tirado alguno, y el registro tiene que decir lo
    // que ha quedado, no lo que se pidió.
    const porBloque = todas(
      `SELECT bloque, COUNT(*) AS n FROM sitios_lugar
        WHERE punto_interes_id = ? GROUP BY bloque`,
      punto.id
    ).reduce((m, r) => ({ ...m, [r.bloque ?? 'imprescindibles']: r.n }), {});
    const generales = (porBloque.imprescindibles ?? 0) + (porBloque.otros ?? 0);
    const infantiles = porBloque.ninos ?? 0;
    const conFotoAhora = una(
      'SELECT COUNT(*) AS n FROM sitios_lugar WHERE punto_interes_id = ? AND imagen_url IS NOT NULL',
      punto.id
    ).n;

    di(
      `${ciudad}: ${generales} sitios` +
        (infantiles ? ` (+${infantiles} para niños)` : '') +
        `, ${conFotoAhora} con foto, ` +
        (datos === null
          ? 'datos de Google pendientes.'
          : sinDatos === 0
            ? 'datos de Google al completo.'
            : `datos de Google pendientes en ${sinDatos} sitio(s).`)
    );

    generadas += 1;
  }

  di(`${generadas} de ${etapas.length} parada(s) con sus sitios.`);
  return { etapas: etapas.length, generadas };
}

export default { ejecutarFaseSitios, sesgoDeIntereses };
