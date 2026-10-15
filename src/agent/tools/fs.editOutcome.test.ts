import { describe, it, expect, vi, afterEach } from 'vitest';
import { workspace } from 'vscode';
import { editFile } from './fs.js';

// #160: edit_file's success reports. Each case is the minimal failing case
// from the October investigation, inverted.

function mount(text: string) {
  vi.spyOn(workspace.fs, 'readFile').mockResolvedValue(Buffer.from(text) as never);
  return vi.spyOn(workspace.fs, 'writeFile').mockResolvedValue(undefined as never);
}
const written = (write: ReturnType<typeof mount>): string =>
  Buffer.from(write.mock.calls[0][1] as Uint8Array).toString();
const ctx = (path: string, extra: Record<string, unknown> = {}) =>
  ({ config: { agentMode: 'agent' }, filesReadThisTurn: new Set([path]), ...extra }) as never;

afterEach(() => vi.restoreAllMocks());

describe('ML-05: an edit that changes nothing writes nothing and says so', () => {
  it('a replace equal to the text the indent tier matched is "No change needed", not "File edited"', async () => {
    const file = 'class Formset:\r\n@cached_property\r\ndef management_form(self):\r\n    return 1\r\n';
    const write = mount(file);
    const result = await editFile(
      {
        path: 'runtests.py',
        search: '    @cached_property\n    def management_form(self):',
        replace: '@cached_property\ndef management_form(self):',
      },
      ctx('runtests.py'),
    );
    expect(write).not.toHaveBeenCalled();
    expect(String(result)).toMatch(/^No change needed: runtests\.py already has this text[\s\S]*nothing was written/);
  });
});

describe('ML-04: a restated block body is trimmed even when the duplicate would parse', () => {
  const FIELDS = [
    'class Field:',
    '    def check(self):',
    '        return []',
    '',
    '    def _check_name(self):',
    '        import keyword',
    '        return []',
    '',
  ].join('\n');

  it('Python: the new method is inserted once, and _check_name keeps one body', async () => {
    const write = mount(FIELDS);
    const result = await editFile(
      {
        path: 'fields.py',
        search: '    def _check_name(self):',
        replace:
          '    def _check_choices(self):\n        return []\n\n' +
          '    def _check_name(self):\n        import keyword\n        return []',
      },
      ctx('fields.py'),
    );
    const out = written(write);
    expect(out.match(/import keyword/g)).toHaveLength(1);
    expect(out).toContain('    def _check_choices(self):\n        return []\n\n    def _check_name(self):\n');
    expect(String(result)).toContain('The redundant tail was trimmed');
  });

  it('an unparsed file (.rst) keeps the old rule: written as sent', async () => {
    const rst = '.. note::\n\n   Old text.\n\n.. end\n';
    const write = mount(rst);
    await editFile(
      { path: 'doc.rst', search: '.. note::', replace: '.. warning::\n\n   New.\n\n.. note::\n\n   Old text.' },
      ctx('doc.rst'),
    );
    expect(written(write).match(/Old text\./g)).toHaveLength(2);
  });
});

describe('ML-06: "already applied" needs the replacement to be in the file', () => {
  const INVOICE = [
    'def invoice(items):',
    '    subtotal = sum(i.price for i in items)',
    '    tax = round(subtotal * 0.2, 2)',
    '    return subtotal + tax',
    '',
  ].join('\n');

  it('a misremembered identifier is not answered "applied earlier" when the replacement is nowhere in the file', async () => {
    const write = mount(INVOICE);
    const outcome = await editFile(
      {
        path: 'invoice.py',
        search: '    sub_total = sum(i.price for i in items)',
        replace: '    subtotal = round(sum(i.price for i in items), 2)',
      },
      ctx('invoice.py'),
    ).then(
      (r) => String(r),
      (e: Error) => e.message,
    );
    expect(outcome).not.toContain('No change needed');
    expect(outcome).not.toContain('applied earlier');
    // Whatever recovery does, it must not be the false all-clear.
    if (write.mock.calls.length > 0) expect(written(write)).toContain('round(sum(');
  });

  it('a rename that really landed is still "No change needed"', async () => {
    const write = mount(INVOICE);
    const result = await editFile(
      {
        path: 'invoice.py',
        search: '    sub_total = sum(i.price for i in items)',
        replace: '    subtotal = sum(i.price for i in items)',
      },
      ctx('invoice.py'),
    );
    expect(write).not.toHaveBeenCalled();
    expect(String(result)).toContain('No change needed');
  });
});

describe('ML-73: repeating an applied edit escalates', () => {
  const FILE = 'x = 2\ny = 3\n';
  const edit = { path: 'a.py', search: 'x = 1', replace: 'x = 2' };

  it('the second identical resend says it is a repeat; a real write resets the count', async () => {
    const signatures = new Map<string, string>();
    const context = ctx('a.py', { editFailureSignatures: signatures });
    mount(FILE);
    const first = String(await editFile(edit, context));
    const second = String(await editFile(edit, context));
    expect(first).toContain('No change needed');
    expect(first).not.toContain('times');
    expect(second).toContain('You have now sent this same edit 2 times');

    vi.restoreAllMocks();
    mount(FILE);
    await editFile({ path: 'a.py', search: 'y = 3', replace: 'y = 4' }, context);
    vi.restoreAllMocks();
    mount(FILE);
    expect(String(await editFile(edit, context))).not.toContain('times');
  });
});
