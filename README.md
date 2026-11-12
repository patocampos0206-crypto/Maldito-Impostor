# MALDITO IMPOSTOR
**¿Quién está mintiendo?** — Creado por Patricio

Juego multijugador presencial: cada participante usa su propio celular y la app reparte roles secretos, organiza los turnos, el dibujo colectivo y las votaciones. Es una **app web instalable (PWA)**: se abre desde el navegador del celular (Android o iPhone) y se puede "agregar a la pantalla de inicio" como una app.

---

## Cómo publicarlo (una sola vez, ~10 minutos, gratis)

El juego necesita estar en un servidor para que todos los celulares se conecten. La opción más simple es **Render**:

1. Creá una cuenta en **github.com** y otra en **render.com** (podés entrar a Render con tu cuenta de GitHub).
2. En GitHub, creá un repositorio nuevo (por ejemplo `maldito-impostor`) y subí **todos los archivos de esta carpeta** (botón *Add file → Upload files*, arrastrás la carpeta descomprimida).
3. En Render: **New → Blueprint**, elegí ese repositorio y confirmá. Render lee el archivo `render.yaml` y configura todo solo.
   - Alternativa manual: **New → Web Service**, elegí el repositorio, *Build command*: `npm install`, *Start command*: `npm start`, plan *Free*.
4. Al terminar te da una dirección tipo `https://maldito-impostor.onrender.com`. **Ese es el link del juego**: compartilo con el grupo.

> En el plan gratuito de Render el servidor "se duerme" tras 15 minutos sin uso; la primera vez que se abre puede tardar ~1 minuto en despertar. Después funciona normal. Con el plan pago más barato no se duerme.

Otras opciones que también funcionan sin cambios: **Railway**, **Fly.io** (incluye `Dockerfile`), o cualquier servidor con Node.js 18 o superior.

### Jugar en casa sin internet (opcional)
En una computadora con Node.js instalado y conectada al mismo Wi-Fi que los celulares:
```
npm start
```
y desde los celulares abrí `http://IP-DE-LA-COMPUTADORA:3000` (la IP aparece en la configuración de red de la compu). En este modo la instalación como app puede no estar disponible porque no hay HTTPS, pero el juego funciona igual.

---

## Cómo se juega
1. Alguien toca **Crear partida** y queda como anfitrión. Aparece un código de 4 letras (tocándolo se comparte el link).
2. El resto toca **Unirse a partida** e ingresa el código y su nombre.
3. El anfitrión configura: cantidad de jugadores (3 a 10), impostores (1 a 3), modalidad, ayudín, tiempos y categorías. Cuando están todos, **¡Empezar partida!**
4. Cada uno toca su tarjeta para ver su rol en secreto. El impostor no ve la palabra/frase; si hay ayudín, ve una pista **una sola vez**.
5. Se juega la ronda según la modalidad:
   - **Frases / Palabras:** la app marca de quién es el turno y cada uno dice en voz alta una palabra relacionada. Al terminar la vuelta se puede hacer otra o votar (también por mayoría con “Quiero votar ya”).
   - **Dibujo colectivo:** un único lienzo compartido en tiempo real. Cada uno, en orden aleatorio, tiene unos segundos (8 por defecto) para agregar una pequeña parte. Se puede deshacer lo propio antes de confirmar; lo confirmado no se puede tocar. Al final se ve el dibujo completo, con quién hizo cada parte.
6. **Votación secreta** desde cada celular. Se muestran solo los totales. Si hay empate, se vota de nuevo solo entre los empatados (y tras dos empates seguidos el anfitrión puede sortear).
7. Se revela al expulsado y si era impostor. La partida sigue con la misma palabra hasta que:
   - **Ganan los jugadores:** expulsaron a todos los impostores.
   - **Ganan los impostores:** quedan tantos impostores como jugadores normales.
8. Pantalla final con todo el historial y botón para **jugar otra vez con los mismos**.

El botón **👁 Rol** (arriba) permite volver a ver tu palabra durante la partida. El menú **⋯** permite compartir la sala, salir, y al anfitrión retirar jugadores, pasar el rol de anfitrión o terminar la partida.

Si alguien cierra el navegador o se le apaga el celular, al volver a abrir el link **recupera su lugar y su rol** automáticamente. Si el anfitrión se desconecta más de 30 segundos, el rol pasa a otro jugador.

---

## Banco de frases y palabras
- `content/frases.txt` y `content/palabras.txt`: más de 1.200 contenidos en 16 categorías, cada uno con su ayudín. El formato es simple (una línea = `texto ; ayudín`), así que se pueden sumar contenidos a mano.
- `npm run validar` revisa todo el banco: repetidos, errores de tipeo, frases demasiado cortas o largas, ayudines que revelan la respuesta y palabras inapropiadas (lista ampliable en `content/bloqueadas.txt`). Lo que no pasa la revisión se descarta solo.
- **Ampliación con IA:** `ANTHROPIC_API_KEY=tu-clave npm run generar -- --tipo frases --todas --cantidad 40` genera contenidos nuevos para todas las categorías, los valida y los guarda en `content/extra/`. Las partidas **no** dependen de la IA: todo sale de la base local.
- La app evita repetir contenidos dentro de la misma sala y entre partidas recientes del servidor.

---

## Para quien mantenga el código
- **Sin dependencias externas**: Node.js puro (`server.js`), sincronización en tiempo real con Server-Sent Events, y un cliente en HTML/CSS/JS (`public/`).
- `lib/game.js` es la lógica autoritativa: roles, turnos, dibujo, votos, empates, expulsiones y victoria. **El servidor arma una vista distinta para cada jugador**: el impostor nunca recibe la palabra (ni oculta en la página), el ayudín deja de enviarse apenas se confirma, y los votos individuales nunca salen del servidor (se descartan al contarlos). Cada jugador se identifica con un token secreto guardado en su celular.
- El estado de las salas se guarda en `data/` y se recupera si el servidor se reinicia.
- `npm test` juega 36 partidas completas con celulares simulados (3 a 10 jugadores, 1 a 3 impostores, las tres modalidades, con y sin ayudín, empates, reconexiones, abandonos) y verifica más de 15.000 condiciones.
