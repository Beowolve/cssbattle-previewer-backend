const functions = require('@google-cloud/functions-framework');
const crypto = require('node:crypto');
const zlib = require('node:zlib');
const puppeteer = require('puppeteer');

const VIEWPORT_WIDTH = 400;
const VIEWPORT_HEIGHT = 300;
const MAX_HTML_BYTES = 10 * 1024;
const RENDER_TIMEOUT_MS = 10_000;
const CHROME_LAUNCH_TIMEOUT_MS = 15_000;
const CLEANUP_TIMEOUT_MS = 2_000;
const SCREENSHOT_CACHE_MAX_BYTES = 25 * 1024 * 1024;
const ALLOWED_INLINE_PROTOCOLS = new Set(['about:', 'data:', 'blob:']);
const CHROME_ARGS = [
    '--no-sandbox',
    '--disable-setuid-sandbox',
    '--disable-dev-shm-usage',
    '--disable-background-networking',
    '--disable-default-apps',
    '--disable-extensions',
    '--disable-sync',
    '--disable-translate',
    '--hide-scrollbars',
    '--metrics-recording-only',
    '--mute-audio',
    '--no-first-run',
    '--no-zygote'
];
const CONTENT_SECURITY_POLICY = [
    "default-src 'none'",
    "script-src 'none'",
    "connect-src 'none'",
    "img-src data:",
    "style-src 'unsafe-inline'",
    "font-src data:",
    "media-src data:",
    "object-src 'none'",
    "frame-src 'none'",
    "base-uri 'none'",
    "form-action 'none'"
].join("; ");

const CRC32_TABLE = createCrc32Table();
const EMPTY_PREVIEW_ETAG = '"empty-preview-400x300-white-v2"';
const EMPTY_PREVIEW_SCREENSHOT = createSolidPng(VIEWPORT_WIDTH, VIEWPORT_HEIGHT, 255, 255, 255, 255);

let browserPromise;
const screenshotCache = new Map();
const screenshotRenderPromises = new Map();
let screenshotCacheBytes = 0;

function createHttpError(message, statusCode) {
    const error = new Error(message);
    error.statusCode = statusCode;
    return error;
}

async function withTimeout(operation, timeoutMs, message) {
    let timeoutId;
    const timeout = new Promise((_, reject) => {
        timeoutId = setTimeout(() => {
            reject(createHttpError(message, 504));
        }, timeoutMs);
    });

    try {
        return await Promise.race([operation, timeout]);
    } finally {
        clearTimeout(timeoutId);
    }
}

function createCrc32Table() {
    const table = new Uint32Array(256);

    for (let i = 0; i < table.length; i += 1) {
        let value = i;

        for (let bit = 0; bit < 8; bit += 1) {
            value = (value & 1) ? (0xedb88320 ^ (value >>> 1)) : (value >>> 1);
        }

        table[i] = value >>> 0;
    }

    return table;
}

function crc32(buffer) {
    let crc = 0xffffffff;

    for (const byte of buffer) {
        crc = CRC32_TABLE[(crc ^ byte) & 0xff] ^ (crc >>> 8);
    }

    return (crc ^ 0xffffffff) >>> 0;
}

function createPngChunk(type, data = Buffer.alloc(0)) {
    const typeBuffer = Buffer.from(type, "ascii");
    const chunk = Buffer.alloc(12 + data.length);

    chunk.writeUInt32BE(data.length, 0);
    typeBuffer.copy(chunk, 4);
    data.copy(chunk, 8);

    const crcBuffer = Buffer.concat([typeBuffer, data]);
    chunk.writeUInt32BE(crc32(crcBuffer), chunk.length - 4);

    return chunk;
}

function createSolidPng(width, height, red, green, blue, alpha) {
    const bytesPerPixel = 4;
    const rowLength = 1 + width * bytesPerPixel;
    const rawImage = Buffer.alloc(rowLength * height);

    for (let row = 0; row < height; row += 1) {
        const rowStart = row * rowLength;
        rawImage[rowStart] = 0;

        for (let column = 0; column < width; column += 1) {
            const pixelStart = rowStart + 1 + column * bytesPerPixel;
            rawImage[pixelStart] = red;
            rawImage[pixelStart + 1] = green;
            rawImage[pixelStart + 2] = blue;
            rawImage[pixelStart + 3] = alpha;
        }
    }

    const ihdr = Buffer.alloc(13);
    ihdr.writeUInt32BE(width, 0);
    ihdr.writeUInt32BE(height, 4);
    ihdr[8] = 8;
    ihdr[9] = 6;
    ihdr[10] = 0;
    ihdr[11] = 0;
    ihdr[12] = 0;

    return Buffer.concat([
        Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
        createPngChunk("IHDR", ihdr),
        createPngChunk("IDAT", zlib.deflateSync(rawImage)),
        createPngChunk("IEND")
    ]);
}

async function launchBrowser() {
    const browser = await puppeteer.launch({
        defaultViewport: { width: VIEWPORT_WIDTH, height: VIEWPORT_HEIGHT },
        args: CHROME_ARGS,
        headless: true,
        pipe: true,
        protocolTimeout: RENDER_TIMEOUT_MS + 5_000
    });

    browser.on("disconnected", () => {
        browserPromise = undefined;
    });

    return browser;
}

async function getBrowser() {
    if (!browserPromise) {
        browserPromise = withTimeout(
            launchBrowser(),
            CHROME_LAUNCH_TIMEOUT_MS,
            "Browser startup timed out."
        ).catch(error => {
            browserPromise = undefined;
            throw error;
        });
    }

    const browser = await browserPromise;

    if (!browser.isConnected()) {
        browserPromise = undefined;
        return getBrowser();
    }

    return browser;
}

async function closeSharedBrowser() {
    if (!browserPromise) {
        return;
    }

    const browser = await browserPromise.catch(() => undefined);
    browserPromise = undefined;

    if (browser?.isConnected()) {
        await withTimeout(browser.close(), CLEANUP_TIMEOUT_MS, "Browser cleanup timed out.");
    }
}

function getHtmlFromRequest(req) {
    const html = req.query.q ?? "";

    if (Array.isArray(html) || typeof html !== "string") {
        throw createHttpError("Query parameter q must be a string.", 400);
    }

    if (Buffer.byteLength(html, "utf8") > MAX_HTML_BYTES) {
        throw createHttpError("Query parameter q is too large.", 413);
    }

    return html;
}

function shouldAllowRequest(requestUrl) {
    try {
        const { protocol } = new URL(requestUrl);
        return ALLOWED_INLINE_PROTOCOLS.has(protocol);
    } catch {
        return false;
    }
}

function addSecurityPolicy(html) {
    const policyMeta = `<meta http-equiv="Content-Security-Policy" content="${CONTENT_SECURITY_POLICY}">`;
    const headMatch = html.match(/<head\b[^>]*>/i);

    if (!headMatch) {
        return `${policyMeta}${html}`;
    }

    const insertAt = headMatch.index + headMatch[0].length;
    return `${html.slice(0, insertAt)}${policyMeta}${html.slice(insertAt)}`;
}

function createCacheKey(html) {
    return crypto.createHash("sha256").update(html).digest("base64url");
}

function getCachedScreenshot(cacheKey) {
    const cached = screenshotCache.get(cacheKey);

    if (!cached) {
        return undefined;
    }

    screenshotCache.delete(cacheKey);
    screenshotCache.set(cacheKey, cached);
    return cached.screenshot;
}

function cacheScreenshot(cacheKey, screenshot) {
    const previous = screenshotCache.get(cacheKey);

    if (previous) {
        screenshotCacheBytes -= previous.size;
        screenshotCache.delete(cacheKey);
    }

    screenshotCache.set(cacheKey, {
        screenshot,
        size: screenshot.byteLength
    });
    screenshotCacheBytes += screenshot.byteLength;

    while (screenshotCacheBytes > SCREENSHOT_CACHE_MAX_BYTES) {
        const oldestKey = screenshotCache.keys().next().value;
        const oldest = screenshotCache.get(oldestKey);

        screenshotCache.delete(oldestKey);
        screenshotCacheBytes -= oldest.size;
    }
}

function clientHasFreshScreenshot(req, etag) {
    const ifNoneMatch = req.get("if-none-match");
    return ifNoneMatch?.split(",").map(value => value.trim()).includes(etag);
}

function sendScreenshot(res, screenshot, etag) {
    res.set('Cache-Control', 'public, max-age=3600');
    res.set('ETag', etag);
    res.header({ "Content-Type": "image/png" });
    res.end(screenshot);
}

function sendNotModified(res, etag) {
    res.set('Cache-Control', 'public, max-age=3600');
    res.set('ETag', etag);
    res.status(304).end();
}

async function renderScreenshot(html) {
    let page;

    try {
        const browser = await getBrowser();

        page = await withTimeout(
            browser.newPage(),
            RENDER_TIMEOUT_MS,
            "Page startup timed out."
        );
        page.setDefaultTimeout(RENDER_TIMEOUT_MS);
        page.setDefaultNavigationTimeout(RENDER_TIMEOUT_MS);
        await page.setJavaScriptEnabled(false);
        await page.setRequestInterception(true);
        page.on("request", request => {
            if (shouldAllowRequest(request.url())) {
                request.continue().catch(() => {});
                return;
            }

            request.abort().catch(() => {});
        });

        await withTimeout(
            page.setContent(html, { waitUntil: "domcontentloaded", timeout: RENDER_TIMEOUT_MS }),
            RENDER_TIMEOUT_MS,
            "Rendering timed out."
        );

        return Buffer.from(await withTimeout(
            page.screenshot({ optimizeForSpeed: true }),
            RENDER_TIMEOUT_MS,
            "Screenshot timed out."
        ));
    } finally {
        if (page) {
            await withTimeout(page.close(), CLEANUP_TIMEOUT_MS, "Page cleanup timed out.").catch(error => {
                console.error("Puppeteer page cleanup error:", error);
            });
        }
    }
}

function getOrCreateRenderPromise(cacheKey, html) {
    const existingRender = screenshotRenderPromises.get(cacheKey);

    if (existingRender) {
        return existingRender;
    }

    const renderPromise = renderScreenshot(html)
        .then(screenshot => {
            cacheScreenshot(cacheKey, screenshot);
            return screenshot;
        })
        .finally(() => {
            screenshotRenderPromises.delete(cacheKey);
        });

    screenshotRenderPromises.set(cacheKey, renderPromise);
    return renderPromise;
}

process.once("SIGTERM", () => {
    closeSharedBrowser().catch(error => {
        console.error("Puppeteer browser shutdown error:", error);
    });
});

functions.http('renderPreview', async (req, res) => {
    try {
        const rawHtml = getHtmlFromRequest(req);

        if (rawHtml.length === 0) {
            if (clientHasFreshScreenshot(req, EMPTY_PREVIEW_ETAG)) {
                sendNotModified(res, EMPTY_PREVIEW_ETAG);
                return;
            }

            sendScreenshot(res, EMPTY_PREVIEW_SCREENSHOT, EMPTY_PREVIEW_ETAG);
            return;
        }

        const html = addSecurityPolicy(rawHtml);
        const cacheKey = createCacheKey(html);
        const etag = `"${cacheKey}"`;

        if (clientHasFreshScreenshot(req, etag)) {
            sendNotModified(res, etag);
            return;
        }

        const cachedScreenshot = getCachedScreenshot(cacheKey);

        if (cachedScreenshot) {
            sendScreenshot(res, cachedScreenshot, etag);
            return;
        }

        const screenshot = await getOrCreateRenderPromise(cacheKey, html);
        sendScreenshot(res, screenshot, etag);

    } catch (error) {
        if (error.statusCode) {
            res.status(error.statusCode).send(error.message);
            return;
        }

        console.error("Puppeteer error:", error);
        res.status(500).send("Internal Server Error");
    }
});
