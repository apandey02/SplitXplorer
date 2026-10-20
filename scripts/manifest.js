// Regenerates the per-slot parts of package.json `contributes`: `npm run manifest`.
// VS Code views must be declared up front, so SplitXplorer declares SLOTS views and
// shows each one only while its `splitXplorer.slotN` context key is true.
const fs = require('fs');
const path = require('path');

const SLOTS = 12; // keep in sync with src/extension.ts
const file = path.join(__dirname, '..', 'package.json');
const pkg = JSON.parse(fs.readFileSync(file, 'utf8'));
const slots = [...Array(SLOTS).keys()].map((i) => i + 1);
const SECTION_VIEW = 'view =~ /^splitXplorer\\.section\\d+$/';

const perSlotCommands = [
  { id: 'rename', title: 'Rename Section', icon: '$(edit)', group: '1_section@1' },
  { id: 'editRules', title: 'Edit Section Rules', icon: '$(list-filter)', group: '1_section@2' },
  { id: 'addFiles', title: 'Add Files or Folders to Section', icon: '$(file-add)', group: '1_section@3' },
  { id: 'remove', title: 'Remove Section', icon: '$(trash)', group: '9_remove@1' },
];

const commands = [
  { command: 'splitXplorer.addSection', title: 'Add Section', category: 'SplitXplorer', icon: '$(add)' },
  { command: 'splitXplorer.renameSection', title: 'Rename Section', category: 'SplitXplorer' },
  { command: 'splitXplorer.editSectionRules', title: 'Edit Section Rules', category: 'SplitXplorer' },
  { command: 'splitXplorer.removeSection', title: 'Remove Section', category: 'SplitXplorer' },
  { command: 'splitXplorer.refresh', title: 'Refresh', category: 'SplitXplorer', icon: '$(refresh)' },
  {
    command: 'splitXplorer.toggleBuiltInExclude',
    title: 'Toggle Hiding Gitignored Files in Built-in Explorer',
    category: 'SplitXplorer',
    icon: '$(eye)',
  },
  { command: 'splitXplorer.moveToSection', title: 'Move to Section...', category: 'SplitXplorer' },
  { command: 'splitXplorer.addToSection', title: 'Also Show in Section...', category: 'SplitXplorer' },
  { command: 'splitXplorer.removeFromSection', title: 'Remove from This Section', category: 'SplitXplorer' },
  { command: 'splitXplorer.showInSection', title: 'Show in SplitXplorer Section...', category: 'SplitXplorer' },
  { command: 'splitXplorer.revealInExplorer', title: 'Reveal in Explorer View', category: 'SplitXplorer' },
  { command: 'splitXplorer.revealInOS', title: 'Reveal in File Explorer', category: 'SplitXplorer' },
  { command: 'splitXplorer.copyPath', title: 'Copy Path', category: 'SplitXplorer' },
  ...slots.flatMap((n) =>
    perSlotCommands.map((c) => ({
      command: `splitXplorer.${c.id}.${n}`,
      title: c.title,
      category: 'SplitXplorer',
      icon: c.icon,
    }))
  ),
];

// VS Code lists views by these static names in the Explorer's right-click menu (runtime
// titles don't reach it), so slots 1 and 2 carry the default sections' names.
const SLOT_NAMES = { 1: 'Gitacknowledged', 2: 'Gitignored' }; // keep in sync with DEFAULT_SECTIONS

pkg.contributes.views = {
  explorer: slots.map((n) => ({
    id: `splitXplorer.section${n}`,
    name: SLOT_NAMES[n] ?? `Custom Section ${n - 2}`,
    when: `splitXplorer.slot${n}`,
  })),
};

pkg.contributes.commands = commands;

pkg.contributes.menus = {
  'view/title': [
    { command: 'splitXplorer.addSection', when: SECTION_VIEW, group: 'navigation@1' },
    { command: 'splitXplorer.refresh', when: SECTION_VIEW, group: 'navigation@2' },
    ...slots.flatMap((n) =>
      perSlotCommands.map((c) => ({
        command: `splitXplorer.${c.id}.${n}`,
        when: `view == splitXplorer.section${n}`,
        group: c.group,
      }))
    ),
    { command: 'splitXplorer.toggleBuiltInExclude', when: SECTION_VIEW, group: '5_builtin@1' },
  ],
  'view/item/context': [
    { command: 'splitXplorer.moveToSection', when: SECTION_VIEW, group: '1_section@1' },
    { command: 'splitXplorer.addToSection', when: SECTION_VIEW, group: '1_section@2' },
    { command: 'splitXplorer.removeFromSection', when: SECTION_VIEW, group: '1_section@3' },
    { command: 'splitXplorer.revealInExplorer', when: SECTION_VIEW, group: 'navigation@1' },
    { command: 'splitXplorer.revealInOS', when: SECTION_VIEW, group: 'navigation@2' },
    { command: 'splitXplorer.copyPath', when: SECTION_VIEW, group: '6_copypath@1' },
  ],
  'explorer/context': [{ command: 'splitXplorer.showInSection', group: '7_splitxplorer@1' }],
  commandPalette: [
    ...[
      'moveToSection',
      'addToSection',
      'removeFromSection',
      'showInSection',
      'revealInExplorer',
      'revealInOS',
      'copyPath',
    ].map((id) => ({ command: `splitXplorer.${id}`, when: 'false' })),
    ...slots.flatMap((n) => perSlotCommands.map((c) => ({ command: `splitXplorer.${c.id}.${n}`, when: 'false' }))),
  ],
};

fs.writeFileSync(file, JSON.stringify(pkg, null, 2) + '\n');
console.log(`manifest: wrote ${SLOTS} section slots`);
