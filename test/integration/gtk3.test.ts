import assert from 'node:assert/strict';
import { afterEach, beforeEach, describe, test } from 'node:test';
import { type App, type Desktop, expect, StrictModeError, TimeoutError } from '../../src/index.ts';
import { launchFixture } from './fixture.ts';

let desktop: Desktop;
let app: App;

beforeEach(async () => {
  ({ desktop, app } = await launchFixture());
});

afterEach(async () => {
  await desktop?.close();
});

const status = () => app.getById('status');

describe('reading', () => {
  test('snapshot shows the form with labels resolved and ids', async () => {
    const snapshot = await app.snapshot();
    assert.match(snapshot, /- window "Northbridge Fixture" \[ref=e\d+\]:/);
    assert.match(snapshot, /- textbox "Name" \[id="name-field"\] \[ref=e\d+\]/);
    assert.match(snapshot, /- textbox "Password" \[protected\]/);
    assert.match(snapshot, /- radio "Medium" \[checked\]/);
    assert.match(snapshot, /- button "Unavailable" \[disabled\]/);
    assert.match(snapshot, /- spinbutton "Quantity" \[ref=e\d+\]: 1/);
    assert.match(snapshot, /- slider "Volume" \[ref=e\d+\]: 50/);
    assert.match(snapshot, /- text "Ready" \[id="status"\]/);
    // hidden tab contents and closed menus stay out of the way
    assert.doesNotMatch(snapshot, /Apples|Word Wrap/);
  });

  test('refs from a snapshot address elements', async () => {
    const snapshot = await app.snapshot();
    const ref = /- button "Submit" \[id="submit"\] \[ref=(e\d+)\]/.exec(snapshot)?.[1];
    assert.ok(ref);
    await desktop.element(ref).click();
    await expect(status()).toHaveText(/^Submitted:/);
    await app.locator(`@${ref}`).click();
    await app.locator(`- button "Submit" [ref=${ref}]`).click();
  });

  test('reads names, text, values and states', async () => {
    await expect(status()).toHaveText('Ready');
    assert.equal(await app.getByLabel('Quantity').role(), 'spinbutton');
    assert.equal((await app.getByRole('slider', { name: 'Volume' }).value())?.current, 50);
    assert.equal(await app.getByRole('radio', { name: 'Medium' }).isChecked(), true);
    assert.equal(await app.getByRole('button', { name: 'Unavailable' }).isEnabled(), false);
    assert.deepEqual(await app.getByRole('radio').count(), 3);
  });
});

describe('forms', () => {
  test('fill, check, choose and submit', async () => {
    await app.getByLabel('Name').fill('Ada Lovelace');
    await app.getByRole('textbox', { name: 'Email' }).fill('ada@example.com');
    await app.locator('textbox "Password"').fill('hunter2');
    await app.getByRole('checkbox', { name: 'Subscribe to newsletter' }).check();
    await app.getByRole('radio', { name: 'Large' }).check();
    await app.getByLabel('Color').selectOption('Blue');
    await app.getByRole('spinbutton', { name: 'Quantity' }).setValue(5);
    await app.getByRole('slider', { name: 'Volume' }).setValue(80);
    await app.getByRole('button', { name: 'Dark mode' }).click();
    await app.getById('submit').click();
    await expect(status()).toHaveText(
      'Submitted: name=Ada Lovelace; email=ada@example.com; password=*******; subscribe=yes; size=Large; ' +
        'color=Blue; quantity=5; volume=80; dark=on',
    );
    await expect(app.getByRole('checkbox', { name: 'Subscribe to newsletter' })).toBeChecked();
    await expect(app.getByRole('radio', { name: 'Medium' })).not.toBeChecked();
  });

  test('fill on a spin button sets its value', async () => {
    await app.getByLabel('Quantity').fill('42');
    await expect(app.getByLabel('Quantity')).toHaveValue(42);
  });

  test('typing goes through the keyboard', async () => {
    const name = app.getByLabel('Name');
    await name.fill('Grace');
    await name.type(' Hopper ✓');
    await expect(name).toHaveText('Grace Hopper ✓');
    await name.press('Control+a');
    await name.press('Backspace');
    await expect(name).toHaveText('');
  });

  test('uncheck and toggles', async () => {
    const box = app.getByRole('checkbox', { name: 'Subscribe to newsletter' });
    await box.check();
    await expect(box).toBeChecked();
    await box.uncheck();
    await expect(box).not.toBeChecked();
    await box.setChecked(true);
    await expect(box).toBeChecked();
  });
});

describe('waiting and strictness', () => {
  test('actions wait for elements that show up later', async () => {
    await app.getByRole('button', { name: 'Load later' }).click();
    await expect(status()).toHaveText('Loading…');
    await app.getByText('Loaded 3 items').waitFor();
    await expect(status()).toHaveText('Loaded');
  });

  test('disabled elements make actions time out with a reason', async () => {
    await assert.rejects(app.getByRole('button', { name: 'Unavailable' }).click({ timeout: 300 }), (err: Error) => {
      assert.ok(err instanceof TimeoutError);
      assert.match(err.message, /is disabled/);
      return true;
    });
  });

  test('ambiguous locators refuse to guess and list the candidates', async () => {
    await assert.rejects(app.getByRole('radio').click(), (err: Error) => {
      assert.ok(err instanceof StrictModeError);
      assert.equal(err.matches.length, 3);
      assert.match(err.message, /radio "Small" \[ref=e\d+\]/);
      return true;
    });
    await app.getByRole('radio').first().check();
    await expect(app.getByRole('radio', { name: 'Small' })).toBeChecked();
  });

  test('misses suggest what is there', async () => {
    await assert.rejects(app.getByRole('button', { name: 'Submt' }).click({ timeout: 200 }), /Similar elements:\n {2}- button "Submit"/);
  });
});

describe('tabs, lists, menus and dialogs', () => {
  test('switch tabs and pick rows', async () => {
    await app.getByRole('tab', { name: 'List' }).click();
    await expect(app.getByRole('tab', { name: 'List' })).toBeSelected();
    await app.getByRole('cell', { name: 'Bananas' }).click();
    await expect(status()).toHaveText('Selected: Bananas');
    await app.getByRole('cell', { name: 'Cherries' }).dblclick();
    await expect(status()).toHaveText('Opened: Cherries');
    await app.getByText('Oslo').click();
    await expect(status()).toHaveText('City: Oslo');
  });

  test('menus open and items activate', async () => {
    await app.getByRole('menu', { name: 'File' }).click();
    await app.getByRole('menuitem', { name: 'Save' }).click();
    await expect(status()).toHaveText('Menu: Save');
    await app.getByRole('menu', { name: 'View' }).click();
    await app.getByRole('menuitemcheckbox', { name: 'Word Wrap' }).click();
    await expect(status()).toHaveText('Word Wrap: on');
  });

  test('modal dialogs stay reachable', async () => {
    // The click handler runs gtk_dialog_run(); a real click keeps the app answering meanwhile.
    await app.getByRole('button', { name: 'Delete…' }).click();
    const dialog = app.getByRole('alert');
    await expect(dialog.getByText('Delete everything?')).toBeVisible();
    await expect(dialog).toHaveState('modal');
    await dialog.getByRole('button', { name: 'Delete' }).click();
    await expect(status()).toHaveText('Deleted');
    await expect(dialog).toHaveCount(0);
  });

  test('multi-line text', async () => {
    await app.getByRole('tab', { name: 'Notes' }).click();
    const notes = app.getById('notes');
    await expect(notes).toHaveText('First line\nSecond line');
    await notes.fill('Replaced');
    await expect(notes).toHaveText('Replaced');
  });
});

describe('mouse and screen', () => {
  test('real mouse clicks', async () => {
    await app.getByRole('checkbox', { name: 'Subscribe to newsletter' }).click({ method: 'mouse' });
    await expect(app.getByRole('checkbox', { name: 'Subscribe to newsletter' })).toBeChecked();
    await app.getById('submit').click({ method: 'mouse' });
    await expect(status()).toContainText('subscribe=yes');
  });

  test('screenshots', async () => {
    const png = await app.window().screenshot();
    assert.equal(png.subarray(1, 4).toString(), 'PNG');
    assert.ok(png.length > 1000);
  });
});
