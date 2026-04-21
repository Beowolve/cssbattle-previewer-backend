# CSSBattle Previewer Backend

This project is the backend for the CSSBattle Previewer.

It runs as a small Google Cloud Run service and renders submitted HTML/CSS with Puppeteer in a headless Chromium instance. The service returns a PNG screenshot of the rendered preview.

The renderer is intentionally restricted:

- JavaScript execution is disabled.
- External resources are blocked as far as possible.
- A Content Security Policy is injected before rendering.
- Rendering and cleanup operations have timeouts.
- Chromium is reused between requests for better performance.
- Rendered screenshots are cached in memory for repeated inputs.

## Endpoint

The current HTTP function is named `renderPreview`.

The preview HTML is currently read from the `q` query parameter and rendered into a `400x300` PNG image.
