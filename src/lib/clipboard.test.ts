import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { copyText } from "./clipboard";

describe("copyText", () => {
  const originalNavigator = globalThis.navigator;
  const originalDocument = globalThis.document;
  const originalWindow = globalThis.window;

  beforeEach(() => {
    // Reset globals to a clean state before each test.
    vi.stubGlobal("navigator", undefined);
    vi.stubGlobal("document", undefined);
    vi.stubGlobal("window", undefined);
  });

  afterEach(() => {
    vi.stubGlobal("navigator", originalNavigator);
    vi.stubGlobal("document", originalDocument);
    vi.stubGlobal("window", originalWindow);
    vi.restoreAllMocks();
  });

  it("uses navigator.clipboard.writeText in secure context", async () => {
    const writeText = vi.fn().mockResolvedValue(undefined);
    vi.stubGlobal("navigator", { clipboard: { writeText } });
    vi.stubGlobal("window", { isSecureContext: true });

    const ok = await copyText("vk-test");
    expect(ok).toBe(true);
    expect(writeText).toHaveBeenCalledWith("vk-test");
  });

  it("falls back to execCommand in non-secure context", async () => {
    const execCommand = vi.fn().mockReturnValue(true);
    const appendChild = vi.fn();
    const removeChild = vi.fn();
    const focus = vi.fn();
    const select = vi.fn();

    let capturedValue = "";
    const style = {} as CSSStyleDeclaration;
    const setAttribute = vi.fn();
    const fakeTextarea = {
      set value(v: string) {
        capturedValue = v;
      },
      style,
      setAttribute,
      focus,
      select,
    } as unknown as HTMLTextAreaElement;

    const createElement = vi.fn().mockReturnValue(fakeTextarea);
    const fakeDocument = {
      createElement,
      execCommand,
      body: { appendChild, removeChild },
    } as unknown as Document;

    vi.stubGlobal("navigator", { clipboard: undefined });
    vi.stubGlobal("window", { isSecureContext: false });
    vi.stubGlobal("document", fakeDocument);

    const ok = await copyText("vk-fallback");
    expect(ok).toBe(true);
    expect(createElement).toHaveBeenCalledWith("textarea");
    expect(capturedValue).toBe("vk-fallback");
    expect(appendChild).toHaveBeenCalledWith(fakeTextarea);
    expect(focus).toHaveBeenCalled();
    expect(select).toHaveBeenCalled();
    expect(execCommand).toHaveBeenCalledWith("copy");
    expect(removeChild).toHaveBeenCalledWith(fakeTextarea);
  });

  it("returns false when navigator.clipboard rejects", async () => {
    const writeText = vi.fn().mockRejectedValue(new Error("denied"));
    vi.stubGlobal("navigator", { clipboard: { writeText } });
    vi.stubGlobal("window", { isSecureContext: true });

    const ok = await copyText("vk-denied");
    expect(ok).toBe(false);
  });

  it("returns false when execCommand returns false", async () => {
    const execCommand = vi.fn().mockReturnValue(false);
    const fakeTextarea = {
      focus: vi.fn(),
      select: vi.fn(),
      setAttribute: vi.fn(),
      style: {} as CSSStyleDeclaration,
    } as unknown as HTMLTextAreaElement;

    const fakeDocument = {
      createElement: vi.fn().mockReturnValue(fakeTextarea),
      execCommand,
      body: { appendChild: vi.fn(), removeChild: vi.fn() },
    } as unknown as Document;

    vi.stubGlobal("navigator", { clipboard: undefined });
    vi.stubGlobal("window", { isSecureContext: false });
    vi.stubGlobal("document", fakeDocument);

    const ok = await copyText("vk-fail");
    expect(ok).toBe(false);
  });
});
