const preview = document.getElementById("playback-preview");
const reducedMotion = window.matchMedia("(prefers-reduced-motion: reduce)");

function updatePreview() {
  preview.src = reducedMotion.matches ? "assets/editor.jpg" : "assets/editor-animation.webp";
}

reducedMotion.addEventListener("change", updatePreview);
updatePreview();
