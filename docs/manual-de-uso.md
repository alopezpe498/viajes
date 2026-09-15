# Manual de uso

Cómo se usa el generador de viajes, pantalla por pantalla.

Está escrito para quien usa la web, no para quien la programa. Explica qué hace
cada cosa, cómo se usa y qué significan los estados, los colores y los avisos que
salen por pantalla.

> **Para quien mantenga este fichero:** es la base de conocimiento del asistente
> de ayuda de la aplicación. Cuando cambie una pantalla, cambia también lo que
> dice aquí de ella: el asistente solo sabe lo que está escrito en este manual, y
> tiene orden de decir «no lo sé» antes que improvisar. Un manual desactualizado
> no produce respuestas raras, produce respuestas equivocadas.

---

## 1. Las ideas básicas

Antes de nada, el vocabulario. Estas palabras salen por todas partes y todo lo
demás se entiende mucho mejor sabiéndolas.

| Palabra | Qué es |
|---|---|
| **Viaje** | Todo lo de una escapada: fechas, viajeros, ruta, itinerario y papeles. |
| **Parada** o **etapa** | Una ciudad de la ruta donde se duerme, con sus noches. |
| **Candidata** | Una ciudad que está en la lista pero todavía no forma parte de la ruta. Se confirma o se descarta. |
| **Noche** | La unidad con la que se reparte el viaje. Las noches se reparten entre paradas. |
| **Día** | Cada jornada del viaje. Salen de las fechas, no de las noches. |
| **Franja** | Cada día se divide en cuatro: Mañana, Mediodía, Tarde y Noche. |
| **Mochila** | Lo que has apuntado pero todavía no tiene día. |
| **Lienzo** | El itinerario: los días del viaje y lo que hay puesto en cada uno. |
| **Tarjeta** | Cada cosa colocada en un día: una visita, una comida, una excursión, un traslado. |
| **Tramo** | El salto entre dos paradas: el vuelo, el tren o el coche que te lleva de una ciudad a la siguiente. |
| **Traslado** | Un desplazamiento corto *dentro* de una ciudad: del hotel al museo. |
| **Dosier** | El resumen imprimible del viaje, para llevarlo encima. |
| **Orquestador** | La parte que monta el viaje entero sola, con la ayuda de la IA. |

Dos principios que explican muchas decisiones de la aplicación:

- **Lo que se puede calcular, se calcula; la IA solo opina.** Los kilómetros, las
  horas y los cuadres de fechas salen de datos reales (Google, Booking,
  Civitatis, Kayak). La IA elige entre opciones que ya son posibles, redacta y
  desempata. No inventa números.
- **Antes un hueco honesto que un dato inventado.** Si algo no se ha podido
  averiguar, la pantalla lo dice. Un campo vacío con su explicación es mejor que
  un número que parece bueno y no lo es.

---

## 2. Mis viajes (la portada)

Es la pantalla de entrada. A la izquierda, el panel con el botón **Nuevo viaje**
y el número de viajes en el cuaderno. A la derecha, tus viajes como billetes.

Cada billete enseña:

- El **talón** de la izquierda con el día y el mes de salida. Si todavía no hay
  fechas, pone `?`.
- El nombre del viaje y la ruta en una línea: `Atenas → Nafplio → Heraclión`. Si
  aún no hay ruta, pone «Sin ruta todavía».
- Unas **chapas** con el recuento:
  - `3 etapas · 8 noches` — cuántas paradas y cuántas noches repartidas.
  - **Cuadra** (en verde) — las noches repartidas coinciden con los días del viaje.
  - **Faltan N noches** / **Sobran N noches** — todavía no cuadra.

**Para abrir un viaje**, pulsa el billete.

**El menú de los tres puntos** (arriba a la derecha de cada billete) tiene:

- **Cambiar nombre.**
- **Borrar viaje…** — pide escribir el nombre del viaje para confirmar. No se
  puede deshacer, y por eso no basta con pulsar un botón rojo.

**El engranaje** junto a «Mis viajes» lleva a los **Ajustes del orquestador**
(sección 19).

---

## 3. Configurar un viaje

Se llega al crear un viaje nuevo, y después desde **Mi ruta → Más opciones →
Configuración**.

### Plantillas

Arriba del todo. Guardan tus ajustes de siempre para no volver a teclearlos.

- **Guardar esta configuración como…** — le pones un nombre y se queda.
- **Elige una plantilla** → **Cargar** — rellena la pantalla con esos ajustes.

**Una plantilla NO guarda ni el destino ni las fechas**, solo la forma de viajar:
viajeros, ritmo, tipo de viaje, presupuesto y las preferencias del viaje
automático. Es a propósito: el destino cambia en cada viaje, la manera de viajar
no.

### Fechas

Un calendario de dos meses. Se pulsa el día de ida y luego el de vuelta, y queda
marcado el rango. Los días del viaje salen de aquí, y son los que luego hay que
cubrir con noches.

### Viajeros

Dos contadores: **adultos** y **niños**. Un adulto es de 18 años en adelante; un
niño, de 0 a 17. Por cada niño se pide su edad, porque los hoteles y los vuelos
cobran distinto según la edad.

Si el viaje lleva niños, más adelante aparece una pestaña **Para niños** en los
sitios de cada ciudad.

### Tipo de viaje

Cinco opciones: **Cultural**, **Gastronómico**, **Naturaleza**, **Relax** y
**Mixto**. Orienta lo que se propone en cada ciudad.

### Ritmo

**Tranquilo**, **Normal** o **Intenso**. Decide cuántas cosas se meten en cada
día y cuánto se aprieta el itinerario.

### Ciudad de origen y presupuesto

- **Ciudad de origen** — de dónde sales. Se usa para buscar los vuelos.
- **Presupuesto orientativo** — se puede dejar en «Sin límite definido».

### Viaje automático (IA)

La sección que le dice al orquestador cómo quieres el viaje. Tiene:

- **Nivel de precio**, **Zona**, **Tipo** de alojamiento, **Habitación
  familiar**, **Desayuno incluido**, **Cancelación gratuita** y **Valoración
  mínima** — los filtros con los que se buscarán los hoteles.
- **Escalas** y **Franja horaria de la ida / de la vuelta** — para los vuelos.
- **En tus palabras** — una frase describiendo qué te interesa. Con eso y las
  categorías basta.
- **Categorías** — los tipos de sitio que te interesan.

---

## 4. ¿A dónde vas? (el destino)

Se escribe el destino en texto libre: «Grecia», «Croacia y Montenegro», «Sevilla».

La aplicación lo interpreta y decide si es:

- **una ciudad** — el viaje va ahí y ya está;
- **un país o una región** — entonces hay que elegir qué ciudades entran, y se
  abre el mapa de exploración.

Si escribes varios países, aparece la pantalla **¿Qué países entran en el
viaje?**: se marcan los que quieras y la IA opina antes de montar nada sobre si
la combinación tiene sentido con los días que hay. Solo opina; la decisión es
tuya.

Si el texto es ambiguo, lo dice en vez de elegir por su cuenta.

### El mapa de exploración

Cuando el destino es un país o una región, sale un mapa con sus ciudades. Cada
una es una tarjeta con foto, descripción y días recomendados.

- **Investigar** — lanza la investigación de esa ciudad: qué ver, cuánto tiempo
  pide, cómo se llega. Tarda cerca de un minuto y la pantalla se refresca sola
  (comprueba cada 5 segundos).
- **A mi ruta** — la mete en el viaje como candidata.
- **Se visita desde…** — algunas ciudades no son parada propia: se ven en una
  excursión de un día desde otra. Aquí se dice desde cuál.
- **Las distancias se miden desde aquí** — marca cuál es la ciudad de entrada,
  que es la referencia para medir lo lejos que queda todo lo demás.

Para volver aquí más tarde: **Mi ruta → Más opciones → Elegir más ciudades**.
Solo sale si el destino es un país o una región; en un viaje a una sola ciudad no
hay nada más que explorar.

### La ficha de una ciudad

Pulsando una ciudad se abre su ficha completa: por qué merece la pena, días
recomendados, cómo moverse por ella y los lugares que tiene dentro. Si todavía no
se ha investigado, lo dice y se puede lanzar desde ahí.

---

## 5. El orquestador: que lo monte solo

El orquestador monta el viaje entero: elige ciudades, reparte noches, busca cómo
ir de una a otra, encuentra hoteles, apunta qué ver y lo coloca todo en sus días.

Se lanza desde el viaje y va enseñando el progreso. Son **seis fases**, y se ven
en pantalla con su nombre:

| Fase | Qué hace |
|---|---|
| **1. Ciudades y noches** | Qué ciudades entran, cuántas noches en cada una y por dónde se entra y se sale. |
| **2. Traslados** | Cómo se va de cada ciudad a la siguiente. |
| **3. Dónde dormir** | Un alojamiento en cada parada, con los filtros que hayas puesto. |
| **4. Qué ver** | Los sitios de cada parada, apuntados según tus intereses. |
| **5. Excursiones** | Las excursiones que merecen la pena, repartidas sin amontonarlas. |
| **6. El lienzo** | Todo colocado en sus días, respetando horarios y días de cierre. |

Las fases 3, 4 y 5 corren a la vez para ir más rápido; las demás van en orden,
porque cada una necesita lo que decidió la anterior.

### Mientras corre

La pantalla de progreso enseña en qué fase va y qué está haciendo. Se puede:

- **Parar** — se detiene donde esté. Lo hecho hasta ese momento se queda.
- **Reanudar** — sigue por donde iba, sin repetir lo que ya estaba hecho.

### Cómo se montó este viaje

Cuando termina, en **Mi ruta → Más opciones → Cómo se montó este viaje** queda el
registro de las seis fases: qué eligió, con qué datos y de dónde salieron. Es lo
que permite revisar un viaje automático en vez de tener que fiarse.

Solo sale en los viajes que montó el orquestador. Un viaje hecho a mano no tiene
nada que contar ahí.

---

## 6. Mi ruta

El centro del viaje. Desde aquí se llega a todo.

### Los dos accesos grandes

Arriba, dos tarjetas:

- **El lienzo** — tu itinerario, día a día.
- **Mapa del viaje** — todo situado sobre el mapa.

### Antes de viajar

Un botón ancho, siempre visible, con cara de aviso. Abre un panel con una
pestaña por país del viaje y dos bloques:

- **Papeles y salud** — Documento, Visado, Vacunas y salud, Seguro de viaje.
- **Dinero y calendario** — Moneda, Dónde y cuándo cambiar, Festivos durante el
  viaje y Recomendaciones de Exteriores.

Abajo hay una casilla **Ya lo he revisado**. Al marcarla, el botón de la ruta
cambia a verde y deja de insistir. Se puede volver a mirar cuando quieras.

Está siempre a la vista a propósito: un visado o una vacuna se piden semanas
antes, y un enlace escondido en un menú se descubre el día de antes, que es
cuando ya no sirve.

### Más opciones

Un desplegable con lo demás:

- **Viaje listo** y **Dosier** (sección 17).
- **Mis reservas** — lo que ya está cerrado y lo que falta.
- **Documentos** — todos los papeles del viaje juntos.
- **Presupuesto** — lo que costaría el viaje tal y como está montado.
- **Elegir más ciudades** — vuelve al mapa de exploración.
- **Cómo se montó este viaje** — el registro del orquestador.
- **Configuración** — fechas, viajeros, ritmo.

### El contador de noches

Dice si el viaje cuadra: cuántos días tiene y cuántas noches hay repartidas. Es
el mismo número que sale en la chapa de la portada.

### Candidatos y Ruta confirmada

Dos listas.

- **Candidatos** — ciudades apuntadas que todavía no están en la ruta.
- **Ruta confirmada** — las paradas de verdad, en orden.

En cada parada de la ruta:

- **+ / −** — una noche más o una noche menos.
- **Abrir etapa** — entra en esa ciudad.
- **Volver a pasar por…** — duplica la parada, para las rutas que pasan dos veces
  por el mismo sitio.
- **Quitar de la ruta** — la saca. Pide confirmación.

Las paradas se pueden **reordenar arrastrándolas**.

### Total de traslados

Al pie: cuántos kilómetros y cuántas horas de carretera hay **dentro** del viaje.
La ida y la vuelta a casa no cuentan, porque son vuelos y sumarlos convertiría
cualquier viaje en miles de kilómetros de coche.

Si algún tramo no se ha podido calcular, lo dice: `(2 tramos sin calcular)`.

---

## 7. Una parada: la pantalla de etapa

Se abre desde **Mi ruta**. Tiene cuatro pestañas.

### Qué ver

La más grande. Dentro hay cuatro sub-pestañas:

#### Sitios

Cuatro cajones, no una lista larga:

- **Imprescindibles** — lo que no se puede dejar de ver.
- **Otros** — lo de segundo nivel.
- **Para niños** — solo si el viaje lleva niños. Sale aunque esté vacía: que no
  haya nada infantil también es una respuesta.
- **Mis búsquedas** — lo que has buscado tú (más abajo).

Cada sitio es una tarjeta con foto, nombre, categoría y descripción. Desplegándola
se ve el «por qué», cómo moverse hasta allí, los lugares que tiene dentro y el
enlace a Wikipedia si lo hay. Una ficha ampliada una vez queda ampliada para
siempre y se ve igual desde cualquier viaje.

Botones de la tarjeta:

- **Apuntar** — lo mete en la mochila del lienzo. Una tarjeta apuntada se marca.
- **Ver detalle** — abre la ficha completa.
- **Verlo en el lienzo** — si ya está colocado, lleva a su día.
- **Reserva con antelación** — aviso de los sitios que hay que sacar antes.

#### Excursiones

Las excursiones de pago, con precio, duración y valoración. Se apuntan igual que
los sitios. Se pueden pedir los **detalles** de una para ver qué incluye, dónde
es el punto de encuentro y qué política de cancelación tiene.

#### Comer

Restaurantes de la ciudad. Se pueden buscar, añadir a mano y pedir sus detalles.

#### Moverse

El transporte urbano de la ciudad: metro, bus, taxi, apps, tarjetas turísticas.
Es una chuleta, no una búsqueda: se apunta lo que sirva.

### Mis búsquedas

Dentro de «Sitios». La pestaña que llenas tú; las otras tres las llena la
aplicación.

Se escribe lo que sea en el campo: **un sitio** («la casa de Gaudí») o **un
tema** («búnkers», «miradores»).

- Si pides **un sitio**, se busca y aparece su ficha.
- Si pides **un tema**, la IA propone hasta seis nombres y **se para ahí**, con
  casillas para que elijas cuáles quieres. Solo se generan las fichas que marques.
  Es deliberado: generar seis fichas que nadie ha pedido es gastar seis búsquedas
  para nada.

Las búsquedas de otros viajes a la misma ciudad aparecen aparte, marcadas como
heredadas: el catálogo de una ciudad es de la casa, no de un viaje.

### Dónde dormir

Los hoteles buscados para esa parada, con sus filtros (precio, zona, tipo,
valoración, desayuno, cancelación). Se puede **cambiar los filtros** y volver a
buscar, y **elegir** uno. El elegido pasa a ser el alojamiento de la parada y
aparece en el mapa y en el dosier.

### Cómo llegar

El tramo que trae a esta ciudad: qué medios hay, cuánto tardan y cuánto cuestan.
Se puede buscar vuelos, meter un transporte a mano, o marcar uno como el elegido.

Los precios no se preguntan a la IA: se buscan de verdad, porque de memoria salen
inventados.

### Mapa

Lleva al mapa del viaje ya filtrado por esta ciudad.

---

## 8. Traslados y distancias

Dentro de una parada, la sección **Traslados**: la chuleta de «cuánto hay de aquí
a allá» dentro de la ciudad.

Se elige **Desde** y **Hasta** —el hotel, un sitio apuntado, o una dirección
escrita a mano— y se consulta. La respuesta da el tiempo en los tres modos:

| Modo | Icono |
|---|---|
| **andando** | 🚶 |
| **coche** | 🚗 |
| **público** | 🚌 |

Lo consultado **se queda apuntado**. Hay dos listas:

- **Fijadas** — arriba, las que quieres tener a mano. Se fija con el botón del
  alfiler.
- **Historial** — abajo, plegado, todo lo demás. No se borra nada: una consulta
  hecha puede volver a hacer falta y ya está pagada.

Desde un traslado se puede **mandarlo al lienzo**, y queda como una tarjeta en el
día que digas.

Las respuestas se guardan, así que consultar dos veces lo mismo es instantáneo y
no vuelve a preguntar a Google. Lo que se mide andando y en coche no caduca; lo
del transporte público sí, porque los horarios cambian.

---

## 9. El lienzo

El itinerario. Una columna por día, y dentro de cada día las cuatro franjas.

### Las franjas

| Franja | Horas |
|---|---|
| **Mañana** | hasta las 13h |
| **Mediodía** | de 13 a 16h |
| **Tarde** | de 16 a 20h |
| **Noche** | desde las 20h |

### La mochila

A la izquierda: lo que has apuntado y todavía no tiene día. Está agrupado por
ciudad y se puede filtrar por tipo (Sitios, Excursiones, Comidas…).

Cuando está vacía dice «Nada aquí: todo repartido».

Si sale **«Se movieron tus fechas: N cosas por recolocar»**, es que cambiaste las
fechas o el reparto de noches y hay cosas que se han quedado en un día que ya no
es de su ciudad. Vuelven a la mochila para que las coloques otra vez.

### Colocar cosas

- **Arrastrando** desde la mochila a la franja de un día. Y de vuelta a la
  mochila arrastrándolas ahí.
- **El botón +** de cada franja, para añadir algo a mano.
- **La rayita entre dos tarjetas** (aparece al pasar el ratón) abre un menú para
  calcular el traslado entre lo de antes y lo de después.

### Las tarjetas

Cada tarjeta tiene su icono según lo que sea: 📍 sitio, 🎟 excursión, 🍴 comida,
✏️ algo puesto a mano, y los traslados enseñan **su medio** (a pie, coche,
autobús, metro, taxi…), que de un vistazo dice más que una flecha.

En la tarjeta se puede:

- **Poner hora y duración** — las casillas del reloj. Las tarjetas con hora se
  ordenan solas por ella.
- **Subir y bajar** con las flechas — solo en las que **no** tienen hora; las que
  la tienen ya están ordenadas por el reloj.
- **Quitar** con la ✕ — vuelve a la mochila. Si la pusiste a mano, se borra.

Debajo del nombre sale la duración que trae el catálogo («2 horas») y el precio,
cuando los hay.

### Los colores

La **chapa de ciudad** de cada día tiene un color, y cada parada del viaje tiene
el suyo. Sirve para ver de un vistazo dónde estás cada día: cuando el color
cambia, has cambiado de ciudad.

Una tarjeta marcada en **rojo** está señalada por un aviso: hay un conflicto con
otra o con el horario del día.

El aviso de «no llegas» se pinta en **ámbar dentro de la propia tarjeta**, no en
rojo, y a propósito: el lienzo avisa, no prohíbe. A lo mejor ese trayecto lo
haces en taxi, o da igual llegar tarde a eso.

### Los avisos

Los avisos del día entero salen arriba de la columna; los de una tarjeta concreta,
dentro de ella.

| Aviso | Qué te está diciendo |
|---|---|
| **Llegas a las HH:MM — tienes N cosas antes de llegar** | Hay plan puesto a una hora en la que todavía estás de camino. |
| **Te vas a las HH:MM — tienes N cosas después de irte** | Hay plan puesto después de tu salida. |
| **Sales del aeropuerto a las HH:MM — X no cabe hasta las HH:MM** | Acabas de aterrizar; eso no da tiempo. |
| **El viaje ocupa de HH:MM a HH:MM — tienes N cosas puestas** | Hay plan puesto justo en el tramo entre ciudades. |
| **El viaje de vuelta sale a las HH:MM…** | Hay algo que pisa la salida. |
| **Se llega a las HH:MM y hay algo puesto…** | Hay algo que pisa la llegada. |
| **A partir de las HH:MM ya no se empieza nada** | Algo puesto demasiado tarde para empezarlo. |
| **X empieza a las HH:MM (Tarde)** | La hora que has puesto no pega con la franja donde está la tarjeta. |
| **X está puesto a las HH:MM y dura N min…** | No cabe en el horario de apertura del sitio. |
| **X cierra los lunes y lo has puesto en…** | El sitio cierra ese día de la semana. |
| **X tiene horarios distintos por temporada…** | No se ha podido saber cuál toca en tu fecha; se ha supuesto el más amplio. **Compruébalo.** |
| **X: no he podido leer su horario con seguridad…** | Igual, pero sin poder suponer nada. **Compruébalo antes de ir.** |
| **Sales de X a las HH:MM y el trayecto son N min…** | No llegas a lo siguiente. Es el aviso ámbar de dentro de la tarjeta. |
| **Este día tiene plan pero no tiene dónde comer** | Falta la comida. |
| *Solape* | Dos cosas a la misma hora. |

Los avisos de horario dicen siempre **qué dice el horario del sitio**, entre
comillas, para que puedas juzgar tú.

### Filtrar por ciudad

Arriba: **Todo el viaje** o una parada concreta. Filtra los días que se ven.

### El botón «Mapa del viaje»

Lleva al mapa con la ciudad que estés mirando ya seleccionada.

---

## 10. El mapa del viaje

Ocupa la pantalla entera y todo lo demás flota encima. No lleva la barra de
navegación de arriba a propósito: una barra sobre un mapa se come justo lo que
has venido a ver. Para volver, la flecha de la tarjeta del título.

### Las cuatro vistas

| Vista | Qué enseña |
|---|---|
| **Día** | Un día concreto: sus sitios, comidas, excursiones y hotel, más el recorrido. |
| **Etapa** | Una ciudad entera, con el orden de visita. |
| **Ruta** | El viaje de ciudad a ciudad, con las líneas de traslado. |
| **Ruta expandida** | Las dos cosas: las ciudades y todo lo que hay dentro de cada una. |

### Las capas

Los interruptores del panel. Cada vista tiene las suyas, porque un control que no
hace nada enseña a desconfiar de los que sí.

| Capa | Qué pinta |
|---|---|
| **Sitios** | Los sitios apuntados (verde). |
| **Comidas** | Los restaurantes (teja). |
| **Excursiones** | Las excursiones (ocre). |
| **Hoteles** | El alojamiento (azul). |
| **Recorrido del día** | La línea que une lo del día en orden. |
| **Ver tiempos** | Cuánto se tarda entre cada dos paradas del recorrido. |
| **Orden de visita** | Numera los puntos de la etapa. |
| **Líneas de traslado** | Los saltos entre ciudades. |
| **Tiempo y precio** | Las etiquetas de cada salto. |

**«Ver tiempos» empieza apagada**, porque pregunta de verdad y cuesta: se
enciende cuando hace falta. Al encenderla, cada tramo del día enseña el tiempo y
el medio (a pie, coche o público) más razonable para esa distancia.

### Medir dos puntos

El botón **Medir**, abajo. Se pulsa, y los dos clics siguientes sobre el mapa
dicen de dónde a dónde. El resultado sale ahí mismo, junto al botón, sin apartar
la vista de lo que acabas de señalar.

Qué pasa con lo medido:

- Si los **dos puntos son de la misma parada**, se guarda también en la lista de
  traslados de esa parada, en el historial.
- Si son de **ciudades distintas**, el resultado sale en pantalla y se queda
  guardado para no volver a preguntarlo, pero no se apunta en ningún sitio: no
  tiene dueño.

### El panel

Se pliega con la ✕ y se vuelve a abrir con el botón de la esquina. Dentro está el
selector de día o de etapa, las capas y la lista de lo que hay en el mapa.

Si algo no se ha podido situar, se dice: la pantalla cuenta cuántos hay **sin
ubicar** en vez de pintarlos en cualquier parte.

---

## 11. Documentos del viaje

**Mi ruta → Más opciones → Documentos.** Reúne todos los papeles del viaje en una
pantalla.

Dos columnas: a la izquierda la lista agrupada por tipo (vuelos, hoteles,
excursiones…), con el nombre del archivo y debajo de quién es; a la derecha, el
documento grande.

Se ven PDF, imágenes, textos y correos electrónicos guardados (`.eml`), que se
muestran ya legibles, con su asunto, remitente y cuerpo.

**Aquí no se sube nada.** Cada papel se sube en su sitio: el billete en su tramo,
la confirmación en el hotel de su parada, el bono en su excursión. Esta pantalla
solo los reúne, que es la pregunta del día antes de salir.

---

## 12. Mis reservas

**Mi ruta → Más opciones → Mis reservas.** Lo que ya está cerrado y lo que falta
por cerrar, ordenado por fecha.

Está en el viaje y no dentro de una parada porque una reserva es del viaje: el
vuelo no es de ninguna ciudad, y lo que importa es el orden de las fechas, no el
de las ciudades.

Cada reserva guarda su localizador, su importe y sus adjuntos.

---

## 13. Presupuesto

**Mi ruta → Más opciones → Presupuesto.** Lo que costaría el viaje tal y como está
montado ahora.

Enseña:

- **Total del viaje** y **Coste por persona.**
- **Por persona y día.**
- **Lo planificado**, desglosado: vuelos, alojamiento, traslados, excursiones.

Los importes se pueden corregir a mano cuando sepas el real, y se puede
**recalcular** para volver a partir de lo que dicen las búsquedas.

Es orientativo, y lo dice: está para saber si sale a cuenta antes de reservar.

---

## 14. Viaje listo y el dosier

En la cabecera de **Mi ruta** y del **lienzo**, en una línea:

- **El interruptor «Viaje listo»** — lo marcas tú. El dosier solo se genera
  cuando dices que el viaje está listo.
- **Un ⚠** que solo aparece si falta algo: tramos de transporte sin resolver, o
  paradas sin hotel. **Informa, nunca impide** marcar el viaje listo.
- **El botón Dosier**, con un puntito si se ha quedado viejo porque has cambiado
  algo después de generarlo.

En el menú del dosier: **Ver**, **Descargar**, **Compartir** y **Regenerar**.

El dosier es el resumen del viaje para llevarlo encima: la ruta, los días, los
alojamientos, los tramos y los papeles.

---

## 15. Cuando algo está trabajando

Varias cosas de la aplicación no son instantáneas: investigar una ciudad, buscar
hoteles o vuelos, ampliar una ficha, montar un viaje entero.

Cuando algo está en marcha, la pantalla lo dice y **se refresca sola** (suele
comprobar cada 5 segundos). No hace falta recargar ni quedarse mirando: se puede
seguir en otra pestaña.

Estados que verás:

| Estado | Significa |
|---|---|
| **Comprobando cada 5 segundos…** | Hay trabajo en marcha; la pantalla se actualizará sola. |
| **Completando la ficha…** | Se está ampliando la información de un sitio. Se recarga sola cuando esté. |
| **Todavía no se ha investigado** | Nadie ha pedido aún esa información. Hay un botón para lanzarla. |
| **No se pudo investigar** | Falló. Normalmente porque falta la clave de la IA o porque el servicio no contestó. Se puede reintentar. |
| **No he podido situarlo** | No se han podido conseguir las coordenadas de esa dirección. El sitio se queda sin punto en el mapa y se puede escribir la dirección a mano. |
| **Sin calcular** | Un tramo cuyos kilómetros u horas no se han podido averiguar. Se cuenta aparte en vez de sumarse como cero. |

Cuando algo falla, la aplicación distingue dos cosas y lo dice: **«no existe»**
(se arregla escribiéndolo mejor) y **«no he podido preguntar»** (no se arregla
tocando nada, es una avería). No hay respaldos silenciosos: si un servicio está
caído, se dice, en vez de rellenar el hueco con algo peor sin avisar.

---

## 16. Ajustes del orquestador

Se llega desde el **engranaje** de la portada.

Una sección por fase, en el orden en que se ejecutan, más una sección
**General** delante con lo que usan varias fases a la vez.

Dentro de cada sección:

- **Los números que ajustan esa fase** — cuántas noches mínimas por parada,
  cuánto se considera un madrugón, cuánto dura una comida… Cada uno enseña su
  valor **De fábrica** y se puede **restaurar**.
- **El prompt de la fase** — lo que se le pide exactamente a la IA en ese paso.
  Se puede editar y restaurar.

También hay **prompts que no son una fase** pero que deciden igual, y que antes
vivían escondidos en el código:

- **Vuelos · la vuelta de madrugada** — si compensa una escala cuando el único
  directo sale de madrugada.
- **Traslados · qué medios hay** — qué transporte existe entre dos ciudades. Los
  precios **no** se preguntan aquí: se buscan aparte.
- **Países · leer el destino escrito** — traduce «Croacia y Montenegro» a una
  lista de países. Solo lee, no opina.
- **Países · qué combinación tiene sentido** — con más de un país, opina sobre la
  combinación antes de montar nada.
- **Países · cruces de frontera** — qué pide cada paso de frontera, una vez
  decidida la ruta.

---

## 17. Ajustes de instalación (las claves)

La pantalla donde viven las claves de los servicios que usa la aplicación. Son
**globales de la instalación**, no de un viaje ni de un usuario.

| Ajuste | Para qué |
|---|---|
| **Clave de la API de Anthropic** | La que paga las llamadas a la IA. Sin ella el orquestador no monta viajes y las pantallas que preguntan a la IA quedan apagadas. |
| **Clave de Google Maps (servidor)** | Situar los sitios y medir los traslados. La usa el servidor, así que conviene restringirla por IP. |
| **Clave de Google Maps (navegador)** | Las teselas del mapa. Ésta **viaja al navegador** y se ve en el código de la página: hay que restringirla por dominio. |
| **Modelo «criterio»** | El que decide: ruta, excursiones y reparto de días. El bueno y el caro. |
| **Modelo «rápido»** | El de las tareas mecánicas: listar sitios, elegir hotel entre los buscados. |
| **Ruta a Chrome** | Dónde está el navegador que usan las búsquedas. Vacío = se busca solo. |

Cada clave enseña su origen: **Guardado aquí**, **De fábrica** o **Sin
configurar**. Las claves secretas nunca se vuelven a enseñar enteras: solo una
pista de los últimos caracteres, para reconocer cuál está puesta.

**El botón Probar** hace una llamada de verdad al servicio y dice si la clave
funciona, no si tiene buena pinta.

> Esta pantalla enseña y guarda credenciales de pago. El sitio debe estar
> protegido con contraseña antes de usarla.

---

## 18. Preguntas rápidas

**¿Cómo cambio una noche de ciudad?**
En **Mi ruta**, en la tarjeta de esa parada, los botones **+** y **−**. El
contador de noches de arriba te dice al momento si el viaje sigue cuadrando.

**¿Qué significa el rojo en una tarjeta del lienzo?**
Que hay un aviso que la señala: choca con otra tarjeta, con el horario del sitio
o con la hora de llegada o salida del día. El texto del aviso está arriba de la
columna del día, o dentro de la propia tarjeta si es de «no llegas» (ése va en
ámbar).

**¿Cómo mido la distancia entre dos puntos?**
En el **Mapa del viaje**, el botón **Medir**: se pulsa y luego se hace clic en
los dos puntos. Si los dos son de la misma ciudad, la medición se guarda además
en los traslados de esa parada.

**¿Por qué no me cuadran las noches?**
Los días salen de las fechas y las noches las repartes tú entre las paradas. Si
sobran o faltan, la chapa de la portada y el contador de **Mi ruta** lo dicen con
el número exacto. Se arregla añadiendo o quitando noches, o cambiando las fechas
en **Configuración**.

**¿Dónde subo el billete de avión?**
En su tramo, dentro de **Cómo llegar** de la parada correspondiente. Luego
aparecerá, junto a todos los demás, en **Documentos**.

**¿Por qué hay un sitio sin punto en el mapa?**
Porque no se ha podido averiguar su dirección exacta. La aplicación prefiere
dejarlo sin situar antes que ponerlo en el centro de la ciudad, que parecería
correcto y no lo sería. Se puede escribir la dirección a mano.

**¿Puedo deshacer el borrado de un viaje?**
No. Por eso el borrado pide escribir el nombre del viaje para confirmar.
