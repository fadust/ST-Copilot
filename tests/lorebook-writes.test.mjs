import assert from 'node:assert/strict';
import { beforeEach, test } from 'node:test';

const books = new Map();
const nativeCache = new Map();
let failures;
let writes;
let saves;
let staleRead;

globalThis.window = { addEventListener() {} };
globalThis.SillyTavern = { getContext: () => ({ getRequestHeaders: () => ({}) }) };
globalThis.toastr = { error: message => failures.push(message) };
globalThis.fetch = async (path, { body }) => {
    const { name, data } = JSON.parse(body);
    if (path === '/api/worldinfo/edit') {
        writes.push(name);
        if (saves.get(name) === 'reject') return new Response('Permission denied', { status: 403 });
        if (saves.get(name) !== 'ignore') books.set(name, data);
        if (saves.get(name) === 'lose-readback') staleRead = name;
        return Response.json({ ok: true });
    }
    assert.equal(path, '/api/worldinfo/get');
    if (staleRead === name) {
        staleRead = null;
        return new Response('Try again later', { status: 503 });
    }
    return Response.json(books.get(name) ?? { entries: {} });
};

const { applyLBChanges, buildEntryCommandContext, clearWiCache, fetchWorldInfoBook, parseLBChangesFromText, readLorebookUidDirectory } = await import('../features/feature-lorebook-engine.js');
const { assembleMessages } = await import('../api.js');
const { setSTWorldInfo } = await import('../state.js');
setSTWorldInfo({ selected_world_info: ['Cast', 'Other'], world_names: ['Archive'], worldInfoCache: nativeCache });

const add = { worldName: 'Cast', name: 'Rook', action: 'add', content: 'First draft.' };
const edit = { worldName: 'Cast', name: 'Rook', action: 'edit', content: 'Final draft.' };

beforeEach(() => {
    books.clear();
    books.set('Cast', { entries: {} });
    books.set('Other', { entries: {} });
    nativeCache.clear();
    clearWiCache();
    writes = [];
    failures = [];
    saves = new Map();
    staleRead = null;
});

test('an edit of a missing entry stays pending and cannot target another book', async () => {
    books.get('Other').entries[1] = { uid: 1, comment: 'Rook', content: 'Other book.' };
    assert.equal((await applyLBChanges([edit])).size, 0);
    assert.deepEqual(writes, []);
    assert.match(failures[0], /Entry not found in "Cast"/);
});

test('a batch can add then edit in the same book before its verified save', async () => {
    assert.deepEqual([...await applyLBChanges([add, edit])], [add, edit]);
    assert.deepEqual(writes, ['Cast']);
    assert.equal(books.get('Cast').entries[1].content, 'Final draft.');
    assert.deepEqual(nativeCache.get('Cast'), books.get('Cast'));
});

test('a partial batch confirms only the saved book and reports the server error', async () => {
    const rejected = { ...add, worldName: 'Other' };
    saves.set('Other', 'reject');
    assert.deepEqual([...await applyLBChanges([add, rejected])], [add]);
    assert.match(failures[0], /HTTP 403.*Permission denied/);
    assert.deepEqual(books.get('Other').entries, {});
    assert.equal(nativeCache.has('Other'), false);
    saves.clear();
    assert.deepEqual([...await applyLBChanges([rejected])], [rejected]);
    assert.equal(books.get('Other').entries[1].comment, 'Rook');
});

test('a write acknowledged by the server stays pending if read-back disagrees', async () => {
    saves.set('Cast', 'ignore');
    assert.equal((await applyLBChanges([add])).size, 0);
    assert.match(failures[0], /saved lorebook does not match/);
    assert.equal(nativeCache.has('Cast'), false);
});

test('a failed add to a new book does not create an empty book first', async () => {
    const newBookAdd = { ...add, worldName: 'New Book' };
    saves.set('New Book', 'reject');
    assert.equal((await applyLBChanges([newBookAdd])).size, 0);
    assert.deepEqual(writes, ['New Book']);
    assert.equal(books.has('New Book'), false);
    saves.clear();
    assert.deepEqual([...await applyLBChanges([newBookAdd])], [newBookAdd]);
    assert.equal(books.get('New Book').entries[1].content, 'First draft.');
});

test('retrying after a lost read-back does not add a duplicate entry', async () => {
    saves.set('Cast', 'lose-readback');
    assert.equal((await applyLBChanges([add])).size, 0);
    assert.match(failures[0], /HTTP 503/);
    saves.clear();
    assert.deepEqual([...await applyLBChanges([add])], [add]);
    assert.equal(Object.keys(books.get('Cast').entries).length, 1);
});

test('concurrent callbacks can add separate entries without losing either one', async () => {
    const second = { ...add, name: 'Finch' };
    const results = await Promise.all([applyLBChanges([add]), applyLBChanges([second])]);
    assert.deepEqual(results.map(result => [...result]), [[add], [second]]);
    assert.deepEqual(Object.values(books.get('Cast').entries).map(entry => entry.comment), ['Rook', 'Finch']);
});

const janus = { uid: 8, comment: 'Janus', key: ['Janus'], content: 'Keeper of the gate.', displayIndex: 5, order: 100 };
const configure = {
    action: 'configure', worldName: 'Cast', uid: 8, name: 'Janus',
    layout: { listPosition: 'first', strategy: 'vectorized', position: '4:1', depth: 0, order: 120, probability: 35 },
};

test('chat assembly supplies the exact matched entry and current settings without supplying its content', async () => {
    books.get('Cast').entries[8] = { ...janus };
    books.get('Cast').entries[1] = { uid: 1, comment: 'Maris', displayIndex: 0 };
    books.get('Other').entries[8] = { ...janus };
    const messages = await assembleMessages(
        { messages: [{ role: 'user', content: 'Move Janus to the top and set his trigger chance to 35%.' }] },
        { lorebookAIManageEnabled: true, lorebookExcludedBooks: ['Other'] },
        null,
    );
    const system = messages[0].content;
    const context = JSON.parse(system.match(/<lorebook_entry_settings>\n(.*)\n<\/lorebook_entry_settings>/)[1]);
    assert.deepEqual(context, [{ book: 'Cast', count: 2, entries: [
        { uid: 8, name: 'Janus', strategy: 'normal', position: '0', depth: 4, order: 100, probability: 100, listPosition: 2 },
    ] }]);
    assert.match(system, /"action":"configure"/);
    assert.doesNotMatch(system, /Keeper of the gate/);
    assert.deepEqual(writes, []);
});

test('a settings proposal changes only native settings and display indexes when applied', async () => {
    books.get('Cast').entries[8] = { ...janus };
    books.get('Cast').entries[1] = { uid: 1, comment: 'Maris', displayIndex: 0 };
    const reply = '\x60\x60\x60lorebook-changes\n' + JSON.stringify({ changes: [
        { ...configure, content: 'Unrequested rewrite', triggers: ['unrequested'] },
    ] }) + '\n\x60\x60\x60';
    const pending = parseLBChangesFromText(reply);
    assert.deepEqual(pending, [configure]);
    assert.deepEqual(writes, []);
    assert.deepEqual([...await applyLBChanges(pending)], pending);
    assert.deepEqual(writes, ['Cast']);
    assert.deepEqual(books.get('Cast').entries[8], {
        ...janus, displayIndex: 0, constant: false, vectorized: true, position: 4, role: 1,
        depth: 0, order: 120, probability: 35, useProbability: true,
    });
    assert.deepEqual(books.get('Cast').entries[1], { uid: 1, comment: 'Maris', displayIndex: 1 });
});

test('configuration requires exact book entry identity and validates the whole layout before writing', async () => {
    books.get('Cast').entries[8] = { ...janus, comment: 'Finch' };
    books.get('Other').entries[8] = { ...janus };
    assert.equal((await applyLBChanges([configure])).size, 0);
    books.get('Cast').entries[8] = { ...janus };
    assert.equal((await applyLBChanges([{ ...configure, layout: { listPosition: 9, probability: 0 } }])).size, 0);
    assert.equal((await applyLBChanges([{ ...configure, layout: { depth: 3 } }])).size, 0);
    assert.deepEqual(books.get('Cast').entries[8], janus);
    assert.deepEqual(writes, []);
});

test('read-only lookup uses current saved UIDs, with book and keyword matching', async () => {
    books.get('Cast').entries[0] = { ...janus, uid: 0, comment: 'Janus of the Gate' };
    books.get('Other').entries[4] = { ...janus, uid: 4 };
    await fetchWorldInfoBook('Cast');
    books.get('Cast').entries[0].order = 321;
    const context = await buildEntryCommandContext({ lorebookAIManageEnabled: false }, 'What is the UID for Janus in Cast?');
    const records = JSON.parse(context.match(/<lorebook_entry_settings>\n(.*)\n<\/lorebook_entry_settings>/)[1]);
    assert.equal(records.length, 1);
    assert.equal(records[0].book, 'Cast');
    assert.deepEqual(records[0].entries.map(({ uid, name, order }) => ({ uid, name, order })), [
        { uid: 0, name: 'Janus of the Gate', order: 321 },
    ]);
    assert.match(await buildEntryCommandContext({}, 'Which entry has UID #0 in Cast?'), /"uid":0/);
    assert.doesNotMatch(context, /Keeper of the gate/);
    assert.deepEqual(writes, []);
});

test('a configure proposal can omit the UID when the book contains one exact title match', async () => {
    books.get('Cast').entries[8] = { ...janus };
    books.get('Other').entries[9] = { ...janus, uid: 9 };
    const { uid, ...namedChange } = { ...configure, layout: { probability: 10 } };
    const pending = parseLBChangesFromText('\x60\x60\x60lorebook-changes\n' + JSON.stringify({ changes: [namedChange] }) + '\n\x60\x60\x60');
    assert.deepEqual(pending, [namedChange]);
    assert.deepEqual([...await applyLBChanges(pending)], [namedChange]);
    assert.equal(books.get('Cast').entries[uid].probability, 10);
    assert.deepEqual(writes, ['Cast']);
});

test('duplicate titles in the same book and mismatched explicit UIDs cannot be applied by name', async () => {
    books.get('Cast').entries[8] = { ...janus };
    books.get('Cast').entries[18] = { ...janus, uid: 18 };
    const unresolved = { ...configure, uid: undefined };
    assert.equal((await applyLBChanges([unresolved])).size, 0);
    assert.match(failures[0], /8, 18/);
    assert.equal((await applyLBChanges([{ ...configure, uid: 80 }])).size, 0);
    assert.deepEqual(writes, []);
});

test('the UID directory and named-book context cover all saved entries beyond the old 30-entry limit', async () => {
    const entries = Array.from({ length: 75 }, (_, uid) => ({ uid, comment: `Resident ${uid}`, content: 'Fixture lore' }));
    books.set('Archive', { entries: Object.fromEntries(entries.map(entry => [entry.uid, entry])) });
    const directory = await readLorebookUidDirectory();
    assert.deepEqual(directory.find(group => group.name === 'Archive').entries, entries.map(({ uid, comment }) => ({ uid, title: comment })));
    for (const query of ['List all UIDs in Archive.', 'Reorder Archive and move Resident 74 to the top.']) {
        const result = await buildEntryCommandContext({ lorebookAIManageEnabled: true }, query);
        const [archive] = JSON.parse(result.match(/<lorebook_entry_settings>\n(.*)\n<\/lorebook_entry_settings>/)[1]);
        assert.equal(archive.entries.length, 75);
        assert.equal(archive.entries[74].uid, 74);
        assert.equal(archive.entries[74].listPosition, 75);
        assert.doesNotMatch(result, /Fixture lore/);
    }
    assert.deepEqual(writes, []);
});
