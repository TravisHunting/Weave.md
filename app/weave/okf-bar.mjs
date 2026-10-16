import YAML from 'yaml';
import {OKF_FIELDS, TIMESTAMP_FIELDS, readFrontmatter, setFrontmatterField, createFrontmatter, splitFrontmatter, okfList} from './okf.mjs';
import {articlePresentation} from './presentation.mjs';

const labels = {type: 'Type', title: 'Title', description: 'Description', resource: 'Resource', tags: 'Tag'};
const placeholders = {type: 'Kind of concept', title: 'Display title', description: 'One-sentence summary', resource: 'URI of the asset', tags: 'tag'};
const scalar = value => value === null || ['string', 'number', 'boolean'].includes(typeof value);
const display = value => Array.isArray(value) && value.every(scalar) ? value.join(', ') : scalar(value) ? String(value ?? '') : YAML.stringify(value, {collectionStyle: 'flow', lineWidth: 0}).trim();
const present = (fields, key) => key in fields && fields[key] !== null && fields[key] !== '';
// Tags are stored without '#'; commas separate several typed at once.
const tagValues = raw => raw.split(',').map(tag => tag.trim().replace(/^#+/, '').trim()).filter(Boolean);

// A row of property pills above the article body. The frontmatter itself is
// hidden in Read and Edit modes; in Edit mode each pill is typed into directly.
// Enter or leaving a pill saves it, Escape restores it, Tab moves to the next.
// Each tag is its own `#tag` pill; "+ Tag" adds them one at a time.
export function createOkfBar(element, {editor, path, visible, editable, message}) {
  let pending = null, deferred = false; // pending: {field} for a pill being added
  const focused = () => element.contains(document.activeElement) && document.activeElement.matches('input');
  function pill(field, {label = labels[field] || field, value = '', editing = false, tag = null} = {}) {
    const node = document.createElement('span'); node.className = 'okf-chip' + (tag !== null ? ' okf-tag' : ''); node.dataset.okfField = field;
    if (tag !== null) node.dataset.okfTag = String(tag);
    const name = document.createElement('span'); name.className = 'okf-key'; name.textContent = tag !== null ? '#' : label; node.append(name);
    if (editing) {
      const input = document.createElement('input'); input.className = 'okf-value'; input.value = value; input.dataset.original = value;
      input.placeholder = placeholders[field] || 'value'; input.spellcheck = field === 'title' || field === 'description';
      input.setAttribute('aria-label', tag !== null ? 'Tag' : label); node.append(input);
    } else if (value) {const shown = document.createElement('span'); shown.className = 'okf-value'; shown.textContent = value; node.append(shown); node.title = (tag !== null ? 'Tag' : label) + ': ' + value;}
    return node;
  }
  function addButton(text, data, title) {
    const button = document.createElement('button'); button.type = 'button'; button.className = 'okf-chip okf-empty'; button.textContent = text; button.title = title;
    Object.assign(button.dataset, data); return button;
  }
  function render({force = false, focus = null} = {}) {
    if (!force && focused()) {deferred = true; return;}
    deferred = false; element.replaceChildren();
    if (!visible()) {element.hidden = true; pending = null; return;}
    const text = editor().text, okf = readFrontmatter(text), canEdit = editable();
    if (!okf.present) {
      element.hidden = !canEdit; pending = null;
      if (canEdit) element.append(addButton('+ Add OKF properties', {okfAction: 'create'}, 'Add Open Knowledge Format frontmatter: type, title, description, resource and tags'));
      return;
    }
    element.hidden = false;
    if (okf.error) {const node = pill('error', {label: 'Frontmatter error', value: okf.error}); node.classList.add('okf-error'); node.title = 'Fix the YAML frontmatter in Source mode: ' + okf.error; element.append(node); return;}
    const fields = okf.fields;
    for (const field of OKF_FIELDS) {
      if (field === 'tags') {
        const tags = okfList(fields.tags);
        tags.forEach((tag, index) => element.append(pill('tags', {editing: canEdit, value: tag, tag: index})));
        if (canEdit && pending?.field === 'tags') element.append(pill('tags', {editing: true, tag: 'new'}));
        else if (canEdit) element.append(addButton('+ Tag', {okfAdd: 'tags'}, 'Add a tag'));
        continue;
      }
      const has = present(fields, field);
      if (canEdit && (has || pending?.field === field)) element.append(pill(field, {editing: true, value: has ? display(fields[field]) : ''}));
      else if (has) element.append(pill(field, {value: display(fields[field])}));
      else if (canEdit) element.append(addButton('+ ' + labels[field], {okfAdd: field}, 'Add ' + field));
    }
    // Other keys already in the frontmatter stay visible and editable, except
    // the timestamps and the `weave` block (Kanban placement) that Weave
    // maintains itself; Source mode still shows them.
    for (const [field, value] of Object.entries(fields)) if (!OKF_FIELDS.includes(field) && !TIMESTAMP_FIELDS.includes(field) && field !== 'weave') element.append(pill(field, {editing: canEdit, value: display(value)}));
    if (focus) {const target = element.querySelector(focus); if (target) {target.focus(); if (target.matches('input')) target.setSelectionRange(target.value.length, target.value.length);}}
  }
  const fieldInput = field => `[data-okf-field="${CSS.escape(field)}"]:not([data-okf-tag]) input.okf-value`;
  const tagInput = tag => `[data-okf-tag="${tag}"] input.okf-value`;
  function apply(next) {editor().setFrontmatter(splitFrontmatter(next).frontmatter);}
  function parse(field, raw, original) {
    if (!raw) return undefined;
    if (OKF_FIELDS.includes(field) || typeof original === 'string') return raw;
    try {const value = YAML.parse(raw); return value ?? raw;} catch (error) {throw new Error('Enter valid YAML for ' + field + ': ' + error.message);}
  }
  // Save one tag pill: edit or remove an existing tag, or append new ones. A
  // new tag keeps an empty tag pill open so the next one can be typed at once.
  function commitTag(input, next, {another = false} = {}) {
    const chip = input.closest('[data-okf-tag]'), slot = chip.dataset.okfTag, text = editor().text;
    const tags = okfList(readFrontmatter(text).fields.tags), typed = tagValues(input.value);
    if (slot === 'new') {
      if (!typed.length) {pending = null; render({force: true, focus: next}); return;}
      tags.push(...typed.filter(tag => !tags.includes(tag)));
      pending = another ? {field: 'tags'} : null;
    } else {
      if (input.value.trim() === input.dataset.original) {if (!next) render({force: true}); return;}
      tags.splice(Number(slot), 1, ...typed);
    }
    apply(setFrontmatterField(text, 'tags', tags.length ? [...new Set(tags)] : undefined));
    render({force: true, focus: another ? tagInput('new') : next});
  }
  // Save one pill. `next` names the pill that should keep focus afterward.
  function commit(input, next = null, options = {}) {
    if (input.closest('[data-okf-tag]')) {commitTag(input, next, options); return;}
    const chip = input.closest('[data-okf-field]'), field = chip.dataset.okfField, raw = input.value.trim();
    const text = editor().text, fields = readFrontmatter(text).fields, isNew = pending?.field === field;
    if (!isNew && raw === input.dataset.original) {if (!next) render({force: true}); return;}
    try {
      if (field === 'type' && !raw) throw new Error('OKF requires a type. Describe the kind of concept, for example Note or Table.');
      const value = parse(field, raw, fields[field]);
      if (value === undefined && !(field in fields)) {pending = null; render({force: true, focus: next}); return;}
      pending = null; apply(setFrontmatterField(text, field, value));
    } catch (error) {message(error.message); input.value = input.dataset.original; pending = null;}
    render({force: true, focus: next});
  }
  function createBlock() {
    const text = editor().text, title = articlePresentation(text, path()).heading;
    apply(createFrontmatter(text, title ? {title} : {}));
    pending = title ? null : {field: 'title'};
    render({force: true, focus: title ? null : fieldInput('title')});
  }
  element.addEventListener('click', event => {
    const button = event.target.closest('button'); if (!button || !editable()) return;
    try {
      if (button.dataset.okfAction === 'create') createBlock();
      else if (button.dataset.okfAdd) {pending = {field: button.dataset.okfAdd}; render({force: true, focus: button.dataset.okfAdd === 'tags' ? tagInput('new') : fieldInput(button.dataset.okfAdd)});}
    } catch (error) {message(error.message || String(error));}
  });
  element.addEventListener('keydown', event => {
    const input = event.target.closest('input'); if (!input) return;
    if (event.key === 'Escape') {event.preventDefault(); input.value = input.dataset.original || ''; pending = null; render({force: true}); editor().view?.focus(); return;}
    if (event.key !== 'Enter') return;
    event.preventDefault();
    const adding = input.closest('[data-okf-tag="new"]');
    commit(input, null, {another: !!adding && !!input.value.trim()});
    if (!adding || !input.value.trim()) editor().view?.focus();
  });
  // Leaving a pill saves it; focus moving to another pill stays in the bar.
  element.addEventListener('focusout', event => {
    const input = event.target.closest('input'); if (!input || !input.isConnected) return;
    // Keep Tab order: refocus the pill or add-button that focus moved to,
    // since saving re-renders the bar.
    const next = event.relatedTarget && element.contains(event.relatedTarget) ? event.relatedTarget : null;
    const chip = next?.closest('[data-okf-field]');
    const focus = !next ? null : next.matches('input') ? (chip.dataset.okfTag !== undefined ? tagInput(chip.dataset.okfTag) : fieldInput(chip.dataset.okfField))
      : next.dataset.okfAdd ? `[data-okf-add="${CSS.escape(next.dataset.okfAdd)}"]` : next.dataset.okfAction ? `[data-okf-action="${next.dataset.okfAction}"]` : null;
    queueMicrotask(() => {if (input.isConnected) commit(input, focus);});
  });
  element.addEventListener('focusout', () => queueMicrotask(() => {if (deferred && !focused()) render();}));
  return {render};
}
