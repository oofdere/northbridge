import assert from 'node:assert/strict';
import { test } from 'node:test';
import { diffSnapshots } from '../../src/agent/changes.ts';

const before = `- application "app" [ref=e1]:
  - window "Main" [active] [ref=e2]:
    - checkbox "Subscribe" [ref=e3]
    - button "Delete…" [ref=e4]
    - button "Load later" [ref=e5]
    - text "Ready" [ref=e6]`;

const after = `- application "app" [ref=e1]:
  - window "Main" [ref=e2]:
    - checkbox "Subscribe" [checked] [focused] [ref=e3]
    - button "Delete…" [ref=e4]
    - text "Deleting" [ref=e6]
  - alert "Question" [modal] [ref=e7]:
    - text "Delete everything?" [ref=e8]
    - button "Delete" [ref=e9]`;

test('reports added, removed and changed elements by ref', () => {
  const diff = diffSnapshots(before, after);
  assert.equal(diff.added, 3);
  assert.equal(diff.removed, 1);
  assert.equal(diff.changed, 2);
  assert.equal(
    diff.text,
    [
      '~ checkbox "Subscribe" [checked] [focused] [ref=e3]  (was: checkbox "Subscribe" [ref=e3])',
      '~ text "Deleting" [ref=e6]  (was: text "Ready" [ref=e6])',
      '+ alert "Question" [modal] [ref=e7]',
      '+   text "Delete everything?" [ref=e8]',
      '+   button "Delete" [ref=e9]',
      '- button "Load later" [ref=e5]',
    ].join('\n'),
  );
});

test('removed subtrees are reported by their top element', () => {
  const withDialog = `${after}
  - text "status" [ref=e20]`;
  const closed = `- application "app" [ref=e1]:
  - window "Main" [ref=e2]:
    - checkbox "Subscribe" [checked] [focused] [ref=e3]
    - button "Delete…" [ref=e4]
    - text "Deleting" [ref=e6]
  - text "status" [ref=e20]`;
  const diff = diffSnapshots(withDialog, closed);
  assert.equal(diff.removed, 3);
  assert.equal(diff.text, '- alert "Question" [modal] [ref=e7]');
});

test('focus moving around is not a change', () => {
  const focusedA = '- button "A" [focused] [ref=e1]\n- button "B" [ref=e2]';
  const focusedB = '- button "A" [ref=e1]\n- button "B" [focused] [ref=e2]';
  assert.equal(diffSnapshots(focusedA, focusedB).text, '');
});

test('identical snapshots have no changes', () => {
  const diff = diffSnapshots(before, before);
  assert.equal(diff.text, '');
  assert.equal(diff.added + diff.removed + diff.changed, 0);
});

test('long diffs are capped', () => {
  const many = Array.from({ length: 100 }, (_, i) => `- button "B${i}" [ref=e${i + 100}]`).join('\n');
  const diff = diffSnapshots('', many, 10);
  assert.equal(diff.added, 100);
  assert.match(diff.text, /… and 90 more changes$/);
});
