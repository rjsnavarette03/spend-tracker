import { app, BrowserWindow, dialog, ipcMain, shell } from 'electron';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import * as db from './db';
import type { TxFilter, TxInput, TxType } from '../shared/types';

const isSmokeTest = process.argv.includes('--smoke-test');
const devServerUrl = process.env.VITE_DEV_SERVER_URL;

app.disableHardwareAcceleration();

if (isSmokeTest) {
  // Keep smoke-test data away from the real user database.
  app.setPath('userData', path.join(os.tmpdir(), `spend-tracker-smoke-${process.pid}`));
}

let mainWindow: BrowserWindow | null = null;

// The whole DB lives in memory and is flushed to disk on every mutation,
// so two running instances would silently clobber each other's writes.
if (!app.requestSingleInstanceLock()) {
  app.quit();
} else {
  app.on('second-instance', () => {
    if (mainWindow) {
      if (mainWindow.isMinimized()) mainWindow.restore();
      mainWindow.focus();
    }
  });
}

function createWindow(): BrowserWindow {
  const iconPath = path.join(__dirname, '..', 'buildResources', 'icon.ico');
  const win = new BrowserWindow({
    width: 1280,
    height: 820,
    minWidth: 980,
    minHeight: 640,
    show: false,
    backgroundColor: '#0f1115',
    autoHideMenuBar: true,
    title: 'SpendTracker',
    ...(fs.existsSync(iconPath) ? { icon: iconPath } : {}),
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
    },
  });

  win.webContents.setWindowOpenHandler(({ url }) => {
    if (url.startsWith('https://') || url.startsWith('http://')) shell.openExternal(url);
    return { action: 'deny' };
  });

  if (devServerUrl) {
    win.loadURL(devServerUrl);
    win.webContents.openDevTools({ mode: 'detach' });
  } else {
    win.loadFile(path.join(__dirname, '..', 'dist', 'index.html'));
  }

  win.once('ready-to-show', () => {
    if (!isSmokeTest) win.show();
  });

  win.on('closed', () => {
    if (mainWindow === win) mainWindow = null;
  });

  return win;
}

// Wrap handlers so validation errors reach the renderer as clean messages.
function handle(channel: string, fn: (...args: never[]) => unknown): void {
  ipcMain.handle(channel, async (_event, ...args) => fn(...(args as never[])));
}

function registerIpc(): void {
  handle('categories:list', () => db.listCategories());
  handle('categories:create', (data: { name: string; type: TxType; color: string }) =>
    db.createCategory(data)
  );
  handle('categories:update', (id: number, data: { name: string; color: string }) =>
    db.updateCategory(id, data)
  );
  handle('categories:remove', (id: number) => db.deleteCategory(id));

  handle('tx:list', (filter: TxFilter) => db.listTransactions(filter ?? {}));
  handle('tx:create', (data: TxInput) => db.createTransaction(data));
  handle('tx:update', (id: number, data: TxInput) => db.updateTransaction(id, data));
  handle('tx:remove', (id: number) => db.deleteTransaction(id));
  handle('tx:exportCsv', async (filter: TxFilter) => {
    if (!mainWindow) return { saved: false };
    const month = filter?.month ? `-${filter.month}` : '';
    const result = await dialog.showSaveDialog(mainWindow, {
      title: 'Export transactions',
      defaultPath: path.join(app.getPath('documents'), `transactions${month}.csv`),
      filters: [{ name: 'CSV', extensions: ['csv'] }],
    });
    if (result.canceled || !result.filePath) return { saved: false };
    fs.writeFileSync(result.filePath, db.transactionsToCsv(filter ?? {}), 'utf8');
    return { saved: true, path: result.filePath };
  });

  handle('budgets:list', (month: string) => db.listBudgets(month));
  handle('budgets:upsert', (categoryId: number, month: string, amountCents: number) =>
    db.upsertBudget(categoryId, month, amountCents)
  );
  handle('budgets:copyFromPrevious', (month: string) => db.copyBudgetsFromPrevious(month));

  handle('reports:summary', (month: string) => db.getSummary(month));
  handle('reports:trend', (endMonth: string, count: number) => db.getTrend(endMonth, count));
  handle('reports:breakdown', (month: string, type: TxType) => db.getBreakdown(month, type));

  handle('app:version', () => app.getVersion());
  handle('app:dbPath', () => db.getDbFilePath());
}

// Demo data for the smoke-test run (isolated temp DB), so the screenshot
// and renderer checks exercise a populated UI, charts included.
function seedDemoData(): void {
  const cats = new Map(db.listCategories().map((c) => [c.name, c] as const));
  const now = new Date();
  const mk = (offsetMonth: number, day: number) => {
    const d = new Date(now.getFullYear(), now.getMonth() - offsetMonth, day);
    return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
  };
  const add = (m: number, day: number, name: string, type: TxType, amount: number, note: string) => {
    db.createTransaction({
      amountCents: Math.round(amount * 100),
      type,
      categoryId: cats.get(name)?.id ?? null,
      date: mk(m, day),
      note,
    });
  };
  for (let m = 5; m >= 0; m--) {
    add(m, 1, 'Salary', 'income', 4200, 'Monthly salary');
    if (m % 2 === 0) add(m, 12, 'Freelance', 'income', 350 + m * 40, 'Side project');
    add(m, 3, 'Housing', 'expense', 1450, 'Rent');
    add(m, 6, 'Groceries', 'expense', 320.4 + m * 12, 'Supermarket');
    add(m, 9, 'Transport', 'expense', 95.5, 'Fuel + transit');
    add(m, 14, 'Dining Out', 'expense', 120.75 + m * 8, 'Restaurants');
    add(m, 18, 'Subscriptions', 'expense', 42.97, 'Streaming + music');
    if (m % 2 === 1) add(m, 20, 'Entertainment', 'expense', 65, 'Cinema');
    add(m, 22, 'Utilities', 'expense', 180.2, 'Electricity + internet');
  }
  const month = mk(0, 1).slice(0, 7);
  const budgetPlan: Array<[string, number]> = [
    ['Groceries', 400],
    ['Dining Out', 200],
    ['Transport', 150],
    ['Entertainment', 100],
    ['Utilities', 200],
  ];
  for (const [name, amount] of budgetPlan) {
    const c = cats.get(name);
    if (c) db.upsertBudget(c.id, month, amount * 100);
  }
}

// ---------- smoke test (--smoke-test) ----------
// Verifies the full stack headlessly: DB round trip in the main process,
// renderer bundle mounting, and the IPC bridge from renderer to DB.

function smokeOutPath(): string {
  const arg = process.argv.find((a) => a.startsWith('--smoke-out='));
  return arg ? arg.slice('--smoke-out='.length) : path.join(process.cwd(), 'smoke-result.txt');
}

async function waitFor(
  check: () => Promise<boolean>,
  timeoutMs: number,
  label: string
): Promise<void> {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    try {
      if (await check()) return;
    } catch {
      // renderer may not be ready yet; keep polling
    }
    await new Promise((r) => setTimeout(r, 250));
  }
  throw new Error(`Timed out waiting for: ${label}`);
}

async function runSmokeTest(win: BrowserWindow): Promise<void> {
  const writeResult = (msg: string) => {
    try {
      fs.writeFileSync(smokeOutPath(), msg, 'utf8');
    } catch {
      /* best effort */
    }
  };
  const failTimer = setTimeout(() => {
    writeResult('FAIL: global timeout');
    app.exit(1);
  }, 60_000);

  try {
    // 1. DB round trip directly in the main process.
    const today = new Date();
    const date = `${today.getFullYear()}-${String(today.getMonth() + 1).padStart(2, '0')}-${String(today.getDate()).padStart(2, '0')}`;
    const month = date.slice(0, 7);
    const cat = db.createCategory({ name: 'Smoke Category', type: 'expense', color: '#ff0000' });
    const tx = db.createTransaction({
      amountCents: 1234,
      type: 'expense',
      categoryId: cat.id,
      date,
      note: 'smoke test',
    });
    const summary = db.getSummary(month);
    if (summary.expenseCents < 1234) throw new Error('summary does not include inserted tx');
    db.upsertBudget(cat.id, month, 50_00);
    const budgets = db.listBudgets(month);
    const row = budgets.find((b) => b.categoryId === cat.id);
    if (!row || row.amountCents !== 50_00 || row.spentCents < 1234) {
      throw new Error(
        `budget row mismatch: catId=${cat.id} rows=${JSON.stringify(budgets)}`
      );
    }
    db.deleteTransaction(tx.id);

    // FK actions: deleting a category must null out its transactions
    // (and cascade its budgets) — guards against the pragma being dropped.
    const tx2 = db.createTransaction({
      amountCents: 500,
      type: 'expense',
      categoryId: cat.id,
      date,
      note: 'fk check',
    });
    db.deleteCategory(cat.id);
    const orphan = db.listTransactions({ month }).find((t) => t.id === tx2.id);
    if (!orphan || orphan.categoryId !== null) {
      throw new Error('FK ON DELETE SET NULL was not applied');
    }
    db.deleteTransaction(tx2.id);

    // 2. Renderer bundle mounted (React rendered into #root).
    await waitFor(
      async () =>
        (await win.webContents.executeJavaScript(
          `document.querySelector('#root') ? document.querySelector('#root').childElementCount : 0`
        )) > 0,
      30_000,
      'renderer to mount React app'
    );

    // 3. IPC bridge end to end from the renderer context.
    const cats = await win.webContents.executeJavaScript(`window.api.categories.list()`);
    if (!Array.isArray(cats) || cats.length < 1) {
      throw new Error('IPC bridge returned no categories');
    }

    // 4. Full renderer -> main -> DB round trip through the bridge.
    const created = await win.webContents.executeJavaScript(
      `window.api.transactions.create({ amountCents: 4242, type: 'income', categoryId: null, date: '${date}', note: 'bridge check' })`
    );
    if (!created || typeof created.id !== 'number' || created.amountCents !== 4242) {
      throw new Error('renderer-side create failed');
    }
    await win.webContents.executeJavaScript(`window.api.transactions.remove(${created.id})`);

    // 5. Optional screenshots for visual verification (--smoke-shot=path).
    const shotArg = process.argv.find((a) => a.startsWith('--smoke-shot='));
    if (shotArg) {
      const base = shotArg.slice('--smoke-shot='.length);
      win.show();
      await new Promise((r) => setTimeout(r, 900));
      fs.writeFileSync(base, (await win.webContents.capturePage()).toPNG());
      const pages: Array<[number, string]> = [
        [1, 'transactions'],
        [2, 'budgets'],
        [3, 'categories'],
      ];
      for (const [idx, name] of pages) {
        await win.webContents.executeJavaScript(
          `document.querySelectorAll('.nav-item')[${idx}].click()`
        );
        await new Promise((r) => setTimeout(r, 500));
        fs.writeFileSync(
          base.replace(/\.png$/, `-${name}.png`),
          (await win.webContents.capturePage()).toPNG()
        );
      }
    }

    clearTimeout(failTimer);
    console.log('SMOKE TEST PASS');
    writeResult('PASS');
    app.exit(0);
  } catch (err) {
    clearTimeout(failTimer);
    const msg = err instanceof Error ? err.message : String(err);
    console.error('SMOKE TEST FAIL:', msg);
    writeResult(`FAIL: ${msg}`);
    app.exit(1);
  }
}

// ---------- app lifecycle ----------

app.whenReady().then(async () => {
  try {
    await db.initDb(app.getPath('userData'));
  } catch (err) {
    dialog.showErrorBox('SpendTracker failed to start', String(err));
    app.exit(1);
    return;
  }
  registerIpc();
  if (isSmokeTest) seedDemoData();
  mainWindow = createWindow();

  if (isSmokeTest) void runSmokeTest(mainWindow);

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) mainWindow = createWindow();
  });
});

app.on('window-all-closed', () => {
  app.quit();
});
