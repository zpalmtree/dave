import {
    EmbedBuilder,
    Message,
    escapeMarkdown,
} from 'discord.js';

import fetch from 'node-fetch';

const EASTERN_TIME_ZONE = 'America/New_York';
const LOOKAHEAD_DAYS = 7;
const MAX_MATCHES = 10;
const ESPN_WORLD_CUP_SCOREBOARD =
    'https://site.api.espn.com/apis/site/v2/sports/soccer/fifa.world/scoreboard';

interface EspnScoreboardResponse {
    events?: EspnEvent[];
}

interface EspnEvent {
    name?: string;
    shortName?: string;
    date?: string;
    status?: EspnStatus;
    competitions?: EspnCompetition[];
}

interface EspnCompetition {
    competitors?: EspnCompetitor[];
    status?: EspnStatus;
}

interface EspnCompetitor {
    homeAway?: string;
    score?: string;
    winner?: boolean;
    team?: EspnTeam;
}

interface EspnTeam {
    displayName?: string;
    shortDisplayName?: string;
    abbreviation?: string;
}

interface EspnStatus {
    displayClock?: string;
    type?: EspnStatusType;
}

interface EspnStatusType {
    state?: string;
    completed?: boolean;
    description?: string;
    detail?: string;
    shortDetail?: string;
}

interface MatchDisplay {
    dateKey: string;
    event: EspnEvent;
}

function padDatePart(value: number): string {
    return value.toString().padStart(2, '0');
}

function dateKeyToEndpointDate(dateKey: string): string {
    return dateKey.replace(/-/g, '');
}

function addDaysToDateKey(dateKey: string, days: number): string {
    const [year, month, day] = dateKey.split('-').map(Number);
    const date = new Date(Date.UTC(year, month - 1, day + days, 12));

    return [
        date.getUTCFullYear(),
        padDatePart(date.getUTCMonth() + 1),
        padDatePart(date.getUTCDate()),
    ].join('-');
}

function getEasternDateKey(date: Date): string {
    const formatter = new Intl.DateTimeFormat('en-US', {
        timeZone: EASTERN_TIME_ZONE,
        year: 'numeric',
        month: '2-digit',
        day: '2-digit',
    });

    const parts = formatter.formatToParts(date).reduce((result, part) => {
        result[part.type] = part.value;
        return result;
    }, {} as { [index: string]: string });

    return `${parts.year}-${parts.month}-${parts.day}`;
}

function escapeDiscordText(text: string): string {
    return escapeMarkdown(
        text,
        {
            codeBlock: true,
            inlineCode: true,
            bold: true,
            italic: true,
            underline: true,
            strikethrough: true,
            spoiler: true,
            codeBlockContent: true,
            inlineCodeContent: true,
            escape: true,
            heading: true,
            bulletedList: true,
            numberedList: true,
            maskedLink: true,
        },
    );
}

function getEasternTime(date: Date): string {
    return new Intl.DateTimeFormat('en-US', {
        timeZone: EASTERN_TIME_ZONE,
        hour: 'numeric',
        minute: '2-digit',
        timeZoneName: 'short',
    }).format(date);
}

function formatDateHeading(dateKey: string, todayKey: string): string {
    const tomorrowKey = addDaysToDateKey(todayKey, 1);
    const [year, month, day] = dateKey.split('-').map(Number);
    const date = new Date(Date.UTC(year, month - 1, day, 12));
    const dateLabel = new Intl.DateTimeFormat('en-US', {
        timeZone: EASTERN_TIME_ZONE,
        weekday: 'short',
        month: 'short',
        day: 'numeric',
    }).format(date);

    if (dateKey === todayKey) {
        return `Today - ${dateLabel}`;
    }

    if (dateKey === tomorrowKey) {
        return `Tomorrow - ${dateLabel}`;
    }

    return dateLabel;
}

function getCompetition(event: EspnEvent): EspnCompetition | undefined {
    return event.competitions?.[0];
}

function getStatus(event: EspnEvent): EspnStatus | undefined {
    return getCompetition(event)?.status || event.status;
}

function getTeamName(competitor: EspnCompetitor | undefined): string {
    if (!competitor) {
        return 'TBD';
    }

    return competitor.team?.shortDisplayName
        || competitor.team?.displayName
        || competitor.team?.abbreviation
        || 'TBD';
}

function getHomeAwayTeams(event: EspnEvent): {
    home?: EspnCompetitor;
    away?: EspnCompetitor;
    competitors: EspnCompetitor[];
} {
    const competitors = getCompetition(event)?.competitors || [];
    const home = competitors.find((competitor) => competitor.homeAway === 'home') || competitors[0];
    const away = competitors.find((competitor) => competitor.homeAway === 'away') || competitors[1];

    return {
        home,
        away,
        competitors,
    };
}

function formatMatchup(event: EspnEvent): string {
    const { home, away } = getHomeAwayTeams(event);

    if (home || away) {
        return `${escapeDiscordText(getTeamName(away))} vs ${escapeDiscordText(getTeamName(home))}`;
    }

    if (event.name) {
        return escapeDiscordText(event.name.replace(' at ', ' vs '));
    }

    return 'TBD vs TBD';
}

function getScoredCompetitors(event: EspnEvent): EspnCompetitor[] {
    const { home, away, competitors } = getHomeAwayTeams(event);

    const winner = competitors.find((competitor) => competitor.winner);
    const loser = competitors.find((competitor) => competitor !== winner);

    if (winner && loser && getStatus(event)?.type?.completed) {
        return [winner, loser];
    }

    if (away && home) {
        return [away, home];
    }

    return competitors;
}

function formatScore(event: EspnEvent): string {
    const scoredCompetitors = getScoredCompetitors(event);

    if (scoredCompetitors.length === 0) {
        return formatMatchup(event);
    }

    return scoredCompetitors.map((competitor) => {
        const score = competitor.score === undefined || competitor.score === ''
            ? '0'
            : competitor.score;

        return `${escapeDiscordText(getTeamName(competitor))} ${score}`;
    }).join(', ');
}

function getLiveLabel(status: EspnStatus | undefined): string {
    if (status?.type?.shortDetail === 'HT' || status?.type?.description === 'Halftime') {
        return 'HT';
    }

    if (status?.displayClock && status.displayClock !== "0'") {
        return `Live ${status.displayClock}`;
    }

    return 'Live';
}

function formatMatchLine(event: EspnEvent): string {
    const status = getStatus(event);
    const statusType = status?.type;
    const eventDate = event.date ? new Date(event.date) : undefined;
    const hasValidDate = eventDate !== undefined && !Number.isNaN(eventDate.getTime());

    if (statusType?.completed || statusType?.state === 'post') {
        return `${statusType.shortDetail || 'FT'} - ${formatScore(event)}`;
    }

    if (statusType?.state === 'in') {
        return `${getLiveLabel(status)} - ${formatScore(event)}`;
    }

    if (statusType?.state === 'pre') {
        return `${hasValidDate ? getEasternTime(eventDate!) : 'TBD'} - ${formatMatchup(event)}`;
    }

    if (statusType?.shortDetail && statusType.shortDetail !== 'Scheduled') {
        const display = statusType.completed ? formatScore(event) : formatMatchup(event);
        return `${statusType.shortDetail} - ${display}`;
    }

    return `${hasValidDate ? getEasternTime(eventDate!) : 'TBD'} - ${formatMatchup(event)}`;
}

async function fetchWorldCupMatches(startDateKey: string, endDateKey: string): Promise<EspnEvent[]> {
    const params = new URLSearchParams({
        dates: `${dateKeyToEndpointDate(startDateKey)}-${dateKeyToEndpointDate(endDateKey)}`,
        limit: '100',
    });

    const response = await fetch(`${ESPN_WORLD_CUP_SCOREBOARD}?${params.toString()}`);

    if (!response.ok) {
        throw new Error(`ESPN scoreboard returned ${response.status}`);
    }

    const data = await response.json() as EspnScoreboardResponse;

    return data.events || [];
}

function getSortedMatchDisplays(events: EspnEvent[]): MatchDisplay[] {
    return events
        .filter((event) => {
            if (!event.date) {
                return false;
            }

            return !Number.isNaN(new Date(event.date).getTime());
        })
        .sort((a, b) => new Date(a.date!).getTime() - new Date(b.date!).getTime())
        .map((event) => ({
            event,
            dateKey: getEasternDateKey(new Date(event.date!)),
        }));
}

function groupMatchesByDate(matches: MatchDisplay[]): Map<string, MatchDisplay[]> {
    const grouped = new Map<string, MatchDisplay[]>();

    for (const match of matches) {
        const dayMatches = grouped.get(match.dateKey) || [];
        dayMatches.push(match);
        grouped.set(match.dateKey, dayMatches);
    }

    return grouped;
}

function buildWorldCupEmbed(events: EspnEvent[], todayKey: string, endDateKey: string): EmbedBuilder {
    const matches = getSortedMatchDisplays(events);
    const grouped = groupMatchesByDate(matches);
    const selectedDays: Array<{ dateKey: string, matches: MatchDisplay[] }> = [];
    let selectedMatchCount = 0;

    const todayMatches = grouped.get(todayKey) || [];
    const todaySelection = todayMatches.slice(0, MAX_MATCHES);
    selectedDays.push({
        dateKey: todayKey,
        matches: todaySelection,
    });
    selectedMatchCount += todaySelection.length;

    const futureDateKeys = [...grouped.keys()]
        .filter((dateKey) => dateKey !== todayKey)
        .sort();

    for (const dateKey of futureDateKeys) {
        if (selectedMatchCount >= MAX_MATCHES) {
            break;
        }

        const dayMatches = grouped.get(dateKey) || [];
        const remainingMatches = MAX_MATCHES - selectedMatchCount;
        const selection = dayMatches.slice(0, remainingMatches);

        if (selection.length === 0) {
            continue;
        }

        selectedDays.push({
            dateKey,
            matches: selection,
        });
        selectedMatchCount += selection.length;
    }

    const embed = new EmbedBuilder()
        .setColor('#1d428a')
        .setTitle('FIFA World Cup Matches')
        .setDescription('Upcoming matches and completed scores. Times are Eastern.')
        .setTimestamp(new Date());

    for (const day of selectedDays) {
        const value = day.matches.length === 0
            ? 'No matches today.'
            : day.matches.map((match) => formatMatchLine(match.event)).join('\n');

        embed.addFields({
            name: formatDateHeading(day.dateKey, todayKey),
            value,
        });
    }

    const omittedMatchCount = matches.length - selectedMatchCount;
    const footer = omittedMatchCount > 0
        ? `Showing ${selectedMatchCount} of ${matches.length} matches through ${endDateKey}`
        : `Schedule through ${endDateKey}`;

    embed.setFooter({
        text: footer,
    });

    return embed;
}

export async function handleWorldCup(msg: Message): Promise<void> {
    const todayKey = getEasternDateKey(new Date());
    const endDateKey = addDaysToDateKey(todayKey, LOOKAHEAD_DAYS);

    try {
        const events = await fetchWorldCupMatches(todayKey, endDateKey);

        if (events.length === 0) {
            await msg.reply('No World Cup matches found for the next 7 days.');
            return;
        }

        await msg.reply({
            embeds: [
                buildWorldCupEmbed(events, todayKey, endDateKey),
            ],
        });
    } catch (err) {
        console.log(`Failed to fetch World Cup schedule: ${(err as any).toString()}`);
        await msg.reply('Failed to fetch World Cup schedule.');
    }
}
