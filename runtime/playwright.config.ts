import { defineConfig, devices } from "@playwright/test";

export default defineConfig({
  testDir: "./e2e",
  timeout: 30_000,
  expect: {
    timeout: 5_000
  },
  use: {
    baseURL: "http://127.0.0.1:5181",
    trace: "on-first-retry"
  },
  webServer: {
    command: "npm run dev -- --port 5181 --strictPort",
    url: "http://127.0.0.1:5181",
    reuseExistingServer: false,
    timeout: 20_000
  },
  projects: [
    {
      name: "chromium",
      use: { ...devices["Desktop Chrome"] }
    }
  ]
});
