import { expect, test, type Page } from "@playwright/test";

/**
 * End-to-end coverage of the application shell.
 *
 * These assert the things a screenshot would not catch: that the render loop
 * survives a source change, that scene selection actually follows the
 * arrangement, and that the output console stays collapsed. The last one is a
 * design constraint worth defending in CI - it is exactly what regressed into
 * a wall of controls before.
 */

/** Counts non-black pixels in a downsampled copy of the visual canvas. */
async function litPixels(page: Page): Promise<number> {
  return page.locator("#visualizer").evaluate((canvas) => {
    const sample = document.createElement("canvas");
    sample.width = 24;
    sample.height = 24;
    const context = sample.getContext("2d");
    if (!context) {
      return 0;
    }
    context.drawImage(canvas as HTMLCanvasElement, 0, 0, sample.width, sample.height);
    const pixels = context.getImageData(0, 0, sample.width, sample.height).data;
    let lit = 0;
    for (let index = 0; index < pixels.length; index += 4) {
      if (pixels[index] + pixels[index + 1] + pixels[index + 2] > 12) {
        lit += 1;
      }
    }
    return lit;
  });
}

async function loadLibraryTrack(page: Page): Promise<void> {
  await page.getByRole("button", { name: "Source", exact: true }).click();
  await page.locator("#libraryMode").click();
  await page.locator(".track-card .track-select").first().click();
  await expect.poll(() =>
    page.evaluate(() => window.__PHRASE2PHOTON_DEBUG__?.state().loadedTrackId ?? null)
  ).not.toBeNull();
}

test("starts in microphone mode and renders immediately", async ({ page }) => {
  const errors: string[] = [];
  page.on("pageerror", (error) => errors.push(error.message));

  await page.goto("/");

  await expect.poll(() =>
    page.evaluate(() => window.__PHRASE2PHOTON_DEBUG__?.state().inputMode ?? null)
  ).toBe("mic");

  // Nothing is playing yet, but the output should not be a black screen.
  await expect.poll(() => litPixels(page)).toBeGreaterThan(10);
  await expect(page.locator("#dock")).toBeHidden();
  expect(errors).toEqual([]);
});

test("loads a compiled show and reports its musical position", async ({ page }) => {
  const errors: string[] = [];
  page.on("pageerror", (error) => errors.push(error.message));

  await page.goto("/");
  await loadLibraryTrack(page);

  await expect(page.locator("#hudBpm")).toHaveText("122.0");
  await expect(page.locator("#nowLabel")).toHaveText("Kolter - Let You Go");
  await expect(page.locator("#nowTime")).toContainText("/ 6:48");
  await expect(page.locator("#hudPosition")).toContainText("bar");
  expect(errors).toEqual([]);
});

test("follows the arrangement by changing scene at phrase boundaries", async ({ page }) => {
  await page.goto("/");
  await loadLibraryTrack(page);

  const sceneAt = async (seconds: number): Promise<string> => {
    await page.evaluate((time) => {
      const audio = document.querySelector<HTMLAudioElement>("#audio");
      if (audio) {
        audio.currentTime = time;
      }
    }, seconds);
    // Give the render loop time to observe the seek and settle.
    await page.waitForTimeout(600);
    return page.evaluate(() => window.__PHRASE2PHOTON_DEBUG__!.state().sceneId);
  };

  const calm = await sceneAt(200);
  const drop = await sceneAt(270);
  expect(calm).not.toBe(drop);
});

test("holds a manually chosen scene against the arrangement", async ({ page }) => {
  await page.goto("/");
  await loadLibraryTrack(page);

  await page.getByRole("button", { name: "Look", exact: true }).click();
  await page.locator('[data-scene="strobe"]').click();
  await expect(page.locator("#sceneAuto")).not.toBeChecked();

  await page.evaluate(() => {
    const audio = document.querySelector<HTMLAudioElement>("#audio");
    if (audio) {
      audio.currentTime = 10;
    }
  });
  await page.waitForTimeout(600);
  expect(await page.evaluate(() => window.__PHRASE2PHOTON_DEBUG__!.state().sceneId)).toBe("strobe");
});

test("keeps the output console collapsed to a handful of live controls", async ({ page }) => {
  await page.goto("/");
  await page.getByRole("button", { name: "Output", exact: true }).click();
  await expect(page.locator("#dock")).toBeVisible();

  const counts = await page.evaluate(() => {
    const root = document.querySelector("#laserRoot")!;
    const all = [...root.querySelectorAll("button,input,select,a")];
    return {
      total: all.length,
      visible: all.filter((element) =>
        (element as HTMLElement).checkVisibility({ checkVisibilityCSS: true })
      ).length,
      openDetails: [...root.querySelectorAll("details")].filter((node) => node.open).length
    };
  });

  // Everything remains reachable, but an operator sees only what they would
  // touch mid-set: enable, blackout, hold, brightness and the colour swatches.
  expect(counts.total).toBeGreaterThan(100);
  expect(counts.visible).toBeLessThanOrEqual(12);
  expect(counts.openDetails).toBe(0);

  await expect(page.getByRole("button", { name: "Blackout" })).toBeVisible();
});

test("switches between source modes without breaking the render loop", async ({ page }) => {
  const errors: string[] = [];
  page.on("pageerror", (error) => errors.push(error.message));

  await page.goto("/");
  await page.getByRole("button", { name: "Source", exact: true }).click();

  for (const mode of ["#libraryMode", "#nowPlayingMode", "#micMode", "#libraryMode"]) {
    await page.locator(mode).click();
    await page.waitForTimeout(250);
  }

  await expect.poll(() => litPixels(page)).toBeGreaterThan(10);
  expect(errors).toEqual([]);
});
