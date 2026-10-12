import { VideoModelId } from './VideoProtocol.js';

/**
 * A built-in recurring video character: a bundled portrait, a persona, and the
 * Discord commands that star him. To add one, put his portrait in images/ and
 * add an entry to VIDEO_CHARACTERS. The commands, broker validation, planner
 * guidance, and image-composition prompts all derive from that entry.
 */
export interface VideoCharacter {
    /** Lowercase cast name. Also the starting-image preset the bots submit. */
    id: string;
    name: string;
    /** Portrait PNG in images/: his identity reference and default opening frame. */
    image: string;
    /** Other preset names that older clients submit. */
    presetAliases?: string[];
    /** Per renderer: the command (also the command_variant recorded on jobs), extra Discord aliases, and the label in status posts. */
    commands: Partial<Record<VideoModelId, { variant: string; aliases?: string[]; label: string }>>;
    /** Completes the help example "<command> ...". */
    example: string;
    /** His eyes as the portrait shows them; generated scenes otherwise enlarge them. */
    eyes: string;
    clothing: string;
    /** The clothing and any emblem, as a noun phrase starting with "the". */
    clothingAndEmblem: string;
    /** Complete default dialogue.delivery voice description. Keep it free of double quotes. */
    delivery: string;
    /** The accent named in delivery, kept through every requested emotion. */
    accent: string;
    /** Short accent name for verbatim user dialogue. */
    accentLabel: string;
    /** Completes "give the <name> character ...". */
    dialogueStyle: string;
    /** Slang that seasons his generated lines. */
    slang: string[];
    /** A pronunciation rule for any slang the speech model would misread. */
    pronunciation?: string;
    /** Sentences on his national pride, running jokes, and memes, added to the shared comedic persona. */
    persona?: string;
}

export const MEXIMUTT: VideoCharacter = {
    id: 'meximutt',
    name: 'Meximutt',
    image: 'oalgo.png',
    presetAliases: ['oalgo'],
    commands: {
        minimax: { variant: 'oalgo', aliases: ['meximutt', 'minimutt'], label: 'Oalgo' },
        minimaxfast: { variant: 'oalgofast', label: 'Oalgo Fast' },
    },
    example: 'celebrates a championship victory',
    eyes: 'narrow eyes',
    clothing: 'Mexican-flag clothing',
    clothingAndEmblem: 'the Mexican flag clothing and emblem',
    // Preferred in the blinded Stargate accent comparison; keep this wording as
    // the default delivery while allowing a scene's explicitly requested emotion.
    delivery: 'boastful and conversational adult male, with a low, chest-resonant voice and a strong Mexican Spanish accent on every English phrase, using full vowels, a lightly tapped r, crisp consonants, and animated rise-and-fall intonation',
    accent: 'Mexican Spanish',
    accentLabel: 'Spanglish',
    dialogueStyle: 'playful Mexican-American slang and code-switching',
    slang: ['o algo', 'mayne', 'wey', 'puta pinche', 'no mames wey'],
    pronunciation: 'The separate slang phrase "o algo" is pronounced as Spanish words, never as individual letters.',
};

export const ARGENMUTT: VideoCharacter = {
    id: 'argenmutt',
    name: 'Argenmutt',
    image: 'argenmutt.png',
    commands: { minimax: { variant: 'argenmutt', label: 'Argenmutt' } },
    example: 'explains why Argentina invented everything',
    eyes: 'small deep-set eyes',
    clothing: 'sky-blue-and-white Argentina-flag T-shirt',
    clothingAndEmblem: 'the sky-blue and white Argentine flag T-shirt and its golden sun emblem',
    delivery: 'boastful and conversational adult male, with a low, chest-resonant voice and a strong Argentine Rioplatense Spanish accent on every English phrase, using a sing-song Italian-style melody, full vowels, a sh sound for y and ll, breathy s at the end of syllables, and animated rise-and-fall intonation',
    accent: 'Argentine Rioplatense Spanish',
    accentLabel: 'Argentine',
    dialogueStyle: 'playful Argentine slang, voseo, and English-Spanish code-switching',
    slang: ['che', 'boludo', 'dale', 'posta', 'qué quilombo', 'la concha de la lora', 'qué mirás, bobo'],
    persona: 'His Argentine pride drives the comedy: Argentina is the greatest country on Earth and invented everything worth having, Messi and Maradona are saints he invokes for any occasion, and three World Cup stars settle every argument. He insists his nono was Italian so he is basically European, rates everything against asado, mate, fernet with cola, and dulce de leche, and blames setbacks on inflation, the referee, Brazil, or the English. Use memes such as “andá pa’ allá, bobo,” “no hay plata,” “lo atamos con alambre,” “la mano de Dios,” and prices that double before he finishes the sentence when they fit the beat.',
};

export const COLOMBIANMUTT: VideoCharacter = {
    id: 'colombianmutt',
    name: 'Colombianmutt',
    image: 'colombianmutt.png',
    commands: { minimax: { variant: 'colombianmutt', label: 'Colombianmutt' } },
    example: 'argues that the arepa is Colombian',
    eyes: 'narrow hooded eyes',
    clothing: 'yellow, blue, and red Colombia-flag T-shirt',
    clothingAndEmblem: 'the yellow, blue, and red striped Colombian flag T-shirt',
    delivery: 'boastful and conversational adult male, with a low, chest-resonant voice and a strong Colombian Spanish accent on every English phrase, using a warm sing-song melody that stretches the last syllable, full vowels, a lightly tapped r, crisp consonants, and animated rise-and-fall intonation',
    accent: 'Colombian Spanish',
    accentLabel: 'Colombian',
    dialogueStyle: 'playful Colombian slang and English-Spanish code-switching',
    slang: ['parce', 'pues', 'hágale', 'qué chimba', 'uy, qué pena', 'no dé papaya', 'hijueputa', 'eh, Ave María'],
    persona: 'His Colombian pride drives the comedy: Colombia has the best coffee, the best dancers, and the only real arepa on Earth, and he argues all three with anyone, above all a Venezuelan. He corrects every “Columbia” to “Colombia, with an O,” brags about Shakira, James, and the five-nil win over Argentina, is always “ya casi llegando” while an hour late, and wraps every insult in politeness such as “qué pena con usted” and “a la orden.” He takes huge offense at any Narcos or Escobar joke and steers it back to coffee, and he blames setbacks on whoever “dio papaya,” the traffic, or the runaway hippos. Use memes such as “no dar papaya,” “Colombia, not Columbia,” and “we don’t talk about Bruno” when they fit the beat.',
};

export const VIDEO_CHARACTERS: readonly VideoCharacter[] = [MEXIMUTT, ARGENMUTT, COLOMBIANMUTT];

export function videoCharacterForPreset(preset: unknown): VideoCharacter | null {
    return VIDEO_CHARACTERS.find(character => character.id === preset
        || character.presetAliases?.includes(preset as string)) || null;
}

/** The character a job's command_variant stars, if any. */
export function videoCharacterForCommand(variant: string | null | undefined): VideoCharacter | null {
    return VIDEO_CHARACTERS.find(character => Object.values(character.commands)
        .some(command => command.variant === variant)) || null;
}

export function videoCharacterCommandLabel(variant: string | null | undefined): string | null {
    return VIDEO_CHARACTERS.flatMap(character => Object.values(character.commands))
        .find(command => command.variant === variant)?.label || null;
}

function quotedList(phrases: string[]): string {
    return [...phrases.slice(0, -1).map(phrase => `“${phrase},”`), `and “${phrases.at(-1)}”`].join(' ');
}

export function videoCharacterPlannerGuidance(character: VideoCharacter): string {
    const { name } = character;
    return [
        `${name} is the recurring character in an enacted visual story. Treat the supplied portrait as his identity and opening frame, not as a requirement to hold its crop, background, or pose for the entire video.`,
        'Resolve spoken wording and visual subject matter independently. When the prompt is a boast, rant, or other utterance about concrete projects, places, objects, transformations, or game mechanics, preserve the appropriate spoken wording while visibly staging its distinctive ideas as actions with consequences. Put those visible beats in the analysis actions and inferred_staging, then realize them in shot.visual; mentioning them only in dialogue, intent, or eyebrow gestures does not cover them.',
        `${name} is a real man in photorealistic live-action footage. Keep fantastical or mythic scenes in that photographic realism, with real, physically present places, creatures, and props, and his own ${character.eyes} and facial proportions, unless the user asks for another rendering style.`,
        `After honoring frame zero, use motivated camera reveals, interactions, transformations, or later cuts to develop the premise around the recognizable ${name} character. Keep his face and mouth readable while he speaks, but allow a wider composition and changing surroundings. Preserve his ${character.clothing} while showing any separately requested national symbols in the scene.`,
        `For a reaction to an attached image, identify the main depicted subject and the props or relationships that explain the situation. Keep that subject recognizable and visibly connect ${name} to it. In shot.visual, name the target of each purposeful glance or head turn and when it happens relative to his speech and reaction; choose the subject and any story-defining prop that he would naturally notice, rather than merely listing them as background scenery. Make the look legible through a clear directional head turn and a useful camera view of both observer and target; a tiny eye shift or downward nod in a distant composition is insufficient.`,
        'Make expressions develop in response to what he notices, using readable changes in eyes, brows, mouth, or posture appropriate to the requested emotion. Preserve facial identity without freezing his face or body. A request to look into the camera describes that action beat, not a permanent gaze lock; leave room for a motivated look toward the scene while preserving the user\'s action order and exact words. If the user explicitly requires continuous eye contact, stillness, or a specific expression sequence, honor that restriction and use only compatible reactions.',
        'When a spoken beat and a separate physical reaction must happen in order, place them in successive shots with dialogue attached only to the speaking shot. Use a dialogue-free reaction shot to make the action readable, instead of packing a long sequence of timestamps into one shot.visual and placing its dialogue after the whole sequence. Keep the same viewpoint if the user explicitly locks the camera; separate beats need not add locations, segments, or runtime. For actions intended to accompany speech, keep them together in the speaking shot.',
        'Develop the visual beats alongside the corresponding spoken phrases instead of reciting the whole monologue first and adding a long silent reenactment afterward. A short utterance with linked ideas normally needs its natural speaking time plus a brief setup and payoff, not a separate segment for each noun. Split long supplied speech at natural clause boundaries across shots or segments while preserving every word and its order. Add runtime only when a required action needs it to remain legible or the user requests it.',
        'Use a static talking head only when the user requests that presentation or the brief is a simple greeting or performance with no visual story to enact. Do not invent a ban on new props, graphics, scene changes, or camera movement merely because dialogue is supplied verbatim. Respect actual user restrictions on text, motion, camera, or presentation.',
        `Use this default ${name} voice description in dialogue.delivery: "${character.delivery}". Copy it in full for his ordinary boastful or conversational delivery, including English-only lines and dialogue supplied verbatim by the user.`,
        `For a different requested emotion, adapt the performance while retaining the low, chest-resonant adult male voice and strong ${character.accent} accent through complaints, shouts, and emotional changes. Keep the voice description outside dialogue.text and language; never recite these instructions or phonetically respell the supplied words. Avoid a neutral American narrator or flat text-to-speech delivery.`,
        `When the requested action or source image supports dialogue, give the ${name} character ${character.dialogueStyle}.`,
        `${name} is the recurring character's cast name. ${character.pronunciation
            ? `${character.pronunciation} Keep speaker IDs and user-supplied dialogue.text unchanged; specify this pronunciation in dialogue.delivery when the name or phrase occurs in spoken wording.`
            : 'Keep speaker IDs and user-supplied dialogue.text unchanged.'} A speaker name is a cast label, not extra dialogue: never announce it unless it belongs to the requested line.`,
        `Season nearly every new ${name} line with slang such as ${quotedList(character.slang)}; vary which phrases appear across lines rather than repeating one, and place it where he would naturally say it, with the joke carried by what the line says.`,
        `Play ${name} as a comedic character, not a narrator: he is supremely and boastfully confident, treats his own schemes and hot takes as genius, never admits he is wrong, and stays that certain whatever happens to him. Build each sketch from its own premise rather than a standing formula: the scheme may work absurdly well, he may be right for a ridiculous reason, he may win and immediately want something stupider, another character may get the last word, or it may fall apart. Indignantly blaming an object or a bystander for a failure is one ending among these; choose it only when this premise makes it the funniest, and give the final line to whichever character and wording the scene has earned. His generated lines react to what is happening in the shot—bragging, complaining, justifying, or escalating—instead of describing the premise the viewer can already see.`,
        ...(character.persona ? [character.persona] : []),
        `Preserve any dialogue the user explicitly requested verbatim in dialogue.text; apply slang and code-switching only to new or adaptable ${name} wording, but always retain the ${character.accentLabel} accent in dialogue.delivery without translating, rewriting, or adding words to supplied lines.`,
    ].join(' ');
}

// Generated scene openings for fantastical premises drift into a glossy CG look,
// and H3 then keeps that medium and gives the character cartoon eyes. State the
// photographic medium positively; the image models draw negated styles too.
export function videoCharacterPhotorealKeyframe(character: VideoCharacter): string {
    return `Render this as a photorealistic live-action photograph with the camera realism of the original ${character.name} portrait: real people with natural skin texture and pores, real fabric, natural lens optics and lighting, and ${character.name}, wherever he appears, with his own ${character.eyes} at their true size, even in a fantastical setting, unless the request itself asks for a different art style.`;
}

// Local Qwen Image Edit has never heard of the characters. Read as a creature's
// name, "Meximutt" drew a mascot in his flag shirt and gave his face to another
// cast member (61af9651). Name him only through his reference picture.
export function bindLocalPresetIdentity(text: string, character: VideoCharacter): string {
    const { name } = character;
    return text.replace(new RegExp(`\\bthe original ${name} portrait\\b`, 'g'), 'Picture 1')
        .replace(new RegExp(`\\b${name}'s\\b`, 'g'), "the Picture 1 man's")
        .replace(new RegExp(`\\b${name}\\b`, 'g'), 'the man in Picture 1');
}
