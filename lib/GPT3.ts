import { Message } from 'discord.js';
import { Configuration, OpenAIApi } from 'openai';

import { config } from './Config.js';

const configuration = new Configuration({
    apiKey: config.openaiApiKey,
});

const openai = new OpenAIApi(configuration);

const DEFAULT_TEMPERATURE = 1;
const DEFAULT_MAX_TOKENS = 500;
const DEFAULT_AI_MODEL = 'gpt-3.5-turbo';
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
        const stripped = result.substr(0, 1900);
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
    //const prefix = `If the following query is factual, answer it honestly. You can use discord style markdown formatting for bolding, italics, and quotations. When displaying code, you should use fenced code blocks created with three backticks (\`\`\`), and specify the language of the code to allow syntax highlighting to work. However, if you do not have sufficient details about a certain piece of info to answer the query, or cannot predict the result, make it up, and answer in a graphic, short story style.\n\n`;
    const prefix = '';

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
                error: (err as any).toString(),
            };
        }
    }
    
    return {
        result: undefined,
        error: 'Got same completion as input. Try with a modified prompt.',
    };
}
