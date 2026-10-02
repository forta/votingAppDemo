# Guía de preparación del bot de juegos Ink

Estado: guía operativa para una ejecución conectada en desarrollo. El bot está
en `cli-scripts/inkjs-bot.js` y la POC local está en `scripts/inkjs-poc.js`;
la POC no accede al servidor. Se ha validado el ciclo de juego desde la web:
el bot publica cada turno en la secuencia, las personas votan desde el cliente
habitual y el bot continúa Ink con la opción ganadora. El bot aún no restaura
partidas ni escucha eventos de cierre; consulta periódicamente el estado.

## Antes de empezar

Los comandos de esta guía se ejecutan desde la raíz del proyecto en una
terminal. Los ejemplos son válidos en Windows PowerShell; en macOS, Linux u
otras shells los comandos de Node.js son equivalentes. La forma de definir
variables de entorno cambia según la terminal; más abajo se muestran ambas
formas para las variables que usa el bot.

- Usa una cuenta registrada que sea dueña del espacio.
- Empieza en desarrollo y en un espacio de prueba. La secuencia debe estar
  vacía y empezar desde cero; el bot inicial no restaura partidas.
- Asegúrate de que el espacio no tenga ya otra secuencia activa creada por ti:
  el MVP permite una secuencia activa por dueño y espacio.
- Ten a mano la historia Ink. Puedes probarla localmente con:

  ```sh
  node scripts/inkjs-poc.js --story scripts/fixtures/inkjs/reference-games/juegodemo.ink
  ```

## Preparar la secuencia y la API key

Haz estos pasos en desarrollo, en la misma instancia donde está el espacio.
Despliega primero la corrección que evita guardar el secret en los logs antes
de crear claves en producción.

1. Inicia sesión como dueño y abre tu espacio de prueba.
2. Entra en **Sequences** y crea una secuencia. Déjala **Internal** y no la
   hagas pública para esta prueba. Anota su `Seq ID`; debe estar nueva y sin
   votaciones.
3. Abre **Settings → API Keys** y crea una clave con modo `sequence_bot`. Una
   misma API key puede asignarse a más de una secuencia; si ya tienes una,
   puedes reutilizarla.
4. Guarda el `API Key ID` y el `Secret` que se muestran al crearla. El secret se
   muestra una sola vez: guárdalo en un gestor de secretos o almacén local
   protegido. No lo pongas en Git, capturas, documentación compartida ni
   archivos del proyecto.
5. Vuelve a la secuencia y usa **Assign Bot** con el `API Key ID`. La clave
   debe pertenecer a la misma cuenta dueña. Comprueba que aparece asignada.
6. Cuando vayas a iniciar la prueba conectada, usa **Start** en la secuencia.
   Anota la URL de esa instancia; el bot debe apuntar a ese mismo servidor.

No añadas la API key como miembro del espacio ni le asignes un rol de espacio.
El modo `sequence_bot` ya no hereda la identidad propietaria de la cuenta ni
permisos de espacio. La key puede crear ballots sólo en su secuencia asignada,
cuando está activa, y leer sus ballots y resultados. No puede crear ballots
sueltos, leer el espacio o los votos individuales, ni votar; la identidad y el
censo de los participantes humanos siguen siendo los habituales.

## Política de votación para las partidas

El bot necesita un resultado con una opción ganadora inequívoca para avanzar
la historia. La política del espacio debe elegirse según lo que prefiera el
grupo. La creación rápida del espacio deja la política predeterminada; para
esta prueba, abre **Edit space** después de crearlo y configura **Voting
Method** como `two_phase`, **Winning majority** como `castVotes`, **Ballot duration**
como `150000` ms y **First phase duration** como `30000` ms. La duración del
ballot es el plazo total desde su creación, así que esos valores dejan unos 30
segundos para la primera fase y hasta 2 minutos adicionales para la segunda.

- **Partida rápida de prueba:** `two_phase`, ventana inicial de 30 segundos y
  unos 2 minutos adicionales para la fase siguiente (duración total aproximada:
  2 minutos y 30 segundos). Una mayoría estricta del censo puede cerrar
  en la primera fase; si no, la votación pasa a la fase siguiente. Esto da una
  respuesta rápida, pero no garantiza que todo el grupo haya podido votar.
- **Más tiempo para participar:** conserva `two_phase` y los 30 segundos
  iniciales, pero aumenta la duración total a horas. Si el grupo no quiere
  decisiones aleatorias, usa `tiePolicy: no_winner`. Al vencer el plazo, la
  votación puede cerrarse sin ganador y el bot se detendrá en pausa; no escogerá
  una rama por su cuenta. El plazo largo da más tiempo para votar, pero no
  equivale a esperar indefinidamente.
- **Desempate aleatorio:** `tiePolicy: random` puede escoger entre opciones
  empatadas que tengan votos. No inventa un ganador cuando nadie votó, no se
  alcanzó el quorum o no hay un empate elegible; por tanto, no garantiza que
  cada cierre produzca una decisión. Úsalo sólo si el grupo acepta que un
  empate real pueda decidirse al azar.

El cierre manual y el vencimiento **no usan una única opción de política**:
`manualAction` controla el cierre forzado por el dueño y `timeoutAction` controla
el vencimiento automático. Cada uno puede configurarse como `resolve` o
`cancel` (el cierre manual también admite `disabled`). Si la acción elegida es
`resolve`, ambos calculan y guardan resultados y aplican el `tiePolicy` del
espacio; si es `cancel`, cierran sin ganador. Por eso, para que ambos intenten
resolver de la misma manera, configura `manualAction: resolve` y
`timeoutAction: resolve`, además de elegir el `tiePolicy`. Incluso con esos
valores, `random` sólo resuelve los empates que cumplen sus condiciones: no
garantiza un ganador si no hubo votos o no se cumplió el quorum.

El bot todavía no se suscribe a eventos de cierre: consulta el
estado de la secuencia y de la votación cada 2 segundos por defecto. Para una
ejecución más estable conviene que una versión futura use el evento de cierre
como aviso inmediato y haga comprobaciones periódicas más lentas para recuperar
el estado si se reinicia, pierde el evento o queda desfasada. Un evento no debe
ser la única fuente de verdad; el estado persistido de la votación debe permitir
reconciliar y detectar cierres sin ganador. El bot actual pausa y termina si la
votación se cierra sin ganador, y todavía no restaura automáticamente una
partida tras reiniciarse.

Datos que necesita el comando del bot:

- URL del servidor: `http://localhost:3000` en desarrollo local o la URL de la
  instancia donde creaste la secuencia.
- Ruta al archivo `.ink` o JSON compilado.
- `Seq ID`, `API Key ID` y `Secret`.

El bot pide el secret ocultando la entrada o lo lee de `INK_BOT_SECRET`; nunca
lo escribe en el contexto CLI. El bot público actual `CLI/public/sequence-bot.js`
sirve de referencia para autenticación y secuencias, pero genera votaciones
aleatorias y no juega una historia Ink.

## Manejo del secret

La creación de API keys ya no incluye el secret en los logs de la aplicación.
Despliega esta corrección antes de crear claves en producción. Si creaste una
clave antes de este cambio, considera revocarla y crear otra: el secret pudo
quedar en los logs del servidor.

## Prueba local de InkJS

La POC sólo valida la historia y la selección interactiva de opciones; no usa
la API key ni la secuencia:

```sh
node scripts/inkjs-poc.js --demo
node scripts/inkjs-poc.js --story scripts/fixtures/inkjs/reference-games/TheIntercept.ink
```

Para una comprobación automática sin interacción:

```sh
npm run inkjs:poc
```

## Ejecutar el bot Ink conectado

No concedas permisos de espacio a la API key. Asegúrate de que la secuencia
está **playing**, asignada a la API key y que no tiene un ballot anterior
activo. Desde la raíz del proyecto lanza:

```powershell
$env:CLI_SERVER_URL = "http://localhost:3000"
```

En macOS o Linux, o en una terminal compatible con POSIX, usa:

```sh
export CLI_SERVER_URL="http://localhost:3000"
```

Después, en cualquiera de esas terminales, ejecuta:

```sh
node cli-scripts/inkjs-bot.js --sequenceId="YOUR_SEQUENCE_ID" --apiKeyId="YOUR_API_KEY_ID" --story=scripts/fixtures/inkjs/reference-games/juegodemo.ink
```

El programa pedirá el secret sin mostrar lo que escribes. Para usar otra
instancia, cambia `CLI_SERVER_URL` por la URL donde preparaste el espacio. Si
prefieres automatizarlo, puedes definir `INK_BOT_SECRET` en el entorno del
proceso y borrarlo al terminar. En PowerShell:

```powershell
$env:INK_BOT_SECRET = "<secret>"
```

En macOS o Linux:

```sh
export INK_BOT_SECRET="<secret>"
```

El bot pone el texto narrativo de Ink en la descripción de cada ballot y las
opciones actuales como alternativas. Así, el primer ballot muestra la
introducción y los siguientes muestran la elección anterior junto con su
reacción narrativa. Los mensajes de la historia, como «¿Qué quieres hacer
ahora?», proceden del propio archivo Ink. Cuando la historia termina con
texto narrativo pendiente, publica un ballot final con una sola opción para
que las personas puedan leer el desenlace antes de que la secuencia se marque
como `finished`.

Las personas votan desde un cliente habitual con el flujo normal; el bot no
entra en el censo ni vota. Cierra el ballot como dueño cuando la política lo
permita, o espera al cierre automático. El bot avanza Ink sólo cuando los
resultados contienen una opción ganadora inequívoca. Si no hay ganador, pausa
la secuencia y se detiene sin elegir una rama. Cuando Ink llega al final y
todavía queda texto narrativo por mostrar, el bot crea un ballot final con ese
texto en la descripción y una sola opción, **Finish the game**. Tras resolverse
ese ballot, marca la secuencia como `finished`.

En la prueba conectada, el operador lanzó el bot con una secuencia nueva, votó
desde el cliente web y comprobó que el bot avanzaba a los siguientes turnos y
al final narrativo. El cliente web puede seguir la secuencia y mostrar cada
nueva votación activa; esa navegación de la interfaz es independiente de la
consulta periódica con la que el bot espera resultados.

Esta primera versión no restaura el estado de Ink. Si se interrumpe o se detiene
después de crear votaciones, no la vuelvas a lanzar sobre esa secuencia; prepara
una nueva y vacía.

La implementación actual permite una sola secuencia activa por dueño y espacio,
con independencia del `tier`. Una secuencia en estado `waiting`, `playing` o
`paused` bloquea la creación de otra en ese espacio. Para repetir la prueba,
finaliza o elimina la anterior, crea una secuencia vacía, asígnale la API key y
vuelve a iniciarla.
