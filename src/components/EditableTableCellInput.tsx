"use client";

import { KeyboardEvent } from "react";
import { useEffect, useState } from "react";
import { cn } from "@/lib/utils";

interface EditableTableCellInputProps {
  value: string;
  ariaLabel: string;
  className?: string;
  disabled?: boolean;
  onChange: (value: string) => void;
  onCommit: (value: string) => void;
}

export function EditableTableCellInput({
  value,
  ariaLabel,
  className,
  disabled,
  onChange,
  onCommit,
}: EditableTableCellInputProps) {
  const [draft, setDraft] = useState(value);

  useEffect(() => {
    setDraft(value);
  }, [value]);

  const handleKeyDown = (event: KeyboardEvent<HTMLInputElement>) => {
    if (event.key === "Enter") {
      event.currentTarget.blur();
    }
  };

  return (
    <input
      aria-label={ariaLabel}
      value={draft}
      disabled={disabled}
      onChange={(event) => {
        setDraft(event.target.value);
        onChange(event.target.value);
      }}
      onBlur={(event) => onCommit(event.currentTarget.value)}
      onKeyDown={handleKeyDown}
      className={cn(
        "h-5 w-full min-w-0 rounded bg-transparent px-1 text-[11px] font-semibold outline-none transition focus:bg-white focus:ring-1 focus:ring-indigo-300 disabled:pointer-events-none disabled:cursor-crosshair disabled:opacity-100",
        className
      )}
    />
  );
}
