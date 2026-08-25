function normalizeSpeech(value) {
    return String(value || '')
        .normalize('NFKC')
        .replace(/[\u2018\u2019]/g, "'")
        .toLocaleLowerCase('en-US')
        .replace(/[^\p{L}\p{N}']+/gu, ' ')
        .replace(/\s+/g, ' ')
        .trim();
}

function containsPhrase(transcript, phrase) {
    return ` ${transcript} `.includes(` ${phrase} `);
}

export function evaluateDialogueContract(contract, observations) {
    if (!contract) return null;
    const requiredPhrases = (contract.required_phrases || [])
        .map(normalizeSpeech)
        .filter(Boolean);
    if (!requiredPhrases.length) throw new Error('dialogue_contract.required_phrases must not be empty.');

    const minimumConfirmations = Math.max(1, Number(contract.minimum_confirmations) || 1);
    const minimumConfirmingModels = Math.max(1, Number(contract.minimum_confirming_models) || 1);
    const expectedSpeech = requiredPhrases.join(' ');
    const checked = observations.map(observation => {
        const normalized = normalizeSpeech(observation.text);
        const confirmsRequired = Boolean(normalized)
            && requiredPhrases.every(phrase => containsPhrase(normalized, phrase));
        return {
            ...observation,
            normalized,
            confirms_required: confirmsRequired,
            exact: normalized === expectedSpeech,
            extra_speech: Boolean(normalized) && normalized !== expectedSpeech,
        };
    });
    const confirmations = checked.filter(observation => observation.confirms_required).length;
    const exactConfirmations = checked.filter(observation => observation.exact).length;
    const confirmingModels = [...new Set(checked
        .filter(observation => observation.confirms_required)
        .map(observation => observation.model))];
    const extraSpeech = checked.filter(observation => observation.extra_speech);
    const allowExtraSpeech = contract.allow_extra_speech === true;
    let status = confirmations >= minimumConfirmations
        && confirmingModels.length >= minimumConfirmingModels
        ? 'passed'
        : 'ambiguous_or_missing';
    if (!allowExtraSpeech && extraSpeech.length) status = 'failed_extra_speech';

    return {
        status,
        required_phrases: contract.required_phrases,
        allow_extra_speech: allowExtraSpeech,
        minimum_confirmations: minimumConfirmations,
        minimum_confirming_models: minimumConfirmingModels,
        confirmations,
        exact_confirmations: exactConfirmations,
        confirming_models: confirmingModels,
        blank_observations: checked.filter(observation => !observation.normalized).length,
        extra_speech_observations: extraSpeech.map(observation => ({
            model: observation.model,
            run: observation.run,
            text: observation.text,
        })),
        observations: checked,
    };
}

export { normalizeSpeech };
