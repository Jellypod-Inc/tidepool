export interface LayoutOpts {
  title: string;
  activePage: "home" | "friends" | "threads" | "config" | "audit";
  content: string;
}

const NAV_ITEMS: { page: LayoutOpts["activePage"]; label: string; href: string; muted?: boolean }[] = [
  { page: "home", label: "Home", href: "/dashboard" },
  { page: "friends", label: "Friends", href: "/dashboard/friends" },
  { page: "threads", label: "Threads", href: "/dashboard/threads" },
  { page: "config", label: "Config", href: "/dashboard/config" },
  { page: "audit", label: "Audit", href: "/dashboard/audit", muted: true },
];

export function renderLayout(opts: LayoutOpts): string {
  const nav = NAV_ITEMS.map((item) => {
    const classes = [
      item.page === opts.activePage ? "active" : "",
      item.muted ? "muted" : "",
    ].filter(Boolean).join(" ");
    return `<a href="${item.href}" hx-get="${item.href}" hx-target="#content" hx-push-url="true" class="${classes}">${item.label}</a>`;
  }).join("\n      ");

  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>${opts.title} — Tidepool</title>
  <link rel="stylesheet" href="/dashboard/style.css">
  <script src="/dashboard/htmx.min.js"></script>
</head>
<body>
  <header>
    <span class="brand">tidepool</span>
    <nav>
      ${nav}
    </nav>
  </header>
  <main id="content">
    ${opts.content}
  </main>
  <script>
    document.addEventListener("click", function(e) {
      if (!e.target.classList.contains("fingerprint")) return;
      var full = e.target.getAttribute("data-full");
      if (!full) return;
      navigator.clipboard.writeText(full).then(function() {
        var toast = document.getElementById("toast");
        if (!toast) return;
        toast.textContent = "Copied: " + full.slice(0, 20) + "\\u2026";
        toast.classList.add("show");
        setTimeout(function() { toast.classList.remove("show"); }, 2000);
      });
    });
    document.body.addEventListener("htmx:pushedIntoHistory", function() {
      var path = window.location.pathname;
      document.querySelectorAll("nav a").forEach(function(a) {
        var href = a.getAttribute("href");
        var isActive = path === href || (href === "/dashboard" && path === "/dashboard/");
        a.classList.toggle("active", isActive);
      });
    });
  </script>
  <div id="toast" class="toast"></div>
</body>
</html>`;
}

export function renderContent(content: string): string {
  return content;
}
