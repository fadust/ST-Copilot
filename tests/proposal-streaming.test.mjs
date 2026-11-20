import assert from 'node:assert/strict';
import { test } from 'node:test';

globalThis.window = { addEventListener() {} };
const { abortGeneration, callGenerate } = await import('../api.js');
const { parseLBChangesFromText } = await import('../features/feature-lorebook-engine.js');

const lorebookBlock = '```lorebook-changes\n{"changes":[{"action":"add","worldName":"Cast","name":"Rook","content":"Returns the key."}]}\n```';
const partial = 'I’ll add the key handoff.\n\n' + lorebookBlock.slice(0, -21);

function generate(sendRequest, onChunk, settings = {}) {
    const profile = { id: 'fixture', api: 'openai', model: 'fixture' };
    globalThis.SillyTavern = { getContext: () => ({
        chat: [],
        extensionSettings: { connectionManager: { selectedProfile: profile.id } },
        ConnectionManagerRequestService: {
            getSupportedProfiles: () => [profile],
            sendRequest,
        },
    }) };
    const session = { messages: [{ role: 'user', content: 'Record Rook’s key handoff in Cast.' }] };
    return callGenerate(session, { forceStreaming: 'on', ...settings }, null, onChunk);
}

test('empty terminal packets preserve streamed text and finish reason', async () => {
    const chunks = [];
    const result = await generate(() => async function* () {
        yield { text: 'The gate is open.', state: { reasoning: 'The record says so.' } };
        yield { choices: [{ finish_reason: 'length' }] };
        return { usage: {} };
    }, text => chunks.push(text));
    assert.deepEqual(chunks, ['The gate is open.', 'The gate is open.']);
    assert.deepEqual(result, { text: 'The gate is open.', reasoning: 'The record says so.', isMaxTokens: true });
});

test('a cut-off proposal stays in the same reply and makes one non-streaming repair request', async () => {
    let calls = 0;
    const result = await generate((profile, messages, maxTokens, { stream }) => {
        calls++;
        if (calls === 1) {
            assert.equal(stream, true);
            return async function* () {
                yield { text: partial };
                throw new Error('Stream closed');
            };
        }
        assert.equal(stream, false);
        assert.equal(messages.at(-3).content, 'Record Rook’s key handoff in Cast.');
        assert.equal(messages.at(-2).content, partial);
        assert.match(messages.at(-1).content, /lorebook-changes/);
        return { choices: [{ message: { content: lorebookBlock } }] };
    });
    assert.equal(calls, 2);
    assert.equal(result.text, 'I’ll add the key handoff.\n\n' + lorebookBlock);
    assert.equal(parseLBChangesFromText(result.text)[0].name, 'Rook');
});

test('a partially streamed proposal tag triggers recovery', async () => {
    let calls = 0;
    const result = await generate((profile, messages, maxTokens, { stream }) => {
        calls++;
        return stream ? async function* () { yield { text: 'I have an entry ready.\n```lorebook-ch' }; } : lorebookBlock;
    });
    assert.equal(calls, 2);
    assert.equal(result.text, 'I have an entry ready.\n' + lorebookBlock);
});

test('a complete JSON body with a missing closing fence is closed locally', async () => {
    const result = await generate((profile, messages, maxTokens, { stream }) => {
        assert.equal(stream, true);
        return async function* () { yield { text: lorebookBlock.slice(0, -2) }; };
    });
    assert.equal(result.text, lorebookBlock);
});

test('complete replies and ordinary code fences stay as received', async () => {
    for (const reply of ['Done.', lorebookBlock, 'Example:\n```json\n{"example": 1}']) {
        const result = await generate((profile, messages, maxTokens, { stream }) => {
            assert.equal(stream, true);
            return async function* () { yield { text: reply }; };
        });
        assert.equal(result.text, reply);
    }
});

test('failed repair keeps the partial reply without exposing it as an applicable proposal', async () => {
    const cut = lorebookBlock.replace(/}]\}\n```$/, '},');
    assert.equal(parseLBChangesFromText(cut), null);
    let calls = 0;
    const result = await generate((profile, messages, maxTokens, { stream }) => {
        calls++;
        return stream ? async function* () { yield { text: cut }; } : 'Still working on it.';
    });
    assert.equal(calls, 2);
    assert.equal(result.incompleteProposal, true);
    assert.equal(result.text, cut);
});

test('Stop leaves a partial stream without submitting a repair', async () => {
    let calls = 0;
    const result = await generate(() => {
        calls++;
        return async function* () { yield { text: partial }; };
    }, () => abortGeneration());
    assert.equal(result, null);
    assert.equal(calls, 1);
});

const leakedLookup = '<｜DSML｜ calls>\n<｜DSML｜ invoke name="lorebook_entry_settings">\n\n</｜DSML｜ invoke>\n</｜DSML｜ calls>';

test('a visible DSML lookup cancels the first stream and restarts once without forwarding the markup', async () => {
    let streamSignal;
    let requestedNextChunk = false;
    const chunks = [];
    let calls = 0;
    const result = await generate((profile, messages, maxTokens, { stream, signal }) => {
        calls++;
        assert.match(messages[0].content, /No callable lorebook tools are available/);
        if (stream) {
            streamSignal = signal;
            return async function* () {
                yield { text: leakedLookup };
                requestedNextChunk = true;
                throw new Error('The stream stalls here');
            };
        }
        assert.ok(streamSignal.aborted);
        assert.ok(!signal.aborted);
        assert.match(messages[0].content, /previous attempt emitted unsupported tool markup/);
        assert.equal(messages.at(-1).content, 'Record Rook’s key handoff in Cast.');
        assert.ok(messages.every(message => !message.content.includes('DSML')));
        return { content: lorebookBlock };
    }, text => chunks.push(text), { lorebookAIManageEnabled: true });
    assert.equal(calls, 2);
    assert.equal(requestedNextChunk, false);
    assert.equal(chunks.length, 0);
    assert.equal(parseLBChangesFromText(result.text)[0].name, 'Rook');
});

test('a reasoning-only lookup can recover but a second invalid reply produces a clear message', async () => {
    let calls = 0;
    const result = await generate((profile, messages, maxTokens, { stream }) => {
        calls++;
        return stream ? async function* () {
            yield { state: { reasoning: leakedLookup } };
            throw new Error('Connection closed before an answer');
        } : { text: leakedLookup };
    }, undefined, { lorebookAIManageEnabled: true });
    assert.equal(calls, 2);
    assert.match(result.text, /model stopped during a lorebook lookup/);
    assert.doesNotMatch(result.text, /DSML/);
    assert.equal(parseLBChangesFromText(result.text), null);
});
