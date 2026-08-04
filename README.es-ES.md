# Dave

Dave es un bot de Discord.

## Requisitos previos

* yarn
* node

## Configuración

* Ve [aquí](https://discordapp.com/developers/applications/me#top) para crear un bot.
* Da un nombre a tu bot y luego haz clic en `Create Application`.
* Desplázate hacia abajo hasta `Create a Bot User` y haz clic en esa opción.
* Anota el `Client ID` para más tarde.
* Ahora puedes obtener tu token de bot haciendo clic en `click to reveal` en la sección del usuario del bot.
* Copia el archivo `src/Config.ts.example` a `src/Config.ts` (`cp src/Config.ts.example src/Config.ts`)
* Ingresa tu token en `Config.ts`.
* **¡No reveles este token a nadie!**
* A continuación, necesitas obtener el Channel ID en el que quieres que se ejecute el bot.
* En Discord, sigue estos pasos-

   1. Haz clic en `User Settings` (pequeño ícono de engranaje a la derecha del nombre en la esquina inferior izquierda)

   2. Haz clic en `Appearance`

   3. Activa `Developer Mode`.

* Edita este enlace, reemplazando la cadena de números después de `client_id=` con el Client ID que anotaste anteriormente.
`https://discord.com/oauth2/authorize?client_id=446154284514541579&scope=bot&permissions=268437568`
* Abre el enlace mencionado y elige el servidor al que deseas agregar el bot. Debes tener permisos de `Manage Server`.

## Configuración

Copia `lib/Config.ts.example` a `lib/Config.ts` y completa los campos relevantes.

Puedes deshabilitar funciones en `lib/CommandDefinitions.ts` si no te interesa obtener las claves API o no quieres errores.

* Cat API: https://thecatapi.com/signup
* Tipos de cambio: https://docs.openexchangerates.org/docs/authentication
* API de YouTube: https://developers.google.com/youtube/v3/docs
* API del clima: https://openweathermap.org/price

## Instalación

`yarn install`

## Compilación

`yarn build`

## Ejecución

`yarn start`
