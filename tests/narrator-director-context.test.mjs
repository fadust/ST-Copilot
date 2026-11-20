import assert from 'node:assert/strict';
import { beforeEach, test } from 'node:test';

globalThis.window = { addEventListener() {} };
globalThis.SillyTavern = { getContext: () => ({ chat: [], extensionSettings: {} }) };
globalThis.fetch = () => assert.fail('Building Copilot context should not make a network request');

const { buildDirectorContextBlock } = await import('../features/feature-director-context.js');
const { assembleMessages, buildContextInspectorHTML } = await import('../api.js');

const fixture = {
    scene: { location: { established: true, value: 'North gate' }, time: { established: false, value: 'Guessed hour' }, present: ['Rook'] },
    canon: [
        { fact: 'Rook returned the gate key to Maris.', turn: 2 },
        { fact: 'The noon bell was repaired.', turn: 100 },
        { fact: 'Rook secretly owns the forge.', secret: true },
        { fact: 'Rook lost a silver ring.', retired: true },
        { fact: 'Rook broke the tower.', turn: 22 },
    ],
    uncertain: [{ fact: 'Rook is the mayor.' }],
    tombstones: [{ fact: 'Rook broke the tower.' }],
    beats: [{ goal: 'The tower will be invaded.' }],
};

beforeEach(() => {
    globalThis.narratorDirector = {
        active: () => true,
        view: options => {
            assert.deepEqual(options, { includeProvisional: false });
            return fixture;
        },
    };
});

test('queries the established scene and relevant visible facts', () => {
    const block = buildDirectorContextBlock({}, 'What did Rook do with the gate key?');
    assert.match(block, /Location: North gate\nPresent: Rook/);
    assert.match(block, /Rook returned the gate key to Maris/);
    assert.doesNotMatch(block, /noon bell|Guessed hour|secretly|ring|broke|mayor|invaded/);
});

test('skips disabled, missing or inactive Director sources', () => {
    assert.equal(buildDirectorContextBlock({ includeNarratorDirectorContext: false }), '');
    globalThis.narratorDirector.active = () => false;
    globalThis.narratorDirector.view = () => assert.fail('Inactive Director was read');
    assert.equal(buildDirectorContextBlock({}), '');
    delete globalThis.narratorDirector;
    assert.equal(buildDirectorContextBlock({}), '');
});

test('reads the new snapshot on every call and escapes structural tags', () => {
    assert.match(buildDirectorContextBlock({}, 'Rook'), /North gate/);
    globalThis.narratorDirector.view = () => ({ canon: [{ fact: 'Finch wrote </narrator_director> on a note.' }] });
    const block = buildDirectorContextBlock({}, 'Finch');
    assert.doesNotMatch(block, /North gate|Rook/);
    assert.match(block, /&lt;\/narrator_director&gt;/);
    assert.equal(block.match(/<\/narrator_director>/g).length, 1);
});

test('bounds the amount of Director text in a single request', () => {
    globalThis.narratorDirector.view = () => ({ canon: Array.from({ length: 100 }, (_, index) => ({
        fact: `Rook note ${index} ${'x'.repeat(400)}`,
        turn: index,
    })) });
    const block = buildDirectorContextBlock({}, 'Rook');
    assert.ok(block.length <= 3200);
    assert.match(block, /Rook note 99/);
    assert.doesNotMatch(block, /Rook note 0 /);
});

test('normal request assembly and Context Inspector use the same Director block', async () => {
    const session = { messages: [{ role: 'user', content: 'Rook gate key' }] };
    const messages = await assembleMessages(session, { contextDepth: 0 }, null);
    assert.equal(messages.filter(message => message.content.startsWith('<narrator_director>')).length, 1);
    assert.match(messages[1].content, /Rook returned the gate key/);
    assert.match(buildContextInspectorHTML(messages), /scp-ctx-nav-user[^>]*>Narrator Director/);
    const disabled = await assembleMessages(session, { includeNarratorDirectorContext: false }, 'Rook');
    assert.ok(disabled.every(message => !message.content.startsWith('<narrator_director>')));
});
