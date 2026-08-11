const EVIDENCE_OVERLAY_ID = "memoroom-competitor-evidence-overlay";

export function evidenceHours(startHour, endHour) {
  if (!Number.isInteger(startHour) || !Number.isInteger(endHour) || endHour <= startHour) return [];
  return Array.from({ length: endHour - startHour }, (_, index) => startHour + index);
}

export function formatEvidenceRange(startHour, endHour) {
  if (evidenceHours(startHour, endHour).length === 0) return "시간 범위 없음";
  return `${String(startHour).padStart(2, "0")}:00~${String(endHour).padStart(2, "0")}:00`;
}

export async function prepareCompetitorEvidenceViewport(page, {
  competitorName,
  dateKey,
  startHour,
  endHour,
  reasonCode,
}) {
  const expectedHours = evidenceHours(startHour, endHour);
  if (expectedHours.length === 0) {
    throw new Error("A focused evidence screenshot requires a valid hour range");
  }

  const prepared = await page.evaluate((payload) => {
    document.getElementById(payload.overlayId)?.remove();

    const items = [...document.querySelectorAll(".time_item")];
    let period = "AM";
    const parsed = items.map((element, index) => {
      const text = (element.querySelector(".time_text")?.textContent || "").replace(/\s+/g, "").trim();
      if (text.includes("오전")) period = "AM";
      if (text.includes("오후")) period = "PM";
      const match = text.match(/(\d{1,2})시/);
      if (!match) return null;
      let hour = Number(match[1]);
      if (period === "PM" && hour !== 12) hour += 12;
      if (period === "AM" && hour === 12) hour = 0;
      element.dataset.memoroomEvidenceHour = String(hour);
      return { element, hour, index };
    }).filter(Boolean);

    const exact = parsed.filter((item) => payload.expectedHours.includes(item.hour));
    const centerHour = (payload.startHour + payload.endHour - 1) / 2;
    const focus = exact
      .slice()
      .sort((left, right) => Math.abs(left.hour - centerHour) - Math.abs(right.hour - centerHour))[0]
      || parsed
      .slice()
      .sort((left, right) => Math.abs(left.hour - centerHour) - Math.abs(right.hour - centerHour))[0];

    if (!focus) {
      return { ok: false, error: "No rendered time slot could be found", renderedHours: [] };
    }

    focus.element.scrollIntoView({ block: "center", inline: "center", behavior: "instant" });

    for (const item of exact) {
      item.element.dataset.memoroomEvidenceTarget = "true";
      item.element.style.setProperty("outline", "4px solid #ef4444", "important");
      item.element.style.setProperty("outline-offset", "2px", "important");
    }

    const overlay = document.createElement("div");
    overlay.id = payload.overlayId;
    overlay.setAttribute("data-memoroom-evidence-overlay", "true");
    overlay.style.cssText = [
      "position:fixed",
      "left:16px",
      "top:16px",
      "z-index:2147483647",
      "max-width:calc(100vw - 32px)",
      "padding:12px 16px",
      "border:3px solid #ef4444",
      "border-radius:10px",
      "background:#ffffff",
      "color:#111827",
      "font:700 18px/1.45 sans-serif",
      "box-shadow:0 8px 30px rgba(0,0,0,.25)",
      "pointer-events:none",
    ].join(";");
    const foundHours = exact.map((item) => item.hour).sort((a, b) => a - b);
    const missingHours = payload.expectedHours.filter((hour) => !foundHours.includes(hour));
    overlay.textContent = [
      `${payload.competitorName} · ${payload.dateKey}`,
      `확인 대상 ${payload.rangeLabel}`,
      missingHours.length > 0
        ? `주의: 화면에 없는 슬롯 ${missingHours.map((hour) => `${String(hour).padStart(2, "0")}:00`).join(", ")}`
        : "빨간 테두리가 확인 대상 슬롯입니다.",
      payload.reasonCode,
    ].join("  |  ");

    return {
      ok: true,
      renderedHours: parsed.map((item) => item.hour),
      foundHours,
      missingHours,
      focusHour: focus.hour,
    };
  }, {
    overlayId: EVIDENCE_OVERLAY_ID,
    competitorName,
    dateKey,
    startHour,
    endHour,
    reasonCode,
    expectedHours,
    rangeLabel: formatEvidenceRange(startHour, endHour),
  });

  if (!prepared.ok) throw new Error(prepared.error);
  if (prepared.missingHours.length > 0) {
    throw new Error(`Target slots were not rendered: ${prepared.missingHours.join(", ")}`);
  }
  await page.waitForTimeout(250);

  const visibility = await page.evaluate(({ expectedHours: hours }) => {
    const viewportWidth = window.innerWidth;
    const viewportHeight = window.innerHeight;
    return hours.map((hour) => {
      const element = document.querySelector(`[data-memoroom-evidence-hour="${hour}"]`);
      if (!element) return { hour, rendered: false, visible: false };
      const rect = element.getBoundingClientRect();
      return {
        hour,
        rendered: true,
        visible: rect.bottom > 0 && rect.top < viewportHeight && rect.right > 0 && rect.left < viewportWidth,
      };
    });
  }, { expectedHours });

  if (visibility.some((item) => !item.rendered || !item.visible)) {
    throw new Error(`Target slots were rendered but not all visible: ${JSON.stringify(visibility)}`);
  }

  return {
    ...prepared,
    expectedHours,
    visibility,
    rangeLabel: formatEvidenceRange(startHour, endHour),
  };
}

export async function clearCompetitorEvidenceViewport(page) {
  await page.evaluate((overlayId) => {
    document.getElementById(overlayId)?.remove();
    for (const element of document.querySelectorAll("[data-memoroom-evidence-hour]")) {
      delete element.dataset.memoroomEvidenceHour;
      delete element.dataset.memoroomEvidenceTarget;
      element.style.removeProperty("outline");
      element.style.removeProperty("outline-offset");
    }
  }, EVIDENCE_OVERLAY_ID).catch(() => {});
}
