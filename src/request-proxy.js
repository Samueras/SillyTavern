import process from 'node:process';
import http from 'node:http';
import https from 'node:https';
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';
import { ProxyAgent } from 'proxy-agent';
import { isValidUrl, color } from './util.js';

const LOG_HEADER = '[Request Proxy]';

/**
 * Reads a local PAC file referenced by a `pac+file://` proxy URL and inlines
 * its contents as a `pac+data:` URL. get-uri (used by pac-proxy-agent to load
 * PAC files) leaks the `fs.promises` FileHandle for `file:` sources; the
 * abandoned handle is later force-closed by the garbage collector finalizer
 * and fails with EBADF, crashing the process with an uncaught exception.
 * Data URLs bypass file handling entirely.
 * @param {string} url Proxy URL.
 * @returns {string} Proxy URL with the PAC file contents inlined.
 */
function inlinePacFile(url) {
    if (!url.startsWith('pac+file:')) {
        return url;
    }

    const pacPath = fileURLToPath(url.replace(/^pac\+/, ''));
    const pacContents = fs.readFileSync(pacPath, 'utf-8');
    console.info(color.green(LOG_HEADER), `Inlined PAC file '${pacPath}' as a data URL. Restart the server to apply PAC file changes.`);
    return `pac+data:application/octet-stream;base64,${Buffer.from(pacContents).toString('base64')}`;
}

/**
 * Initialize request proxy.
 * @param {ProxySettings} settings Proxy settings.
 * @typedef {object} ProxySettings
 * @property {boolean} enabled Whether proxy is enabled.
 * @property {string} url Proxy URL.
 * @property {string[]} bypass List of URLs to bypass proxy.
 * @property {boolean} enableKeepAlive Enable HTTP/HTTPS keep-alive.
 * @property {boolean} privateRequestFilterEnabled Whether the private request filter is enabled.
 */
export default function initRequestProxy({ enabled, url, bypass, enableKeepAlive, privateRequestFilterEnabled }) {
    try {
        // No proxy is enabled, so return
        if (!enabled) {
            return;
        }

        if (privateRequestFilterEnabled) {
            console.warn(color.yellow(LOG_HEADER), 'Warning: Request proxy is enabled while private request filter is also enabled. Only URLs that BYPASS the request proxy will be checked.');
            console.warn(color.yellow(LOG_HEADER), 'To ensure all requests are properly filtered, disable the request proxy.');
        }

        if (!url) {
            console.error(color.red(LOG_HEADER), 'No proxy URL provided');
            return;
        }

        if (!isValidUrl(url)) {
            console.error(color.red(LOG_HEADER), 'Invalid proxy URL provided');
            return;
        }

        const originalUrl = url;

        try {
            url = inlinePacFile(url);
        } catch (error) {
            console.error(color.red(LOG_HEADER), 'Failed to read PAC file:', error);
            return;
        }

        // ProxyAgent uses proxy-from-env under the hood
        // Reference: https://github.com/Rob--W/proxy-from-env
        // Keep the file URL here: proxy-from-env prepends https:// to data
        // URLs because they do not contain ://. Substitute the inlined URL
        // only after environment proxy selection and bypass matching.
        process.env.all_proxy = originalUrl;

        if (Array.isArray(bypass) && bypass.length > 0) {
            process.env.no_proxy = bypass.join(',');
        }

        const httpAgent = http.globalAgent;
        const httpsAgent = https.globalAgent;

        const proxyAgent = new ProxyAgent({ httpAgent, httpsAgent, keepAlive: enableKeepAlive });
        const resolveProxy = proxyAgent.getProxyForUrl;
        proxyAgent.getProxyForUrl = async (targetUrl, request) => {
            const selected = await resolveProxy(targetUrl, request);
            return selected === originalUrl ? url : selected;
        };

        http.globalAgent = proxyAgent;
        https.globalAgent = proxyAgent;

        console.info();
        console.info(color.green(LOG_HEADER), 'Proxy URL is used:', color.blue(originalUrl));
        console.info();
    } catch (error) {
        console.error(color.red(LOG_HEADER), 'Failed to initialize request proxy:', error);
    }
}
