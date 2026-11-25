// Steps that drive the page editor (packages/builder/src/editor) from Playwright.

/** Types into a text that is edited in place on the editor's canvas, replacing what was there. */
export async function typeInPlace(page, selector, text) {
  const field = page.locator(`${selector} [data-puck-overlay-portal]`).first();
  await field.hover();
  await field.click();
  await page.locator(`${selector} [contenteditable="plaintext-only"], ${selector} [contenteditable="true"]`).first().waitFor({ timeout: 10000 });
  await page.keyboard.press('ControlOrMeta+A');
  await page.keyboard.type(text);
}

/** Selects the block at `block` on the canvas and fills its list (links, cards) in the side panel. */
export async function fillItems(page, block, items) {
  await page.locator(`.dsp ${block}`).first().click();
  const list = page.locator('[class*="_ArrayField_"]:visible').first();
  await list.waitFor();
  for (let i = 0; i < items.length; i++) {
    if ((await list.locator('[class*="_ArrayFieldItem_"]').count()) <= i) await list.locator('[class*="_ArrayField-addButton"]').click();
    const item = list.locator('[class*="_ArrayFieldItem_"]').nth(i);
    const inputs = item.locator('input, textarea');
    if (!(await inputs.first().isVisible().catch(() => false))) await item.locator('[class*="_ArrayFieldItem-summary"]').click();
    const values = Object.values(items[i]);
    for (let f = 0; f < values.length; f++) await inputs.nth(f).fill(values[f]);
    await item.locator('[class*="_ArrayFieldItem-summary"]').click();
  }
}

export async function openEditor(page) {
  await page.click('#edit-page');
  await page.waitForSelector('.ed .dsp h1', { timeout: 60000 });
}

export async function closeEditor(page) {
  await page.click('.ed-done');
  await page.waitForSelector('.ed', { state: 'detached' });
}
