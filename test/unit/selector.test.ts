import assert from 'node:assert/strict';
import { test } from 'node:test';
import { evaluate, formatQuery, type Query } from '../../src/query.ts';
import { parseSelector, SelectorError } from '../../src/selector.ts';
import type { TreeNode } from '../../src/tree.ts';
import { S, tree } from './helpers.ts';

const app = tree({
  role: 'application',
  name: 'editor',
  children: [
    {
      role: 'window',
      name: 'Untitled — Editor',
      states: S('active'),
      children: [
        {
          role: 'generic',
          children: [
            { role: 'button', name: 'Save', children: [{ role: 'text', name: 'Save' }] },
            { role: 'button', name: 'Save As…' },
            { role: 'button', name: 'Close', states: ['showing'] },
            { role: 'checkbox', name: 'Wrap lines', states: S('checked') },
            { role: 'checkbox', name: 'Spell check' },
            { role: 'textbox', name: 'Search', id: 'search-field', states: S('focused', 'editable') },
          ],
        },
        {
          role: 'list',
          name: 'Files',
          children: [
            { role: 'listitem', name: 'notes.txt', states: S('selectable', 'selected') },
            { role: 'listitem', name: 'todo.md', states: S('selectable') },
            { role: 'listitem', name: 'secret.txt', states: ['enabled'] },
          ],
        },
        { role: 'textbox', text: 'hello world', states: S('editable', 'multiline') },
      ],
    },
    {
      role: 'dialog',
      name: 'Save File',
      children: [
        { role: 'textbox', name: 'Name' },
        { role: 'button', name: 'Save' },
        { role: 'button', name: 'Cancel' },
      ],
    },
  ],
});

const env = {
  resolveRef: (ref: string): TreeNode | undefined => {
    const all: TreeNode[] = [];
    const visit = (n: TreeNode) => {
      all.push(n);
      n.children.forEach(visit);
    };
    visit(app);
    return all.find((n) => n.handle.key === `node${ref.slice(1)}`);
  },
};

function names(q: Query | string): string[] {
  const query = typeof q === 'string' ? parseSelector(q) : q;
  return evaluate(query, [app], env).map((n) => `${n.info.role}:${n.name || n.text}`);
}

test('role and exact name, case-insensitive', () => {
  assert.deepEqual(names('button "Save"'), ['button:Save', 'button:Save']);
  assert.deepEqual(names('button "save"'), ['button:Save', 'button:Save']);
  assert.deepEqual(names('button "save"s'), []);
  assert.deepEqual(names('button "Save As..."'), ['button:Save As…']);
});

test('role aliases', () => {
  assert.deepEqual(names('push-button "Close"'), ['button:Close']);
  assert.deepEqual(names('entry'), ['textbox:Search', 'textbox:hello world', 'textbox:Name']);
  assert.deepEqual(names('label "Save"'), ['text:Save']);
});

test('regex and attribute operators', () => {
  assert.deepEqual(names('button /^save/i'), ['button:Save', 'button:Save As…', 'button:Save']);
  assert.deepEqual(names('button[name*="as"]'), ['button:Save As…']);
  assert.deepEqual(names('button[name^="cl"]'), ['button:Close']);
  assert.deepEqual(names('[name$=".txt"]'), ['listitem:notes.txt']);
});

test('states, including negation and visibility', () => {
  assert.deepEqual(names('checkbox [checked]'), ['checkbox:Wrap lines']);
  assert.deepEqual(names('checkbox[checked=false]'), ['checkbox:Spell check']);
  assert.deepEqual(names('checkbox[unchecked]'), ['checkbox:Spell check']);
  assert.deepEqual(names('button[disabled]'), ['button:Close']);
  assert.deepEqual(names('listitem'), ['listitem:notes.txt', 'listitem:todo.md']);
  assert.deepEqual(names('listitem:hidden'), ['listitem:secret.txt']);
  assert.deepEqual(names('listitem:any-visibility'), ['listitem:notes.txt', 'listitem:todo.md', 'listitem:secret.txt']);
});

test('chaining: descendants with space or >>, children with >', () => {
  assert.deepEqual(names('dialog "Save File" button "Save"'), ['button:Save']);
  assert.deepEqual(names('dialog >> button'), ['button:Save', 'button:Cancel']);
  // generic wrappers are see-through for ">"
  assert.deepEqual(names('window > button "Save"'), ['button:Save']);
  assert.deepEqual(names('window > text'), []);
});

test('ids, text and pseudo-classes', () => {
  assert.deepEqual(names('#search-field'), ['textbox:Search']);
  assert.deepEqual(names('[id="search-field"]'), ['textbox:Search']);
  assert.deepEqual(names(':text("hello")'), ['textbox:hello world']);
  // text search reports the innermost element: the label, not the button around it
  assert.deepEqual(names('*:text-is("Save")'), ['text:Save', 'button:Save']);
  assert.deepEqual(names('button:first'), ['button:Save']);
  assert.deepEqual(names('button:last'), ['button:Cancel']);
  assert.deepEqual(names('button:nth(1)'), ['button:Save As…']);
  assert.deepEqual(names('list:has(listitem[selected])'), ['list:Files']);
  assert.deepEqual(names('*:has-text("todo")'), ['window:Untitled — Editor', 'list:Files', 'listitem:todo.md']);
  assert.deepEqual(names('window:not(:has-text("todo"))'), []);
});

test('unions and pasted snapshot lines', () => {
  assert.deepEqual(names('checkbox [checked], dialog textbox'), ['checkbox:Wrap lines', 'textbox:Name']);
  assert.deepEqual(names('- checkbox "Wrap lines" [checked] [ref=e999]'), []);
  assert.deepEqual(names('- textbox "Search" [focused] [ref=e999]: "abc"'), []);
  const save = env.resolveRef('e4')!;
  assert.equal(save.name, 'Save');
  assert.deepEqual(names('@e4'), ['button:Save']);
  assert.deepEqual(names('e4'), ['button:Save']);
  assert.deepEqual(names('- button "Save" [ref=e4]'), ['button:Save']);
});

test('formats queries back to selectors', () => {
  assert.equal(formatQuery(parseSelector('dialog "Save File" >> button "Save" :first')), 'dialog "Save File" button "Save":first');
  assert.equal(formatQuery(parseSelector('checkbox[checked=false]')), 'checkbox[checked=false]');
});

test('reports bad selectors helpfully', () => {
  assert.throws(() => parseSelector('buton "Save"'), (e: Error) => e instanceof SelectorError && /Unknown role "buton"/.test(e.message));
  assert.throws(() => parseSelector('button "Save'), /Unterminated string/);
  assert.throws(() => parseSelector('button[frobbed]'), /Unknown state "frobbed"/);
  assert.throws(() => parseSelector(''), /Empty selector/);
});
