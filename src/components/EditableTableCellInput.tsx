"use client";

import { KeyboardEvent } from "react";
import { cn } from "@/lib/utils";

interface EditableTableCellInputProps {
  value: string;
  placeholder?: string;
  ariaLabel: string;
  className?: string;
  disabled?: boolean;
  onChange: (value: string) => void;
  onCommit: (value: string) => void;
}

export function EditableTableCellInput({
  value,
  placeholder,
  ariaLabel,
  className,
  disabled,
  onChange,
  onCommit,
}: EditableTableCellInputProps) {
  const handleKeyDown = (event: KeyboardEvent<HTMLInputElement>) => {
    if (event.key === "Enter") {
      event.currentTarget.blur();
    }
  };

  return (
    <input
      aria-label={ariaLabel}
      value={value}
      placeholder={placeholder}
      disabled={disabled}
      onChange={(event) => {
        onChange(event.target.value);
      }}
      onBlur={(event) => onCommit(event.currentTarget.value)}
      onKeyDown={handleKeyDown}
      className={cn(
        "h-full min-h-[22px] w-full min-w-0 rounded-none bg-transparent px-0.5 text-center text-[11px] font-semibold leading-none outline-none transition placeholder:text-current focus:bg-white focus:ring-1 focus:ring-indigo-300 disabled:pointer-events-none disabled:cursor-crosshair disabled:opacity-100",
        className
      )}
    />
  );
}
