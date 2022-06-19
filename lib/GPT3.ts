import { Message, Util } from 'discord.js';
import { Configuration, OpenAIApi } from 'openai';

import { config } from './Config.js';

const configuration = new Configuration({
    apiKey: config.openaiApiKey,
});

const openai = new OpenAIApi(configuration);

const DEFAULT_TEMPERATURE = 0.9;
const DEFAULT_MAX_TOKENS = 900;
const DEFAULT_AI_MODEL = 'text-davinci-002';
const DEFAULT_TIMEOUT = 1000 * 30;

export async function handleGPT3(msg: Message, args: string): Promise<void> {
    const prompt = args.trim();

    if (prompt.length === 0) {
        await msg.reply(`No prompt given. Try \`${config.prefix}ai help\``);
        return;
    }

    const tempRegex = /(^[\d.]+)?(.*)/s;

    const results = tempRegex.exec(prompt);

    if (!results) {
        await msg.reply(`No prompt given. Try \`${config.prefix}ai help\``);
        return;
    }

    /* Extract temp if present */
    const [ , temp, query ] = results;

    const completion = await handleGPT3Request(
        query,
        undefined,
        undefined,
        Number(temp) || undefined,
    );

    if (completion) {
        /* Ensure we don't hit discord api limits */
        const stripped = Util.escapeMarkdown(completion.substr(0, 1999));

        await msg.reply(stripped);
    } else {
        await msg.reply('Timed out getting result.');
    }
}

export async function handleGPT3Request(
    prompt: string,
    model: string = DEFAULT_AI_MODEL,
    maxTokens: number = DEFAULT_MAX_TOKENS,
    temperature: number = DEFAULT_TEMPERATURE,
) {
    try {
        const completion = await openai.createCompletion({
            model,
            prompt,
            max_tokens: maxTokens,
            temperature,
            echo: true,
        }, {
            timeout: DEFAULT_TIMEOUT,
        });

        if (completion.data.choices && completion.data.choices.length > 0) {
            return completion.data.choices[0].text!;
        }
    } catch (err) {
        console.log(err.toString());
        return undefined;
    }
    
    return undefined;
}
