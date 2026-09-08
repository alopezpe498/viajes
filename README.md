# CreadorViajes

Generador de viajes personal. Dos mitades:

1. **Los scrapers** (`providers/`), que ya funcionan contra las webs reales.
2. **La aplicación web** (`app.js` + wizard de 7 pasos), que de momento va con
   **datos falsos**. Los scrapers todavía **no están conectados** a la app.

---

## Arrancar

```bash
npm install
npm start
```

→ http://localhost:3000

La primera vez crea la base de datos (`db/viajes.db`) y siembra un viaje de
ejemplo a París. Si borras ese fichero, se vuelve a sembrar solo.

**Si el puerto 3000 está ocupado** (te lo dirá con un mensaje claro), arranca en
otro:

```powershell
$env:PORT=3100; npm start      # PowerShell
```

```bash
PORT=3100 npm start            # bash
```

La BD usa el módulo `node:sqlite` que trae Node 24 de serie: cero dependencias
nativas, nada que compilar. Va marcado como experimental, por eso `npm start`
silencia ese aviso concreto.

### Los scrapers, por separado

```bash
node test-vueling.js BCN OVD 2026-09-07 2026-09-10
node test-civitatis.js berlin 20
node test-booking.js "Paris" 2026-09-14 2026-09-17 2 15
```

---

## Estructura

```
app.js                  Servidor Express y arranque
routes/viajes.js        Todas las rutas del wizard
db/index.js             Esquema SQLite y migraciones
db/seed.js              DATOS FALSOS de ejemplo
services/proveedores.js EL ENCHUFE: la única puerta por la que se piden datos
services/catalogo.js    El CATÁLOGO: lo que se sabe del mundo, sin viaje detrás
services/etapas.js      Las paradas de la ruta y sus fechas derivadas
services/avisos.js      Clima, seguridad y festivos del destino
services/geocodificar.js Proxy a Nominatim, con turno y caché
services/ruta.js        Las paradas del viaje: orden, fechas y tramos
services/etapa.js       El subproyecto de una parada
services/distancias.js  OSRM y Haversine para los tramos
services/lienzo.js      Los días del viaje y lo que hay puesto en cada uno
services/portada.js     Los billetes de la home y el borrado en cascada
services/descubrir.js   Investigar un destino: IA + Wikipedia
services/movilidad.js   Cómo se va de una ciudad a otra y cómo se mueve uno dentro
services/direcciones.js Dónde está cada cosa: dirección editable + coordenadas internas
services/traslados.js   "¿Cuánto hay de aquí a allá?": Google Routes, OSRM de respaldo
services/comer.js       Bares y restaurantes: Google Places, IA con web de respaldo
lib/google.js           La única puerta a Google Maps (Geocoding y Routes)
services/adjuntos.js    Los papeles del viaje: billetes, bonos y confirmaciones
services/dosier.js      El dosier: HTML autocontenido y ZIP con los adjuntos
lib/ia.js               La única puerta a la API de Anthropic
public/js/descubrir.js  Mapa (Leaflet) y carrusel de la pantalla de descubrir
public/js/sitio.js      Pestañas y sondeo de la ficha profunda
public/js/elegir-destino.js  El mapamundi y su tarjeta deslizante
public/js/ruta.js       Mi ruta: repintado, arrastre y modal
public/js/etapa.js      La etapa: pestañas, apuntar, notas y tramos
public/js/lienzo.js     El lienzo: mochila, días y arrastre
public/js/home.js       La portada: menú, renombrar y borrar
.env.ejemplo            Plantilla: cópiala a .env y pon tu clave
public/manifest.webmanifest  Manifest de la PWA (instalable)
public/sw.js            Service worker: red primero, cachea solo estáticos
public/js/pwa.js        Registra el service worker
tools/generar-iconos.js Dibuja los iconos PNG sin dependencias
jobs/cola.js            Cola de trabajos (tabla SQLite)
jobs/worker.js          Ejecuta los trabajos de uno en uno, dentro de Express
views/                  Plantillas EJS (una por pantalla + parciales)
public/css/estilo.css   Hoja única, mobile-first
public/js/app.js        JS del navegador (marcado, chips, filtros)

providers/              Scrapers reales
lib/browser.js          Playwright con perfil persistente
lib/iata.js             Ciudad -> código IATA de CIUDAD (PAR, LON, ROM...)
test-*.js               Pruebas de los scrapers por línea de comandos
```

---

## Qué es falso y qué es real en esta fase

| | Estado |
|---|---|
| Wizard completo, 7 pasos navegables | **Real**, funciona |
| Guardado en SQLite y retomar por `paso_actual` | **Real** |
| Viajeros (adultos, niños con edades) y ritmo | **Real**, en la pantalla 1 |
| Marcar/desmarcar candidatos | **Real** (escribe en BD) |
| **Actividades del catálogo** | **REALES**, de Civitatis vía cola de trabajos |
| **Hoteles** | **REALES**, de Booking vía cola, con filtros de búsqueda |
| **Vuelos** | **REALES**, de Kayak vía cola de trabajos |
| **Avisos del destino** | **REALES**: clima, seguridad y festivos vía cola |
| "Ayúdame a elegir" (rama IA) | **Maqueta**: los desplegables no hacen nada |
| Reparto por días del itinerario | **No implementado** (placeholder) |
| "Generar dossier" | **No implementado** (botón desactivado) |
| Scraper `providers/civitatis.js` | **Real y CONECTADO** al catálogo |
| Scraper `providers/booking.js` | **Real y CONECTADO** a la pantalla de hoteles |
| Scraper `providers/kayak.js` | **Real y CONECTADO** a la pantalla de vuelos |
| `providers/vueling.js` | **Real**, guardado como reserva. Sin conectar a propósito |
| `services/avisos.js` | **Real y CONECTADO** a la pantalla 3. Sin navegador |
| Pantalla **Descubrir destino** | **REAL**: IA + Wikipedia + mapa de OpenStreetMap |
| **Ficha profunda** de una ciudad o sitio | **REAL**: IA + Wikipedia + excursiones de Civitatis desde el catálogo |
| **Pantalla de etapa** | **REAL**: catálogo, Booking y Kayak conectados a la parada |
| **El lienzo** | **REAL**: reparto por días, con avisos de incoherencia |
| Opinión de la IA sobre el lienzo | **Cascarón**: botón, cola y hueco listos; el contenido llega después |

Los datos falsos están calcados en forma y rangos de lo que devuelven los
providers de verdad (misma escala de valoración sobre 10, precios de hotel como
total de la estancia, etc.) para que al conectarlos no haya que tocar plantillas
ni consultas.

---

## El enchufe para conectar los scrapers

`services/proveedores.js` expone `obtenerActividades(viaje)`,
`obtenerVuelos(viaje)`, `obtenerHoteles(viaje)` y `obtenerAvisos(viaje)`.

**Los cuatro están conectados.** Todos siguen el mismo patrón: si el viaje no
tiene datos guardados, se encola un trabajo y se devuelve estado `buscando`; el
worker lo ejecuta y la pantalla se refresca sola por sondeo.

La única diferencia está en **quién** encola:

- **Actividades y avisos** se encolan solos al entrar en la pantalla: no hay
  nada que configurar antes.
- **Vuelos y hoteles** no, porque antes quieres tocar sus filtros. Ahí la
  búsqueda la lanzas tú con un botón.

### La cola

| | |
|---|---|
| Tabla | `trabajos` (id, viaje_id, tipo, estado, mensaje_error, creado_en, terminado_en) |
| Tipos | `actividades` (Civitatis) · `vuelos` (Kayak) · `hoteles` (Booking) · `avisos` · `descubrir_destino` · `investigar_ciudad` |
| `referencia_id` | De qué va el trabajo cuando no basta el viaje: el id del destino o del punto de interés |
| Estados | `pendiente` → `en_curso` → `hecho` / `error` |
| Worker | `jobs/worker.js`, dentro del proceso de Express, uno a la vez |
| Al arrancar | los `en_curso` colgados pasan a `error` ("interrumpido por reinicio") |

Nunca corren dos scrapers a la vez: comparten el perfil de Chrome de
`browser-profile/` y se pelearían por él. **Por lo mismo, no lances
`node test-civitatis.js` mientras el servidor esté trabajando.**

**Si levantas dos servidores contra la misma base de datos, solo uno procesa
la cola.** El segundo lo detecta por un latido (tabla `worker_latido`), lo
avisa por consola y no arranca su bucle; puedes navegar con él igualmente,
porque las búsquedas las hará el otro. Si el primero muere, espera 30 s y
reinicia el segundo para que tome el relevo.

Esto no es una manía: los dos workers compartían el perfil de Chrome de
`browser-profile/`. Cuando ambos cogían el mismo trabajo, uno abría el
navegador y el otro se quedaba esperando el candado del perfil **para siempre**,
sin volver a coger ni un trabajo más. El síntoma era una pantalla eternamente
en "Buscando…" sin que se abriera Chrome. Además del latido, el reclamo del
trabajo ahora es atómico (`reclamar()` en `jobs/cola.js`) y abrir el navegador
tiene un tope de 45 s.

**La regla que hace posible ese cambio sin tocar nada más:** ninguna ruta ni
plantilla lee datos falsos directamente; todas pasan por ese servicio. Por eso
las funciones ya reciben el `viaje` entero (con destino y fechas), que es justo
lo que necesitan los providers.

---

## Filtros de hoteles

La pantalla 6 tiene un panel plegable "Filtros de búsqueda", en tres bloques:

| Bloque | Filtros |
|---|---|
| Precio y calidad | precio/noche, nota mínima (7+/8+/9+), estrellas (3+/4+/5) |
| Comodidades | piscina, wifi, parking, desayuno |
| Condiciones | cancelación gratis, tipo (hotel/apartamento), distancia al centro |

Se guardan por viaje en `viajes.filtros_hoteles` (JSON). Todos se aplican **en
la propia búsqueda de Booking**, con el parámetro `nflt` de su URL: los
resultados ya llegan filtrados.

**Salvo la distancia al centro**, que es un filtro LOCAL: se aplica sobre los
resultados ya leídos (campo `distanciaCentro`), así que se nota al momento sin
volver a scrapear. En el panel va marcado con "se aplica al momento". Los
hoteles sin dato de distancia no se descartan.

Los códigos de `nflt` están documentados y verificados uno a uno en la cabecera
de `providers/booking.js`. Los saqué del atributo `data-filters-item` de su
propio panel de filtros y luego comprobé que la URL construida a mano deja las
casillas marcadas y cambia el número de resultados.

**Booking no ofrece filtro de aire acondicionado ni de calefacción.** Lo
comprobé desplegando la lista entera en dos destinos (Lisboa en octubre y
Sevilla en agosto): hay 14 `hotelfacility` y 25 `roomfacility`, y ninguno es
eso. Por eso no están en el panel.

---

## Filtros de vuelos

La pantalla 5 tiene su propio panel plegable, con la misma regla que hoteles:
se guardan en `viajes.filtros_vuelos` (JSON) y hay un botón explícito.

**Los vuelos NO se buscan solos al entrar en la pantalla.** Kayak abre un
Chrome y tarda; que eso pase solo por pasar por la pantalla es agresivo y
además te impide elegir filtros antes de gastar la búsqueda. La primera vez
verás el panel abierto y un botón *Buscar con estos filtros*.

| Filtro | Quién lo aplica |
|---|---|
| Escalas (directos / máx. 1) | **Kayak**, en la URL (`fs=stops=0` / `stops=0,1`) |
| Duración máx. por trayecto | **Kayak** (`fs=legdur=-N`, en minutos) |
| Franja de salida (ida y vuelta) | **Nosotros**, al momento |
| Precio máx. por persona | **Nosotros**, al momento |

Los dos primeros obligan a rebuscar (los aplica Kayak, así que las 15 opciones
que trae ya son buenas). Los otros dos se notan al instante y llevan la píldora
"se aplican al momento".

Probé los cuatro contra la web de Kayak; el detalle de qué funcionó y qué no
está en la cabecera de `providers/kayak.js`. Dos avisos que salieron de ahí:
`stops=-1` **no** significa "hasta una escala" (Kayak lo normaliza a
`stops=0,2`, justo lo contrario), y ni `depart=` ni `price=` hacen nada.

Si los filtros locales dejan la lista en cero pero la búsqueda sí tenía
resultados, la pantalla lo dice con otro mensaje: *"Ningún vuelo cumple los
filtros"*, para no confundirlo con una búsqueda vacía.

---

## Avisos del destino (pantalla 3)

Tres fuentes gratuitas y públicas, sin clave ni registro. **No abren navegador**:
son peticiones HTTP normales, así que el trabajo tarda segundos y no se pelea
por el perfil de Chrome con los scrapers.

| Aviso | Fuente | Qué mira |
|---|---|---|
| Clima | [Open-Meteo](https://open-meteo.com) (geocoding + archivo histórico) | Los mismos días del viaje en los **5 años anteriores** |
| Seguridad | [Recomendaciones de viaje del Ministerio de Exteriores](https://www.exteriores.gob.es) | La sección "Seguridad" de la ficha del país |
| Festivos | [Nager.Date](https://date.nager.at) | Festivos **nacionales** que caen dentro de las fechas |

### Los umbrales del clima

Están en `UMBRALES_CLIMA`, arriba de `services/avisos.js`, para poder moverlos
sin bucear en el código:

| | Valor | Aviso |
|---|---|---|
| `calorFuerte` | máxima media > **32 °C** | "Va a hacer calor" (precaución) |
| `frio` | mínima media < **5 °C** | "Va a hacer frío" (precaución) |
| `lluviaFrecuente` | llovió > **40 %** de los días | "Llueve a menudo en esas fechas" (precaución) |
| `mmParaContarComoLluvia` | **1 mm** en el día | umbral para contar un día como lluvioso |
| `anosDeHistorico` | **5** años | cuántos años se promedian |

Si no hay nada reseñable, el aviso es positivo y en azul: *"Clima templado en
esas fechas"*, con las medias reales.

### La severidad de seguridad

Sale del propio texto oficial, no de una lista mía:

- contiene **"desaconseja"** → `alerta` (rojo)
- contiene **"precaución/precauciones/extreme"** → `precaución` (ámbar)
- si no → `info` (azul)

**España no lleva aviso de seguridad**: es el país desde el que se viaja y
Exteriores no tiene ficha propia para él.

### Si una fuente se cae

Cada una va en su propio `try/catch`. La que falle deja un aviso suyo en azul
(*"No he podido consultar X"*) y **las otras dos siguen**. La pantalla nunca se
queda rota y el botón "Entendido, continuar" está siempre.

Lo único imprescindible es el geocoding: sin coordenadas ni país no hay nada
que consultar, y entonces sí sale la pantalla de error con "Reintentar".

Casos ya probados: países que Nager.Date no cubre (Nepal contesta `204` vacío,
y eso **no** se trata como fallo) y sitios de los que Open-Meteo no devuelve
nombre de país (Nuuk, Longyearbyen): ahí Exteriores se salta sin ruido.

### Cuándo caducan

Los avisos se guardan en la tabla `avisos` por viaje. Se borran y se vuelven a
pedir cuando cambia el **destino** o cambian las **fechas** — no cuando cambian
los viajeros, que no influyen en nada de esto. También hay un "Actualizar datos"
para forzarlo a mano.

---

## Distancias entre ciudades

Mirando Italia hay que poder saber si Florencia está a tiro de Roma para un fin
de semana o si son tres horas de carretera. Hasta ahora el mapa solo decoraba.

**Se calcula una vez y ya.** La distancia de Roma a Florencia no cambia, así que
vive en el CATÁLOGO (`distancias_ciudades`) y no caduca. La segunda vez que
alguien mire Italia —en este viaje o en otro— no se le pregunta nada a nadie.

El par **no tiene dirección**: se guarda una sola fila con el id menor delante,
y un índice único sobre ese par ordenado es lo que impide que dos consultas
simultáneas dejen A→B y B→A y después haya dos verdades.

Las ciudades son `puntos_interes`, que es lo que hay en el mapa de exploración de
un país y lo que apunta cada etapa que sale de ahí. Una parada que no venga del
mapa no tiene punto, y para esa la distancia de su tramo sigue viviendo donde
vivía: en la propia fila de `transportes`.

### El punto de referencia

Desde dónde se miden, en orden de "lo que ya se sabe seguro":

1. La **primera parada** de la ruta.
2. La ciudad a la que **llega el vuelo** de ida, si ese tramo existe.
3. La **primera ciudad seleccionada**, aunque siga siendo candidata. Al elegir la
   primera en el mapa todavía no está confirmada, y esperar a que lo esté dejaría
   la pantalla sin distancias justo cuando más hacen falta.
4. Nada: sin referencia no se pinta ninguna distancia.

### Los umbrales

| | Color |
|---|---|
| hasta 400 km y 4 h | sin color |
| más de 400 km **o** 4 h | ámbar |
| más de 700 km **o** 7 h | rojo |

Basta con pasarse en uno de los dos: 526 km en 5 h 30 ya es medio día.

### Nada bloquea la pantalla

El endpoint devuelve **solo lo que hay en caché** y encola el cálculo de lo que
falte. El mapa pinta lo que tiene, sondea cada 4 s y va rellenando. Un par que
falla se queda con un guión y se reintenta al volver a abrir el mapa.

Y las peticiones van **de una en una**: `porCarretera` ya serializa con su pausa,
y el bucle es un bucle, no un `Promise.all`. Veinte peticiones a la vez a un
servidor que nos deja usarlo gratis es la forma de que dejen de dejarnos.

### En el mapa y en la ruta

Cada ficha de ciudad dice *"A 273 km · 3 h en coche de Roma"*. El mapa dibuja una
línea punteada de la referencia a cada ciudad **ya elegida** —solo a esas: una a
cada candidata sería una telaraña— con los km a media línea.

En "Mi ruta", cada salto lleva sus km en el chip y al final va el total. Solo los
saltos de en medio: la ida y la vuelta son vuelos, y sumarlos convertiría
cualquier viaje a Italia en "4.000 km de coche".

### El aviso de viabilidad

Hora y media de carretera al día. Es una regla de servilleta y no pretende otra
cosa: solo avisa, no impide nada. Un viaje de tres días con seis horas de coche
se puede hacer; lo que no se puede es no haberse dado cuenta.

---

## Las búsquedas dejan de acumularse

### El problema, con números

Madrid llegó a tener **71 fichas** en la pestaña "Comer". Cada búsqueda añadía
doce y ninguna se iba nunca, así que a la cuarta consulta era imposible
encontrar entre ellas los tres sitios que uno mismo se había apuntado.

Son **dos cosas distintas metidas en la misma lista**:

- Lo que YO me he apuntado (o he escrito a mano). Es mío, es del viaje y no
  caduca.
- Lo que salió de una consulta. Es de usar y tirar: si vuelvo a buscar, lo de
  antes ya no me interesa.

Ahora hay tres montones: **los míos**, **la última búsqueda**, y **el histórico
plegado**. Con eso Madrid pasó de 81 tarjetas en pantalla a 13, y el histórico
ocupa 37 píxeles cerrado.

**No se borra nada, y es deliberado.** Cada ficha costó una llamada a Places, y
el próximo viaje a Madrid la reutiliza sin volver a pedirla. Lo que se limpia es
la pantalla, que es donde estaba el problema. `catalogo_comer.busqueda` guarda de
qué consulta es cada fila; "la última" es la marca más alta, y como son
timestamps ISO ordenan igual como texto que como fecha.

Las marcas `'manual'` y `'antiguo'` no cuentan como búsqueda: lo escrito a mano
es una decisión y no caduca, y lo que había antes de existir esta columna se va
directo al histórico.

### La movilidad duplicaba

`guardarFichaMovilidad` era un `INSERT` a secas: pulsar "Buscar otra vez" en
Moverse metía otra vez las mismas cinco fichas de metro y taxi. Ahora hay un
índice único por (ciudad, nombre) y la segunda búsqueda **actualiza** en vez de
duplicar, que es lo que ya hacían las excursiones y los restaurantes. Lo que no
se pisa es el teléfono ni la web cuando vienen vacíos: si alguien los escribió a
mano, una búsqueda que no los trae no puede borrarlos.

## "Moverse", partida en dos

La pestaña mezclaba dos preguntas distintas sin nada que las separase: **cuánto
hay de aquí a allá** y **cómo funciona el transporte de esta ciudad**. Ahora son
dos secciones con su cabecera, su icono y su frase.

### Los traslados, con lo importante arriba

La lista crecía con cada consulta y no todas valen lo mismo: "del hotel al
centro" se mira veinte veces durante el viaje; "del Prado a Atocha" se miró una
vez para decidir algo. Un chincheta fija los que quiero tener a mano; el resto
se queda plegado como **historial**. Nada se borra.

### Dos tarjetas por fila, y por qué

Las fichas de transporte urbano llevan teléfono, web, horarios y dirección. En
una columna de 244 px eso no cabe — y ahí estaba el fallo de verdad: **`1fr` es
en realidad `minmax(auto, 1fr)`**, así que el contenido que no puede encoger
EMPUJA su columna. La rejilla salía con columnas de **352, 218 y 184 px** en vez
de repartidas, que es lo que se veía como "desbordan la pantalla".

Con `minmax(0, 1fr)` las columnas mandan sobre el contenido, y con dos por fila
hay sitio de sobra: 373 px cada una. El teléfono sigue siendo un `tel:` tocable.

## "Ponerlo en un día", en una ventana centrada

El formulario colgaba del propio botón con `position: absolute`. En una ficha de
"Moverse" ese botón está dentro de una tarjeta de una rejilla, así que el
formulario acababa pintado **arriba del todo de la página**, a pantallas de
distancia de lo que se acababa de pulsar: parecía que no había pasado nada.

Ahora es una ventana centrada sobre el contenido, con los mismos campos y un
Cancelar. Se cierra con **Cancelar, con Escape y tocando fuera**, que son las
tres cosas que uno intenta.

Se llama `.ventana` y no `.modal` **porque `.modal` ya existía**: es el diálogo
de confirmar el borrado de un viaje, en la portada. Reutilizar el nombre hizo
que las dos se pisaran las reglas y la nueva salía pegada al borde izquierdo y
descuadrada.

---

## La hora y el orden en el lienzo

### Cualquier tarjeta puede llevar hora

Antes solo las escritas a mano —y luego los traslados y las comidas— podían
tenerla. No tenía sentido: al Prado se llega a una hora concreta igual que a una
cena, y sin poder apuntarla el lienzo no termina de ser un plan.

**La hora es del PLAN, no de la ficha.** La misma catedral puede ir a las diez un
martes y a las seis un viernes; eso no se guarda en el catálogo, se guarda en la
tarjeta (`itinerario.hora` y `.duracion_min`). Por eso una ficha apuntada en dos
viajes no arrastra la hora de uno al otro.

**No se propone ninguna hora, nunca.** Ni la de apertura del museo, ni una
deducida de la tarjeta anterior más su duración. El campo nace vacío. Una hora
sugerida que nadie ha pedido se acaba dando por buena, y entonces el plan dice
algo que nadie decidió.

**El control va plegado.** Con cinco tarjetas en un día, diez casillas vacías
convierten la columna en un formulario: se ve un relojito muy tenue, y las
casillas salen al tocarlo. La duración tecleada manda sobre la del catálogo —si
pones que tu visita son 90 minutos, son 90 aunque la ficha diga "2 horas"— y las
dos viajan al dosier.

### El orden dentro de la franja

- **Las que tienen hora van primero, ordenadas por ella.** Si el free tour es a
  las 10:00 y la comida a las 14:30, el orden del día ya está dicho: arrastrarlas
  para ponerlas "bien" sería trabajo que no debería hacer nadie.
- **Las que no tienen hora van detrás, en su orden manual**, y se suben o bajan
  con dos flechas que aparecen al pasar por encima. Antes una tarjeta nueva solo
  podía caer al final de su franja: para meter una comida entre dos visitas había
  que sacarlo todo y volver a colocarlo.

Las flechas solo salen en las tarjetas **sin** hora. Las que la tienen ya están
ordenadas por ella y empujarlas no cambiaría nada: el botón sería una promesa
falsa.

Un detalle que costó encontrar: el primer comparador devolvía `0` para dos
tarjetas de franjas distintas —"que las agrupe la vista"— y eso rompe el orden.
Un comparador no transitivo hace que `sort` coloque las cosas como le dé la gana,
y el síntoma era que poner una hora no movía nada. Ahora el orden es total:
día, franja, con-hora, hora, orden manual, id.

### El traslado del "+" con extremos elegibles

Lo deducido de las tarjetas de al lado sigue siendo **la propuesta**, que acierta
casi siempre. Debajo hay un "Cambiar de dónde a dónde" que abre dos campos con
el **mismo autocompletado** del buscador de traslados de la etapa: el
alojamiento, los sitios apuntados, las excursiones, los restaurantes y el
transporte urbano, más cualquier dirección escrita a mano.

Sale también cuando a un extremo le falta la dirección: ahí es justo donde más
falta hace poder cambiarlo, en vez de tener que salir del lienzo.

La tarjeta muestra la duración calculada. **La hora de salida la pone el
usuario**; no se calcula ninguna hora de llegada.

### "Comer" no hacía nada: por qué

El fallo estaba en una línea que parecía inofensiva:

```js
document.addEventListener('click', (ev) => {
  if (!ev.target.closest('.hueco')) cerrarHuecos();
});
```

Ese manejador vive en `document`, así que corre **después** de los de la
pantalla. Para cuando llegaba, el de "Comer" ya había sustituido el contenido del
menú por el "buscando…", y con él el botón que se acababa de pulsar: `ev.target`
era un elemento **ya desconectado del DOM**, su `closest()` no encontraba ningún
`.hueco`, y esto cerraba el menú entero.

La petición salía igual y contestaba treinta segundos después, pero no había
dónde pintarla. Desde fuera: pulsas y no pasa nada.

Se arregla mirando `ev.composedPath()`, que se calcula al lanzar el evento y se
queda guardado, así que sigue diciendo por dónde pasó aunque el DOM haya cambiado
debajo.

De paso, `llamar()` se tragaba los errores: avisaba en un aviso flotante y no
devolvía nada, así que quien necesitaba reaccionar al fallo no se enteraba y el
menú se quedaba en "calculando…" para siempre. Ahora devuelve `{ ok, error }`.

### Lo apuntado, primero

Si me molesté en apuntarme un restaurante para esta parada, me interesa más que
doce que acabo de descubrir. Salen arriba y marcados como "apuntado", y detrás
los nuevos. Entre ellos se ordenan igual —por desvío—, así que un apuntado que
queda lejísimos no se cuela por delante de otro que pilla de paso.

---

## El mapa de exploración

### Teselas de Google, con OpenStreetMap de respaldo

Se usa `GOOGLE_MAPS_BROWSER_KEY` —la del navegador, restringida por dominio— a
través del plugin `Leaflet.GoogleMutant`. No se pueden pedir las imágenes de
Google por URL y ya: sus condiciones no lo permiten. Lo que hace el plugin es
montar un mapa de Google de verdad por debajo y llevarlo sincronizado con el de
Leaflet, así que su atribución sale como tiene que salir y los marcadores, el
carrusel y las líneas siguen siendo de Leaflet, sin tocarlos.

El estilo apaga las etiquetas de puntos de interés y de transporte y baja la
saturación: encima del mapa hay que pintar marcadores, líneas punteadas y
etiquetas de distancia, y con los negocios y las paradas de metro de Google no
se lee nada.

**El respaldo es lo que costó hacer bien.** Hay cuatro formas de que Google no
funcione y no todas avisan igual:

| Qué pasa | Cómo se detecta |
|---|---|
| No hay clave en el `.env` | Se mira antes de nada |
| El script no se descarga | `onerror` |
| La clave no vale (algunos casos) | `gm_authFailure` |
| **`RefererNotAllowedMapError`** | **Ninguna de las anteriores** |

El último es el que muerde, y es además el más probable: la clave está
restringida por dominio, así que en cuanto se prueba desde un puerto que no está
en la lista salta ese error. Y en ese caso **la API carga bien, no llama a
`gm_authFailure`, escribe el error en la consola y deja el mapa en gris**. Desde
el código todo parece haber ido bien.

Por eso, después de poner la capa, se espera al `tilesloaded` del mapa de Google
—el evento que dice "ya hay imágenes en pantalla"— con un plazo de cuatro
segundos. Si no llega, se quita la capa y entra OpenStreetMap con el motivo en
la consola:

```
[descubrir] teselas de OpenStreetMap: Google no llegó a pintar. Lo normal es
que la clave no autorice «http://localhost:3210»: mira la consola, ahí lo dice
con su nombre.
```

### Ciudad de entrada

Un control pequeño en cada ficha, aparte de "A mi ruta" porque no es lo mismo
apuntar una parada que decidir por dónde se entra al viaje. Marcarlo hace dos
cosas:

1. **Confirma la ciudad en la ruta como primera parada.** No queda como
   candidata: una ciudad de entrada es por definición una parada decidida.
2. **Mueve ahí la referencia de todas las distancias**, y las fichas se
   recalculan al momento.

Y lo segundo sale gratis de lo primero: `referenciaDelViaje` ya cogía la primera
parada confirmada. No hace falta columna nueva ni ajuste aparte — "ciudad de
entrada" y "primera parada" son la misma cosa dicha de dos maneras, y conviene
que lo sigan siendo. Por debajo son `confirmarEtapa` y `reordenar`, las mismas
que usa la pantalla de la ruta.

**Solo puede haber una.** Se comporta como un grupo de opciones: se cambia
marcando otra, y la anterior se queda en la ruta un puesto más abajo. Se cambia
por dónde se entra, no se borra media ruta. Desmarcar no hace nada —el viaje
entra por algún sitio— y se dice.

Solo aparece en destinos de nivel **país**, donde cada resultado es una ciudad.
En una ciudad los resultados son el Prado o el Retiro, y por ninguno se entra a
ningún sitio.

### Refresco en vivo

Antes, añadir una ciudad pintaba su botón de "En tu ruta" y hasta ahí llegaba
todo: el marcador seguía igual y, sobre todo, **no aparecía su línea punteada**,
porque esa lista vive en el mapa de marcadores del JS y nadie la actualizaba.
Había que salir de la pantalla y volver a entrar.

Y con las investigaciones era peor. El sondeo comparaba qué tarjetas seguían
girando y, si alguna terminaba, **recargaba la página entera** — perdiendo el
encuadre del mapa y el sitio del carrusel. Pero solo se enteraba si la propia
pantalla había visto empezar la investigación: si el trabajo ya estaba en marcha
al entrar, o si el sondeo se saltaba justo el momento del final, la tarjeta se
quedaba para siempre con su ruedecita y su distancia sin pintar. **Eso es lo que
le pasó a Gdansk.**

Ahora hay un solo endpoint, `/api/destinos/:id/mapa`, que devuelve **todo junto**
—estado de cada punto, referencia y distancias— y una sola función que repinta
con lo que diga. Sin comparar nada y sin recordar nada: si algo cambió se ve, y
repintar lo mismo no cuesta. Se llama al añadir a la ruta, al marcar la ciudad
de entrada y en cada vuelta del sondeo. **Ya no queda ni un `location.reload()`
en esta pantalla.**

Pedirlo todo en una llamada es a propósito: por trozos, el mapa se queda medio
de una época y medio de otra —la tarjeta ya dice "En tu ruta" pero la línea
todavía no está—.

### Un fallo que escondía a otro

El endpoint nuevo leía `distancias.calculando`, pero `distanciasDelMapa` no
devuelve eso: devuelve `faltan`, y lo de "estoy calculando" se deduce. Como
`undefined` es falso, el mapa dejaba de sondear justo cuando había pares en
camino, y los guiones no se rellenaban nunca. Ahora es `faltan > 0`, igual que
en el endpoint de distancias de siempre.

---

## App instalable (PWA)

Se instala desde Chrome y se abre en su propia ventana, sin barra de URL, con
su icono. Igual que menusemanal y gastos.

```
public/manifest.webmanifest   Nombre, colores, iconos, start_url
public/sw.js                  El service worker
public/js/pwa.js              Lo registra. Cuatro líneas y nada más
public/icons/*.png            Los iconos, PNG de verdad
tools/generar-iconos.js       Los dibuja. Se ejecuta a mano si hay que rehacerlos
```

### Un solo `<head>` para diecisiete pantallas

Todas las vistas de la aplicación incluyen `parciales/cabecera.ejs`, así que el
`<link rel="manifest">`, el `theme-color` y el `apple-touch-icon` se ponen una
vez y quedan en todas.

**El dosier no lleva nada de esto, y es a propósito.** Tiene su propio `<head>`
porque es un archivo que se descarga y se abre desde un ZIP, muchas veces sin
servidor detrás. Un manifest o un service worker ahí no tendrían a qué agarrarse.

### Los iconos se dibujan, no se descargan

`tools/generar-iconos.js` los genera sin dependencias: un PNG es una firma, tres
trozos y un CRC32, y `node:zlib` ya viene en Node. Meter `sharp` —doscientos
megas de binarios nativos— para pintar un avión blanco sobre un cuadrado azul
sería desproporcionado.

**La zona segura de los maskable importa.** Android recorta el icono con la
forma que le dé la gana: círculo, cuadrado redondeado, *squircle*. Lo único
garantizado es el círculo central del 80 % del ancho. Por eso hay dos dibujos:

- `any` — el avión ocupa el 76 %. Nadie lo va a recortar, así que se ve grande.
- `maskable` — el avión al 52 %, para caber en ese círculo. Suelto parece
  pequeño; recortado en el móvil queda igual que los demás.

Ninguno tiene transparencia: un maskable con agujeros se ve fatal recortado.

### El service worker es prudente, y tiene que serlo

**Esta app vive de datos vivos.** Los precios de un vuelo, las plazas de un
hotel, el horario de un autobús: todo lo que enseña puede haber cambiado desde
ayer. Un service worker alegre convierte una herramienta de planificar en una
fuente de datos viejos sin avisar, que es peor que no tener nada.

La regla es siempre la misma: **primero la red**. La caché solo entra cuando la
red ha fallado de verdad, y entonces es un apaño de emergencia —el metro, un
pueblo sin cobertura, el avión— y no el camino normal.

| Qué | Estrategia |
|---|---|
| css, js, iconos, manifest | Caché primero. Son míos y los versiono yo |
| Páginas | **Red primero**, caché de respaldo |
| API (GET) | **Red primero**, caché de respaldo |
| Búsquedas, estados, detalles, adjuntos | **Nunca** se guardan |
| POST, PUT, DELETE | **Nunca**. Ni pasan por el service worker |

Lo de la lista `NUNCA` no es una precaución vaga. Guardar `/estado` sería lo
peor que podría hacer ese archivo: la pantalla se quedaría con un "buscando…"
eterno porque nunca vería que el trabajo ya terminó.

En el precache **no va ninguna página**: una página lleva datos del viaje
dentro, y precacharla sería congelar el viaje del día que se instaló.

**Para publicar cambios, subir `VERSION` en `sw.js`.** El nombre de la caché la
lleva dentro, así que al activarse la versión nueva borra las viejas enteras.

### Cómo se comprueba que Chrome la da por instalable

`pwa.js` escucha `beforeinstallprompt`, que es el evento que Chrome dispara
cuando ha verificado **todo** lo suyo: manifest válido, iconos de 192 y 512,
`display: standalone`, service worker con manejador de `fetch` y origen seguro.
Que salte es la única confirmación de verdad; lo demás es mirar el código y
suponer.

Abre la consola y busca:

```
[pwa] service worker registrado, ámbito: https://viajes.es-consultingdream.uk/
[pwa] Chrome la da por instalable: aparece "Instalar app" en el menú.
```

Si sale la segunda línea, el menú de Chrome (⋮) tiene **Instalar app** y se abre
en ventana propia. No se llama a `prompt()` en ningún momento: instalar lo decide
la persona desde ese menú, no una ventana que salta sola nada más entrar.

---

## Comer: bares y restaurantes

El hueco llevaba puesto desde la primera versión del lienzo: `comer` ya estaba
entre los tipos de la mochila, con su icono y su color. Lo que faltaba era de
dónde salen las fichas.

### Places es la API cara, y todo está escrito con eso en mente

Geocoding y Routes son baratas. Places se paga por llamada **y por campo**, y un
campo de más sube el tramo de precio de toda la petición. La disciplina es la
misma que ya probamos con las fichas de Civitatis:

1. La búsqueda pide la **máscara mínima**: id, nombre, dirección, coordenadas,
   nota, número de opiniones, nivel de precio y tipo. Nada más.
2. Lo que vuelve se guarda **entero** en el catálogo de la ciudad.
3. Un sitio ya guardado **no se vuelve a pedir**.
4. El teléfono, la web y los horarios van en una llamada **aparte, bajo demanda,
   al abrir una ficha, y una sola vez**. De veinte resultados se abren dos:
   pedirlos todos al buscar es pagar dieciocho veces por lo que nadie va a leer.

`detalles_en` es la marca de "esto ya se pidió". Sin ella no se distinguiría un
bar sin teléfono de uno que nadie ha mirado, y se pagaría por el mismo silencio
en cada visita. Si los escribes tú a mano, también cuenta: la ficha deja de
ofrecer el botón.

### Dos fuentes, y se nota cuál contestó

En local la clave de servidor está restringida por IP, así que Places falla
siempre y entra **la IA con búsqueda web**, que devuelve los mismos campos.

Pero **la IA no cuenta opiniones: recuerda**. Un número suyo con dos decimales
al lado de uno de Google sería dar por medido lo que no lo está, así que sus
fichas salen **sin nota** y con una marca discreta que lo dice. Preferimos un
hueco honesto a un 4,7 inventado.

```
[google] places:buscar: The provided API key has an IP address restriction…
[comer] Places no dio resultados: pregunto a la IA con búsqueda web.
[comer] 12 sitio/s de la IA para «cenar tranquilo cerca del hotel» en Madrid.
```

La nota que **ordena** es la ponderada de siempre, `(nota·n + 7,5·50)/(n+50)`:
un 5,0 con tres opiniones no puede ganarle a un 4,6 con ochocientas.

### El campo libre es lo que hace útil la búsqueda

"Cenar tranquilo cerca del hotel" no se puede pedir con filtros; se escribe.
Places entiende lenguaje natural y la IA todavía más. Al lado hay un botón para
lo mejor de la ciudad sin escribir nada, que es el otro noventa por ciento de
las veces.

Y una ficha a mano siempre es posible: el bar que te recomendó un amigo no está
en ninguna API.

### Distancias por ficha: la misma pieza, mirada al revés

"¿A cuánto está de…?" en restaurantes, sitios y excursiones. **No hay tabla
nueva**: un traslado ya guarda de qué elemento es cada extremo, así que
preguntar "¿cuáles tocan a esta ficha?" es una consulta, no un modelo.

Por eso borrar una distancia desde la ficha la borra de la lista de "Moverse", y
es lo correcto: es el mismo dato.

Se lee siempre "desde esta ficha hacia el otro" aunque la consulta se hiciera al
revés. En la ficha del restaurante uno quiere leer "Al hotel: 12 min", no "Del
hotel: 12 min".

### El "+" del lienzo gana "Comer"

Busca **alrededor del punto medio** de los dos vecinos, con radio proporcional a
lo que los separa: la mitad de la distancia, con suelo de 400 m y techo de 3 km,
que es lo que uno acepta desviarse por comer. Un radio fijo daría lo mismo para
dos sitios pegados que para dos en barrios opuestos.

**El desvío es el dato.** Cada resultado dice cuánto hay de él a cada extremo,
porque un sitio buenísimo a quince minutos del camino no pilla de paso por muy
céntrico que sea el punto medio. Y ordena por eso.

Aquí hubo que resolver dos cosas para que el desvío existiera de verdad:

- **El sesgo por coordenadas solo lo entiende Places.** A la IA hay que
  contárselo con palabras, así que la consulta le menciona entre qué dos sitios
  está buscando. Sin eso devolvía buenos restaurantes de todo Madrid.
- **Las fichas de la IA llegan sin coordenadas**, y sin ellas no hay desvío que
  calcular. Se sitúan **ahí mismo**, antes de contestar, en vez de dejarlo para
  la cola. Cuesta unos segundos —Nominatim va a una petición por segundo— y se
  paga una sola vez por sitio.

Al elegir uno entra como **tarjeta de altura normal**: una comida es una
actividad, no un traslado. Con su hora y su duración editables, porque una
comida y un traslado son las dos cosas del día que se planean por la hora.

### Dos fallos que salieron probando esto

**`enLineaRecta` redondeaba a kilómetros enteros.** Nació para tramos entre
ciudades, donde 460 y 460,3 son lo mismo. Dentro de una ciudad es un desastre:
del hotel al bar hay 328 metros, que redondeados son **cero**, y de ahí salía "1
min andando" para un paseo de seis. Ahora hay `distanciaKm()` sin redondear, que
es la que usan los traslados urbanos y el desvío.

**"Calle Huertas 18, Madrid" caía en Torrelaguna.** Madrid es también la
provincia, y Nominatim devolvía primero una calle de un pueblo a sesenta
kilómetros. Es una respuesta correcta a una pregunta ambigua, y colarla por
buena pone tu cena a una hora de coche sin avisar. Ahora se piden cinco
resultados con `addressdetails` y se prefiere el que cae en el municipio que se
pidió; el log dice qué descartó.

### En el dosier

- Las **comidas colocadas** salen en su día y su franja con la cocina, la hora,
  la duración, la dirección y el teléfono como enlace tocable.
- Lo **apuntado sin día** va en un bloque "Dónde comer" al final del día, con sus
  distancias guardadas. Es lo que uno mira a las dos de la tarde sin plan:
  "¿qué tenía yo apuntado por aquí?".

### La migración

Migración 18: la tabla `catalogo_comer`, y una **reconstrucción** de
`direcciones` para ensanchar su `CHECK` y que admita `'comer'`. SQLite no sabe
modificar un CHECK, así que la única vía es tabla nueva, copiar y renombrar; se
hace en una transacción y se dice claro en el código, porque la alternativa —un
restaurante que no puede tener dirección— dejaría fuera justo lo que da sentido
a la pestaña.

---

## Traslados: "¿cuánto hay de aquí a allá?"

Es la pregunta que más se repite planificando un día. Se hace veinte veces, y
hasta ahora había que salir a Google Maps, mirarla y volver sin que quedara
constancia de nada: a la media hora ya no te acuerdas de si eran 20 minutos o
40, y la vuelves a mirar.

### Dos claves de Google, y no se mezclan

```
GOOGLE_MAPS_SERVER_KEY    Geocoding, Routes y Places. Restringida por IP.
                          Es la única que toca el servidor.
GOOGLE_MAPS_BROWSER_KEY   Maps JavaScript API, para pintar mapas.
                          NO se usa todavía y NO está en ninguna vista.
```

**La clave de servidor no funciona desde casa, y eso está bien.** Está
restringida a la IP del servidor, así que en local Google contesta *"This IP is
not authorized"* con toda la razón. No es un fallo que arreglar: es la
restricción haciendo su trabajo.

Por eso `lib/google.js` **nunca lanza**: devuelve `null` y quien llama se va al
plan B. En local se desarrolla contra el plan B; en el servidor entra Google y
se nota **porque aparece el transporte público**, que es lo único que OSRM no
sabe dar.

Se rinde sola: a los **tres noes seguidos** deja de preguntar y va directa al
respaldo. Preguntar igualmente son ocho segundos de espera por traslado delante
de alguien que está planificando. Se reactiva al reiniciar.

**El log siempre dice quién contestó**, y hace falta: "12 min en coche" se ve
exactamente igual lo diga Google o lo diga OSRM.

```
[google] geocoding: This IP, site or mobile application is not authorized…
[nominatim] OK: «Calle de la Cruz 6, Madrid» → 6, Calle de la Cruz, Sol, Madrid…
[direcciones] situada con nominatim: «Calle de la Cruz 6»
[traslados] Sin Google (clave restringida o ausente): OSRM y estimación.
[traslados] Retiro Park → Museo Reina Sofía: andando 17 min · coche 5 min (osrm)
```

### El OSRM público ignora el perfil

Cuesta media hora descubrirlo, así que queda escrito: pedirle
`/route/v1/foot/...` devuelve **exactamente los mismos números** que
`/driving/...` — 1,7 km en 3 minutos, o sea 34 km/h andando.

Así que el tiempo a pie **no se le pregunta**: se estima aquí, a 4,5 km/h sobre
la línea recta con un 30 % de margen de calles. Y se marca con un `~` delante,
porque una cosa es un dato y otra un cálculo de servilleta.

### A) Las direcciones: una tabla, no una columna en cada sitio

Las cosas que tienen dirección viven en cinco tablas distintas. Cinco `ALTER` y
cinco sitios donde acordarse de leerla. Va aparte, con el mismo patrón de
`(tipo_elemento, elemento_id)` que ya usa `adjuntos` y que funciona.

**El alcance lo da el tipo**, y eso es lo que hace que la elección sea correcta:

| tipo | apunta a | alcance |
|---|---|---|
| `hotel` | `candidatos.id` | **Del viaje.** Mi hotel en Madrid es mío. |
| `punto` | `puntos_interes.id` | **Catálogo.** La dirección del Prado no |
| `sitio` | `sitios_lugar.id` | cambia entre viajes: se teclea una vez |
| `actividad` | `catalogo_actividades.id` | y sirve siempre. |
| `movilidad` | `catalogo_movilidad.id` | |

**Las coordenadas son internas.** El usuario piensa en direcciones y en nombres;
`lat`/`lng` son el combustible del cálculo. No salen a ninguna pantalla, y el
endpoint de lugares las quita en una función aparte (`paraLaVista`) para que ese
borrado esté en **un** sitio y sea difícil olvidárselo.

**Se geocodifica en segundo plano.** Guardar es instantáneo —la persona escribe,
pulsa y ya está— y la búsqueda va por la cola, con la ficha diciendo "situando…".
Si no se encuentra, se avisa con suavidad y se deja editar; nunca se rechaza lo
que ha escrito la persona.

**Dos formas de la misma dirección.** Un punto de encuentro de Civitatis viene
así: *"Plaza de Oriente (junto a la estatua ecuestre de Felipe IV)."*. El
paréntesis le sirve a una persona y le estorba a un geocodificador. Se prueba
entera primero —a veces el paréntesis es parte del nombre, y lo que escribió la
persona merece el primer intento— y si no aparece se reintenta sin él.

Los puntos de encuentro que ya estaban raspados **se vuelcan en la migración**,
quedándose con la primera línea: lo demás es el "Ver mapa" y una advertencia
legal que sale en todas las fichas.

### B) Los traslados son material de investigación

Un traslado consultado **no se borra** porque la actividad salga del lienzo.
Saber que del hotel al centro hay 20 minutos andando sigue siendo verdad aunque
ese día se decida no ir. Por eso cuelgan de la **etapa** y no de la tarjeta.

Los extremos se guardan **congelados** —texto y coordenadas de ahora—, no como
referencia al elemento: si mañana borro la excursión, la consulta que hice sigue
diciendo lo que decía. Se apunta además de dónde salió cada extremo, pero eso es
para poder recalcular, no la fuente de verdad.

Los dos campos del buscador aceptan **dos cosas**: el nombre de algo del viaje
(y entonces viaja su tipo y su id) o cualquier dirección tecleada —el
aeropuerto, una calle—, que se geocodifica al vuelo y no se guarda como
dirección de nadie, porque no es de nadie.

Lo que todavía no tiene dirección se dice una vez, sin dramatismo: es más útil
saber por qué el Prado no sale en la lista que no verlo y no saber.

### C) El "+" entre tarjetas del lienzo

Entre cada par de tarjetas y en los dos bordes de cada franja. **Casi
invisible**: son cinco o seis por franja, y si se vieran todos el día parecería
un formulario. Se insinúan al acercar el ratón; en el móvil se dejan muy tenues.

Quién está a cada lado **lo decide el servidor** (`vecinosDeHueco`), y no el
navegador, porque los vecinos no siempre están en la misma franja:

- En medio de una franja, las tarjetas de al lado.
- Al principio de la tarde, el de antes es la última tarjeta de la mañana.
- **En los bordes del día no hay tarjeta: es el hotel.** Se sale de dormir y se
  vuelve a dormir, y ese es justo el traslado que uno quiere calcular.

Las tarjetas que ya **son** un traslado se saltan: enlazar un traslado con otro
no dice nada, y saltándolo se llega a los dos sitios de verdad. Si eso da un
traslado que ya existe, se devuelve el que hay en vez de duplicarlo.

Se coloca **en el hueco**, no al final de la franja: se empuja hacia abajo lo que
venga después. Un traslado entre dos tarjetas solo significa algo si queda entre
esas dos.

Si a un extremo le falta la dirección, el "+" **dice cuál** y ofrece ir a
ponérsela. Un "no se puede" a secas deja a la persona buscando por la pantalla.

Y la consulta se guarda **también** en la lista de la etapa: es la misma pieza,
dos entradas.

### D) En el dosier

- Las **tarjetas de traslado** salen en su día y su franja, finas, con el medio y
  los minutos: "17 min andando". El medio importa tanto como el número.
- La **chuleta** de cada parada va al final del día, en un bloque compacto. No es
  el plan —eso son las tarjetas de arriba—, es la referencia de "cuánto hay" para
  cuando el plan se tuerce y hay que decidir en la calle. Se repite en todos los
  días de la misma parada a propósito: el dosier enseña un día cada vez, y una
  chuleta que solo saliera el primer día no estaría cuando hace falta.

### La migración es solo aditiva

Migración 17: dos tablas nuevas (`direcciones`, `traslados`) y dos columnas en
`itinerario` (`traslado_id`, `medio`). Nada borrado, nada renombrado.

---

## Movilidad: cómo se llega y cómo se mueve uno

Hasta esta tanda el tramo entre dos paradas tenía un solo botón: **Buscar
vuelos**. También en Sarajevo → Mostar, que se hace en autobús en dos horas y
media por diez euros. Y una vez en la ciudad no había ningún sitio donde
apuntar el metro, el bono de tres días o el teléfono del taxi: acababa en una
nota suelta o en el móvil de otro.

Son **dos piezas** que comparten el patrón de ficha de sitios y excursiones:

- **Cómo llegar** (en el tramo): los medios de esa pareja de ciudades.
- **Moverse** (subpestaña de la etapa): el transporte urbano de la ciudad.

### Las dos preguntan CON BÚSQUEDA WEB

`lib/ia.js` acepta `conWeb: true` y añade la herramienta `web_search` de la API.
No es un capricho: un horario de autobús o el precio de un billete de metro
cambian, y de memoria un modelo se los inventa con toda la seguridad del mundo.
Si la herramienta no está disponible en la cuenta, la consulta **se reintenta
sin web** en vez de fallar; se ve en el log cuántas búsquedas hizo.

Los dos prompts dicen lo mismo en su primera línea: *si un dato no lo
encuentras, deja la cadena vacía; no te lo inventes*. Una ficha con la duración
en blanco es útil. Una con una duración inventada es peor que nada.

### Las dos son CATÁLOGO

Los autobuses entre Sarajevo y Mostar no dependen de mi viaje. Se consultan una
vez, y el año que viene —o en el viaje de otro— ya están:

- `catalogo_transporte_tramo`, por **pareja de ciudades sin dirección**: el
  nombre normalizado menor delante, un `CHECK (ciudad_a_norm <= ciudad_b_norm)`
  y un índice sobre el par. Sarajevo → Mostar y Mostar → Sarajevo son la misma
  fila, que es lo que hace que la parada de vuelta no vuelva a preguntar nada.
  Lo que sí cambia según el sentido va en su propio campo, `nota_sentido`, y se
  pinta aparte con una flecha de doble punta.
- `catalogo_movilidad`, por ciudad normalizada.

### Lo elegido y lo tecleado SÍ es del viaje

`transportes.ficha_transporte_id` dice cuál está elegido en **este** tramo, y
`transporte_datos` guarda lo concreto —horario, precio real, localizador, nota—
con una fila **por (tramo, ficha)**.

Por ficha y no por tramo a propósito: si apunté el horario del tren y después me
decido por el autobús, lo del tren sigue ahí cuando vuelva. Y por eso elegir
**no recarga la pantalla**: repinta las clases y una clase `oculto`. Una recarga
se llevaría por delante lo que estuviera a medio escribir en otra ficha.

### El avión sigue estando

Hay tramos largos donde sí se vuela. El avión aparece **siempre** como una ficha
más, con borde punteado para que no parezca un dato investigado, y su botón
lleva al buscador de Kayak de siempre. No se guarda en el catálogo: no es un
dato sobre el mundo, es una puerta a otra pantalla de esta aplicación.

Por eso `comoLlegarDeTramo()` devuelve además `delCatalogo`, que es cuántas
fichas hay **sin contar el avión**. Es lo que decide si la pantalla dice
"todavía no se ha mirado cómo ir de Sarajevo a Mostar".

### A mano, siempre

Si la IA no devuelve nada útil —o falla, o no hay clave— hay un botón **A mano**
con todos los campos editables, en las dos piezas y junto a las generadas. Es el
mismo formulario que sale al pulsar **Editar** en una ficha existente.

Borrar sí pregunta: la ficha es del catálogo, y se la quita también a los demás
viajes que pasen por ahí.

### El teléfono, siempre como `tel:`

Es el dato más útil de la pestaña y se usa en la calle, con una mano y con
prisa. Un número que hay que copiar no sirve de nada. Se pinta como pastilla
verde, no como texto: en el móvil la diferencia entre "un número" y "llamar" es
exactamente esa. En el href van solo dígitos y el `+` —un `tel:` con espacios no
marca en algunos móviles—, pero a la vista queda el número tal cual se escribió.

### El traslado en el lienzo: tarjeta fina

Una ficha de "Moverse" se puede poner en un día como cualquier otra cosa, pero
allí se pinta **más fina**: coger el metro no pesa lo que una mañana en un
museo, y si se pintaran igual el día parecería el doble de lleno de lo que está.

Lleva su hora y su duración **a la vista y tecleables ahí mismo**, porque en un
traslado eso es todo lo que hay que saber. El icono es el del medio (taxi,
metro, bus), no uno genérico: en una tarjeta tan pequeña el icono es medio
mensaje.

Dos detalles que salieron al probarlo:

- La tarjeta es `draggable`, así que el navegador empezaba a arrastrarla en
  cuanto pinchabas en la casilla de la hora y no había forma de escribir nada.
  El `dragstart` sale antes si el clic viene de dentro del reloj.
- Un traslado guarda su nombre en `texto_manual` y su ficha en `movilidad_id`.
  El `CHECK` de `itinerario` exige que haya candidato **o** texto, nunca los
  dos, y así se cumple sin tocar la tabla.

### Al dosier

- El **medio elegido** va con los demás transportes del viaje. Primero lo
  tecleado —el horario que cogí, el localizador—, que es lo que se mira en la
  estación con la mochila al hombro; después lo del catálogo, que es contexto.
- Los **traslados** salen en su día y su franja, finos, con su hora, su duración
  y el teléfono como enlace tocable.
- Un tramo con medio elegido **cuenta como resuelto** en el check de "viaje
  listo". El autobús de las 9:15 con el billete comprado no es menos tramo
  cerrado que un vuelo elegido.

### La migración es solo aditiva

Migración 16: tres tablas nuevas, `transportes.ficha_transporte_id`, y
`itinerario.movilidad_id` y `.duracion_min`. Nada borrado, nada renombrado.

---

## Clonar una parada

El caso que lo pide: Barcelona → Sarajevo → Mostar, pero el vuelo de vuelta sale
de Sarajevo. La ruta de verdad es **Sarajevo → Mostar → Sarajevo**, y esa segunda
vez suele ser de cero noches: se pasa por allí a coger el avión.

El botón "Clonar" de cada tarjeta crea una parada nueva al final:

- **Enganchada al mismo destino del catálogo**, así que nace con los sitios y las
  excursiones ya investigados. Ni una búsqueda repetida: eso es conocimiento
  sobre la ciudad, no sobre el viaje.
- **Vacía de todo lo demás**: sin hotel, sin transporte, sin nada apuntado ni
  colocado, sin cotizaciones. Volver a pasar por Sarajevo no es dormir otra vez
  en el mismo hotel.
- **Cero noches**, que en la tarjeta se lee *"de paso"*. Se edita como cualquier
  otra: a veces sí se duerme esa última noche.

Las dos son paradas independientes: se arrastran, se borran y se abren por
separado, y el catálogo que comparten no se toca.

### Cero noches es un estado válido

`cambiarNoches` tenía el suelo en uno —"una parada de cero noches no es una
parada"—, y para el caso normal está bien. Pero la parada de paso existe. Ahora
el suelo es cero.

### Nada impide repetir ciudad

No hay `UNIQUE` en `etapas` ni filtro que las esconda. Los tramos se generan por
**id de etapa**, no por ciudad, así que Mostar → Sarajevo sale como un salto más
y la vuelta a casa parte siempre de la última parada de la ruta, sea clonada o
no: no hay ninguna lógica de "la última ciudad distinta" que simplificar, nunca
la hubo.

### Dos efectos que salieron al probarlo

Elegir una **segunda ciudad** en el mapa estaba roto de antes, y con la ciudad
repetida se veía:

- `sincronizarEtapaUnica` **renombraba** la parada existente con el destino del
  viaje, así que elegir Mostar convertía la parada de Sarajevo en "Mostar" y
  Sarajevo desaparecía. Ahora solo se ejecuta con la ruta vacía; a partir de la
  segunda ciudad manda `asegurarEtapaDeCiudad`, que la añade al final sin tocar
  lo que hay. Y adopta la parada suelta que aquella crea, para no duplicarla.
- `viajes.destino` se sobrescribía con la última ciudad tocada, y el chip de "Mi
  ruta" acababa diciendo "Mostar" en un viaje a Sarajevo. El ámbito se pone una
  vez y se queda.

### Con la ciudad repetida, el mapa lleva a la ruta

Entrar "en Sarajevo" desde el mapa ya no quiere decir nada concreto cuando hay
dos: son dos paradas distintas, con sus fechas y su hotel. Así que se va a la
ruta, que es donde se ve cuál es cuál, en vez de elegir una a ciegas.

---

## Los adjuntos

El billete, la confirmación del hotel, el bono de la excursión. Todo eso llega
por correo en PDF o como foto y no tenía sitio: acababa en la galería del móvil.

Cuelgan de **tres clases de elemento**, y `adjuntos.elemento_id` apunta a una
tabla distinta según cuál sea. Es una relación polimórfica, así que no lleva
clave ajena: SQLite no puede tener una columna que apunte a tres tablas.

| tipo_elemento | apunta a | qué guarda |
|---|---|---|
| `transporte` | `transportes.id` | billetes, tarjetas de embarque |
| `alojamiento` | `candidatos.id` del hotel **elegido** | confirmación, instrucciones de entrada |
| `excursion` | `candidatos.id` de la apuntada | bonos, entradas |

El alojamiento cuelga del hotel elegido y no de la etapa a propósito: la
confirmación es **de ese** hotel. Si cambio de hotel, ya no vale para nada.

Los archivos van a `adjuntos/viaje-{id}/{tipo}/{elemento_id}/`, con un nombre
nuevo (marca de tiempo + nombre saneado) porque lo que llega es el nombre que
tenía en tu ordenador y puede traer barras, `..` o cualquier cosa. El original se
conserva solo para enseñarlo. Se aceptan PDF, JPG, PNG y HEIC hasta 15 MB.

**Se suben con el archivo como cuerpo del `fetch`**, no como multipart: el
navegador puede mandar un `File` tal cual y el servidor lo recibe con
`express.raw`, así que no hace falta meter una librería de multipart para subir
de uno en uno, que es como se suben estas cosas.

**Dónde va el cajón en cada sitio.** El componente es el mismo y el
comportamiento también —subir, arrastrar, ver, borrar—; lo que cambia es cómo se
abre, según lo que haya alrededor:

| Sitio | Título | Presentación |
|---|---|---|
| Tramo | Billetes y tarjetas de embarque | píldora plegada en la tarjeta |
| Alojamiento | Reserva e instrucciones | píldora plegada en la caja del hotel |
| Excursión | Bonos y entradas | sección final del desplegable "Ver detalles" |

En la excursión va dentro del desplegable porque fuera quedaba flotando entre una
tarjeta y la siguiente, sin que se viera de cuál era. Con la tarjeta cerrada, si
hay papeles, aparece un **clip pequeño con el número** junto a los botones que
abre el desplegable directamente por esa sección; con cero, la tarjeta se queda
limpia y el cajón espera dentro.

Ese clip es una entrada aparte de "Ver detalles" a propósito: ese botón, cuando
la ficha no está descargada, se va a Civitatis a buscarla, y para mirar un bono
que ya tienes no hace falta abrir un navegador. Por lo mismo, pulsar "Ver
detalles" en una excursión apuntada abre el panel **ya**, aunque la ficha tarde:
si no, no habría forma de subir un papel a una excursión cuya búsqueda falla.

Dentro de un desplegable el cajón va **sin píldora** (`abierto: true`), con la
etiqueta de encabezado y la lista a la vista: hacerte pulsar dos veces para ver
un bono sería absurdo.

**Desapuntar una excursión con adjuntos pregunta antes.** El servidor los borra
al quitar el candidato —si no, se quedarían colgando de algo que ya no está en el
viaje—, así que hay que decirlo antes y con el número. La cuenta sale del propio
cajón, que ya la lleva al día: no hace falta preguntar al servidor para saber si
hay que avisar.

**Sin clave ajena, la limpieza la hace el código**: `borrarAdjuntosDe()` donde se
borra un elemento, y `limpiarAdjuntosHuerfanos()` como red de seguridad para los
caminos que se escapan —recalcular la ruta borra tramos, refrescar los hoteles
borra candidatos—. Se pasa por lo que hay y limpia lo que sobra, disco incluido.

---

## El dosier es un ZIP

```
dosier.html
adjuntos/vuelo-ida/1-billete-ida-toni.pdf
adjuntos/hotel-madrid/1-confirmacion.png
```

El HTML sigue siendo autocontenido en datos y fotos (base64), y **enlaza los
adjuntos en relativo**, así que con el ZIP descomprimido funcionan sin conexión.
Los adjuntos NO van en base64: irían dentro del HTML y lo harían inmanejable.

**El mismo HTML sirve para las dos cosas.** Si se abre desde la aplicación —para
una revisión rápida, sin descomprimir— un bloque al final cambia esos enlaces
por los de la app. La detección es por la **ruta exacta** (`/viaje/{id}/dosier`)
y no por el protocolo: si alguien sirve la carpeta descomprimida con un servidor
estático, el protocolo también sería `http` y los enlaces relativos —que ahí sí
funcionan— se romperían.

"Ver" abre el HTML suelto; "Descargar" baja el ZIP. Un adjunto que ya no esté en
el disco se omite y se cuenta en el resultado: que falte un billete no puede
dejarte sin el resto del viaje.

### Compartir: el orden importa

`navigator.share()` exige **activación transitoria**: el permiso que da el
navegador durante unos segundos después de que toques algo. La primera versión
hacía `await fetch(zip)` dentro del manejador del clic y llamaba a `share`
después — para entonces, en un móvil con el ZIP viniendo por la red, la
activación ya había caducado y `share` fallaba con
`NotAllowedError: Must be handling a user gesture`. En un escritorio con el
servidor en localhost la petición tarda milisegundos y la activación aguanta, así
que el fallo **solo se veía en el móvil**.

Ahora el ZIP se pide **al abrir el menú**, y el clic de "Compartir" no espera a
nada: llama a `share` como primera cosa, con `.then()` en vez de `await` (un
`await` por delante deja el resto del manejador para el siguiente turno y vuelve
a perder la activación). Mientras el ZIP viene, el botón dice "Preparando…" con
el icono girando y no se deja pulsar.

Y si aun así se pulsara antes de tiempo, **no se llama a `share` cuando el ZIP
llega**: para entonces ya no habría gesto y volveríamos al mismo error. Se avisa,
se sigue trayendo y el botón se habilita para un segundo toque, que sí trae su
propio gesto.

Regenerar el dosier tira el ZIP precargado y trae el nuevo: compartir uno viejo
sería peor que no compartir nada.

Y no, el tipo de archivo no era el problema: `canShare({files})` con un
`application/zip` devuelve `true`.

**Tres escalones**. El motivo exacto va al log —`NotAllowedError`, qué dijo
`canShare`— y en pantalla solo lo accionable: a quien quiere mandar su dosier por
WhatsApp no le sirve de nada leer el nombre de una excepción.

1. Compartir el ZIP.
2. Si el navegador no traga ese archivo, compartir el texto y descargar el ZIP
   aparte: al menos el mensaje sale por el selector del sistema.
3. Sin API, descargar y decir qué hacer.

Cancelar el selector lanza `AbortError` y no es un fallo: no se avisa de nada.

### El control, en una línea

Interruptor pequeño, un ⚠ que solo aparece si falta algo, y el botón Dosier con
un puntito si se ha quedado viejo. La fecha y las acciones —Ver, Descargar,
Compartir, Regenerar— viven dentro del menú. Antes era una caja que ocupaba más
que el contador de noches para algo que se toca al final del viaje y una vez.

---

## El dosier

La salida final: **un solo archivo HTML** con el viaje entero dentro, para
consultarlo desde el móvil en la calle y sin conexión.

### Tres reglas que mandan sobre todo lo demás

1. **Todo va dentro.** Los datos como JSON en un `<script>`, el CSS y el JS en
   línea, las fotos en base64. Ni una petición a internet: ni CDNs, ni fuentes,
   ni llamadas a esta aplicación. Se abre con `file://` y funciona.
2. **Se genera con lo que ya está guardado.** El dosier no busca nada: si una
   excursión no tiene su ficha descargada, enseña lo básico y ya está.
3. **Si algo falla al generarlo, se omite y se sigue.** Una foto que no se deja
   descargar no puede impedir que exista el archivo.

### El check de "viaje listo"

Lo pongo y lo quito yo, desde el mismo panel en "Mi ruta" y en el lienzo. Al
lado se ve qué falta —tramos sin resolver, etapas sin hotel—, pero eso **solo
informa**: un viaje puede estar listo con la última noche sin cerrar si así lo
decido. Bloquear el check por eso sería la aplicación diciéndome cuándo está
listo mi viaje.

El botón "Generar dosier" sí depende del check, y cuando está apagado su tooltip
dice por qué.

### Cómo se sabe que el dosier se ha quedado viejo

`viajes.modificado_en` contra `viajes.dosier_en`. La primera la mantienen
**disparadores de SQLite** sobre `itinerario`, `etapas`, `transportes` y el
`marcado` de `candidatos`.

Son disparadores y no llamadas a mano porque "tocar el viaje" pasa desde una
docena de sitios y basta olvidarse de uno para que el dosier diga que está al día
cuando no lo está.

Y cada uno lleva un `WHEN` que compara columna a columna, así que **una escritura
que deja los mismos valores no cuenta**: sin eso, `recalcularFechasEtapas` —que
reescribe las mismas fechas cada vez que se entra en la ruta— avisaría de que el
viaje ha cambiado cada vez que se mira. Por lo mismo quedan fuera las columnas de
caché: que OSRM rellene la distancia de un tramo no es un cambio mío.

### Las fotos

Se piden **tal y como están guardadas**, que ya son miniaturas: las de Wikipedia
vienen a 330 px de ancho (~33 KB) y las de Civitatis a 230 px (~8 KB).
Redimensionar en el servidor pediría una librería nativa de imagen para llegar a
un tamaño que las fuentes ya dan. Lo que sí hay es **tope por foto** (200 KB) y
**presupuesto total** (4 MB), que es lo que de verdad decide si el archivo cabe
en un móvil.

Solo se descargan las que el dosier va a pintar: las de sitios y excursiones. El
hotel se enseña con su nombre, su zona y su nota.

### Ojo con el catálogo: la misma excursión en dos ciudades

Civitatis lista la misma actividad desde varias ciudades —el tour del Palacio
Real sale en la página de Madrid y también en la de Granada—, así que en
`catalogo_actividades` hay **dos filas con la misma url**. Es correcto: la clave
única es ciudad + actividad.

Pero significa que buscar la ficha solo por url devuelve la primera que caiga,
que puede ser la de la otra ciudad y no tener los detalles descargados. El
síntoma era una excursión ampliada que en el dosier salía pelada. El cruce mira
la ciudad de la parada, y solo si no encuentra nada se conforma con la url.

### El archivo por dentro

Se pinta **en el navegador** a partir del JSON embebido, no viene escrito desde
el servidor: el buscador y la navegación por días trabajan sobre esos mismos
datos, y si el HTML viniera hecho, buscar sería recorrer el DOM y acabaría
desincronizado.

- **Portada** con nombre, fechas, ruta y los datos de un vistazo.
- **Vista "hoy"**: si la fecha actual cae dentro del viaje, se abre por el día
  que toca, con su pestaña marcada.
- **Un día por pantalla**, con sus franjas, sus bloques de transporte (vuelo,
  aerolínea, horarios, origen→destino) y el hotel de esa noche. El último día no
  lleva hotel: se vuelve.
- **Cada cosa es desplegable** y enseña la ficha entera que haya en el catálogo.
- **Reservas** al final: todos los vuelos y hoteles juntos.
- **Buscador** por nombre, sobre los datos embebidos.

Sin mapas —necesitan red—: donde hay coordenadas va un enlace a Google Maps, que
funcionará si hay conexión, y las coordenadas escritas para poder buscarlas a
mano si no.

---

## Días y noches no son lo mismo

Un viaje del 25 al 27 son **dos noches pero tres días**. El día de la vuelta
también se viaja y tiene sus horas: el vuelo sale por la tarde y queda una mañana
entera que repartir.

El lienzo estaba usando el número de noches como número de días, así que generaba
solo el 25 y el 26, y el vuelo de vuelta del 27 acababa cayendo en el 26. Ahora
crea un día por cada fecha de la salida a la vuelta **inclusive** (`noches + 1`).

`nochesEntre()` está bien y se usa bien en todas partes —el reparto de la ruta,
el contador de la portada, las fechas en cascada de las etapas—: **el único sitio
donde se confundía era `services/lienzo.js`**. Lo demás cuenta noches porque lo
que necesita son noches.

Y los bloques fijos de transporte se colocan **por su fecha**, no por su
posición: la vuelta va al día cuya fecha coincide con el fin de la última etapa,
no a "el último día que haya". Buscar por fecha es lo que hace que no vuelva a
descolocarse si algún día vuelve a faltar o sobrar un día.

**Las horas de un vuelo de un tramo.** Como los tramos se buscan de solo ida,
esas tarjetas traen UN trayecto y va etiquetado `ida`. El lienzo buscaba uno
llamado `vuelta` para sacar la hora de salida del regreso, no lo encontraba, y el
bloque se quedaba sin hora y en la franja por defecto. Ahora, con un solo
trayecto, las dos horas salen de él: el bloque de ida usa su llegada y el de
vuelta su salida.

---

## Un solo sondeo por pantalla

En la etapa pueden estar trabajando a la vez la preparación de la ciudad, los
hoteles y los vuelos de cada tramo. Todo eso lo cuenta **un único** endpoint
(`/etapa/:id/estado`) y lo sondea **un único** temporizador.

El sondeo solo se enciende si algo está en marcha, y ahí estaba el fallo: la
condición miraba la ficha y los hoteles pero **no los vuelos**. Buscar vuelos
dejaba el *"Buscando en Kayak…"* colgado indefinidamente —el trabajo terminaba
bien, pero nadie estaba mirando— y los resultados solo aparecían cuando otra cosa
forzaba una recarga.

Cuando algo termina se recarga la pantalla, y eso **no pisa al tramo que siga
buscando**: lo que se pinta lo decide el servidor, que sabe cómo está cada uno.
El que siga en marcha vuelve a salir "buscando"; el que haya fallado, con su
error y su botón de reintentar. Si algo acaba mientras otra cosa sigue, también
se recarga, para enseñar ya lo que esté hecho sin esperar a lo demás.

---

## El centro de trabajo es la ETAPA

El mapa era paso obligado y concentraba las fichas ricas; la etapa era una lista
pobre. Ahora es al revés: **el trabajo se hace en la etapa**, y el mapa solo se
usa cuando de verdad hay algo que elegir.

### El mapa se comporta según el NIVEL del destino

| Nivel | Qué pasa al elegirlo |
|---|---|
| **Ciudad** ("Sevilla") | No hay pantalla de fichas. El mapa se queda contando el progreso —*"Buscando los sitios más bonitos de Sevilla…"*, *"Buscando excursiones…"*— y al terminar **entra directamente en su etapa**. Si ya estaba investigada, entra al instante. |
| **País o región** ("Portugal") | El mapa **sí** es la pantalla de exploración: fichas de ciudades y zonas, cada una con "A mi ruta". Solo las añadidas se vuelven etapas candidatas; el resto se queda en el catálogo. Ahí no se buscan sitios ni excursiones de cada ciudad: eso pasa al entrar en su etapa. |

Una ciudad no se elige entre otras, se trabaja. Por eso no tiene sentido
enseñarle a nadie una pantalla intermedia para que "explore" Sevilla dentro de
Sevilla.

**Un país tampoco es una parada.** Elegir "Portugal" ya no crea una etapa
"Portugal" confirmada: en la ruta aparecía como si uno fuera a dormir en el país
entero. Las paradas de un viaje a Portugal son las ciudades que se elijan, y
solo esas.

### La etapa nace llena

Al abrir una parada cuya ciudad no tiene nada en el catálogo, se lanzan **solas**
las dos búsquedas —los sitios (IA + Wikipedia) y las excursiones (Civitatis)— y
la pestaña "Qué ver" cuenta por dónde van. No hay que pulsar nada: entrar en
Sevilla es querer Sevilla. Si el catálogo ya tiene datos, abre cargada al
instante y no se abre ningún navegador.

Las dos van en UN trabajo (`preparar_etapa`) y no en dos, porque lo que se
pregunta es una sola cosa —"¿puedo entrar ya?"—. **Si una fuente falla, la otra
sigue**: solo se da por fallido si fallan las dos.

No se reintenta sola después de un fallo. Sin esa condición, una ciudad que falla
(sin clave de IA, por ejemplo) se reencolaría en cada visita: un bucle silencioso
de trabajos condenados. Para reintentar está el botón del aviso.

### Fichas cuadradas, en rejilla vertical

Las dos subpestañas usan la misma rejilla: **3 fichas por fila en escritorio, 2
en pantalla media, 1 en móvil**. Todo se ve bajando con la página; ni un carrusel
horizontal.

"Sitios" usa la misma tarjeta cuadrada que tenía el mapa
(`parciales/ficha-sitio.ejs`, sobre `.tarjeta-punto`): foto, nombre, descripción
y su detalle desplegable. Antes eran barras horizontales de una línea, y en una
barra no cabe una foto ni se lee una descripción. Cada ficha conserva sus
acciones: "Me lo apunto" / "Apuntado" y "Ponerlo en un día".

### El detalle no se pierde nunca

**El fallo era de lectura, no de guardado.** Ampliar la ficha del Coliseo
escribía tres cosas en el catálogo —el párrafo del "por qué" y el "cómo moverse"
en `puntos_interes.datos_extra`, y los lugares de dentro en `sitios_lugar`—, pero
la consulta de la etapa se traía solo el nombre, la foto y la descripción corta.
El detalle seguía ahí; nadie lo leía.

Ahora `queVerDeEtapa` lo lee entero (los hijos de una vez y agrupados en memoria,
que una consulta por sitio serían quince para pintar una pestaña) y la ficha lo
enseña. **Una ficha ampliada una vez queda ampliada para siempre, se mire desde
donde se mire**: desde la etapa, desde el mapa o desde otro viaje.

Y se puede ampliar desde la etapa, con el mismo trabajo que usa el mapa
(`investigar_ciudad`), porque lo que sale va al catálogo.

### Volver al mapa, solo cuando tiene sentido

En la cabecera de "Mi ruta", junto a Configuración, hay un **"Elegir más
ciudades"** que lleva al mapa de exploración del destino. Solo aparece si el
destino del viaje es de nivel país o región. En un viaje a Sevilla no sale: no
hay nada más que explorar allí, y sería una puerta a ninguna parte.

---

## La pantalla de la etapa

### "Qué ver" tiene subpestañas

Mezclaba dos cosas que no se parecen: los **sitios** de la ciudad y las
**excursiones** de Civitatis, estas últimas en un carrusel horizontal larguísimo
donde no se veía lo que había. Ahora cada una tiene su subpestaña y su lista
vertical: se ve todo bajando con la página.

La lista de subpestañas está en la propia plantilla (`SUBVISTAS`, en
`views/etapa.ejs`) y el JS no sabe cuántas hay ni cómo se llaman. Para añadir
"Comer" o "Bares" basta con meter una entrada ahí y su `<section class="subpanel">`
debajo.

### Las excursiones tienen foto y ficha

El catálogo ya guardaba `imagen_url` de cada excursión y la tarjeta pintaba un
icono de ticket sobre fondo azul. Ahora manda la foto; la que no tenga se queda
con el icono, sin hueco gris ni imagen rota.

Y cada una lleva **"Ver detalles"**, que trae la ficha completa de Civitatis:
descripción larga, duración, idiomas, qué incluye y qué no, punto de encuentro y
política de cancelación.

**La ficha es del CATÁLOGO, no del viaje.** Lo que incluye el free tour de Berlín
no cambia porque yo viaje en marzo o en octubre: se busca **una vez** y se queda
para siempre y para todos los viajes. La segunda vez que alguien la abre no se
busca nada, se despliega al instante.

Y se pide **una a una**, al pulsar su botón. Nunca en masa: con veintisiete
excursiones por ciudad serían veintisiete visitas de navegador para leer tres.

La receta (`buscarFichaActividad`, en `providers/civitatis.js`) lee **por texto,
no por clases**, y no es pereza: Civitatis sirve la misma ficha con dos maquetas
—móvil y escritorio, con los ids repetidos— y además cambia de forma según el
tipo de actividad. Recorriendo el DOM, la receta que funcionaba en un free tour
se traía la sección entera en una entrada de acuario. Leyendo las etiquetas
("Duración", "Incluido", "No incluido"...) funciona igual en las dos.

**Lo que no está, no está.** Una entrada de museo no tiene punto de encuentro, y
casi ninguna ficha publica horarios de salida: Civitatis los enseña en el
calendario de reserva, después de elegir un día, y eso ya no es información
estable del catálogo. Esos campos se quedan vacíos y no se pintan.

### Los filtros van ANTES de buscar, y viven dentro de la pestaña

Antes, entrar en "Dónde dormir" lanzaba Booking sin preguntar, y el botón
"Filtros" te echaba a la pantalla del wizard: se buscaba en un sitio y se
filtraba en otro. Ahora:

- **Sin resultados**: no se lanza nada. Se enseña el formulario de filtros,
  abierto, y se busca al pulsar **"Buscar hoteles"**.
- **Con resultados**: el resumen de los filtros usados arriba y un
  **"Cambiar filtros"** que despliega el mismo formulario ahí mismo.

Nunca se sale de la pantalla. El formulario es el mismo de siempre, extraído a
`parciales/filtros-hotel.ejs` (y `parciales/filtros-vuelo.ejs`), que ahora
comparten el wizard y la etapa.

Para que puedan convivir varios paneles en una página no queda ni un id global:
cada chip dice a qué **campo** pertenece y el manejador de `app.js` lo busca por
`name` dentro de **su** formulario.

### Los vuelos se buscan POR TRAMO

BCN → Berlín del 10 y Berlín → BCN del 13 son **dos búsquedas distintas**, cada
una **solo ida** (`buscarVuelosKayak` con `fechaVuelta: null`) y con **sus
propios filtros**, guardados en `transportes.filtros_vuelos`. Puedo querer
directos a la ida y que me dé igual a la vuelta.

Mientras un tramo no tenga filtros propios hereda los del viaje, así que lo que
ya estaba buscado sigue viéndose igual.

De paso desaparece la aproximación que había documentada: entrar por una ciudad
y salir por otra ya no obliga a fingir un ida y vuelta a la misma, porque cada
punta se busca por separado y con sus dos puntas reales.

### Ámbitos: qué es del viaje y qué es de una parte

| Se guarda con | Es de | Se busca desde |
|---|---|---|
| `transporte_id` | ese tramo | su tarjeta, en "Cómo llegar" |
| `etapa_id` | esa parada | la pestaña de la etapa |
| ninguno de los dos | el viaje entero | el paso 5 |

`candidatosDe()` excluye lo que cuelga de un tramo, porque si no el paso 5
listaba la ida y la vuelta de la ruta juntas y revueltas como si fueran opciones
de ida y vuelta del viaje.

Con `etapa_id` **no** se hace lo mismo, y es a propósito: un hotel se duerme EN
una ciudad, así que siempre cuelga de una etapa —hasta cuando lo busca el paso
6, que lo guarda en la única del viaje—. Excluirlos dejaría el paso 6
eternamente vacío, buscando otra vez algo que ya tiene.

---

## Ya no hay wizard

La pantalla de configuración arrastraba la cabecera del wizard: la tira de pasos
"Tu viaje · Destino · Avisos" prometiendo un camino que hace tiempo que no
existe. Se ha quitado: la pantalla empieza en "Configura tu viaje", con su miga
de pan, y al guardar **vuelve a donde estabas** —a la ruta si venías de ella, al
mapamundi si el viaje acaba de nacer y todavía no tiene destino—. El botón dice
"Guardar", no "Continuar".

---

## Las listas de resultados son compartidas

Las presentaciones ricas de vuelos y hoteles viven en parciales y las usan **el
wizard y la pantalla de etapa**:

| Parcial | Qué pinta | La usan |
|---|---|---|
| `parciales/vuelo.ejs` | La opción de ida y vuelta con los **dos trayectos**: horarios, aeropuertos, duración y escalas | Paso 5 y "Cómo llegar" de la etapa |
| `parciales/hotel.ejs` | Nota, nº de opiniones, zona, distancia al centro y precio total | Paso 6 y "Dónde dormir" de la etapa |
| `parciales/tarjeta.ejs` | Actividad de Civitatis | Paso 4, ficha de ciudad y etapa |

Los tres llevan el círculo de elegir con `data-marcar`, que maneja el código
genérico de `app.js`. Por eso **todos los endpoints que eligen algo contestan
`{ marcado }`**: la tarjeta es la misma en todas partes y no se le cambia el
contrato, solo la URL.

### Lo que se había perdido

La pestaña "Cómo llegar" montaba su propia lista desde el JS y se dejaba por el
camino **los horarios**, que es justo el dato con el que se elige un vuelo. El
scraper nunca dejó de extraerlos: estaban en `datos_extra.tramos` todo el
tiempo. Ahora la lista se pinta en el servidor con el parcial de siempre.

### Los filtros, en los dos sitios

Los filtros son del VIAJE y se ajustan en su panel del paso 5 / paso 6. La etapa
enseña cuáles están puestos, cuántos resultados esconden y un atajo para
cambiarlos, y **los aplica**: los de búsqueda viajan a Kayak en la URL
(`fs=stops=0`) y los locales (precio por persona, franja horaria) se aplican
sobre lo guardado. Si los filtros dejan la lista vacía se dice con esas
palabras — *"Ningún vuelo cumple los filtros"* — y no se confunde con "no has
buscado".

**Ojo con los ámbitos:** refrescar vuelos u hoteles desde el wizard NO toca los
que cuelgan de un tramo o de una etapa. El trabajo que se encola ahí es de
ámbito viaje y no sabría reponerlos, así que se quedarían vacíos para siempre.
Cada etapa se refresca con su propio botón.

### La ventana del navegador, apartada

`lib/browser.js` lanza Chrome con `--window-position=-2400,0`: fuera de
pantalla, para que no salte al primer plano cada vez que se busca algo.

**Sigue siendo una ventana real. Nada de headless**, nunca: los cuatro scrapers
están validados con ventana de verdad y en headless los antibots de Booking y
Kayak los cazarían al primer intento. Lo único que cambia es dónde aparece; si
hace falta verla, se quita esa línea.

---

## Una etapa no es un museo

La regla que decide todo en `descubrir`, y que costó un rato aprender:

> **El NIVEL del destino decide qué es cada resultado.**

| Nivel del destino | Qué son sus resultados | Qué hace el botón |
|---|---|---|
| País o región | Ciudades y zonas donde dormir | **"A mi ruta"** — crea una etapa |
| Ciudad | Sitios de dentro (museos, parques, barrios) | **"Me lo apunto"** — candidato dentro de la etapa de esa ciudad |

### Qué estaba mal

El botón creaba una etapa por cada resultado sin mirar el nivel. Para Japón eso
está bien: Tokio, Kioto y Osaka son paradas. Para Madrid era un disparate: el
Prado, el Palacio Real y el Retiro no son paradas de ningún viaje, son cosas que
ver **dentro** de la parada Madrid.

El síntoma era un viaje con tres candidatos llamados **"Madrid, Madrid,
Madrid"**: como los tres resultados son de categoría `sitio`, la etapa tomaba el
nombre de su `ciudad_base`, que en los tres casos era Madrid.

Y encima la etapa Madrid de verdad estaba suelta: no apuntaba a nada del
catálogo, así que su pestaña "Qué ver" salía vacía aunque el catálogo tuviera
quince sitios y veintiocho excursiones de esa misma ciudad.

### El enlace que faltaba

`etapas.destino_id` — de una parada al destino del catálogo del que sabemos
cosas. Con él, "Qué ver" bebe de **dos fuentes** y las suma:

- Del **destino de nivel ciudad**: sus `puntos_interes` (el Prado, el Retiro).
- Del **punto de un destino de nivel país**: su ficha profunda en `sitios_lugar`
  (los templos de Kioto).

Las excursiones van por nombre de ciudad, que es como se guardan: no necesitan
el enlace.

### Apuntar crea la parada sola

Apuntar el Museo del Prado en un viaje que aún no pasaba por Madrid **crea la
etapa Madrid** en `recopilando`, enlazada al catálogo, sin preguntar: quien
apunta el Prado está diciendo que quiere ir a Madrid, y hacerle confirmar eso
sobra. Se avisa una vez — *"Madrid añadida a tu ruta"* — y no se repite con cada
museo.

### Cuidado con los ids

Tres tablas distintas alimentan "Qué ver" y **sus ids se solapan**: el 42 es el
Museo del Prado en `puntos_interes` y otra cosa en `sitios_lugar`. Por eso al
apuntar se manda también de qué tabla viene (`punto` / `sitio` / `actividad`).

### La reparación

Migración `2026-09-etapa-no-es-un-sitio`, de un solo uso:

```
4 etapas convertidas en sitios apuntados (1 etapa de ciudad creada),
1 etapa reenganchada al catálogo.
```

Convierte las etapas que en realidad eran sitios en candidatos dentro de la
etapa de su ciudad (creándola si no estaba), las borra como etapas, y engancha
al catálogo las etapas sueltas cuyo nombre coincide con un destino investigado.
**No borra nada del catálogo**: lo apuntado sigue apuntado, solo que en el sitio
correcto.

---

## La portada: el cuaderno de viajes

Panel de acento a la izquierda y los viajes como **billetes** a la derecha,
sobre un fondo de carta náutica (curvas de nivel, cruces, rosa de los vientos
y una ruta punteada; todo decorativo y sin clics).

Cada billete lleva datos de verdad, no adornos:

| Parte | De dónde sale |
|---|---|
| Talón con mes y día | `viajes.fecha_inicio`, o "?" en gris si no tiene fechas |
| Ciudades con → | Las etapas **confirmadas** en su orden; "Sin ruta todavía" si no hay |
| Chip "N etapas · M noches" | Cuenta y suma de esas etapas |
| Chip verde "Cuadra" / ámbar "Faltan N noches" | Noches repartidas contra las del viaje. Sin fechas no sale chip |
| Panel: "N viajes" y "Próxima salida" | La fecha de inicio futura más cercana |

Son **dos consultas**, no una por billete: los viajes y todas sus etapas de un
tirón, y el cruce en memoria.

### Sus estilos van APARTE

`public/css/portada.css`, y la carga solo la home. No es manía: los nombres de
la portada son genéricos a propósito (`panel`, `principal`, `menu`, `billete`)
y en la hoja compartida chocaron. **`.panel` se llevó por delante la ficha de
lugar y la pantalla de etapa**, cuyas pestañas también se llaman `panel`: se
pintaban con el azul y los 300 px del lateral de la home, y todo el contenido
salía embutido en una columna estrecha.

Aislar por fichero en vez de renombrar deja el marcado limpio y hace imposible
la colisión: esas reglas no llegan a ninguna otra pantalla.

### Entrar en un viaje existente

Clicar un billete NO reabre el configurador. Se entra por donde se dejó, de más
avanzado a menos:

| Estado del viaje | A dónde va |
|---|---|
| Tiene paradas (candidatas o confirmadas) | `/viaje/:id/ruta` |
| Sin paradas, pero con el destino en el catálogo | `/descubrir/:destinoId` |
| Sin nada, pero con fechas | `/elegir-destino/:id` |
| Ni fechas | `/viajes/:id/paso/1`, el configurador |

El configurador queda para el flujo de "＋ Nuevo viaje" y como enlace discreto
**"Configuración"** en la cabecera de la ruta, para cambiar fechas o viajeros.

### Borrar un viaje

Menú ⋯ en cada billete, con "Cambiar nombre" y "Borrar viaje…". Borrar pregunta
con el modal de la casa y dice exactamente qué se lleva:

> Se borrará «Viaje a Japón» con 1 etapa, 0 cosas apuntadas y 0 cosas del lienzo.

La cascada la hace SQLite: `candidatos`, `etapas`, `transportes`, `itinerario`,
`trabajos` y `avisos` referencian `viajes(id)` con `ON DELETE CASCADE` y las
claves ajenas están activadas. Un solo `DELETE` se lo lleva todo.

**El catálogo NO se toca**: `destinos`, `puntos_interes`, `sitios_lugar` y
`catalogo_actividades` no tienen `viaje_id`. Borrar el viaje a Japón no puede
borrar lo que sabemos de Japón.

---

## La jerarquía de destinos

Investigando España salían mezcladas Barcelona, el Parque Güell y la Sagrada
Familia. Eso no es cuestión de gusto, es un error de jerarquía: el Parque Güell
no compite con Barcelona, **está dentro** de Barcelona. Y rompe el modelo,
porque de una etapa se duerme y de un monumento no.

Ahora el **nivel del destino** manda sobre lo que se pide:

| Nivel | Qué se pide |
|---|---|
| País o región | **Solo** ciudades, pueblos, comarcas, islas y valles: sitios donde dormir o hacer base. Cada uno con una frase de qué aporta a la ruta |
| Ciudad | Sitios concretos de dentro (barrios, monumentos, museos, mercados) y alguna excursión de día |

La prohibición del prompt de país va **con ejemplos**, que es lo que se cumple:
decir "nada de monumentos" se obedece a medias; decir *"Sagrada Familia NO, está
dentro de Barcelona"* se entiende a la primera.

El nivel viene del mapamundi (Nominatim contesta país o ciudad según el zoom) y
se guarda en `destinos.tipo`. **El que devuelve la IA se ignora**: a veces
contesta "ciudad" para un país entero y eso volvería a mezclarlo todo. Si un
destino antiguo no tiene nivel, se le pregunta a Nominatim antes de investigar.

Para limpiar lo ya investigado con la mezcla, la ficha de destino tiene dos
botones donde antes había uno:

- **Refrescar** — actualiza lo que hay sin borrarlo (el de siempre).
- **Reinvestigar** — borra los puntos y vuelve a preguntar desde cero. Es el que
  hace falta aquí: refrescar no quita la Sagrada Familia, hay que tirarlo todo.

---

## El lienzo: repartir lo apuntado por los días

```
/viaje/:viajeId/lienzo        ?etapa=ID para verlo filtrado
```

La mochila a la izquierda con lo apuntado que aún no tiene día, y los días a la
derecha con sus cuatro franjas. Se arrastra de una a otros.

### De dónde salen los días

De las etapas confirmadas, no de una tabla de días. El día 1 es la fecha de
inicio del viaje y hay tantos días como **noches**. Cada día cae dentro del
rango de una etapa (`fecha_inicio <= día < fecha_fin`) y, como las etapas van
encadenadas sin huecos, cada día pertenece a una y solo una:

```
Osaka 10→14 nov (4 noches)  ->  días 1, 2, 3, 4
Tokio 14→19 nov (5 noches)  ->  días 5, 6, 7, 8, 9
Kioto 19→24 nov (5 noches)  ->  días 10, 11, 12, 13, 14
```

### Una consulta, no sesenta

Quince días por cuatro franjas serían sesenta viajes a la base para pintar algo
que cabe en cinco `SELECT`. `lienzoDeViaje()` los hace una vez y reparte en
memoria: días, colocados, mochila, bloques fijos y avisos salen de la misma
pasada. Es también lo que devuelve la API tras cada cambio, para repintar sin
recargar.

### La tabla `itinerario`, rehecha

Existía desde el primer día pero nunca se usó (cero filas, ni una consulta), y
su `dia` guardaba una FECHA en una columna de texto. El lienzo necesita el
NÚMERO de día, y eso en una columna TEXT es una trampa: SQLite ordenaría el día
10 antes que el 2. Como no había datos, se rehízo con la forma correcta.

Lleva un `CHECK` que hace cumplir la regla del diseño:

```sql
CHECK ((candidato_id IS NOT NULL) <> (texto_manual IS NOT NULL))
```

Una fila es **o** una cosa colocada **o** un texto a mano. Nunca las dos, nunca
ninguna. Probado: la base rechaza los dos casos.

### Los bloques fijos de transporte

Los tramos resueltos se pintan en ámbar y no se arrastran. Van donde les toca:

| Tramo | Dónde cae |
|---|---|
| Vuelo de ida | Día 1, en la franja de su hora de llegada (mañana si no se sabe) |
| Entre etapas | Primer día de la etapa de destino |
| Vuelo de vuelta | Último día, en la franja de su hora de salida (tarde si no se sabe) |

Las horas salen del vuelo elegido: de la ida interesa cuándo se **aterriza** y
de la vuelta cuándo se **despega**.

**El tiempo de OSRM solo se enseña si el tramo va en coche o bus.** Poner
"Shinkansen · 5h35" al lado de un tren que tarda 2h15 no es un detalle feo: es
decirle a alguien una hora que no es.

### Los avisos

Se calculan al pintar y **no bloquean nada**: igual has puesto ahí el museo a
propósito porque piensas cambiar el vuelo.

| Aviso | Cuándo salta |
|---|---|
| *"Llegas a las 20:35 — tienes 1 cosa antes de llegar"* | Hay algo en una franja anterior a la de la llegada |
| *"Te vas a las 15:20 — tienes N cosas después de irte"* | Lo mismo al revés, el día de la vuelta |
| *"Cena en Pontocho empieza a las 21:00 (noche)"* | La hora de la tarjeta no cuadra con su franja |

El aviso sale en la cabecera del día y la tarjeta afectada se pone en rojo.

### Si mueven las fechas

El lienzo no toca la ruta. Si las fechas cambian allí y alguna fila queda con un
día que ya no existe, **no se borra**: vuelve a la mochila con el borde
discontinuo y un aviso *"Se movieron tus fechas: N cosas por recolocar"*.

### Desde la pantalla de etapa

Cada cosa apuntada gana **"Ponerlo en un día"**: un mini-selector con los días
de esa etapa y las cuatro franjas, sin abrir el lienzo. Lo ya colocado enseña
dónde está (*"Día 12 · mediodía"*) con enlace al lienzo, y arriba hay un botón
**"Ver el lienzo de esta etapa"** que lo abre ya filtrado.

### El botón de la IA

**Cascarón a propósito.** Existen el botón, el trabajo `opinar_lienzo` en la
cola, el sondeo y el hueco donde aterriza el resultado; lo que dice hoy es
*"La opinión de la IA llegará en la próxima versión."*. Cuando haya contenido
real solo hay que rellenar el medio.

---

## La etapa: el subproyecto de cada parada

```
/etapa/:etapaId          #ver | #dormir | #llegar
```

Tres pestañas con el mismo patrón que la ficha de ciudad. Lo importante es lo
que **no** tiene: código nuevo de catálogo, de hoteles ni de vuelos. Las cajas
son las mismas de siempre, enchufadas al contexto de una parada.

| Del viaje entero | De la etapa |
|---|---|
| `viaje.destino` | `etapa.nombre_ciudad` |
| `viaje.fecha_inicio/fin` | `etapa.fecha_inicio/fin` |
| `candidatos.viaje_id` | `candidatos.etapa_id` |

El truco para reutilizar los trabajos de la cola sin romper el wizard es
`trabajos.referencia_id`: un trabajo de **hoteles con referencia** es de una
etapa (y busca en su ciudad y sus fechas); **sin referencia** es el del viaje,
como toda la vida. Igual con los vuelos, donde la referencia es un tramo.

La tarjeta de hotel salió del paso 6 a `parciales/hotel.ejs` **sin tocarle el
aspecto**, y su círculo de elegir lo sigue manejando el código genérico de
`app.js`: por eso el endpoint de la etapa contesta `{ marcado }` y no otro
nombre. Lo mismo con la caja de excursión, que se reusa en modo solo lectura.

### Qué ver

Los sitios de `sitios_lugar` y las excursiones del catálogo de la ciudad, cada
uno con su interruptor **"Me lo apunto"**. Apuntar crea un `candidato` con
`etapa_id`; desapuntar lo borra. Lo apuntado se tiñe de `--tinte` con un tic.

Si la ciudad no tiene ficha profunda, se encola `investigar_ciudad` **una sola
vez**. Sin ese "una sola vez", una ciudad que falla (por ejemplo, sin clave de
IA) se re-encolaba en CADA visita: un bucle silencioso de trabajos condenados.

### Dónde dormir

El panel de Booking, con las fechas de la etapa. **No busca solo al entrar**:
abre un navegador y tarda, así que lo pide quien quiera pedirlo. Los filtros son
los del viaje.

Solo puede haber un hotel elegido por etapa: elegir otro suelta el anterior, y
volver a pulsar el que estaba lo deja sin elegir. El elegido sale destacado
arriba en verde con un botón "Cambiar".

Sin fechas (etapa en `recopilando`) no hay panel: un aviso con enlace a la ruta.

### Cómo llegar

Cada tramo enseña **distancia y tiempo de referencia**, calculados una vez con
OSRM y cacheados en `transportes.distancia_km` / `duracion_min`. Se recalculan
solos cuando el tramo cambia de puntas, porque al reordenar la ruta esa fila se
borra y la nueva nace sin distancia.

Hay un tope de **1.500 km** para el dato por carretera, y no es un capricho:
OSRM es más listo de lo que conviene y, preguntado por Barcelona → Tokio,
contesta tan tranquilo *"12.513 km, 158 horas"* atravesando Eurasia. Es cierto y
no le sirve a nadie. Por encima del tope se enseña la línea recta (Haversine,
calculada aquí sin pedir nada a nadie), que es la que dice a las claras que eso
es un vuelo: *"≈ 10.307 km en línea recta"*.

| Tipo de tramo | Cómo se resuelve |
|---|---|
| Extremos (casa→primera, última→casa) | **Buscar vuelos** con el panel de Kayak |
| Entre ciudades | **A mano**: tipo, notas y precio aproximado. Nada de scraping de trenes |

Los chips de la pantalla de ruta llevan a la pestaña "Cómo llegar" de la etapa
**de la que sale** el tramo (la ida, a la de la primera parada), y muestran el
resumen real: *"Tren · Shinkansen Hikari · ≈ 452 km"*.

**Una limitación conocida de los vuelos:** una tarjeta de Kayak es un ida y
vuelta, así que los tramos de los extremos buscan la ventana entera del viaje
(de la primera parada a la última). Si entras por una ciudad y sales por otra
—Osaka de ida, Kioto de vuelta— un ida y vuelta a la misma ciudad es una
aproximación. Lo correcto sería una búsqueda multidestino, y eso es tocar
`providers/kayak.js`. Mientras tanto el precio orienta, y el tramo siempre se
puede apuntar a mano.

### Notas y navegación

Bajo la cabecera hay un campo de notas plegado que guarda solo, 800 ms después
de dejar de escribir. Al pie, la parada anterior, la siguiente y la ruta entera.

---

## Mi ruta: las paradas del viaje

```
/viaje/:viajeId/ruta
```

Es la columna vertebral del modelo nuevo: el sitio donde un montón de ciudades
sueltas se convierte en una ruta con fechas. Se llega desde el atajo "Mi ruta"
de la tarjeta de embarque y desde el aviso que sale al añadir un sitio en
Descubrir.

### Todo pasa por `recalcularRuta()`

No es manía de ordenado: hay tres cosas que dependen unas de otras y tocarlas
por separado las descuadra en cuanto te despistas.

1. **El orden** tiene que ser 1, 2, 3… sin huecos. Si borras la 2ª parada, la 3ª
   pasa a ser la 2ª o el número del círculo miente.
2. **Las fechas** son derivadas y van en cascada: la primera empieza cuando
   empieza el viaje y cada una arranca donde acabó la anterior — ese día se
   viaja, no se duerme en dos sitios. Cambiar una noche en la primera parada
   mueve todas las demás.
3. **Los tramos** son los huecos ENTRE paradas, más la ida desde casa y la
   vuelta. Reordenar cambia qué salto es cuál.

Así que después de cada operación se recalcula la ruta entera y se persiste. Son
tres paradas y media: no hay nada que optimizar.

Un tramo que **sigue existiendo no se toca**, para no perder el transporte ya
elegido: si mueves Osaka al principio, el salto de Tokio a Kioto sigue siendo el
mismo y conserva su elección. Comprobado: tras reordenar, la fila
`Tokio → Kioto` seguía siendo la misma (mismo `id`).

### La API

| Ruta | Qué hace |
|---|---|
| `POST /api/etapas/:id/confirmar` | Un candidato pasa a la ruta, al final y con 1 noche |
| `POST /api/etapas/:id/quitar` | Fuera esa parada (y sus tramos) |
| `POST /api/etapas/:id/noches` | `{ delta: +1 \| -1 }`, mínimo 1 noche |
| `POST /api/viajes/:id/reordenar` | `{ ordenIds: [...] }` tras arrastrar |

Todas devuelven **la ruta entera recalculada** y el cliente repinta con eso. Es
más tráfico que mandar solo lo que cambió, pero cambiar una noche mueve las
fechas de todas las paradas siguientes y los tramos de en medio: con el estado
completo no hay forma de desincronizarse.

### El contador de noches

Cuenta **solo las etapas confirmadas**, y tiene cuatro caras:

| Estado | Qué dice |
|---|---|
| `faltan` | "Te quedan X noches por colocar" |
| `exacto` | "Cuadra perfecto ✓" en verde |
| `exceso` | "Te pasas en X noches…" en rojo, y la barra también |
| `sin_fechas` | "Define las fechas del viaje…" con enlace a la configuración |

Sin fechas los steppers **siguen funcionando**: se reparten noches igual y las
fechas de cada parada salen como "— → —". Poner fechas después las rellena
solas.

### Detalles

- Quitar un **candidato** es inmediato; quitar una **parada confirmada** pregunta
  antes con el modal de la app, porque mueve las fechas de todo lo que venga
  detrás.
- Reordenar va con drag & drop de HTML5 a pelo, sin librerías.
- La ciudad de casa sale de `ORIGEN_POR_DEFECTO` (`BCN`). El wizard todavía no
  pregunta el origen; el día que lo haga, `ciudadDeCasa()` es el único sitio que
  hay que tocar.
- La maqueta usaba emoji para los iconos (🏠 ⠿ ⚠ ✓). Aquí van los de Tabler,
  que es lo que usa el resto de la app.

**Tres nombres de clase chocaban** con los que ya usaba el paso 1 (`contador`,
`barra`) y las tarjetas de vuelo (`tramo`). Las nuevas se llaman
`ruta-contador`, `ruta-barra` y `ruta-tramo`: renombrar las mías era lo seguro,
tocar las viejas habría roto pantallas que van bien.

### Lo que todavía no hace

Los chips de transporte y el botón "Abrir etapa" llevan a `/etapa/:id`, que hoy
es un **placeholder** ("En construcción"). Lo mismo con
`/viaje/:viajeId/lienzo`. Las filas de `transportes` sí se crean y se mantienen
de verdad: cuando llegue la búsqueda, los tramos ya estarán ahí esperando.

---

## Elegir destino: el mapamundi

```
/elegir-destino/:viajeId
```

Sustituye al campo de texto que había en el paso 2. La diferencia no es
estética: escribir "Japón" exige saber ya a dónde vas, y mirar el mapa no. El
buscador sigue arriba para quien lo tenga decidido.

El flujo del wizard queda: **configuración → mapamundi → descubrir**. El paso 2
ya no tiene formulario, y su GET redirige aquí para que el enlace de la tarjeta
de embarque siga funcionando.

### Las teselas: CARTO ya no vale

El plan era CARTO Voyager, pero **ya no es gratis sin clave**. Y engaña: sus
teselas siguen devolviendo `200` con una imagen, solo que la imagen es un cartel
de *"API KEY REQUIRED"* estampado sobre el mapa. No falla, sale feo.

Como aquí no se usa nada que pida clave, el mapa va con las teselas del
**Humanitarian OSM Team** (`tile.openstreetmap.fr/hot`): libres, sin registro,
con un color más cálido y menos ruido que las estándar de OSM. Se les baja un
poco la saturación por CSS (solo al `leaflet-tile-pane`, para no despintar el
marcador ni los controles). La atribución va abajo a la derecha y es obligatoria.

Comprobado el 06/09/2026: Wikimedia responde `403` a peticiones externas y
Stadia `401`. Las de HOT y las estándar de OSM son las dos únicas que funcionan
sin clave.

### Geocodificación: SIEMPRE desde el servidor

Nominatim (el buscador de OpenStreetMap) se llama desde
`services/geocodificar.js`, nunca desde el navegador. Tres razones:

1. **Exige un User-Agent** que identifique a la aplicación. Sin él banea, y
   desde el navegador no se puede poner: manda el suyo.
2. **Una petición por segundo como máximo.** Desde el navegador, alguien
   nervioso clicando el mapa manda diez en dos segundos. Aquí se ponen en fila,
   encadenando cada una a la anterior.
3. La **caché en memoria** sirve para todos: clicar dos veces en el mismo sitio
   no sale del servidor. La clave redondea a dos decimales (~1 km), porque dos
   clics a un dedo de distancia son el mismo sitio.

| Ruta | Qué hace |
|---|---|
| `GET /api/geocodificar?lat&lon&zoom` | De un punto del mapa a un sitio con nombre |
| `GET /api/geocodificar-texto?q` | Del buscador a unas coordenadas |
| `POST /api/destinos/elegir` | Guarda el destino y lleva a descubrir |

### Qué nivel de detalle se pide

El `zoom` de Nominatim decide si contesta el país o el pueblo. Se saca del zoom
del mapa, que es lo que dice qué está mirando la persona:

| Zoom del mapa | Zoom Nominatim | Qué devuelve |
|---|---|---|
| ≤ 4 | 3 | País |
| 5-7 | 8 | Región o ciudad grande |
| ≥ 8 | 12 | Ciudad o pueblo |

Quien mira el mundo entero y toca España quiere España, no el pueblo que haya
debajo. Del `address` se coge `country` y, como ciudad, el primero que exista de
`city` / `town` / `village` / `state` — que son cuatro nombres distintos para lo
mismo según dónde caiga el dedo.

### La tarjeta de abajo

Sube deslizándose (`transform`, 0,35 s) y tiene tres caras: "Identificando el
lugar…" con tres puntitos, el sitio encontrado, o el "ahí solo hay agua". Vive
siempre en el DOM y sube o baja con una clase: montarla y desmontarla con cada
clic haría imposible animarla.

El botón **Investigar X** pasa por `elegirDestinoParaViaje()`, que es el único
sitio por el que cambia el destino de un viaje, porque son cuatro cosas
encadenadas y olvidarse de una deja la base coja: el viaje apunta al destino, su
etapa le sigue, los avisos caducan y se re-encolan, y el destino entra en el
catálogo. **Si el destino ya estaba investigado se entra directo con la caché,
sin encolar nada.**

---

## Descubrir destino (mapa + carrusel)

Es la pantalla nueva: escribes "Japón" en el paso 2 del wizard y, en vez de ir
al paso 3, entras a un mapa con los imprescindibles del país.

```
/descubrir/:destinoId?viaje=:id
```

El id de la ruta es el del **destino del catálogo**, no el del viaje. Es a
propósito: el mismo Japón se mira desde viajes distintos, y lo único que cambia
entre uno y otro es qué sitios ya están en esa ruta. Sin `?viaje=` la pantalla
se ve igual pero no deja añadir nada.

### Las dos fuentes, y por qué son dos

| Paso | Fuente | Qué aporta |
|---|---|---|
| 1 | **IA** (`/v1/messages`) | QUÉ hay que ver: 12-15 sitios con categoría, coordenadas, días recomendados y por qué merecen la pena |
| 2 | **Wikipedia en español** (API de resúmenes) | CÓMO SE VE: la foto y el enlace al artículo |

Las fotos **no** se le piden a la IA a posta. Una URL de imagen inventada es una
imagen rota, y un modelo no tiene forma de saber si un fichero existe.
Wikipedia sí, porque se le pregunta. Lo que sí se le pide a la IA es el
`titulo_wikipedia` exacto, que es lo que se busca después.

Wikipedia va con **350 ms de pausa entre peticiones**. No es prudencia
decorativa: las 15 seguidas a pelo tardan 1,7 s y a partir de la sexta contesta
`429` y se quedaban sin foto sitios que sí tienen artículo. Con el respiro tarda
unos 6 s y entran todas. Misma regla que con los scrapers.

Un sitio sin artículo, sin foto o con página de desambiguación se queda con la
imagen a null y la tarjeta pinta el placeholder de color con su icono. Nunca
tumba la investigación entera.

### La clave de IA

Se lee de `.env` (hay un `.env.ejemplo` al lado):

```
ANTHROPIC_API_KEY=sk-ant-...
MODELO_IA=claude-haiku-4-5
```

**Sin clave la app arranca igual.** Solo fallan los trabajos que de verdad la
necesitan, y lo hacen con el mensaje *"Falta configurar la clave de IA en .env"*
en la pantalla, con su botón de reintentar. `.env` está en el `.gitignore`.

`lib/ia.js` exige en el system prompt que se responda solo con JSON, limpia el
```json que llegue igualmente, y **reintenta una vez** si no parsea. Una, no un
bucle: si a la segunda tampoco es JSON, algo va mal de verdad y prefiero
enterarme a gastar tokens en silencio.

### Los marcadores

Leaflet con teselas de OpenStreetMap: gratis, sin clave, y con la atribución
`© OpenStreetMap` en la esquina, que es obligatoria y no se quita.

Nada de la chincheta azul de Leaflet: los marcadores son HTML con los colores
del tema, y el estado se lee de un vistazo.

| Estado | Marcador |
|---|---|
| Sin investigar | Punto blanco con borde gris |
| Investigándose | Borde azul y un aro discontinuo girando |
| Investigada | Relleno azul claro con un tic |
| La que se está mirando | La de su estado, más grande y con halo |

### Mapa y carrusel, atados

Tocas un marcador y el carrusel va a su tarjeta; deslizas el carrusel y el mapa
centra su marcador. Hecho a lo tonto eso se muerde la cola (mover uno mueve el
otro, que mueve el primero...), así que hay un cerrojo que corta el eco mientras
dura el desplazamiento, y el scroll espera 120 ms a que pares antes de mover el
mapa: seguirlo píxel a píxel marea.

### Los botones de la tarjeta

- **[Investigar]** — encola `investigar_ciudad`. El botón pasa a "Investigando…"
  con su rueda y el marcador se pone a girar. Cuando termina, la tarjeta pasa a
  **[Ver ficha]** y lleva a la ficha profunda (ver más abajo).
- **[A mi ruta]** — **siempre visible**, se haya investigado o no. Crea una etapa
  en estado `recopilando`, sin noches y sin fechas, y el botón pasa a
  "En tu ruta ✓" deshabilitado. Sin salir de la pantalla y sin recargar.

`recopilando` significa justo eso: me interesa, todavía no sé cuánto me quedo.
Cuando se confirme y se le pongan noches, `recalcularFechasEtapas` le pondrá las
fechas.

### Entrar y actualizar

Al confirmar el destino en el paso 2:

- si ya está investigado en el catálogo → entra directo, con la caché;
- si no → encola `descubrir_destino` y entra enseñando el estado de carga.

La fila de `destinos` se crea **siempre**, aunque no sepamos nada del sitio,
porque la pantalla necesita un id al que ir mientras la IA piensa.

El botón de refrescar junto a la pill de frescura ("Investigado hoy / hace X")
vuelve a lanzar la investigación. Los puntos **se actualizan, no se duplican**:
hay un índice único por `(destino_id, nombre_norm)`, así que el Kioto de hoy es
el Kioto de la semana pasada con los datos al día.

Ojo con una cosa: reinvestigar el país **no** toca el `investigado_en` de los
puntos. Ese campo dice si un punto tiene ficha profunda, y pisarlo borraría
trabajo ya hecho.

### Lo que NO cambia todavía

Los pasos 3 a 7 del wizard antiguo siguen exactamente igual. El paso 2 ahora
lleva aquí en vez de al paso 3, y nada más.

---

## Ficha profunda de una ciudad o un sitio

```
/sitio/:puntoInteresId?viaje=:id
```

Se llega desde el botón **[Ver ficha]** de la tarjeta del carrusel, o desde el
globo del marcador en el mapa (solo los marcadores ya investigados llevan globo:
uno que no lleva a ningún sitio solo estorba).

### Qué hace el trabajo `investigar_ciudad`

Cuatro pasos, y el orden importa:

1. **La IA** dice qué hay dentro: 6-10 lugares concretos (templos, barrios,
   mercados, miradores) con coordenadas, más un `parrafo_por_que` y un
   `como_moverse`.
2. **Wikipedia** le pone foto y enlace a cada uno, con los mismos 350 ms de
   pausa entre peticiones que en la investigación del destino.
3. **Se guarda.** A partir de aquí ya hay ficha aunque lo siguiente falle.
4. **Solo si es una ciudad**: las excursiones de Civitatis, y solo si no las
   teníamos ya cacheadas.

El paso 4 va el último y en su propio `try/catch` a posta: es el que abre el
navegador y el que más veces va a fallar. Si Civitatis se pone tonto, la ficha
está guardada y la pantalla se ve entera menos la pestaña de excursiones.
Al revés sería absurdo: perder la ficha por unos free tours.

Lo que se le pide a la IA en `descripcion` no es un resumen de enciclopedia
— para eso ya está el enlace a Wikipedia — sino **consejo práctico**: a qué hora
ir, qué no perderse, cuánto tiempo hace falta.

### La caché de excursiones, en acción

Aquí se ve para qué sirvió mover la caché de actividades del viaje a la ciudad:

```
Lisboa: 28 en caché -> no se scrapea
Kioto:   0 en caché -> Civitatis (21,9 s, 30 actividades)
Segunda vez: 30 en caché -> se salta Civitatis
```

Investigar Kioto desde otro viaje ya no vuelve a abrir el navegador.

### La pantalla

Cabecera con la foto del punto a sangre (o un bloque de tinte con icono grande
si no hay), nombre, "Recomendado: X-Y días · Investigada [cuándo]", botón de
volver al mapa y **[Añadir a mi ruta]** — que pasa a "En tu ruta ✓" sin recargar.

El velo oscuro sobre la foto va fuerte a propósito: muchas imágenes de Wikipedia
son montajes con bandas blancas (la de Kioto, sin ir más lejos) y con un velo
suave el chip de "CIUDAD" desaparecía justo encima de una de esas bandas.

Tres pestañas tipo píldora, y solo se ve la activa:

| Pestaña | Qué lleva |
|---|---|
| **Resumen** | La tarjeta "Por qué merece la pena" y una rejilla con días recomendados, cómo moverse, nº de sitios y nº de excursiones |
| **Qué ver (n)** | Mini-fichas plegables (`<details>` del propio HTML, sin librería): foto de 56 px, nombre y una línea. Al abrir, la descripción entera y los enlaces "Wikipedia" y "Ver en mapa" (OpenStreetMap centrado en sus coordenadas, en pestaña nueva) |
| **Excursiones (n)** | Las cajas de Civitatis de siempre, leídas del catálogo. **Solo para ciudades** |

Las excursiones se pintan con el mismo componente que el catálogo
(`parciales/tarjeta.ejs`), pero en **modo solo lectura**: llevan enlace a
Civitatis en vez del círculo de marcar. Son actividades del catálogo, de la
ciudad, y no candidatas de ningún viaje: no cuelgan de ninguna etapa todavía,
así que no hay nada que marcar.

Si la investigación sigue en curso, la pantalla **enseña lo que ya haya** y
añade arriba una franja "Completando la ficha…" con la rueda, que sondea cada
5 s y recarga sola al terminar.

### Un detalle de las etapas

Añadir a la ruta un punto de categoría `sitio` crea la etapa con el nombre de su
**ciudad base**, no el del sitio: del Monte Fuji se duerme en Hakone. La misma
función (`anadirPuntoALaRuta`) la usan el mapa y la ficha, para que el botón
haga exactamente lo mismo en las dos pantallas.

---

## El modelo de datos: catálogo y viaje

Las tablas están partidas en dos mundos, y la línea que los separa es esta:

> **catálogo** = conocimiento estable, vale para cualquier viaje futuro.
> **viaje** = mis decisiones y mis cotizaciones, con fechas.

Dicho de otra forma: *"qué se puede ver en Lisboa"* es catálogo y no caduca;
*"cuánto cuesta el hotel del 19 al 22"* es viaje y caduca en cuanto muevo las
fechas.

### Catálogo (sin `viaje_id` en ninguna tabla)

| Tabla | Qué guarda |
|---|---|
| `destinos` | El ámbito que se investiga: un país, una región o una ciudad. `investigado_en` dice si la ficha está fresca |
| `puntos_interes` | Los ~15 imprescindibles de un destino. Pueden ser **ciudades** (Tokio) o **sitios** que se visitan desde una ciudad (Monte Fuji, con `ciudad_base` = "Hakone") |
| `sitios_lugar` | La ficha profunda de un punto: los templos, barrios y mercados **de** esa ciudad |
| `catalogo_actividades` | Caché de Civitatis **por ciudad normalizada**, no por viaje |

Lo de la caché es el cambio con más efecto práctico: antes las actividades solo
vivían dentro de cada viaje, así que ir dos veces a Lisboa significaba scrapear
Lisboa dos veces. Ahora la ciudad es la clave (`ciudad_norm`: sin acentos ni
mayúsculas), y el segundo viaje se aprovecha del primero.

### Viaje

| Tabla | Qué guarda |
|---|---|
| `viajes` | La cabecera. **`destino` es ahora el ÁMBITO** ("Japón"), no una ciudad |
| `etapas` | Las paradas de la ruta: ciudad, orden, noches, fechas y estado |
| `transportes` | Cómo se va de una etapa a la siguiente. `etapa_origen_id` a null = ida desde casa; `etapa_destino_id` a null = vuelta a casa |
| `candidatos` | Lo que se puede marcar. **Hoteles y actividades cuelgan de una `etapa_id`; los vuelos, de un `transporte_id`** |
| `itinerario` | El reparto por días, con `etapa_id` para poder mirar una etapa o el viaje entero |
| `avisos` | Clima, seguridad y festivos |

### Estados de una etapa

- **`recopilando`** — ciudad que estoy mirando y que **aún no entra** en el
  itinerario. No tiene fechas: todavía no ocupa sitio en el calendario.
- **`confirmada`** — entra, con sus noches asignadas.

### Las fechas de las etapas son derivadas

No se editan a mano. Salen de la fecha de inicio del viaje, del orden de las
etapas y de las noches de cada una, encadenando: la etapa siguiente empieza el
día en que acaba la anterior, porque ese día se viaja y se duerme ya en la
ciudad nueva.

Todo eso vive en una sola función, `recalcularFechasEtapas()`
(`services/etapas.js`), que se llama cada vez que cambia algo de lo que
dependen.

### Un viaje de un destino es un viaje de UNA etapa

Es la pieza que hace que el cambio no rompa nada. Mientras el wizard siga
preguntando por un destino y dos fechas, `sincronizarEtapaUnica()` mantiene esa
etapa pegada a `viajes.destino`: cambiar el destino le cambia el nombre, cambiar
las fechas le cambia las noches. En cuanto un viaje tenga más de una etapa, esa
función se aparta y manda la ruta.

### Qué hizo la migración `2026-09-etapas-y-catalogo`

No borró **nada**: ni una columna ni una fila. Solo añadió.

- Creó las tablas nuevas y las columnas `candidatos.etapa_id`,
  `candidatos.transporte_id` e `itinerario.etapa_id`.
- A cada viaje existente le creó **una etapa confirmada** con su destino, orden
  1 y las noches que durase, más sus dos transportes (ida y vuelta).
- Colgó de ahí sus candidatos: hoteles y actividades de la etapa, vuelos del
  transporte de ida (hoy una tarjeta de Kayak trae ida y vuelta juntas).
- Volcó al catálogo las actividades de Civitatis que había en los viajes,
  deduplicadas por ciudad: 435 candidatos intactos, 200 actividades únicas en el
  catálogo a partir de 222 repartidas por ocho ciudades.

Las columnas viejas siguen donde estaban y marcadas como tales en los
comentarios del esquema. Nada de la interfaz cambió en esta fase.

---

## De dónde sales

El origen de los vuelos no se pregunta en el wizard: está fijo en
`services/proveedores.js`, en `ORIGEN_POR_DEFECTO` (ahora `'BCN'`). Cámbialo ahí
si te mudas.

El destino se traduce a código IATA con `lib/iata.js`, que tiene ~100 ciudades
habituales desde España. Son códigos de **ciudad**, no de aeropuerto: `PAR`
incluye Charles de Gaulle, Orly y Beauvais. Si buscas un destino que no está,
el trabajo acaba en error con el mensaje *"No conozco el código de aeropuerto
de «X»; añádelo a lib/iata.js"* — y añadirlo es una línea.

---

## Responsive

Una sola app que se adapta, no dos versiones. Un único punto de ruptura en
`900px`:

- **Móvil (base):** tarjetas a una columna, barra de acción **fija abajo** a mano
  del pulgar con el contador de selección.
- **Escritorio (≥900px):** rejilla de 3 columnas, panel lateral derecho de 220px
  con la selección siempre visible, etiquetas de paso en la barra de progreso, y
  la barra de acciones vuelve al flujo normal.

---

## La pestaña abierta la decide el servidor

La pantalla de etapa se recarga entera muchas veces: cada vez que termina una
búsqueda, al apuntar algo, al elegir un hotel, al ordenar la lista. Unas veinte
llamadas a `location.reload()` y un sondeo que recarga cuando baja el número de
trabajos en marcha.

Y hasta ahora la plantilla traía `pestana--activa` **clavada en "Qué ver"**, con
los otros paneles en `hidden`. La pestaña que estabas mirando volvía después,
cuando `etapa.js` —75 KB— acababa de descargarse y ejecutarse. Medido en local
con todo en caché: **214 ms de "Qué ver" en pantalla** antes de recuperar la
tuya. Por la red, más. Eso era el salto.

Se intentó arreglar dos veces, y las dos se arregló lo mismo: **dónde acabas**.
Primero con el ancla (`#dormir`), después con `sessionStorage`. Las dos
funcionan. Pero el salto no es el final del viaje, es el principio.

Ahora la pestaña va en la **query** (`?p=dormir&sp=sub-comer`) y no en el ancla,
porque el ancla **no llega al servidor**: el navegador se la queda. En la query
sí llega, así que la página nace ya con la pestaña buena y no hay nada que
reponer.

Tres piezas:

- `vistaPedida(req.query)` en las rutas valida contra la lista conocida y
  cualquier cosa rara cae en la primera.
- La plantilla pinta la activa desde `vista`, pestañas y subpestañas.
- `mostrar()` y `mostrarSub()` mantienen la URL al día con `replaceState`.

Los enlaces que hacen viaje de ida y vuelta al servidor —ordenar hoteles,
ordenar vuelos, los redirects— llevan ahora `&p=…`. Con `#dormir` se perdía la
pestaña en el camino.

Queda un guión en línea, sin `defer`, para el único caso que la URL no cubre:
llegar sin parámetros teniendo algo guardado. Se ejecuta antes de pintar.

**La subpestaña importaba aún más que la pestaña**, porque "Comer" y "Moverse"
viven dentro de "Qué ver": buscar un restaurante y esperar el resultado te
devolvía a "Sitios" en cada recarga.

## Pulsar no es arrastrar

`.carrusel--agarrado .tarjeta-punto { pointer-events: none }` es necesaria
mientras se arrastra: sin ella el navegador selecciona texto y las tarjetas se
comen el gesto. El problema era **cuándo** se ponía la clase: en `pointerdown`,
o sea en cualquier pulsación.

Desde el instante en que apoyabas el ratón, las tarjetas dejaban de existir para
el puntero. El `pointerup` y el `click` aterrizaban en el `.carrusel` en vez de
en la tarjeta, y ahí se caían dos cosas de golpe:

- El manejador de la ficha hace `ev.target.closest('.tarjeta-punto')` y le salía
  `null`: seleccionar una ficha no hacía nada.
- Un `<label>` que nunca recibe el clic no cambia su casilla ni dispara
  `change`: "Ciudad de entrada" tampoco hacía nada.

**En el móvil funcionaba** porque el táctil se sale antes (`pointerType ===
'touch'`) y la clase no llegaba a ponerse. De ahí lo desconcertante: el dedo sí,
el ratón no.

La clase se pone ahora al pasar el umbral de seis píxeles, cuando ya se sabe que
es un arrastre. Y de paso: `soltar()` reinicia `recorrido` siempre —un arrastre
que acabara fuera del carrusel no trae clic detrás y dejaba el valor viejo,
envenenando el siguiente clic legítimo— y el guardián de clics exime los
controles en vez de cancelarlo todo.

## Líneas también a las candidatas

Se dibujaban solo a las ciudades ya seleccionadas, por miedo a la telaraña. El
resultado era peor: la ficha decía "A 598 km de Cracovia" y en el mapa no había
ni rastro de esa línea. El dato estaba calculado —y pagado— pero no se veía
dónde caía, que es justo para lo que se mira un mapa.

Ahora la tiene toda ciudad con distancia, y se distinguen por el trazo: la ruta
va marcada y continua (2 px, `5 5`), la candidata fina y de puntos (1 px,
`1 6`). Las de la ruta se pintan las últimas para quedar por encima al cruzarse.

## Las teselas, de los dos mapas

Hay DOS pantallas con mapa y solo una tenía código de Google: la de descubrir
un destino. El mapamundi de elegir destino seguía con OpenStreetMap y no se
había enterado de nada.

Eso explica un síntoma que despistó mucho: en el mapamundi **no había ningún
error de Google en consola ni una sola petición a `maps.googleapis.com`**. No
es lo que se ve cuando algo falla; es lo que se ve cuando el código no existe.
Buscar la causa en la clave o en la API era buscar donde no estaba.

Ahora las teselas viven en `public/js/mapa-teselas.js` y las usan las dos:
`Teselas.poner(mapa, { clave, contexto })`. Google en español primero, OSM de
respaldo, y una sola implementación que mantener.

En un mapamundi el idioma se nota más que en ningún sitio: con OSM los nombres
salen en su lengua local (Warszawa, Milano) y con Google en español (Varsovia,
Milán). Elegir a dónde vas leyendo topónimos en polaco es peor de lo que parece.

## Cuando el mapa se cae a OpenStreetMap, se entera todo el mundo

El respaldo funcionaba bien y esa era la trampa: se caía a OSM con un
`console.warn` de una línea, el mapa se veía "igual que antes" y estuvimos con
las teselas de Google desactivadas sin saberlo. Ahora el aviso lleva el motivo,
el dominio y dónde mirar en Google Cloud Console. Es ruido a propósito.

(Con `RefererNotAllowedMapError` la API carga sin quejarse y **no** dispara
`gm_authFailure`; por eso `teselasDeGoogle` no se fía y comprueba que de verdad
haya pintado antes de darlo por bueno.)

## Los códigos IATA ya no se escriben a mano

`lib/iata.js` era una lista fija, y si la ciudad no estaba, la búsqueda de
vuelos moría con un "añádelo a lib/iata.js": pedirle a alguien que edite código
fuente para buscar un vuelo.

La lista se queda como semilla —es correcta, gratis, sin red, y sabe cosas que
importan, como que `PAR` son los tres aeropuertos de París y no solo CDG—, pero
lo que no esté se resuelve solo con la IA y se guarda en `iata_ciudades`. El
orden es **caché → lista → IA**, con la caché primero para que una corrección
escrita a mano en la tabla mande sobre todo lo demás.

Cádiz es el caso que lo explica: no tiene aeropuerto, hay que saber que le toca
Jerez (**XRY**), y eso una lista escrita a mano no lo adivina. Cada ciudad se
pregunta una vez en la vida de la base de datos; los "no lo sé" también se
guardan, para no repetir la llamada en cada reintento.

## Borrar un viaje se lo lleva todo lo suyo

Antes se borraba el viaje y se dejaba intacto el catálogo, con el argumento de
que borrar el viaje a Japón no debe borrar lo que sabemos de Japón.

El argumento sigue valiendo **cuando hay más viajes**. Deja de valer cuando ese
catálogo lo trajo este viaje y no lo usa nadie más: entonces no es conocimiento
compartido, es el rastro de una prueba. Y repetir la prueba desde cero era
imposible, porque la segunda vez todo salía de la caché.

Ahora se limpia también lo huérfano, y **solo** lo huérfano: restaurantes,
transporte urbano, excursiones y tramos de las ciudades que ya no visita ningún
viaje; las ciudades investigadas y sus sitios si su destino no lo usa nadie; y
las direcciones que apuntaban a algo que ya no existe (`direcciones` guarda
(tipo, id) contra seis tablas, así que SQLite no puede limpiarla sola).

Si otro viaje pisa la misma ciudad, no se toca nada de ella. Es la diferencia
entre limpiar y romper.

Y como ahora se lleva más por delante, hay que **escribir el nombre del viaje**
para que se encienda el botón. Se compara sin distinguir mayúsculas ni espacios
de más: la ceremonia es para obligar a leer cuál es el viaje, no para jugar a
las adivinanzas.

---

## Antes de viajar

Una ficha por país con lo que hace falta para **entrar** (documento, visado,
vacunas, seguro) y lo que hace falta **saber** (moneda, dónde cambiar, festivos
durante el viaje, recomendaciones de Exteriores).

Vive en "Mi ruta" y no en la etapa, y el botón está **siempre visible** con el
ámbar de los avisos de la casa. No es un detalle de estilo: un visado se tramita
con semanas y una vacuna con más, así que esto se consulta mientras se organiza.
Un enlace discreto en un menú se descubre el día antes de salir, que es cuando
ya no sirve de nada.

**Una pestaña por país, deducidas solas** de las paradas. Si el viaje cruza a
otro país aparece la segunda sin que nadie diga nada; si es a uno solo, la barra
de pestañas ni se pinta.

### De dónde sale cada cosa

| | Fuente |
|---|---|
| Festivos | Nager.Date |
| Recomendaciones de seguridad | exteriores.gob.es |
| Papeles, salud, dinero | la IA configurada |

Las tres van **en paralelo**. En fila tardaba diecisiete segundos, y no porque
hubiera mucho que hacer: la página de Exteriores agotaba su plazo de doce
mientras las otras dos esperaban turno sin motivo. `allSettled` y no `all`,
porque aquí el objetivo es el contrario de "si una falla, aborta": si una falla,
las otras dos tienen que llegar igual, y lo que no se pudo consultar se dice en
la propia ficha en vez de esconderlo. Exteriores se cae con cierta alegría —en
las pruebas devolvió 503 desde su WAF varias veces seguidas—.

### Se guarda por país + fechas, no por viaje

Los festivos y los avisos dependen de cuándo se va, pero dos viajes a Portugal
la misma semana comparten ficha y no hay por qué pagar dos veces la llamada a la
IA. Con eso, abrir el panel es instantáneo: enseña lo guardado y solo pide lo que
falte.

`generado_en` es la pieza importante. Si lo generado pasa de 30 días **y** el
viaje está a menos de 90, la ficha se marca como "conviene actualizar", con una
banda ámbar dentro y un punto en la pestaña del país. Las dos condiciones a la
vez: un dato de hace dos meses para un viaje que es dentro de un año no urge; el
mismo dato a dos semanas de salir, sí.

### El país se guarda en la parada

Averiguarlo es geocodificar la ciudad, y eso es una petición por parada. Al
principio se hacía en cada apertura del panel; ahora se resuelve una vez y se
queda en `etapas.pais` y `etapas.codigo_pais`. Abrir el panel pasó de geocodificar
todas las ciudades a **6 ms**.

Y hacía falta por otra razón: el dosier se arma sin red y de forma síncrona, así
que no puede geocodificar. Su filtro por país se quedaba vacío y, como la tabla
de fichas se comparte entre viajes con las mismas fechas, el dosier de un viaje a
Polonia llegó a llevarse la ficha de Chequia de otro. Ahora, si un viaje no tiene
países resueltos, el dosier no enseña la sección en vez de enseñarlo todo: que
falte se nota y se arregla abriendo el panel; que sobre un país equivocado no se
nota y engaña.

---

## El mapa de la parada

Cuarta pestaña de la etapa. Un mapa de la ciudad con **todo lo que el viaje
tiene en ella**: el hotel elegido, los sitios y excursiones apuntados, y los
restaurantes apuntados. Sirve para una pregunta que una lista no contesta —si el
museo está a diez minutos del hotel o al otro lado del río— y para nada más:
aquí no se añade, no se edita y no se borra.

El hotel va más grande porque es la referencia contra la que se lee todo lo
demás, y cada tipo lleva su color con una leyenda pequeña al lado del título.
El encuadre se ajusta solo a lo que haya; con un solo marcador se centra y se
pone un zoom de barrio, porque `fitBounds` sobre un punto deja un cuadro de área
cero y el mapa se va al zoom máximo, que en una ciudad es ver una acera.

### De dónde salen las coordenadas

Primero de la tabla `direcciones`, cuando el sitio ya está geocodificado; si no,
del propio catálogo: `puntos_interes` y `sitios_lugar` traen lat/lon de serie.
Los restaurantes y las excursiones no las traen y dependen de que se haya
geocodificado su dirección.

**Lo que no se puede situar se cuenta, no desaparece.** Que falte algo del mapa
sin decir nada hace pensar que el mapa está roto; decir "1 sitio no está porque
no tiene dirección situada: Excursión a Consuegra" hace pensar que falta una
dirección, que es lo que pasa de verdad.

Con el hotel hay **tres** estados y tres frases, porque confundirlos hace que la
pantalla mienta: no hay hotel elegido; hay hotel pero sin dirección situada (que
es común y no es lo mismo); y hotel en el mapa.

### Las distancias no se calculan aquí

Se leen de los traslados ya guardados, los que se consultaron desde "Moverse" o
desde las fichas. Abrir este mapa no dispara ni una petición a Routes ni a OSRM:
enseña lo que hay y calla lo que no. De los modos disponibles se elige andando
primero, que es la pregunta que se hace mirando un mapa de ciudad.

### Se monta tarde, y a propósito

Leaflet necesita que su contenedor tenga tamaño para calcular el encuadre, y
esta pestaña nace oculta: montarlo al cargar daría un mapa de cero píxeles con
los marcadores amontonados en una esquina. Se monta la primera vez que se abre
la pestaña —vigilando el atributo `hidden` del panel, no el clic, para que
funcione igual venga de un clic, de la URL o del guión que repone la pestaña— y
al cargar si el servidor la pintó ya abierta con `?p=mapa`.

### Preparado para el recorrido de un día

`pintar(lista, opciones)` no sabe de dónde sale la lista ni qué representa. Si un
elemento trae `orden`, el marcador enseña el número en vez del icono; con
`unir: true` se dibuja la línea que los une en ese orden. Las dos cosas están
escritas y probadas, pero **nadie las enciende todavía**: el día que esto tenga
que enseñar las paradas de un día numeradas, es pasarle esa lista y ya. El
pintado no hay que tocarlo.

Las teselas son las mismas que las del mapa de destinos, del mismo módulo
(`public/js/mapa-teselas.js`): Google en español y OpenStreetMap de respaldo,
avisando por consola con el nombre de la pantalla.

---

## Configura tu viaje, rehecha

Era la última pantalla con la estética vieja: dos `<input type="date">` y unos
chips que no se parecían a nada del resto. Ahora sigue `maqueta-configuracion.html`:
calendario de rango de dos meses, contadores circulares, chips de tipo,
segmentado de ritmo, campo de presupuesto y barra fija abajo.

**Es un cambio de interfaz, no de modelo.** El POST va al mismo sitio, con los
mismos nombres de campo, y el servidor no se ha tocado. Los controles nuevos
escriben en campos ocultos: `fecha_inicio`, `fecha_fin`, `adultos`, `ninos`,
`edades_ninos` (repetido, uno por niño), `tipo_viaje` (CSV), `ritmo` y
`presupuesto`. Los efectos de siempre siguen ocurriendo: al cambiar las fechas
se resincronizan las etapas y se reencolan los avisos, y al cambiar fechas o
viajeros se tiran los candidatos de vuelo y hotel sin marcar.

### El CSS cuelga de `.config`, y no es manía

La maqueta usa nombres genéricos —`.tarjeta`, `.chip`, `.chips`, `.contador`,
`.campo`, `.edades`, `.edad`— y **los siete existen ya en `estilo.css`** con
otra pinta. Sin prefijo, o esta pantalla salía vestida de otra o le cambiaba la
ropa a media aplicación. Las 72 reglas del archivo empiezan por `.config`, así
que ni una sale de aquí.

### Dos cosas de la maqueta que no se copiaron

- **Los chips de tipo.** La maqueta trae siete (añade Aventura, Compras y Vida
  nocturna) y aquí van los cinco que existen hoy. Meter valores nuevos sería
  cambiar los datos, no la pantalla.
- **La edad del niño.** La maqueta define al niño como "de 0 a 11 años" y al
  adulto "de 12 en adelante"; aquí se mantiene 0-17 y adultos desde 18. No es un
  detalle de texto: cambiarlo movería a un chaval de quince de una columna a la
  otra y las búsquedas de vuelos y hoteles lo cobrarían distinto.

También se respetan los topes del modelo —de 1 a 9 adultos, de 0 a 6 niños—
apagando el "+" al llegar. La maqueta no ponía tope porque no guardaba nada, y
enseñar un botón que no hace nada es peor que apagarlo.

### El botón dice la verdad

Sin las dos fechas el servidor rechaza el guardado, así que el botón nace
apagado y el resumen de al lado dice qué falta: "Elige las fechas para
continuar", "Falta el día de vuelta" o "La vuelta tiene que ser posterior a la
ida" cuando se marca dos veces el mismo día. Enseñar un botón que va a fallar es
hacer que alguien descubra el error después de pulsarlo.

El calendario abre por el mes de la ida si ya la hay —al editar, lo normal es
querer ver lo que elegiste— y por el actual si no. Atrás no se puede ir más allá
del mes en curso: los días pasados están deshabilitados y un calendario de meses
vacíos no lleva a ninguna parte.

---

## El lienzo avisa de los tiempos que no cuadran

Si sales de un sitio a las 15:00 y el trayecto son dos horas, a las 15:30 no
estás en el siguiente. Sobre el papel del lienzo eso no se ve —dos tarjetas
seguidas parecen igual de seguidas midan lo que midan— y solo se descubre
andando por la ciudad con prisa.

La regla es literal: **hora de fin del primero + trayecto > hora de inicio del
segundo**. El fin es su hora más su duración; sin duración tecleada se toma la
hora de inicio, que es lo prudente.

**Se usa lo ya calculado, no se pide nada.** Los tiempos salen de los traslados
consultados desde "Moverse" o desde las fichas, que ahora vienen de Google
Routes. Si entre dos cosas no hay traslado calculado, no hay aviso: inventarse
un tiempo para poder avisar sería peor que callarse. De los medios disponibles
se prefiere andando y luego público, que es con lo que se encadena un día.

Solo entre tarjetas **consecutivas** del mismo día y con hora las dos: sin hora
no hay nada que comparar, y comparar la primera con la tercera sería avisar de
un salto que nadie va a dar. Los traslados quedan fuera como extremo — avisar de
que no da tiempo a llegar al trayecto no significa nada.

El aviso va **dentro de la segunda tarjeta**, en ámbar, y no arriba con los del
día: los otros son del día entero ("tienes tres cosas antes de llegar") y ahí
están bien; este habla de dos tarjetas concretas y leerlo en la cabecera obliga
a buscar de cuáles.

Y avisa, no prohíbe. No recoloca nada, no impide guardar y no cambia ninguna
hora. Igual ese trayecto se hace en taxi, o igual da lo mismo llegar tarde a eso.

---

## Datos duros de los sitios

La ficha de un sitio se montaba con dos fuentes: la IA propone **qué** ver y
Wikipedia cuenta **qué es**. Las dos hablan del sitio y ninguna dice lo que hace
falta para ir: cuánto cuesta, a qué hora abre, cuánto se tarda en verlo. Ahora
hay una tercera, y solo trae números.

### Una búsqueda por etapa, no una por sitio

Se abre un navegador de verdad (perfil persistente, como Booking o Civitatis) y
se le pregunta a Google **una sola vez** por todos los sitios de la ciudad
juntos, pidiendo una tabla. Quince búsquedas sueltas serían quince oportunidades
de que salte un captcha y quince veces más lento.

De ahí sale **texto en crudo**. Convertirlo en campos lo hace la IA, y ahí está
la regla que sostiene todo esto:

> **Los datos duros o vienen de la búsqueda o no vienen.**

La IA participa como traductora, no como fuente. El prompt le prohíbe
explícitamente completar con lo que sepa, porque lo sabe: conoce los horarios
del Louvre y los rellenaría encantada. Un horario inventado no se distingue de
uno real hasta que te plantas delante de una puerta cerrada, y entonces ya da
igual de dónde salió.

### Tres estados, y hay que distinguirlos

| Estado | Qué se ve |
|---|---|
| Buscándose | "cargando…" |
| Buscado y no había | un guion, y "La búsqueda no encontró estos datos" |
| Sin buscar todavía | no se pinta el bloque |

`datos_en` se marca **siempre** al terminar, se haya encontrado algo o no. Sin
esa marca, un sitio del que la búsqueda no dijo nada se quedaría diciendo
"cargando…" para siempre.

### Catálogo, con fecha

El precio del Castillo de San Jorge no depende de mi viaje: se guarda en
`sitios_lugar` y lo hereda el siguiente que vaya a Lisboa. Pasados 30 días se
sigue enseñando con un "Consultado hace 45 días: puede haber cambiado" — un dato
de hace cinco semanas sigue orientando, y esconderlo sería dejar la ficha vacía
por prudencia mal entendida.

### El fallo bueno

El bloque de respuesta con IA de Google no tiene selector estable ni
documentado. Se prueban varios contenedores y, si ninguno aparece, se cae a los
resultados normales. Cuando Google cambie la maqueta esto devolverá **menos
datos, no datos falsos**, y las fichas se quedarán con huecos.

El captcha no se espera: `comprobarCaptcha` de lib/browser.js se queda esperando
a que alguien pulse Enter, y eso aquí colgaría la cola de trabajos para siempre.
Aquí se detecta y se aborta, la etapa sigue su camino y el motivo queda escrito
en el registro de la cola.

### "Ese día está cerrado"

Muchos museos cierran los lunes y muchos palacios los martes, y en un lienzo eso
no se ve: la tarjeta cae igual de bien en cualquier columna. La nueva regla lee
la columna `horarios` —la de la búsqueda, no Places— y avisa.

Un horario es una frase en cristiano, así que traducirla a días de la semana lo
hace la IA **al generarse el aviso, no al buscar**: la mayoría de los sitios no
acaban en ningún día concreto y traducir quince horarios para usar dos sería
pagar por trece. El resultado se guarda en `cierra_dias`, así que es una llamada
por sitio en toda su vida, no una por cada pintada del lienzo. Mientras no esté
interpretado no se avisa: callar un día es mejor que soltar un "cierra los
lunes" a medio deducir.

Y los días de la semana acabados en -s no llevan plural, que si no queda "los
juevess".
