(() => {
  const { document, ResizeObserver } = globalThis;
  const brand = document.querySelector(".brand");
  const logo = brand.querySelector(".brand-logo img");
  const wordmark = brand.querySelector(".brand-name");
  const canvas = brand.querySelector(".brand-canvas");
  const surface = canvas.getContext("2d", { alpha: false, willReadFrequently: true });
  const inkCanvas = document.createElement("canvas");
  const ink = inkCanvas.getContext("2d", { willReadFrequently: true });
  if (!surface || !ink) return;

  const motion = globalThis.matchMedia("(prefers-reduced-motion: no-preference) and (forced-colors: none)");
  const label = wordmark.textContent.toUpperCase();
  const bandWidth = 104;
  const sweepDurationMs = 2000;
  let layout;
  let frame = 0;
  let lastPaint = 0;

  function paint(time) {
    const { width, height, logoX, logoY, logoSize, textX, baseline, background } = layout;
    const progress = Math.min(1, (time % sweepDurationMs) / (sweepDurationMs * 0.84));
    const left = -bandWidth + (width + bandWidth) * progress;
    const gradient = ink.createLinearGradient(left, 0, left + bandWidth, 0);
    gradient.addColorStop(0, "#aeafb2");
    gradient.addColorStop(0.48, "#fff");
    gradient.addColorStop(1, "#aeafb2");

    // Clip in memory. Only a finished bitmap reaches the visible surface.
    ink.globalCompositeOperation = "source-over";
    ink.clearRect(0, 0, width, height);
    ink.drawImage(logo, logoX, logoY, logoSize, logoSize);
    ink.fillStyle = "#fff";
    ink.fillText(label, textX, baseline);
    ink.globalCompositeOperation = "source-in";
    ink.fillStyle = gradient;
    ink.fillRect(0, 0, width, height);

    surface.fillStyle = background;
    surface.fillRect(0, 0, canvas.width, canvas.height);
    surface.drawImage(inkCanvas, 0, 0);
  }

  function animate(time) {
    // The small software surface does not need to repaint at display refresh rate.
    if (time - lastPaint >= 32) {
      lastPaint = time;
      paint(time);
    }
    frame = globalThis.requestAnimationFrame(animate);
  }

  function refresh() {
    globalThis.cancelAnimationFrame(frame);
    frame = 0;
    if (!motion.matches || !logo.naturalWidth) {
      canvas.hidden = true;
      brand.classList.remove("is-animated");
      return;
    }

    const bounds = brand.getBoundingClientRect();
    const iconBounds = logo.getBoundingClientRect();
    const textBounds = wordmark.getBoundingClientRect();
    const ratio = globalThis.devicePixelRatio;
    const { width, height } = bounds;
    if (!width || !height) return;
    canvas.width = inkCanvas.width = Math.ceil(width * ratio);
    canvas.height = inkCanvas.height = Math.ceil(height * ratio);
    ink.setTransform(canvas.width / width, 0, 0, canvas.height / height, 0, 0);
    const style = globalThis.getComputedStyle(wordmark);
    ink.font = `${style.fontWeight} ${style.fontSize} ${style.fontFamily}`;
    ink.letterSpacing = style.letterSpacing;
    const metrics = ink.measureText(label);
    const baseline = textBounds.top - bounds.top
      + (textBounds.height + metrics.fontBoundingBoxAscent - metrics.fontBoundingBoxDescent) / 2;
    layout = {
      width, height, baseline,
      logoX: iconBounds.left - bounds.left,
      logoY: iconBounds.top - bounds.top,
      logoSize: iconBounds.width,
      textX: textBounds.left - bounds.left,
      background: globalThis.getComputedStyle(document.body).backgroundColor
    };

    lastPaint = globalThis.performance.now();
    paint(lastPaint);
    canvas.hidden = false;
    brand.classList.add("is-animated");
    if (!document.hidden) frame = globalThis.requestAnimationFrame(animate);
  }

  new ResizeObserver(refresh).observe(brand);
  logo.addEventListener("load", refresh);
  motion.addEventListener("change", refresh);
  document.addEventListener("visibilitychange", refresh);
})();
