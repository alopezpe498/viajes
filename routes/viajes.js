/**
 * routes/viajes.js
 * -----------------------------------------------------------------------------
 * Todas las rutas del wizard.
 *
 * EL WIZARD TIENE 7 PASOS:
 *   1 Configuración (fechas + viajeros + tipo)   <- absorbió el antiguo "Tipo"
 *   2 Destino
 *   3 Avisos
 *   4 Qué ver
 *   5 Vuelos
 *   6 Hotel
 *   7 Dosier
 *
 * Dos ideas que se repiten en todo el fichero:
 *  1. `paso_actual` se guarda en CADA cambio de pantalla, para poder cerrar el
 *     navegador y retomar donde lo dejaste.
 *  2. Las pantallas NUNCA leen datos directamente: siempre piden a
 *     services/proveedores.js.
 */

import express from 'express';
import { todas, una, ejecutar, nochesEntre } from '../db/index.js';
import {
  obtenerActividades,
  obtenerVuelos,
  obtenerHoteles,
  obtenerAvisos,
  obtenerSeleccion,
  refrescarActividades,
  estadoActividades,
  refrescarHoteles,
  estadoHoteles,
  filtrosHotelesDe,
  guardarFiltrosHoteles,
  resumenFiltros,
  refrescarVuelos,
  estadoVuelos,
  filtrosVuelosDe,
  guardarFiltrosVuelos,
  resumenFiltrosVuelos,
  refrescarAvisos,
  estadoAvisos,
  olvidarAvisos,
  olvidarTransporteYAlojamiento,
} from '../services/proveedores.js';
import { sincronizarEtapaUnica } from '../services/etapas.js';
import { asegurarDestino, destinoPorNombre, actividadPorId } from '../services/catalogo.js';
import { panoramaDeDestino, fichaDeUnPunto, olvidarInvestigacion } from '../services/descubrir.js';
import { encolar, trabajoActivo, ultimoTrabajo } from '../jobs/cola.js';
import { hayClaveIA } from '../lib/ia.js';
import { sitioEnCoordenadas, sitioPorTexto } from '../services/geocodificar.js';
import {
  recalcularRuta,
  rutaDeViaje,
  confirmarEtapa,
  reordenar,
  clonarEtapa,
  quitarEtapa,
  cambiarNoches,
} from '../services/ruta.js';
import {
  cargarEtapa,
  queVerDeEtapa,
  alternarApuntado,
  hotelesDeEtapa,
  buscarHotelesDeEtapa,
  elegirHotel,
  estadoHotelesDeEtapa,
  tramosDeEtapa,
  describirTramo,
  asegurarDistancia,
  guardarTransporteManual,
  olvidarTransporteManual,
  guardarNotas,
  TIPOS_TRANSPORTE,
  vuelosDeTramo,
  filtrosVuelosDeTramo,
  guardarFiltrosVuelosTramo,
  asegurarEtapaDeCiudad,
  prepararEtapa,
  estadoPreparacionEtapa,
} from '../services/etapa.js';
import {
  lienzoDeViaje,
  colocar,
  mover,
  quitar,
  retocar,
  moverEnFranja,
  vecinosDeHueco,
  colocacionesDeEtapa,
  FRANJAS,
} from '../services/lienzo.js';
import {
  generarDosier,
  leerDosier,
  zipDelViaje,
  estadoDelDosier,
} from '../services/dosier.js';
import {
  comerDeEtapa,
  fichaDeComer,
  pedirBusquedaDeComer,
  guardarFichaManual,
  actualizarFichaDeComer,
  borrarFichaDeComer,
  pedirDetallesDeComer,
  estadoDetallesDeComer,
  buscarEntre,
} from '../services/comer.js';
import {
  TIPOS_CON_DIRECCION,
  direccionDe,
  guardarDireccion,
  volcarDireccionDeHotel,
  pedirGeocodificar,
  lugaresDeEtapa,
  paraLaVista,
} from '../services/direcciones.js';
import {
  trasladosDeEtapa,
  crearTraslado,
  recalcularTraslado,
  borrarTraslado,
  trasladoPorId,
  calcularTraslado,
  trasladosDeElemento,
  trasladosDeElementos,
  fijarTraslado,
} from '../services/traslados.js';
import {
  comoLlegarDeTramo,
  pedirTransporteDeTramo,
  elegirMedio,
  guardarDatosDelTramo,
  guardarFichaTramo,
  actualizarFichaTramo,
  borrarFichaTramo,
  moverseDeEtapa,
  pedirMovilidadDeCiudad,
  guardarFichaMovilidad,
  actualizarFichaMovilidad,
  borrarFichaMovilidad,
} from '../services/movilidad.js';
import {
  distanciasDelMapa,
  referenciaDelViaje,
  trasladosDeLaRuta,
  avisoDeTraslados,
} from '../services/distancias-ciudades.js';
import {
  guardarAdjunto,
  adjuntosDe,
  adjuntoPorId,
  borrarAdjunto,
  limpiarAdjuntosHuerfanos,
  borrarAdjuntosDelViaje,
  rutaDe,
  comoTamano,
  TOPE as TOPE_ADJUNTO,
} from '../services/adjuntos.js';
import { fichasDelViaje, generarFicha, marcarRevisado } from '../services/ficha-pais.js';
import { mapaDeEtapa } from '../services/mapa-etapa.js';
import { buscandoDatos } from '../services/datos-sitios.js';
import {
  pedirBusqueda,
  elegirPropuestas,
  borrarBusqueda,
  busquedasDeEtapa,
} from '../services/busquedas-sitios.js';
import {
  OPCIONES_AUTO,
  VIAJEROS_PARA_FAMILIAR,
  configAuto,
  validarConfigAuto,
  lanzarOrquestador,
  progresoDeViaje,
  parametros,
  guardarParametro,
  restaurarParametro,
  prompts,
  guardarPrompt,
  restaurarPrompt,
} from '../services/orquestador.js';
import { CATEGORIAS_SITIO } from '../services/descubrir.js';
import {
  datosDePortada,
  borrarViaje,
  loQueArrastra,
  renombrarViaje,
} from '../services/portada.js';

export const router = express.Router();

/** Cuántos pasos tiene el wizard. Si cambia, cambia también en la cabecera. */
const TOTAL_PASOS = 7;

/** Chips de tipo de viaje (ahora viven en la pantalla 1). */
const TIPOS_VIAJE = [
  { valor: 'cultural',     etiqueta: 'Cultural' },
  { valor: 'gastronomico', etiqueta: 'Gastronómico' },
  { valor: 'naturaleza',   etiqueta: 'Naturaleza' },
  { valor: 'relax',        etiqueta: 'Relax' },
  { valor: 'mixto',        etiqueta: 'Mixto' },
];

/** Ritmos posibles (plegado "Más opciones" de la pantalla 1). */
const RITMOS = ['tranquilo', 'normal', 'intenso'];

/** Carga el viaje o corta con un 404 legible. */
function cargarViaje(req, res, next) {
  const viaje = una('SELECT * FROM viajes WHERE id = ?', Number(req.params.id));
  if (!viaje) {
    return res.status(404).send('No existe ese viaje. <a href="/">Volver a mis viajes</a>');
  }
  // edades_ninos se guarda como JSON: lo desempaquetamos una sola vez aquí.
  viaje.edadesNinos = viaje.edades_ninos ? JSON.parse(viaje.edades_ninos) : [];
  req.viaje = viaje;
  next();
}

/** Guarda en qué paso está el viaje. */
function guardarPaso(viajeId, paso) {
  ejecutar('UPDATE viajes SET paso_actual = ? WHERE id = ?', paso, viajeId);
}

/** Normaliza a array lo que llega de un formulario con campos repetidos. */
/**
 * Lee los filtros de HOTEL de un formulario.
 *
 * Está aquí suelta porque ahora hay DOS sitios que mandan este formulario: el
 * paso 6 del wizard y la pestaña "Dónde dormir" de una etapa. Es el mismo
 * panel (parciales/filtros-hotel.ejs) y tiene que entenderse igual en los dos.
 *
 * `distanciaMax` es el único raro: es un filtro LOCAL que en el paso 6 se
 * aplica al momento y no viaja con el formulario. Si no viene, se conserva el
 * que hubiera en vez de borrarlo.
 */
/**
 * Le pone al hotel elegido sus adjuntos.
 *
 * Solo al ELEGIDO: los papeles son de la reserva que se ha hecho, no de los
 * diecinueve hoteles que quedaron por el camino.
 */
function conAdjuntosDelHotel(dormir) {
  if (!dormir?.elegido) return dormir;
  return {
    ...dormir,
    elegido: { ...dormir.elegido, adjuntos: adjuntosDe('alojamiento', dormir.elegido.id) },
  };
}

function filtrosDelCuerpo(cuerpo, anteriores = null) {
  const aEntero = (v) => {
    const n = Number(v);
    return Number.isFinite(n) && n > 0 ? Math.round(n) : null;
  };

  let precioMin = aEntero(cuerpo.precioMin);
  let precioMax = aEntero(cuerpo.precioMax);
  // Si los pones al revés, los cambiamos en vez de dar error: se entiende igual.
  if (precioMin && precioMax && precioMin > precioMax) [precioMin, precioMax] = [precioMax, precioMin];

  const distancia = Number(cuerpo.distanciaMax);

  return {
    precioMin,
    precioMax,
    notaMinima: [7, 8, 9].includes(Number(cuerpo.notaMinima)) ? Number(cuerpo.notaMinima) : null,
    estrellas: [3, 4, 5].includes(Number(cuerpo.estrellas)) ? Number(cuerpo.estrellas) : null,
    piscina: cuerpo.piscina === '1',
    wifi: cuerpo.wifi === '1',
    parking: cuerpo.parking === '1',
    desayuno: cuerpo.desayuno === '1',
    cancelacionGratis: cuerpo.cancelacionGratis === '1',
    tipoAlojamiento: ['hotel', 'apartamento'].includes(cuerpo.tipoAlojamiento)
      ? cuerpo.tipoAlojamiento
      : null,
    distanciaMax: 'distanciaMax' in cuerpo
      ? ([1, 3].includes(distancia) ? distancia : null)
      : (anteriores?.distanciaMax ?? null),
  };
}

/**
 * Lee los filtros de VUELO de un formulario. Lo mandan el paso 5 (ida y vuelta)
 * y cada tramo de una etapa (solo ida, y ahí no hay `salidaVuelta` que elegir).
 */
function filtrosVueloDelCuerpo(cuerpo) {
  const aEntero = (v) => {
    const n = Number(v);
    return Number.isFinite(n) && n > 0 ? Math.round(n) : null;
  };
  const franja = (v) => (['manana', 'tarde', 'noche'].includes(v) ? v : null);

  return {
    escalas: ['directos', 'max1'].includes(cuerpo.escalas) ? cuerpo.escalas : null,
    duracionMax: [4, 8, 12].includes(Number(cuerpo.duracionMax)) ? Number(cuerpo.duracionMax) : null,
    salidaIda: franja(cuerpo.salidaIda),
    salidaVuelta: franja(cuerpo.salidaVuelta),
    precioMaxPersona: aEntero(cuerpo.precioMaxPersona),
  };
}

/**
 * A donde vuelve la pantalla de configuracion al guardar.
 *
 * Cuando habia wizard, de aqui se iba SIEMPRE al paso siguiente. Ya no hay
 * pasos: a la configuracion se entra desde la ruta para cambiar unas fechas, y
 * lo que espera cualquiera es volver a la ruta.
 *
 * El `volverA` solo se acepta si es una ruta interna: un parametro de la URL no
 * puede acabar mandando a nadie fuera de la aplicacion.
 */
function destinoDeVuelta(volverA, viaje, esNuevo) {
  if (typeof volverA === 'string' && /^\/[^/\\]/.test(volverA)) return volverA;
  return esNuevo ? `/elegir-destino/${viaje.id}` : `/viaje/${viaje.id}/ruta`;
}

function comoLista(valor) {
  if (valor === undefined || valor === null) return [];
  return Array.isArray(valor) ? valor : [valor];
}

// =============================================================================
// HOME
// =============================================================================
router.get('/', (req, res) => {
  res.render('home', datosDePortada());
});

/** Crea un viaje vacío y entra directo al paso 1. */
router.post('/viajes', (req, res) => {
  const r = ejecutar(
    `INSERT INTO viajes (nombre, paso_actual, estado) VALUES (?, 1, 'borrador')`,
    'Viaje sin nombre'
  );
  res.redirect(`/viajes/${Number(r.lastInsertRowid)}/paso/1`);
});

/** Entrar en un viaje = seguir donde lo dejaste. */
/**
 * Entrar en un viaje desde la portada.
 *
 * Antes esto reabría el configurador (fechas, viajeros, continuar…) y había que
 * pasar otra vez por todos los pasos hasta llegar al mapa. Eso solo tiene
 * sentido la primera vez; a un viaje que ya existe se entra por donde se dejó.
 *
 * El orden de las tres preguntas es el del trabajo, de más avanzado a menos:
 *
 *   1. ¿Tiene paradas? -> a la RUTA, que es donde se monta el viaje.
 *   2. ¿Tiene destino investigado? -> a DESCUBRIR, a seguir eligiendo sitios.
 *   3. ¿No tiene nada? -> al MAPAMUNDI, a elegir a dónde va.
 *
 * Solo se cae al configurador si el viaje ni siquiera tiene fechas, que es un
 * viaje recién creado y ahí sí hay que empezar por el principio.
 */
router.get('/viajes/:id', cargarViaje, (req, res) => {
  const viaje = req.viaje;

  // 1) Con paradas (candidatas o confirmadas), la ruta.
  const etapas = una('SELECT COUNT(*) AS n FROM etapas WHERE viaje_id = ?', viaje.id).n;
  if (etapas > 0) return res.redirect(`/viaje/${viaje.id}/ruta`);

  // 2) Sin paradas pero con el destino ya investigado, a seguir descubriéndolo.
  if (viaje.destino) {
    const enCatalogo = destinoPorNombre(viaje.destino);
    if (enCatalogo) return res.redirect(`/descubrir/${enCatalogo.id}?viaje=${viaje.id}`);
  }

  // 3) Sin nada. Si ya tiene su configuración, directo al mapa; si ni eso, al
  //    configurador, que es lo único que le falta.
  if (viaje.fecha_inicio && viaje.fecha_fin) {
    return res.redirect(`/elegir-destino/${viaje.id}`);
  }
  return res.redirect(`/viajes/${viaje.id}/paso/1`);
});

/**
 * Alias del antiguo paso "Tipo de viaje", que ya no existe como pantalla.
 * Si tenías un enlace guardado, te lleva a donde vive ahora ese contenido.
 */
router.get('/viajes/:id/tipo', cargarViaje, (req, res) => {
  res.redirect(`/viajes/${req.viaje.id}/paso/1`);
});

// =============================================================================
// PASO 2b — rama "ayúdame a elegir" (maqueta, sin IA conectada)
// =============================================================================
router.get('/viajes/:id/destino/ayuda', cargarViaje, (req, res) => {
  res.render('paso2b-ayuda', { viaje: req.viaje });
});

// =============================================================================
// PASOS 1..7 — GET (pintar) y POST (guardar y avanzar)
// =============================================================================
router.get('/viajes/:id/paso/:n', cargarViaje, async (req, res) => {
  const viaje = req.viaje;
  const paso = Number(req.params.n);

  if (!Number.isInteger(paso) || paso < 1) {
    return res.status(400).send('Paso fuera de rango. <a href="/">Volver</a>');
  }
  // El wizard tenía 8 pasos: un enlace viejo al 8 va al último de ahora.
  if (paso > TOTAL_PASOS) {
    return res.redirect(`/viajes/${viaje.id}/paso/${TOTAL_PASOS}`);
  }

  guardarPaso(viaje.id, paso);
  const seleccion = await obtenerSeleccion(viaje.id);

  switch (paso) {
    case 1: {
      // A donde se vuelve al guardar. Si vienes de la ruta, a la ruta; si el
      // viaje acaba de nacer y todavia no tiene destino, al mapamundi.
      const esNuevo = !viaje.destino;
      return res.render('paso1-configuracion', {
        viaje,
        tipos: TIPOS_VIAJE,
        seleccionados: (viaje.tipo_viaje || '').split(',').filter(Boolean),
        ritmos: RITMOS,
        esNuevo,
        urlVolver: destinoDeVuelta(req.query.volverA, viaje, esNuevo),
        // Lo del modo automatico. Va siempre, aunque el check este apagado: la
        // seccion se pinta oculta para que el navegador conserve lo escrito
        // cuando se marca y se desmarca.
        auto: configAuto(viaje),
        opcionesAuto: OPCIONES_AUTO,
        categorias: CATEGORIAS_SITIO,
        viajerosTotales: (viaje.adultos ?? 2) + (viaje.ninos ?? 0),
        viajerosParaFamiliar: VIAJEROS_PARA_FAMILIAR,
        error: null,
      });
    }

    // El paso 2 dejó de ser un campo de texto y pasó a ser el mapamundi. Se
    // mantiene la redirección para que el enlace de la tarjeta de embarque (y
    // cualquier marcador viejo) siga llevando a donde ahora se elige el destino.
    case 2:
      return res.redirect(`/elegir-destino/${viaje.id}`);

    case 3: {
      const resultado = await obtenerAvisos(viaje);
      return res.render('paso3-avisos', {
        viaje,
        estado: resultado.estado,
        avisos: resultado.avisos,
        trabajo: resultado.trabajo,
      });
    }

    case 4: {
      const catalogo = await obtenerActividades(viaje);
      return res.render('paso4-catalogo', {
        viaje,
        estado: catalogo.estado,
        actividades: catalogo.actividades,
        trabajo: catalogo.trabajo,
        seleccion,
      });
    }

    case 5: {
      // El orden viaja en la URL, igual que en hoteles, para que los chips
      // funcionen sin JavaScript.
      const ordenesValidos = ['precio', 'duracion'];
      const orden = ordenesValidos.includes(req.query.orden) ? req.query.orden : 'precio';
      const resultado = await obtenerVuelos(viaje, { orden });
      const filtrosV = filtrosVuelosDe(viaje);
      return res.render('paso5-vuelos', {
        viaje,
        estado: resultado.estado,
        vuelos: resultado.vuelos,
        trabajo: resultado.trabajo,
        orden,
        filtros: filtrosV,
        resumenDeFiltros: resumenFiltrosVuelos(filtrosV),
        totalSinFiltrosLocales: resultado.totalSinFiltrosLocales ?? 0,
        ocultosPorFiltros: resultado.ocultosPorFiltros ?? 0,
        seleccion,
      });
    }

    case 6: {
      // El orden viaja en la URL (?orden=precio) para que los chips funcionen
      // sin JavaScript y el enlace se pueda compartir o recargar.
      const ordenesValidos = ['recomendados', 'precio', 'nota'];
      const orden = ordenesValidos.includes(req.query.orden) ? req.query.orden : 'recomendados';
      const resultado = await obtenerHoteles(viaje, { orden });
      const filtros = filtrosHotelesDe(viaje);
      return res.render('paso6-hoteles', {
        viaje,
        estado: resultado.estado,
        hoteles: resultado.hoteles,
        trabajo: resultado.trabajo,
        orden,
        filtros,
        resumenDeFiltros: resumenFiltros(filtros),
        ocultosPorDistancia: resultado.ocultosPorDistancia ?? 0,
        seleccion,
      });
    }

    case 7:
      return res.render('paso7-resumen', { viaje, seleccion });
  }
});

/** Solo los pasos con formulario (1 y 2) mandan POST. */
router.post('/viajes/:id/paso/:n', cargarViaje, async (req, res) => {
  const viaje = req.viaje;
  const paso = Number(req.params.n);

  // ---------------------------------------------------------------------------
  // PASO 1: configuración (fechas + viajeros + tipo + más opciones)
  // ---------------------------------------------------------------------------
  if (paso === 1) {
    const { fecha_inicio, fecha_fin, presupuesto, tipo_viaje, ritmo, ciudad_origen } = req.body;

    /** Vuelve a pintar la pantalla conservando lo que había escrito. */
    const esNuevo = !viaje.destino;
    // Lo que llegue de la seccion automatica, aun sin validar. Se declara aqui
    // porque `conError` lo necesita para poder devolver la pantalla con lo
    // escrito puesto, y se rellena mas abajo cuando toca validar.
    let datosAuto = null;
    const urlVolver = destinoDeVuelta(req.body.volverA, viaje, esNuevo);

    const conError = (mensaje, campo) =>
      res.render('paso1-configuracion', {
        viaje: {
          ...viaje,
          fecha_inicio,
          fecha_fin,
          presupuesto,
          tipo_viaje,
          ritmo,
          ciudad_origen,
          adultos: Number(req.body.adultos) || viaje.adultos,
          ninos: Number(req.body.ninos) || 0,
          edadesNinos: comoLista(req.body.edades_ninos).map(Number),
          // El check, tal y como lo dejo el usuario: si vuelve la pantalla con
          // un error, la seccion tiene que seguir abierta.
          automatico: req.body.automatico ? 1 : 0,
        },
        tipos: TIPOS_VIAJE,
        seleccionados: (tipo_viaje || '').split(',').filter(Boolean),
        ritmos: RITMOS,
        esNuevo,
        urlVolver,
        // Lo que habia escrito en la seccion automatica, para no perderlo.
        auto: { ...configAuto(viaje), ...(datosAuto ?? {}) },
        opcionesAuto: OPCIONES_AUTO,
        categorias: CATEGORIAS_SITIO,
        viajerosTotales: (Number(req.body.adultos) || viaje.adultos || 2) + (Number(req.body.ninos) || 0),
        viajerosParaFamiliar: VIAJEROS_PARA_FAMILIAR,
        error: { mensaje, campo },
      });

    // --- Fechas: coherentes y no en el pasado ---
    if (!fecha_inicio || !fecha_fin) {
      return conError('Necesito las dos fechas para seguir.', 'fecha_inicio');
    }
    if (fecha_fin <= fecha_inicio) {
      return conError('La vuelta tiene que ser posterior a la ida.', 'fecha_fin');
    }
    const hoy = new Date();
    hoy.setHours(0, 0, 0, 0);
    if (new Date(`${fecha_inicio}T12:00:00`) < hoy) {
      return conError('Esa fecha de ida ya ha pasado.', 'fecha_inicio');
    }

    // --- Viajeros ---
    const adultos = Math.min(Math.max(Number(req.body.adultos) || 1, 1), 9);
    const ninos = Math.min(Math.max(Number(req.body.ninos) || 0, 0), 6);
    // Nos quedamos con tantas edades como niños haya, saneadas a 0-17.
    const edades = comoLista(req.body.edades_ninos)
      .slice(0, ninos)
      .map((e) => Math.min(Math.max(Number(e) || 0, 0), 17));
    while (edades.length < ninos) edades.push(0);

    // ¿Han cambiado los viajeros? Si sí, lo que había buscado ya no sirve.
    const cambiaronViajeros =
      adultos !== viaje.adultos ||
      ninos !== viaje.ninos ||
      JSON.stringify(edades) !== JSON.stringify(viaje.edadesNinos);

    // --- Más opciones ---
    const ritmoLimpio = RITMOS.includes(ritmo) ? ritmo : 'normal';

    // --- El modo automático ---
    //
    // Se valida ANTES de guardar nada: si falta un campo, la pantalla vuelve con
    // el aviso y el viaje se queda como estaba. Guardar a medias dejaría un
    // viaje marcado como automático al que le faltan decisiones, y el
    // orquestador tendría que inventárselas.
    const quiereAutomatico = Boolean(req.body.automatico);
    if (quiereAutomatico) {
      const viajeros = (Number(req.body.adultos) || 1) + (Number(req.body.ninos) || 0);
      const revision = validarConfigAuto(req.body, {
        viajeros,
        categoriasValidas: CATEGORIAS_SITIO,
      });
      datosAuto = revision.limpia;
      if (revision.error) return conError(revision.error, revision.campo);
    }

    // De dónde se sale. Vacío vuelve a Barcelona, que es lo de siempre.
    const origenLimpio = String(ciudad_origen ?? '').trim().slice(0, 120) || 'Barcelona';
    const cambioElOrigen = origenLimpio !== (viaje.ciudad_origen ?? 'Barcelona');

    ejecutar(
      `UPDATE viajes
          SET fecha_inicio = ?, fecha_fin = ?, presupuesto = ?, tipo_viaje = ?,
              adultos = ?, ninos = ?, edades_ninos = ?, ritmo = ?, ciudad_origen = ?,
              automatico = ?, config_auto = ?
        WHERE id = ?`,
      fecha_inicio,
      fecha_fin,
      presupuesto ? Number(presupuesto) : null,
      tipo_viaje || '',
      adultos,
      ninos,
      JSON.stringify(edades),
      ritmoLimpio,
      origenLimpio,
      quiereAutomatico ? 1 : 0,
      // Al apagar el check no se borra lo contestado: si vuelve a encenderlo,
      // se encuentra sus respuestas puestas en vez de la pantalla en blanco.
      datosAuto ? JSON.stringify(datosAuto) : (viaje.config_auto ?? null),
      viaje.id
    );

    // Vuelos y hoteles se buscaron para OTROS viajeros: fuera los no marcados,
    // para que se vuelvan a buscar con la ocupación nueva.
    // Ojo: tambien cuentan las fechas. Unos vuelos del 12 de octubre no sirven
    // si mueves el viaje a noviembre.
    const cambiaronFechas =
      fecha_inicio !== viaje.fecha_inicio || fecha_fin !== viaje.fecha_fin;

    // Las fechas de las etapas son derivadas: salen de la fecha de inicio del
    // viaje y de las noches de cada una. Si cambian las del viaje, hay que
    // recalcularlas o quedan apuntando a la semana pasada.
    if (cambiaronFechas) sincronizarEtapaUnica(viaje.id);

    // Los avisos dependen SOLO de destino y fechas, no de los viajeros.
    if (cambiaronFechas && viaje.destino) {
      await olvidarAvisos(viaje.id);
      console.log(`[rutas] Viaje #${viaje.id}: cambiaron las fechas, avisos a la cola otra vez.`);
    }

    // Cambiar el origen invalida los vuelos igual que cambiar las fechas: unos
    // vuelos desde Barcelona no sirven si ahora se sale de Madrid.
    if (cambiaronViajeros || cambiaronFechas || cambioElOrigen) {
      const { borrados, reencolados } = await olvidarTransporteYAlojamiento(viaje.id);
      if (borrados || reencolados.length) {
        console.log(
          `[rutas] Viaje #${viaje.id}: cambiaron ` +
            `${[cambiaronViajeros && 'los viajeros', cambiaronFechas && 'las fechas'].filter(Boolean).join(' y ')}. ` +
            `Borrados ${borrados} candidatos sin marcar` +
            (reencolados.length ? `; a buscar de nuevo: ${reencolados.join(', ')}.` : '.')
        );
      }
    }

    // CON EL CHECK PUESTO NO SE VA AL MAPA: se pone a montar el viaje y se
    // enseña el progreso. Es la diferencia entera entre los dos modos, y por eso
    // va aquí, en el único sitio por el que pasan los dos.
    if (quiereAutomatico) {
      lanzarOrquestador(viaje.id);
      return res.redirect(`/viajes/${viaje.id}/orquestador`);
    }

    // Se vuelve a donde estabas: a la ruta si venias de ella, y al mapamundi si
    // el viaje acaba de nacer y todavia no tiene destino.
    return res.redirect(urlVolver);
  }

  // ---------------------------------------------------------------------------
  // PASO 2: destino
  // ---------------------------------------------------------------------------
  // El PASO 2 ya no existe como formulario: el destino se elige en el mapamundi
  // (/elegir-destino/:viajeId) y lo guarda POST /api/destinos/elegir, que usa la
  // misma función que usaba esto. El GET del paso 2 redirige allí.

  return res.redirect(`/viajes/${viaje.id}/paso/${Math.min(paso + 1, TOTAL_PASOS)}`);
});

// =============================================================================
// ACTIVIDADES: estado del trabajo, reintentar y actualizar
// =============================================================================

/**
 * Endpoint de sondeo. La pantalla del catálogo lo llama cada 5 s mientras
 * está en estado "buscando", y recarga cuando deja de estarlo.
 */
router.get('/viajes/:id/actividades/estado', cargarViaje, (req, res) => {
  res.json(estadoActividades(req.viaje.id));
});

/** Reintentar tras un error: vuelve a encolar el trabajo. */
router.post('/viajes/:id/actividades/reintentar', cargarViaje, async (req, res) => {
  await refrescarActividades(req.viaje.id);
  res.redirect(`/viajes/${req.viaje.id}/paso/4`);
});

/**
 * "Actualizar datos": tira las actividades NO marcadas y vuelve a buscar.
 * Lo que ya has marcado se queda donde está.
 */
router.post('/viajes/:id/actividades/actualizar', cargarViaje, async (req, res) => {
  const { borradas } = await refrescarActividades(req.viaje.id);
  console.log(`[rutas] Viaje #${req.viaje.id}: ${borradas} actividades no marcadas borradas; a la cola otra vez.`);
  res.redirect(`/viajes/${req.viaje.id}/paso/4`);
});

// =============================================================================
// AVISOS: estado del trabajo, reintentar y actualizar
// =============================================================================

/** Sondeo mientras se consultan las tres fuentes. */
router.get('/viajes/:id/avisos/estado', cargarViaje, (req, res) => {
  res.json(estadoAvisos(req.viaje.id));
});

/** Reintentar tras un error. */
router.post('/viajes/:id/avisos/reintentar', cargarViaje, async (req, res) => {
  await refrescarAvisos(req.viaje.id);
  res.redirect(`/viajes/${req.viaje.id}/paso/3`);
});

/** "Actualizar datos": vuelve a consultar las tres fuentes. */
router.post('/viajes/:id/avisos/actualizar', cargarViaje, async (req, res) => {
  const { borrados } = await refrescarAvisos(req.viaje.id);
  console.log(`[rutas] Viaje #${req.viaje.id}: ${borrados} avisos borrados; a consultar de nuevo.`);
  res.redirect(`/viajes/${req.viaje.id}/paso/3`);
});

// =============================================================================
// VUELOS: estado del trabajo, reintentar y actualizar
// =============================================================================

/** Sondeo mientras Kayak busca. */
router.get('/viajes/:id/vuelos/estado', cargarViaje, (req, res) => {
  res.json(estadoVuelos(req.viaje.id));
});

/** Reintentar tras un error. */
router.post('/viajes/:id/vuelos/reintentar', cargarViaje, async (req, res) => {
  await refrescarVuelos(req.viaje.id);
  res.redirect(`/viajes/${req.viaje.id}/paso/5`);
});

/**
 * "Buscar con estos filtros": guarda los filtros, borra los vuelos NO marcados
 * y encola una busqueda nueva. Es la UNICA forma de que se lance una busqueda
 * de vuelos: entrar en la pantalla no la dispara.
 */
router.post('/viajes/:id/vuelos/filtros', cargarViaje, async (req, res) => {
  const filtros = filtrosVueloDelCuerpo(req.body);

  guardarFiltrosVuelos(req.viaje.id, filtros);
  const { borrados } = await refrescarVuelos(req.viaje.id);
  console.log(
    `[rutas] Viaje #${req.viaje.id}: filtros de vuelo -> ${resumenFiltrosVuelos(filtros)}. ` +
      `Borrados ${borrados} sin marcar; a la cola.`
  );
  res.redirect(`/viajes/${req.viaje.id}/paso/5`);
});

/**
 * Filtros LOCALES de vuelo (franjas horarias y precio por persona): solo
 * guardan la preferencia. No encolan nada, porque se aplican sobre lo ya leido.
 */
router.post('/viajes/:id/vuelos/filtros-locales', cargarViaje, (req, res) => {
  const franja = (v) => (['manana', 'tarde', 'noche'].includes(v) ? v : null);
  const filtros = filtrosVuelosDe(req.viaje);

  if ('salidaIda' in req.body) filtros.salidaIda = franja(req.body.salidaIda);
  if ('salidaVuelta' in req.body) filtros.salidaVuelta = franja(req.body.salidaVuelta);
  if ('precioMaxPersona' in req.body) {
    const n = Number(req.body.precioMaxPersona);
    filtros.precioMaxPersona = Number.isFinite(n) && n > 0 ? Math.round(n) : null;
  }

  guardarFiltrosVuelos(req.viaje.id, filtros);
  res.json({ resumen: resumenFiltrosVuelos(filtros) });
});

/** "Actualizar datos": borra los NO marcados y vuelve a buscar. */
router.post('/viajes/:id/vuelos/actualizar', cargarViaje, async (req, res) => {
  const { borrados } = await refrescarVuelos(req.viaje.id);
  console.log(`[rutas] Viaje #${req.viaje.id}: ${borrados} vuelos no marcados borrados; a la cola otra vez.`);
  res.redirect(`/viajes/${req.viaje.id}/paso/5`);
});

// =============================================================================
// HOTELES: estado del trabajo, reintentar y actualizar
// =============================================================================

/** Sondeo mientras Booking busca. */
router.get('/viajes/:id/hoteles/estado', cargarViaje, (req, res) => {
  res.json(estadoHoteles(req.viaje.id));
});

/** Reintentar tras un error. */
router.post('/viajes/:id/hoteles/reintentar', cargarViaje, async (req, res) => {
  await refrescarHoteles(req.viaje.id);
  res.redirect(`/viajes/${req.viaje.id}/paso/6`);
});

/**
 * "Buscar con estos filtros": guarda los filtros, borra los hoteles NO marcados
 * y encola una busqueda nueva. Hasta que no se pulsa esto, cambiar los chips no
 * hace nada: los resultados que ya tienes se quedan como estan.
 */
router.post('/viajes/:id/hoteles/filtros', cargarViaje, async (req, res) => {
  const filtros = filtrosDelCuerpo(req.body, filtrosHotelesDe(req.viaje));

  guardarFiltrosHoteles(req.viaje.id, filtros);
  const { borrados } = await refrescarHoteles(req.viaje.id);
  console.log(
    `[rutas] Viaje #${req.viaje.id}: filtros de hotel -> ${resumenFiltros(filtros)}. ` +
      `Borrados ${borrados} sin marcar; a la cola otra vez.`
  );
  res.redirect(`/viajes/${req.viaje.id}/paso/6`);
});

/**
 * Distancia al centro: filtro LOCAL. Solo guarda la preferencia y responde;
 * NO encola nada, porque se aplica sobre los resultados que ya tenemos.
 * Lo llama el JS del navegador, que además oculta las tarjetas al instante.
 */
router.post('/viajes/:id/hoteles/distancia', cargarViaje, (req, res) => {
  const filtros = filtrosHotelesDe(req.viaje);
  const valor = Number(req.body.distanciaMax);
  filtros.distanciaMax = [1, 3].includes(valor) ? valor : null;
  guardarFiltrosHoteles(req.viaje.id, filtros);
  res.json({ distanciaMax: filtros.distanciaMax, resumen: resumenFiltros(filtros) });
});

/** "Actualizar datos": borra los NO marcados y vuelve a buscar. */
router.post('/viajes/:id/hoteles/actualizar', cargarViaje, async (req, res) => {
  const { borrados } = await refrescarHoteles(req.viaje.id);
  console.log(`[rutas] Viaje #${req.viaje.id}: ${borrados} hoteles no marcados borrados; a la cola otra vez.`);
  res.redirect(`/viajes/${req.viaje.id}/paso/6`);
});

// =============================================================================
// Marcar / desmarcar un candidato (lo llama el JS del navegador con fetch)
// =============================================================================
router.post('/viajes/:id/candidatos/:cid/marcar', cargarViaje, async (req, res) => {
  const cid = Number(req.params.cid);
  const candidato = una(
    'SELECT * FROM candidatos WHERE id = ? AND viaje_id = ?',
    cid,
    req.viaje.id
  );
  if (!candidato) return res.status(404).json({ error: 'No existe ese candidato' });

  const nuevo = candidato.marcado ? 0 : 1;

  // Hoteles y vuelos son de eleccion UNICA: solo se duerme en un sitio y solo
  // se vuela una vez. Al marcar uno, se desmarcan los demas de ese tipo.
  // (En vuelos cada candidato es el paquete entero de ida y vuelta, asi que
  // elegir uno ya deja el transporte resuelto.)
  if (nuevo === 1 && (candidato.tipo === 'hotel' || candidato.tipo === 'vuelo')) {
    ejecutar(
      `UPDATE candidatos SET marcado = 0 WHERE viaje_id = ? AND tipo = ? AND id <> ?`,
      req.viaje.id,
      candidato.tipo,
      cid
    );
  }

  ejecutar('UPDATE candidatos SET marcado = ? WHERE id = ?', nuevo, cid);

  // AL ELEGIR EL HOTEL, SU DIRECCIÓN ENTRA SOLA.
  //
  // Es justo el momento en que hace falta: el hotel elegido es el extremo de
  // casi todos los traslados del día —se sale de dormir y se vuelve a dormir—
  // y hasta ahora había que teclearla a mano habiéndola tenido delante en
  // Booking.
  //
  // Solo se rellena si el campo está VACÍO: si ya hay una escrita o corregida
  // a mano, esa manda. Y sigue siendo editable, que lo que da Booking a veces
  // es el barrio y no la calle.
  if (nuevo === 1 && candidato.tipo === 'hotel') {
    volcarDireccionDeHotel(candidato);
  }

  const seleccion = await obtenerSeleccion(req.viaje.id);
  res.json({
    marcado: Boolean(nuevo),
    total: seleccion.total,
    costeTotal: Math.round(seleccion.costeTotal),
    porTipo: Object.fromEntries(
      Object.entries(seleccion.porTipo).map(([t, items]) => [t, items.map((i) => i.titulo)])
    ),
  });
});

// =============================================================================
// DESCUBRIR DESTINO — la pantalla del mapa
// =============================================================================
// La ruta lleva el id del DESTINO (que es del catálogo, no del viaje) y el
// viaje va en la query. Es a propósito: el mismo destino se mira desde viajes
// distintos, y lo que cambia entre uno y otro es solo qué sitios están ya en la
// ruta. Sin `?viaje=` la pantalla sigue funcionando: se ve el catálogo y no se
// puede añadir a ninguna ruta.

/** Carga el destino del catálogo y, si viene, el viaje desde el que se mira. */
function cargarDestino(req, res, next) {
  const destino = una('SELECT * FROM destinos WHERE id = ?', Number(req.params.destinoId));
  if (!destino) {
    return res.status(404).send('No existe ese destino. <a href="/">Volver a mis viajes</a>');
  }
  const viajeId = Number(req.query.viaje) || null;
  req.destino = destino;
  req.viajeDelContexto = viajeId ? una('SELECT * FROM viajes WHERE id = ?', viajeId) : null;
  next();
}

/** La pantalla. */
router.get('/descubrir/:destinoId', cargarDestino, (req, res) => {
  const viaje = req.viajeDelContexto;
  const panorama = panoramaDeDestino(req.destino.id, viaje?.id ?? null);
  const estado = estadoDescubrimiento(req.destino.id, viaje?.id ?? null);

  // Cuál es la ciudad de entrada ahora mismo: la referencia desde la que se
  // miden todas las distancias de esta pantalla.
  const referencia = viaje ? referenciaDelViaje(viaje.id) : null;

  res.render('descubrir', {
    destino: panorama.destino,
    puntos: panorama.puntos.map((p) => ({ ...p, esEntrada: esLaEntrada(referencia, p.id) })),
    esCiudad: panorama.esCiudad,
    viaje,
    etapasEnRuta: viaje ? etapasEnRuta(viaje.id) : 0,
    estado: estado.estado,
    mensajeError: estado.mensaje_error,
    hayIA: hayClaveIA(),
    // LA CLAVE DEL NAVEGADOR, y solo esa. Está restringida por dominio y su
    // sitio es el HTML. La de servidor —Places, Routes, Geocoding— no sale de
    // `lib/google.js` ni aparece en ninguna vista.
    claveMapas: process.env.GOOGLE_MAPS_BROWSER_KEY || '',
  });
});


/**
 * QUÉ PESTAÑA Y SUBPESTAÑA VIENEN ABIERTAS, leídas de la URL.
 *
 * `?p=dormir&sp=sub-comer`. Van en la query y no en el ancla porque el ancla
 * NO llega al servidor: el navegador se la queda. Y hacía falta que llegase,
 * porque quien tiene que pintar la pestaña buena es esta casa, no el JS
 * cuando ya se ha visto la otra.
 *
 * Se valida contra la lista de siempre: cualquier cosa rara cae en la primera,
 * que es lo que se veía antes de todo esto.
 */
const PESTANAS = ['ver', 'dormir', 'llegar', 'mapa'];
const SUBPESTANAS = ['sub-sitios', 'sub-excursiones', 'sub-comer', 'sub-moverse'];

/**
 * Y un tercer nivel dentro de «Sitios»: en qué bloque estabas.
 *
 * Va en la URL por lo mismo que los otros dos: buscar algo en «Mis búsquedas»
 * recarga la pantalla cuando termina el trabajo, y sin esto la recarga te
 * devolvía a «Imprescindibles» justo cuando venías a ver lo que habías pedido.
 */
const BLOQUES_VISTA = ['imprescindibles', 'otros', 'ninos', 'busqueda'];

function vistaPedida(query = {}) {
  const p = String(query.p ?? '').trim();
  const sp = String(query.sp ?? '').trim();
  const bl = String(query.bl ?? '').trim();
  return {
    pestana: PESTANAS.includes(p) ? p : PESTANAS[0],
    subpestana: SUBPESTANAS.includes(sp) ? sp : SUBPESTANAS[0],
    bloque: BLOQUES_VISTA.includes(bl) ? bl : BLOQUES_VISTA[0],
  };
}

/**
 * ¿Es este punto la CIUDAD DE ENTRADA?
 *
 * Lo es cuando es la primera parada confirmada de la ruta, que es justo de
 * donde `referenciaDelViaje` saca la referencia de las distancias. Si la
 * referencia viene de otro sitio —del vuelo de ida, o de una candidata suelta—
 * es un apaño del sistema, no una decisión de nadie, y el control no se marca:
 * marcarlo es lo que la convierte en decisión.
 */
function esLaEntrada(referencia, puntoId) {
  return Boolean(referencia && referencia.de === 'ruta' && referencia.ciudadId === puntoId);
}

/**
 * Marcar una ciudad como la de ENTRADA del viaje.
 *
 * Hace las dos cosas que pide el nombre, y en este orden:
 *
 *   1. La confirma en la ruta. No queda como candidata: una ciudad de entrada
 *      es por definición una parada decidida.
 *   2. La pone LA PRIMERA. Y con eso, sin tocar nada más, pasa a ser la
 *      referencia de las distancias: `referenciaDelViaje` ya coge la primera
 *      parada confirmada. No hace falta una columna nueva ni un ajuste aparte;
 *      "ciudad de entrada" y "primera parada" son la misma cosa dicha de dos
 *      maneras, y conviene que lo sigan siendo.
 *
 * SOLO PUEDE HABER UNA. Marcar otra mueve la referencia, y la anterior se queda
 * en la ruta un puesto más abajo: se cambia por dónde se entra, no se borra
 * media ruta.
 *
 * Se apoya en `confirmarEtapa` y `reordenar`, que son las mismas que usa la
 * pantalla de la ruta. Aquí no se toca el modelo de etapas.
 */
router.post('/descubrir/:destinoId/punto/:puntoId/ciudad-entrada', cargarDestino, (req, res) => {
  const viaje = req.viajeDelContexto;
  if (!viaje) return res.status(400).json({ error: 'Hace falta un viaje.' });

  // Solo tiene sentido en un destino de nivel PAÍS, donde cada punto es una
  // ciudad. En una ciudad los puntos son el Prado o el Retiro, y ninguno es una
  // parada por la que se entre a ningún sitio.
  if (req.destino.tipo === 'ciudad') {
    return res.status(400).json({ error: 'Aquí los resultados no son ciudades.' });
  }

  const punto = una(
    'SELECT * FROM puntos_interes WHERE id = ? AND destino_id = ?',
    Number(req.params.puntoId),
    req.destino.id
  );
  if (!punto) return res.status(404).json({ error: 'Ese sitio no está en este destino.' });

  // Si todavía no estaba en la ruta, entra ahora.
  const enLaRuta = anadirPuntoALaRuta(viaje, punto);
  confirmarEtapa(enLaRuta.etapaId);
  // Con un solo id delante, `reordenar` deja el resto detrás en su mismo orden.
  reordenar(viaje.id, [enLaRuta.etapaId]);

  console.log(
    `[rutas] Viaje #${viaje.id}: «${punto.nombre}» es la ciudad de entrada (y la primera parada).`
  );
  res.json({ ok: true, puntoId: punto.id, etapaId: enLaRuta.etapaId });
});

/**
 * TODO lo que el mapa necesita para repintarse, en una sola respuesta.
 *
 * Existe porque hasta ahora la pantalla no se enteraba de nada: añadías una
 * ciudad y las líneas punteadas seguían como estaban, terminaba una
 * investigación y la tarjeta se quedaba con su ruedecita girando. Había que
 * salir y volver a entrar.
 *
 * Se junta todo en una llamada a propósito: el estado de los puntos, las
 * distancias y la referencia se pintan A LA VEZ, y pedirlos por separado deja
 * medio mapa de una época y medio de otra.
 */
router.get('/api/destinos/:destinoId/mapa', (req, res) => {
  const destinoId = Number(req.params.destinoId);
  const viajeId = Number(req.query.viaje) || null;

  const panorama = panoramaDeDestino(destinoId, viajeId);
  if (!panorama) return res.status(404).json({ error: 'Ese destino ya no está.' });

  const estado = estadoDescubrimiento(destinoId, viajeId);
  const referencia = viajeId ? referenciaDelViaje(viajeId) : null;

  const distancias = viajeId
    ? distanciasDelMapa(destinoId, viajeId)
    : { referencia: null, distancias: {}, faltan: 0, calculando: false };

  // Lo que falte, que se vaya calculando por detrás. Igual que en el endpoint
  // de distancias: uno cada vez por destino.
  if (distancias.faltan && viajeId && !trabajoActivo(viajeId, 'distancias', destinoId)) {
    encolar(viajeId, 'distancias', destinoId);
  }

  res.json({
    puntos: panorama.puntos.map((p) => ({
      id: p.id,
      estado: p.estado,
      enRuta: Boolean(p.enRuta),
      ficha: p.estado === 'investigada' ? `/sitio/${p.id}${viajeId ? `?viaje=${viajeId}` : ''}` : null,
      esEntrada: esLaEntrada(referencia, p.id),
    })),
    estado: estado.estado,
    investigando: estado.investigando ?? [],
    referencia: distancias.referencia,
    distancias: distancias.distancias,
    // `distanciasDelMapa` cuenta los pares que le faltan, no dice "estoy
    // calculando": lo segundo se deduce de lo primero, igual que en el
    // endpoint de distancias de toda la vida. Leer un `calculando` que esa
    // función nunca devuelve daba siempre `false`, y el mapa dejaba de
    // preguntar justo cuando había cosas en camino.
    calculando: distancias.faltan > 0,
  });
});

/** Sondeo: ¿sigue investigándose algo? */
router.get('/descubrir/:destinoId/estado', cargarDestino, (req, res) => {
  res.json(estadoDescubrimiento(req.destino.id, Number(req.query.viaje) || null));
});

/** "Actualizar": vuelve a preguntarle a la IA. Los puntos se refrescan, no se duplican. */
router.post('/descubrir/:destinoId/actualizar', cargarDestino, (req, res) => {
  const viajeId = req.viajeDelContexto?.id ?? null;
  if (!viajeId) return res.status(400).send('Hace falta un viaje para lanzar la investigación.');

  encolar(viajeId, 'descubrir_destino', req.destino.id);
  console.log(`[rutas] Destino «${req.destino.nombre}»: a investigar otra vez.`);
  res.redirect(`/descubrir/${req.destino.id}?viaje=${viajeId}`);
});

/**
 * "Reinvestigar": borra lo que sabemos del destino y vuelve a preguntar.
 *
 * No es lo mismo que "Actualizar", que refresca sin borrar. Esto es para los
 * destinos investigados con el prompt viejo, donde se colaban monumentos entre
 * las ciudades: refrescar no los quita, hay que tirarlo todo y empezar.
 */
router.post('/descubrir/:destinoId/reinvestigar', cargarDestino, (req, res) => {
  const viajeId = req.viajeDelContexto?.id ?? null;
  if (!viajeId) return res.status(400).send('Hace falta un viaje para reinvestigar.');

  const { borrados } = olvidarInvestigacion(req.destino.id);
  encolar(viajeId, 'descubrir_destino', req.destino.id);

  console.log(
    `[rutas] Destino «${req.destino.nombre}»: borrados ${borrados} puntos, a investigar de cero.`
  );
  res.redirect(`/descubrir/${req.destino.id}?viaje=${viajeId}`);
});

/**
 * [Investigar] de una tarjeta: encola la ficha profunda de ese sitio.
 * Responde JSON porque la pantalla no se recarga: el botón cambia y ya.
 */
router.post('/descubrir/:destinoId/punto/:puntoId/investigar', cargarDestino, (req, res) => {
  const viajeId = req.viajeDelContexto?.id ?? null;
  const punto = una(
    'SELECT * FROM puntos_interes WHERE id = ? AND destino_id = ?',
    Number(req.params.puntoId),
    req.destino.id
  );
  if (!punto) return res.status(404).json({ error: 'Ese sitio no está en este destino.' });
  if (!viajeId) return res.status(400).json({ error: 'Hace falta un viaje para investigar.' });

  encolar(viajeId, 'investigar_ciudad', punto.id);
  res.json({ puntoId: punto.id, estado: 'investigando' });
});

/**
 * [A mi ruta]: crea una etapa en 'recopilando'.
 *
 * Sin noches y sin fechas a propósito. 'recopilando' significa justo eso: me
 * interesa, todavía no sé cuánto me quedo. Cuando se confirme y se le pongan
 * noches, `recalcularFechasEtapas` le pondrá las fechas.
 */
router.post('/descubrir/:destinoId/punto/:puntoId/a-mi-ruta', cargarDestino, (req, res) => {
  const viaje = req.viajeDelContexto;
  if (!viaje) return res.status(400).json({ error: 'Hace falta un viaje para añadir a la ruta.' });

  const punto = una(
    'SELECT * FROM puntos_interes WHERE id = ? AND destino_id = ?',
    Number(req.params.puntoId),
    req.destino.id
  );
  if (!punto) return res.status(404).json({ error: 'Ese sitio no está en este destino.' });

  // AQUÍ MANDA EL NIVEL DEL DESTINO.
  //
  // De un país, este punto es una ciudad y se convierte en una PARADA.
  // De una ciudad, este punto es el Prado o el Retiro: no es una parada de
  // ningún viaje, es algo que ver DENTRO de la parada Madrid. Se apunta como
  // candidato de esa etapa, y si la etapa todavía no existe se crea sola.
  if (req.destino.tipo === 'ciudad') {
    return res.json(apuntarSitioDeCiudad(viaje, req.destino, punto));
  }

  // La misma función que usa la ficha: el botón tiene que hacer lo mismo en
  // las dos pantallas.
  res.json(anadirPuntoALaRuta(viaje, punto));
});

/**
 * Apunta un sitio de una ciudad dentro de la etapa de esa ciudad.
 *
 * La etapa se crea sola si no estaba, en 'recopilando' y enlazada al destino
 * del catálogo. No se pregunta nada: quien apunta el Museo del Prado está
 * diciendo que quiere ir a Madrid, y hacerle confirmar eso sobraría. Se le
 * avisa, eso sí, la primera vez.
 */
function apuntarSitioDeCiudad(viaje, destino, punto) {
  let etapa = una(
    `SELECT * FROM etapas
      WHERE viaje_id = ? AND (destino_id = ? OR nombre_ciudad = ?)
      ORDER BY (estado = 'confirmada') DESC, orden, id LIMIT 1`,
    viaje.id,
    destino.id,
    destino.nombre
  );

  let etapaNueva = false;
  if (!etapa) {
    const ultimo = una('SELECT MAX(orden) AS n FROM etapas WHERE viaje_id = ?', viaje.id);
    const r = ejecutar(
      `INSERT INTO etapas (viaje_id, destino_id, nombre_ciudad, orden, noches, estado)
       VALUES (?, ?, ?, ?, 0, 'recopilando')`,
      viaje.id,
      destino.id,
      destino.nombre,
      (ultimo?.n ?? 0) + 1
    );
    etapa = una('SELECT * FROM etapas WHERE id = ?', Number(r.lastInsertRowid));
    etapaNueva = true;
    console.log(`[rutas] Viaje #${viaje.id}: «${destino.nombre}» entra en la ruta al apuntar un sitio suyo.`);
  } else if (!etapa.destino_id) {
    // Estaba suelta: se aprovecha para engancharla al catálogo.
    ejecutar('UPDATE etapas SET destino_id = ? WHERE id = ?', destino.id, etapa.id);
  }

  const r = alternarApuntado(etapa.id, 'punto', punto.id);
  return {
    puntoId: punto.id,
    etapaId: etapa.id,
    apuntado: r?.apuntado ?? false,
    etapaNueva,
    ciudad: destino.nombre,
  };
}

/**
 * En qué anda el descubrimiento de un destino.
 *
 * Junta dos cosas en una: si se está investigando el destino entero (la lista
 * de sitios todavía no existe) y qué sitios sueltos se están investigando a
 * fondo. La pantalla necesita las dos para saber si enseña el estado de carga
 * grande o solo unas ruedecitas en algunas tarjetas.
 */
function estadoDescubrimiento(destinoId, viajeId = null) {
  const cuantos = una(
    'SELECT COUNT(*) AS n FROM puntos_interes WHERE destino_id = ?',
    destinoId
  ).n;

  const investigandoPuntos = todas(
    `SELECT referencia_id FROM trabajos
      WHERE tipo = 'investigar_ciudad' AND estado IN ('pendiente','en_curso')`
  ).map((t) => t.referencia_id);

  const activo = viajeId ? trabajoActivo(viajeId, 'descubrir_destino', destinoId) : null;
  if (activo) {
    return {
      estado: cuantos ? 'actualizando' : 'buscando',
      total: cuantos,
      investigando: investigandoPuntos,
      mensaje_error: null,
    };
  }

  if (!cuantos) {
    const ultimo = viajeId ? ultimoTrabajo(viajeId, 'descubrir_destino', destinoId) : null;
    if (ultimo?.estado === 'error') {
      return { estado: 'error', total: 0, investigando: [], mensaje_error: ultimo.mensaje_error };
    }
    return { estado: 'sin_datos', total: 0, investigando: [], mensaje_error: null };
  }

  return {
    estado: 'hecho',
    total: cuantos,
    investigando: investigandoPuntos,
    mensaje_error: null,
  };
}

// =============================================================================
// FICHA PROFUNDA de un punto de interés
// =============================================================================
// Igual que /descubrir: el id es del CATÁLOGO y el viaje va en la query, porque
// la ficha de Kioto es la misma se mire desde el viaje que se mire. Lo único
// que cambia es si Kioto ya está en ESA ruta.

/** Carga el punto y, si viene, el viaje desde el que se mira. */
function cargarPunto(req, res, next) {
  const punto = una('SELECT * FROM puntos_interes WHERE id = ?', Number(req.params.puntoId));
  if (!punto) {
    return res.status(404).send('No existe ese sitio. <a href="/">Volver a mis viajes</a>');
  }
  const viajeId = Number(req.query.viaje) || null;
  req.punto = punto;
  req.viajeDelContexto = viajeId ? una('SELECT * FROM viajes WHERE id = ?', viajeId) : null;
  next();
}

/** La pantalla. */
router.get('/sitio/:puntoId', cargarPunto, (req, res) => {
  const viaje = req.viajeDelContexto;
  const ficha = fichaDeUnPunto(req.punto.id, viaje?.id ?? null);
  res.render('sitio', { ...ficha, viaje, etapasEnRuta: viaje ? etapasEnRuta(viaje.id) : 0 });
});

/** Sondeo mientras se completa la ficha. */
router.get('/sitio/:puntoId/estado', cargarPunto, (req, res) => {
  const ficha = fichaDeUnPunto(req.punto.id, Number(req.query.viaje) || null);
  res.json({
    estado: ficha.estado,
    sitios: ficha.sitios.length,
    excursiones: ficha.excursiones.length,
    mensaje_error: ficha.mensajeError,
  });
});

/** Lanzar o repetir la investigación desde la propia ficha. */
router.post('/sitio/:puntoId/investigar', cargarPunto, (req, res) => {
  const viaje = req.viajeDelContexto;
  if (!viaje) return res.status(400).send('Hace falta un viaje para investigar.');

  encolar(viaje.id, 'investigar_ciudad', req.punto.id);
  console.log(`[rutas] «${req.punto.nombre}»: ficha profunda a la cola.`);
  res.redirect(`/sitio/${req.punto.id}?viaje=${viaje.id}`);
});

/**
 * [Añadir a mi ruta] desde la ficha. Misma regla que en el mapa: manda el nivel
 * del destino, no el punto. La ficha del Museo del Prado no puede crear una
 * parada del viaje llamada "Madrid"; lo apunta dentro de la parada Madrid.
 */
router.post('/sitio/:puntoId/a-mi-ruta', cargarPunto, (req, res) => {
  const viaje = req.viajeDelContexto;
  if (!viaje) return res.status(400).json({ error: 'Hace falta un viaje para añadir a la ruta.' });

  const destino = una('SELECT * FROM destinos WHERE id = ?', req.punto.destino_id);
  if (destino?.tipo === 'ciudad') {
    return res.json(apuntarSitioDeCiudad(viaje, destino, req.punto));
  }

  res.json(anadirPuntoALaRuta(viaje, req.punto));
});

/**
 * Mete un punto en la ruta de un viaje como etapa en 'recopilando'.
 *
 * Vive aquí suelta porque la piden dos pantallas (el mapa y la ficha) y el
 * comportamiento tiene que ser exactamente el mismo en las dos: sin noches, sin
 * fechas, al final de la lista y sin duplicar si ya estaba.
 */
function anadirPuntoALaRuta(viaje, punto) {
  const yaEsta = una(
    'SELECT * FROM etapas WHERE viaje_id = ? AND punto_interes_id = ?',
    viaje.id,
    punto.id
  );
  if (yaEsta) return { puntoId: punto.id, etapaId: yaEsta.id, yaEstaba: true };

  const ultimo = una('SELECT MAX(orden) AS n FROM etapas WHERE viaje_id = ?', viaje.id);
  const r = ejecutar(
    `INSERT INTO etapas (viaje_id, punto_interes_id, nombre_ciudad, orden, noches, estado)
     VALUES (?, ?, ?, ?, 0, 'recopilando')`,
    viaje.id,
    punto.id,
    // De un sitio se duerme en su ciudad base: del Monte Fuji, en Hakone.
    punto.categoria === 'sitio' && punto.ciudad_base ? punto.ciudad_base : punto.nombre,
    (ultimo?.n ?? 0) + 1
  );

  console.log(`[rutas] Viaje #${viaje.id}: «${punto.nombre}» añadido a la ruta (recopilando).`);
  return { puntoId: punto.id, etapaId: Number(r.lastInsertRowid), yaEstaba: false };
}

// =============================================================================
// ELEGIR DESTINO — el mapamundi
// =============================================================================
// Sustituye al campo de texto que había en el paso 2. La búsqueda por nombre no
// desaparece: vive dentro del mapa, para quien ya sabe a dónde va.

/** La pantalla. */
router.get('/elegir-destino/:viajeId', (req, res) => {
  const viaje = una('SELECT * FROM viajes WHERE id = ?', Number(req.params.viajeId));
  if (!viaje) {
    return res.status(404).send('No existe ese viaje. <a href="/">Volver a mis viajes</a>');
  }
  res.render('elegir-destino', {
    viaje,
    // La misma clave que usa la pantalla de descubrir. Aquí faltaba, y por eso
    // este mapa nunca llegó a pedirle nada a Google.
    claveMapas: process.env.GOOGLE_MAPS_BROWSER_KEY || '',
  });
});

/**
 * Geocodificación INVERSA: de un punto del mapa a un sitio con nombre.
 *
 * Es un proxy al Geocoding de Google, y tiene que serlo: la clave de servidor
 * está restringida por IP y no puede salir al navegador. Lo resuelve
 * services/geocodificar.js, que además cachea para no pagar dos veces por el
 * mismo punto.
 */
router.get('/api/geocodificar', async (req, res) => {
  // Ojo con Number(''), que da 0 y es un número perfectamente finito: sin
  // comprobar que venga algo, un lat vacío colaba como el golfo de Guinea.
  const lat = req.query.lat === '' ? NaN : Number(req.query.lat);
  const lon = req.query.lon === '' ? NaN : Number(req.query.lon);
  const enRango =
    Number.isFinite(lat) && Number.isFinite(lon) &&
    Math.abs(lat) <= 90 && Math.abs(lon) <= 180;
  if (!enRango) {
    return res.status(400).json({ error: 'Esas coordenadas no valen.' });
  }

  try {
    res.json(await sitioEnCoordenadas(lat, lon, Number(req.query.zoom) || 2));
  } catch (err) {
    console.error('[rutas] geocodificación inversa:', err.message);
    res.status(502).json({ error: 'No he podido preguntar qué hay ahí. Inténtalo otra vez.' });
  }
});

/** Geocodificación por TEXTO: del buscador de la cabecera a unas coordenadas. */
router.get('/api/geocodificar-texto', async (req, res) => {
  try {
    res.json(await sitioPorTexto(req.query.q));
  } catch (err) {
    console.error('[rutas] búsqueda por texto:', err.message);
    res.status(502).json({ error: 'No he podido buscar ese sitio. Inténtalo otra vez.' });
  }
});

/**
 * "Investigar X": el botón de la tarjeta del mapa.
 *
 * Hace exactamente lo mismo que hacía confirmar el destino escrito a mano, así
 * que comparte función con aquello y no se duplica nada.
 */
router.post('/api/destinos/elegir', async (req, res) => {
  const nombre = String(req.body.nombre ?? '').trim();
  const viaje = una('SELECT * FROM viajes WHERE id = ?', Number(req.body.viajeId));

  if (!viaje) return res.status(404).json({ error: 'Ese viaje ya no existe.' });
  if (!nombre) return res.status(400).json({ error: 'Falta el nombre del destino.' });

  try {
    const tipo = req.body.tipo === 'ciudad' ? 'ciudad' : 'pais';
    const { destinoId } = await elegirDestinoParaViaje(viaje, {
      nombre,
      tipo,
      lat: Number(req.body.lat),
      lon: Number(req.body.lon),
    });

    // EL NIVEL DEL DESTINO DECIDE A DONDE SE VA.
    //
    //  - CIUDAD: no hay nada que explorar. Una ciudad no se elige entre otras,
    //    se trabaja. El mapa enseña el progreso de las dos busquedas y despues
    //    entra DIRECTAMENTE en su etapa. Si ya estaba investigada, entra ya.
    //  - PAIS o REGION: ahi si hay que elegir, y el mapa es la pantalla donde se
    //    hace: fichas de ciudades y zonas, y solo las añadidas seran paradas.
    if (tipo === 'ciudad') {
      const destino = una('SELECT * FROM destinos WHERE id = ?', destinoId);
      const r = asegurarEtapaDeCiudad(viaje.id, destino);
      if (!r) return res.status(500).json({ error: 'No se pudo crear la parada.' });

      // Si acaba de nacer una parada, la ruta necesita sus fechas y sus tramos.
      if (r.nueva) recalcularRuta(viaje.id);

      // CON LA CIUDAD REPETIDA NO SE ADIVINA. Clonar una etapa deja la misma
      // ciudad dos veces en la ruta —Sarajevo al principio y Sarajevo de paso al
      // final—, y entrar "en Sarajevo" ya no quiere decir nada concreto: son dos
      // paradas distintas, con sus fechas y su hotel. Así que se lleva a la
      // ruta, que es donde se ve cuál es cuál, en vez de elegir una a ciegas.
      if (r.cuantas > 1) {
        console.log(
          `[rutas] Viaje #${viaje.id}: «${destino.nombre}» está ${r.cuantas} veces en la ruta; a la ruta.`
        );
        return res.json({ modo: 'ruta', url: `/viaje/${viaje.id}/ruta`, listo: true });
      }

      const estado = prepararEtapa(r.etapa.id);
      return res.json({
        modo: 'ciudad',
        etapaId: r.etapa.id,
        url: `/etapa/${r.etapa.id}`,
        urlEstado: `/api/etapas/${r.etapa.id}/preparacion`,
        listo: !estado.trabajando,
        mensaje: estado.mensaje,
      });
    }

    // El navegador redirige solo: así el botón puede quedarse girando mientras
    // tanto en vez de dar un salto en seco.
    res.json({ modo: 'explorar', url: `/descubrir/${destinoId}?viaje=${viaje.id}` });
  } catch (err) {
    console.error('[rutas] al elegir destino:', err);
    res.status(500).json({ error: 'No se pudo guardar el destino.' });
  }
});

/**
 * Pone un destino como ámbito de un viaje y se asegura de que esté investigado.
 *
 * Es el punto por el que pasa TODO lo que cambia el destino de un viaje, venga
 * del mapa o de donde venga, porque son cuatro cosas encadenadas y olvidarse de
 * una deja la base coja:
 *
 *   1. El viaje apunta al destino nuevo (y se le pone nombre si no tenía).
 *   2. Su etapa única sigue al destino (mientras haya una sola).
 *   3. Los avisos del destino viejo ya no valen: fuera y a la cola otra vez.
 *   4. El destino entra en el CATÁLOGO, y si no se ha investigado, a la cola.
 *
 * Devuelve el id del destino del catálogo, que es a donde hay que ir después.
 */
async function elegirDestinoParaViaje(viaje, { nombre, tipo = 'pais', lat = null, lon = null }) {
  const nombreViaje = viaje.nombre === 'Viaje sin nombre' ? `Viaje a ${nombre}` : viaje.nombre;

  // EL DESTINO DEL VIAJE SOLO SE PONE UNA VEZ.
  //
  // `viajes.destino` es el ámbito del viaje —lo que se lee en el chip de "Mi
  // ruta"— y no la última ciudad que se ha tocado en el mapa. Añadir Mostar a un
  // viaje que ya pasa por Sarajevo no convierte el viaje en "un viaje a Mostar":
  // sigue siendo el mismo, con una parada más.
  const yaTieneRuta = Boolean(una('SELECT 1 FROM etapas WHERE viaje_id = ?', viaje.id));
  const destinoDelViaje = yaTieneRuta && viaje.destino ? viaje.destino : nombre;
  const cambioDestino = destinoDelViaje !== viaje.destino;

  ejecutar(
    'UPDATE viajes SET destino = ?, nombre = ? WHERE id = ?',
    destinoDelViaje,
    nombreViaje,
    viaje.id
  );

  // UN PAIS NO ES UNA PARADA.
  //
  // De una CIUDAD sí: el viaje a Sevilla tiene una parada, que es Sevilla, y
  // conviene que exista desde el principio (la crea `asegurarEtapaDeCiudad`
  // justo después, con su enlace al catálogo).
  //
  // De un país o una región, NO. Antes esto creaba una etapa "Portugal"
  // confirmada, y en la ruta aparecía como si uno fuera a dormir en el país
  // entero. Las paradas de un viaje a Portugal son las ciudades que se elijan
  // en el mapa, y solo esas: hasta que se elija la primera, la ruta está vacía,
  // que es exactamente lo que pasa.
  // Solo cuando el viaje NO tiene ninguna parada todavía.
  //
  // `sincronizarEtapaUnica` renombra la parada única con el destino del viaje, y
  // eso está bien mientras haya una sola. Con una ruta ya empezada es
  // destructivo: elegir Mostar en el mapa renombraba la parada de Sarajevo a
  // "Mostar" y Sarajevo desaparecía. A partir de la segunda ciudad manda
  // `asegurarEtapaDeCiudad`, que la añade al final sin tocar lo que hay.
  const sinParadas = !una('SELECT 1 FROM etapas WHERE viaje_id = ?', viaje.id);
  if (tipo === 'ciudad' && sinParadas) sincronizarEtapaUnica(viaje.id);

  // Los avisos (clima, seguridad, festivos) son del destino: cambiarlo los
  // caduca. Se piden solos porque en su pantalla no hay nada que configurar.
  if (cambioDestino && viaje.fecha_inicio && viaje.fecha_fin) {
    await olvidarAvisos(viaje.id);
    console.log(`[rutas] Viaje #${viaje.id}: destino «${nombre}», avisos a la cola.`);
  }

  // La fila del catálogo se crea siempre, aunque no sepamos nada del sitio: la
  // pantalla de descubrir necesita un id al que ir mientras la IA piensa.
  // Si ya existía, se reutiliza: el catálogo es conocimiento estable y no se
  // duplica por que dos viajes vayan al mismo sitio.
  const enCatalogo = asegurarDestino(nombre, {
    tipo,
    lat: Number.isFinite(lat) ? lat : null,
    lon: Number.isFinite(lon) ? lon : null,
  });

  if (enCatalogo.investigado_en) {
    console.log(`[rutas] Viaje #${viaje.id}: «${nombre}» ya estaba investigado. Entramos con la caché.`);
  } else if (tipo === 'ciudad') {
    // De una ciudad no se encola nada aquí: lo hace `prepararEtapa`, que además
    // encadena las excursiones de Civitatis. Dos trabajos para lo mismo sería
    // abrir el navegador dos veces.
    console.log(`[rutas] Viaje #${viaje.id}: «${nombre}» es una ciudad; la prepara su etapa.`);
  } else {
    encolar(viaje.id, 'descubrir_destino', enCatalogo.id);
    console.log(`[rutas] Viaje #${viaje.id}: «${nombre}» (${tipo}) a investigar por la IA.`);
  }

  return { destinoId: enCatalogo.id, yaInvestigado: Boolean(enCatalogo.investigado_en) };
}

// =============================================================================
// MI RUTA — las paradas del viaje
// =============================================================================

/** La pantalla. */
router.get('/viaje/:viajeId/ruta', (req, res) => {
  const viajeId = Number(req.params.viajeId);
  const viaje = una('SELECT * FROM viajes WHERE id = ?', viajeId);
  if (!viaje) {
    return res.status(404).send('No existe ese viaje. <a href="/">Volver a mis viajes</a>');
  }

  // SI SE ESTA MONTANDO SOLO, se enseña el progreso en vez de la ruta. Cerrar
  // la pantalla de progreso no cancela nada —el trabajo va por la cola—, así que
  // al volver al viaje hay que devolverle donde estaba: mirando cómo se monta.
  // Una ruta medio vacía que cambia sola bajo el ratón no se entiende.
  if (viaje.automatico && progresoDeViaje(viajeId).trabajando) {
    return res.redirect(`/viajes/${viajeId}/orquestador`);
  }

  // Se recalcula al entrar: si algo quedó descuadrado (un viaje migrado, unas
  // fechas cambiadas desde otra pantalla), la ruta se ve ya coherente.
  recalcularRuta(viajeId);

  // "Elegir más ciudades" solo tiene sentido si el destino del viaje es un país
  // o una región: ahí quedan ciudades por descubrir. En un viaje a Sevilla no
  // hay nada más que explorar, y el botón sería una puerta a ninguna parte.
  const destino = viaje.destino ? destinoPorNombre(viaje.destino) : null;
  const explorable = destino && destino.tipo !== 'ciudad';

  // Cuánta carretera hay dentro del viaje, y si es demasiada para los días que
  // dura. Solo informa: la decisión sigue siendo mía.
  const traslados = trasladosDeLaRuta(viajeId);
  const dias = nochesEntre(viaje.fecha_inicio, viaje.fecha_fin) + 1;

  res.render('ruta', {
    ruta: rutaDeViaje(viajeId),
    // Si ya se revisó "Antes de viajar", el botón deja de ser un aviso.
    antesRevisado: Boolean(viaje.antes_revisado_en),
    urlExplorar: explorable ? `/descubrir/${destino.id}?viaje=${viajeId}` : null,
    dosier: estadoDelDosier(viaje),
    traslados,
    avisoTraslados: viaje.fecha_inicio ? avisoDeTraslados(traslados.minutos, dias) : null,
  });
});

// =============================================================================
// ANTES DE VIAJAR: la ficha práctica de cada país
// -----------------------------------------------------------------------------
// Dos rutas y una división clara entre ellas:
//
//   GET  devuelve LO QUE HAY GUARDADO y no genera nada. Así el panel abre al
//        instante, con lo que ya se sabe, en vez de dejar a alguien mirando una
//        ruedecita mientras se llama a la IA.
//   POST genera (o regenera) UN país. Lo llama el propio panel para lo que le
//        falte, y el botón de "actualizar" para rehacer lo que se quedó viejo.
//
// Generar tarda lo que tardan las fuentes, así que va con su plazo largo y sin
// prisa: es una acción que se pide a sabiendas.
// =============================================================================

/** Lo guardado de cada país del viaje. No llama a nadie de fuera. */
router.get('/api/viaje/:viajeId/antes-de-viajar', async (req, res) => {
  try {
    const datos = await fichasDelViaje(Number(req.params.viajeId));
    if (!datos) return res.status(404).json({ error: 'Ese viaje ya no existe.' });
    res.json(datos);
  } catch (err) {
    console.error('[rutas] no pude reunir las fichas de país:', err);
    res.status(500).json({ error: 'No se pudo consultar la información de los países.' });
  }
});

/** Genera o regenera la ficha de UN país. */
router.post('/api/viaje/:viajeId/antes-de-viajar', async (req, res) => {
  const viaje = una('SELECT * FROM viajes WHERE id = ?', Number(req.params.viajeId));
  if (!viaje) return res.status(404).json({ error: 'Ese viaje ya no existe.' });

  const pais = String(req.body?.pais ?? '').trim();
  if (!pais) return res.status(400).json({ error: 'Falta el país.' });

  try {
    const ficha = await generarFicha({
      pais,
      codigoPais: String(req.body?.codigoPais ?? '').trim() || null,
      fechaInicio: viaje.fecha_inicio,
      fechaFin: viaje.fecha_fin,
    });
    res.json({ ficha });
  } catch (err) {
    console.error(`[rutas] no pude generar la ficha de ${pais}:`, err);
    res.status(500).json({ error: err.message || 'No se pudo preparar la ficha.' });
  }
});

/** "Ya lo he revisado". Reversible: se manda `revisado: false` y vuelve atrás. */
router.post('/api/viaje/:viajeId/antes-de-viajar/revisado', (req, res) => {
  const viaje = una('SELECT id FROM viajes WHERE id = ?', Number(req.params.viajeId));
  if (!viaje) return res.status(404).json({ error: 'Ese viaje ya no existe.' });

  const revisadoEn = marcarRevisado(viaje.id, Boolean(req.body?.revisado));
  res.json({ revisadoEn });
});

// --- API de la ruta ---------------------------------------------------------
// Todas devuelven la ruta entera recalculada, y el cliente repinta con eso. Es
// más tráfico que devolver solo lo que cambió, pero cambiar una noche mueve las
// fechas de todas las paradas siguientes y los tramos de en medio: mandar el
// estado completo es lo único que no se desincroniza nunca.

/** Un candidato pasa a la ruta. */
router.post('/api/etapas/:id/confirmar', (req, res) => {
  const viajeId = confirmarEtapa(Number(req.params.id));
  if (!viajeId) return res.status(404).json({ error: 'Esa etapa ya no existe.' });
  res.json(rutaDeViaje(viajeId));
});

/** Fuera esa parada. */
/**
 * Clonar una etapa: la misma ciudad otra vez, al final de la ruta.
 *
 * Para el viaje que sale de una ciudad distinta de la última que se visita:
 * Sarajevo → Mostar → Sarajevo, donde esa segunda vez es de paso, a coger el
 * avión. Nace enganchada al mismo destino del catálogo —con sus sitios y sus
 * excursiones ya investigados— y vacía de todo lo demás.
 */
router.post('/api/etapas/:id/clonar', (req, res) => {
  const r = clonarEtapa(Number(req.params.id));
  if (!r) return res.status(404).json({ error: 'Esa parada ya no existe.' });
  res.json({ ...rutaDeViaje(r.viajeId), etapaNueva: r.etapaId });
});

router.post('/api/etapas/:id/quitar', (req, res) => {
  const viajeId = quitarEtapa(Number(req.params.id));
  if (!viajeId) return res.status(404).json({ error: 'Esa etapa ya no existe.' });
  res.json(rutaDeViaje(viajeId));
});

/** Una noche más o una menos. */
router.post('/api/etapas/:id/noches', (req, res) => {
  const delta = Number(req.body?.delta);
  if (delta !== 1 && delta !== -1) {
    return res.status(400).json({ error: 'El cambio de noches solo puede ser +1 o -1.' });
  }
  const viajeId = cambiarNoches(Number(req.params.id), delta);
  if (!viajeId) return res.status(404).json({ error: 'Esa etapa ya no existe.' });
  res.json(rutaDeViaje(viajeId));
});

/** El orden nuevo tras arrastrar. */
router.post('/api/viajes/:viajeId/reordenar', (req, res) => {
  const viajeId = Number(req.params.viajeId);
  if (!una('SELECT id FROM viajes WHERE id = ?', viajeId)) {
    return res.status(404).json({ error: 'Ese viaje ya no existe.' });
  }
  reordenar(viajeId, req.body?.ordenIds);
  res.json(rutaDeViaje(viajeId));
});

// =============================================================================
// LA ETAPA — el subproyecto de cada parada
// =============================================================================

/** Carga la etapa y su contexto, o corta con un 404 legible. */
function cargarContextoEtapa(req, res, next) {
  const contexto = cargarEtapa(Number(req.params.etapaId ?? req.params.id));
  if (!contexto) {
    return res.status(404).send('No existe esa etapa. <a href="/">Volver a mis viajes</a>');
  }
  req.contexto = contexto;
  next();
}

/** La pantalla. */
router.get('/etapa/:etapaId', cargarContextoEtapa, async (req, res) => {
  const contexto = req.contexto;
  const { etapa, viaje, punto } = contexto;

  // LA ETAPA NACE LLENA.
  //
  // Si el catálogo no sabe nada de esta ciudad, al entrar se lanzan solas las
  // dos búsquedas —los sitios y las excursiones— y la pestaña "Qué ver" cuenta
  // lo que está pasando. Entrar en Sevilla es querer Sevilla: no tiene sentido
  // pedir un clic más para empezar a mirar.
  //
  // `prepararEtapa` no reintenta después de un fallo: sin esa condición, una
  // ciudad que falla (por ejemplo, sin clave de IA en el .env) se reencolaría
  // en CADA visita, un bucle silencioso de trabajos condenados. Para reintentar
  // está el botón del aviso.
  const preparando = prepararEtapa(etapa.id);

  // De paso, fuera los adjuntos cuyo elemento ya no existe: el billete de un
  // tramo que se borró al reordenar la ruta, o la confirmación de un hotel que
  // se fue al refrescar la búsqueda.
  await limpiarAdjuntosHuerfanos(viaje.id);

  const tramos = tramosDeEtapa(contexto);

  // Las distancias se calculan la primera vez que se mira el tramo y se quedan
  // guardadas en su fila. Si Google no responde, el tramo se pinta igual sin ellas.
  for (const t of tramos) {
    if (t.distanciaKm == null) await asegurarDistancia(t.id);
  }

  const lienzoDeLaEtapa = lienzoDeViaje(viaje.id, { etapaId: etapa.id });

  const orden = req.query.orden || 'recomendados';
  const ordenVuelos = req.query.ordenVuelos === 'duracion' ? 'duracion' : 'precio';

  // Los vuelos de cada tramo se cargan AQUÍ y se pintan con la tarjeta rica de
  // siempre (parciales/vuelo.ejs). Antes los montaba el JS a mano y se dejaba
  // por el camino lo más importante: los horarios.
  // Cada tramo lleva SUS resultados y SUS filtros: la ida y la vuelta se
  // buscan por separado y pueden querer cosas distintas.
  const tramosConVuelos = tramosDeEtapa(contexto).map((t) => ({
    ...t,
    resultados: vuelosDeTramo(t.id, { orden: ordenVuelos }),
    filtros: filtrosVuelosDeTramo(una('SELECT * FROM transportes WHERE id = ?', t.id)),
    adjuntos: adjuntosDe('transporte', t.id),
    // Cómo se va de una ciudad a la siguiente. Solo en los saltos de en medio:
    // de casa y a casa se vuela, y para eso está el buscador.
    medios: t.donde === 'salto' ? comoLlegarDeTramo(t.id, t.nombreOrigen, t.nombreDestino) : null,
  }));

  // Se calculan UNA vez y se reparten. Pedirlos dentro del objeto que se pinta
  // los volvía a calcular por cada sitio donde se mencionaban —tres consultas
  // completas al catálogo para pintar la misma pantalla—.
  const queVer = queVerDeEtapa(contexto);
  const comer = comerDeEtapa(etapa);

  res.render('etapa', {
    ...contexto,
    // QUÉ PESTAÑA VIENE ABIERTA, DECIDIDO AQUÍ.
    //
    // Antes esto no existía: la vista pintaba SIEMPRE "Qué ver" y el JS
    // reponía la buena una vez cargado. Como la pantalla se recarga entera
    // cada vez que termina una búsqueda —y al apuntar, al elegir, al
    // borrar…— el resultado era un salto a "Qué ver" cada pocos segundos.
    //
    // Ahora la pestaña viaja en la URL y llega ya pintada. El JS solo la
    // mantiene al día.
    vista: vistaPedida(req.query),
    // EL MAPA DE LA PARADA: el hotel, lo apuntado y los restaurantes, con sus
    // coordenadas. Van al cliente porque hay que dibujarlas; no se enseñan en
    // ninguna pantalla, que es la regla de siempre.
    mapaEtapa: mapaDeEtapa(etapa.id),
    claveMapas: process.env.GOOGLE_MAPS_BROWSER_KEY || '',
    ordenVuelos,
    // Los filtros de hotel se pintan DENTRO de la pestaña: el formulario vive
    // donde se usa, no en otra pantalla.
    filtrosHoteles: filtrosHotelesDe(viaje),
    resumenFiltrosHoteles: resumenFiltros(filtrosHotelesDe(viaje)),
    // Dónde está colocada ya cada cosa apuntada, y qué días tiene esta parada
    // para el mini-selector de "Ponerlo en un día".
    colocaciones: colocacionesDeEtapa(etapa.id),
    diasDeLaEtapa: lienzoDeLaEtapa?.dias ?? [],
    franjas: FRANJAS,
    queVer,
    moverse: moverseDeEtapa(etapa),
    // Los traslados consultados y a dónde se puede ir desde aquí. Los lugares
    // salen SIN coordenadas: al navegador no le hacen falta y no se enseñan.
    traslados: trasladosDeEtapa(etapa.id),
    lugares: paraLaVista(lugaresDeEtapa(etapa.id)),
    comer,
    // Las distancias guardadas de cada ficha, en un mapa por tipo. Salen de la
    // MISMA tabla de traslados: preguntar "¿cuáles tocan a esta ficha?" es una
    // consulta, no un modelo aparte.
    distanciasComer: trasladosDeElementos('comer', comer.fichas.map((c) => c.id)),
    distanciasSitios: distanciasDeSitios(queVer.sitios),
    distanciasActividades: trasladosDeElementos(
      'actividad',
      queVer.excursiones.map((a) => a.id)
    ),
    dormir: conAdjuntosDelHotel(hotelesDeEtapa(contexto, { orden: req.query.orden || 'recomendados' })),
    tramos: tramosConVuelos,
    tiposTransporte: TIPOS_TRANSPORTE,
    preparando,
    orden: req.query.orden || 'recomendados',
  });
});

/**
 * Sondeo de la etapa. Junta los dos trabajos que pueden estar en marcha aquí
 * (la ficha de la ciudad y los hoteles) para no tener dos sondeos a la vez.
 */
router.get('/etapa/:etapaId/estado', cargarContextoEtapa, (req, res) => {
  const contexto = req.contexto;
  const { etapa } = contexto;

  // TODO lo que puede estar trabajando en esta pantalla, en una sola respuesta.
  //
  // Antes esto contaba dos cosas —la ficha y los hoteles— y se dejaba fuera los
  // vuelos. Como el sondeo solo se encendía si algo de lo que miraba estaba en
  // marcha, buscar vuelos dejaba el "Buscando en Kayak…" colgado para siempre:
  // el trabajo terminaba bien, pero nadie estaba mirando. Los resultados solo
  // aparecían cuando otra cosa forzaba una recarga.
  //
  // Un solo sondeo y un solo sitio donde añadir lo próximo que trabaje aquí.
  const preparacion = estadoPreparacionEtapa(etapa.id);
  const hoteles = estadoHotelesDeEtapa(etapa.id);

  const tramos = {};
  for (const t of tramosDeEtapa(contexto)) {
    const r = vuelosDeTramo(t.id);
    // Los medios del tramo son otra cosa que puede estar en marcha aquí: si no
    // se contaran, "Buscando cómo llegar…" se quedaría colgado igual que le
    // pasaba a los vuelos antes de unificar el sondeo.
    const m = t.donde === 'salto' ? comoLlegarDeTramo(t.id, t.nombreOrigen, t.nombreDestino) : null;
    tramos[t.id] = {
      estado: r.estado,
      total: r.vuelos.length,
      mensaje_error: r.mensaje_error,
      medios: m ? { buscando: m.buscando, total: m.fichas.length } : null,
    };
  }

  const movilidad = moverseDeEtapa(etapa);
  const misTraslados = trasladosDeEtapa(etapa.id);
  const miComer = comerDeEtapa(etapa);

  // Los datos duros de los sitios: precio, horario y duración salidos de una
  // búsqueda de verdad. Es lo último que se ha añadido a esta pantalla y, como
  // les pasó antes a los vuelos, no se contaba aquí: las fichas se quedaban con
  // "cargando…" en cada hueco hasta que uno recargaba a mano.
  const datos = { buscando: Boolean(etapa.punto_interes_id && buscandoDatos(etapa.viaje_id, etapa.punto_interes_id)) };

  // Y las busquedas del usuario, que son lo ultimo que trabaja en esta pantalla.
  // Una busqueda "esperando" NO cuenta como trabajo: esta parada a proposito,
  // esperando a que alguien marque casillas, y contarla dejaria el sondeo dando
  // vueltas para siempre.
  const misBusquedas = busquedasDeEtapa(etapa);

  const algunTramoBuscando = Object.values(tramos).some(
    (t) => t.estado === 'buscando' || t.medios?.buscando
  );

  res.json({
    preparacion,
    hoteles: hoteles.estado,
    hotelesTotal: hoteles.total,
    mensaje_error: hoteles.mensaje_error,
    tramos,
    movilidad: { buscando: movilidad.buscando, total: movilidad.fichas.length },
    traslados: { calculando: misTraslados.calculando, total: misTraslados.traslados.length },
    comer: { buscando: miComer.buscando, total: miComer.fichas.length },
    datos,
    busquedas: { buscando: misBusquedas.trabajando, total: misBusquedas.busquedas.length },
    // La pantalla recarga cuando NADA sigue en marcha.
    trabajando:
      preparacion.trabajando ||
      datos.buscando ||
      misBusquedas.trabajando ||
      hoteles.estado === 'buscando' ||
      movilidad.buscando ||
      misTraslados.calculando ||
      miComer.buscando ||
      algunTramoBuscando,
  });
});

/** "Me lo apunto": interruptor de un sitio, una excursión o un restaurante. */
router.post('/etapa/:etapaId/apuntar', cargarContextoEtapa, (req, res) => {
  // Cuatro tablas con ids que se solapan: hay que decir de cuál viene.
  const validos = ['sitio', 'punto', 'actividad', 'comer'];
  const que = validos.includes(req.body?.que) ? req.body.que : 'actividad';
  const r = alternarApuntado(req.contexto.etapa.id, que, Number(req.body?.id));
  if (!r) return res.status(404).json({ error: 'Eso ya no está en el catálogo.' });
  res.json(r);
});

/**
 * Guardar los filtros y buscar, todo en uno, desde la propia pestaña.
 *
 * Es el boton "Buscar hoteles" del formulario que ahora vive DENTRO de "Donde
 * dormir". Antes ese boton mandaba a la pantalla del wizard: se buscaba en un
 * sitio y se filtraba en otro, que es justo lo que no se quiere.
 *
 * Los filtros son del VIAJE (los mismos del paso 6) porque lo que quiero de un
 * hotel no cambia de una ciudad a otra; lo que cambia son las fechas, y esas
 * son las de la etapa.
 */
router.post('/etapa/:etapaId/hoteles/filtros', cargarContextoEtapa, (req, res) => {
  const { etapa, viaje } = req.contexto;

  guardarFiltrosHoteles(viaje.id, filtrosDelCuerpo(req.body));

  if (!etapa.fecha_inicio || !etapa.fecha_fin) {
    return res.status(400).send('Esta etapa no tiene fechas: confírmala en la ruta.');
  }
  buscarHotelesDeEtapa(etapa.id);
  res.redirect(`/etapa/${etapa.id}?p=dormir`);
});

/** Cotizar hoteles con las fechas de ESTA etapa. */
router.post('/etapa/:etapaId/hoteles/buscar', cargarContextoEtapa, (req, res) => {
  const { etapa } = req.contexto;
  if (!etapa.fecha_inicio || !etapa.fecha_fin) {
    return res.status(400).send('Esta etapa no tiene fechas: confírmala en la ruta.');
  }
  buscarHotelesDeEtapa(etapa.id);
  res.redirect(`/etapa/${etapa.id}?p=dormir`);
});

/**
 * Elegir (o soltar) el hotel de la etapa.
 *
 * El id va en la ruta y no en el cuerpo porque el círculo de la tarjeta es el
 * mismo componente del paso 6, y ese manda un POST sin cuerpo a la URL que le
 * pongas en `data-marcar`.
 */
router.post('/etapa/:etapaId/hoteles/:candidatoId/elegir', cargarContextoEtapa, (req, res) => {
  const r = elegirHotel(req.contexto.etapa.id, Number(req.params.candidatoId));
  if (!r) return res.status(404).json({ error: 'Ese hotel ya no está.' });
  // El manejador genérico de public/js/app.js espera { marcado }: la tarjeta de
  // hotel es la misma que en el paso 6 y no se le cambia el contrato.
  res.json({ marcado: r.elegido });
});

/**
 * "Ver detalles" de UNA excursion: encola la busqueda de su ficha completa.
 *
 * UNA A UNA, NUNCA EN MASA. Con veintiocho excursiones por ciudad, buscarlas
 * todas serian veintiocho visitas de navegador para leer tres.
 *
 * Y solo si no esta ya: la ficha es del CATALOGO, asi que puede haberla traido
 * otro viaje. En ese caso no se busca nada y la pantalla la despliega al
 * momento.
 */
router.post('/etapa/:etapaId/actividad/:actividadId/detalles', cargarContextoEtapa, (req, res) => {
  const { viaje } = req.contexto;
  const actividadId = Number(req.params.actividadId);

  const actividad = actividadPorId(actividadId);
  if (!actividad) return res.status(404).json({ error: 'Esa excursión ya no está en el catálogo.' });

  if (actividad.detalles_en) return res.json({ estado: 'hecho' });
  if (!actividad.url) {
    return res.status(400).json({ error: 'Esta excursión no tiene enlace a Civitatis.' });
  }

  const activo = trabajoActivo(viaje.id, 'ficha_actividad', actividadId);
  if (!activo) encolar(viaje.id, 'ficha_actividad', actividadId);

  res.json({ estado: 'buscando' });
});

/** Sondeo de la ficha de una excursion. */
router.get('/etapa/:etapaId/actividad/:actividadId/detalles', cargarContextoEtapa, (req, res) => {
  const { viaje } = req.contexto;
  const actividadId = Number(req.params.actividadId);

  const actividad = actividadPorId(actividadId);
  if (!actividad) return res.status(404).json({ error: 'Esa excursión ya no está en el catálogo.' });

  if (actividad.detalles_en) return res.json({ estado: 'hecho' });

  const activo = trabajoActivo(viaje.id, 'ficha_actividad', actividadId);
  if (activo) return res.json({ estado: 'buscando' });

  const ultimo = ultimoTrabajo(viaje.id, 'ficha_actividad', actividadId);
  res.json({
    estado: ultimo?.estado === 'error' ? 'error' : 'sin_datos',
    mensaje_error: ultimo?.estado === 'error' ? ultimo.mensaje_error : null,
  });
});

/**
 * Las distancias de un destino desde la ciudad de entrada del viaje.
 *
 * Devuelve lo que YA está en caché y encola el cálculo de lo que falte. La
 * pantalla no espera a OSRM: pinta lo que hay, sondea, y va rellenando.
 */
router.get('/api/destinos/:destinoId/distancias', (req, res) => {
  const destinoId = Number(req.params.destinoId);
  const viajeId = Number(req.query.viaje) || null;
  if (!viajeId) return res.json({ referencia: null, distancias: {}, faltan: 0, total: 0 });

  const datos = distanciasDelMapa(destinoId, viajeId);

  // Si falta alguna, que se vaya calculando por detrás. Uno cada vez: si ya hay
  // trabajo en marcha para este destino no se encola otro.
  if (datos.faltan && !trabajoActivo(viajeId, 'distancias', destinoId)) {
    encolar(viajeId, 'distancias', destinoId);
  }

  res.json({ ...datos, calculando: datos.faltan > 0 });
});

/**
 * Sondeo de la preparacion de una parada: si sigue buscando y que esta buscando.
 * Lo usan la pantalla de la etapa y el mapa, que espera aqui antes de entrar.
 */
router.get('/api/etapas/:etapaId/preparacion', (req, res) => {
  const estado = estadoPreparacionEtapa(Number(req.params.etapaId));
  if (!estado) return res.status(404).json({ error: 'Esa parada ya no existe.' });
  res.json(estado);
});

/** Reintentar la preparacion a mano, despues de un fallo. */
router.post('/api/etapas/:etapaId/preparacion', (req, res) => {
  const estado = prepararEtapa(Number(req.params.etapaId), { forzar: true });
  if (!estado) return res.status(404).send('Esa parada ya no existe.');

  if (req.accepts('html') && !req.xhr) return res.redirect(`/etapa/${req.params.etapaId}?p=ver`);
  res.json(estado);
});

/**
 * "Ampliar la ficha" de un sitio desde la etapa.
 *
 * Es el mismo trabajo que ya usaba la pantalla del mapa, y por eso lo que salga
 * se guarda en el CATALOGO: la ficha ampliada aqui se ve tambien alli, y al
 * reves. Una ficha ampliada una vez queda ampliada para siempre.
 */
router.post('/etapa/:etapaId/sitio/:puntoId/ampliar', cargarContextoEtapa, (req, res) => {
  const { viaje } = req.contexto;
  const puntoId = Number(req.params.puntoId);

  const punto = una('SELECT * FROM puntos_interes WHERE id = ?', puntoId);
  if (!punto) return res.status(404).json({ error: 'Ese sitio ya no está en el catálogo.' });

  if (punto.investigado_en) return res.json({ estado: 'hecha' });

  const activo = trabajoActivo(viaje.id, 'investigar_ciudad', puntoId);
  if (!activo) encolar(viaje.id, 'investigar_ciudad', puntoId);

  res.json({ estado: 'ampliando' });
});

/** Sondeo de esa ampliacion. */
router.get('/etapa/:etapaId/sitio/:puntoId/ampliar', cargarContextoEtapa, (req, res) => {
  const { viaje } = req.contexto;
  const puntoId = Number(req.params.puntoId);

  const punto = una('SELECT * FROM puntos_interes WHERE id = ?', puntoId);
  if (!punto) return res.status(404).json({ error: 'Ese sitio ya no está en el catálogo.' });

  if (punto.investigado_en) return res.json({ estado: 'hecha' });

  const activo = trabajoActivo(viaje.id, 'investigar_ciudad', puntoId);
  if (activo) return res.json({ estado: 'ampliando' });

  const ultimo = ultimoTrabajo(viaje.id, 'investigar_ciudad', puntoId);
  res.json({
    estado: ultimo?.estado === 'error' ? 'error' : 'sin_datos',
    mensaje_error: ultimo?.estado === 'error' ? ultimo.mensaje_error : null,
  });
});

/** Notas de la etapa, con autoguardado. */
router.post('/etapa/:etapaId/notas', cargarContextoEtapa, (req, res) => {
  guardarNotas(req.contexto.etapa.id, req.body?.notas);
  res.json({ guardado: true });
});

// --- Los tramos -------------------------------------------------------------

/**
 * Buscar los vuelos de UN tramo, con los filtros que vengan del formulario.
 *
 * SOLO ESE SENTIDO Y SOLO ESA FECHA: BCN→Madrid del 11 y Madrid→BCN del 13 son
 * dos busquedas distintas. Y cada tramo guarda LOS SUYOS, que para eso estan en
 * su propia columna: puedo querer directos a la ida y que me de igual a la
 * vuelta.
 *
 * El formulario manda todos los campos, asi que este endpoint hace las dos
 * cosas —guardar y buscar— y vuelve a la misma pantalla. Nunca redirige al
 * wizard: los filtros viven dentro de la pestaña.
 */
router.post('/tramo/:id/vuelos/buscar', (req, res) => {
  const tramo = una('SELECT * FROM transportes WHERE id = ?', Number(req.params.id));
  if (!tramo) return res.status(404).send('Ese tramo ya no existe.');

  // Si viene del panel de filtros, se guardan antes de buscar; si viene del
  // botón "Actualizar", el cuerpo va vacío y se dejan los que ya tenía.
  if (req.body && Object.keys(req.body).length > 1) {
    guardarFiltrosVuelosTramo(tramo.id, filtrosVueloDelCuerpo(req.body));
  }

  ejecutar(
    `DELETE FROM candidatos
      WHERE transporte_id = ? AND tipo = 'vuelo' AND origen_datos = 'kayak' AND marcado = 0`,
    tramo.id
  );
  encolar(tramo.viaje_id, 'vuelos', tramo.id);

  const volver = req.body?.volverA || `/etapa/${tramo.etapa_origen_id ?? tramo.etapa_destino_id}`;
  res.redirect(`${volver}${volver.includes('?') ? '&' : '?'}p=llegar`);
});

/** Los vuelos encontrados para un tramo, y su estado. */
router.get('/tramo/:id/vuelos', (req, res) => {
  const tramo = una('SELECT * FROM transportes WHERE id = ?', Number(req.params.id));
  if (!tramo) return res.status(404).json({ error: 'Ese tramo ya no existe.' });

  const vuelos = todas(
    `SELECT * FROM candidatos
      WHERE transporte_id = ? AND tipo = 'vuelo' AND origen_datos = 'kayak'
      ORDER BY (precio IS NULL), precio ASC, id`,
    tramo.id
  ).map((c) => ({
    id: c.id,
    titulo: c.titulo,
    precio: c.precio,
    moneda: c.moneda,
    duracion: c.duracion,
    elegido: Boolean(c.marcado),
    extra: c.datos_extra ? JSON.parse(c.datos_extra) : {},
  }));

  const activo = trabajoActivo(tramo.viaje_id, 'vuelos', tramo.id);
  const ultimo = ultimoTrabajo(tramo.viaje_id, 'vuelos', tramo.id);

  res.json({
    estado: activo ? 'buscando' : vuelos.length ? 'hecho'
      : ultimo?.estado === 'error' ? 'error' : 'sin_datos',
    mensaje_error: !activo && ultimo?.estado === 'error' ? ultimo.mensaje_error : null,
    vuelos,
  });
});

/**
 * Elegir el vuelo de un tramo: eso lo deja resuelto.
 *
 * El id va en la RUTA porque la tarjeta de vuelo es la misma del paso 5, y su
 * círculo manda un POST sin cuerpo a la URL de `data-marcar`. Se contesta con
 * `{ marcado }`, que es lo que espera el manejador genérico de app.js.
 */
router.post('/tramo/:id/vuelos/:candidatoId/marcar', (req, res) => {
  const tramo = una('SELECT * FROM transportes WHERE id = ?', Number(req.params.id));
  if (!tramo) return res.status(404).json({ error: 'Ese tramo ya no existe.' });

  const candidatoId = Number(req.params.candidatoId);
  const candidato = una(
    "SELECT * FROM candidatos WHERE id = ? AND transporte_id = ? AND tipo = 'vuelo'",
    candidatoId,
    tramo.id
  );
  if (!candidato) return res.status(404).json({ error: 'Ese vuelo ya no está.' });

  // Uno solo por tramo: elegir otro suelta el anterior, y volver a pulsar el
  // que estaba lo deja sin elegir.
  const soltar = tramo.candidato_id === candidatoId;
  ejecutar("UPDATE candidatos SET marcado = 0 WHERE transporte_id = ?", tramo.id);
  if (!soltar) ejecutar('UPDATE candidatos SET marcado = 1 WHERE id = ?', candidatoId);
  ejecutar('UPDATE transportes SET candidato_id = ? WHERE id = ?', soltar ? null : candidatoId, tramo.id);

  res.json({ marcado: !soltar });
});

/** Resolver un tramo a mano: tren, bus, coche, ferry o vuelo apuntado. */
router.post('/tramo/:id/manual', (req, res) => {
  const t = guardarTransporteManual(Number(req.params.id), {
    tipo: req.body?.tipo,
    notas: req.body?.notas,
    precio: req.body?.precio,
  });
  if (!t) return res.status(404).json({ error: 'Ese tramo ya no existe.' });
  res.json({ tramo: describirTramo(t) });
});

/** Deshacer lo apuntado a mano: el tramo vuelve a estar pendiente. */
router.post('/tramo/:id/olvidar', (req, res) => {
  const t = olvidarTransporteManual(Number(req.params.id));
  if (!t) return res.status(404).json({ error: 'Ese tramo ya no existe.' });
  res.json({ tramo: describirTramo(t) });
});

/**
 * Las distancias de los sitios de una parada, en UN mapa.
 *
 * Un sitio puede venir de dos tablas distintas —`puntos_interes` y
 * `sitios_lugar`— y sus ids se solapan: el 42 es el Prado en una y otra cosa en
 * la otra. Por eso la clave del mapa lleva el origen delante.
 */
function distanciasDeSitios(sitios) {
  const dePuntos = trasladosDeElementos('punto', sitios.filter((x) => x.origen === 'punto').map((x) => x.id));
  const deSitios = trasladosDeElementos('sitio', sitios.filter((x) => x.origen === 'sitio').map((x) => x.id));

  const juntos = new Map();
  for (const [id, lista] of dePuntos) juntos.set(`punto:${id}`, lista);
  for (const [id, lista] of deSitios) juntos.set(`sitio:${id}`, lista);
  return juntos;
}

// =============================================================================
// COMER — bares y restaurantes
// =============================================================================
/** Buscar. El texto libre es el matiz: "cenar tranquilo cerca del hotel". */
// =============================================================================
// EL ORQUESTADOR: progreso, parámetros y cerebro
// =============================================================================
/**
 * La pantalla de progreso del montaje automático.
 *
 * Se puede volver cuando sea: el trabajo va por la cola, así que si cerraste la
 * pestaña y vuelves, aquí está por dónde iba.
 */
router.get('/viajes/:id/orquestador', cargarViaje, (req, res) => {
  res.render('orquestador-progreso', {
    viaje: req.viaje,
    progreso: progresoDeViaje(req.viaje.id),
  });
});

/** Sondeo de esa pantalla. Devuelve las seis fases con su estado y su log. */
router.get('/viajes/:id/orquestador/estado', cargarViaje, (req, res) => {
  res.json(progresoDeViaje(req.viaje.id));
});

/** Volver a lanzarlo. Reinicia las fases: si le das, es que quieres rehacerlo. */
router.post('/viajes/:id/orquestador/lanzar', cargarViaje, (req, res) => {
  const r = lanzarOrquestador(req.viaje.id);
  res.json(r);
});

/** Los números con los que decide. */
router.get('/orquestador/parametros', (req, res) => {
  res.render('orquestador-parametros', { parametros: parametros() });
});

router.post('/api/orquestador/parametros/:clave', (req, res) => {
  const r = guardarParametro(req.params.clave, req.body?.valor);
  if (!r) return res.status(404).json({ error: 'Ese parámetro no existe.' });
  if (r.error) return res.status(400).json(r);
  res.json({ ...r, esDeFabrica: r.valor === r.valor_fabrica });
});

router.post('/api/orquestador/parametros/:clave/restaurar', (req, res) => {
  const r = restaurarParametro(req.params.clave);
  if (!r) return res.status(404).json({ error: 'Ese parámetro no existe.' });
  res.json({ ...r, esDeFabrica: true });
});

/** Lo que se le dice a la IA en cada fase. */
router.get('/orquestador/cerebro', (req, res) => {
  res.render('orquestador-cerebro', { prompts: prompts() });
});

router.post('/api/orquestador/prompts/:fase', (req, res) => {
  const r = guardarPrompt(req.params.fase, req.body?.texto);
  if (r.error) return res.status(400).json(r);
  res.json({ ...r, esDeFabrica: r.prompt_actual === r.prompt_fabrica });
});

router.post('/api/orquestador/prompts/:fase/restaurar', (req, res) => {
  const r = restaurarPrompt(req.params.fase);
  if (!r) return res.status(404).json({ error: 'Esa fase no existe.' });
  res.json({ ...r, esDeFabrica: true });
});

// =============================================================================
// «MIS BÚSQUEDAS»: los sitios que el usuario se busca por su cuenta
// =============================================================================
/** Escribir algo y darle a buscar. Se toma nota y se encola; aquí no se espera. */
router.post('/api/etapas/:etapaId/sitios/buscar', (req, res) => {
  const etapa = una('SELECT * FROM etapas WHERE id = ?', Number(req.params.etapaId));
  if (!etapa) return res.status(404).json({ error: 'Esa parada ya no existe.' });

  const viaje = una('SELECT * FROM viajes WHERE id = ?', etapa.viaje_id);
  const r = pedirBusqueda(viaje, etapa, req.body?.texto);
  if (r.error) return res.status(400).json(r);
  res.json(r);
});

/** Sondeo de la pestaña: en qué punto va cada búsqueda. */
router.get('/api/etapas/:etapaId/sitios/busquedas', (req, res) => {
  const etapa = una('SELECT * FROM etapas WHERE id = ?', Number(req.params.etapaId));
  if (!etapa) return res.status(404).json({ error: 'Esa parada ya no existe.' });
  res.json(busquedasDeEtapa(etapa));
});

/** El usuario marca cuáles de las propuestas quiere. */
router.post('/api/busquedas-sitios/:id/elegir', (req, res) => {
  const r = elegirPropuestas(Number(req.params.id), req.body?.nombres);
  if (r.error) return res.status(400).json(r);
  res.json(r);
});

/** Quitar una búsqueda de la lista. Las fichas que dio se quedan: son catálogo. */
router.delete('/api/busquedas-sitios/:id', (req, res) => {
  borrarBusqueda(Number(req.params.id));
  res.json({ ok: true });
});

router.post('/api/etapas/:etapaId/comer/buscar', (req, res) => {
  const r = pedirBusquedaDeComer(Number(req.params.etapaId), req.body?.consulta);
  if (!r) return res.status(404).json({ error: 'Esa parada ya no existe.' });
  res.json(r);
});

/** Sondeo de la pestaña. */
router.get('/api/etapas/:etapaId/comer', (req, res) => {
  const e = una('SELECT * FROM etapas WHERE id = ?', Number(req.params.etapaId));
  if (!e) return res.status(404).json({ error: 'Esa parada ya no existe.' });
  res.json(comerDeEtapa(e));
});

/** El bar que te recomendó un amigo, escrito a mano. */
router.post('/api/etapas/:etapaId/comer', (req, res) => {
  const e = una('SELECT * FROM etapas WHERE id = ?', Number(req.params.etapaId));
  if (!e) return res.status(404).json({ error: 'Esa parada ya no existe.' });

  const ficha = guardarFichaManual(e.nombre_ciudad, req.body ?? {});
  if (!ficha) return res.status(400).json({ error: 'No se pudo guardar esa ficha.' });
  res.json({ ficha });
});

router.put('/api/comer/:fichaId', (req, res) => {
  const f = actualizarFichaDeComer(Number(req.params.fichaId), req.body ?? {});
  if (!f) return res.status(404).json({ error: 'Ese sitio ya no está.' });
  res.json({ ficha: f });
});

router.delete('/api/comer/:fichaId', (req, res) => {
  if (!borrarFichaDeComer(Number(req.params.fichaId))) {
    return res.status(404).json({ error: 'Ese sitio ya no está.' });
  }
  res.json({ borrado: true });
});

/**
 * Los datos de contacto de UN sitio, bajo demanda.
 *
 * Es la parte cara de Places, así que se piden al abrir la ficha y solo una
 * vez: exactamente el mismo camino que las fichas de Civitatis. Un sitio que ya
 * los tiene contesta al instante sin salir a ningún sitio.
 */
router.post('/api/comer/:fichaId/detalles', (req, res) => {
  const r = pedirDetallesDeComer(Number(req.params.fichaId), Number(req.body?.viajeId));
  if (!r) return res.status(404).json({ error: 'Ese sitio ya no está.' });
  res.json(r);
});

router.get('/api/comer/:fichaId/detalles', (req, res) => {
  res.json(estadoDetallesDeComer(Number(req.params.fichaId), Number(req.query.viaje)));
});

/**
 * Las distancias guardadas de una ficha cualquiera.
 *
 * Sale de la MISMA tabla de traslados: un traslado ya sabe de qué elemento es
 * cada extremo, así que preguntar "¿cuáles tocan a esta ficha?" es una consulta
 * y no un modelo nuevo.
 */
router.get('/api/distancias/:tipo/:elementoId', (req, res) => {
  res.json({ traslados: trasladosDeElemento(req.params.tipo, Number(req.params.elementoId)) });
});

// =============================================================================
// COMER DESDE EL LIENZO
// =============================================================================
/**
 * Qué hay para comer ENTRE las dos tarjetas de un hueco.
 *
 * Se busca alrededor del punto medio con un radio proporcional a lo que separa
 * los extremos, y cada resultado dice su desvío. Sin ese desvío, "de paso" no
 * significa nada: un sitio buenísimo a quince minutos del camino no pilla de
 * paso por muy céntrico que sea el punto medio.
 */
router.post('/api/viaje/:viajeId/hueco/comer', async (req, res) => {
  const viajeId = Number(req.params.viajeId);
  const hueco = vecinosDeHueco(viajeId, {
    dia: Number(req.body?.dia),
    franja: String(req.body?.franja ?? ''),
    indice: Number(req.body?.indice),
  });
  if (!hueco) return res.status(404).json({ error: 'Ese hueco no existe.' });
  if (!hueco.origen || !hueco.destino) {
    return res.status(400).json({ error: 'Aquí no hay nada antes o después entre lo que buscar.' });
  }

  const sinSitio = [hueco.origen, hueco.destino].find((x) => !x.situada);
  if (sinSitio) {
    return res.status(400).json({
      error: `Falta la dirección de «${sinSitio.nombre}».`,
      falta: sinSitio,
    });
  }

  const a = puntoDeLugar(hueco.origen);
  const b = puntoDeLugar(hueco.destino);
  if (!a || !b) {
    return res.status(400).json({ error: 'No se sabe dónde caen esos dos puntos.' });
  }

  try {
    const r = await buscarEntre(hueco.ciudad, a, b, {
      consulta: req.body?.consulta,
      // Los nombres de los dos extremos: es lo que le dice a la IA de qué zona
      // se está hablando, porque el sesgo por coordenadas solo lo entiende
      // Places.
      entre: { origen: hueco.origen.nombre, destino: hueco.destino.nombre },
    });

    // LO QUE YA TIENES APUNTADO, DELANTE.
    //
    // Si me molesté en apuntarme un sitio para esta parada, es que me interesa
    // más que doce que acabo de descubrir. Salen arriba y marcados, y detrás
    // los nuevos. Se ordenan igual entre ellos —por desvío—, así que un
    // apuntado que queda lejísimos no se cuela por delante de otro apuntado que
    // pilla de paso.
    const apuntados = new Set(
      todas(
        "SELECT titulo FROM candidatos WHERE etapa_id = ? AND tipo = 'comer'",
        hueco.etapaId
      ).map((c) => c.titulo)
    );

    const sitios = r.sitios
      .map((x) => ({ ...x, yaApuntado: apuntados.has(x.nombre) }))
      .sort((x, y) => (y.yaApuntado ? 1 : 0) - (x.yaApuntado ? 1 : 0));

    res.json({ ...r, sitios, hueco });
  } catch (err) {
    console.error('[rutas] al buscar dónde comer entre dos puntos:', err);
    res.status(500).json({ error: err.message || 'No se pudo buscar.' });
  }
});

/** Coloca en el hueco el sitio elegido, como tarjeta de comida. */
router.post('/api/viaje/:viajeId/hueco/comer/colocar', (req, res) => {
  const viajeId = Number(req.params.viajeId);
  const hueco = vecinosDeHueco(viajeId, {
    dia: Number(req.body?.dia),
    franja: String(req.body?.franja ?? ''),
    indice: Number(req.body?.indice),
  });
  if (!hueco?.etapaId) return res.status(404).json({ error: 'Ese hueco no existe.' });

  const ficha = fichaDeComer(Number(req.body?.fichaId));
  if (!ficha) return res.status(404).json({ error: 'Ese sitio ya no está.' });

  // Apuntarlo primero: una comida en el lienzo es una cosa apuntada del viaje,
  // igual que una excursión. Si ya estaba apuntado se reutiliza su candidato.
  const yaEsta = una(
    "SELECT * FROM candidatos WHERE etapa_id = ? AND tipo = 'comer' AND titulo = ?",
    hueco.etapaId,
    ficha.nombre
  );
  if (!yaEsta) alternarApuntado(hueco.etapaId, 'comer', ficha.id);

  const candidato = una(
    "SELECT * FROM candidatos WHERE etapa_id = ? AND tipo = 'comer' AND titulo = ?",
    hueco.etapaId,
    ficha.nombre
  );
  if (!candidato) return res.status(500).json({ error: 'No se pudo apuntar ese sitio.' });

  const fila = colocar(viajeId, {
    candidatoId: candidato.id,
    dia: Number(req.body?.dia),
    franja: String(req.body?.franja ?? ''),
    hora: req.body?.hora ?? null,
    // UNA COMIDA ES UNA ACTIVIDAD: tarjeta de altura normal, no la fina de los
    // traslados. Se le da una duración de partida razonable y editable.
    duracionMin: Number(req.body?.duracionMin) || 90,
    orden: hueco.orden,
  });
  if (!fila) return res.status(400).json({ error: 'No se pudo colocar ahí.' });

  res.json(lienzoDeViaje(viajeId, { etapaId: Number(req.body?.etapa) || null }));
});

/** El punto de un lugar del hueco, que es lo único que necesita la búsqueda. */
function puntoDeLugar(lugar) {
  if (!lugar?.tipo || !lugar?.id) return null;
  const d = direccionDe(lugar.tipo, lugar.id);
  return d?.situada ? d.punto : null;
}

// =============================================================================
// DIRECCIONES — dónde está cada cosa
// =============================================================================
/**
 * Guardar la dirección de algo. Contesta al instante.
 *
 * Buscar las coordenadas va por la cola: geocodificar tarda —hay que preguntarle
 * turno de una petición por segundo— y quien acaba de teclear una calle no
 * tiene por qué esperar a nadie. La ficha dice "situando…" mientras tanto.
 */
router.post('/api/direcciones/:tipo/:elementoId', (req, res) => {
  if (!Object.hasOwn(TIPOS_CON_DIRECCION, req.params.tipo)) {
    return res.status(400).json({ error: 'Eso no puede tener dirección.' });
  }

  const d = guardarDireccion(req.params.tipo, Number(req.params.elementoId), req.body?.direccion, {
    viajeId: Number(req.body?.viajeId) || null,
  });
  res.json({ guardado: true, direccion: d });
});

/** Cómo va la búsqueda de una dirección. Lo sondea la ficha. */
router.get('/api/direcciones/:tipo/:elementoId', (req, res) => {
  res.json({ direccion: direccionDe(req.params.tipo, Number(req.params.elementoId)) });
});

/** Volver a buscarla sin cambiar el texto: para cuando falló la red. */
router.post('/api/direcciones/:tipo/:elementoId/situar', (req, res) => {
  const r = pedirGeocodificar(req.params.tipo, Number(req.params.elementoId), {
    viajeId: Number(req.body?.viajeId) || null,
  });
  if (!r) return res.status(404).json({ error: 'Esa dirección ya no está.' });
  res.json(r);
});

// =============================================================================
// TRASLADOS — cuánto hay de aquí a allá
// =============================================================================
/**
 * A dónde se puede ir desde esta parada.
 *
 * Alimenta el autocompletado de los dos campos del buscador. Sale SIN
 * coordenadas: el usuario piensa en direcciones y en nombres, y lat/lng no
 * pintan nada en el navegador.
 */
router.get('/api/etapas/:etapaId/lugares', (req, res) => {
  res.json({ lugares: paraLaVista(lugaresDeEtapa(Number(req.params.etapaId))) });
});

/** La lista de traslados consultados de una parada. */
router.get('/api/etapas/:etapaId/traslados', (req, res) => {
  res.json(trasladosDeEtapa(Number(req.params.etapaId)));
});

/** Consultar uno nuevo. Los extremos pueden ser del viaje o tecleados. */
router.post('/api/etapas/:etapaId/traslados', (req, res) => {
  const r = crearTraslado(Number(req.params.etapaId), req.body?.origen, req.body?.destino);
  if (!r) return res.status(404).json({ error: 'Esa parada ya no existe.' });
  // `falta` dice QUÉ elemento se quedó sin dirección, para que la pantalla
  // pueda ofrecer abrir su edición en vez de dejar a la persona adivinando.
  if (r.error) return res.status(400).json({ error: r.error, falta: r.falta ?? null });
  res.json(r);
});

/** Fijar un traslado para que salga arriba, o soltarlo al historial. */
router.post('/api/traslados/:id/fijar', (req, res) => {
  const r = fijarTraslado(Number(req.params.id));
  if (!r) return res.status(404).json({ error: 'Ese traslado ya no está.' });
  res.json(r);
});

router.post('/api/traslados/:id/recalcular', (req, res) => {
  const t = recalcularTraslado(Number(req.params.id));
  if (!t) return res.status(404).json({ error: 'Ese traslado ya no está.' });
  res.json({ traslado: t });
});

router.delete('/api/traslados/:id', (req, res) => {
  if (!borrarTraslado(Number(req.params.id))) {
    return res.status(404).json({ error: 'Ese traslado ya no está.' });
  }
  res.json({ borrado: true });
});

/**
 * Poner un traslado consultado en el lienzo, con el medio que se elija.
 *
 * El medio decide los minutos y el icono: el mismo traslado son 20 andando o 8
 * en coche, y la tarjeta tiene que decir cuál de los dos se va a hacer.
 */
router.post('/api/traslados/:id/al-lienzo', (req, res) => {
  const t = trasladoPorId(Number(req.params.id));
  if (!t) return res.status(404).json({ error: 'Ese traslado ya no está.' });

  const medio = String(req.body?.medio ?? '');
  const elegido = t.resultados.find((r) => r.modo === medio) ?? t.resultados[0];
  if (!elegido) return res.status(400).json({ error: 'Ese traslado todavía no tiene resultado.' });

  const fila = colocar(t.viajeId, {
    textoManual: t.recorrido,
    dia: req.body?.dia,
    franja: req.body?.franja,
    hora: req.body?.hora ?? null,
    trasladoId: t.id,
    medio: elegido.modo,
    duracionMin: elegido.minutos,
  });
  if (!fila) return res.status(400).json({ error: 'No se pudo colocar ahí.' });

  res.json(lienzoDeViaje(t.viajeId, { etapaId: Number(req.body?.etapa) || null }));
});

/**
 * El "+" del lienzo: qué hay a un lado y a otro de un hueco.
 *
 * Lo contesta el servidor y no el navegador porque los vecinos no siempre están
 * en la misma franja —el de antes puede ser la última tarjeta de la mañana, y
 * en el borde del día es el hotel—, y esa lógica no puede vivir en dos sitios.
 */
router.get('/api/viaje/:viajeId/hueco', (req, res) => {
  const r = vecinosDeHueco(Number(req.params.viajeId), {
    dia: Number(req.query.dia),
    franja: String(req.query.franja ?? ''),
    indice: Number(req.query.indice),
  });
  if (!r) return res.status(404).json({ error: 'Ese hueco no existe.' });
  res.json(r);
});

/**
 * Calcular y colocar un traslado desde el lienzo, de un tirón.
 *
 * Es el camino del punto 7: se pulsa el "+", se toman los vecinos y sale la
 * tarjeta. La consulta se guarda TAMBIÉN en la lista de la etapa, porque es la
 * misma pieza: una consulta hecha es una consulta que quiero volver a leer.
 */
router.post('/api/viaje/:viajeId/hueco/traslado', async (req, res) => {
  const viajeId = Number(req.params.viajeId);
  const hueco = vecinosDeHueco(viajeId, {
    dia: Number(req.body?.dia),
    franja: String(req.body?.franja ?? ''),
    indice: Number(req.body?.indice),
  });
  if (!hueco) return res.status(404).json({ error: 'Ese hueco no existe.' });

  // LO DEDUCIDO ES UNA PROPUESTA, NO UNA IMPOSICIÓN.
  //
  // Las tarjetas de al lado aciertan casi siempre, y por eso siguen siendo lo
  // que sale puesto. Pero no siempre: a veces uno quiere el traslado desde el
  // hotel aunque la tarjeta anterior sea un museo, o hasta el aeropuerto
  // aunque no haya ninguna tarjeta detrás. Si el navegador manda extremos, se
  // usan esos.
  const origen = req.body?.origen ?? hueco.origen;
  const destino = req.body?.destino ?? hueco.destino;

  if (!origen || !destino) {
    return res.status(400).json({
      error: 'Hay que decir desde dónde y hasta dónde.',
    });
  }

  // A un elemento del viaje se le exige dirección; al texto libre no, que se
  // busca al calcular. `crearTraslado` ya sabe distinguirlos, así que aquí solo
  // se comprueba lo que viene de las tarjetas de al lado.
  const sinSitio = [origen, destino].find((x) => x?.tipo && x?.id && x.situada === false);
  if (sinSitio) {
    return res.status(400).json({
      error: `Falta la dirección de «${sinSitio.nombre}».`,
      falta: sinSitio,
    });
  }

  const creado = crearTraslado(hueco.etapaId, origen, destino);
  if (!creado || creado.error) {
    return res.status(400).json({ error: creado?.error ?? 'No se pudo consultar.' });
  }

  // Se espera al cálculo: aquí SÍ, porque el resultado es la tarjeta que hay
  // que colocar. En la lista de la etapa se puede enseñar "calculando…"; una
  // tarjeta sin minutos en el lienzo no dice nada.
  const listo = await calcularTraslado(creado.traslado.id);
  const elegido = listo?.resultados?.[0];
  if (!elegido) {
    return res.status(400).json({
      error: listo?.mensaje ?? 'No se ha podido calcular ese traslado.',
      trasladoId: creado.traslado.id,
    });
  }

  const fila = colocar(viajeId, {
    textoManual: listo.recorrido,
    dia: Number(req.body?.dia),
    franja: String(req.body?.franja ?? ''),
    trasladoId: listo.id,
    medio: elegido.modo,
    duracionMin: elegido.minutos,
    // Se mete justo en el hueco, no al final de la franja: el orden es lo que
    // hace que un traslado signifique algo.
    orden: hueco.orden,
  });
  if (!fila) return res.status(400).json({ error: 'No se pudo colocar ahí.' });

  res.json({
    ...lienzoDeViaje(viajeId, { etapaId: Number(req.body?.etapa) || null }),
    traslado: listo,
  });
});

// =============================================================================
// MOVILIDAD — cómo ir de una ciudad a otra, y cómo moverse dentro
// =============================================================================

/** Pedir a la IA (con búsqueda web) los medios de un tramo. */
router.post('/api/tramos/:id/transporte/buscar', (req, res) => {
  const r = pedirTransporteDeTramo(Number(req.params.id), { forzar: true });
  if (!r) return res.status(404).json({ error: 'Ese tramo ya no existe.' });
  res.json(r);
});

/** Sondeo: ¿ya están las fichas del tramo? */
router.get('/api/tramos/:id/transporte', (req, res) => {
  const t = una('SELECT * FROM transportes WHERE id = ?', Number(req.params.id));
  if (!t) return res.status(404).json({ error: 'Ese tramo ya no existe.' });

  const origen = t.etapa_origen_id
    ? una('SELECT nombre_ciudad FROM etapas WHERE id = ?', t.etapa_origen_id)
    : null;
  const destino = t.etapa_destino_id
    ? una('SELECT nombre_ciudad FROM etapas WHERE id = ?', t.etapa_destino_id)
    : null;

  res.json(
    comoLlegarDeTramo(t.id, origen?.nombre_ciudad ?? null, destino?.nombre_ciudad ?? null) ?? {}
  );
});

/** Elegir (o soltar) el medio de un tramo. */
router.post('/api/tramos/:id/transporte/:fichaId/elegir', (req, res) => {
  const r = elegirMedio(Number(req.params.id), Number(req.params.fichaId));
  if (!r) return res.status(404).json({ error: 'Ese medio ya no está.' });
  res.json(r);
});

/** Lo tecleado de un medio en un tramo: horario, precio, reserva y nota. */
router.post('/api/tramos/:id/transporte/:fichaId/datos', (req, res) => {
  const r = guardarDatosDelTramo(Number(req.params.id), Number(req.params.fichaId), req.body ?? {});
  res.json({ guardado: true, datos: r });
});

/** Crear una ficha de medio a mano. Siempre disponible, con IA o sin ella. */
router.post('/api/tramos/:id/transporte', (req, res) => {
  const t = una('SELECT * FROM transportes WHERE id = ?', Number(req.params.id));
  if (!t) return res.status(404).json({ error: 'Ese tramo ya no existe.' });

  const origen = t.etapa_origen_id
    ? una('SELECT nombre_ciudad FROM etapas WHERE id = ?', t.etapa_origen_id)
    : null;
  const destino = t.etapa_destino_id
    ? una('SELECT nombre_ciudad FROM etapas WHERE id = ?', t.etapa_destino_id)
    : null;
  if (!origen || !destino) {
    return res.status(400).json({ error: 'Este tramo va a casa o viene de casa.' });
  }

  const ficha = guardarFichaTramo(
    origen.nombre_ciudad,
    destino.nombre_ciudad,
    req.body ?? {},
    'manual'
  );
  res.json({ ficha });
});

router.put('/api/transporte-tramo/:fichaId', (req, res) => {
  const f = actualizarFichaTramo(Number(req.params.fichaId), req.body ?? {});
  if (!f) return res.status(404).json({ error: 'Esa ficha ya no está.' });
  res.json({ ficha: f });
});

router.delete('/api/transporte-tramo/:fichaId', (req, res) => {
  if (!borrarFichaTramo(Number(req.params.fichaId))) {
    return res.status(404).json({ error: 'Esa ficha ya no está.' });
  }
  res.json({ borrado: true });
});

// --- Moverse por la ciudad ---------------------------------------------------

/** Pedir a la IA (con búsqueda web) cómo moverse por la ciudad de una etapa. */
router.post('/api/etapas/:etapaId/movilidad/buscar', (req, res) => {
  const r = pedirMovilidadDeCiudad(Number(req.params.etapaId));
  if (!r) return res.status(404).json({ error: 'Esa parada ya no existe.' });
  res.json(r);
});

/** Sondeo de la pestaña "Moverse". */
router.get('/api/etapas/:etapaId/movilidad', (req, res) => {
  const e = una('SELECT * FROM etapas WHERE id = ?', Number(req.params.etapaId));
  if (!e) return res.status(404).json({ error: 'Esa parada ya no existe.' });
  res.json(moverseDeEtapa(e));
});

/** Crear una ficha de movilidad a mano. */
router.post('/api/etapas/:etapaId/movilidad', (req, res) => {
  const e = una('SELECT * FROM etapas WHERE id = ?', Number(req.params.etapaId));
  if (!e) return res.status(404).json({ error: 'Esa parada ya no existe.' });
  res.json({ ficha: guardarFichaMovilidad(e.nombre_ciudad, req.body ?? {}, 'manual') });
});

router.put('/api/movilidad/:fichaId', (req, res) => {
  const f = actualizarFichaMovilidad(Number(req.params.fichaId), req.body ?? {});
  if (!f) return res.status(404).json({ error: 'Esa ficha ya no está.' });
  res.json({ ficha: f });
});

router.delete('/api/movilidad/:fichaId', (req, res) => {
  if (!borrarFichaMovilidad(Number(req.params.fichaId))) {
    return res.status(404).json({ error: 'Esa ficha ya no está.' });
  }
  res.json({ borrado: true });
});

// =============================================================================
// ADJUNTOS — el billete, la confirmación, el bono
// =============================================================================

/**
 * De qué viaje es un elemento. Sin esto no se sabe en qué carpeta va el archivo.
 *
 * Es una relación polimórfica: `elemento_id` apunta a `transportes` o a
 * `candidatos` según el tipo, así que hay que preguntar a la tabla que toque.
 */
function viajeDelElemento(tipo, elementoId) {
  const fila =
    tipo === 'transporte'
      ? una('SELECT viaje_id FROM transportes WHERE id = ?', elementoId)
      : una('SELECT viaje_id FROM candidatos WHERE id = ?', elementoId);
  return fila?.viaje_id ?? null;
}

/**
 * Subir un adjunto.
 *
 * EL ARCHIVO VIENE COMO CUERPO CRUDO, no como multipart. El navegador puede
 * mandar un File tal cual en el body de un fetch, y así no hace falta meter una
 * librería de multipart en el proyecto para subir de uno en uno, que es como se
 * suben estas cosas. El nombre viaja en una cabecera porque un nombre de archivo
 * puede traer cualquier carácter y en la URL daría problemas.
 */
router.post(
  '/api/adjuntos/:tipo/:elementoId',
  express.raw({ type: () => true, limit: TOPE_ADJUNTO }),
  async (req, res) => {
    const { tipo } = req.params;
    const elementoId = Number(req.params.elementoId);

    const viajeId = viajeDelElemento(tipo, elementoId);
    if (!viajeId) return res.status(404).json({ error: 'Ese elemento ya no existe.' });

    let nombre = 'archivo';
    try {
      nombre = decodeURIComponent(req.get('X-Nombre') ?? '') || 'archivo';
    } catch {
      nombre = 'archivo'; // cabecera mal codificada: no es motivo para fallar
    }

    const r = await guardarAdjunto({
      viajeId,
      tipo,
      elementoId,
      nombre,
      mime: req.get('Content-Type'),
      datos: req.body,
    });

    if (!r.ok) return res.status(400).json({ error: r.error });
    res.json({ adjunto: { ...r.adjunto, tamanoTexto: comoTamano(r.adjunto.tamano) } });
  }
);

/** Los adjuntos de un elemento. */
router.get('/api/adjuntos/:tipo/:elementoId', async (req, res) => {
  const { tipo } = req.params;
  const elementoId = Number(req.params.elementoId);

  // De qué viaje limpiar. Si el elemento ya no existe —que es justo cuando hay
  // huérfanos que limpiar— no se le puede preguntar a él: se le pregunta al
  // propio adjunto, que lleva su viaje dentro.
  const viajeId =
    viajeDelElemento(tipo, elementoId) ?? adjuntosDe(tipo, elementoId)[0]?.viaje_id ?? null;
  if (viajeId) await limpiarAdjuntosHuerfanos(viajeId);

  res.json({ adjuntos: adjuntosDe(tipo, elementoId) });
});

/** Borrar uno. */
router.delete('/api/adjuntos/:id', async (req, res) => {
  const ok = await borrarAdjunto(Number(req.params.id));
  if (!ok) return res.status(404).json({ error: 'Ese adjunto ya no está.' });
  res.json({ borrado: true });
});

/**
 * Ver un adjunto. Se sirve desde aquí y no como estático porque la carpeta
 * `adjuntos/` está fuera de `public/` a propósito: son papeles con datos
 * personales y no tienen por qué ser alcanzables adivinando una ruta.
 */
router.get('/adjunto/:id', (req, res) => {
  const a = adjuntoPorId(Number(req.params.id));
  if (!a) return res.status(404).send('Ese adjunto ya no está.');

  res.type(a.mime);
  // `inline`: el PDF o la foto se abren en la pestaña en vez de descargarse.
  res.setHeader('Content-Disposition', `inline; filename="${a.nombre_archivo}"`);
  res.sendFile(rutaDe(a), (err) => {
    if (err && !res.headersSent) res.status(404).send('El archivo ya no está en el disco.');
  });
});

// =============================================================================
// EL DOSIER — la salida final del viaje
// =============================================================================

/**
 * El check de "viaje listo". Lo pongo y lo quito yo.
 *
 * NO se valida contra nada: la pantalla enseña qué falta —tramos sin resolver,
 * etapas sin hotel— pero eso solo informa. Un viaje puede estar listo con la
 * última noche sin cerrar si así lo he decidido, y bloquear el check por eso
 * sería la aplicación diciéndome cuándo está listo mi viaje.
 */
router.post('/api/viaje/:viajeId/listo', (req, res) => {
  const viajeId = Number(req.params.viajeId);
  const viaje = una('SELECT * FROM viajes WHERE id = ?', viajeId);
  if (!viaje) return res.status(404).json({ error: 'Ese viaje ya no existe.' });

  const listo = req.body?.listo === true || req.body?.listo === 'true' || req.body?.listo === '1';
  ejecutar('UPDATE viajes SET listo = ? WHERE id = ?', listo ? 1 : 0, viajeId);

  const actualizado = una('SELECT * FROM viajes WHERE id = ?', viajeId);
  res.json({ listo, dosier: estadoDelDosier(actualizado) });
});

/** Estado del dosier, para que las dos pantallas pinten lo mismo. */
router.get('/api/viaje/:viajeId/dosier', (req, res) => {
  const viaje = una('SELECT * FROM viajes WHERE id = ?', Number(req.params.viajeId));
  if (!viaje) return res.status(404).json({ error: 'Ese viaje ya no existe.' });
  res.json(estadoDelDosier(viaje));
});

/**
 * Generar el dosier. Sustituye al anterior: solo hay uno por viaje.
 *
 * Tarda lo que tarden las fotos, así que contesta cuando ya está el archivo en
 * disco. No es un trabajo de la cola porque no abre navegador ni compite por el
 * perfil de Chrome: son unas cuantas descargas pequeñas.
 */
router.post('/api/viaje/:viajeId/dosier', async (req, res) => {
  const viajeId = Number(req.params.viajeId);
  const viaje = una('SELECT * FROM viajes WHERE id = ?', viajeId);
  if (!viaje) return res.status(404).json({ error: 'Ese viaje ya no existe.' });

  try {
    const r = await generarDosier(viajeId);
    if (!r) return res.status(500).json({ error: 'No se pudo generar el dosier.' });

    const actualizado = una('SELECT * FROM viajes WHERE id = ?', viajeId);
    res.json({
      generado: true,
      bytes: r.bytes,
      tamano: `${(r.bytes / 1024 / 1024).toFixed(2)} MB`,
      fotos: r.fotos,
      fotosOmitidas: r.fotosOmitidas,
      adjuntos: r.adjuntos,
      adjuntosOmitidos: r.adjuntosOmitidos,
      nombresOmitidos: r.nombresOmitidos,
      urlVer: `/viaje/${viajeId}/dosier`,
      urlDescargar: `/viaje/${viajeId}/dosier/descargar`,
      dosier: estadoDelDosier(actualizado),
    });
  } catch (err) {
    console.error('[rutas] al generar el dosier:', err);
    res.status(500).json({ error: err.message || 'No se pudo generar el dosier.' });
  }
});

/** Verlo en una pestaña. Se sirve tal cual está en disco. */
router.get('/viaje/:viajeId/dosier', async (req, res) => {
  const html = await leerDosier(Number(req.params.viajeId));
  if (!html) {
    return res
      .status(404)
      .send('Todavía no hay dosier de este viaje. <a href="/">Volver a mis viajes</a>');
  }
  res.type('html').send(html);
});

/**
 * Descargarlo: baja el ZIP, que es el dosier completo.
 *
 * El HTML suelto se queda para "Ver" —una revisión rápida no tiene por qué pasar
 * por descomprimir nada—, pero lo que uno se lleva al móvil es el ZIP: dentro
 * van los adjuntos, y los enlaces del HTML apuntan a ellos en relativo.
 */
router.get('/viaje/:viajeId/dosier/descargar', async (req, res) => {
  const viajeId = Number(req.params.viajeId);
  const zip = await zipDelViaje(viajeId);
  if (!zip) {
    // Puede no haber ZIP y sí HTML: los dosieres generados antes de que el
    // dosier pasara a ser un ZIP. Se dice qué hacer, que es una sola cosa.
    const html = await leerDosier(viajeId);
    return res
      .status(404)
      .send(
        html
          ? 'Este dosier es de antes de que llevara adjuntos. Vuelve a generarlo para tener el ZIP.'
          : 'Todavía no hay dosier de este viaje.'
      );
  }

  const viaje = una('SELECT nombre FROM viajes WHERE id = ?', viajeId);
  // El nombre del archivo va saneado: acabará en el sistema de archivos de un
  // móvil y ahí los acentos y las barras dan más problemas que otra cosa.
  const limpio = nombreDeArchivo(viaje?.nombre, viajeId);

  res.setHeader('Content-Disposition', `attachment; filename="${limpio}.zip"`);
  res.type('application/zip');
  res.sendFile(zip, (err) => {
    if (err && !res.headersSent) res.status(404).send('El ZIP ya no está en el disco.');
  });
});

/** El nombre del viaje, apto para un sistema de archivos. */
function nombreDeArchivo(nombre, viajeId) {
  return (
    String(nombre ?? `viaje-${viajeId}`)
      .normalize('NFD')
      .replace(/[̀-ͯ]/g, '')
      .replace(/[^a-zA-Z0-9]+/g, '-')
      .replace(/^-+|-+$/g, '')
      .toLowerCase() || `viaje-${viajeId}`
  );
}

// =============================================================================
// EL LIENZO — repartir lo apuntado por los días del viaje
// =============================================================================

/** La pantalla. `?etapa=ID` la deja filtrada a una parada. */
router.get('/viaje/:viajeId/lienzo', (req, res) => {
  const viajeId = Number(req.params.viajeId);
  const viaje = una('SELECT * FROM viajes WHERE id = ?', viajeId);
  if (!viaje) {
    return res.status(404).send('No existe ese viaje. <a href="/">Volver a mis viajes</a>');
  }

  const etapaId = Number(req.query.etapa) || null;
  const lienzo = lienzoDeViaje(viajeId, { etapaId });

  res.render('lienzo', {
    lienzo,
    opinion: viaje.opinion_lienzo,
    pensando: Boolean(trabajoActivo(viajeId, 'opinar_lienzo')),
    // El mismo panel del dosier que la ruta: se cierra el viaje desde donde se
    // esté mirando, no solo desde una pantalla.
    dosier: estadoDelDosier(viaje),
  });
});

/** El lienzo entero en JSON: lo que usa el cliente para repintar. */
router.get('/api/viaje/:viajeId/lienzo', (req, res) => {
  const lienzo = lienzoDeViaje(Number(req.params.viajeId), {
    etapaId: Number(req.query.etapa) || null,
  });
  if (!lienzo) return res.status(404).json({ error: 'Ese viaje ya no existe.' });
  res.json(lienzo);
});

/** Colocar algo: un candidato de la mochila o un texto escrito a mano. */
router.post('/api/itinerario', (req, res) => {
  const viajeId = Number(req.body?.viajeId);
  if (!una('SELECT id FROM viajes WHERE id = ?', viajeId)) {
    return res.status(404).json({ error: 'Ese viaje ya no existe.' });
  }

  const fila = colocar(viajeId, {
    candidatoId: Number(req.body?.candidatoId) || null,
    textoManual: req.body?.textoManual ?? null,
    dia: req.body?.dia,
    franja: req.body?.franja,
    hora: req.body?.hora ?? null,
    // Un traslado viaja como texto_manual + movilidad_id: el CHECK de la tabla
    // solo admite una de las dos columnas de contenido, y el nombre va en esa.
    movilidadId: Number(req.body?.movilidadId) || null,
    duracionMin: Number(req.body?.duracionMin) || null,
  });
  if (!fila) return res.status(400).json({ error: 'No se pudo colocar ahí.' });

  res.json(lienzoDeViaje(viajeId, { etapaId: Number(req.body?.etapa) || null }));
});

/** Moverlo a otro día o a otra franja. */
router.post('/api/itinerario/:id/mover', (req, res) => {
  const fila = mover(Number(req.params.id), {
    dia: req.body?.dia,
    franja: req.body?.franja,
  });
  if (!fila) return res.status(404).json({ error: 'Eso ya no está en el lienzo.' });

  res.json(lienzoDeViaje(fila.viaje_id, { etapaId: Number(req.body?.etapa) || null }));
});

/** Cambiar la hora o la duración de algo, sin sacarlo del día. */
router.post('/api/itinerario/:id/retocar', (req, res) => {
  const fila = retocar(Number(req.params.id), {
    hora: 'hora' in (req.body ?? {}) ? req.body.hora : undefined,
    duracionMin: 'duracionMin' in (req.body ?? {}) ? req.body.duracionMin : undefined,
  });
  if (!fila) return res.status(404).json({ error: 'Eso ya no está en el lienzo.' });

  res.json(lienzoDeViaje(fila.viaje_id, { etapaId: Number(req.body?.etapa) || null }));
});

/** Subirlo o bajarlo dentro de su franja. */
router.post('/api/itinerario/:id/mover-en-franja', (req, res) => {
  const direccion = req.body?.direccion === 'arriba' ? 'arriba' : 'abajo';
  const fila = moverEnFranja(Number(req.params.id), direccion);
  if (!fila) return res.status(404).json({ error: 'Eso ya no está en el lienzo.' });

  res.json(lienzoDeViaje(fila.viaje_id, { etapaId: Number(req.body?.etapa) || null }));
});

/** Sacarlo del lienzo. Si era un candidato, vuelve solo a la mochila. */
router.delete('/api/itinerario/:id', (req, res) => {
  const fila = quitar(Number(req.params.id));
  if (!fila) return res.status(404).json({ error: 'Eso ya no está en el lienzo.' });

  res.json(lienzoDeViaje(fila.viaje_id, { etapaId: Number(req.query.etapa) || null }));
});

/** "Pedir opinión a la IA": encola el trabajo y la pantalla sondea. */
router.post('/api/viaje/:viajeId/opinar', (req, res) => {
  const viajeId = Number(req.params.viajeId);
  if (!una('SELECT id FROM viajes WHERE id = ?', viajeId)) {
    return res.status(404).json({ error: 'Ese viaje ya no existe.' });
  }
  const trabajo = encolar(viajeId, 'opinar_lienzo');
  res.json({ pensando: true, trabajoId: trabajo.id });
});

/** Sondeo de la opinión. */
router.get('/api/viaje/:viajeId/opinion', (req, res) => {
  const viajeId = Number(req.params.viajeId);
  const viaje = una('SELECT opinion_lienzo, opinion_lienzo_en FROM viajes WHERE id = ?', viajeId);
  if (!viaje) return res.status(404).json({ error: 'Ese viaje ya no existe.' });

  const activo = trabajoActivo(viajeId, 'opinar_lienzo');
  const ultimo = ultimoTrabajo(viajeId, 'opinar_lienzo');

  res.json({
    pensando: Boolean(activo),
    opinion: viaje.opinion_lienzo,
    cuando: viaje.opinion_lienzo_en,
    mensaje_error: !activo && ultimo?.estado === 'error' ? ultimo.mensaje_error : null,
  });
});

// =============================================================================
// PORTADA: renombrar y borrar viajes
// =============================================================================

/** Qué se lleva por delante el borrado. Se pregunta ANTES de confirmar. */
router.get('/api/viajes/:id/arrastre', (req, res) => {
  const datos = loQueArrastra(Number(req.params.id));
  if (!datos) return res.status(404).json({ error: 'Ese viaje ya no existe.' });
  res.json(datos);
});

/**
 * Borra el viaje y todo lo suyo.
 *
 * El catálogo (destinos, sus sitios y sus excursiones) NO se toca: es
 * conocimiento reutilizable y borrar un viaje a Japón no puede borrar lo que
 * sabemos de Japón.
 */
router.delete('/api/viajes/:id', async (req, res) => {
  const viajeId = Number(req.params.id);
  const r = borrarViaje(viajeId);
  if (!r) return res.status(404).json({ error: 'Ese viaje ya no existe.' });

  // Las filas de `adjuntos` se van solas por la cascada; los archivos del disco
  // no tienen quien se los lleve, así que se borran aquí.
  await borrarAdjuntosDelViaje(viajeId);

  console.log(
    `[rutas] Borrado el viaje «${r.nombre}»: ` +
      Object.entries(r.arrastre).map(([k, v]) => `${v} ${k}`).join(', ') + '.'
  );
  res.json({ borrado: true, ...r });
});

/** Cambiar el nombre del viaje. */
router.post('/api/viajes/:id/nombre', (req, res) => {
  const nombre = renombrarViaje(Number(req.params.id), req.body?.nombre);
  if (!nombre) return res.status(400).json({ error: 'Ese nombre no vale.' });
  res.json({ nombre });
});

/**
 * Cuántas paradas tiene la ruta de un viaje: las confirmadas y las que todavía
 * son candidatas. Es el número del contador de "Mi ruta".
 */
function etapasEnRuta(viajeId) {
  return una('SELECT COUNT(*) AS n FROM etapas WHERE viaje_id = ?', viajeId).n;
}

/** El contador, para refrescarlo sin recargar al añadir algo a la ruta. */
router.get('/api/viajes/:id/etapas/cuenta', (req, res) => {
  const viajeId = Number(req.params.id);
  if (!una('SELECT id FROM viajes WHERE id = ?', viajeId)) {
    return res.status(404).json({ error: 'Ese viaje ya no existe.' });
  }
  res.json({ etapas: etapasEnRuta(viajeId) });
});
