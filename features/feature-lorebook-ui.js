/**
 * feature-lorebook-ui.js
 * The Lorebook Manager window: book list with checkboxes (select/exclude),
 * entry list with search, entry detail editor, per-entry keyword-override
 * cycling, add/delete entries — plus rendering the "Proposed Lorebook
 * Changes" review card that appears under an AI message.
 *
 * Moved from original index.js "Lorebook Manager UI" section
 * (lines 4352-5415, 1064 lines).
 *
 * DEPENDENCY NOTE: `applyCustomTheme` (future Theme section) isn't built
 * yet — injected. `updateMsgCount` turned out to live in what's now
 * `ui/ui-chat.js`, so it's imported directly (creates an import cycle with
 * that module — safe since it's only called from inside function bodies).
 * `getWiCache`/`clearWiCache`/`getLastActiveEntries` are new exports added
 * to feature-lorebook-engine.js specifically so this file can read/clear
 * that module's private cache without reaching into its internals.
 *
 *   import { setForwardDeps } from './features/feature-lorebook-ui.js';
 *   import { applyCustomTheme } from './ui/ui-window.js'; // future (Theme section)
 *   setForwardDeps({ applyCustomTheme });
 *
 * Until wired: opening the manager won't re-apply the current theme —
 * everything else (browsing, editing, applying changes) works standalone.
 */

import { EXT_DISPLAY, THEME_PRESETS, ICONS } from '../constants.js';
import { escHtml, showCustomDialog, copyText } from '../utils/util-dom.js';
import { getSettings, saveSettings } from '../settings.js';
import { getCurrentSession, saveSessionsToMetadata } from '../session.js';
import {
    EMBEDDED_BOOK_KEY, fetchWorldInfoBook, editWorldInfoBook, saveWorldInfoBook, getDisplayName,
    getActiveLorebookNames, getBookSourceType, wiEntriesToArray, getEntryOverrideKey,
    buildLorebookContextBlock, stripLBChangesBlock, resolveLBChangeTarget,
    logLBHistoryChanges, applyLBChanges, getWiCache as _getWiCache,
    clearWiCache, getLastActiveEntries as _getLastActiveEntries,
    getEntryLayout, updateEntryLayout, setEntryField,
    readLorebookUidDirectory,
} from './feature-lorebook-engine.js';
import { openDiffModal, reconstructLBChangesBlock } from './feature-chatedit-engine.js';
import { updateMsgCount as _updateMsgCount } from '../ui/ui-chat.js';

// ── Injected forward dep (see header note) ──────────────────────────────────
let _applyCustomTheme = () => {};

export function setForwardDeps({ applyCustomTheme } = {}) {
    if (applyCustomTheme) _applyCustomTheme = applyCustomTheme;
}

let _lbActiveBook = null;
let _lbSearchQuery = '';
let _lbEntryDetailEntry = null;
let _lbEntryDetailBook = null;
let _lbUidBooks = [];
let _lbUidRequest = null;

// Exported so ui-settings.js's LB toggle handlers (which need to refresh
// the currently-open lorebook entry list after a setting change) can read
// this without reaching into private module state.
export function getLbActiveBook() { return _lbActiveBook; }
export function getLbSearchQuery() { return _lbSearchQuery; }

export function renderProposalCard(changes, msgEl) {
    if (!changes?.length) return;
    document.querySelector(`.scp-lb-proposal-card[data-for="${msgEl.dataset.id}"]`)?.remove();

    const editableChanges = changes.map(c => ({ ...c }));
    const itemStates = editableChanges.map(() => 'pending');
    const readyConfigurations = new Set();
    let applying = false;
    const actionLabels = { add: '+ Add', edit: '✎ Edit', patch: '✂ Patch', delete: '✕ Remove', configure: 'Configure' };

    const card = document.createElement('div');
    card.className = 'scp-lb-proposal-card';
    card.dataset.for = msgEl.dataset.id;
    card.style.margin = '8px 0 0 0';

    const syncBlockToMessage = () => {
        const session = getCurrentSession();
        const msg = session.messages.find(m => m.id === card.dataset.for);
        if (!msg) return;
        const pending = editableChanges.filter((_, i) => itemStates[i] === 'pending');
        const stripped = stripLBChangesBlock(msg.content);
        if (pending.length === 0) {
            msg.content = stripped;
        } else {
            msg.content = stripped + '\n\n' + reconstructLBChangesBlock(pending);
        }
        if (msg.swipes) msg.swipes[msg.swipeIndex || 0].content = msg.content;
        saveSessionsToMetadata();
    };

    const persistState = () => {};

    const getPendingCount = () => itemStates.filter(s => s === 'pending').length;
    const getAppliedCount = () => itemStates.filter(s => s === 'applied').length;
    const getApplicableChanges = () => editableChanges.filter((change, index) =>
        itemStates[index] === 'pending' && (change.action !== 'configure' || readyConfigurations.has(index)));

    const checkAllResolved = () => {
        if (getPendingCount() === 0) { syncBlockToMessage(); card.remove(); }
    };

    // ── Header ──
    const header = document.createElement('div');
    header.className = 'scp-lb-proposal-header';

    const headerLeft = document.createElement('div');
    headerLeft.style.cssText = 'display:flex;align-items:center;gap:8px;flex:1;min-width:0';
    headerLeft.innerHTML = `<span class="scp-lb-proposal-icon">${ICONS.book}</span>
        <span class="scp-lb-proposal-title">Proposed Lorebook Changes</span>`;

    const countBadge = document.createElement('span');
    countBadge.className = 'scp-lb-proposal-count';
    countBadge.textContent = `${editableChanges.length} pending`;
    headerLeft.appendChild(countBadge);

    const dismissBtn = document.createElement('button');
    dismissBtn.className = 'scp-lb-proposal-dismiss';
    dismissBtn.innerHTML = ICONS.x; dismissBtn.title = 'Dismiss';
    dismissBtn.addEventListener('click', () => {
        if (applying) return;
        const dismissedChanges = editableChanges.filter((_, i) => itemStates[i] === 'pending');
        if (dismissedChanges.length > 0) {
            logLBHistoryChanges(dismissedChanges, 'Dismissed', card.dataset.for);
        }
        itemStates.forEach((s, i) => { if (s === 'pending') itemStates[i] = 'dismissed'; });
        syncBlockToMessage(); card.remove();
    });

    header.appendChild(headerLeft); header.appendChild(dismissBtn);

    // ── Item list ──
    const list = document.createElement('div');
    list.className = 'scp-lb-proposal-list';

    const itemEls = [];

    editableChanges.forEach((c, ci) => {
        const isConfigure = c.action === 'configure';
        const item = document.createElement('div');
        item.className = `scp-lb-proposal-item scp-lb-proposal-${c.action || 'edit'}`;

        const itemHeader = document.createElement('div');
        itemHeader.className = 'scp-lb-proposal-item-header';

        const itemMeta = document.createElement('div');
        itemMeta.style.cssText = 'display:flex;align-items:center;gap:8px;flex:1;min-width:0;flex-wrap:wrap';
        itemMeta.innerHTML = `
            <span class="scp-lb-proposal-action">${escHtml(actionLabels[c.action] || c.action || '?')}</span>
            <span class="scp-lb-proposal-name scp-lb-pn-target">${escHtml(c.name || c.originalName || `Entry #${c.uid ?? '?'}`)}</span>${c.constant ? '<span class="scp-lb-src-badge scp-lb-src-global" style="font-size:9px;padding:1px 5px" title="Constant entry">★</span>' : ''}`;

        const _activeBooks = getActiveLorebookNames();
        const _currentBook = editableChanges[ci].worldName || '';

        const worldDd = document.createElement('div');
        worldDd.className = 'scp-lb-proposal-world-dd';

        const worldTrigger = document.createElement('button');
        worldTrigger.className = 'scp-lb-proposal-world-trigger';
        worldTrigger.type = 'button';
        worldTrigger.disabled = isConfigure;

        const worldTriggerText = document.createElement('span');
        worldTriggerText.className = 'scp-lb-proposal-world-trigger-text';
        worldTriggerText.textContent = `in ${getDisplayName(_currentBook) || '?'}`;

        const worldChevronEl = document.createElement('span');
        worldChevronEl.className = 'scp-lb-proposal-world-chevron';
        worldChevronEl.innerHTML = ICONS.chevron;

        worldTrigger.appendChild(worldTriggerText);
        if (!isConfigure) worldTrigger.appendChild(worldChevronEl);

        const worldPanel = document.createElement('div');
        worldPanel.className = 'scp-lb-proposal-world-panel';

        let _selectedBook = _currentBook;

        const buildWorldPanelItems = (items) => {
            worldPanel.innerHTML = '';

            if (!items.length) {
                const empty = document.createElement('div');
                empty.className = 'scp-lb-proposal-world-empty';
                empty.textContent = 'No active lorebooks';
                worldPanel.appendChild(empty);
            }

            items.forEach(name => {
                const item2 = document.createElement('div');
                item2.className = `scp-lb-proposal-world-item${name === _selectedBook ? ' active' : ''}`;
                item2.dataset.value = name;

                const dot = document.createElement('span');
                dot.className = 'scp-lb-proposal-world-item-dot';
                const label = document.createElement('span');
                label.textContent = getDisplayName(name);

                item2.appendChild(dot);
                item2.appendChild(label);
                item2.addEventListener('click', () => selectBook(name));
                worldPanel.appendChild(item2);
            });

            if (c.action === 'add') {
                const sep = document.createElement('div');
                sep.className = 'scp-lb-proposal-world-sep';
                worldPanel.appendChild(sep);

                const newItem = document.createElement('div');
                newItem.className = 'scp-lb-proposal-world-item scp-lb-proposal-world-new';
                newItem.innerHTML = `<span>${ICONS.plus}</span><span>Create new lorebook…</span>`;
                newItem.addEventListener('click', async () => {
                    closeWorldPanel();
                    const name = await showCustomDialog({ type: 'prompt', title: 'New Lorebook Name', message: 'Enter name for the new lorebook:', placeholder: 'My Lorebook' });
                    if (name?.trim()) {
                        const n = name.trim();
                        if (!_activeBooks.includes(n)) {
                            _activeBooks.push(n);
                        }
                        buildWorldPanelItems(_activeBooks);
                        selectBook(n);
                    }
                });
                worldPanel.appendChild(newItem);
            }
        };

        const closeWorldPanel = () => {
            worldPanel.classList.remove('open');
            worldTrigger.classList.remove('open');
        };

        const openWorldPanel = () => {
            const rect = worldTrigger.getBoundingClientRect();
            worldPanel.style.top = `${rect.bottom + 4}px`;
            worldPanel.style.left = `${rect.left}px`;
            worldPanel.classList.add('open');
            worldTrigger.classList.add('open');
        };

        const _validateBookEntry = async (bookName) => {
            worldTrigger.classList.add('loading');
            const checkChange = { ...editableChanges[ci], worldName: bookName };
            if (bookName !== editableChanges[ci].worldName) {
                delete checkChange.uid;
            }
            
            const resolved = await resolveLBChangeTarget(checkChange, true);
            worldTrigger.classList.remove('loading');

            const found = !!resolved.origEntry;

            if (found) {
                const orig = resolved.origEntry;
                const n = orig.comment || `Entry #${orig.uid}`;
                editableChanges[ci].originalName = n;
                if (!editableChanges[ci].name) editableChanges[ci].name = n;
                
                const nameEl = item.querySelector('.scp-lb-pn-target');
                if (nameEl) nameEl.textContent = n;

                const nameInput = item.querySelector('.scp-lb-name-input');
                if (nameInput && !nameInput.value) nameInput.value = n;

                if (editableChanges[ci].triggers === null) {
                    const origKeys = orig.key || [];
                    editableChanges[ci].triggers = [...origKeys];
                    
                    const tEl = item.querySelector('.scp-lb-proposal-triggers');
                    if (tEl) tEl.textContent = origKeys.length ? `Keys: ${origKeys.join(', ')}` : 'Keys: none';
                    
                    const tInput = item.querySelector('.scp-lb-trig-input');
                    if (tInput && !tInput.value) {
                        tInput.value = origKeys.join(', ');
                        tInput.placeholder = '';
                    }
                }
            }

            if (found && resolved.bookName && resolved.bookName !== bookName) {
                editableChanges[ci].worldName = resolved.bookName;
                _selectedBook = resolved.bookName;
                worldPanel.querySelectorAll('.scp-lb-proposal-world-item').forEach(el => {
                    el.classList.toggle('active', el.dataset.value === resolved.bookName);
                });
                worldTriggerText.textContent = `in ${getDisplayName(resolved.bookName)}`;
                toastr.info(
                    `Entry found in "<b>${escHtml(getDisplayName(resolved.bookName))}</b>" instead of "<b>${escHtml(getDisplayName(bookName))}</b>" — lorebook switched automatically.`,
                    EXT_DISPLAY,
                    { timeOut: 6000, escapeHtml: false }
                );
            } else {
                worldTriggerText.textContent = found
                    ? `in ${getDisplayName(bookName)}`
                    : `in ${getDisplayName(bookName)} ⚠`;
            }

            worldTrigger.classList.toggle('warn', !found);
            applyItemBtn.disabled = !found;
            applyItemBtn.title = found ? 'Apply this change' : 'Entry not found in selected lorebook';
        };

        const selectBook = async (name) => {
            _selectedBook = name;
            editableChanges[ci].worldName = name;
            worldTriggerText.textContent = `in ${getDisplayName(name)}`;
            worldTrigger.classList.remove('warn');

            worldPanel.querySelectorAll('.scp-lb-proposal-world-item').forEach(el => {
                el.classList.toggle('active', el.dataset.value === name);
            });
            closeWorldPanel();
            if (c.action === 'edit' || c.action === 'delete' || c.action === 'patch') await _validateBookEntry(name);
        };

        worldTrigger.addEventListener('click', e => {
            e.stopPropagation();
            const isOpen = worldPanel.classList.contains('open');
            document.querySelectorAll('.scp-lb-proposal-world-panel.open').forEach(p => {
                p.classList.remove('open');
                p.previousElementSibling?.classList.remove('open');
            });
            if (!isOpen) openWorldPanel();
        });

        const _allBooks = [..._activeBooks];
        if (_currentBook && !_activeBooks.includes(_currentBook)) _allBooks.unshift(_currentBook);

        buildWorldPanelItems(_allBooks);

        worldDd.appendChild(worldTrigger);
        worldDd.appendChild(worldPanel);

        const itemBtns = document.createElement('div');
        itemBtns.className = 'scp-lb-proposal-item-btns';

        // Edit toggle
        let editToggleBtn = null;
        if (c.action !== 'delete' && !isConfigure) {
            editToggleBtn = document.createElement('button');
            editToggleBtn.className = 'scp-lb-proposal-edit-toggle';
            editToggleBtn.title = 'Edit before applying'; editToggleBtn.textContent = '✎';
            itemBtns.appendChild(editToggleBtn);
        }

        // Diff btn - for edit AND patch actions
        if (c.action === 'edit' || c.action === 'patch') {
            const diffBtn = document.createElement('button');
            diffBtn.className = 'scp-lb-proposal-diff-btn';
            diffBtn.title = 'View diff'; diffBtn.innerHTML = ICONS.diff;
            diffBtn.addEventListener('click', async e => {
                e.stopPropagation();
                const change = editableChanges[ci];
                const { origEntry } = await resolveLBChangeTarget(change);
                if (!origEntry) {
                    toastr.warning('Could not find original entry to compare against.', EXT_DISPLAY);
                    return;
                }
                openDiffModal(change, origEntry);
            });
            itemBtns.appendChild(diffBtn);
        }

        const closeEditPanel = () => {
            const editPanel = item.querySelector('.scp-lb-proposal-edit-panel');
            if (editPanel && editPanel.style.display !== 'none') {
                editPanel.style.display = 'none';
                if (previewEl) previewEl.style.display = '';
                if (triggersEl) triggersEl.style.display = '';
                if (editToggleBtn) editToggleBtn.classList.remove('active');
            }
        };

        // Per-item Apply btn
        const applyItemBtn = document.createElement('button');
        applyItemBtn.className = 'scp-lb-proposal-item-apply';
        applyItemBtn.title = 'Apply this change'; applyItemBtn.textContent = '✓';
        applyItemBtn.addEventListener('click', async e => {
            e.stopPropagation();
            if (applying || itemStates[ci] !== 'pending') return;
            closeEditPanel();
            applyItemBtn.disabled = true; applyItemBtn.textContent = '…';
            await applyPending([editableChanges[ci]]);
            applyItemBtn.disabled = itemStates[ci] !== 'pending';
            applyItemBtn.textContent = '✓';
        });

        const rejectItemBtn = document.createElement('button');
        rejectItemBtn.className = 'scp-lb-proposal-item-reject';
        rejectItemBtn.title = 'Reject this change'; rejectItemBtn.textContent = '✕';
        rejectItemBtn.addEventListener('click', e => {
            e.stopPropagation();
            if (applying || itemStates[ci] !== 'pending') return;
            closeEditPanel();
            itemStates[ci] = 'rejected';
            item.classList.add('scp-lb-item-rejected');
            itemBtns.querySelectorAll('button').forEach(b => { b.disabled = true; });

            logLBHistoryChanges([editableChanges[ci]], 'Rejected', card.dataset.for);
            persistState(); updateCountBadge(); updateFooterBtns(); 
            syncBlockToMessage()
            checkAllResolved();
        });

        itemBtns.appendChild(applyItemBtn);
        itemBtns.appendChild(rejectItemBtn);
        itemHeader.appendChild(itemMeta);
        itemHeader.appendChild(itemBtns);
        item.appendChild(itemHeader);
        item.appendChild(worldDd);

        // Preview / triggers
        let previewEl = null, triggersEl = null;
        if (isConfigure) {
            previewEl = document.createElement('div');
            previewEl.className = 'scp-lb-proposal-preview scp-lb-configure-preview';
            const labels = { listPosition: 'List position', strategy: 'Strategy', position: 'Position', depth: 'Depth', order: 'Order', probability: 'Trigger chance' };
            const positionOptions = document.getElementById('scp-lb-entry-position')?.options;
            const format = (key, value) => {
                if (key === 'probability') return `${value}%`;
                if (key === 'position' && positionOptions) return Array.from(positionOptions).find(option => option.value === value)?.textContent ?? value;
                return typeof value === 'string' ? value[0].toUpperCase() + value.slice(1) : value;
            };
            const renderSettings = (current = {}) => {
                previewEl.replaceChildren(...Object.entries(c.layout).map(([key, value]) => {
                    const row = document.createElement('div');
                    const prior = current[key] === undefined ? '' : `${format(key, current[key])} → `;
                    row.textContent = `${labels[key]}: ${prior}${format(key, value)}`;
                    return row;
                }));
            };
            applyItemBtn.disabled = true;
            previewEl.textContent = 'Looking up entry…';
            const showLookupError = message => {
                previewEl.textContent = message;
                previewEl.classList.add('scp-lb-configure-error');
            };
            resolveLBChangeTarget(c, true).then(({ data, origEntry, matchingUids }) => {
                if (itemStates[ci] !== 'pending') return;
                if (data?._embedded) {
                    showLookupError('Edit this embedded entry in its character card.');
                    return;
                }
                if (!origEntry) {
                    showLookupError(matchingUids
                        ? `Several entries have this name. Specify a UID from ${matchingUids.join(', ')} in chat.`
                        : 'Entry not found. Check the lorebook name and entry title.');
                    return;
                }
                editableChanges[ci].uid = origEntry.uid;
                const uidLabel = document.createElement('span');
                uidLabel.className = 'scp-lb-uid';
                uidLabel.textContent = `UID ${origEntry.uid}`;
                itemMeta.appendChild(uidLabel);
                renderSettings({ ...getEntryLayout(origEntry), listPosition: wiEntriesToArray(data).indexOf(origEntry) + 1 });
                readyConfigurations.add(ci);
                applyItemBtn.disabled = false;
                updateFooterBtns();
            }).catch(() => showLookupError('Could not read the selected lorebook.'));
            item.appendChild(previewEl);
        } else if (c.content) {
            previewEl = document.createElement('div');
            previewEl.className = 'scp-lb-proposal-preview';
            const isLong = c.content.length > 120;
            previewEl.textContent = isLong ? c.content.slice(0, 120) + '…' : c.content;
            if (isLong) {
                let _expanded = false;
                previewEl.title = 'Click to expand';
                previewEl.style.cursor = 'pointer';
                previewEl.addEventListener('click', e => {
                    e.stopPropagation();
                    if (window.getSelection()?.toString()) return;
                    _expanded = !_expanded;
                    previewEl.textContent = _expanded ? c.content : c.content.slice(0, 120) + '…';
                    previewEl.style.whiteSpace = _expanded ? 'pre-wrap' : '';
                    previewEl.style.fontStyle = _expanded ? 'normal' : '';
                    previewEl.title = _expanded ? 'Click to collapse' : 'Click to expand';
                });
            }
            item.appendChild(previewEl);
        }
        if (c.triggers !== null && c.triggers?.length) {
            triggersEl = document.createElement('div');
            triggersEl.className = 'scp-lb-proposal-triggers';
            triggersEl.textContent = 'Keys: ' + c.triggers.join(', ');
            item.appendChild(triggersEl);
        } else if (c.triggers === null) {
            triggersEl = document.createElement('div');
            triggersEl.className = 'scp-lb-proposal-triggers';
            triggersEl.style.opacity = '0.5';
            triggersEl.textContent = 'Keys: keep original';
            item.appendChild(triggersEl);
        }

        // Inline edit panel
        if (c.action !== 'delete' && !isConfigure) {
            const editPanel = document.createElement('div');
            editPanel.className = 'scp-lb-proposal-edit-panel';
            editPanel.style.display = 'none';

            const mkRow = (labelHtml, el) => {
                const row = document.createElement('div');
                row.className = 'scp-lb-pe-row';
                const lbl = document.createElement('label');
                lbl.className = 'scp-lb-pe-label'; lbl.innerHTML = labelHtml;
                row.appendChild(lbl); row.appendChild(el); return row;
            };

            const nameInput = document.createElement('input');
            nameInput.type = 'text'; nameInput.className = 'scp-lb-pe-input scp-lb-name-input';
            nameInput.value = c.name || '';
            nameInput.addEventListener('input', () => { editableChanges[ci].name = nameInput.value; });
            editPanel.appendChild(mkRow('Name', nameInput));

            const trigInput = document.createElement('input');
            trigInput.type = 'text'; trigInput.className = 'scp-lb-pe-input scp-lb-trig-input';
            trigInput.placeholder = 'Keywords (comma separated)';
            trigInput.value = Array.isArray(c.triggers) ? c.triggers.join(', ') : '';
            trigInput.addEventListener('input', () => {
                const val = trigInput.value.trim();
                editableChanges[ci].triggers = val === '' ? [] : val.split(',').map(t => t.trim()).filter(Boolean);
            });
            editPanel.appendChild(mkRow('Keys', trigInput));

            if (c.action === 'patch') {
                // Patch mode
                const rebuildPatches = () => {
                    const existing = editPanel.querySelector('.scp-lb-patches-wrap');
                    if (existing) existing.remove();
                    const patchWrap = document.createElement('div');
                    patchWrap.className = 'scp-lb-patches-wrap';
                    patchWrap.style.cssText = 'display:flex;flex-direction:column;gap:8px;margin-top:4px';
                    (editableChanges[ci].patches || []).forEach((patch, pi) => {
                        const pHdr = document.createElement('div');
                        pHdr.style.cssText = 'display:flex;align-items:center;justify-content:space-between;margin-bottom:2px';
                        pHdr.innerHTML = `<span style="font-size:10px;font-weight:700;color:var(--scp-accent);text-transform:uppercase;letter-spacing:.04em">Patch ${pi+1}</span>`;
                        if ((editableChanges[ci].patches || []).length > 1) {
                            const delP = document.createElement('button');
                            delP.style.cssText = 'background:none;border:none;color:var(--scp-danger);cursor:pointer;font-size:11px;padding:0;font-family:var(--scp-font)';
                            delP.textContent = '✕ Remove';
                            delP.addEventListener('click', () => { editableChanges[ci].patches.splice(pi, 1); rebuildPatches(); });
                            pHdr.appendChild(delP);
                        }
                        const searchTa = document.createElement('textarea');
                        searchTa.className = 'scp-lb-pe-textarea'; searchTa.rows = 2; searchTa.value = patch.search || '';
                        searchTa.placeholder = 'first unique words || last unique words';
                        searchTa.addEventListener('input', () => { editableChanges[ci].patches[pi].search = searchTa.value; });
                        const replaceTa = document.createElement('textarea');
                        replaceTa.className = 'scp-lb-pe-textarea'; replaceTa.rows = 3; replaceTa.value = patch.replace || '';
                        replaceTa.placeholder = 'replacement text';
                        replaceTa.addEventListener('input', () => { editableChanges[ci].patches[pi].replace = replaceTa.value; });
                        patchWrap.appendChild(pHdr);
                        patchWrap.appendChild(mkRow('Anchor (range)', searchTa));
                        patchWrap.appendChild(mkRow('Replace', replaceTa));
                        if (pi < (editableChanges[ci].patches || []).length - 1) {
                            const sep = document.createElement('div');
                            sep.style.cssText = 'height:1px;background:rgba(255,255,255,.07);margin:4px 0';
                            patchWrap.appendChild(sep);
                        }
                    });
                    const addPBtn = document.createElement('button');
                    addPBtn.className = 'scp-action-btn'; addPBtn.style.marginTop = '4px';
                    addPBtn.innerHTML = `${ICONS.plus}<span>Add Patch</span>`;
                    addPBtn.addEventListener('click', () => {
                        if (!editableChanges[ci].patches) editableChanges[ci].patches = [];
                        editableChanges[ci].patches.push({ search: '', replace: '' });
                        rebuildPatches();
                    });
                    patchWrap.appendChild(addPBtn);
                    editPanel.appendChild(patchWrap);
                };
                rebuildPatches();
            } else {
                const contentTa = document.createElement('textarea');
                contentTa.className = 'scp-lb-pe-textarea';
                contentTa.value = c.content || '';
                contentTa.addEventListener('input', () => { editableChanges[ci].content = contentTa.value; });
                editPanel.appendChild(mkRow('Content', contentTa));
            }

            // Constant checkbox
            const constWrap = document.createElement('label');
            constWrap.className = 'scp-sp-check'; constWrap.style.marginTop = '6px';
            const constCb = document.createElement('input');
            constCb.type = 'checkbox'; constCb.checked = !!c.constant;
            constCb.addEventListener('change', () => { editableChanges[ci].constant = constCb.checked; });
            constWrap.appendChild(constCb);
            constWrap.appendChild(Object.assign(document.createElement('span'), { textContent: 'Constant (always inject)' }));
            editPanel.appendChild(constWrap);

            // Outlet checkbox
            const outletWrap = document.createElement('label');
            outletWrap.className = 'scp-sp-check'; outletWrap.style.marginTop = '6px';
            const outletCb = document.createElement('input');
            outletCb.type = 'checkbox'; outletCb.checked = !!c.outlet;
            outletWrap.appendChild(outletCb);
            outletWrap.appendChild(Object.assign(document.createElement('span'), { textContent: 'Outlet Entry' }));
            const outletNameRow = document.createElement('div');
            outletNameRow.className = 'scp-lb-pe-row'; outletNameRow.style.display = c.outlet ? 'flex' : 'none';
            const outletNameInp = document.createElement('input');
            outletNameInp.type = 'text'; outletNameInp.className = 'scp-lb-pe-input';
            outletNameInp.value = c.outlet_name || ''; outletNameInp.placeholder = 'Outlet macro name...';
            outletNameInp.addEventListener('input', () => { editableChanges[ci].outlet_name = outletNameInp.value; });
            outletNameRow.innerHTML = '<label class="scp-lb-pe-label">Outlet Name</label>';
            outletNameRow.appendChild(outletNameInp);
            outletCb.addEventListener('change', () => {
                editableChanges[ci].outlet = outletCb.checked;
                outletNameRow.style.display = outletCb.checked ? 'flex' : 'none';
            });
            editPanel.appendChild(outletWrap);
            editPanel.appendChild(outletNameRow);

            item.appendChild(editPanel);

            if (editToggleBtn) {
                editToggleBtn.addEventListener('click', e => {
                    e.stopPropagation();
                    const isOpen = editPanel.style.display !== 'none';
                    editPanel.style.display = isOpen ? 'none' : 'flex';
                    if (previewEl) previewEl.style.display = isOpen ? '' : 'none';
                    if (triggersEl) triggersEl.style.display = isOpen ? '' : 'none';
                    editToggleBtn.classList.toggle('active', !isOpen);
                });
            }
        }

        list.appendChild(item);
        itemEls.push(item);

        if ((c.action === 'edit' || c.action === 'delete' || c.action === 'patch') && itemStates[ci] === 'pending') {
            _validateBookEntry(_selectedBook).catch(() => {});
        }
    });

    itemEls.forEach((el, i) => {
        if (itemStates[i] === 'applied') {
            el.classList.add('scp-lb-item-applied');
            el.querySelectorAll('button').forEach(b => { b.disabled = true; });
        } else if (itemStates[i] === 'rejected') {
            el.classList.add('scp-lb-item-rejected');
            el.querySelectorAll('button').forEach(b => { b.disabled = true; });
        }
    });

    // ── Footer ──
    const footer = document.createElement('div');
    footer.className = 'scp-lb-proposal-footer';

    const applyAllBtn = document.createElement('button');
    applyAllBtn.className = 'scp-lb-proposal-apply'; applyAllBtn.textContent = 'Apply All';

    const rejectAllBtn = document.createElement('button');
    rejectAllBtn.className = 'scp-lb-proposal-reject'; rejectAllBtn.textContent = 'Reject All';

    const updateCountBadge = () => {
        const p = getPendingCount();
        countBadge.textContent = p > 0 ? `${p} pending` : `${getAppliedCount()} applied`;
    };

    const updateFooterBtns = () => {
        const p = getPendingCount();
        applyAllBtn.style.display = p > 0 ? '' : 'none';
        rejectAllBtn.style.display = p > 0 ? '' : 'none';
        applyAllBtn.disabled = applying || getApplicableChanges().length === 0;
    };

    const applyPending = async pending => {
        if (applying || !pending.length) return;
        applying = true;
        applyAllBtn.disabled = true; applyAllBtn.textContent = 'Applying…';
        try {
            const confirmed = await applyLBChanges(pending, card.dataset.for);
            editableChanges.forEach((change, i) => {
                if (!confirmed.has(change)) return;
                itemStates[i] = 'applied';
                itemEls[i].classList.add('scp-lb-item-applied');
                itemEls[i].querySelectorAll('button').forEach(button => { button.disabled = true; });
            });
            updateCountBadge();
            updateFooterBtns();
            if (getPendingCount()) syncBlockToMessage();
            else checkAllResolved();
        } catch (e) {
            toastr.error(`Failed: ${e.message}`, EXT_DISPLAY, { escapeHtml: true });
        } finally {
            applying = false;
            applyAllBtn.textContent = 'Apply All';
            updateFooterBtns();
        }
    };

    applyAllBtn.addEventListener('click', () => applyPending(getApplicableChanges()));

    rejectAllBtn.addEventListener('click', () => {
        if (applying) return;
        const rejectedChanges = [];
        itemStates.forEach((s, i) => {
            if (s === 'pending') {
                itemStates[i] = 'rejected';
                itemEls[i].classList.add('scp-lb-item-rejected');
                itemEls[i].querySelectorAll('button').forEach(b => { b.disabled = true; });
                rejectedChanges.push(editableChanges[i]);
            }
        });
        if (rejectedChanges.length > 0) logLBHistoryChanges(rejectedChanges, 'Rejected', card.dataset.for);
        persistState(); updateCountBadge(); updateFooterBtns(); 
        checkAllResolved();
    });

    footer.appendChild(applyAllBtn); footer.appendChild(rejectAllBtn);
    updateFooterBtns();
    card.appendChild(header); card.appendChild(list); card.appendChild(footer);
    const body = msgEl.querySelector('.scp-msg-body');
    if (body) body.insertBefore(card, body.querySelector('.scp-swipe-bar'));
    else msgEl.after(card);
}

export async function openLorebookManager() {
    const overlay = document.getElementById('scp-lb-overlay');
    if (!overlay) return;
    _applyCustomTheme(getSettings().customTheme || THEME_PRESETS.default);
    overlay.style.display = 'flex';
    const s = getSettings();
    if (document.getElementById('scp-lb-search')) document.getElementById('scp-lb-search').value = _lbSearchQuery;
    clearWiCache();
    await buildLorebookContextBlock(s).catch(() => {});
    await refreshLorebookList().catch(e => console.error(`[${EXT_DISPLAY}] LB list:`, e));
    if (_lbActiveBook) await renderEntryList(_lbActiveBook, _lbSearchQuery).catch(() => {});
}

function getUidDirectoryGroups() {
    const book = document.getElementById('scp-lb-uids-book').value;
    const query = document.getElementById('scp-lb-search').value.trim().toLowerCase();
    const uid = /^(?:uid\s*[:#]?\s*|#)?(\d+)$/.exec(query)?.[1];
    return _lbUidBooks.filter(group => !book || group.name === book).flatMap(group => {
        if (!query || !group.entries || getDisplayName(group.name).toLowerCase().includes(query)) return [group];
        const entries = group.entries.filter(entry => uid === undefined
            ? entry.title.toLowerCase().includes(query) : Number(entry.uid) === Number(uid));
        return entries.length ? [{ ...group, entries }] : [];
    });
}

function renderUidDirectory() {
    if (_lbUidRequest) return;
    const groups = getUidDirectoryGroups();
    const count = groups.reduce((total, group) => total + (group.entries?.length ?? 0), 0);
    document.getElementById('scp-lb-uids-count').textContent = `${count} ${count === 1 ? 'entry' : 'entries'}`;
    document.getElementById('scp-lb-uids-copy').disabled = !count;
    document.getElementById('scp-lb-uids-results').innerHTML = groups.map(({ name, entries }) => {
        const title = escHtml(getDisplayName(name));
        if (!entries?.length) return `<div class="scp-lb-empty-state">${title} — ${entries ? 'No entries' : 'Could not read lorebook'}</div>`;
        return `<table class="scp-lb-uid-table">
            <caption>${title}</caption>
            <thead><tr><th scope="col">UID</th><th scope="col">Entry</th></tr></thead>
            <tbody>${entries.map(entry => `<tr><td>${escHtml(String(entry.uid))}</td><td>${escHtml(entry.title)}</td></tr>`).join('')}</tbody>
        </table>`;
    }).join('') || '<div class="scp-lb-empty-state">No matching entries.</div>';
}

export async function openLorebookUidDirectory(book = '') {
    const directory = document.getElementById('scp-lb-uid-directory');
    if (!directory) return;
    const overlay = document.getElementById('scp-lb-overlay');
    if (overlay.style.display === 'none') await openLorebookManager();
    directory.hidden = false;
    document.getElementById('scp-lb-open-uids').setAttribute('aria-expanded', 'true');
    document.getElementById('scp-lb-entries').inert = true;
    document.getElementById('scp-lb-entry-detail').inert = true;
    document.getElementById('scp-lb-search').value = '';
    document.getElementById('scp-lb-uids-count').textContent = 'Reading lorebooks…';
    document.getElementById('scp-lb-uids-results').replaceChildren();
    document.getElementById('scp-lb-uids-copy').disabled = true;
    document.getElementById('scp-lb-uids-back').focus();

    const select = document.getElementById('scp-lb-uids-book');
    select.disabled = true;
    const request = readLorebookUidDirectory();
    _lbUidRequest = request;
    const books = await request;
    if (_lbUidRequest !== request || directory.hidden) return;
    _lbUidRequest = null;
    _lbUidBooks = books;
    select.replaceChildren(new Option('All lorebooks', ''), ...books.map(group => new Option(getDisplayName(group.name), group.name)));
    const match = books.find(group => getDisplayName(group.name).toLowerCase() === book.toLowerCase());
    select.value = match?.name || '';
    select.disabled = false;
    if (book && !match) toastr.warning(`Lorebook "${book}" was not found. Showing all lorebooks.`, EXT_DISPLAY, { escapeHtml: true });
    renderUidDirectory();
}

function closeUidDirectory() {
    const directory = document.getElementById('scp-lb-uid-directory');
    if (!directory || directory.hidden) return;
    directory.hidden = true;
    _lbUidRequest = null;
    document.getElementById('scp-lb-open-uids').setAttribute('aria-expanded', 'false');
    document.getElementById('scp-lb-entries').inert = false;
    document.getElementById('scp-lb-entry-detail').inert = false;
    document.getElementById('scp-lb-search').value = _lbSearchQuery;
}

export function closeLorebookManager() {
    closeUidDirectory();
    document.getElementById('scp-lb-overlay').style.display = 'none';
}

export function _applyLBBookCheckState(item, name, s) {
    const isSelected = s.lorebookSelectedBooks.includes(name);
    const isExcluded = (s.lorebookExcludedBooks || []).includes(name);
    const check = item.querySelector('.scp-lb-book-check');
    if (!check) return;
    check.classList.remove('checked', 'excluded');
    if (isSelected) check.classList.add('checked');
    else if (isExcluded) check.classList.add('excluded');
    check.title = isSelected ? 'Selected: all entries included — click to exclude' : isExcluded ? 'Excluded: all entries blocked — click to reset' : 'Default — click to include all';
    item.classList.toggle('selected', isSelected);
    item.classList.toggle('lb-excluded', isExcluded);
    // dim entries area when forced state
    const isForced = isSelected || isExcluded;
    if (item.classList.contains('lb-book-open')) {
        const entriesEl = document.getElementById('scp-lb-entries');
        if (entriesEl) entriesEl.classList.toggle('lb-entries-dimmed', isForced);
    }
}

export async function refreshLorebookList() {
    const listEl = document.getElementById('scp-lb-book-list');
    if (!listEl) return;

    const ctx = SillyTavern.getContext();
    if (typeof ctx.updateWorldInfoList === 'function') {
        ctx.updateWorldInfoList().catch(() => {});
    }

    const activeNamesArray = getActiveLorebookNames();
    const s = getSettings();

    listEl.innerHTML = '';
    if (!activeNamesArray.length) {
        listEl.innerHTML = '<div class="scp-lb-loading">No active lorebooks found.<br><small style="opacity:.5">Link one to the character or select globally.</small></div>';
        return;
    }

    await Promise.all(activeNamesArray.map(name => fetchWorldInfoBook(name)));

    const frag = document.createDocumentFragment();
    for (const name of activeNamesArray) {
        const displayName = getDisplayName(name);
        const isSelected = s.lorebookSelectedBooks.includes(name);
        const isExcluded = (s.lorebookExcludedBooks || []).includes(name);
        
        const item = document.createElement('div');
        item.className = `scp-lb-book-item${isSelected ? ' selected' : ''}${isExcluded ? ' lb-excluded' : ''}${_lbActiveBook === name ? ' lb-book-open' : ''}`;
        item.dataset.name = name;
        
        const cached = _getWiCache()[name];
        const entryCount = cached ? Object.keys(cached.entries || {}).length : '…';
        const isEmbedded = name === EMBEDDED_BOOK_KEY;
        const srcType = getBookSourceType(name);
        const srcLabel = { global: 'G', character: 'C', chat: 'Ch', embedded: '✦', manual: '' }[srcType] || '';
        const srcClass = `scp-lb-src-${srcType}`;
        
        const checkState = isSelected ? 'checked' : isExcluded ? 'excluded' : '';
        const checkTitle = isSelected ? 'Selected: all entries included — click to exclude' : isExcluded ? 'Excluded: all entries blocked — click to reset' : 'Default — click to include all';
        
        item.innerHTML = `
            <div class="scp-lb-book-check${checkState ? ' ' + checkState : ''}" data-book="${escHtml(name)}" title="${checkTitle}"></div>
            <div class="scp-lb-book-info">
                <span class="scp-lb-book-name">${escHtml(displayName)}${isEmbedded ? ' <span class="scp-lb-embedded-badge">embedded</span>' : ''}</span>
                <span class="scp-lb-book-meta">${entryCount} entries · Active</span>
            </div>
            ${srcLabel ? `<span class="scp-lb-src-badge ${srcClass}" title="Source: ${srcType}">${srcLabel}</span>` : ''}
            <span class="scp-lb-book-active-dot" title="Currently active in this chat"></span>`;
            
        item.querySelector('.scp-lb-book-check').addEventListener('click', e => { e.stopPropagation(); toggleLorebookSelection(name); });
        item.addEventListener('click', () => viewLorebookEntries(name));
        frag.appendChild(item);
    }
    listEl.appendChild(frag);
    updateLBFooterInfo();
}

export async function toggleLorebookSelection(name) {
    const s = getSettings();
    const isSelected = s.lorebookSelectedBooks.includes(name);
    const isExcluded = (s.lorebookExcludedBooks || []).includes(name);

    if (!isSelected && !isExcluded) {
        s.lorebookSelectedBooks.push(name);
        s.lorebookExcludedBooks = (s.lorebookExcludedBooks || []).filter(b => b !== name);
    } else if (isSelected) {
        s.lorebookSelectedBooks = s.lorebookSelectedBooks.filter(b => b !== name);
        if (!s.lorebookExcludedBooks) s.lorebookExcludedBooks = [];
        s.lorebookExcludedBooks.push(name);
    } else {
        s.lorebookExcludedBooks = s.lorebookExcludedBooks.filter(b => b !== name);
    }
    saveSettings();

    await buildLorebookContextBlock(s);

    const item = document.querySelector(`.scp-lb-book-item[data-name="${CSS.escape(name)}"]`);
    if (item) _applyLBBookCheckState(item, name, s);
    updateLBFooterInfo();
    _updateMsgCount(getCurrentSession());
    if (_lbActiveBook) renderEntryList(_lbActiveBook, _lbSearchQuery);
}

export async function viewLorebookEntries(name) {
    closeUidDirectory();
    _lbActiveBook = name;
    document.querySelectorAll('.scp-lb-book-item').forEach(el => el.classList.toggle('lb-book-open', el.dataset.name === name));
    document.getElementById('scp-lb-main-actions').style.display = '';
    document.getElementById('scp-lb-ctx-legend').style.display = '';
    document.getElementById('scp-lb-entry-detail').style.display = 'none';
    document.getElementById('scp-lb-entries').style.display = '';
    const s = getSettings();
    const isForced = s.lorebookSelectedBooks.includes(name) || (s.lorebookExcludedBooks || []).includes(name);
    const entriesEl = document.getElementById('scp-lb-entries');
    if (entriesEl) entriesEl.classList.toggle('lb-entries-dimmed', isForced);
    await renderEntryList(name, _lbSearchQuery);
}

export async function renderEntryList(bookName, search = '') {
    const container = document.getElementById('scp-lb-entries');
    if (!container) return;
    const data = await fetchWorldInfoBook(bookName);
    if (!data) { container.innerHTML = '<div class="scp-lb-empty-state">Failed to load lorebook</div>'; return; }

    const entries = wiEntriesToArray(data);
    const [sort, direction] = (document.getElementById('scp-lb-sort')?.value || 'list').split('-');
    const s = getSettings();
    const overrides = s.lorebookEntryOverrides || {};
    const isBookSelected = (s.lorebookSelectedBooks || []).includes(bookName);
    const activeEntryUids = new Set(
        _getLastActiveEntries().filter(e => e.bookName === bookName).map(e => e.uid)
    );
    const lowerSearch = search.trim().toLowerCase();
    const explicitUid = /^(?:uid\s*[:#]?\s*|#)(\d+)$/.exec(lowerSearch)?.[1];
    const filtered = search ? entries.filter(e => {
        if (explicitUid !== undefined) return Number(e.uid) === Number(explicitUid);
        return (e.comment || '').toLowerCase().includes(lowerSearch)
            || (e.content || '').toLowerCase().includes(lowerSearch)
            || (e.key || []).join(' ').toLowerCase().includes(lowerSearch)
            || String(e.uid) === lowerSearch;
    }) : entries;
    const metric = entrySortValue[sort];
    if (metric) {
        const sign = direction === 'desc' ? -1 : 1;
        filtered.sort((a, b) => sign * (sort === 'strategy'
            ? metric(a).localeCompare(metric(b))
            : metric(a) - metric(b)));
    }

    const label = document.getElementById('scp-lb-entries-label');
    if (label) label.textContent = `${getDisplayName(bookName)} — ${filtered.length}${filtered.length !== entries.length ? ` of ${entries.length}` : ''} entr${filtered.length !== 1 ? 'ies' : 'y'}`;

    const frag = document.createDocumentFragment();
    for (const entry of filtered) {
        const overKey = getEntryOverrideKey(bookName, entry);
        const override = overrides[overKey];
        const isDisabled = !!entry.disable;
        const isInCtx = activeEntryUids.has(entry.uid);
        const row = document.createElement('div');
        row.className = `scp-lb-entry-row${isDisabled ? ' lb-disabled' : ''}${isInCtx ? ' lb-in-ctx' : ''}`;
        row.dataset.uid = entry.uid;

        let indClass = '', indTitle = '', btnText = '~';
        if (override === true) { indClass = 'forced-on'; indTitle = 'Force included in Copilot context'; btnText = '✓'; }
        else if (override === false) { indClass = 'forced-off'; indTitle = 'Force excluded from Copilot context'; btnText = '✕'; }
        else if (entry.constant && !entry.disable) { indClass = 'forced-on'; indTitle = 'Constant entry (Always included)'; btnText = '✓'; }
        else if (isInCtx) { indClass = 'scp-lb-ind-in-ctx'; indTitle = 'Currently injected in last Copilot request'; }
        else { indTitle = isDisabled ? 'Disabled in lorebook' : isBookSelected ? 'Will be included (book selected)' : 'Book not selected — no injection'; }

        row.innerHTML = `
            <div class="scp-lb-entry-indicator ${indClass}" title="${indTitle}"></div>
            <div class="scp-lb-entry-info">
                <span class="scp-lb-entry-name">${escHtml(entry.comment || `#${entry.uid}`)}${isInCtx ? ' <span class="scp-lb-in-ctx-badge">in context</span>' : ''}</span>
                <span class="scp-lb-entry-keys">${entry.key?.slice(0, 5).map(k => escHtml(k)).join(' · ') || '—'}</span>
            </div>
            <span class="scp-lb-uid">UID ${escHtml(String(entry.uid))}</span>
            ${metric ? `<span class="scp-lb-sort-value">${escHtml(String(metric(entry)))}${sort === 'probability' ? '%' : ''}</span>` : ''}
            <div class="scp-lb-entry-actions">
                <button class="scp-lb-entry-toggle-btn ${indClass}" title="Cycle: Default → Force On → Force Off">${btnText}</button>
                <button class="scp-lb-entry-view-btn" title="View / Edit">${ICONS.edit}</button>
            </div>`;
        row.querySelector('.scp-lb-entry-toggle-btn').addEventListener('click', e => { e.stopPropagation(); cycleEntryOverride(bookName, entry, row); });
        row.querySelector('.scp-lb-entry-view-btn').addEventListener('click', e => { e.stopPropagation(); showEntryDetail(entry, bookName, data); });
        row.addEventListener('click', () => showEntryDetail(entry, bookName, data));
        frag.appendChild(row);
    }
    container.innerHTML = '';
    container.appendChild(frag);

    const ctxEl = document.getElementById('scp-lb-footer-ctx');
    if (ctxEl) {
        ctxEl.textContent = activeEntryUids.size
            ? `${activeEntryUids.size} entr${activeEntryUids.size !== 1 ? 'ies' : 'y'} in context`
            : '';
    }
}

export function cycleEntryOverride(bookName, entry, rowEl) {
    const s = getSettings();
    if (!s.lorebookEntryOverrides) s.lorebookEntryOverrides = {};
    const key = getEntryOverrideKey(bookName, entry);
    const current = s.lorebookEntryOverrides[key];
    const isConstantEntry = !!entry.constant && !entry.disable;
    let next;
    if (current === undefined) next = isConstantEntry ? false : true;
    else if (current === true) next = false;
    else { delete s.lorebookEntryOverrides[key]; next = undefined; }
    if (next !== undefined) s.lorebookEntryOverrides[key] = next;
    saveSettings();

    const ind = rowEl.querySelector('.scp-lb-entry-indicator');
    const btn = rowEl.querySelector('.scp-lb-entry-toggle-btn');
    const isConstant = isConstantEntry;

    if (next === true) {
        ind.className = 'scp-lb-entry-indicator forced-on';
        btn.textContent = '✓'; btn.className = 'scp-lb-entry-toggle-btn forced-on';
        rowEl.classList.remove('lb-in-ctx');
    } else if (next === false) {
        ind.className = 'scp-lb-entry-indicator forced-off';
        btn.textContent = '✕'; btn.className = 'scp-lb-entry-toggle-btn forced-off';
        rowEl.classList.remove('lb-in-ctx');
    } else {
        const isInCtx = _getLastActiveEntries().some(e => e.bookName === bookName && e.uid === entry.uid);
        ind.className = `scp-lb-entry-indicator${isConstant ? ' forced-on' : (isInCtx ? ' scp-lb-ind-in-ctx' : '')}`;
        btn.textContent = isConstant ? '✓' : '~'; 
        btn.className = `scp-lb-entry-toggle-btn${isConstant ? ' forced-on' : ''}`;
        rowEl.classList.toggle('lb-in-ctx', isInCtx);
    }

    _updateMsgCount(getCurrentSession());
}

const entrySortValue = {
    strategy: entry => ({ normal: 'Normal', constant: 'Constant', vectorized: 'Vectorized' })[getEntryLayout(entry).strategy],
    depth: entry => getEntryLayout(entry).depth,
    order: entry => getEntryLayout(entry).order,
    probability: entry => getEntryLayout(entry).probability,
};

const entryControlIds = {
    listPosition: 'scp-lb-list-position', strategy: 'scp-lb-entry-strategy', position: 'scp-lb-entry-position',
    depth: 'scp-lb-entry-depth', order: 'scp-lb-entry-order', probability: 'scp-lb-entry-probability',
};

function entryControls() {
    return Object.fromEntries(Object.entries(entryControlIds).map(([key, id]) => [key, document.getElementById(id)]));
}

function syncEntryDepth(controls) {
    controls.depth.disabled = controls.position.disabled || !controls.position.value.startsWith('4:');
}

export function showEntryDetail(entry, bookName, data = _getWiCache()[bookName]) {
    _lbEntryDetailEntry = entry;
    _lbEntryDetailBook = bookName;
    document.getElementById('scp-lb-entry-detail').style.display = 'flex';
    document.getElementById('scp-lb-entries').style.display = 'none';

    document.getElementById('scp-lb-detail-title').textContent = entry.comment || `Entry #${entry.uid}`;
    const uidButton = document.getElementById('scp-lb-detail-uid');
    uidButton.textContent = `UID ${entry.uid}`;
    uidButton.setAttribute('aria-label', `Copy entry UID ${entry.uid}`);
    document.getElementById('scp-lb-detail-name').value = entry.comment || '';
    document.getElementById('scp-lb-detail-triggers').value = (entry.key || []).join(', ');
    document.getElementById('scp-lb-detail-content').value = entry.content || '';
    const controls = entryControls();
    const ordered = wiEntriesToArray(data);
    const readOnly = bookName === EMBEDDED_BOOK_KEY;
    const values = {
        listPosition: ordered.findIndex(item => String(item.uid) === String(entry.uid)) + 1,
        ...getEntryLayout(entry),
    };
    controls.listPosition.max = String(ordered.length);
    for (const [field, input] of Object.entries(controls)) {
        input.value = String(values[field]);
        input.dataset.savedValue = input.value;
        input.disabled = readOnly;
    }
    syncEntryDepth(controls);

    const lbStatus = document.getElementById('scp-lb-detail-lb-status');
    if (lbStatus) {
        const updateStatus = () => {
            lbStatus.textContent = entry.disable ? 'Disabled' : 'Enabled';
            lbStatus.className = `scp-lb-detail-status ${entry.disable ? 'status-disabled' : 'status-enabled'}`;
        };
        updateStatus();
        lbStatus.onclick = async () => {
            entry.disable = !entry.disable;
            updateStatus();
            const data = await fetchWorldInfoBook(bookName);
            if (data?.entries[entry.uid] !== undefined) {
                data.entries[entry.uid].disable = entry.disable;
                await saveWorldInfoBook(bookName, data);
                toastr.success('Status updated', EXT_DISPLAY);
                renderEntryList(bookName, _lbSearchQuery);
            }
        };
    }

    updateEntryInjectionControls(entry, bookName);
}

function updateEntryInjectionControls(entry, bookName) {
    const s = getSettings();
    const override = (s.lorebookEntryOverrides || {})[getEntryOverrideKey(bookName, entry)];
    ['scp-lb-inj-default', 'scp-lb-inj-force-on', 'scp-lb-inj-force-off'].forEach(id => document.getElementById(id)?.classList.remove('active'));
    if (override === true) document.getElementById('scp-lb-inj-force-on')?.classList.add('active');
    else if (override === false) document.getElementById('scp-lb-inj-force-off')?.classList.add('active');
    else document.getElementById('scp-lb-inj-default')?.classList.add('active');

    const hintEl = document.getElementById('scp-lb-inj-hint');
    if (hintEl) {
        const isBookSel = (s.lorebookSelectedBooks ||[]).includes(bookName);
        const isInCtx = _getLastActiveEntries().some(e => e.bookName === bookName && e.uid === entry.uid);
        if (override === true) hintEl.textContent = 'Always injected into Copilot context.';
        else if (override === false) hintEl.textContent = 'Never injected — excluded regardless of book selection.';
        else if (entry.constant && !entry.disable) hintEl.textContent = 'Constant entry. Automatically injected unless Forced Off.';
        else if (isInCtx) hintEl.textContent = '✓ In Copilot request context.';
        else if (isBookSel) hintEl.textContent = 'Included because this book is selected. Disable the entry or use Force Off to exclude.';
        else if (entry.disable) hintEl.textContent = 'Entry is disabled in lorebook. Enable it or use Force On to override.';
        else hintEl.textContent = 'Book not selected. Check the book checkbox in the sidebar, or use Force On.';
    }
}

export async function saveEntryDetail() {
    if (!_lbEntryDetailEntry || !_lbEntryDetailBook) return;
    if (_lbEntryDetailBook === EMBEDDED_BOOK_KEY) { toastr.warning('Cannot save embedded character book entries. Edit the character card in ST.', EXT_DISPLAY); return; }
    const sourceEntry = _lbEntryDetailEntry;
    const bookName = _lbEntryDetailBook;
    const saveButton = document.getElementById('scp-lb-detail-save');
    if (saveButton.disabled) return;
    const layout = {};
    for (const [field, input] of Object.entries(entryControls())) {
        if (input.disabled || input.value === input.dataset.savedValue) continue;
        if (!input.reportValidity()) return;
        layout[field] = input.type === 'number' ? input.valueAsNumber : input.value;
    }
    const name = document.getElementById('scp-lb-detail-name').value;
    const keys = document.getElementById('scp-lb-detail-triggers').value.split(',').map(key => key.trim()).filter(Boolean);
    const content = document.getElementById('scp-lb-detail-content').value;
    saveButton.disabled = true;
    try {
        const { data, entry } = await editWorldInfoBook(bookName, data => {
            const entry = data?.entries?.[sourceEntry.uid];
            if (!entry) throw new Error('This entry no longer exists. Refresh the lorebook list.');

            if (Object.keys(layout).length) updateEntryLayout(data, entry, layout);
            if (name !== (sourceEntry.comment || '')) setEntryField(data, entry, 'comment', name);
            if (keys.join(', ') !== (sourceEntry.key || []).join(', ')) setEntryField(data, entry, 'key', keys, 'keys');
            if (content !== (sourceEntry.content || '')) setEntryField(data, entry, 'content', content);
            return entry;
        });
        toastr.success('Entry saved', EXT_DISPLAY);
        if (_lbEntryDetailEntry === sourceEntry && _lbActiveBook === bookName && document.getElementById('scp-lb-entry-detail').style.display !== 'none') {
            showEntryDetail(entry, bookName, data);
        }
        if (_lbActiveBook === bookName) await renderEntryList(bookName, _lbSearchQuery);
        _updateMsgCount(getCurrentSession());
    } catch (error) {
        toastr.error(`Entry could not be saved: ${error.message}`, EXT_DISPLAY, { escapeHtml: true });
    } finally {
        saveButton.disabled = false;
    }
}

export async function deleteEntryDetail() {
    if (!_lbEntryDetailEntry || !_lbEntryDetailBook) return;
    const ok = await showCustomDialog({ type: 'confirm', title: 'Delete Entry', message: `Delete "${_lbEntryDetailEntry.comment || 'this entry'}"? This cannot be undone.` });
    if (!ok) return;
    const data = await fetchWorldInfoBook(_lbEntryDetailBook);
    if (!data) return;
    delete data.entries[_lbEntryDetailEntry.uid];
    await saveWorldInfoBook(_lbEntryDetailBook, data);
    toastr.success('Entry deleted', EXT_DISPLAY);
    document.getElementById('scp-lb-entry-detail').style.display = 'none';
    document.getElementById('scp-lb-entries').style.display = '';
    renderEntryList(_lbEntryDetailBook, _lbSearchQuery);
    _updateMsgCount(getCurrentSession());
}

export async function addNewEntry() {
    if (!_lbActiveBook) { toastr.warning('Select a lorebook first', EXT_DISPLAY); return; }
    if (_lbActiveBook === EMBEDDED_BOOK_KEY) { toastr.warning('Cannot add entries to embedded character books directly. Edit the character card.', EXT_DISPLAY); return; }
    const name = await showCustomDialog({ type: 'prompt', title: 'New Entry', message: 'Entry name:', placeholder: 'New Entry' });
    if (name === null) return;
    const data = await fetchWorldInfoBook(_lbActiveBook);
    if (!data) { toastr.error('Failed to load book', EXT_DISPLAY); return; }
    const uids = Object.keys(data.entries).map(Number);
    const newUid = uids.length ? Math.max(...uids) + 1 : 1;
    const newEntry = {
        uid: newUid, key: [], keysecondary: [], content: '',
        comment: name.trim() || 'New Entry', disable: false, group: '',
        selective: false, constant: false, position: 0, depth: 4,
        displayIndex: newUid, prevent_recursion: false,
        delayUntilRecursion: false, scan_depth: null,
        match_whole_words: null, use_group_scoring: false,
        case_sensitive: null, automation_id: '', role: null,
        vectorized: false, sticky: null, cooldown: null, delay: null,
    };
    data.entries[newUid] = newEntry;
    await saveWorldInfoBook(_lbActiveBook, data);
    toastr.success('Entry created', EXT_DISPLAY);
    await renderEntryList(_lbActiveBook, _lbSearchQuery);
    showEntryDetail(newEntry, _lbActiveBook, data);
}

export function updateLBFooterInfo() {
    const el = document.getElementById('scp-lb-footer-info');
    if (!el) return;
    const s = getSettings();
    const count = (s.lorebookSelectedBooks || []).length;
    const excCount = (s.lorebookExcludedBooks || []).length;
    const kwOn = s.lorebookAutoKeyword;
    const parts = [];
    if (count) parts.push(`${count} book${count !== 1 ? 's' : ''} selected`);
    if (excCount) parts.push(`${excCount} excluded`);
    if (kwOn) parts.push('Auto-keywords ON');
    if (!count && !excCount && !kwOn) parts.push('☑ Check books in sidebar to inject entries into Copilot context');
    el.textContent = parts.join(' · ');
}

export function setupLorebookManagerListeners() {
    document.getElementById('scp-lb-close')?.addEventListener('click', closeLorebookManager);
    document.getElementById('scp-lb-open-uids')?.addEventListener('click', () => openLorebookUidDirectory());
    document.getElementById('scp-lb-uids-back')?.addEventListener('click', () => {
        closeUidDirectory();
        document.getElementById('scp-lb-open-uids').focus();
    });
    document.getElementById('scp-lb-uids-book')?.addEventListener('change', renderUidDirectory);
    document.getElementById('scp-lb-uids-copy')?.addEventListener('click', () => {
        const text = getUidDirectoryGroups().filter(group => group.entries?.length).map(group => [
            getDisplayName(group.name), 'UID\tEntry',
            ...group.entries.map(entry => `${entry.uid}\t${entry.title}`),
        ].join('\n')).join('\n\n');
        if (text) copyText(text);
    });
    const lbOverlay = document.getElementById('scp-lb-overlay');
    if (lbOverlay) {
        let _lbOverlayTouchStart = null;
        let _lbMouseDownTarget = null;
        lbOverlay.addEventListener('mousedown', e => { _lbMouseDownTarget = e.target; });
        lbOverlay.addEventListener('touchstart', e => {
            if (e.target === lbOverlay) _lbOverlayTouchStart = { x: e.touches[0].clientX, y: e.touches[0].clientY };
        }, { passive: true });
        lbOverlay.addEventListener('touchend', e => {
            if (e.target === lbOverlay && _lbOverlayTouchStart) {
                const dx = Math.abs(e.changedTouches[0].clientX - _lbOverlayTouchStart.x);
                const dy = Math.abs(e.changedTouches[0].clientY - _lbOverlayTouchStart.y);
                if (dx < 8 && dy < 8) closeLorebookManager();
            }
            _lbOverlayTouchStart = null;
        }, { passive: true });
        lbOverlay.addEventListener('click', e => {
            if (e.target === lbOverlay && _lbMouseDownTarget === lbOverlay) closeLorebookManager();
            _lbMouseDownTarget = null;
        });
    }

    const diffModal = document.getElementById('scp-diff-modal');
    document.getElementById('scp-diff-close')?.addEventListener('click', () => { if (diffModal) diffModal.style.display = 'none'; });
    let _diffMouseDown = null;
    diffModal?.addEventListener('mousedown', e => { _diffMouseDown = e.target; });
    diffModal?.addEventListener('click', e => { if (e.target === diffModal && _diffMouseDown === diffModal) diffModal.style.display = 'none'; });
    document.getElementById('scp-lb-refresh')?.addEventListener('click', async () => {
        if (!document.getElementById('scp-lb-uid-directory')?.hidden) {
            await openLorebookUidDirectory(document.getElementById('scp-lb-uids-book').value);
            return;
        }
        clearWiCache();
        await refreshLorebookList();
        if (_lbActiveBook) await renderEntryList(_lbActiveBook, _lbSearchQuery);
    });

    let _lbSearchTid = null;
    document.getElementById('scp-lb-search')?.addEventListener('input', e => {
        if (!document.getElementById('scp-lb-uid-directory')?.hidden) {
            renderUidDirectory();
            return;
        }
        _lbSearchQuery = e.target.value;
        clearTimeout(_lbSearchTid);
        _lbSearchTid = setTimeout(() => { if (_lbActiveBook) renderEntryList(_lbActiveBook, _lbSearchQuery); }, 200);
    });
    document.getElementById('scp-lb-sort')?.addEventListener('change', () => {
        if (_lbActiveBook) renderEntryList(_lbActiveBook, _lbSearchQuery);
    });
    document.getElementById('scp-lb-entry-position')?.addEventListener('change', () => syncEntryDepth(entryControls()));

    document.getElementById('scp-lb-enable-all')?.addEventListener('click', () => {
        if (!_lbActiveBook || !_getWiCache()[_lbActiveBook]) return;
        const s = getSettings();
        Object.values(_getWiCache()[_lbActiveBook].entries).forEach(e => { s.lorebookEntryOverrides[getEntryOverrideKey(_lbActiveBook, e)] = true; });
        saveSettings(); renderEntryList(_lbActiveBook, _lbSearchQuery);
        _updateMsgCount(getCurrentSession());
    });
    document.getElementById('scp-lb-disable-all')?.addEventListener('click', () => {
        if (!_lbActiveBook || !_getWiCache()[_lbActiveBook]) return;
        const s = getSettings();
        Object.values(_getWiCache()[_lbActiveBook].entries).forEach(e => { s.lorebookEntryOverrides[getEntryOverrideKey(_lbActiveBook, e)] = false; });
        saveSettings(); renderEntryList(_lbActiveBook, _lbSearchQuery);
        _updateMsgCount(getCurrentSession());
    });
    document.getElementById('scp-lb-reset-overrides')?.addEventListener('click', async () => {
        if (!_lbActiveBook) return;
        const ok = await showCustomDialog({ type: 'confirm', title: 'Reset Overrides', message: `Reset all copilot injection overrides for "${_lbActiveBook}"?` });
        if (!ok) return;
        const s = getSettings();
        if (_getWiCache()[_lbActiveBook]) Object.values(_getWiCache()[_lbActiveBook].entries).forEach(e => { delete s.lorebookEntryOverrides[getEntryOverrideKey(_lbActiveBook, e)]; });
        saveSettings(); renderEntryList(_lbActiveBook, _lbSearchQuery);
        _updateMsgCount(getCurrentSession());
    });
    document.getElementById('scp-lb-add-entry')?.addEventListener('click', addNewEntry);
    document.getElementById('scp-lb-back')?.addEventListener('click', async () => {
        document.getElementById('scp-lb-entry-detail').style.display = 'none';
        document.getElementById('scp-lb-entries').style.display = '';
        
        await buildLorebookContextBlock(getSettings());
        if (_lbActiveBook) await renderEntryList(_lbActiveBook, _lbSearchQuery);
    });
    document.getElementById('scp-lb-detail-save')?.addEventListener('click', saveEntryDetail);
    document.getElementById('scp-lb-detail-delete')?.addEventListener('click', deleteEntryDetail);
    document.getElementById('scp-lb-detail-uid')?.addEventListener('click', () => {
        if (_lbEntryDetailEntry?.uid != null) copyText(String(_lbEntryDetailEntry.uid));
    });
    document.getElementById('scp-lb-detail-copy')?.addEventListener('click', () => {
        const c = document.getElementById('scp-lb-detail-content')?.value; if (c) copyText(c);
    });
    ['scp-lb-inj-default', 'scp-lb-inj-force-on', 'scp-lb-inj-force-off'].forEach(id => {
        document.getElementById(id)?.addEventListener('click', () => {
            if (!_lbEntryDetailEntry || !_lbEntryDetailBook) return;
            const val = document.getElementById(id)?.dataset.val;
            const s = getSettings();
            if (!s.lorebookEntryOverrides) s.lorebookEntryOverrides = {};
            const key = getEntryOverrideKey(_lbEntryDetailBook, _lbEntryDetailEntry);
            if (val === 'default') delete s.lorebookEntryOverrides[key];
            else s.lorebookEntryOverrides[key] = val === 'true';
            
            saveSettings();
            ['scp-lb-inj-default', 'scp-lb-inj-force-on', 'scp-lb-inj-force-off'].forEach(bid => document.getElementById(bid)?.classList.remove('active'));
            document.getElementById(id)?.classList.add('active');
            updateEntryInjectionControls(_lbEntryDetailEntry, _lbEntryDetailBook);
            _updateMsgCount(getCurrentSession());
        });
    });
}
