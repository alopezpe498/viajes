# Repaso de la configuración del viaje

**Hecho el 18/09/2026. Solo lectura: cada variable rastreada por todo el código y
comprobado además que cada hueco `{{…}}` de cada prompt se rellena de verdad.**

> Este documento vivía en `salida.md`, que está en `.gitignore` y se sobrescribe
> con cada diagnóstico. Se guarda aquí porque son 215 líneas de rastreo que no se
> vuelven a hacer gratis, y porque explica POR QUÉ el motor es hoy como es.

---

## QUÉ PASÓ CON CADA HALLAZGO

Anotado el 18/09/2026, el mismo día. El diagnóstico se deja tal cual está más
abajo —no se reescribe la historia— y aquí se dice en qué quedó cada cosa.

| § | Hallazgo | En qué quedó |
|---|---|---|
| 1.1 | El sesgo solo actúa la primera vez que se investiga una ciudad | **ARREGLADO**, pero no como proponía el repaso. Medido: el perfil mueve la COLA de la lista, no la cabeza —tres perfiles sobre Atenas dan los mismos cuatro primeros—. Así que no hay que reordenar ni separar catálogo de viaje: hay que COMPLETAR. Una tanda por ciudad y perfil que añade lo que falta como segundo nivel. |
| 1.2 | Los niños: 0 de 11 ciudades con bloque | **ARREGLADO.** Si viajan niños y la ciudad no tiene el cajón, se pide solo ese. No se regenera nada. |
| 1.3 | `habitacionFamiliar` no se usa en ningún sitio | **ARREGLADO.** Llega a quien elige el alojamiento. NO como filtro de Booking: los códigos de ese fichero están comprobados uno a uno contra el panel real y no me invento uno. |
| 1.4 | Los intereses no llegan al lienzo | **ARREGLADO** a medias y a propósito. `{{INTERESES}}` y la regla 13 del prompt: entre dos cosas que compiten por el mismo hueco, entra la que va con el perfil. NO se tocó `importanciaDe` —a quién se expulsa en un choque— porque es el corazón del reparto y pide medirlo antes. |
| 1.5 | `tipo_viaje` solo sirve para elegir ciudades | **ABIERTO.** Es una decisión de producto: o significa lo mismo que las categorías y se unifica, o tiene que llegar a sitios y excursiones. |
| 1.6 | El ritmo no llega a las reglas fijas | **ABIERTO y dormido.** El día útil es siempre 9:00-22:00 y 13 horas para todos. Tocarlo mueve el reparto entero: esperando viajes largos, igual que la densidad. |
| 1.7 | El presupuesto no decide nada | **CERRADO: se deja de preguntar.** Campo oculto, columna intacta, las pantallas que lo enseñan lo siguen enseñando. |
| 1.8 | El nivel de precio solo mira hoteles | **DESCARTADO CON DATOS.** Un tope no habría cambiado ni un viaje: de las 121 excursiones que caben en un día la mediana son 39 € y lo elegido en cuatro viajes fue 0-76 €. Lo que sí había era el mismo plan al quíntuple (Wieliczka 76 € contra 410 € privada) y lo cubre la regla 4b del prompt. |
| 2 | `{{CALENDARIO}}` llega vacío | **ARREGLADO.** Y apareció otro que el repaso no tenía: `{{HOTEL}}` en el prompt del lienzo. |
| 3.5 | Los filtros de las pantallas manuales no se pueden pedir en automático | **ARREGLADO.** Estrellas, piscina, parking y wifi se piden ahora, y el «céntrico» dejó de ser un sí/no: el radio se elige (1 o 3 km) y el aflojado amplía desde ahí. |

**Y queda una comprobación que lo dice sola:** `tools/cobertura-de-la-configuracion.js`
sale con código 1 si algo que debería llegar deja de llegar. Es lo que evita que
esto se vuelva a torcer en silencio, que era el problema de fondo.

---


Solo lectura. Sin commits ni cambios. Cada variable rastreada por todo el código
(`services/`, `lib/`, `jobs/`, `routes/`) y comprobado además que cada hueco
`{{…}}` de cada prompt se rellena de verdad: `rellenar()` deja **vacío en
silencio** el que no recibe dato, así que que esté en el prompt no basta.

Las variables son de dos familias:

- **Las del viaje** (pantalla «Configura tu viaje»): fechas, origen, adultos,
  niños y edades, presupuesto, ritmo, tipo de viaje y revisión del reparto.
- **Las del modo automático** (`config_auto`, parcial `config-automatico.ejs`):
  alojamiento (7), vuelos (3) e intereses (2).

---

## 1. LO GORDO, POR ORDEN DE DAÑO

### 1.1 · El sesgo por intereses solo actúa la PRIMERA vez que se investiga una ciudad

`orquestador-sitios.js:235` — si la ciudad ya tiene sitios en el catálogo:
*«ya existían N sitios. No los regenero.»* Y el sesgo (`sesgoDeIntereses`,
`orquestador-sitios.js:122-128`) solo se aplica **al generar**.

El catálogo de sitios es **compartido entre viajes**. Consecuencia: el segundo
viaje a Atenas, con otros intereses, hereda la lista que se hizo con los
intereses del primero. Tus categorías y tu texto libre **no hacen nada** en
«qué ver» de una ciudad ya investigada.

Hoy hay **11 ciudades** con sitios guardados: para todas ellas, lo que marques
en «intereses» ya no cambia su lista.

### 1.2 · Con los niños pasa lo mismo, y peor

El bloque de sitios para niños solo se pide si hay edades **en el momento de
investigar la ciudad** (`descubrir.js:923`: `if (edadesNinos.length)
quiero.push('ninos')`). Si la ciudad ya se investigó sin niños, un viaje en
familia posterior **no tiene ni un sitio para niños**.

Medido: **0 de 11 ciudades** tienen bloque de niños. Un viaje familiar a
cualquiera de ellas saldría sin nada pensado para críos.

### 1.3 · «Habitación familiar» se pide y no se usa en ningún sitio

`habitacionFamiliar` se valida (`orquestador.js:232`), es **obligatoria** con más
de dos viajeros… y no aparece en ninguna otra línea del código. Ni en la
búsqueda de Booking, ni en los filtros, ni en el prompt de elegir hotel.
Contestarla no cambia nada.

### 1.4 · Los intereses no llegan al lienzo, que es donde se decide qué se ve

El prompt del lienzo no tiene `{{INTERESES}}`: sus huecos son
`CIUDAD · RITMO · VIAJEROS · FRANJAS · DURACION_COMIDA · DIAS · COLOCABLES ·
HOTEL · MAX_LARGAS`. Y cuando no cabe todo, el reparto recorta por
`importanciaDe` (`orquestador-lienzo.js:791`), que mira `bloque` y `orden` —la
jerarquía universal de la ciudad— y **nada de tu perfil**.

Así que el sesgo decide qué entra en la LISTA, pero cuando el día no da para
todo, lo que se cae se elige sin mirar lo que te interesa. Con perfil
«gastronomía», un mercado del puesto 8 se cae antes que un museo del puesto 5.

### 1.5 · El tipo de viaje solo sirve para elegir ciudades

`tipo_viaje` (cultural, gastronómico, naturaleza, relax, mixto) llega a un único
sitio: el prompt de candidatas (`orquestador-ciudades.js:2115`). No llega a qué
ver, ni a excursiones, ni al lienzo, ni al hotel.

Y ni siquiera ahí pesa en la cuenta: la rúbrica de ciudades convierte las
**categorías** en multiplicadores (`rubrica-ciudades.js:180-186`), no el tipo de
viaje. Marcar «Naturaleza» como tipo **no sube** la casilla de paisaje; marcarla
como categoría, sí. «Relax» no tiene ningún efecto medible en ninguna parte.

### 1.6 · El ritmo llega a la IA, pero no a las reglas fijas

**Sí llega** a cuatro prompts —candidatas, traslados, excursiones, lienzo— y a
una regla de código: `horaMinimaDeSalida` (`orquestador-traslados.js:777`), que
con ritmo intenso deja salir una hora antes.

**No llega** a las reglas que juzgan si el plan cabe, que son fijas:

- el día útil es siempre de 9:00 a 22:00 y 13 horas (`hora_maxima_inicio`,
  `HORAS_DEL_DIA_UTIL`);
- «holgada / ajustada / corta» y «¿caben los imprescindibles?»
  (`orquestador-paradas-cortas.js`) se calculan igual para todos.

Un viaje «tranquilo» se juzga con horas de viaje intenso: el motor puede decir
«cabe, va holgada» de un día que para ese ritmo va lleno.

### 1.7 · El presupuesto que declaras no decide nada

`viaje.presupuesto` solo se **enseña**: en la pantalla de presupuesto
(«tu presupuesto orientativo era…»), en el dosier y en el resumen antiguo. Ningún
paso lo usa para elegir: ni el nivel de hotel, ni el tope de vuelos
(`precioMaxPersona: null` en `orquestador-ciudades.js:271` y
`orquestador-traslados.js:362`), ni las excursiones. En los cinco viajes
automáticos está vacío.

### 1.8 · El nivel de precio solo mira hoteles

`nivelPrecio` (económico / medio / alto) se usa en el rango de precio del hotel
(`orquestador-dormir.js:323`) y en la estimación de gasto diario
(`presupuesto.js:465`). **No** en excursiones —se eligen sin mirar lo que
cuestan—, ni en vuelos, ni en dónde comer.

---

## 2. HALLAZGO ADYACENTE: EL CALENDARIO LLEGA VACÍO

No es una variable tuya, pero sale de tus fechas. El prompt de ciudades dice:

> - Calendario: {{CALENDARIO}}
> …Tienes el calendario arriba: úsalo, no lo calcules de memoria. Una noche extra
> vale más donde el día que ganas NO sea lunes —museos cerrados—…

`{{CALENDARIO}}` **no lo rellena nadie** (no hay ninguna clave `CALENDARIO:` en
el código). El modelo recibe «Calendario: » en blanco y una instrucción que le
pide usarlo. Los otros dos huecos sin rellenar (`PASAPORTE` en `fronteras`,
`REGISTRO` en la traducción del registro) sí se rellenan por otra vía; este no.

---

## 3. TABLA COMPLETA: VARIABLE, SE USA, DÓNDE

Leyenda: ✅ se usa y decide · 🟡 se usa a medias · ❌ no decide nada

### 3.1 · Datos del viaje (pantalla «Configura tu viaje»)

| Variable | ¿Decide? | Dónde se usa | Dónde NO llega |
|---|---|---|---|
| `fecha_inicio` / `fecha_fin` | ✅ | noches y días de todo; búsqueda de vuelos y hoteles; `{{FECHA_INICIO}}` y `{{FECHA_FIN}}` en candidatas y países | `{{CALENDARIO}}` llega vacío (§2) |
| `ciudad_origen` | ✅ | aeropuerto de salida (`proveedores.js:46`); `{{ORIGEN}}` en candidatas, países y fronteras | — |
| `adultos` | ✅ | ocupación en Kayak y Booking; `{{VIAJEROS}}` en todos los prompts | — |
| `ninos` + edades | 🟡 | ocupación en Kayak y Booking; `{{VIAJEROS}}` con edades en traslados, excursiones y lienzo; bloque niños en sitios | el bloque niños solo si la ciudad es nueva (§1.2); dormir solo dice «N niños», sin edades |
| `ritmo` | 🟡 | prompts de candidatas, traslados, excursiones, lienzo y países; `horaMinimaDeSalida` | reglas fijas del día útil y de «cabe / holgada» (§1.6) |
| `tipo_viaje` | 🟡 | solo `{{TIPO_VIAJE}}` en candidatas | sitios, excursiones, lienzo, hotel, rúbrica (§1.5) |
| `presupuesto` | ❌ | solo se enseña (pantalla de presupuesto, dosier, resumen) | ninguna decisión (§1.7) |
| `revision_reparto` | ✅ | `worker.js:1811`: si no está marcada, el motor no para a pedirte el visto bueno del reparto | (es de procedimiento, no de sesgo) |

### 3.2 · Alojamiento (modo automático)

| Variable | ¿Decide? | Dónde se usa | Notas |
|---|---|---|---|
| `nivelPrecio` | 🟡 | rango de precio por ciudad (`orquestador-dormir.js:323`); gasto diario (`presupuesto.js:465`) | no en excursiones ni vuelos (§1.8) |
| `zona` | ✅ | «céntrico» = radio de 1 km en Booking (`orquestador-dormir.js:116`); se amplía a 3 km y luego se suelta si no sale nada | «céntrico» es del centro de la ciudad, no de donde están tus sitios |
| `tipoAlojamiento` | ✅ | filtro de Booking (`:110`); `{{TIPO}}` en el prompt (`:325`); comprobación final (`:708`) | — |
| `habitacionFamiliar` | ❌ | **en ninguna parte** | obligatoria con más de 2 viajeros (§1.3) |
| `desayuno` | ✅ | filtro de Booking (`:108`) | se suelta en el último reintento, y el registro lo dice |
| `cancelacionGratis` | ✅ | filtro de Booking (`:109`) | se suelta junto al desayuno |
| `notaMinima` | ✅ | filtro de Booking (`:103`) | — |

El orden en que se sueltan los filtros cuando no sale hotel está pensado y
documentado (`orquestador-dormir.js:23` y `:356-398`): primero el precio, luego
la zona, al final desayuno y cancelación. Esto funciona bien.

### 3.3 · Vuelos (modo automático)

| Variable | ¿Decide? | Dónde se usa | Notas |
|---|---|---|---|
| `escalas` | ✅ | vuelos de entrada y salida (`orquestador-ciudades.js:267`); saltos internos en avión (`orquestador-traslados.js:362`) | se suelta en el tercer intento si no hay nada, y se dice |
| `franjaIda` | ✅ | vuelo de ida (`orquestador-ciudades.js:269`) | se suelta en el segundo intento; no aplica a los saltos internos, a propósito |
| `franjaVuelta` | ✅ | vuelo de vuelta (`:270`) | ídem; además `afinarLaVuelta` busca alternativa si la vuelta sale de madrugada |

Los vuelos son la parte mejor atada de toda la configuración.

### 3.4 · Intereses (modo automático)

| Variable | ¿Decide? | Dónde se usa | Dónde NO llega |
|---|---|---|---|
| `categorias` | 🟡 | multiplicadores de la rúbrica de ciudades (`rubrica-ciudades.js:180`); `{{CATEGORIAS}}` en sitios; `{{INTERESES}}` en candidatas y excursiones | lienzo (§1.4); ciudades ya investigadas (§1.1); hotel |
| `intereses` (texto libre) | 🟡 | se traduce a ajustes por categoría para las ciudades (`rubrica-ciudades.js:258`); va en crudo a sitios y excursiones | lienzo; ciudades ya investigadas; hotel |

**Comprobado con Túnez (103)**, donde escribiste *«Evitar visitas y excursiones
al desierto»*: el itinerario final no tiene nada del desierto, así que se
respetó. Pero el registro dice cómo se tradujo para las ciudades:
*«Tus intereses: menos "naturaleza"»*. La traducción a categorías es **gruesa**:
«nada de desierto» se convirtió en «menos naturaleza» en todo el viaje, que
también baja miradores, jardines o costa que no tenían nada que ver.

### 3.5 · Filtros de las pantallas manuales antiguas

Las pantallas de vuelos (paso 5) y hoteles (paso 6) del asistente antiguo
guardan sus propios filtros (`filtros_vuelos`, `filtros_hoteles`): precio
mínimo y máximo, estrellas, piscina, wifi, parking, distancia máxima, duración
máxima del vuelo, precio máximo por persona.

**El orquestador no lee ninguno**: usa solo `config_auto`. Hoy no hace daño
porque en los cinco viajes automáticos están todos a `null`. Pero son
preferencias que el modo automático **no sabe expresar**: no hay forma de pedir
piscina, estrellas o un tope de precio de vuelo en automático.

---

## 4. QUÉ HARÍA, POR ORDEN

Sin tocar nada: esto es solo el diagnóstico.

1. **El catálogo compartido contra el sesgo (§1.1 y §1.2).** Es lo que más
   vacía de efecto a la configuración, y va a más con cada ciudad nueva. La
   salida limpia es separar lo que es de la ciudad (la lista de sitios, que se
   comparte) de lo que es del viaje (el orden según tus intereses, que no se
   debería heredar). Y el bloque de niños debería pedirse cuando hay niños y
   no hay bloque, aunque la ciudad ya exista.
2. **Los intereses en el lienzo (§1.4).** Cuando no cabe todo, que el perfil
   pese al decidir qué se cae — sin tocar los intocables.
3. **`{{CALENDARIO}}` vacío (§2).** Es un bug de una línea con instrucción
   explícita que lo usa. Barato y claro.
4. **`habitacionFamiliar` (§1.3).** O se usa en la búsqueda de Booking, o se
   deja de preguntar. Hoy es un campo obligatorio que no hace nada.
5. **`tipo_viaje` (§1.5).** Decidir si es lo mismo que las categorías —y
   entonces unificarlo— o si significa otra cosa, y entonces que llegue a
   sitios y excursiones. Hoy son dos preguntas parecidas y solo una pesa.
6. **El ritmo en las reglas fijas (§1.6)** y **el presupuesto (§1.7)**: más
   discutibles. El ritmo ya llega a la IA; el presupuesto es un orientativo que
   quizá deba quedarse solo como aviso. Los dejaría para cuando haya datos de
   los viajes que estás generando.
