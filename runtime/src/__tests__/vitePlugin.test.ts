import { describe, expect, it, vi } from "vitest";

import { sendJsonIfWritable } from "../library/vitePlugin.js";

describe("vite now-playing proxy helpers", () => {
  it("refuses to write JSON after headers were already sent", () => {
    const response = {
      headersSent: true,
      writableEnded: false,
      statusCode: 200,
      setHeader: vi.fn(),
      end: vi.fn()
    };

    const wrote = sendJsonIfWritable(response as never, { error: "late failure" }, 502);

    expect(wrote).toBe(false);
    expect(response.setHeader).not.toHaveBeenCalled();
    expect(response.end).not.toHaveBeenCalled();
  });
});
