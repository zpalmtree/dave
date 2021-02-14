# Dave

Dave is a discord bot.

## Prerequisites

* yarn
* node

## Setup

* Go [here](https://discordapp.com/developers/applications/me#top) to make a bot.
* Give your bot a name, and then click `Create Application`.
* Scroll down to `Create a Bot User` and click that.
* Note down the `Client ID` for later.
* Now you can get your bot token by clicking `click to reveal` in the bot user section.
* Copy the file `src/Config.ts.example` to `src/Config.ts` (`cp src/Config.ts.example src/Config.ts`)
* Enter your token in `Config.ts`.
* **Don't reveal this token to anyone!**
* Next you need to get the Channel ID you want the bot to run in.
* In Discord, follow these steps-

   1. Click on `User Settings`(small gear icon to right of name in the bottom left)

   2. Click on `Appearance`

   3. Enable `Developer Mode`.

* Edit this link, replacing the string of numbers after `client_id=` with the Client ID you noted down earlier.
`https://discord.com/oauth2/authorize?client_id=446154284514541579&scope=bot&permissions=268437568`
* Open said link and choose the server you wish to add the bot to. You must have `Manage Server` permissions.

## Configuration

Copy `src/Config.ts.example` to `src/Config.ts` and fill in the relevant fields.

You can disable functions in `lib/CommandDefinitions.ts` if you can't be bothered to get the API keys and don't want errors.

* Cat API: https://thecatapi.com/signup
* Exchange rates: https://docs.openexchangerates.org/docs/authentication
* Youtube API: https://developers.google.com/youtube/v3/docs
* Weather API: https://openweathermap.org/price

## Installation

`yarn install`

## Compilation

`yarn build`

## Running

`yarn start`
