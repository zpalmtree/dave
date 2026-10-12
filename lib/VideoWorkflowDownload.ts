import { createHash, randomUUID } from 'crypto';
import { mkdir, readFile, rename, writeFile } from 'fs/promises';
import { homedir } from 'os';
import { join } from 'path';
import { ActionRowBuilder, ButtonBuilder, ButtonStyle, Interaction } from 'discord.js';

const PREFIX = 'video-workflows:';

export function workflowDownloadDirectory(): string {
    return process.env.VIDEO_WORKFLOW_DOWNLOAD_DIR || join(homedir(), '.local', 'share', 'dave', 'video-workflows');
}

/** Retain small archives independently of the broker's 24-hour render cleanup. */
export async function saveWorkflowDownload(archive: { attachment: Buffer }, directory = workflowDownloadDirectory()) {
    const id = createHash('sha256').update(archive.attachment).digest('hex');
    await mkdir(directory, { recursive: true });
    const path = join(directory, `${id}.zip`);
    const temporary = `${path}.${randomUUID()}.tmp`;
    await writeFile(temporary, archive.attachment);
    await rename(temporary, path);
    return new ActionRowBuilder<ButtonBuilder>().addComponents(new ButtonBuilder()
        .setCustomId(`${PREFIX}${id}`).setLabel('Download workflows').setStyle(ButtonStyle.Secondary));
}

export async function handleWorkflowDownload(interaction: Interaction, directory = workflowDownloadDirectory()): Promise<void> {
    if (!interaction.isButton() || !interaction.customId.startsWith(PREFIX)) return;
    if (interaction.message.author.id !== interaction.client.user?.id) return;
    const id = interaction.customId.slice(PREFIX.length);
    await interaction.deferReply({ ephemeral: true });
    if (!/^[a-f0-9]{64}$/.test(id)) {
        await interaction.editReply('This workflow download is unavailable.');
        return;
    }
    try {
        const attachment = await readFile(join(directory, `${id}.zip`));
        await interaction.editReply({ files: [{ attachment, name: `workflows-${id.slice(0, 8)}.zip` }] });
    } catch (error) {
        console.warn(`[Video] Could not provide workflow download ${id}: ${String(error)}`);
        await interaction.editReply('Couldn’t download these workflows. Please try again later.');
    }
}
