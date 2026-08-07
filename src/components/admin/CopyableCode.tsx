"use client";

import { useState } from "react";

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
    try {
      if (navigator.clipboard && window.isSecureContext) {
        await navigator.clipboard.writeText(children);
      } else {
        // Fallback for non-secure contexts or older browsers
        const textarea = document.createElement("textarea");
        textarea.value = children;
        textarea.style.position = "fixed";
        textarea.style.opacity = "0";
        document.body.appendChild(textarea);
        textarea.focus();
        textarea.select();
        document.execCommand("copy");
        document.body.removeChild(textarea);
      }
      setCopied(true);
      setTimeout(() => setCopied(false), 1200);
    } catch {
      // ignore clipboard errors
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
