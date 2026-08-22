export function formatDiscordEpoch(
    epochSeconds: number,
    style: 'F' | 'R' | 't' | 'D' = 'F',
): string {
    return `<t:${Math.floor(epochSeconds)}:${style}>`;
}

export function formatDiscordDateAndRelative(epochSeconds: number): string {
    return `${formatDiscordEpoch(epochSeconds, 'F')} (${formatDiscordEpoch(epochSeconds, 'R')})`;
}
