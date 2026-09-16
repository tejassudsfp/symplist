import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { useState } from "react";
import { describe, expect, it, vi } from "vitest";
import { OtpInput, sanitizeCode } from "./otp-input.tsx";

function Harness({
  length = 6,
  onComplete,
}: {
  length?: number;
  onComplete?: (value: string) => void;
}) {
  const [value, setValue] = useState("");
  return (
    <OtpInput
      length={length}
      value={value}
      onChange={setValue}
      {...(onComplete ? { onComplete } : {})}
      label="6-digit code"
    />
  );
}

describe("the code field (email_otp.md)", () => {
  it("keeps only digits, up to the code length", () => {
    expect(sanitizeCode("123 456", 6)).toBe("123456");
    expect(sanitizeCode("12-34-56", 6)).toBe("123456");
    expect(sanitizeCode("abc123456789", 6)).toBe("123456");
    expect(sanitizeCode("", 6)).toBe("");
  });

  it("is one semantic input with one-time-code autofill and a numeric keyboard", () => {
    render(<Harness />);
    const input = screen.getByLabelText("6-digit code");
    expect(input.tagName).toBe("INPUT");
    expect(input).toHaveAttribute("autocomplete", "one-time-code");
    expect(input).toHaveAttribute("inputmode", "numeric");
    expect(screen.getAllByRole("textbox")).toHaveLength(1);
  });

  it("takes a pasted code with separators and reports completion once", async () => {
    const user = userEvent.setup();
    const onComplete = vi.fn();
    render(<Harness onComplete={onComplete} />);
    const input = screen.getByLabelText("6-digit code");
    input.focus();
    await user.paste("12-34-56");
    expect(input).toHaveValue("123456");
    expect(onComplete).toHaveBeenCalledExactlyOnceWith("123456");
  });

  it("does not report completion again when a digit is typed into a full code", async () => {
    const user = userEvent.setup();
    const onComplete = vi.fn();
    render(<Harness onComplete={onComplete} />);
    const input = screen.getByLabelText("6-digit code");
    input.focus();
    await user.paste("123456");
    expect(onComplete).toHaveBeenCalledExactlyOnceWith("123456");
    // Correcting a digit shifts the rest out of the field; submitting that would spend an attempt
    // of the challenge on a code nobody typed.
    (input as HTMLInputElement).setSelectionRange(3, 3);
    await user.keyboard("9");
    expect(input).toHaveValue("123945");
    expect(onComplete).toHaveBeenCalledOnce();
  });

  it("supports keyboard editing", async () => {
    const user = userEvent.setup();
    render(<Harness />);
    const input = screen.getByLabelText("6-digit code");
    await user.type(input, "123");
    await user.keyboard("{Backspace}");
    expect(input).toHaveValue("12");
  });

  it("follows the configured code length", () => {
    render(<Harness length={8} />);
    expect(screen.getByLabelText("6-digit code")).toHaveAttribute("pattern", "[0-9]{8}");
  });
});
