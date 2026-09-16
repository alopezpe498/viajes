/**
 * services/rubrica-ciudades.js
 * -----------------------------------------------------------------------------
 * CUÁNTO VALE UNA CIUDAD, CONTADO EN VEZ DE OPINADO.
 *
 * Hasta aquí la fase 1 le pedía a la IA un número del 1 al 5 con una sola frase
 * de instrucción: «"peso" es cuánto merece la pena; no pongas todo a 5». Sin
 * ancla, ese número baila. Medido con diez tiradas de la misma pregunta sobre el
 * mismo destino: Kairouan 4 o 5, El Jem 3 o 4, Sfax 2 o 3. Y el peso no es
 * decorativo —el máximo decide qué repartos de noches son legales—, así que con
 * esos bailes quién entra en la ruta era lotería.
 *
 * LA CURA NO ES PEDIRLE MEJOR EL NÚMERO: ES NO PEDIRLE EL NÚMERO.
 *
 *   La IA aporta EVIDENCIA: casillas de hechos que puede NOMBRAR.
 *   El código hace la ARITMÉTICA: pesos por casilla, ponderación por perfil,
 *   orden y banda.
 *
 * Lo que se gana no es solo estabilidad. Es que la cuenta se puede imprimir:
 * «Kairouan, 9 puntos: UNESCO +3, Gran Mezquita +3, la medina +2, alfombras +1».
 * Un número que se explica se puede discutir; un 4 a ojo, no.
 *
 * DOS PUNTUACIONES, Y LAS DOS HACEN FALTA:
 *
 *   · `objetivos` — lo que vale la ciudad, sin mirar quién viaja. Es un hecho
 *     del mundo y por eso se puede guardar en el catálogo y heredar.
 *   · `perfil`    — lo mismo, ponderado por lo que le interesa a quien viaja.
 *     Depende del viaje y se recalcula en cada uno.
 *
 * Teniendo las dos, el motor puede decir en voz alta lo que antes se tragaba:
 * «dejo fuera esto, que objetivamente es de primer orden, porque tus intereses
 * van por otro lado». Ese aviso es el objetivo, no un extra.
 */

import { una, ejecutar } from '../db/index.js';
import { parametro } from './orquestador.js';
import { consultarJSON, hayClaveIA, temperaturaAlPuntuar } from '../lib/ia.js';
import { CATEGORIAS_SITIO } from './descubrir.js';

// =============================================================================
// LAS CASILLAS
// =============================================================================
/**
 * SIETE CASILLAS, Y CADA UNA EXIGE PODER NOMBRAR LA COSA.
 *
 * El filtro no es la casilla: es la evidencia. «Tiene un casco antiguo bonito»
 * no marca nada; «la Medina de Túnez» sí. Por eso el saneado tira toda casilla
 * cuya evidencia esté vacía o sea una de las fórmulas de relleno de siempre.
 *
 * EL TAMAÑO NO ESTÁ AQUÍ, y es deliberado. Una capital administrativa sin nada
 * que ver no puede subir por ser grande: los habitantes viajan aparte y solo
 * desempatan.
 *
 * Los pesos son la primera calibración y por eso son parámetros: se van a
 * quedar cortos en algo y hay que poder moverlos sin tocar esto.
 */
export const CASILLAS = {
  unesco: {
    peso: 3,
    parametro: 'rubrica_peso_unesco',
    pide: 'el nombre exacto de la inscripción',
    // Categorías de interés que potencian esta casilla. Las transversales llevan
    // pocas a propósito: si potenciaran todas, no ponderarían nada.
    potencian: ['monumentos', 'museos'],
  },
  hito_de_primer_orden: {
    peso: 3,
    parametro: 'rubrica_peso_hito',
    pide: 'el nombre del monumento o yacimiento',
    potencian: ['monumentos'],
  },
  conjunto_historico: {
    peso: 2,
    parametro: 'rubrica_peso_conjunto',
    pide: 'cómo se llama ese casco antiguo',
    potencian: ['barrios y paseos', 'monumentos'],
  },
  museo_de_referencia: {
    peso: 2,
    parametro: 'rubrica_peso_museo',
    pide: 'el nombre del museo y de qué es su colección',
    potencian: ['museos'],
  },
  paisaje_singular: {
    peso: 2,
    parametro: 'rubrica_peso_paisaje',
    pide: 'qué accidente natural concreto',
    potencian: ['naturaleza', 'miradores'],
  },
  cocina_o_artesania: {
    peso: 1,
    parametro: 'rubrica_peso_cocina',
    pide: 'qué plato o producto, y dónde se le conoce',
    potencian: ['gastronomía', 'compras y mercados'],
  },
  puerta_de_region: {
    peso: 1,
    parametro: 'rubrica_peso_puerta',
    pide: 'qué zona y qué se hace desde ahí',
    potencian: [],
  },
};

export const NOMBRES_DE_CASILLA = Object.keys(CASILLAS);

/** Lo que vale cada casilla ahora mismo, con los parámetros puestos. */
export function pesoDeCasilla(nombre) {
  const c = CASILLAS[nombre];
  if (!c) return 0;
  const v = parametro(c.parametro, c.peso);
  return Number.isFinite(v) && v >= 0 ? v : c.peso;
}

// =============================================================================
// EL SANEADO: UNA CASILLA SIN NOMBRE NO ES UNA CASILLA
// =============================================================================
/**
 * Fórmulas que no son evidencia de nada.
 *
 * Son las que el modelo escribe cuando no tiene el dato pero no quiere dejar el
 * hueco. No están para castigarle: están porque «con encanto» y «la Medina de
 * Túnez» no pueden valer los mismos tres puntos.
 */
const RELLENO =
  /^(?:muy\s+)?(?:bonita?|bonito|precios[oa]|encantador[a]?|con\s+encanto|con\s+identidad|aut[eé]ntic[oa]|[uú]nic[oa]|espectacular|impresionante|hist[oó]ric[oa]|interesante|var[ií]os?|much[oa]s?|s[ií]|n[oa]|-+|\.*)$/i;

/** Una evidencia vale si nombra algo: tiene letras, largo suficiente y no es relleno. */
export function evidenciaValida(texto) {
  const t = String(texto ?? '').trim();
  if (t.length < 4) return false;
  if (!/[a-zá-úñ]{3}/i.test(t)) return false;
  return !RELLENO.test(t);
}

/**
 * Deja la evidencia de una ciudad en la forma que usa el resto del módulo.
 *
 * Tira lo que no reconoce y lo que no nombra nada, y DEVUELVE TAMBIÉN LO
 * TIRADO: una casilla descartada es justo lo que hay que poder mirar cuando una
 * ciudad salga más baja de lo que parecía.
 */
export function sanearEvidencia(crudo) {
  const puestas = {};
  const tiradas = [];

  const lista = Array.isArray(crudo) ? crudo : [];
  for (const e of lista) {
    const casilla = String(e?.casilla ?? '').trim();
    if (!CASILLAS[casilla]) {
      if (casilla) tiradas.push({ casilla, motivo: 'no es una casilla de la rúbrica' });
      continue;
    }
    if (puestas[casilla]) continue; // repetida: la primera manda
    const evidencia = String(e?.evidencia ?? '').trim();
    if (!evidenciaValida(evidencia)) {
      tiradas.push({ casilla, motivo: evidencia ? `no nombra nada: «${evidencia}»` : 'sin evidencia' });
      continue;
    }
    puestas[casilla] = evidencia;
  }

  return { puestas, tiradas };
}

// =============================================================================
// EL PERFIL DE QUIEN VIAJA
// =============================================================================
/**
 * El multiplicador de cada casilla según lo que le interesa a quien viaja.
 *
 * `1 + bonus × (categorías marcadas que potencian esa casilla)`, con tope. Quien
 * marca TODAS las categorías —que es el caso por defecto— obtiene
 * multiplicadores casi planos, y está bien que así sea: no ha priorizado, así
 * que la rúbrica decide sola.
 *
 * `ajustes` son los que salen de traducir el texto libre («evitar el desierto»)
 * y suman o restan categorías, con su motivo escrito. Van aparte porque son lo
 * único de aquí que no es una casilla marcada en una pantalla.
 */
export function multiplicadoresDe({ categorias = [], ajustes = [] } = {}) {
  const bonus = parametro('rubrica_bonus_por_interes', 0.35);
  const tope = parametro('rubrica_tope_multiplicador', 2);

  // Cada categoría vale 1; los ajustes del texto libre la suben o la bajan.
  const fuerza = new Map();
  for (const c of categorias) fuerza.set(c, (fuerza.get(c) ?? 0) + 1);
  for (const a of ajustes) {
    const signo = Number(a?.signo);
    if (!Number.isFinite(signo) || !a?.categoria) continue;
    fuerza.set(a.categoria, (fuerza.get(a.categoria) ?? 0) + signo);
  }

  const mult = {};
  for (const [nombre, c] of Object.entries(CASILLAS)) {
    const suma = c.potencian.reduce((s, cat) => s + Math.max(0, fuerza.get(cat) ?? 0), 0);
    mult[nombre] = Math.min(tope, Math.max(0, 1 + bonus * suma));
  }
  return mult;
}

/**
 * EL TEXTO LIBRE, TRADUCIDO A NÚMEROS QUE SE PUEDEN LEER.
 *
 * «Evitar visitas y excursiones al desierto» no se puede sumar. Hasta ahora se
 * metía tal cual en el prompt y ahí se quedaba: influía, pero por un camino que
 * no se podía auditar, así que la cuenta impresa nunca iba a explicar del todo
 * por qué una ciudad salió como salió.
 *
 * Se traduce UNA VEZ por viaje y se guarda. Y es lo único de este módulo que le
 * pregunta algo a la IA, con un encargo deliberadamente pequeño: no opina sobre
 * ciudades, solo dice a qué categorías apunta una frase y en qué sentido. Eso es
 * estable —va de la frase de quien viaja, no del mundo— y queda escrito con su
 * porqué al lado.
 *
 * Si falla o no hay clave, se devuelve la lista vacía: el viaje sigue con la
 * rúbrica objetiva y las categorías marcadas, que es exactamente lo de antes.
 */
export async function ajustesDelTextoLibre(viaje, texto, di = () => {}) {
  const frase = String(texto ?? '').trim();
  if (!frase) return [];

  // La caché va por frase: si la cambia, se vuelve a preguntar; si no, nunca.
  try {
    const guardado = JSON.parse(viaje?.perfil_intereses ?? 'null');
    if (guardado?.frase === frase && Array.isArray(guardado.ajustes)) return guardado.ajustes;
  } catch {
    /* json roto: se vuelve a preguntar */
  }

  if (!hayClaveIA()) return [];

  let ajustes = [];
  try {
    const r = await consultarJSON(
      [
        'Alguien ha escrito esto sobre lo que le interesa de un viaje:',
        '',
        `«${frase}»`,
        '',
        'Dime a qué categorías de visita apunta y en qué sentido.',
        '',
        `Categorías, copiadas tal cual: ${CATEGORIAS_SITIO.join(' | ')}`,
        '',
        'Reglas:',
        '- "signo" es 1 si la frase pide MÁS de esa categoría y -1 si pide MENOS',
        '  o la evita. No hay medias tintas ni otros números.',
        '- Solo las categorías que la frase mencione o implique CLARAMENTE. Si la',
        '  frase no habla de una categoría, no la pongas: una lista corta y',
        '  segura vale más que una larga y adivinada.',
        '- "por_que" cita el trozo de la frase del que sale. Sin cita, no lo pongas.',
        '- Si la frase no permite deducir nada, devuelve {"ajustes":[]}. Es una',
        '  respuesta correcta y no un fallo.',
        '',
        'Devuelve SOLO: {"ajustes":[{"categoria":"naturaleza","signo":-1,"por_que":"dice «evitar el desierto»"}]}',
      ].join('\n'),
      {
        maxTokens: 500,
        paso: 'traducir los intereses escritos a mano',
        temperatura: temperaturaAlPuntuar(),
        // Clasificar una frase en categorías es mecánica: la puntuación la hace
        // el código con el resultado. Corre dentro de la fase 1, que está en
        // criterio, y sin esto se iba al modelo caro sin ninguna necesidad.
        modelo: 'rapido',
      }
    );
    ajustes = (Array.isArray(r?.ajustes) ? r.ajustes : [])
      .map((a) => ({
        categoria: String(a?.categoria ?? '').trim().toLowerCase(),
        signo: Number(a?.signo) > 0 ? 1 : Number(a?.signo) < 0 ? -1 : 0,
        porQue: String(a?.por_que ?? '').trim(),
      }))
      .filter((a) => CATEGORIAS_SITIO.includes(a.categoria) && a.signo !== 0 && a.porQue);
  } catch (err) {
    di(`   No pude traducir «${frase}» a categorías (${err.message}). Sigo sin ese ajuste.`);
    return [];
  }

  if (viaje?.id) {
    ejecutar(
      'UPDATE viajes SET perfil_intereses = ? WHERE id = ?',
      JSON.stringify({ frase, ajustes }),
      viaje.id
    );
  }

  for (const a of ajustes) {
    di(`   Tus intereses: ${a.signo > 0 ? 'más' : 'menos'} «${a.categoria}» — ${a.porQue}.`);
  }
  return ajustes;
}

/** Lo guardado para este viaje, sin preguntar nada. Para pintarlo o repasarlo. */
export function ajustesGuardados(viajeId) {
  const v = una('SELECT perfil_intereses FROM viajes WHERE id = ?', Number(viajeId));
  try {
    const g = JSON.parse(v?.perfil_intereses ?? 'null');
    return Array.isArray(g?.ajustes) ? g.ajustes : [];
  } catch {
    return [];
  }
}

// =============================================================================
// LA CUENTA
// =============================================================================
/**
 * Los puntos de una ciudad, con el desglose para poder enseñarlo.
 *
 * `objetivos` no mira el perfil; `perfil` sí. La diferencia entre los dos es lo
 * que permite decir «esto vale, pero no para ti», que es medio objetivo de toda
 * esta recalibración.
 */
export function puntosDeCiudad(evidencia, multiplicadores = null) {
  const puestas = evidencia && typeof evidencia === 'object' ? evidencia : {};
  const mult = multiplicadores ?? {};

  let objetivos = 0;
  let conPerfil = 0;
  const desglose = [];

  for (const casilla of NOMBRES_DE_CASILLA) {
    const texto = puestas[casilla];
    if (!texto) continue;
    const base = pesoDeCasilla(casilla);
    const m = Number.isFinite(mult[casilla]) ? mult[casilla] : 1;
    objetivos += base;
    conPerfil += base * m;
    desglose.push({ casilla, evidencia: texto, base, multiplicador: m, puntos: base * m });
  }

  return { objetivos, perfil: conPerfil, desglose };
}

/**
 * LA BANDA 1-5, QUE ES SOLO PARA LEER.
 *
 * Las decisiones —quién manda, cómo se ordenan los repartos— van con la
 * puntuación continua, que es lo que evita que dos ciudades a 8 y 9 puntos caigan
 * en el mismo escalón y se empaten por un redondeo. Esto existe porque el prompt
 * del paso 3 y la pantalla llevan toda la vida hablando de «peso 1-5» y un 7,4
 * ahí no se lee.
 *
 * NO SE USA PARA DECIDIR NADA. Si algún día aparece un `=== banda` en una
 * decisión, es un error.
 */
export function bandaDePuntos(puntos) {
  const p = Number(puntos) || 0;
  if (p >= 9) return 5;
  if (p >= 6.5) return 4;
  if (p >= 4) return 3;
  if (p >= 2) return 2;
  return 1;
}

/**
 * ¿ESTOS DOS PESOS SON «EL MISMO»?
 *
 * Con enteros del 1 al 5, `peso === pesoMaximo` era una pregunta sensata y media
 * docena de decisiones la hacían. Con puntuación continua esa igualdad no se
 * cumple casi nunca, y las reglas que dependían de ella —«la ruta tiene que
 * incluir una ciudad de peso máximo», «un donante del mismo peso con dos noches
 * más»— se quedarían mudas o, peor, se volverían mucho más estrictas sin que
 * nadie lo hubiera decidido.
 *
 * Así que el empate se conserva, pero con una holgura declarada: dos ciudades
 * que se llevan menos de un 15% son «igual de importantes» para esas reglas.
 */
export function mismoPeso(a, b) {
  const x = Number(a) || 0;
  const y = Number(b) || 0;
  const mayor = Math.max(Math.abs(x), Math.abs(y));
  if (!mayor) return true;
  return Math.abs(x - y) <= parametro('rubrica_holgura_de_empate', 0.15) * mayor;
}

// =============================================================================
// CÓMO SE CUENTA EN VOZ ALTA
// =============================================================================
/** «UNESCO «Medina de Túnez» +3 · hito «Gran Mezquita» +3 ×1,4» */
export function comoSeLeeLaCuenta(desglose) {
  return desglose
    .map((d) => {
      const m = d.multiplicador === 1 ? '' : ` ×${d.multiplicador.toFixed(2).replace(/\.?0+$/, '')}`;
      return `${d.casilla.replace(/_/g, ' ')} «${d.evidencia}» +${d.base}${m}`;
    })
    .join(' · ');
}

export default {
  ajustesDelTextoLibre,
  ajustesGuardados,
  CASILLAS,
  NOMBRES_DE_CASILLA,
  pesoDeCasilla,
  evidenciaValida,
  sanearEvidencia,
  multiplicadoresDe,
  puntosDeCiudad,
  bandaDePuntos,
  mismoPeso,
  comoSeLeeLaCuenta,
};
