/**
 * 浏览器端到端冒烟（playwright-core + 本机 Chromium）：
 * 装载基础样例 → 装载调查资料包 → 事件/候选 → 两路线 → 自报更正 →
 * 不可判定 → 发布交付 → 处置板（待办/取样/关闭）→ 拓扑修订 → 交付页。
 * 收集控制台错误；任一环节失败退出码非 0。
 *
 * 用法：node scripts/browser-smoke.mjs [baseURL]（需先启动 vite preview / dev）
 */

import { createRequire } from 'node:module';

// playwright-core 不进入项目依赖：优先项目内解析，其次 /tmp/node_modules（容器临时安装）
let chromium;
try {
  ({ chromium } = await import('playwright-core'));
} catch {
  const req = createRequire('/tmp/node_modules/');
  ({ chromium } = req('playwright-core'));
}

const baseURL = process.argv[2] ?? 'http://localhost:4173';
const failures = [];
const consoleErrors = [];

function check(label, condition, detail = '') {
  if (condition) console.log(`  ✓ ${label}${detail ? `：${detail}` : ''}`);
  else {
    failures.push(label);
    console.log(`  ✗ ${label}${detail ? `：${detail}` : ''}`);
  }
}

const browser = await chromium.launch({ headless: true });
const page = await browser.newPage();
page.on('console', (msg) => {
  if (msg.type() === 'error') consoleErrors.push(msg.text());
});
page.on('pageerror', (err) => consoleErrors.push(String(err)));

try {
  console.log(`=== 打开 ${baseURL} ===`);
  await page.goto(baseURL, { waitUntil: 'networkidle' });
  await page.waitForSelector('.sidebar', { timeout: 15000 });
  // 清空本地库，保证可重复执行
  await page.evaluate(() => indexedDB.deleteDatabase('outfall-review'));
  await page.reload({ waitUntil: 'networkidle' });
  await page.waitForSelector('.sidebar', { timeout: 15000 });
  check('应用外壳渲染', true);

  // 1. 装载基础样例
  await page.click('text=装载样例资料');
  await page.waitForSelector('text=样例装载完成', { timeout: 120000 });
  check('基础样例装载', true);

  // 2. 事件与候选：装载调查资料包
  await page.click('button.nav-item:has-text("事件与候选")');
  await page.click('text=装载调查资料包');
  await page.waitForSelector('text=短时高氨氮事件', { timeout: 180000 });
  check('调查资料包装载并检出事件', true);
  const windowText = await page.textContent('.card .stat-value.small.mono');
  check('事件窗口 14:32–14:41', /14:3[12]:\d{2} → 14:4[01]:\d{2}/.test(windowText ?? ''), (windowText ?? '').trim());

  // 候选卡片：3 个候选，SRC-C 时间带不相容
  await page.waitForSelector('text=宏成化工工业支管', { timeout: 30000 });
  await page.waitForSelector('text=城西雨污合流溢流口');
  await page.waitForSelector('text=厂内反硝化回流');
  check('召回 3 个候选', true);
  const incompatible = await page.locator('span.badge.bad:has-text("时间带不相容")').count();
  check('厂内回流被时间带门槛排除', incompatible >= 1, `${incompatible} 处不相容标记`);
  const pumpBadge = await page.locator('span.badge.info:has-text("泵站中途切换")').count();
  check('泵站中途切换标注', pumpBadge >= 1);

  // 证据展开：第一个候选展开后能看到证据表
  await page.click('.card-head:has(h3:text("宏成化工工业支管"))');
  await page.waitForSelector('td:text("自报资料")', { timeout: 10000 });
  const denyCell = await page.locator('td:has-text("全天未排放")').count();
  check('v1 自报否认在证据展开中可见', denyCell >= 1);

  // 3. 证据路线（v1 状态）
  await page.click('button.nav-item:has-text("证据路线")');
  await page.waitForSelector('text=路线一 · 集合发布', { timeout: 15000 });
  const inSetCard = page.locator('div.card:has(> .card-pad > h3:text-matches("入选集合"))');
  const excludedCard = page.locator('div.card:has(> .card-pad > h3:text-matches("未入选"))');
  const inSetV1 = (await inSetCard.textContent()) ?? '';
  const excludedV1 = (await excludedCard.textContent()) ?? '';
  check('v1 集合只含溢流口', inSetV1.includes('城西雨污合流溢流口') && !inSetV1.includes('宏成化工'), inSetV1.slice(0, 40));
  check('v1 未入选含化工支管及反证理由', excludedV1.includes('宏成化工') && excludedV1.includes('反证'), excludedV1.slice(0, 60));
  const rankCard = page.locator('.card:has(> .card-head > h2:text-matches("路线二"))');
  const rankV1Text = (await rankCard.textContent()) ?? '';
  check('v1 排序可判定（无不可判定提示）', !rankV1Text.includes('不可判定：'), '');

  // 4. 导入自报更正 → 排序变为不可判定，集合变为并列
  await page.click('button.nav-item:has-text("来源登记簿")');
  await page.click('text=导入自报更正批次');
  await page.waitForSelector('text=自报更正已入库', { timeout: 30000 });
  await page.waitForSelector('span.badge.bad:has-text("已撤销")', { timeout: 15000 });
  check('自报 v1 批次显示已撤销', true);
  await page.click('button.nav-item:has-text("证据路线")');
  await page.waitForSelector('text=不可判定', { timeout: 15000 });
  check('v2 排序输出不可判定', true);
  const inSetV2 = (await page.locator('div.card:has(> .card-pad > h3:text-matches("入选集合"))').textContent()) ?? '';
  check('v2 集合为并列两支管', inSetV2.includes('宏成化工工业支管') && inSetV2.includes('城西雨污合流溢流口'), inSetV2.slice(0, 60));
  const sens = (await page.locator('.card:has(> .card-head > h2:text-matches("路线二"))').textContent()) ?? '';
  check('敏感性含自报更正前与雨量误差', sens.includes('自报更正前') && sens.includes('雨量下浮') && sens.includes('雨量上浮'), '');

  // 5. 发布两条路线交付
  await page.click('button:has-text("发布集合交付")');
  await page.waitForSelector('text=已发布集合交付', { timeout: 15000 });
  await page.click('button:has-text("发布排序交付")');
  await page.waitForSelector('text=已发布排序交付', { timeout: 15000 });
  check('两条路线交付发布', true);

  // 6. 交付页：支持/反证并列 + 免责声明 + 哈希
  await page.click('button.nav-item:has-text("结论交付")');
  await page.waitForSelector('text=支持与反证并列', { timeout: 15000 });
  const deliveryText = await page.textContent('.content');
  check('交付页含免责声明', deliveryText.includes('不构成、也不得被解释为污染来源的责任结论'));
  check('交付页含内容哈希', /[0-9a-f]{12}…[0-9a-f]{6}/.test(deliveryText));

  // 7. 处置板：待办 + 取样 + 关闭
  await page.click('button.nav-item:has-text("调查处置板")');
  await page.waitForSelector('text=调查处置板', { timeout: 15000 });
  const firstCard = page.locator('.card:has(> .card-head > h3:text("城西雨污合流溢流口"))');
  await firstCard.locator('input[placeholder^="新增待办"]').fill('调取溢流口液位计原始记录');
  await firstCard.locator('button:has-text("添加")').click();
  await page.waitForSelector('text=调取溢流口液位计原始记录', { timeout: 10000 });
  await firstCard.locator('input[placeholder="取样点"]').fill('SW-CSO-07 溢流口');
  await firstCard.locator('input[placeholder="结果"]').fill('氨氮 8.4 mg/L');
  await firstCard.locator('button:has-text("记录取样")').click();
  await page.waitForSelector('text=氨氮 8.4 mg/L', { timeout: 10000 });
  await firstCard.locator('button:has-text("关闭调查")').click();
  await page.waitForSelector('text=关闭快照', { timeout: 10000 });
  check('处置板：待办/取样/关闭快照', true);

  // 8. 拓扑修订：已关闭调查不改写，未关闭标记过旧
  await page.click('button.nav-item:has-text("来源登记簿")');
  await page.click('text=导入拓扑修订');
  await page.waitForSelector('text=拓扑修订已入库', { timeout: 30000 });
  await page.click('button.nav-item:has-text("调查处置板")');
  await page.waitForSelector('text=登记簿已修订', { timeout: 15000 });
  const closedCardText = await page.locator('.card:has(> .card-head > h3:text("城西雨污合流溢流口"))').textContent();
  check('已关闭调查保持快照且不改写', closedCardText.includes('关闭快照') && !closedCardText.includes('登记簿已修订'));
  const openCardText = await page.locator('.card:has(> .card-head > h3:text("宏成化工工业支管"))').textContent();
  check('未关闭调查标记登记簿已修订', openCardText.includes('登记簿已修订'));

  // 9. 控制台错误
  check('浏览器控制台无错误', consoleErrors.length === 0, consoleErrors.slice(0, 3).join(' | '));
} catch (error) {
  failures.push(`异常：${(error && error.message) || error}`);
  console.error('执行异常：', error);
} finally {
  await browser.close();
}

if (failures.length > 0) {
  console.error(`\n冒烟失败 ${failures.length} 项：${failures.join('；')}`);
  process.exit(1);
}
console.log('\n浏览器冒烟通过：装载、事件、候选、两路线、更正撤销、不可判定、交付、处置板、拓扑修订全部正常。');
