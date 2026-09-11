/**
 * services/paralelo.js
 * -----------------------------------------------------------------------------
 * HACER VARIAS COSAS A LA VEZ SIN QUE UNA TUMBE A LAS DEMÁS.
 *
 * Lo usa el orquestador para las paradas de una fase y para las puertas de la
 * fase 1: cosas que no dependen unas de otras y que hasta ahora iban en fila
 * solo porque un `for` es lo más fácil de escribir.
 *
 * DOS REGLAS, Y LAS DOS VIENEN DEL ENCARGO:
 *
 *   1. CON LÍMITE. No se lanzan veinte llamadas de golpe: se mantienen N en el
 *      aire y en cuanto una acaba entra la siguiente. Sin límite, una ruta de
 *      ocho ciudades abriría ocho conversaciones a la vez y la API empezaría a
 *      devolver 429, que es más lento que haberlas hecho en fila.
 *
 *   2. UN FALLO NO PARA EL RESTO. `Promise.all` cancela todo en cuanto una
 *      promesa se rompe, y eso convertiría un error en Nafplio en un viaje sin
 *      Atenas ni Delfos. Aquí cada tarea devuelve su resultado O su error, y
 *      quien llama decide. Es la misma regla que ya rige entre fases: una que
 *      falla deja su hueco escrito y se sigue.
 */

/**
 * Corre `tarea` sobre cada elemento con como mucho `limite` a la vez.
 *
 * Devuelve un array del mismo tamaño y EN EL MISMO ORDEN que la entrada, con
 * `{ valor }` o `{ error }` en cada hueco. El orden importa: el registro se lee
 * después y una lista de ciudades desordenada según quién acabó antes es
 * ilegible.
 */
export async function enParalelo(elementos, limite, tarea) {
  const lista = [...elementos];
  const salida = new Array(lista.length);
  const tope = Math.max(1, Math.min(Number(limite) || 1, lista.length || 1));

  let siguiente = 0;

  const obrero = async () => {
    for (;;) {
      const i = siguiente;
      siguiente += 1;
      if (i >= lista.length) return;

      try {
        salida[i] = { valor: await tarea(lista[i], i) };
      } catch (error) {
        salida[i] = { error };
      }
    }
  };

  await Promise.all(Array.from({ length: tope }, obrero));
  return salida;
}

/**
 * LAS PARADAS DE UNA FASE, EN PARALELO Y CADA UNA EN SU CONTEXTO.
 *
 * Tres cosas que hay que hacer bien y que si se dejan a cada fase se harán de
 * tres maneras distintas:
 *
 *   1. CADA PARADA EN SU PROPIO CONTEXTO. `enFase` abre uno nuevo por parada, y
 *      eso es lo que permite que el cronómetro sepa que esta llamada de IA es de
 *      Atenas y aquella de Nafplio aunque estén en el aire a la vez. Con un
 *      contexto compartido, la última en escribir se lo quedaría todo.
 *
 *   2. EL PUNTO DE PARADA SE MIRA ANTES DE CADA UNA. Con un `for` bastaba un
 *      `break`; aquí no hay bucle del que salir, así que en cuanto alguien pide
 *      parar, las que no han empezado no empiezan. Las que ya estaban en el aire
 *      terminan: cortarlas a medias es tirar trabajo bueno.
 *
 *   3. UN FALLO NO SE LLEVA A LAS DEMÁS. Igual que entre fases.
 */
export async function porParada(
  etapas,
  { limite, nombreDe, hayQueParar = () => false, enFase, enParada, di },
  tarea
) {
  let parado = false;

  const resultados = await enParalelo(etapas, limite, (etapa) => {
    const nombre = nombreDe(etapa);
    if (parado) return { saltada: true, nombre };

    if (hayQueParar(nombre)) {
      parado = true;
      di?.(`Parada pedida: no empiezo ${nombre}.`);
      return { saltada: true, nombre };
    }

    return enFase(async () => {
      enParada(nombre);
      try {
        return await tarea(etapa, nombre);
      } finally {
        enParada(nombre); // cierra el reloj de esta parada
      }
    });
  });

  return { resultados, parado };
}

/**
 * UN SEMÁFORO DE N PLAZAS, que se coge y se suelta a mano.
 *
 * El `cerrojo` de arriba envuelve una función y la suelta al terminar, y para el
 * navegador ESO NO VALE: envolvía solo el arranque de Chrome, así que se soltaba
 * en cuanto la ventana abría y la sesión seguía viva sin protección. El segundo
 * scraping arrancaba otro Chrome sobre el mismo perfil y salía «profile is
 * already in use». La plaza hay que tenerla de abrir a cerrar, y eso obliga a
 * cogerla en un sitio y soltarla en otro.
 *
 * `coger()` devuelve la plaza que te ha tocado y cómo soltarla. El número de
 * plazas se lee en cada petición, así que cambiarlo en la pantalla no obliga a
 * reiniciar.
 */
export function semaforo(cuantas) {
  let dentro = 0;
  const esperando = [];
  const libres = new Set();

  const plazasAhora = () => Math.max(1, Number(typeof cuantas === 'function' ? cuantas() : cuantas) || 1);

  const siguiente = () => {
    if (!esperando.length || dentro >= plazasAhora()) return;
    const quien = esperando.shift();
    dentro += 1;
    const plaza = [...libres][0] ?? dentro - 1;
    libres.delete(plaza);
    quien({ plaza, soltar: () => soltar(plaza) });
  };

  const soltar = (plaza) => {
    if (libres.has(plaza)) return; // soltar dos veces no suma una plaza de más
    libres.add(plaza);
    dentro = Math.max(0, dentro - 1);
    siguiente();
  };

  return {
    coger() {
      return new Promise((listo) => {
        esperando.push(listo);
        siguiente();
      });
    },
    /** Cuántos hay dentro ahora. Solo para el registro y las pruebas. */
    ocupadas: () => dentro,
  };
}
