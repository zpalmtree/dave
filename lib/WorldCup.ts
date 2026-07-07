import {
    EmbedBuilder,
    Message,
    escapeMarkdown,
} from 'discord.js';

import fetch from 'node-fetch';

const EASTERN_TIME_ZONE = 'America/New_York';
const LOOKAHEAD_DAYS = 7;
const BRACKET_LOOKBACK_DAYS = 14;
const MAX_MATCHES = 10;
const ESPN_WORLD_CUP_SCOREBOARD =
    'https://site.api.espn.com/apis/site/v2/sports/soccer/fifa.world/scoreboard';
const TEAM_FLAGS: { [abbreviation: string]: string } = {
    ALG: '🇩🇿',
    ARG: '🇦🇷',
    AUS: '🇦🇺',
    AUT: '🇦🇹',
    BEL: '🇧🇪',
    BIH: '🇧🇦',
    BRA: '🇧🇷',
    CAN: '🇨🇦',
    CIV: '🇨🇮',
    COD: '🇨🇩',
    COL: '🇨🇴',
    CPV: '🇨🇻',
    CRO: '🇭🇷',
    CUW: '🇨🇼',
    CZE: '🇨🇿',
    ECU: '🇪🇨',
    EGY: '🇪🇬',
    ENG: '🏴󠁧󠁢󠁥󠁮󠁧󠁿',
    ESP: '🇪🇸',
    FRA: '🇫🇷',
    GER: '🇩🇪',
    GHA: '🇬🇭',
    HAI: '🇭🇹',
    IRN: '🇮🇷',
    IRQ: '🇮🇶',
    JOR: '🇯🇴',
    JPN: '🇯🇵',
    KOR: '🇰🇷',
    KSA: '🇸🇦',
    MAR: '🇲🇦',
    MEX: '🇲🇽',
    NED: '🇳🇱',
    NOR: '🇳🇴',
    NZL: '🇳🇿',
    PAN: '🇵🇦',
    PAR: '🇵🇾',
    POR: '🇵🇹',
    QAT: '🇶🇦',
    RSA: '🇿🇦',
    SCO: '🏴󠁧󠁢󠁳󠁣󠁴󠁿',
    SEN: '🇸🇳',
    SUI: '🇨🇭',
    SWE: '🇸🇪',
    TUN: '🇹🇳',
    TUR: '🇹🇷',
    URU: '🇺🇾',
    USA: '🇺🇸',
    UZB: '🇺🇿',
};

interface EspnScoreboardResponse {
    events?: EspnEvent[];
}

interface EspnEvent {
    name?: string;
    shortName?: string;
    date?: string;
    season?: EspnSeason;
    status?: EspnStatus;
    competitions?: EspnCompetition[];
}

interface EspnSeason {
    slug?: string;
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
    name?: string;
    location?: string;
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

interface PlaceholderResolver {
    [teamLabel: string]: string;
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

function getDiscordTimestamp(date: Date): string {
    const unixTimestamp = Math.floor(date.getTime() / 1000);

    return `<t:${unixTimestamp}:t> (<t:${unixTimestamp}:R>)`;
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

function getTeamLabels(competitor: EspnCompetitor | undefined): string[] {
    if (!competitor) {
        return [];
    }

    return [
        competitor.team?.abbreviation,
        competitor.team?.shortDisplayName,
        competitor.team?.displayName,
        competitor.team?.name,
        competitor.team?.location,
    ].filter((label): label is string => !!label);
}

function getTeamFlag(competitor: EspnCompetitor | undefined): string {
    const abbreviation = competitor?.team?.abbreviation;

    if (!abbreviation) {
        return '';
    }

    return TEAM_FLAGS[abbreviation] || '';
}

function formatTeam(
    competitor: EspnCompetitor | undefined,
    placeholderResolver: PlaceholderResolver = {},
): string {
    for (const label of getTeamLabels(competitor)) {
        if (placeholderResolver[label]) {
            return placeholderResolver[label];
        }
    }

    const flag = getTeamFlag(competitor);
    const name = escapeDiscordText(getTeamName(competitor));

    return flag ? `${flag} ${name}` : name;
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

function wrapMatchupTeamLabel(label: string): string {
    if (label.startsWith('Winner of ') || label.startsWith('Loser of ')) {
        return `(${label})`;
    }

    return label;
}

function formatMatchup(
    event: EspnEvent,
    placeholderResolver: PlaceholderResolver = {},
): string {
    const { home, away } = getHomeAwayTeams(event);

    if (home || away) {
        return [
            wrapMatchupTeamLabel(formatTeam(away, placeholderResolver)),
            wrapMatchupTeamLabel(formatTeam(home, placeholderResolver)),
        ].join(' vs ');
    }

    if (event.name) {
        return escapeDiscordText(event.name.replace(' at ', ' vs '));
    }

    return 'TBD vs TBD';
}

function getScore(competitor: EspnCompetitor | undefined): string {
    if (!competitor || competitor.score === undefined || competitor.score === '') {
        return '0';
    }

    return competitor.score;
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

function formatScore(
    event: EspnEvent,
    placeholderResolver: PlaceholderResolver = {},
): string {
    const scoredCompetitors = getScoredCompetitors(event);

    if (scoredCompetitors.length === 0) {
        return formatMatchup(event, placeholderResolver);
    }

    return scoredCompetitors
        .map((competitor) => `${formatTeam(competitor, placeholderResolver)} ${getScore(competitor)}`)
        .join(', ');
}

function formatCompletedScore(
    event: EspnEvent,
    placeholderResolver: PlaceholderResolver = {},
): string {
    const { away, home, competitors } = getHomeAwayTeams(event);
    const winner = competitors.find((competitor) => competitor.winner);
    const loser = competitors.find((competitor) => competitor !== winner);

    if (winner && loser) {
        return `${formatTeam(winner, placeholderResolver)} wins ${getScore(winner)}:${getScore(loser)} over ${formatTeam(loser, placeholderResolver)}`;
    }

    if (away && home && getScore(away) === getScore(home)) {
        return `${formatTeam(away, placeholderResolver)} draws ${getScore(away)}:${getScore(home)} with ${formatTeam(home, placeholderResolver)}`;
    }

    if (away && home) {
        return `${formatTeam(away, placeholderResolver)} ${getScore(away)}:${getScore(home)} ${formatTeam(home, placeholderResolver)}`;
    }

    return formatScore(event, placeholderResolver);
}

function getLiveLabel(status: EspnStatus | undefined): string {
    if (status?.type?.shortDetail === 'HT' || status?.type?.description === 'Halftime') {
        return 'Halftime';
    }

    if (status?.displayClock && status.displayClock !== "0'") {
        return `Live ${status.displayClock}`;
    }

    return 'Live';
}

function formatMatchLine(
    event: EspnEvent,
    placeholderResolver: PlaceholderResolver,
): string {
    const status = getStatus(event);
    const statusType = status?.type;
    const eventDate = event.date ? new Date(event.date) : undefined;
    const hasValidDate = eventDate !== undefined && !Number.isNaN(eventDate.getTime());

    if (statusType?.completed || statusType?.state === 'post') {
        return formatCompletedScore(event, placeholderResolver);
    }

    if (statusType?.state === 'in') {
        return `${getLiveLabel(status)} - ${formatScore(event, placeholderResolver)}`;
    }

    if (statusType?.state === 'pre') {
        return `${hasValidDate ? getDiscordTimestamp(eventDate!) : 'TBD'} - ${formatMatchup(event, placeholderResolver)}`;
    }

    if (statusType?.shortDetail && statusType.shortDetail !== 'Scheduled') {
        const display = statusType.completed
            ? formatCompletedScore(event, placeholderResolver)
            : formatMatchup(event, placeholderResolver);
        return `${statusType.shortDetail} - ${display}`;
    }

    return `${hasValidDate ? getDiscordTimestamp(eventDate!) : 'TBD'} - ${formatMatchup(event, placeholderResolver)}`;
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

function getEventsByRound(events: EspnEvent[], roundSlug: string): EspnEvent[] {
    return events
        .filter((event) => event.season?.slug === roundSlug)
        .filter((event) => {
            if (!event.date) {
                return false;
            }

            return !Number.isNaN(new Date(event.date).getTime());
        })
        .sort((a, b) => new Date(a.date!).getTime() - new Date(b.date!).getTime());
}

function addPlaceholderLabels(
    placeholderResolver: PlaceholderResolver,
    labels: string[],
    value: string,
): void {
    for (const label of labels) {
        placeholderResolver[label] = value;
    }
}

function getWinnerOrPlaceholderLabel(
    event: EspnEvent,
    placeholderResolver: PlaceholderResolver,
): string {
    const winner = getCompetition(event)?.competitors?.find((competitor) => competitor.winner);

    if (winner && getStatus(event)?.type?.completed) {
        return formatTeam(winner, placeholderResolver);
    }

    return `Winner of ${formatMatchup(event, placeholderResolver)}`;
}

function getLoserOrPlaceholderLabel(
    event: EspnEvent,
    placeholderResolver: PlaceholderResolver,
): string {
    const competitors = getCompetition(event)?.competitors || [];
    const winner = competitors.find((competitor) => competitor.winner);
    const loser = competitors.find((competitor) => competitor !== winner);

    if (winner && loser && getStatus(event)?.type?.completed) {
        return formatTeam(loser, placeholderResolver);
    }

    return `Loser of ${formatMatchup(event, placeholderResolver)}`;
}

function buildPlaceholderResolver(events: EspnEvent[]): PlaceholderResolver {
    const placeholderResolver: PlaceholderResolver = {};

    getEventsByRound(events, 'round-of-16').forEach((event, index) => {
        const gameNumber = index + 1;
        addPlaceholderLabels(
            placeholderResolver,
            [
                `RD16 W${gameNumber}`,
                `Round of 16 ${gameNumber} Winner`,
            ],
            getWinnerOrPlaceholderLabel(event, placeholderResolver),
        );
    });

    getEventsByRound(events, 'quarterfinals').forEach((event, index) => {
        const gameNumber = index + 1;
        addPlaceholderLabels(
            placeholderResolver,
            [
                `QFW${gameNumber}`,
                `QF W${gameNumber}`,
                `QW${gameNumber}`,
                `Quarterfinal ${gameNumber} Winner`,
            ],
            getWinnerOrPlaceholderLabel(event, placeholderResolver),
        );
    });

    getEventsByRound(events, 'semifinals').forEach((event, index) => {
        const gameNumber = index + 1;
        addPlaceholderLabels(
            placeholderResolver,
            [
                `SFW${gameNumber}`,
                `SF W${gameNumber}`,
                `Semifinal ${gameNumber} Winner`,
            ],
            getWinnerOrPlaceholderLabel(event, placeholderResolver),
        );
        addPlaceholderLabels(
            placeholderResolver,
            [
                `SF L${gameNumber}`,
                `Semifinal ${gameNumber} Loser`,
            ],
            getLoserOrPlaceholderLabel(event, placeholderResolver),
        );
    });

    return placeholderResolver;
}

function buildWorldCupEmbed(events: EspnEvent[], todayKey: string): EmbedBuilder {
    const placeholderResolver = buildPlaceholderResolver(events);
    const matches = getSortedMatchDisplays(events)
        .filter((match) => match.dateKey >= todayKey);
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
        .filter((dateKey) => dateKey > todayKey)
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
        .setTitle('FIFA World Cup Matches');

    for (const day of selectedDays) {
        const value = day.matches.length === 0
            ? 'No matches today.'
            : day.matches.map((match) => formatMatchLine(match.event, placeholderResolver)).join('\n\n');

        embed.addFields({
            name: formatDateHeading(day.dateKey, todayKey),
            value,
        });
    }

    return embed;
}

export async function handleWorldCup(msg: Message): Promise<void> {
    const todayKey = getEasternDateKey(new Date());
    const fetchStartKey = addDaysToDateKey(todayKey, -BRACKET_LOOKBACK_DAYS);
    const endDateKey = addDaysToDateKey(todayKey, LOOKAHEAD_DAYS);

    try {
        const events = await fetchWorldCupMatches(fetchStartKey, endDateKey);
        const upcomingMatches = getSortedMatchDisplays(events)
            .filter((match) => match.dateKey >= todayKey);

        if (upcomingMatches.length === 0) {
            await msg.reply('No World Cup matches found for the next 7 days.');
            return;
        }

        await msg.reply({
            embeds: [
                buildWorldCupEmbed(events, todayKey),
            ],
        });
    } catch (err) {
        console.log(`Failed to fetch World Cup schedule: ${(err as any).toString()}`);
        await msg.reply('Failed to fetch World Cup schedule.');
    }
}
