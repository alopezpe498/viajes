/**
 * services/ajustes.js
 * -----------------------------------------------------------------------------
 * LAS CLAVES Y LOS AJUSTES DE INSTALACIÓN, EDITABLES DESDE LA PANTALLA.
 *
 * Hasta ahora vivían en el `.env`, así que cambiar la clave de la IA pedía entrar
 * al servidor por SSH. Eso convierte «pasarle la aplicación a alguien» en
 * «enseñarle a editar un fichero por SSH», que no es pasársela.
 *
 * ───────────────────────────────────────────────────────────────────────────
 * EL ORDEN ES SIEMPRE TABLA → .env → FÁBRICA, Y NUNCA AL REVÉS.
 *
 * Es lo único que hace que esto se pueda meter en una instalación que ya
 * funciona sin romperla: con la tabla vacía, `volcarAjustes()` no pisa nada y
 * todo sigue leyendo el `.env` de siempre. El día que se guarda una clave, esa
 * clave —y solo esa— pasa a mandar. Si se quita, vuelve a mandar el `.env`.
 *
 * Y POR ESO NO HACE FALTA TOCAR NI UN SITIO DE USO. El `.env` se carga al
 * importar `lib/ia.js` y `lib/google.js`, pero `process.env.X` se LEE EN CADA
 * LLAMADA: dentro de `consultarJSON`, dentro de `hayClaveIA`, en las cabeceras
 * de Google, en cada petición de las rutas. Así que basta con volcar lo guardado
 * a `process.env` al arrancar —y al guardar, para que una clave nueva funcione
 * sin reiniciar— y los quince sitios que las leen no se enteran de nada.
 * ───────────────────────────────────────────────────────────────────────────
 *
 * EL `.env` NO SE TOCA. Ni se lee para copiarlo aquí, ni se reescribe jamás. Una
 * aplicación que edita su propio fichero de arranque es una aplicación que un
 * día se cae a mitad de escribirlo y ya no levanta.
 *
 * LAS CLAVES NO SALEN DE AQUÍ. Lo que devuelve este módulo para la pantalla es
 * «hay una y acaba en AB12», nunca la clave. Los cuatro últimos caracteres son
 * lo justo para distinguir una clave de otra sin enseñarla.
 */

import { todas, una, ejecutar } from '../db/index.js';
import { MODELO_POR_DEFECTO, MODELO_CRITERIO_POR_DEFECTO } from '../lib/ia.js';

/**
 * QUÉ SE PUEDE AJUSTAR, Y CÓMO SE TRATA CADA COSA.
 *
 * `secreto` decide dos cosas a la vez: que no salga en claro y que se pinte con
 * los botones de Reemplazar y Quitar en vez de con un campo de texto normal.
 *
 * `fabrica` solo lo tienen los que de verdad tienen un valor por defecto. Una
 * credencial no lo tiene: sin ella, la función se apaga y ya está.
 */
export const AJUSTES = [
  {
    clave: 'ANTHROPIC_API_KEY',
    etiqueta: 'Clave de la API de Anthropic',
    explica:
      'La que paga las llamadas a la IA. Sin ella el orquestador no monta viajes ' +
      'y las pantallas que preguntan a la IA quedan apagadas.',
    secreto: true,
    prueba: 'anthropic',
  },
  {
    clave: 'GOOGLE_MAPS_SERVER_KEY',
    etiqueta: 'Clave de Google Maps (servidor)',
    explica:
      'Geocodificación, Places y Routes: situar los sitios y medir los traslados. ' +
      'La usa el servidor, así que conviene restringirla por IP.',
    secreto: true,
    prueba: 'google-servidor',
  },
  {
    clave: 'GOOGLE_MAPS_BROWSER_KEY',
    etiqueta: 'Clave de Google Maps (navegador)',
    explica:
      'Las teselas del mapa. Esta VIAJA AL NAVEGADOR, así que se ve en el código ' +
      'de la página: restríngela por dominio en la consola de Google.',
    secreto: true,
    prueba: 'google-navegador',
  },
  {
    clave: 'MODELO_CRITERIO',
    etiqueta: 'Modelo «criterio»',
    explica: 'El que decide: ruta, excursiones y reparto de días. El bueno y el caro.',
    secreto: false,
    fabrica: MODELO_CRITERIO_POR_DEFECTO,
  },
  {
    clave: 'MODELO_RAPIDO',
    etiqueta: 'Modelo «rápido»',
    explica: 'El de las tareas mecánicas: listar sitios, elegir hotel entre los buscados.',
    secreto: false,
    fabrica: MODELO_POR_DEFECTO,
  },
  {
    clave: 'RUTA_CHROME',
    etiqueta: 'Ruta a Chrome',
    explica:
      'Dónde está el navegador que usa el scraping. Vacío = se busca solo en los ' +
      'sitios de siempre, y si no aparece se usa el Chromium de Playwright.',
    secreto: false,
  },

  // =========================================================================
  // EL TOUR DE BIENVENIDA — dos ajustes que NO se editan a mano
  // =========================================================================
  //
  // Viven aquí porque son estado del usuario y este es el sitio donde vive el
  // estado del usuario: nada de `localStorage`, que se pierde al cambiar de
  // navegador y no se puede mirar desde el servidor.
  //
  // `interno` los saca de la pantalla de ajustes. No es que se escondan: es que
  // un campo de texto donde escribir «1» no es la manera de decir «quiero ver
  // el tour otra vez». Esa la pone la propia pantalla, con una fila que parece
  // una preferencia y es un botón.
  {
    clave: 'tour_visto',
    etiqueta: 'Tour de bienvenida visto',
    explica: 'Se marca solo al terminar el tour o al saltarlo. Entonces deja de salir.',
    secreto: false,
    interno: true,
  },
  {
    clave: 'tour_tramos_vistos',
    etiqueta: 'Tramos del tour ya vistos',
    explica:
      'Qué pantallas ya enseñaron su tramo, separadas por comas. Es lo que permite ' +
      'que cada pantalla suelte el suyo la primera vez que se pisa, en vez de las ' +
      'nueve burbujas seguidas el primer día.',
    secreto: false,
    interno: true,
  },
];

const PORaCLAVE = new Map(AJUSTES.map((a) => [a.clave, a]));

/** Lo guardado, tal cual está en la base. Uso interno: puede traer secretos. */
function guardados() {
  const filas = todas('SELECT clave, valor, secreto, actualizado_en FROM ajustes_instalacion');
  return new Map(filas.map((f) => [f.clave, f]));
}

/**
 * EL VALOR DE UN AJUSTE, con el orden de siempre: tabla, `.env`, fábrica.
 *
 * Devuelve `''` cuando no hay nada en ningún sitio. Nunca `null`: quien pregunta
 * quiere un valor que poder usar o comparar, no tres formas distintas de nada.
 */
export function ajuste(clave) {
  const fila = una('SELECT valor FROM ajustes_instalacion WHERE clave = ?', clave);
  if (fila?.valor) return fila.valor;

  const delEntorno = process.env[clave];
  if (delEntorno) return delEntorno;

  return PORaCLAVE.get(clave)?.fabrica ?? '';
}

/** De dónde sale el valor que se está usando. Es lo que pinta la pantalla. */
export function origenDe(clave) {
  if (una('SELECT 1 AS hay FROM ajustes_instalacion WHERE clave = ?', clave)) return 'guardado';
  if (process.env[clave]) return 'entorno';
  if (PORaCLAVE.get(clave)?.fabrica) return 'fabrica';
  return 'sin-configurar';
}

/**
 * VUELCA LO GUARDADO A `process.env`.
 *
 * Se llama al arrancar —después de migrar, antes del worker— y cada vez que se
 * guarda o se quita algo, para que una clave nueva funcione sin reiniciar.
 *
 * SOLO PISA LO QUE ESTÁ EN LA TABLA. Lo que no esté guardado se queda con lo que
 * trajera el `.env`: esa es toda la compatibilidad hacia atrás, y por eso esta
 * función no borra nada de `process.env` salvo cuando se quita un ajuste a mano
 * —ver `quitarAjuste`—.
 */
export function volcarAjustes() {
  const filas = guardados();
  for (const [clave, fila] of filas) {
    if (fila.valor) process.env[clave] = fila.valor;
  }
  if (filas.size) {
    console.log(`[ajustes] ${filas.size} ajuste(s) de instalación cargados de la base.`);
  }
  return filas.size;
}

/** Los cuatro últimos. Lo justo para reconocer una clave sin enseñarla. */
function pistaDe(valor) {
  const v = String(valor ?? '');
  return v.length > 4 ? v.slice(-4) : '••••';
}

/**
 * TODO LO QUE NECESITA LA PANTALLA, Y NADA MÁS.
 *
 * De los secretos NO SALE EL VALOR: sale `hay` y `pista`. Aunque alguien mire el
 * HTML de la página o la respuesta del API, no hay clave que copiar.
 */
export function ajustesParaLaPantalla() {
  const filas = guardados();

  // Los internos no se pintan: no son cosas que se escriban a mano.
  return AJUSTES.filter((a) => !a.interno).map((a) => {
    const fila = filas.get(a.clave);
    const origen = origenDe(a.clave);
    const valor = ajuste(a.clave);

    return {
      clave: a.clave,
      etiqueta: a.etiqueta,
      explica: a.explica,
      secreto: Boolean(a.secreto),
      sePuedeProbar: Boolean(a.prueba),
      fabrica: a.fabrica ?? null,
      origen,
      hay: Boolean(valor),
      // El secreto viaja en pista; el resto, en claro, que para eso no lo es.
      pista: a.secreto && valor ? pistaDe(valor) : null,
      valor: a.secreto ? null : valor,
      guardadoEn: fila?.actualizado_en ?? null,
    };
  });
}

/** Un solo ajuste con la misma forma. Lo que se devuelve tras guardar. */
export function ajusteParaLaPantalla(clave) {
  return ajustesParaLaPantalla().find((a) => a.clave === clave) ?? null;
}

// =============================================================================
// ESCRIBIR
// =============================================================================
/** Guarda un ajuste y lo pone a funcionar en caliente. */
export function guardarAjuste(clave, valor) {
  const def = PORaCLAVE.get(clave);
  if (!def) return { error: 'Ese ajuste no existe.' };

  const limpio = String(valor ?? '').trim();
  if (!limpio) return { error: 'No has escrito nada. Para dejarlo vacío, usa «Quitar».' };

  ejecutar(
    `INSERT INTO ajustes_instalacion (clave, valor, secreto, actualizado_en)
     VALUES (?, ?, ?, datetime('now'))
     ON CONFLICT (clave) DO UPDATE SET
       valor = excluded.valor,
       secreto = excluded.secreto,
       actualizado_en = datetime('now')`,
    clave,
    limpio,
    def.secreto ? 1 : 0
  );

  // EN CALIENTE. Sin esto habría que reiniciar para que la clave nueva valiera,
  // y nadie entiende que guardar algo no haga efecto.
  process.env[clave] = limpio;

  console.log(`[ajustes] «${clave}» guardado${def.secreto ? ' (secreto)' : `: ${limpio}`}.`);
  return { ajuste: ajusteParaLaPantalla(clave) };
}

/**
 * Quita un ajuste guardado y devuelve el mando al `.env`.
 *
 * Aquí sí hay que tocar `process.env`: si solo se borrase la fila, el valor
 * guardado seguiría vivo en memoria hasta el siguiente reinicio y «quitar» no
 * quitaría nada. Se borra de `process.env` y se vuelve a volcar, que es lo que
 * devuelve el valor del `.env` si lo había —porque `.env` se recarga al importar
 * los módulos, no aquí—.
 *
 * Y AHÍ ESTÁ EL LÍMITE HONESTO: si el `.env` tenía un valor, esta función no
 * puede resucitarlo en caliente, porque el `.env` ya se leyó al arrancar y su
 * valor fue pisado. La pantalla lo dice: al quitar, avisa de que hace falta
 * reiniciar para volver a usar el del `.env`.
 */
export function quitarAjuste(clave) {
  if (!PORaCLAVE.has(clave)) return { error: 'Ese ajuste no existe.' };

  const r = ejecutar('DELETE FROM ajustes_instalacion WHERE clave = ?', clave);
  delete process.env[clave];
  volcarAjustes();

  console.log(`[ajustes] «${clave}» quitado${r.changes ? '' : ' (no estaba guardado)'}.`);
  return { ajuste: ajusteParaLaPantalla(clave), habiaEnEntorno: false };
}

// =============================================================================
// PROBAR
// =============================================================================
/**
 * ¿FUNCIONA ESTA CREDENCIAL?
 *
 * La llamada más pequeña que cada API admite, con un tope de tiempo corto: esto
 * se pulsa con la pantalla delante y no puede quedarse pensando.
 *
 * SE PRUEBA EL VALOR QUE SE VA A USAR, no lo que hay en la tabla: si estás
 * pegando una clave nueva, quieres saber si ESA vale antes de guardarla. Por eso
 * acepta un valor suelto y, si no viene, usa el que esté en vigor.
 *
 * Y SE DISTINGUE «LA RECHAZAN» DE «NO SE PUDO PREGUNTAR». Un corte de red no es
 * una clave mala, y decir que lo es manda a alguien a buscar una clave nueva que
 * no necesita.
 */
const TIMEOUT_PRUEBA_MS = 10_000;

async function conTope(hacer) {
  const corte = new AbortController();
  const reloj = setTimeout(() => corte.abort(), TIMEOUT_PRUEBA_MS);
  try {
    return await hacer(corte.signal);
  } finally {
    clearTimeout(reloj);
  }
}

/** Anthropic: un mensaje de un token. Es la llamada más barata que existe. */
async function probarAnthropic(clave) {
  const r = await conTope((signal) =>
    fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: {
        'x-api-key': clave,
        'anthropic-version': '2023-06-01',
        'content-type': 'application/json',
      },
      body: JSON.stringify({
        model: ajuste('MODELO_RAPIDO') || MODELO_POR_DEFECTO,
        max_tokens: 1,
        messages: [{ role: 'user', content: 'ok' }],
      }),
      signal,
    })
  );

  if (r.ok) return { ok: true, mensaje: 'La clave funciona.' };

  const cuerpo = await r.json().catch(() => ({}));
  const porQue = cuerpo?.error?.message ?? `HTTP ${r.status}`;

  if (r.status === 401 || r.status === 403) {
    return { ok: false, mensaje: `La rechazan: ${porQue}` };
  }
  if (r.status === 400 && /model/i.test(porQue)) {
    // La clave vale; lo que no existe es el modelo que tiene puesto.
    return { ok: false, mensaje: `La clave parece buena, pero el modelo no vale: ${porQue}` };
  }
  return { ok: false, mensaje: `Contestan que no: ${porQue}` };
}

/** Google, servidor: geocodificar algo que existe desde hace siglos. */
async function probarGoogleServidor(clave) {
  const url = new URL('https://maps.googleapis.com/maps/api/geocode/json');
  url.searchParams.set('address', 'Plaza Mayor, Madrid');
  url.searchParams.set('key', clave);

  const r = await conTope((signal) => fetch(url, { signal }));
  const d = await r.json().catch(() => ({}));

  if (d.status === 'OK') return { ok: true, mensaje: 'La clave funciona (geocodificación).' };
  if (d.status === 'REQUEST_DENIED') {
    return { ok: false, mensaje: `La rechazan: ${d.error_message ?? 'petición denegada'}` };
  }
  if (d.status === 'OVER_QUERY_LIMIT') {
    return { ok: false, mensaje: 'La clave vale, pero está sin cuota o sin facturación activada.' };
  }
  return { ok: false, mensaje: `Google contesta «${d.status ?? `HTTP ${r.status}`}».` };
}

/**
 * Google, navegador: la clave de las teselas del mapa.
 *
 * ESTA NO SE PUEDE PROBAR DE VERDAD DESDE EL SERVIDOR, y hay que decirlo en vez
 * de inventar un veredicto. Dos intentos descartados por medirlo:
 *
 *   · Static Maps devolvía «esta API no está activada en tu proyecto» —cierto, y
 *     da igual: no es la API que usa el mapa—. Decir «la rechazan» por eso manda
 *     a alguien a buscar una clave nueva que no necesita.
 *   · El cargador de la Maps JavaScript API —la que SÍ usa el mapa— contesta 200
 *     y 315 KB de JavaScript casi idéntico con una clave buena y con una
 *     inventada: el error solo aparece en el navegador.
 *
 * Lo que sí se puede saber es si la clave EXISTE, y se pregunta por geocoding,
 * que contesta de verdad. Las tres respuestas son tres cosas distintas y las
 * tres son útiles:
 *
 *   «referer restrictions»  la clave existe Y está restringida por dominio, que
 *                           es exactamente como debe estar una clave que viaja
 *                           al navegador. Lo mejor que puede pasar.
 *   OK                      existe y NO está restringida: funciona, pero
 *                           cualquiera que la copie de tu página puede gastarla.
 *   «API key is invalid»    esa clave no existe. Eso sí es un no.
 */
async function probarGoogleNavegador(clave) {
  const url = new URL('https://maps.googleapis.com/maps/api/geocode/json');
  url.searchParams.set('address', 'Madrid');
  url.searchParams.set('key', clave);

  const r = await conTope((signal) => fetch(url, { signal }));
  const d = await r.json().catch(() => ({}));
  const porQue = d.error_message ?? '';

  if (/referer|referrer/i.test(porQue)) {
    return {
      ok: true,
      mensaje:
        'La clave existe y está restringida por dominio, que es como debe estar. ' +
        'Google no deja comprobarla desde el servidor: míralo abriendo el mapa de un viaje.',
    };
  }

  if (d.status === 'OK') {
    return {
      ok: true,
      aviso: true,
      mensaje:
        'La clave funciona, pero NO está restringida por dominio. Como viaja al navegador, ' +
        'cualquiera puede copiarla del código de la página y gastarla. Restríngela en la consola de Google.',
    };
  }

  if (/invalid/i.test(porQue)) return { ok: false, mensaje: `La rechazan: ${porQue}` };

  // Cualquier otra cosa —una API sin activar, una cuota— no dice nada sobre las
  // teselas: la clave existe, y lo que falla es otra puerta.
  return {
    ok: true,
    aviso: true,
    mensaje:
      `Google contesta «${d.status ?? `HTTP ${r.status}`}»${porQue ? `: ${porQue}` : ''}. ` +
      'Eso no dice nada del mapa: compruébalo abriendo el mapa de un viaje.',
  };
}

/** Prueba una credencial. `valor` opcional: sin él, se prueba la que esté en vigor. */
export async function probarAjuste(clave, valor = null) {
  const def = PORaCLAVE.get(clave);
  if (!def?.prueba) return { error: 'Ese ajuste no se puede probar.' };

  const laQueSeUsa = String(valor ?? '').trim() || ajuste(clave);
  if (!laQueSeUsa) return { error: 'No hay ninguna clave que probar.' };

  try {
    if (def.prueba === 'anthropic') return await probarAnthropic(laQueSeUsa);
    if (def.prueba === 'google-servidor') return await probarGoogleServidor(laQueSeUsa);
    if (def.prueba === 'google-navegador') return await probarGoogleNavegador(laQueSeUsa);
    return { error: 'Esa prueba no existe.' };
  } catch (err) {
    // NO ES LO MISMO QUE LA RECHACEN. Un corte de red o un timeout no significa
    // que la clave sea mala, y decirlo mandaría a alguien a pedir otra por nada.
    const porQue = err?.name === 'AbortError' ? 'no contestaron a tiempo' : err.message;
    return { ok: false, sinRespuesta: true, mensaje: `No se pudo comprobar: ${porQue}.` };
  }
}

export default {
  AJUSTES,
  ajuste,
  origenDe,
  volcarAjustes,
  ajustesParaLaPantalla,
  ajusteParaLaPantalla,
  guardarAjuste,
  quitarAjuste,
  probarAjuste,
};
