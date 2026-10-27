# comfyrizz marketing site

Static, build-free marketing site for **https://comfy.rizz.click**. Plain `index.html` and `styles.css`, with no JavaScript and no framework.

Marketing only: it has no Generate, no API keys and no spend controls. Judges get a separate, invite-only tokenized workspace URL for live inference.

## Open locally

Open `site/index.html` in a browser, or serve it:

```sh
cd site && python3 -m http.server 8080   # then visit http://localhost:8080
```

## Deploy

Upload the contents of `site/` as-is to any static host (GitHub Pages, Cloudflare Pages, Netlify, S3 and so on) and point `comfy.rizz.click` at it. All asset paths are relative. No build step.

## Assets

`assets/` holds Kinetic ZZ marks copied from `brand/` (logo SVGs, symbol, favicon, PNG exports, social card), plus `showcase-demo.mp4` / `showcase-demo-poster.jpg` for the featured reel. Other showcase stills come from `docs/media/`. Don't redraw the logo. Update brand marks by re-copying from `brand/`.

## Brand tokens

violet `#6D28FF`, mint `#00D8AB`, ink `#14112B`, paper `#F7F5FC`, surface-dark `#211C38`, border-light `#DED9EB`, muted-on-dark `#BEB7D0`. No gradients, glow or shadows.

## Copy rules

Say "Google Colab", never bare "Colab". Don't claim to be Comfy.org. Don't print secrets, tokens or private hosts.
