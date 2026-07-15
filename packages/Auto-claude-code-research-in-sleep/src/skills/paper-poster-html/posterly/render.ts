import { asciiSafe } from "./textutil.js";

export interface SettleResult {
  mathjaxIntended: boolean;
  hasMathjax: boolean;
  mathjaxStatus: "ok" | "timeout" | "error" | "not-needed";
  mathjaxError: string | null;
  texWithoutMathjax: boolean;
}

interface PwPage {
  emulateMedia(opts: { media: string }): Promise<void>;
  setViewportSize(size: { width: number; height: number }): Promise<void>;
  goto(url: string, opts?: { waitUntil?: string; timeout?: number }): Promise<void>;
  evaluate(expression: string | Function, arg?: unknown): Promise<unknown>;
  waitForTimeout(ms: number): Promise<void>;
  waitForLoadState(state?: string, opts?: { timeout?: number }): Promise<void>;
  pdf(opts?: Record<string, unknown>): Promise<Buffer>;
  screenshot(opts?: Record<string, unknown>): Promise<Buffer>;
}

interface PwBrowserContext {
  newPage(): Promise<PwPage>;
}

interface PwBrowser {
  newContext(opts: { viewport: { width: number; height: number } }): Promise<PwBrowserContext>;
  close(): Promise<void>;
}

interface PwChromium {
  launch(): Promise<PwBrowser>;
}

export interface PwPlaywright {
  chromium: PwChromium;
}

export async function openPrintEmulatedPageAsync(
  p: PwPlaywright,
  viewportPx: [number, number],
): Promise<{ browser: PwBrowser; ctx: PwBrowserContext; page: PwPage }> {
  const [w, h] = viewportPx;
  const browser = await p.chromium.launch();
  const ctx = await browser.newContext({ viewport: { width: w, height: h } });
  const page = await ctx.newPage();
  await page.emulateMedia({ media: "print" });
  await page.setViewportSize({ width: w, height: h });
  return { browser, ctx, page };
}

export async function settlePage(
  page: PwPage,
  options: {
    mathjaxTimeoutMs?: number;
    settleMs?: number;
  } = {},
): Promise<SettleResult> {
  const mathjaxTimeoutMs = options.mathjaxTimeoutMs ?? 15000;
  const settleMs = options.settleMs ?? 500;

  let mathjaxIntended = false;
  try {
    mathjaxIntended = !!(await page.evaluate(
      `() => !!(document.querySelector('script[src*="mathjax" i]') ` +
        `|| (window.MathJax && Object.keys(window.MathJax).length > 0))`,
    ));
  } catch {
    mathjaxIntended = false;
  }

  let hasMj = false;
  try {
    hasMj = !!(await page.evaluate(
      `() => !!(window.MathJax && window.MathJax.startup ` + `&& window.MathJax.startup.promise)`,
    ));
  } catch {
    hasMj = false;
  }

  let mjStatus: SettleResult["mathjaxStatus"] = "not-needed";
  let mjError: string | null = null;

  if (hasMj) {
    const mjJs =
      `() => Promise.race([` +
      `  MathJax.startup.promise` +
      `    .then(() => (MathJax.typesetPromise` +
      `      ? MathJax.typesetPromise() : null))` +
      `    .then(() => 'ok'),` +
      `  new Promise(r => setTimeout(` +
      `    () => r('timeout'), ${mathjaxTimeoutMs}))` +
      `])`;
    try {
      const result = await page.evaluate(mjJs);
      mjStatus = (result as string) === "ok" ? "ok" : "timeout";
    } catch (e: unknown) {
      mjStatus = "error";
      mjError = String(e);
    }
  }

  try {
    await page.evaluate(
      `() => document.fonts && document.fonts.ready ` + `? document.fonts.ready : null`,
    );
  } catch {
    // best-effort
  }
  await page.evaluate(
    `() => new Promise(r => ` + `requestAnimationFrame(() => requestAnimationFrame(r)))`,
  );
  await page.waitForTimeout(settleMs);

  let texWithoutMathjax = false;
  try {
    const sanity = (await page.evaluate(
      `() => {` +
        `  const has_mjx = ` +
        `    document.querySelectorAll('mjx-container').length > 0;` +
        `  const txt = document.body && document.body.innerText || '';` +
        `  const has_dollar  = /\\$[^$\\n]+\\$/.test(txt);` +
        `  const has_ddollar = /\\$\\$[\\s\\S]+?\\$\\$/.test(txt);` +
        `  const has_paren   = /\\\\\\([\\s\\S]+?\\\\\\)/.test(txt);` +
        `  const has_brack   = /\\\\\\[[\\s\\S]+?\\\\\\]/.test(txt);` +
        `  return {has_mjx, has_tex: has_dollar || has_ddollar ` +
        `                          || has_paren  || has_brack};` +
        `}`,
    )) as { has_mjx: boolean; has_tex: boolean };
    texWithoutMathjax = !!sanity.has_tex && !sanity.has_mjx;
  } catch {
    texWithoutMathjax = false;
  }

  return {
    mathjaxIntended,
    hasMathjax: hasMj,
    mathjaxStatus: mjStatus,
    mathjaxError: mjError,
    texWithoutMathjax,
  };
}

export function hardFailOnSettleProblems(
  result: SettleResult,
  mathjaxTimeoutMs: number,
): string | null {
  if (result.mathjaxStatus === "error") {
    return (
      `MathJax typeset error: ${asciiSafe(result.mathjaxError)}. ` +
      `Refusing to measure a broken-script page.`
    );
  }
  if (result.mathjaxStatus === "timeout") {
    return (
      `MathJax typeset did not finish within ` +
      `${mathjaxTimeoutMs} ms. Refusing to measure a ` +
      `partially typeset poster.`
    );
  }
  if (result.mathjaxIntended && result.texWithoutMathjax) {
    return (
      `page intended to load MathJax (script/config present) ` +
      `but no rendered <mjx-container> was found despite TeX ` +
      `delimiters in body text. MathJax likely failed to load ` +
      `(CDN block? script error?). Refusing to measure raw-TeX ` +
      `layout.`
    );
  }
  return null;
}
