import { afterEach, beforeEach, describe, expect, jest, test } from '@jest/globals';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import https from 'node:https';
import { pathToFileURL } from 'node:url';
import { PacProxyAgent } from 'pac-proxy-agent';
import initRequestProxy from '../src/request-proxy.js';

describe('local PAC request proxy', () => {
    let directory;
    let environment;
    let httpAgent;
    let httpsAgent;
    let pacUrl;

    beforeEach(() => {
        environment = { ...process.env };
        for (const key of Object.keys(process.env)) {
            if (/proxy/i.test(key)) delete process.env[key];
        }
        httpAgent = http.globalAgent;
        httpsAgent = https.globalAgent;
        directory = fs.mkdtempSync(path.join(os.tmpdir(), 'st-pac-'));
        const filename = path.join(directory, 'proxy.pac');
        fs.writeFileSync(filename, 'function FindProxyForURL(url, host) { return host === "api.chub.ai" ? "SOCKS5 127.0.0.1:1080" : "DIRECT"; }');
        pacUrl = `pac+${pathToFileURL(filename).href}`;
        jest.spyOn(console, 'info').mockImplementation(() => {});
    });

    afterEach(() => {
        if (http.globalAgent !== httpAgent) http.globalAgent.destroy();
        http.globalAgent = httpAgent;
        https.globalAgent = httpsAgent;
        process.env = environment;
        fs.rmSync(directory, { recursive: true, force: true });
        jest.restoreAllMocks();
    });

    test('inlines local PAC without corrupting its URL and evaluates routing', async () => {
        initRequestProxy({ enabled: true, url: pacUrl, bypass: [] });
        const selected = await https.globalAgent.getProxyForUrl('https://api.chub.ai/');
        expect(selected.startsWith('pac+data:')).toBe(true);
        expect(() => new URL(selected)).not.toThrow();
        // Evaluation must no longer depend on an open file or its continued existence.
        fs.unlinkSync(path.join(directory, 'proxy.pac'));
        const agent = new PacProxyAgent(selected);
        try {
            const resolve = await agent.getResolver();
            expect(await resolve('https://api.chub.ai/')).toBe('SOCKS5 127.0.0.1:1080');
            expect(await resolve('https://api.deepseek.com/')).toBe('DIRECT');
        } finally {
            agent.destroy();
        }
    });

    test('preserves bypass and protocol-specific environment proxy precedence', async () => {
        process.env.https_proxy = 'http://127.0.0.1:8080';
        initRequestProxy({ enabled: true, url: pacUrl, bypass: ['localhost', '.example.com'] });
        expect(await https.globalAgent.getProxyForUrl('https://localhost/')).toBe('');
        expect(await https.globalAgent.getProxyForUrl('https://api.example.com/')).toBe('');
        expect(await https.globalAgent.getProxyForUrl('https://api.chub.ai/')).toBe('http://127.0.0.1:8080');
        expect((await http.globalAgent.getProxyForUrl('http://api.chub.ai/')).startsWith('pac+data:')).toBe(true);
    });

    test('keeps ordinary SOCKS URLs unchanged', async () => {
        const url = 'socks5://127.0.0.1:1080';
        initRequestProxy({ enabled: true, url, bypass: [] });
        expect(await https.globalAgent.getProxyForUrl('https://api.chub.ai/')).toBe(url);
    });
});
