# Dave

Dave is a chat bot. It runs on Discord and Uproar (uproar.chat) at the same time; the Uproar side is optional and stays off until you configure it (see [Uproar](#uproar-uproarchat) below).

https://github.com/user-attachments/assets/80d7947d-5c55-492e-8d2b-d8d7986ead96

The operator-hosted Discord bots' data practices and privacy contact are described
in the [Dave and Sluglicious privacy policy](PRIVACY.md).

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

Copy `lib/Config.ts.example` to `lib/Config.ts` and fill in the relevant fields.

You can disable functions in `lib/CommandDefinitions.ts` if you can't be bothered to get the API keys and don't want errors.

* Cat API: https://thecatapi.com/signup
* Exchange rates: https://docs.openexchangerates.org/docs/authentication
* Youtube API: https://developers.google.com/youtube/v3/docs
* Weather API: https://openweathermap.org/price

## Codex reset alerts

The optional watcher polls the [Codex Resets public API](https://codex-resets.com/api/docs)
every 60 seconds. It announces explicit scheduled resets and separately reports executed
resets, including banked credits. Forecasts and elapsed ETAs never count as execution.
Both alert types ping the `@codex` role (`1560349689025532064`) and link back to
Codex Resets and the source post. All other mentions are disabled.

Create `~/.config/dave-codex-resets.json` (or set `CODEX_RESET_WATCH_CONFIG_FILE`):

```json
{
  "botUserId": "446154284514541579",
  "channelId": "746507379310461010"
}
```

Only the selected bot runs the watcher, preventing duplicate alerts across the two
deployment tracks. It needs View Channel, Send Messages, and Embed Links permissions.
The `@codex` role must be mentionable, or the bot must have Mention Everyone permission.
Restart the bots after configuring it. No API key is required.

The adjacent `.state.json` file stores seen events and a persistent delivery queue.
Keep it across restarts. First startup silently baselines executed history but announces
any currently scheduled reset. Later polls page through history to catch resets missed
during downtime and retry failed deliveries. Missing configuration disables the watcher;
invalid state fails closed. Use a new config/state path when changing the destination.
Detection depends on the tracker publishing an announcement or execution signal;
it cannot verify individual accounts' limits.

## Uproar (uproar.chat)

Dave can run on Uproar alongside Discord. It stays Discord-only until you set both
`uproarBotId` and `uproarBotToken` in `lib/Config.ts`; leave them blank to disable it.

Dave connects to Uproar by **dialing out** over a WebSocket, the same way it connects to
Discord's gateway, so there is nothing to host: no public URL, webhook, or open port.

To wire it up:

* Create a bot on Uproar: either an **account-level agent** (Settings > Bots > *My Agents*),
  which you then admit into any server, or a **server-owned** bot (a server's
  Settings > Bots). The bot's **token is shown once**, at creation, inside the returned URL
  (`https://uproar.chat/api/bots/<id>/<token>`). Copy it immediately; it is stored hashed and
  never shown again. If you lose it, regenerate a new one.
* Add the bot to the server(s) and channel(s) you want it in. For an account-level agent,
  share its handle (`bot.xxxxxxxx`) and have a server admin admit it (Server Settings > Bots).
  Give the bot **View Channel** and **Send Messages** in those channels, plus **Attach Files**
  (for the image commands) and **Add Reactions** (for polls and paginated replies).
* Fill in the Uproar fields in `lib/Config.ts`:
  * `uproarBotId` — the bot's id (the `<id>` in the URL above)
  * `uproarBotToken` — the execute token (the `<token>` shown once)
  * `uproarBaseUrl` — defaults to `https://uproar.chat`; only change it if you self-host Uproar
* Build and start as usual (below). Commands work exactly as on Discord, with the same `prefix`.

## Installation

`yarn install`

## Compilation

`yarn build`

## Running

`yarn start`
