// Without input synthesis (as on Wayland today), everything goes through accessibility actions.
import assert from 'node:assert/strict';
import { after, before, test } from 'node:test';
import { type App, connect, type Desktop, expect, NotSupportedError } from '../../src/index.ts';
import { GTK3_FIXTURE, PYTHON } from './fixture.ts';

let desktop: Desktop;
let app: App;

before(async () => {
  desktop = await connect({ input: false });
  app = await desktop.launch([PYTHON, GTK3_FIXTURE]);
});

after(async () => {
  await desktop?.close();
});

test('forms work with accessibility actions alone', async () => {
  assert.equal(desktop.hasInput(), false);
  await app.getByLabel('Name').fill('Ada');
  await app.getByLabel('Name').type(' Lovelace');
  await app.getByRole('checkbox', { name: 'Subscribe to newsletter' }).check();
  await app.getByRole('radio', { name: 'Small' }).check();
  await app.getByLabel('Color').selectOption('Green');
  await app.getById('submit').click();
  await expect(app.getById('status')).toContainText('name=Ada Lovelace; email=; password=; subscribe=yes; size=Small; color=Green');
});

test('menus and tabs', async () => {
  await app.getByRole('menu', { name: 'File' }).click();
  await app.getByRole('menuitem', { name: 'New' }).click();
  await expect(app.getById('status')).toHaveText('Menu: New');
  await app.getByRole('tab', { name: 'List' }).click();
  await app.getByRole('cell', { name: 'Dates' }).click();
  await expect(app.getById('status')).toHaveText('Selected: Dates');
  await app.getByRole('tab', { name: 'Form' }).click();
});

test('keyboard-only operations say why they cannot run', async () => {
  await assert.rejects(desktop.keyboard.press('Tab'), (err: Error) => err instanceof NotSupportedError && /no input synthesis/.test(err.message));
  await assert.rejects(desktop.screenshot(), NotSupportedError);
});
