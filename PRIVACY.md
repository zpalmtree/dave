# Dave and Sluglicious privacy policy

Last updated: 10 September 2026

## Scope and contact

This policy covers the Dave and Sluglicious Discord applications operated by
`zpalmtree`, including Sluglicious's connected holder-verification service.
Their application IDs are `446154284514541579` and `903156913724874832`.
The chat-bot source is available at <https://github.com/zpalmtree/dave>.
Independent operators of copies of this software are responsible for their own
data practices; this policy does not describe their deployments.

For privacy questions, access, correction, or deletion requests, contact
`zpalmtree` privately on Discord in a server where the bot operates. A server
administrator can help put you in touch with the operator. Include your Discord
user ID and enough context to identify the relevant feature or records. Do not
post private messages, wallet credentials, or other sensitive information in a
public GitHub issue. General software issues can be reported through the
[repository](https://github.com/zpalmtree/dave/issues).

The separate private meeting assistant NSA has its own
[privacy policy](docs/nsa-privacy.md).

## Data the applications process

Depending on the features used and the channels the bot can access, the
applications process:

- Discord user, server, channel, message and reply IDs; display names; timestamps;
  messages, links, attachments, and reactions needed for the relevant feature.
- Commands and their arguments, replies and conversation context, submitted
  images/audio/video, and generated responses or media.
- Saved quotes, reminders and their text, watch lists, game state and preferences,
  command-use records, and AI token-usage and estimated-cost records.
- Media-generation job records, prompts, source media, generated files, and
  diagnostic logs. Errors may include command or message text.
- For people who use Sluglicious holder verification, the association between a
  Discord user ID and public wallet addresses, relevant public blockchain
  holdings/staking/activity, and Discord roles needed to maintain eligibility.
  This does not require a wallet seed phrase or private key.

Ordinary messages may be processed without a command for link previews,
attachment transcription, and conversation context. A summary requested by one
participant may include other participants' messages in that channel.

## Purposes and sharing

The data supports the requested bot features: answering commands, repairing link
previews, transcribing media, summarizing conversations, generating media,
maintaining reminders and community features, updating holder roles, and
operating and troubleshooting these services.

Responses, summaries, previews and generated media are normally posted back to
Discord and are visible to people with access to the destination channel.
Information included in those outputs may originate in the conversation being
summarized or the material supplied to the bot.

AI features send the necessary prompt, conversation context, or media to the
provider used by that feature. Integrations include OpenAI, Anthropic, Google,
xAI and Groq; not every command uses every provider. Video processing may also
use operator-managed workers. Link-preview and other external-service features
send the relevant URL or request to the corresponding service. Hosting and
storage providers process data as part of operating the application.

The bot software uses AI services for inference, such as generating an answer or
transcript. It does not implement model training or fine-tuning on Discord
messages. Provider-side handling and retention depend on the provider and the
service/account settings; this policy does not promise zero retention by those
providers.

We do not sell Discord data or provide it to advertising networks or data
brokers. Data may also need to be disclosed where required by law.

## Storage and retention

Some data is held in process memory, and some is written to operator-managed
databases, files, media-job storage and logs. Saved feature data, command
arguments and operational records can persist across bot restarts.

The summary cache is capped at 5,000 messages per channel. Summary requests use
a 12-hour history window; that window is not a 12-hour expiry for the cache.
In-memory caches disappear when their process restarts, but the bot may retrieve
accessible message history again for a later request. The application does not
currently have a universal automatic expiry schedule for persistent records.

Data is retained for the features and operation described above. Contact the
operator to request access, correction or deletion. Requests are handled
manually, and data that is no longer needed for these purposes or is subject to
a valid deletion request will be removed, except where retention is required
by law. The operator may need to verify that a request relates to your data.

Deleting a Discord message does not automatically erase every cached copy,
command log, saved quote, generated output, or provider-side record. Include
relevant message IDs or feature details in a deletion request so these copies
can be identified. Discord and service providers also maintain their own data
under their applicable policies.

## Choices and access

There is currently no built-in per-user command that opts a person out of all
message processing. You can contact the operator about exclusion or deletion.
Server administrators can restrict the channels the bot can view or remove it
from a server to stop future access there. Not invoking a command alone does
not prevent the ordinary-message features described above.

Avoid sharing confidential material with a bot feature or in a channel whose
content you do not want that feature to process. Hosting credentials and bot
tokens are not part of the public source. This policy does not claim that every
stored record is encrypted by the application or automatically deleted.

## Changes

Updates will be published at this URL with a revised date. Material changes to
data use should be communicated to affected users before they take effect.
