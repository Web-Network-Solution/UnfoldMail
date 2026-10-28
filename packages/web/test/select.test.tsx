import { afterEach, beforeAll, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { useState } from 'react';
import Select, { SelectOption } from '../src/components/ui/Select';

beforeAll(() => {
  HTMLElement.prototype.scrollIntoView = vi.fn();
  HTMLElement.prototype.hasPointerCapture = () => false;
  HTMLElement.prototype.releasePointerCapture = vi.fn();
});
afterEach(cleanup);
function Field({ disabled = false, onChange = vi.fn() }) {
  const [value, setValue] = useState('');
  return <Select aria-label="Move to folder" name="folder" value={value} disabled={disabled} onValueChange={v => { setValue(v); onChange(v); }}>
    <SelectOption value="">Keep current folder</SelectOption>
    <SelectOption value="archive">Archive</SelectOption>
    <SelectOption value="unavailable" disabled>Unavailable</SelectOption>
    <SelectOption value="projects">Projects</SelectOption>
  </Select>;
}
async function open() {
  fireEvent.keyDown(screen.getByRole('combobox'), { key: 'ArrowDown' });
  return screen.findByRole('listbox');
}
it('changes a controlled value and allows returning to the empty option', async () => {
  const change = vi.fn(); render(<form><Field onChange={change}/></form>);
  await open(); fireEvent.click(screen.getByRole('option', { name: 'Archive' }));
  expect(change).toHaveBeenLastCalledWith('archive');
  expect((document.querySelector('input[name="folder"]') as HTMLInputElement).value).toBe('archive');
  await open(); fireEvent.click(screen.getByRole('option', { name: 'Keep current folder' }));
  expect(change).toHaveBeenLastCalledWith('');
});
it('does not submit its enclosing form and restores focus after Escape', async () => {
  const submit = vi.fn(); render(<form onSubmit={submit}><Field/></form>);
  await open(); fireEvent.keyDown(screen.getByRole('listbox'), { key: 'Escape' });
  await waitFor(() => expect(screen.queryByRole('listbox')).toBeNull());
  await waitFor(() => expect(document.activeElement).toBe(screen.getByRole('combobox')));
  expect(submit).not.toHaveBeenCalled();
});
it('portals options inside the enclosing dialog and isolates Escape', async () => {
  const escape = vi.fn(); render(<div role="dialog" onKeyDown={escape}><Field/></div>);
  const list = await open(); expect(screen.getByRole('dialog').contains(list)).toBe(true);
  escape.mockClear(); fireEvent.keyDown(list, { key: 'Escape' });
  expect(escape).not.toHaveBeenCalled();
});
it('keeps unavailable choices disabled', async () => {
  const change = vi.fn(); render(<Field onChange={change}/>); await open();
  const item = screen.getByRole('option', { name: 'Unavailable' });
  expect(item.getAttribute('aria-disabled')).toBe('true'); fireEvent.click(item);
  expect(change).not.toHaveBeenCalled();
});
it('supports numeric option values without changing the callback contract', async () => {
  const change = vi.fn(); render(<Select aria-label="Reminder" value={0} onValueChange={change}><SelectOption value={0}>At start</SelectOption><SelectOption value={15}>15 minutes before</SelectOption></Select>);
  await open(); fireEvent.click(screen.getByRole('option', { name: '15 minutes before' }));
  expect(change).toHaveBeenCalledWith('15');
});
it('keeps disabled fields out of interaction', () => {
  render(<Field disabled/>); expect((screen.getByRole('combobox') as HTMLButtonElement).disabled).toBe(true);
});
