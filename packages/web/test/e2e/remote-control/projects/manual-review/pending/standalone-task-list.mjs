// Run with ego-browser nodejs < this-file after seeding an isolated dev:web profile.
// Prepend globalThis.STANDALONE_WEB_E2E = { url, spaceId } to override the URL or resume a space.
import assert from "node:assert/strict";

const config = globalThis.STANDALONE_WEB_E2E ?? {};
const task = await taskSpace(config.spaceId ?? "Standalone Web task list E2E");
console.log({ spaceId: task.spaceId });
const page = task.page("p1");
const baseUrl = config.url || "http://localhost:5173/";
await page.goto(baseUrl);
await page.waitForFunction(
  () =>
    document.body.textContent.includes("Welcome to ZCode") ||
    document.body.textContent.includes("Web fixture pinned task"),
  undefined,
  { timeout: 15000 },
);
if (await page.evaluate(() => document.body.textContent.includes("Welcome to ZCode"))) {
  await page.click("loc=role:button[name='Use API key']");
  await page.click("loc=role:button[name='Skip for now']");
}
await page.waitForSelector("text=Web fixture pinned task", { timeout: 15000 });
await page.waitForSelector("text=Web fixture older task", { timeout: 15000 });
await page.waitForSelector("text=Web fixture recent task", { timeout: 15000 });
console.log("PASS standalone existing tasks and pinned partition");

async function chooseFilter(name) {
  await page.click("loc=css:button[aria-label='Filter and sort']");
  await page.click(`loc=role:menuitemradio[name='${name}']`);
  await page.keyboard.press("Escape");
}
await chooseFilter("Timeline");
await chooseFilter("Created");
const taskOrder = () =>
  page.evaluate(() =>
    [...document.querySelectorAll("li[data-testid]")]
      .map((node) => node.getAttribute("data-testid"))
      .filter((id) => id === "task-item-web-history" || id === "task-item-web-recent"),
  );
await page.waitForFunction(
  () => document.querySelector("li[data-testid='task-item-web-recent']") !== null,
);
assert.deepEqual(await taskOrder(), ["task-item-web-recent", "task-item-web-history"]);
await chooseFilter("Updated");
await page.waitForFunction(
  () =>
    [...document.querySelectorAll("li[data-testid]")]
      .filter((node) =>
        ["task-item-web-history", "task-item-web-recent"].includes(
          node.getAttribute("data-testid"),
        ),
      )[0]
      ?.getAttribute("data-testid") === "task-item-web-history",
);
assert.deepEqual(await taskOrder(), ["task-item-web-history", "task-item-web-recent"]);
console.log("PASS standalone created/updated sorting");

await page.click("loc=role:button[name*='Search']");
await page.fill(
  "loc=css:input[placeholder='Search actions, tasks, or files']",
  "uniqueWebBodyNeedle",
);
await page.waitForFunction(() =>
  document
    .querySelector("[role='dialog'] [role='option']")
    ?.textContent.includes("uniqueWebBodyNeedle"),
);
const matches = await page.evaluate(() =>
  [...document.querySelectorAll("[role='dialog'] [role='option']")].map((node) => node.textContent),
);
assert.equal(matches.length, 1);
assert.ok(matches[0].includes("Web fixture older task"));
console.log("PASS standalone body search and snippet");
await page.keyboard.press("Escape");
await page.click("loc=css:button[aria-label='Archived']");
await page.waitForSelector("text=Web fixture archived task");
assert.equal(
  await page.evaluate(
    () => document.querySelector("li[data-testid='task-item-web-history']") !== null,
  ),
  false,
);
await page.click("loc=css:button[aria-label='Close']");
await page.waitForSelector("text=Web fixture older task");
console.log("PASS standalone archived filter and return to active tasks");
await task.finish({ keep: [] });
