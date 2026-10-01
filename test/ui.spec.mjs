import { test, expect } from "@playwright/test";
test("desktop dashboard renders four bots, the review card and synthetic mode", async ({
  page,
}) => {
  const errors = [];
  page.on("pageerror", (e) => errors.push(e.message));
  await page.goto("/beebots/");
  // Four cards: the three strategies plus the random-entry control arm.
  await expect(page.locator(".bot")).toHaveCount(4);
  await expect(page.locator("#mode")).toHaveText("DEMO · SYNTHETIC");
  await expect(page.locator("#leaderboard tr")).toHaveCount(4);
  await expect(page.locator("#analysis .analysis-row").first()).toBeVisible({
    timeout: 10000,
  });
  await expect(page.locator("#pause")).toBeDisabled();
  await expect(page.locator("#coverage")).toContainText("410 discovered");
  await expect(page.locator("#coverage")).toContainText("26 Scout assets");
  // Regression: 2.1.0 put the decision-model form in the operations grid as a
  // third panel and broke the layout. It must now live in a dialog, and the
  // operations row must hold only the order ledger and market coverage.
  await expect(page.locator("#model-settings")).toHaveCount(0);
  // 2.4.0: four bot cards across the top, then a three-up panels row, then the
  // order ledger, market coverage and the hourly Trade Review at the bottom.
  await expect(page.locator("#review")).toHaveCount(1);
  await expect(page.locator("#review-body")).toContainText("Two of three arms");
  await expect(page.locator("#review-body .proposal")).toHaveCount(1);
  // 2.5.0 row order: Order ledger / Decision stream / Laya analysis under the
  // bots, then Leaderboard / Market coverage / Trade Review at the bottom.
  await expect(page.locator(".panels > .panel")).toHaveCount(3);
  await expect(
    page.locator(".panels > .panel").nth(0).locator("h2"),
  ).toHaveText("Order ledger");
  await expect(
    page.locator(".panels > .panel").nth(1).locator("h2"),
  ).toHaveText("Decision stream");
  await expect(
    page.locator(".panels > .panel").nth(2).locator("h2"),
  ).toHaveText("Laya analysis");
  await expect(
    page.locator(".operations > .panel").first().locator("h2"),
  ).toHaveText("Leaderboard");
  await expect(page.locator(".operations #model-dialog")).toHaveCount(0);
  await expect(page.locator("#model-dialog")).toHaveCount(1);
  await expect(page.locator("#model-gear")).toBeVisible();

  // The model card names the active model and shows a cost alongside the count.
  await expect(page.locator("#summary-model")).toContainText("GLM-4.7-FLASH");
  await expect(page.locator("#summary-cost")).toContainText("$0.00");
  await expect(page.locator("#summary-cost")).toContainText("free");
  // No vendor name is hardcoded anywhere in the rendered dashboard.
  await expect(page.locator("body")).not.toContainText("DEEPSEEK");

  // Opening the gear populates both dropdowns from the catalogue without
  // touching the page layout.
  await page.locator("#model-gear").click();
  await expect(page.locator("#model-dialog")).toBeVisible();
  await expect(page.locator("#settings-provider")).toHaveValue("zai");
  await expect(page.locator("#settings-model-select")).toHaveValue(
    "glm-4.7-flash",
  );
  // A keyless local provider hides the key field and reveals its endpoint.
  await page.locator("#settings-provider").selectOption("ollama");
  await expect(page.locator("#settings-endpoint-row")).toBeVisible();
  await expect(page.locator("#settings-key-row")).toBeHidden();
  await expect(page.locator("#settings-endpoint")).toHaveValue(
    "http://127.0.0.1:11434/v1",
  );
  // Selecting a keyed provider flips the fields back.
  await page.locator("#settings-provider").selectOption("zai");
  await expect(page.locator("#settings-endpoint-row")).toBeHidden();
  await expect(page.locator("#settings-key-row")).toBeVisible();
  // The dialog is out of flow: the operations row is unchanged while it is open.
  await expect(page.locator(".operations > *")).toHaveCount(2);
  await page.locator(".dialog-close").click();
  await expect(page.locator("#model-dialog")).toBeHidden();
  await page.locator("#filter").selectOption("analysis");
  await expect(page.locator("#events .event").first()).toContainText(
    "analysis",
  );
  await page.screenshot({
    path: "test-results/dashboard-desktop.png",
    fullPage: true,
  });
  expect(errors).toEqual([]);
});
test("mobile layout fits viewport without horizontal scrolling", async ({
  page,
}) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto("/beebots/");
  await expect(page.locator(".bot")).toHaveCount(4);
  expect(
    await page.evaluate(
      () => document.documentElement.scrollWidth <= window.innerWidth,
    ),
  ).toBe(true);
  await page.screenshot({
    path: "test-results/dashboard-mobile.png",
    fullPage: true,
  });
});
