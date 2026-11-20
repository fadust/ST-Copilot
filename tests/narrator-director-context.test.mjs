import assert from 'node:assert/strict';
import { beforeEach, test } from 'node:test';

globalThis.window = { addEventListener() {} };
globalThis.SillyTavern = { getContext: () => ({ chat: [], extensionSettings: {} }) };
globalThis.fetch = () => assert.fail('Building Copilot context should not make a network request');

const { buildDirectorContextBlock, DIRECTOR_ANSWER_RULES } = await import('../features/feature-director-context.js');
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

test('keeps all character matches and the end of a long relevant record', () => {
    globalThis.narratorDirector.view = () => ({
        cast: { 'Rook Flint': {} },
        canon: [
            ...Array.from({ length: 12 }, (_, index) => ({ fact: `Rook note ${index}.`, turn: index })),
            { fact: `${'Earlier details. '.repeat(35)}At the end, Rook handed the book to Maris.` },
            { fact: 'Maris did not enter the orchard.', turn: 14 },
        ],
    });
    const block = buildDirectorContextBlock({}, 'What does Director know about Rook? Do not add any guesses.');
    assert.equal(block.match(/^\d+\. /gm).length, 13);
    assert.match(block, /Rook note 0\./);
    assert.match(block, /At the end, Rook handed the book to Maris\./);
    assert.doesNotMatch(block, /orchard/);
});

test('keeps orders distinct from completed actions in compound records', () => {
    globalThis.narratorDirector.view = () => ({ canon: [
        { fact: 'Maris found the copper tub and ordered Rook to heat water. Rook handed her the book.' },
        { fact: 'Rook was told to close the gate.' },
    ] });
    const block = buildDirectorContextBlock({}, 'Rook');
    assert.match(block, /Rook handed her the book\./);
    assert.match(block, /Order or request, completion unconfirmed by this clause: “ordered Rook to heat water”/);
    assert.match(block, /completion unconfirmed by this clause: “told to close the gate”/);
    assert.doesNotMatch(block, /Rook heated|Rook closed/);
});

test('keeps a short recent fallback for generic questions', () => {
    globalThis.narratorDirector.view = () => ({ canon: Array.from({ length: 9 }, (_, index) => ({ fact: `Record ${index}`, turn: index })) });
    const block = buildDirectorContextBlock({}, 'What does Director know?');
    assert.equal(block.match(/^\d+\. /gm).length, 4);
    assert.match(block, /Record 8/);
    assert.doesNotMatch(block, /Record 0/);
});

test('normal request assembly and Context Inspector use the same Director block', async () => {
    const session = { messages: [{ role: 'user', content: 'Rook gate key' }] };
    const messages = await assembleMessages(session, { contextDepth: 0 }, null);
    assert.equal(messages.filter(message => message.content.startsWith('<narrator_director>')).length, 1);
    assert.match(messages[1].content, /Rook returned the gate key/);
    assert.ok(messages[0].content.includes(DIRECTOR_ANSWER_RULES));
    assert.match(buildContextInspectorHTML(messages), /scp-ctx-nav-user[^>]*>Narrator Director/);
    const disabled = await assembleMessages(session, { includeNarratorDirectorContext: false }, 'Rook');
    assert.ok(disabled.every(message => !message.content.startsWith('<narrator_director>')));
    assert.ok(!disabled[0].content.includes(DIRECTOR_ANSWER_RULES));
});
