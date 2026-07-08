const origin = window.location.origin;

document.querySelectorAll("[data-template]").forEach((element) => {
  element.textContent = element.dataset.template.replaceAll("{origin}", origin);
});

document.querySelectorAll("[data-copy]").forEach((button) => {
  button.addEventListener("click", async () => {
    const code = button.parentElement?.querySelector("code");
    if (!code) return;

    const value = code.textContent.trim();
    try {
      await navigator.clipboard.writeText(value);
      button.textContent = "Copied";
      setTimeout(() => {
        button.textContent = "Copy";
      }, 1400);
    } catch {
      window.prompt("Copy", value);
    }
  });
});
