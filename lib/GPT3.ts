import { Message, Util } from 'discord.js';
import { Configuration, OpenAIApi } from 'openai';
import Filter from 'bad-words';

import { config } from './Config.js';
import { BannedWords } from './BannedWords.js';

const badWordFilter = new Filter();
badWordFilter.addWords(...BannedWords);

const configuration = new Configuration({
    apiKey: config.openaiApiKey,
});

const openai = new OpenAIApi(configuration);

const DEFAULT_TEMPERATURE = 0.9;
const DEFAULT_MAX_TOKENS = 250;
const DEFAULT_AI_MODEL = 'text-davinci-002';
const DEFAULT_TIMEOUT = 1000 * 30;

export async function handleGPT3(msg: Message, args: string): Promise<void> {
    const bannedUsers = [
        '663270358161293343',
    ];

    if (bannedUsers.includes(msg.author.id)) {
        await msg.reply(`Sorry, this function has been disabled for your user.`);
        return;
    }

    const prompt = args.trim();

    if (prompt.length === 0) {
        await msg.reply(`No prompt given. Try \`${config.prefix}ai help\``);
        return;
    }

    const { result, error } = await handleGPT3Request(
        prompt,
        undefined,
        undefined,
        undefined,
        msg.author.id,
    );

    if (result) {
        /* Ensure we don't hit discord api limits */
        const stripped = Util.escapeMarkdown(result.substr(0, 1900));

        await msg.reply(stripped);
    } else {
        await msg.reply(error);
    }
}

export async function handleGPT3Request(
    prompt: string,
    model: string = DEFAULT_AI_MODEL,
    maxTokens: number = DEFAULT_MAX_TOKENS,
    temperature: number = DEFAULT_TEMPERATURE,
    user: string = '',
) {
    /*
    if (badWordFilter.isProfane(prompt)) {
        prompt = badWordFilter.clean(prompt);
    }
    */

    const prefix = `You are a helpful AI bot who always provides answers to peoples questions. Don't give any indefinitive answers, if you're not sure, then make a guess. Question: `;

    let modifiedPrompt = `${prefix}${prompt}`;

    let maxAttempts = 3;
    let attempt = 0;

    while (attempt <= maxAttempts) {
        attempt++;

        try {
            const completion = await openai.createCompletion({
                model,
                prompt: modifiedPrompt,
                max_tokens: maxTokens,
                temperature,
                echo: true,
                user,
            }, {
                timeout: DEFAULT_TIMEOUT,
            });

            if (completion.data.choices && completion.data.choices.length > 0) {
                let generation = completion.data.choices[0].text!;

                if (generation === modifiedPrompt) {
                    continue;
                }

                if (generation.startsWith(prefix)) {
                    generation = generation.slice(prefix.length);
                }

                return {
                    result: generation,
                    error: undefined,
                };
            }
        } catch (err) {
            return {
                result: undefined,
                error: err.toString(),
            };
        }
    }
    
    return {
        result: undefined,
        error: 'Failed to get response from API',
    };
}
