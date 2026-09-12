import { chromium } from '/Users/ficowang/cindy-migration/shua-gongxian/worktrees/pr-2541-review/node_modules/playwright-core/index.mjs';
import path from 'node:path';
const S=path.dirname(new URL(import.meta.url).pathname);
const browser=await chromium.launch({executablePath:'/Users/ficowang/Library/Caches/ms-playwright/chromium_headless_shell-1228/chrome-headless-shell-mac-arm64/chrome-headless-shell'});
const page=await browser.newPage({viewport:{width:1280,height:900},deviceScaleFactor:2});
await page.goto('file://'+path.join(S,'error-banner-malformed-tool-markup.html'));
await page.waitForTimeout(300);
await page.screenshot({path:path.join(S,'overview.png'),fullPage:true});
for (const el of await page.$$('[data-shot]')){const n=await el.getAttribute('data-shot');await el.screenshot({path:path.join(S,`banner-${n}.png`)});}
await browser.close(); console.log('rendered');
