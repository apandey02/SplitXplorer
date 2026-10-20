import * as vscode from 'vscode';
import { GitIgnoreIndex } from './gitIndex';
import {
  PathSet,
  SectionConfig,
  SectionKind,
  isVisible,
  pathKey,
  withoutAtOrBelow,
} from './rules';

/** Number of view slots pre-declared in package.json (keep in sync with scripts/manifest.js). */
const SLOTS = 12;
const STATE_KEY = 'splitXplorer.sections';
const NODE_MIME = 'application/vnd.code.tree.splitxplorer';
const URI_MIME = 'text/uri-list';

const viewId = (slot: number) => `splitXplorer.section${slot}`;
const keyOf = (uri: vscode.Uri) => pathKey(`${uri.scheme}://${uri.authority}${uri.path}`);
const keyOfString = (s: string) => keyOf(vscode.Uri.parse(s));

const KINDS: { kind: SectionKind; label: string; detail: string }[] = [
  { kind: 'acknowledged', label: 'Gitacknowledged', detail: 'Files git does not ignore' },
  { kind: 'ignored', label: 'Gitignored', detail: 'Files and folders matched by .gitignore' },
  { kind: 'custom', label: 'Blank', detail: 'Starts empty: drag files in or add glob rules' },
  { kind: 'all', label: 'All Files', detail: 'Everything in the workspace, like the built-in Explorer' },
];

const DEFAULT_SECTIONS: SectionConfig[] = [
  { slot: 1, kind: 'acknowledged', name: 'Gitacknowledged', include: [], exclude: [], globs: [] },
  { slot: 2, kind: 'ignored', name: 'Gitignored', include: [], exclude: [], globs: [] },
];

interface Node {
  uri: vscode.Uri;
  isDir: boolean;
  /** This entry or one of its ancestors is gitignored. */
  ignored: boolean;
  index: GitIgnoreIndex;
  slot: number;
  isWorkspaceRoot?: boolean;
}

/** Holds one GitIgnoreIndex per workspace folder and rebuilds them when files change. */
class Model implements vscode.Disposable {
  private indexes = new Map<string, GitIgnoreIndex>();
  private timer: NodeJS.Timeout | undefined;
  private readonly emitter = new vscode.EventEmitter<void>();
  readonly onDidChange = this.emitter.event;

  async refresh(): Promise<void> {
    const next = new Map<string, GitIgnoreIndex>();
    for (const folder of vscode.workspace.workspaceFolders ?? []) {
      try {
        next.set(folder.uri.toString(), await GitIgnoreIndex.load(folder.uri.fsPath));
      } catch (err) {
        console.error(`[splitxplorer] failed to index ${folder.uri.fsPath}`, err);
        next.set(folder.uri.toString(), GitIgnoreIndex.empty());
      }
    }
    this.indexes = next;
    this.emitter.fire();
  }

  scheduleRefresh(): void {
    clearTimeout(this.timer);
    this.timer = setTimeout(() => void this.refresh(), 400);
  }

  private indexOf(folder: vscode.WorkspaceFolder): GitIgnoreIndex {
    return this.indexes.get(folder.uri.toString()) ?? GitIgnoreIndex.empty();
  }

  roots(slot: number): Node[] {
    return (vscode.workspace.workspaceFolders ?? []).map((folder) => ({
      uri: folder.uri,
      isDir: true,
      ignored: false,
      index: this.indexOf(folder),
      slot,
      isWorkspaceRoot: true,
    }));
  }

  /** Builds a node for any workspace path, for checking visibility outside a tree walk. */
  async nodeFor(uri: vscode.Uri, slot: number): Promise<Node | undefined> {
    const folder = vscode.workspace.getWorkspaceFolder(uri);
    if (!folder) return undefined;
    let isDir = false;
    try {
      isDir = ((await vscode.workspace.fs.stat(uri)).type & vscode.FileType.Directory) !== 0;
    } catch {
      return undefined;
    }
    const index = this.indexOf(folder);
    const rootKey = keyOf(folder.uri);
    let ignored = false;
    for (let u = uri; keyOf(u) !== rootKey && keyOf(u).length > rootKey.length; u = vscode.Uri.joinPath(u, '..')) {
      if (index.isIgnored(u.fsPath)) {
        ignored = true;
        break;
      }
    }
    return { uri, isDir, ignored, index, slot, isWorkspaceRoot: keyOf(uri) === rootKey };
  }

  dispose(): void {
    clearTimeout(this.timer);
    this.emitter.dispose();
  }
}

/** One Explorer section: its saved config, derived rule sets, and its tree view. */
class Section implements vscode.TreeDataProvider<Node>, vscode.TreeDragAndDropController<Node> {
  readonly dragMimeTypes = [NODE_MIME, URI_MIME];
  readonly dropMimeTypes = [NODE_MIME, URI_MIME];

  private readonly emitter = new vscode.EventEmitter<void>();
  readonly onDidChangeTreeData = this.emitter.event;
  readonly view: vscode.TreeView<Node>;

  private includeSet = new PathSet();
  private excludeSet = new PathSet();
  private globMatches = new PathSet();

  constructor(
    public config: SectionConfig,
    private readonly model: Model,
    private readonly manager: SectionManager
  ) {
    this.view = vscode.window.createTreeView(viewId(config.slot), {
      treeDataProvider: this,
      dragAndDropController: this,
      showCollapseAll: true,
      canSelectMany: true,
    });
    this.apply(config);
  }

  /** Re-derives everything from a (possibly edited) config and redraws. */
  apply(config: SectionConfig): void {
    this.config = config;
    this.view.title = config.name;
    this.includeSet = new PathSet(config.include.map(keyOfString));
    this.excludeSet = new PathSet(config.exclude.map(keyOfString));
    void this.reload();
  }

  /** Recomputes glob matches (custom sections) and redraws. */
  async reload(): Promise<void> {
    if (this.config.kind === 'custom') this.globMatches = await this.matchGlobs();
    this.updateMessage();
    this.emitter.fire();
  }

  private async matchGlobs(): Promise<PathSet> {
    const set = new PathSet();
    for (const folder of vscode.workspace.workspaceFolders ?? []) {
      for (const glob of this.config.globs) {
        // The second pattern catches globs that name folders, which findFiles never returns.
        for (const pattern of [glob, `${glob.replace(/\/+$/, '')}/**`]) {
          const found = await vscode.workspace.findFiles(new vscode.RelativePattern(folder, pattern), undefined, 5000);
          for (const uri of found) set.add(keyOf(uri));
        }
      }
    }
    return set;
  }

  private updateMessage(): void {
    const roots = this.model.roots(this.config.slot);
    const c = this.config;
    if (c.kind === 'ignored' && roots.length > 0 && roots.every((r) => !r.index.isRepo)) {
      this.view.message = 'No git repository found in this workspace.';
    } else if (c.kind === 'custom' && c.include.length === 0 && c.globs.length === 0) {
      this.view.message = 'Drag files or folders here, or use Edit Section Rules to add glob patterns.';
    } else {
      this.view.message = undefined;
    }
  }

  refresh(): void {
    this.emitter.fire();
  }

  private base(node: Node, key: string): boolean {
    switch (this.config.kind) {
      case 'acknowledged':
        return !node.ignored;
      case 'ignored':
        return node.ignored || (node.isDir && node.index.containsIgnored(node.uri.fsPath));
      case 'all':
        return true;
      case 'custom':
        return this.globMatches.covers(key) || this.globMatches.hasBelow(key);
    }
  }

  shows(node: Node): boolean {
    const key = keyOf(node.uri);
    return isVisible(key, node.isDir, this.base(node, key), this.includeSet, this.excludeSet);
  }

  getTreeItem(node: Node): vscode.TreeItem {
    const item = new vscode.TreeItem(
      node.uri,
      node.isDir ? vscode.TreeItemCollapsibleState.Collapsed : vscode.TreeItemCollapsibleState.None
    );
    // Stable ids keep folders expanded across refreshes.
    item.id = `${node.slot}:${node.uri.toString()}`;
    item.contextValue = node.isDir ? 'folder' : 'file';
    if (!node.isDir) {
      item.command = { command: 'vscode.open', title: 'Open', arguments: [node.uri] };
    }
    if (this.config.kind === 'ignored' && node.isDir && !node.ignored && !node.isWorkspaceRoot) {
      item.description = 'contains ignored';
    }
    return item;
  }

  async getChildren(parent?: Node): Promise<Node[]> {
    if (!parent) {
      const roots = this.model.roots(this.config.slot);
      // Single-folder workspace: skip the redundant root node, like the built-in Explorer.
      return roots.length === 1 ? this.childrenOf(roots[0]) : roots;
    }
    return this.childrenOf(parent);
  }

  private async childrenOf(dir: Node): Promise<Node[]> {
    let entries: [string, vscode.FileType][];
    try {
      entries = await vscode.workspace.fs.readDirectory(dir.uri);
    } catch {
      return [];
    }

    const nodes: Node[] = [];
    for (const [name, type] of entries) {
      if (name === '.git') continue;
      const uri = vscode.Uri.joinPath(dir.uri, name);
      const isDir = (type & vscode.FileType.Directory) !== 0;
      const ignored = dir.ignored || dir.index.isIgnored(uri.fsPath);
      const node: Node = { uri, isDir, ignored, index: dir.index, slot: this.config.slot };
      if (this.shows(node)) nodes.push(node);
    }

    return nodes.sort(
      (a, b) =>
        Number(b.isDir) - Number(a.isDir) ||
        a.uri.path.localeCompare(b.uri.path, undefined, { sensitivity: 'base', numeric: true })
    );
  }

  handleDrag(source: readonly Node[], data: vscode.DataTransfer): void {
    const uris = source.filter((n) => !n.isWorkspaceRoot).map((n) => n.uri.toString());
    data.set(NODE_MIME, new vscode.DataTransferItem({ from: this.config.slot, uris }));
    data.set(URI_MIME, new vscode.DataTransferItem(uris.join('\r\n')));
  }

  async handleDrop(_target: Node | undefined, data: vscode.DataTransfer): Promise<void> {
    const own = data.get(NODE_MIME)?.value as { from: number; uris: string[] } | undefined;
    if (own) {
      if (own.from === this.config.slot) return;
      const uris = own.uris.map((s) => vscode.Uri.parse(s));
      const move = vscode.workspace.getConfiguration('splitXplorer').get('dragBehavior', 'move') === 'move';
      await this.manager.assign(this.config.slot, uris, move ? own.from : undefined);
      return;
    }
    // Drops from the built-in Explorer or the editor arrive as a uri list.
    const list = await data.get(URI_MIME)?.asString();
    if (!list) return;
    const uris = list
      .split(/\r?\n/)
      .map((l) => l.trim())
      .filter((l) => l && !l.startsWith('#'))
      .map((l) => vscode.Uri.parse(l));
    await this.manager.assign(this.config.slot, uris);
  }

  dispose(): void {
    this.view.dispose();
    this.emitter.dispose();
  }
}

/** Creates, persists, and edits the sections shown in the Explorer. */
class SectionManager implements vscode.Disposable {
  private readonly sections = new Map<number, Section>();

  constructor(private readonly context: vscode.ExtensionContext, private readonly model: Model) {
    const saved = context.workspaceState.get<SectionConfig[]>(STATE_KEY) ?? DEFAULT_SECTIONS;
    for (const config of saved) {
      if (config.slot >= 1 && config.slot <= SLOTS) this.create({ ...DEFAULT_SECTIONS[0], ...config });
    }
    void this.syncContext();
    model.onDidChange(() => {
      for (const s of this.sections.values()) void s.reload();
    });
  }

  all(): Section[] {
    return [...this.sections.values()].sort((a, b) => a.config.slot - b.config.slot);
  }

  get(slot: number): Section | undefined {
    return this.sections.get(slot);
  }

  private create(config: SectionConfig): Section {
    const section = new Section(config, this.model, this);
    this.sections.set(config.slot, section);
    return section;
  }

  private async save(): Promise<void> {
    await this.context.workspaceState.update(
      STATE_KEY,
      this.all().map((s) => s.config)
    );
  }

  private async syncContext(): Promise<void> {
    for (let slot = 1; slot <= SLOTS; slot++) {
      await vscode.commands.executeCommand('setContext', `splitXplorer.slot${slot}`, this.sections.has(slot));
    }
  }

  private async update(slot: number, change: (c: SectionConfig) => SectionConfig): Promise<void> {
    const section = this.sections.get(slot);
    if (!section) return;
    section.apply(change(section.config));
    await this.save();
  }

  async add(): Promise<void> {
    const slot = [...Array(SLOTS).keys()].map((i) => i + 1).find((s) => !this.sections.has(s));
    if (slot === undefined) {
      vscode.window.showWarningMessage(`SplitXplorer supports up to ${SLOTS} sections. Remove one to add another.`);
      return;
    }
    const pick = await vscode.window.showQuickPick(
      KINDS.map((k) => ({ label: k.label, description: k.detail, sectionKind: k.kind })),
      { title: 'Add Explorer Section', placeHolder: 'Choose what the new section shows' }
    );
    if (!pick) return;
    const name = await vscode.window.showInputBox({
      title: 'Name the New Section',
      value: pick.sectionKind === 'custom' ? 'New Section' : pick.label,
      validateInput: (v) => (v.trim() ? undefined : 'Enter a name.'),
    });
    if (name === undefined) return;
    this.create({ slot, kind: pick.sectionKind, name: name.trim(), include: [], exclude: [], globs: [] });
    await this.save();
    await this.syncContext();
    await vscode.commands.executeCommand(`${viewId(slot)}.focus`);
  }

  async rename(slot: number): Promise<void> {
    const section = this.sections.get(slot);
    if (!section) return;
    const name = await vscode.window.showInputBox({
      title: 'Rename Section',
      value: section.config.name,
      validateInput: (v) => (v.trim() ? undefined : 'Enter a name.'),
    });
    if (name === undefined) return;
    await this.update(slot, (c) => ({ ...c, name: name.trim() }));
  }

  async remove(slot: number): Promise<void> {
    const section = this.sections.get(slot);
    if (!section) return;
    const answer = await vscode.window.showWarningMessage(
      `Remove the "${section.config.name}" section? Its rules will be deleted.`,
      { modal: true },
      'Remove'
    );
    if (answer !== 'Remove') return;
    section.dispose();
    this.sections.delete(slot);
    await this.save();
    await this.syncContext();
  }

  /**
   * Makes uris show in the target section. With `from`, also takes them out of that
   * section, so a drag between sections moves rather than copies.
   */
  async assign(slot: number, uris: vscode.Uri[], from?: number): Promise<void> {
    const target = this.sections.get(slot);
    if (!target) return;
    for (const uri of uris) {
      const key = keyOf(uri);
      await this.update(slot, (c) => ({ ...c, exclude: withoutAtOrBelow(c.exclude, key, keyOfString) }));
      const node = await this.model.nodeFor(uri, slot);
      if (!node || node.isWorkspaceRoot) continue;
      if (!target.shows(node)) {
        await this.update(slot, (c) => ({
          ...c,
          include: [...withoutAtOrBelow(c.include, key, keyOfString), uri.toString()],
        }));
      }
      if (from !== undefined) await this.unassign(from, [uri]);
    }
  }

  /** Hides uris from a section, dropping matching include rules first and excluding only if needed. */
  async unassign(slot: number, uris: vscode.Uri[]): Promise<void> {
    const section = this.sections.get(slot);
    if (!section) return;
    for (const uri of uris) {
      const key = keyOf(uri);
      await this.update(slot, (c) => ({ ...c, include: withoutAtOrBelow(c.include, key, keyOfString) }));
      const node = await this.model.nodeFor(uri, slot);
      if (!node || node.isWorkspaceRoot) continue;
      if (section.shows(node)) {
        await this.update(slot, (c) => ({
          ...c,
          exclude: [...withoutAtOrBelow(c.exclude, key, keyOfString), uri.toString()],
        }));
      }
    }
  }

  /** Quick-pick editor for a section's include, exclude, and glob rules. */
  async editRules(slot: number): Promise<void> {
    type RuleItem = vscode.QuickPickItem & { run: () => Promise<void> | void };
    const removeButton = { iconPath: new vscode.ThemeIcon('trash'), tooltip: 'Remove rule' };
    const rel = (s: string) => vscode.workspace.asRelativePath(vscode.Uri.parse(s));

    for (;;) {
      const section = this.sections.get(slot);
      if (!section) return;
      const c = section.config;
      const ruleItems = (list: 'include' | 'exclude' | 'globs', icon: string, label: (s: string) => string) =>
        c[list].map<RuleItem>((value) => ({
          label: `$(${icon}) ${label(value)}`,
          description: list === 'globs' ? 'glob' : list,
          buttons: [removeButton],
          run: () => this.update(slot, (cfg) => ({ ...cfg, [list]: cfg[list].filter((v) => v !== value) })),
        }));

      const items: (RuleItem | vscode.QuickPickItem)[] = [
        { label: '$(add) Add glob pattern...', run: () => this.addGlob(slot) } as RuleItem,
        { label: '$(file-add) Add files or folders...', run: () => this.pickAndAssign(slot) } as RuleItem,
        { label: 'Rules', kind: vscode.QuickPickItemKind.Separator },
        ...ruleItems('globs', 'symbol-misc', (s) => s),
        ...ruleItems('include', 'eye', rel),
        ...ruleItems('exclude', 'eye-closed', rel),
      ];

      const choice = await new Promise<RuleItem | undefined>((resolve) => {
        const qp = vscode.window.createQuickPick<RuleItem | vscode.QuickPickItem>();
        qp.title = `Rules for "${c.name}"`;
        qp.placeholder =
          c.kind === 'custom'
            ? 'Shows glob matches and included paths, minus excluded paths'
            : 'Included and excluded paths override what this section shows by default';
        qp.items = items;
        qp.onDidTriggerItemButton((e) => {
          resolve(e.item as RuleItem);
          qp.hide();
        });
        qp.onDidAccept(() => {
          const item = qp.selectedItems[0] as RuleItem | undefined;
          // Accepting a rule row does nothing; only its trash button removes it.
          resolve(item && !item.description ? item : undefined);
          qp.hide();
        });
        qp.onDidHide(() => {
          resolve(undefined);
          qp.dispose();
        });
        qp.show();
      });
      if (!choice) return;
      await choice.run();
    }
  }

  private async addGlob(slot: number): Promise<void> {
    const glob = await vscode.window.showInputBox({
      title: 'Add Glob Pattern',
      prompt: 'Relative to each workspace folder, for example src/**/*.ts or docs',
      validateInput: (v) => (v.trim() ? undefined : 'Enter a pattern.'),
    });
    if (!glob) return;
    const section = this.sections.get(slot);
    if (section && section.config.kind !== 'custom') {
      vscode.window.showInformationMessage('Glob patterns only apply to Blank sections; use included paths here instead.');
      return;
    }
    await this.update(slot, (c) => ({ ...c, globs: [...new Set([...c.globs, glob.trim()])] }));
  }

  async pickAndAssign(slot: number): Promise<void> {
    const uris = await vscode.window.showOpenDialog({
      canSelectFiles: true,
      canSelectFolders: true,
      canSelectMany: true,
      defaultUri: vscode.workspace.workspaceFolders?.[0]?.uri,
      openLabel: 'Add to Section',
    });
    if (uris) await this.assign(slot, uris);
  }

  /** Asks which section to use, for palette and context-menu commands that have no view. */
  async pickSection(title: string, except?: number): Promise<number | undefined> {
    const choices = this.all().filter((s) => s.config.slot !== except);
    if (choices.length === 0) return undefined;
    const pick = await vscode.window.showQuickPick(
      choices.map((s) => ({ label: s.config.name, description: KINDS.find((k) => k.kind === s.config.kind)?.label, slot: s.config.slot })),
      { title }
    );
    return pick?.slot;
  }

  refreshAll(): void {
    for (const s of this.sections.values()) s.refresh();
  }

  dispose(): void {
    for (const s of this.sections.values()) s.dispose();
  }
}

export function activate(context: vscode.ExtensionContext): void {
  const model = new Model();
  const sections = new SectionManager(context, model);

  // Any create/delete can change what's ignored; edits only matter for .gitignore files.
  const isInsideDotGit = (uri: vscode.Uri) => /\/\.git(\/|$)/.test(uri.path);
  const onFsEvent = (uri: vscode.Uri) => {
    if (!isInsideDotGit(uri)) model.scheduleRefresh();
  };
  const allFiles = vscode.workspace.createFileSystemWatcher('**/*', false, true, false);
  allFiles.onDidCreate(onFsEvent);
  allFiles.onDidDelete(onFsEvent);
  const ignoreFiles = vscode.workspace.createFileSystemWatcher('**/.gitignore');
  ignoreFiles.onDidChange(() => model.scheduleRefresh());

  /** Commands from item menus get the clicked node, plus every selected node. */
  const selection = (node: Node | undefined, all: Node[] | undefined) =>
    (all && all.length > 0 ? all : node ? [node] : []).filter((n) => !n.isWorkspaceRoot);

  const withSlot = (title: string, run: (slot: number) => Promise<void>) => async (slot?: number) => {
    const s = typeof slot === 'number' ? slot : await sections.pickSection(title);
    if (s !== undefined) await run(s);
  };

  const perSlot: vscode.Disposable[] = [];
  for (let slot = 1; slot <= SLOTS; slot++) {
    // View title menus pass no arguments, so each slot gets its own command ids.
    perSlot.push(
      vscode.commands.registerCommand(`splitXplorer.rename.${slot}`, () => sections.rename(slot)),
      vscode.commands.registerCommand(`splitXplorer.editRules.${slot}`, () => sections.editRules(slot)),
      vscode.commands.registerCommand(`splitXplorer.remove.${slot}`, () => sections.remove(slot)),
      vscode.commands.registerCommand(`splitXplorer.addFiles.${slot}`, () => sections.pickAndAssign(slot))
    );
  }

  context.subscriptions.push(
    model,
    sections,
    allFiles,
    ignoreFiles,
    ...perSlot,
    vscode.workspace.onDidChangeWorkspaceFolders(() => model.scheduleRefresh()),

    vscode.commands.registerCommand('splitXplorer.addSection', () => sections.add()),
    vscode.commands.registerCommand('splitXplorer.renameSection', withSlot('Rename Which Section?', (s) => sections.rename(s))),
    vscode.commands.registerCommand('splitXplorer.removeSection', withSlot('Remove Which Section?', (s) => sections.remove(s))),
    vscode.commands.registerCommand('splitXplorer.editSectionRules', withSlot('Edit Rules for Which Section?', (s) => sections.editRules(s))),

    vscode.commands.registerCommand('splitXplorer.refresh', async () => {
      await model.refresh();
      sections.refreshAll();
    }),

    vscode.commands.registerCommand('splitXplorer.toggleBuiltInExclude', async () => {
      const config = vscode.workspace.getConfiguration('explorer');
      const next = !config.get<boolean>('excludeGitIgnore', false);
      await config.update('excludeGitIgnore', next, vscode.ConfigurationTarget.Workspace);
      vscode.window.showInformationMessage(
        `Built-in Explorer now ${next ? 'hides' : 'shows'} gitignored files.`
      );
    }),

    vscode.commands.registerCommand('splitXplorer.moveToSection', async (node?: Node, all?: Node[]) => {
      const nodes = selection(node, all);
      if (nodes.length === 0) return;
      const to = await sections.pickSection('Move to Section', nodes[0].slot);
      if (to !== undefined) await sections.assign(to, nodes.map((n) => n.uri), nodes[0].slot);
    }),
    vscode.commands.registerCommand('splitXplorer.addToSection', async (node?: Node, all?: Node[]) => {
      const nodes = selection(node, all);
      if (nodes.length === 0) return;
      const to = await sections.pickSection('Also Show in Section', nodes[0].slot);
      if (to !== undefined) await sections.assign(to, nodes.map((n) => n.uri));
    }),
    vscode.commands.registerCommand('splitXplorer.removeFromSection', async (node?: Node, all?: Node[]) => {
      const nodes = selection(node, all);
      if (nodes.length > 0) await sections.unassign(nodes[0].slot, nodes.map((n) => n.uri));
    }),
    // From the built-in Explorer's context menu, which passes plain uris.
    vscode.commands.registerCommand('splitXplorer.showInSection', async (uri?: vscode.Uri, all?: vscode.Uri[]) => {
      const uris = all && all.length > 0 ? all : uri ? [uri] : [];
      if (uris.length === 0) return;
      const to = await sections.pickSection('Show in Section');
      if (to !== undefined) await sections.assign(to, uris);
    }),

    vscode.commands.registerCommand('splitXplorer.revealInExplorer', (node: Node) =>
      vscode.commands.executeCommand('revealInExplorer', node.uri)
    ),
    vscode.commands.registerCommand('splitXplorer.revealInOS', (node: Node) =>
      vscode.commands.executeCommand('revealFileInOS', node.uri)
    ),
    vscode.commands.registerCommand('splitXplorer.copyPath', (node: Node) =>
      vscode.env.clipboard.writeText(node.uri.fsPath)
    )
  );

  void model.refresh();
}

export function deactivate(): void {}
