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
import { buscarDatosDeSitios, interpretarHorariosDelCatalogo } from '../services/datos-sitios.js';
import { destinoPorNombre } from '../services/catalogo.js';
import { ocupacionDe } from '../services/proveedores.js';
import { anotar, apuntarHueco, configAuto, parametro, ORIGENES } from '../services/orquestador.js';
import { hayQueParar } from '../services/orquestador-parada.js';
import { porParada, avisar, avisoDeSitios } from '../services/paralelo.js';
import { enFase } from '../services/fase-actual.js';
import { enParada } from '../services/cronometro.js';
import { fundirSitiosContenidos } from '../services/contenidos.js';
import { puntuarLosSitios, contradiccionesDe } from '../services/rubrica-sitios.js';

const FASE = 'sitios';

// =============================================================================
// EL AVISO DE CONTRADICCIÓN
// =============================================================================
/**
 * CUANDO EL ORDEN Y LA RÚBRICA DICEN LO CONTRARIO, SE DICE. NO SE ELIGE.
 *
 * El reparto sigue usando `orden` y solo `orden`: esta función no toca ninguna
 * ficha, no cambia ningún puesto y no echa nada del plan. Escribe una línea en
 * la pantalla de avisos y se va.
 *
 * Y es a propósito. La rúbrica se midió contra el viaje de control y NO sirve
 * para repartir —bajaba 26 sitios y subía 1, y tiraba de banda a la Torre Blanca
 * y a Ano Poli—, porque mide valor absoluto y el reparto necesita valor relativo
 * a la ciudad. Pero para señalar un desacuerdo grande entre dos lecturas sí
 * sirve: si el orden pone un sitio entre los intocables y la rúbrica no le
 * encuentra ni un hecho que nombrar, una de las dos se ha equivocado y quien
 * decide cuál es quien mira el viaje, no el motor.
 *
 * Severidad `info`, que es lo que es: una cosa para mirar, no un problema.
 */
function avisarDeContradicciones(viajeId, punto, ciudad, di) {
  const casos = contradiccionesDe(punto);
  if (!casos.length) return 0;

  const linea = (c) =>
    `#${c.orden} ${c.nombre} (${c.puntos} ${c.puntos === 1 ? 'punto' : 'puntos'}` +
    (c.casillas.length ? `: ${c.casillas.join(', ')}` : ', sin ningún hecho que nombrar') +
    ')';

  ejecutar(
    `INSERT INTO avisos (viaje_id, categoria, severidad, titulo, texto)
     VALUES (?, 'rubrica', 'info', ?, ?)`,
    viajeId,
    `En ${ciudad} hay ${casos.length === 1 ? 'un sitio' : `${casos.length} sitios`} de primera fila con nota baja`,
    casos.length === 1
      ? `${linea(casos[0])}. Está entre los primeros de la lista de ${ciudad}, así que el plan lo ` +
        'protege como si fuera el motivo del viaje, pero al medirlo no se le encontró casi nada ' +
        'que contar. Puede que la lista se pasara, o que la medición se quedara corta. ' +
        'No se ha cambiado nada: míralo y decide tú.'
      : `${casos.map(linea).join('. ')}. Están entre los primeros de la lista de ${ciudad}, así que ` +
        'el plan los protege como si fueran el motivo del viaje, pero al medirlos no se les ' +
        'encontró casi nada que contar. Puede que la lista se pasara, o que la medición se quedara ' +
        'corta. No se ha cambiado nada: míralos y decide tú.'
  );

  di(`   ${ciudad}: ${casos.length} sitio(s) de primera fila con nota baja. Avisado, sin tocar nada.`);
  return casos.length;
}

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

  // LOS AVISOS DE LA VEZ ANTERIOR SE VAN AHORA, Y SOLO AQUÍ.
  //
  // Cada parada escribe el suyo dentro del bucle en paralelo, así que borrar
  // dentro sería que la última en entrar se llevara por delante los de las
  // otras. Se limpia una vez, antes de empezar, como hacen las demás fases.
  ejecutar("DELETE FROM avisos WHERE viaje_id = ? AND categoria = 'rubrica'", viajeId);

  const aLaVez = Math.max(1, parametro('concurrencia_paradas', 3));
  di(
    `${etapas.length} parada(s)` +
      (aLaVez > 1 && etapas.length > 1 ? `, de ${aLaVez} en ${aLaVez}.` : ', de una en una.'),
    ORIGENES.ninguno
  );

  // LAS PARADAS NO DEPENDEN UNAS DE OTRAS.
  //
  // Iban en fila solo porque un `for` es lo más fácil de escribir, y el
  // cronómetro puso el precio encima de la mesa: 6m 35s de IA en tres ciudades
  // seguidas. Ninguna necesita nada de la anterior —cada una investiga su ciudad
  // y escribe en su propio punto del catálogo— así que van a la vez.
  //
  // El scraping que haya dentro sigue haciendo cola solo: el semáforo de
  // `abrirNavegador` se encarga, porque el perfil de Chrome es uno.
  // LA BANDERA SE LEVANTA SALGA LA CIUDAD POR DONDE SALGA.
  //
  // El sitio bueno para avisar es en cuanto están las filas Y las coordenadas
  // —justo después de `situarLosSitios`—, y ahí se avisa expresamente. Pero de
  // esta tarea se sale por cuatro puertas más: sin ficha en el catálogo, con los
  // sitios ya generados de antes, con la generación caída, o por un error que no
  // se esperaba. Si por alguna de esas no se avisara, la fase de excursiones de
  // esa ciudad se comería el plazo entero esperando algo que ya no va a llegar
  // —y la de «ya existían» es justo la que más se pisa al regenerar un viaje—.
  // Así que el aviso va también en un `finally`. Avisar dos veces no hace nada.
  const avisandoAlTerminar = (tarea) => async (etapa, ciudad) => {
    const aviso = etapa.punto_interes_id ? avisoDeSitios(viajeId, etapa.punto_interes_id) : null;
    try {
      return await tarea(etapa, ciudad);
    } finally {
      if (aviso) avisar(aviso);
    }
  };

  const { resultados } = await porParada(
    etapas,
    {
      limite: aLaVez,
      nombreDe: (e) => e.nombre_ciudad,
      hayQueParar: (ciudad) => hayQueParar(viajeId, FASE, ciudad),
      enFase: (fn) => enFase(viajeId, FASE, fn),
      enParada,
      di: (t) => di(t, ORIGENES.ninguno),
    },
    avisandoAlTerminar(async (etapa, ciudad) => {

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
        return { hecha: false };
      }

      // --- Lo que ya está no se toca ---------------------------------------
      const cuantos = una(
        'SELECT COUNT(*) AS n FROM sitios_lugar WHERE punto_interes_id = ?',
        punto.id
      ).n;
      if (cuantos) {
        di(`${ciudad}: ya existían ${cuantos} sitios. No los regenero.`);

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
        // Y SE PUNTÚAN, AUNQUE SEAN DE ANTES.
        //
        // AQUÍ ESTABA EL FALLO, y lo destapó el viaje de control 110: el
        // enganche de la rúbrica estaba DESPUÉS de este `return`, así que solo
        // alcanzaba a las ciudades recién investigadas. Atenas, Nafplio y
        // Tesalónica ya existían del viaje anterior, tomaron esta salida y
        // ninguna se puntuó.
        //
        // Peor que perder un viaje: así la rúbrica NUNCA habría llegado a los
        // 156 sitios que ya estaban en el catálogo, que es exactamente el
        // agujero que la red del NULL venía a tapar. Se habría quedado
        // enchufada y sin nada que leer.
        //
        // `puntuarLosSitios` no pregunta si ya están todos puntuados, así que
        // esto rellena una vez y después no cuesta nada.
        try {
          await puntuarLosSitios(punto, ciudad, di);
          avisarDeContradicciones(viajeId, punto, ciudad, di);
        } catch (err) {
          di(`   ${ciudad}: no pude puntuar los sitios (${err.message}).`);
        }

        // ESTA PARADA CUENTA COMO RESUELTA: los sitios están, solo que de antes.
        //
        // Aquí estaba el «Cannot access 'generadas' before initialization» de
        // Hanói. Al pasar el bucle a paralelo, el contador dejó de ser un `let`
        // de fuera y pasó a calcularse DESPUÉS, contando los resultados; se me
        // quedó un `generadas += 1` dentro del closure, y leer una `const` que
        // aún no existe revienta. Solo saltaba en las ciudades que ya tenían
        // sitios, que es justo por lo que no salió en las pruebas.
        return { hecha: true };
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
        return { hecha: false };
      }

      // --- 2) Wikipedia: foto y enlace --------------------------------------
      await ponerFotosDeWikipedia(ficha.sitios);
      guardarFichaProfunda(punto, ficha);
      ejecutar("UPDATE puntos_interes SET investigado_en = datetime('now') WHERE id = ?", punto.id);

      // --- 3) Dirección y coordenada, como en el flujo manual ---------------
      try {
        await situarLosSitios(punto, di);
      } catch (err) {
        // Que Places no conteste no deja la parada sin sitios: solo sin
        // direcciones, que es un hueco menor y se ve en la ficha.
        di(`   ${ciudad}: no pude situar los sitios (${err.message}).`);
      }

      // AQUÍ, Y NO AL FINAL DE LA CIUDAD, ES CUANDO EXCURSIONES PUEDE SEGUIR.
      //
      // Lo que esa fase necesita de aquí es la lista de nombres —para que la IA
      // sepa qué se va a ver ya— y la coordenada —para la salvaguarda de los
      // metros al fundir—. Las dos cosas están puestas en esta línea.
      //
      // Lo que viene después, los precios y horarios de Google, no le hace
      // ninguna falta y tarda lo suyo: en el viaje 60 fueron 41 s entre este
      // punto y el final de la ciudad. Avisar aquí es lo que hace que esperar
      // salga gratis; avisar al final costaría esos 41 s por nada.
      avisar(avisoDeSitios(viajeId, punto.id));

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

      // LO QUE ESTÁ DENTRO DE OTRO NO ES OTRA VISITA.
      //
      // Se hace con los sitios ya guardados y antes de contar, para que el
      // recuento diga lo que de verdad se va a visitar.
      try {
        const fundidos = await fundirSitiosContenidos(punto, ciudad, di);
        if (fundidos) di(`   ${ciudad}: ${fundidos} sitio(s) se visitan dentro de otro.`);
      } catch (err) {
        di(`   ${ciudad}: no pude fundir los sitios contenidos (${err.message}).`);
      }

      // CUÁNTO VALE CADA SITIO, CONTADO EN VEZ DE OPINADO.
      //
      // Va DESPUÉS de fundir a propósito: así se puntúa lo que de verdad se va a
      // visitar y no se gasta una casilla en algo que ya se ve dentro de otra
      // cosa.
      //
      // Y no lanza: si falla, los sitios se quedan sin nota —que es «todavía no
      // se ha medido», no «vale cero»— y el reparto sigue usando el orden de la
      // lista para ellos. Puntuar es una mejora, no un requisito.
      try {
        await puntuarLosSitios(punto, ciudad, di);
        avisarDeContradicciones(viajeId, punto, ciudad, di);
      } catch (err) {
        di(`   ${ciudad}: no pude puntuar los sitios (${err.message}).`);
      }

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
      return { hecha: true };
    })
  );

  // Y SI ALGUNA CIUDAD NI SE LLEGÓ A EMPEZAR, SE AVISA IGUAL.
  //
  // El `finally` de arriba cubre las que entraron en la tarea, pero una parada
  // pedida a media lista hace que las siguientes se salten SIN ejecutarla: esas
  // no avisarían nunca y la fase de excursiones se quedaría esperando a alguien
  // que ya se ha ido. Nadie debe esperar a una fase que ya ha terminado, así que
  // al cerrar se levantan todas las banderas que falten. El plazo de espera es
  // para los cuelgues de verdad, no para esto.
  for (const e of etapas) {
    if (e.punto_interes_id) avisar(avisoDeSitios(viajeId, e.punto_interes_id));
  }

  // --- LOS DÍAS DE CIERRE, ANTES DE QUE NADIE REPARTA ----------------------
  //
  // Va aquí porque aquí es donde el texto del horario acaba de llegar, y porque
  // quien lo necesita —el reparto del lienzo— es una fase entera más tarde. Se
  // hacía al revés: el lienzo ya pintado encolaba la traducción y el worker la
  // resolvía cuando podía, así que la IA repartía los días sin saber qué cerraba
  // ninguno. En el viaje a Túnez eso fueron once sitios con día de cierre y cero
  // líneas de aviso en el prompt.
  //
  // Y DESPUÉS DE LEVANTAR LAS BANDERAS, no antes: la fase de excursiones espera
  // a `avisoDeSitios` para arrancar y no tiene por qué esperar también a esto.
  //
  // El 90% de los horarios los lee el código sin preguntar a nadie —el catálogo
  // entero de un viaje son milisegundos—, así que no se filtra por «lo que se
  // vaya a colocar»: eso era justo lo que dejaba medio catálogo a oscuras.
  for (const e of etapas) {
    if (!e.punto_interes_id) continue;
    try {
      const r = await interpretarHorariosDelCatalogo(e.punto_interes_id, di);
      if (r.preguntados || r.fallidos) {
        di(
          `   ${e.nombre_ciudad}: ${r.leidos} horario(s) leídos en código, ` +
            `${r.preguntados} preguntado(s)` +
            (r.fallidos ? `, ${r.fallidos} sin poder traducir.` : '.')
        );
      }
    } catch (err) {
      // Que no se sepan los cierres no invalida la fase: el reparto recibirá un
      // «NO SE SABE qué días cierra», que es la verdad y se puede decir.
      di(`   ${e.nombre_ciudad}: no pude traducir los horarios (${err.message}).`);
    }
  }

  // UN FALLO EN UNA CIUDAD NO SE TRAGA NI SE LLEVA A LAS DEMÁS.
  for (const [k, r] of resultados.entries()) {
    if (!r?.error) continue;
    const ciudad = etapas[k]?.nombre_ciudad ?? `parada ${k + 1}`;
    di(`${ciudad}: no se pudo (${r.error.message}).`);
    apuntarHueco(viajeId, FASE, `${ciudad}: ${r.error.message}`);
  }

  const generadas = resultados.filter((r) => r?.valor?.hecha).length;

  di(`${generadas} de ${etapas.length} parada(s) con sus sitios.`);
  return { etapas: etapas.length, generadas };
}

export default { ejecutarFaseSitios, sesgoDeIntereses };
