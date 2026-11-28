"use client";

import { useRef } from "react";

// 6 位 TOTP 方格输入：逐格输入自动前进，退格回退/删除，支持整段粘贴自动分格
interface OtpInputProps {
  value: string;
  onChange: (value: string) => void;
  disabled?: boolean;
  autoFocus?: boolean;
}

const OTP_LENGTH = 6;

export default function OtpInput({ value, onChange, disabled, autoFocus }: OtpInputProps) {
  const inputRefs = useRef<Array<HTMLInputElement | null>>([]);
  const chars = Array.from({ length: OTP_LENGTH }, (_, i) => value[i] ?? "");

  const focusAt = (index: number) => {
    const el = inputRefs.current[index];
    if (el) el.focus();
  };

  // 从 index 位起写入数字串（单键 1 位 / 粘贴多位），超出末位截断
  const fillFrom = (index: number, digits: string) => {
    if (!digits) return;
    const next = (value.slice(0, index) + digits + value.slice(index + digits.length)).slice(
      0,
      OTP_LENGTH
    );
    onChange(next);
    focusAt(Math.min(index + digits.length, OTP_LENGTH - 1));
  };

  const handleChange = (index: number, raw: string) => {
    const digits = raw.replace(/\D/g, "");
    if (!digits) return;
    // 末位已有值（6 位已输满）：忽略新输入。
    // 注意不能只拦「单字符」：焦点本来就在末格时不会重新触发 onFocus，input 拿到的是
    // 追加后的 "12"（两字符）—— 只看长度仍会走进替换分支，于是末位被默默换掉。
    // 预期是先退格删掉再输。整串 autofill / 粘贴各有独立路径（onPaste）。
    if (index === OTP_LENGTH - 1 && chars[index] !== "") return;
    // 格子已有值时 onChange 返回「旧值 + 新值」：普通键入只取末位（替换语义）；
    // 多位数字串只来自粘贴/自动填充（paste 有独立路径，此处兜底 SMS autofill 直接落入 input）
    const incoming = chars[index] && digits.length > 1 ? digits.slice(-1) : digits;
    fillFrom(index, incoming);
  };

  const handleKeyDown = (index: number, e: React.KeyboardEvent<HTMLInputElement>) => {
    if (e.key === "Backspace") {
      e.preventDefault();
      if (chars[index]) {
        // 当前格有值：删当前格，焦点不动
        onChange(value.slice(0, index) + value.slice(index + 1));
      } else if (index > 0) {
        // 当前格为空：删前一位并前移焦点
        onChange(value.slice(0, index - 1) + value.slice(index));
        focusAt(index - 1);
      }
    } else if (e.key === "ArrowLeft" && index > 0) {
      e.preventDefault();
      focusAt(index - 1);
    } else if (e.key === "ArrowRight" && index < OTP_LENGTH - 1) {
      e.preventDefault();
      focusAt(index + 1);
    }
  };

  const handlePaste = (index: number, e: React.ClipboardEvent<HTMLInputElement>) => {
    e.preventDefault();
    fillFrom(index, e.clipboardData.getData("text").replace(/\D/g, ""));
  };

  return (
    <div className="flex items-center justify-center gap-1.5 sm:gap-2">
      {chars.map((ch, i) => (
        <input
          key={i}
          ref={(el) => {
            inputRefs.current[i] = el;
          }}
          type="text"
          inputMode="numeric"
          autoComplete={i === 0 ? "one-time-code" : "off"}
          maxLength={OTP_LENGTH}
          value={ch}
          disabled={disabled}
          autoFocus={autoFocus && i === 0}
          onChange={(e) => handleChange(i, e.target.value)}
          onKeyDown={(e) => handleKeyDown(i, e)}
          onPaste={(e) => handlePaste(i, e)}
          onFocus={(e) => e.target.select()}
          aria-label={`Digit ${i + 1}`}
          className="h-12 w-10 rounded-md border border-gray-300 bg-white text-center text-lg font-semibold text-gray-900 shadow-sm focus:border-blue-500 focus:outline-none focus:ring-1 focus:ring-blue-500 disabled:opacity-50"
        />
      ))}
    </div>
  );
}
