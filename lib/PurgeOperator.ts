import { Client, Message } from 'discord.js';
import { handlePurge, isPurgeUserAllowed, logPurgeEvent } from './Purge.js';

// PM2 IPC is available only to the local service operator, not to Discord users.
export function createPurgeOperator(client: Client, purge = handlePurge) {
    return async (packet: any): Promise<Record<string, unknown> | undefined> => {
        if (packet?.topic !== 'purge-operator') return;
        const { action, guildId, userId, channelId } = packet.data ?? {};
        if (action === 'status') return { ok: true, runs: purge.status() };
        if (action !== 'start' || ![guildId, userId, channelId].every(id =>
            typeof id === 'string' && /^\d{17,20}$/.test(id))) {
            return { ok: false, reason: 'invalid_request' };
        }
        if (!isPurgeUserAllowed(userId)) return { ok: false, reason: 'user_not_allowed' };
        const guild = await client.guilds.fetch(guildId);
        const channel = await guild.channels.fetch(channelId);
        if (!channel || channel.guildId !== guildId || !channel.isTextBased() || !('send' in channel)) {
            return { ok: false, reason: 'invalid_channel' };
        }
        const member = await guild.members.fetch(userId);
        // Check after async lookups: a Discord invocation may have started meanwhile.
        const running = purge.status().find(run => run.guildId === guildId);
        if (running) return { ok: false, reason: 'already_running', run: running };
        logPurgeEvent('operator_start', { guildId, userId, channelId });
        // Reuse the exact handler and concurrency guard used by Discord commands.
        const context = {
            guild, channel, author: member.user,
        } as unknown as Message;
        void purge(context).catch(() => logPurgeEvent('operator_run_error', { guildId, userId }));
        return { ok: true, run: purge.status().find(run => run.guildId === guildId) };
    };
}

export function installPurgeOperator(client: Client): () => void {
    const handle = createPurgeOperator(client);
    const listener = (packet: any) => {
        if (packet?.topic !== 'purge-operator') return;
        const requestId = packet.data?.requestId;
        void handle(packet).catch(error => ({ ok: false, reason: 'discord_error', code: error?.code }))
            .then(result => {
                logPurgeEvent('operator_response', { requestId, ...result });
                if (process.connected && process.send) {
                    process.send({ type: 'process:msg', data: { topic: 'purge-operator', requestId, ...result } },
                        (error: Error | null) => { if (error) logPurgeEvent('operator_reply_error', { requestId }); });
                }
            });
    };
    process.on('message', listener);
    const resume = () => { void handlePurge.resumePending(client); };
    resume();
    const recoveryTimer = setInterval(resume, 60000);
    recoveryTimer.unref();
    logPurgeEvent('operator_ready', { ipcAvailable: !!process.send });
    return () => { clearInterval(recoveryTimer); process.off('message', listener); };
}
