"use client";

import { useEffect, useMemo, useRef, useState, type PointerEvent as ReactPointerEvent } from "react";
import { Check, Copy, MessageSquareText, Phone, UserPlus, X } from "lucide-react";
import { cn } from "@/lib/utils";

const LONG_PRESS_MS = 520;
const MOVE_CANCEL_DISTANCE = 12;

function phoneDigits(value: string) {
  return value.replace(/\D/g, "");
}

function escapeVCardText(value: string) {
  return value
    .replace(/\\/g, "\\\\")
    .replace(/\n/g, "\\n")
    .replace(/,/g, "\\,")
    .replace(/;/g, "\\;");
}

export default function PhoneActionLink({
  phone,
  contactName,
  className,
  iconClassName,
  cancelled = false,
}: {
  phone: string;
  contactName?: string | null;
  className?: string;
  iconClassName?: string;
  cancelled?: boolean;
}) {
  const [isOpen, setIsOpen] = useState(false);
  const [copied, setCopied] = useState(false);
  const longPressTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const pressStartRef = useRef<{ x: number; y: number } | null>(null);
  const didLongPressRef = useRef(false);
  const digits = useMemo(() => phoneDigits(phone), [phone]);
  const displayName = contactName?.trim() || "머무룸 고객";
  const contactFileHref = useMemo(() => {
    const vCard = [
      "BEGIN:VCARD",
      "VERSION:3.0",
      `FN:${escapeVCardText(displayName)}`,
      `TEL;TYPE=CELL:${digits}`,
      "END:VCARD",
    ].join("\r\n");

    return `data:text/vcard;charset=utf-8,${encodeURIComponent(vCard)}`;
  }, [digits, displayName]);

  const clearLongPressTimer = () => {
    if (longPressTimerRef.current) {
      clearTimeout(longPressTimerRef.current);
      longPressTimerRef.current = null;
    }
  };

  const openMenu = () => {
    didLongPressRef.current = true;
    setCopied(false);
    setIsOpen(true);
  };

  const closeMenu = () => {
    didLongPressRef.current = false;
    setIsOpen(false);
  };

  const handlePointerDown = (event: ReactPointerEvent<HTMLAnchorElement>) => {
    if (event.button !== 0) return;
    pressStartRef.current = { x: event.clientX, y: event.clientY };
    clearLongPressTimer();
    longPressTimerRef.current = setTimeout(openMenu, LONG_PRESS_MS);
  };

  const handlePointerMove = (event: ReactPointerEvent<HTMLAnchorElement>) => {
    const start = pressStartRef.current;
    if (!start) return;

    if (
      Math.abs(event.clientX - start.x) > MOVE_CANCEL_DISTANCE
      || Math.abs(event.clientY - start.y) > MOVE_CANCEL_DISTANCE
    ) {
      clearLongPressTimer();
      pressStartRef.current = null;
    }
  };

  const finishPointerPress = () => {
    clearLongPressTimer();
    pressStartRef.current = null;
  };

  const handleCopy = async () => {
    try {
      await navigator.clipboard.writeText(phone);
      setCopied(true);
    } catch {
      const input = document.createElement("textarea");
      input.value = phone;
      input.style.position = "fixed";
      input.style.opacity = "0";
      document.body.appendChild(input);
      input.select();
      document.execCommand("copy");
      input.remove();
      setCopied(true);
    }
  };

  useEffect(() => {
    if (!isOpen) return;

    const handleEscape = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        didLongPressRef.current = false;
        setIsOpen(false);
      }
    };

    window.addEventListener("keydown", handleEscape);
    return () => window.removeEventListener("keydown", handleEscape);
  }, [isOpen]);

  useEffect(() => () => {
    if (longPressTimerRef.current) clearTimeout(longPressTimerRef.current);
  }, []);

  return (
    <>
      <a
        href={`tel:${digits}`}
        onClick={(event) => {
          event.stopPropagation();
          if (didLongPressRef.current) {
            event.preventDefault();
            didLongPressRef.current = false;
          }
        }}
        onDoubleClick={(event) => event.stopPropagation()}
        onPointerDown={handlePointerDown}
        onPointerMove={handlePointerMove}
        onPointerUp={finishPointerPress}
        onPointerCancel={finishPointerPress}
        onPointerLeave={finishPointerPress}
        onContextMenu={(event) => {
          event.preventDefault();
          event.stopPropagation();
          clearLongPressTimer();
          openMenu();
        }}
        className={cn(
          "inline-flex min-w-0 items-center gap-1 underline decoration-slate-300 underline-offset-2 transition hover:text-emerald-600",
          cancelled && "line-through text-slate-400",
          className,
        )}
        style={{ WebkitTouchCallout: "none" }}
        aria-label={`${phone} 전화 걸기. 길게 누르면 전화 및 메시지 메뉴`}
      >
        <Phone className={cn("h-3.5 w-3.5 shrink-0", iconClassName)} />
        <span className="truncate">{phone}</span>
      </a>

      {isOpen && (
        <div
          className="fixed inset-0 z-[120] flex items-end justify-center bg-slate-900/30 p-3 dark:bg-slate-950/55 sm:items-center"
          onClick={(event) => {
            event.stopPropagation();
            closeMenu();
          }}
          role="presentation"
        >
          <section
            role="dialog"
            aria-modal="true"
            aria-label={`${displayName} 연락 방법 선택`}
            className="relative z-10 w-full max-w-sm overflow-hidden rounded-2xl border border-slate-200 bg-white text-slate-900 shadow-2xl dark:border-slate-700 dark:bg-slate-900 dark:text-white"
            onClick={(event) => event.stopPropagation()}
          >
            <div className="flex items-start justify-between border-b border-slate-200 px-5 py-4 dark:border-white/10">
              <div className="min-w-0">
                <strong className="block truncate text-base">{displayName}</strong>
                <span className="mt-0.5 block text-sm text-emerald-600 dark:text-emerald-400">{phone}</span>
              </div>
              <button
                type="button"
                onClick={closeMenu}
                className="rounded-full p-1.5 text-slate-400 transition hover:bg-slate-100 hover:text-slate-900 dark:hover:bg-white/10 dark:hover:text-white"
                aria-label="연락 메뉴 닫기"
              >
                <X className="h-5 w-5" />
              </button>
            </div>

            <a
              href={`tel:${digits}`}
              onClick={closeMenu}
              className="flex items-center justify-between border-b border-slate-200 px-5 py-4 transition hover:bg-slate-50 active:bg-slate-100 dark:border-white/10 dark:hover:bg-white/5 dark:active:bg-white/10"
            >
              <span>
                <strong className="block text-sm">통화하기</strong>
                <span className="text-xs text-slate-500 dark:text-slate-400">전화 앱 열기</span>
              </span>
              <Phone className="h-5 w-5" />
            </a>

            <a
              href={`sms:${digits}`}
              onClick={closeMenu}
              className="flex items-center justify-between border-b border-slate-200 px-5 py-4 transition hover:bg-slate-50 active:bg-slate-100 dark:border-white/10 dark:hover:bg-white/5 dark:active:bg-white/10"
            >
              <span>
                <strong className="block text-sm">메시지 보내기</strong>
                <span className="text-xs text-slate-500 dark:text-slate-400">기본 문자 앱 열기</span>
              </span>
              <MessageSquareText className="h-5 w-5" />
            </a>

            <a
              href={contactFileHref}
              download={`${displayName.replace(/[\\/:*?"<>|]/g, "_")}.vcf`}
              onClick={closeMenu}
              className="flex items-center justify-between border-b border-slate-200 px-5 py-4 transition hover:bg-slate-50 active:bg-slate-100 dark:border-white/10 dark:hover:bg-white/5 dark:active:bg-white/10"
            >
              <span>
                <strong className="block text-sm">연락처에 추가</strong>
                <span className="text-xs text-slate-500 dark:text-slate-400">이름과 번호 저장</span>
              </span>
              <UserPlus className="h-5 w-5" />
            </a>

            <button
              type="button"
              onClick={handleCopy}
              className="flex w-full items-center justify-between px-5 py-4 text-left transition hover:bg-slate-50 active:bg-slate-100 dark:hover:bg-white/5 dark:active:bg-white/10"
            >
              <span>
                <strong className="block text-sm">{copied ? "복사 완료" : "번호 복사"}</strong>
                <span className="text-xs text-slate-500 dark:text-slate-400">{copied ? "클립보드에 저장했습니다." : phone}</span>
              </span>
              {copied ? <Check className="h-5 w-5 text-emerald-600 dark:text-emerald-400" /> : <Copy className="h-5 w-5" />}
            </button>
          </section>
        </div>
      )}
    </>
  );
}
