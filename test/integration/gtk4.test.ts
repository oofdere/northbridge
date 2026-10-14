// GTK 4 behaves differently from GTK 3: its own AT-SPI implementation, window-relative
// coordinates, and buttons that activate 250ms after an accessibility click.
import { execFileSync } from 'node:child_process';
import { after, before, test } from 'node:test';
import { type App, connect, type Desktop, expect } from '../../src/index.ts';
import './fixture.ts';

const hasCalculator = (() => {
  try {
    execFileSync('which', ['gnome-calculator'], { stdio: 'ignore' });
    return true;
  } catch {
    return false;
  }
})();

let desktop: Desktop;
let calc: App;

before(async () => {
  if (!hasCalculator) return;
  desktop = await connect();
  calc = await desktop.launch('gnome-calculator');
});

after(async () => {
  await desktop?.close();
});

const display = () => calc.getByRole('textbox').first();

test('buttons through accessibility actions', { skip: !hasCalculator && 'gnome-calculator not installed' }, async () => {
  await calc.getByRole('button', { name: 'C' }).click();
  for (const key of ['7', '+', '8', '=']) await calc.getByRole('button', { name: key }).click();
  await expect(display()).toHaveText('15');
});

test('keyboard right after a click is not overtaken by it', { skip: !hasCalculator && 'gnome-calculator not installed' }, async () => {
  await calc.getByRole('button', { name: 'C' }).click();
  await display().type('12*3');
  await display().press('Enter');
  await expect(display()).toHaveText('36');
});

test('mouse clicks land on GTK 4 widgets', { skip: !hasCalculator && 'gnome-calculator not installed' }, async () => {
  await calc.getByRole('button', { name: 'C' }).click({ method: 'mouse' });
  for (const key of ['6', '×', '7', '=']) await calc.getByRole('button', { name: key }).click({ method: 'mouse' });
  await expect(display()).toHaveText('42');
});

test('history shows up in the snapshot', { skip: !hasCalculator && 'gnome-calculator not installed' }, async () => {
  await expect(calc.getByRole('list').getByText('6×7')).toBeVisible();
});
