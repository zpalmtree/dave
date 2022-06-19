import { Message } from 'discord.js';
import { Configuration, OpenAIApi } from 'openai';

import { config } from './Config.js';

const configuration = new Configuration({
    apiKey: config.openaiApiKey,
});

const openai = new OpenAIApi(configuration);

const DEFAULT_TEMPERATURE = 0.9;
const DEFAULT_MAX_TOKENS = 2000;
const DEFAULT_AI_MODEL = 'text-davinci-002';

export async function handleGPT3(msg: Message, args: string): Promise<void> {
    const prompt = args.trim();

    if (prompt.length === 0) {
        msg.reply(`No prompt given. Try \`${config.prefix}ai help\``);
        return;
    }

    const completion = await handleGPT3Request(prompt);

    if (completion) {
        msg.reply(completion);
    } else {
        msg.reply('Failed to get response from API!');
    }
}

export async function handleGPT3Request(
    prompt: string,
    model: string = DEFAULT_AI_MODEL,
    maxTokens: number = DEFAULT_MAX_TOKENS,
    temperature: number = DEFAULT_TEMPERATURE,
) {
    const completion = await openai.createCompletion({
        model,
        prompt,
        max_tokens: maxTokens,
        temperature,
        echo: true,
    });

    if (completion.data.choices && completion.data.choices.length > 0) {
        return completion.data.choices[0].text!;
    }

    return undefined;
}
