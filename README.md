# CSSBattle Previewer Backend

This project is the backend for the CSSBattle Previewer.

It runs as a small Google Cloud Run service and renders submitted HTML/CSS with Puppeteer in a headless Chromium instance. The service returns a `400x300` PNG screenshot of the rendered preview.

The renderer is intentionally restricted:

- JavaScript execution is disabled.
- External resources are blocked as far as possible.
- A Content Security Policy is injected before rendering.
- Input is limited to 10 KiB.
- Empty input returns a static white `400x300` PNG without starting Chromium.
- Rendering and cleanup operations have timeouts.
- Chromium is reused between requests for better performance.
- Rendered screenshots are cached in memory for repeated inputs.

## Endpoint

The HTTP function is named `renderPreview`.

The preview HTML is currently read from the `q` query parameter and rendered into a PNG image.

```text
GET /?q=<html>
```

## Deployment

Manual deployment is handled by `deploy.ps1`.

```powershell
.\deploy.ps1
```

The deployment uses:

- Google Cloud Run source deployment
- Ubuntu 22 Full with Node.js 22: `google-22-full/nodejs22`
- Automatic base image updates
- 2 GiB memory
- 15 seconds request timeout
- Public unauthenticated access
