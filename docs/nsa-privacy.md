# NSA meeting assistant privacy policy

Last updated: 10 September 2026

## Scope and contact

NSA (Discord application `1489445973771161802`) is a private bot used to record
team meetings and produce meeting notes. This policy describes that deployment,
not Dave or Sluglicious. Publishing this policy does not make the bot's source
code, meeting recordings or transcripts public.

For privacy questions, recording objections, or access, correction and deletion
requests, contact the team's meeting organizer or bot operator `zpalmtree`
privately on Discord. Include the meeting date or session ID and your Discord
user ID where relevant. Do not publish confidential meeting material in a
public support request.

## Information collected and its purpose

The bot monitors occupancy in a configured team voice channel. When a meeting
is active, it records audio and captures the associated meeting-chat messages
to create live summaries, transcripts, final minutes and exports. It also
retrieves a configured amount of preceding chat context; the default lookback
is 30 minutes.

Records can include:

- Meeting and channel IDs, start/end times, participant Discord IDs, display
  names, and join/leave information.
- Meeting audio, transcripts, chat text, links, attachment references, reply
  references, message metadata and edit history.
- Generated summaries and minutes, archive/export locations, and operational
  diagnostics.

The bot targets its configured meeting channels rather than all server chat.
Its meeting controls use `/meeting` commands restricted to authorized managers.
Recording notices are configurable; an organizer must ensure participants know
when the bot is recording. A notice is not a technical per-participant consent
or opt-out control.

## Processing and recipients

Meeting audio and relevant context are sent to OpenAI for transcription and
summarization. The application uses inference APIs; it does not implement
training or fine-tuning on meeting content. Provider-side processing and
retention depend on the provider and the service/account settings.

The bot stores session, participant, transcript and chat records in an
operator-managed SQLite database. Audio and generated artifacts, including chat
context exports, are stored in S3-compatible object storage. Temporary audio
files and diagnostic logs may also exist on the host.

The production database, temporary files, application logs and retained
migration backups use encrypted storage. Audio and generated artifacts in
Amazon S3 use AES-256 server-side encryption. Authorized application processes
can decrypt data to provide the meeting features. These controls do not make
an exported download link safe to share publicly, or establish erasure of
historical hosting-provider snapshots.

Summaries and minutes are posted to the configured Discord output channel and
detail threads. Their audience is determined by Discord channel permissions.
Authorized meeting managers can request exports with signed download links;
anyone who receives an unexpired link may be able to download its contents.
The default link lifetime is 15 minutes. A link expiring does not delete the
underlying archive.

Hosting, storage and AI providers process data to provide these services. We
do not sell meeting data or share it with advertising networks or data brokers.
Data may also need to be disclosed where required by law.

## Retention and deletion

The application currently has no universal automatic expiry for its database,
recordings or exports. These records support meeting history, regeneration and
authorized exports. Requests to access, correct or delete data are handled
manually by the operator. Data that is no longer necessary for those purposes
or is subject to a valid deletion request will be removed, except where
retention is required by law. The operator may verify your identity and the
scope of a request before acting on team records involving other people.

Deleting a chat message in Discord is not an automatic erasure request for all
copies. During an active session, the bot marks detected message deletions and
omits marked messages from later summary inputs, but the stored text and edit
history are not automatically erased. Earlier summaries, audio, exports and
provider-side records may still contain the material. Tell the operator which
meeting and material your request concerns so these copies can be considered.

## Participant choices and security

There is currently no built-in per-user opt-out from recording or chat capture.
Raise an objection with the organizer before participating so they can arrange
an unrecorded meeting or stop the bot. Authorized managers can use
`/meeting stop`; server administrators can restrict the bot's channel access
or remove it. Leaving the voice channel stops capture of your subsequent voice
there, but does not erase earlier recordings or prevent capture of messages you
continue to post in the associated recorded chat.

Access to team outputs should be limited through Discord permissions and
operator-controlled hosting and storage credentials. This policy does not
promise that encryption prevents access by an authorized operator or a
compromised running service. Do not share export links outside their intended
audience.

## Changes

Updates will be published here with a revised date. Material changes to
recording or data use should be communicated to participants before they take
effect.
