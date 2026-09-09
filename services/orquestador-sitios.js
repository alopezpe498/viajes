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
} from '../services/descubrir.js';
import { situarLosSitios } from '../services/direcciones.js';
import { buscarDatosDeSitios } from '../services/datos-sitios.js';
import { destinoPorNombre } from '../services/catalogo.js';
import { ocupacionDe } from '../services/proveedores.js';
import { anotar, apuntarHueco, configAuto } from '../services/orquestador.js';

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
    const conFoto = await ponerFotosDeWikipedia(ficha.sitios);
    guardarFichaProfunda(punto, ficha);
    ejecutar("UPDATE puntos_interes SET investigado_en = datetime('now') WHERE id = ?", punto.id);

    const porBloque = ficha.sitios.reduce((m, s) => {
      m[s.bloque] = (m[s.bloque] ?? 0) + 1;
      return m;
    }, {});
    const generales = (porBloque.imprescindibles ?? 0) + (porBloque.otros ?? 0);
    const infantiles = porBloque.ninos ?? 0;

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

    const sinDatos = datos ? datos.sitios - datos.rellenados : null;
    di(
      `${ciudad}: ${generales} sitios` +
        (infantiles ? ` (+${infantiles} para niños)` : '') +
        `, ${conFoto} con foto, ` +
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
