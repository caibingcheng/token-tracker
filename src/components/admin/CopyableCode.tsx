"use client";

import { useState } from "react";
import { copyText } from "@/lib/clipboard";

export function CopyableCode({
  children,
  className = "",
}: {
  children: string;
  className?: string;
}) {
  const [copied, setCopied] = useState(false);

  const handleClick = async (e: React.MouseEvent) => {
    e.stopPropagation();
    const ok = await copyText(children);
    if (ok) {
      setCopied(true);
      setTimeout(() => setCopied(false), 1200);
    }
  };

  return (
    <code
      onClick={handleClick}
      title={copied ? "Copied!" : `Click to copy: ${children}`}
      className={`cursor-pointer hover:opacity-80 ${className}`}
    >
      {copied ? "Copied!" : children}
    </code>
  );
}
