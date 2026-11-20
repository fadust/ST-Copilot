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

const { applyLBChanges } = await import('../features/feature-lorebook-engine.js');
const { setSTWorldInfo } = await import('../state.js');
setSTWorldInfo({ selected_world_info: ['Cast', 'Other'], worldInfoCache: nativeCache });

const add = { worldName: 'Cast', name: 'Rook', action: 'add', content: 'First draft.' };
const edit = { worldName: 'Cast', name: 'Rook', action: 'edit', content: 'Final draft.' };

beforeEach(() => {
    books.clear();
    books.set('Cast', { entries: {} });
    books.set('Other', { entries: {} });
    nativeCache.clear();
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
